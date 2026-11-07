/**
 * TeamAccessLog — who has access, as a signed log (docs/specs/team-roles-and-access.md §3.3, §4.1).
 *
 * `state/team-access/log.jsonl`, one line per row. A row is either a phone's whole signed request,
 * whose events are read ONLY from the signed body, or a machine-signed row. Every row carries a
 * monotonic `seq` from this machine, assigned under the append and machine-signed with the row, so a
 * clock moving backward cannot reorder events. An append is fsynced before it returns, so a torn
 * last line was never acknowledged, and boot truncates it to the last newline before any append.
 *
 * `state/team-access/confined.json` is separate and survives `team-off` and a restore: every
 * conversation that must never again run with owner reach, with its fixed audience. It is written
 * before the event that makes a conversation so.
 *
 * Step 2a: one machine, and the owner's phone is the only person writer. The fold still re-checks
 * the signer's standing, so a row cannot exceed it. An agent that never invited anyone has no files.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isGrantAccessEvent, parseSignedEvents, validateMachineEvent, type MachineEvent, type RequestEvent } from './TeamAccessEvents.js';
import { sha256Hex, type MachineSignature, type MachineSigner } from './AppRecordSignatures.js';
import type { GrantAccess } from '../permissions/TeamAccess.js';
import type { OrgRole } from '../permissions/types.js';

export const TEAM_ACCESS_DIR = path.join('state', 'team-access');
export const TEAM_ACCESS_LAST_GOOD_DIR = path.join('state', 'team-access-last-good');

export interface RequestRow {
  seq: number;
  kind: 'request';
  receivedAt: string;
  /** The phone's stored signed request and the machine's receipt (mobile-native-conversations §4.6). */
  signedOrigin: { keyHash: string; deviceId: string; bodyB64: string; bodySha256: string; [k: string]: unknown };
  receipt?: MachineSignature;
  machineSig: MachineSignature;
}

export interface MachineRow {
  seq: number;
  kind: 'machine';
  at: string;
  events: MachineEvent[];
  machineSig: MachineSignature;
}

export type TeamAccessRow = RequestRow | MachineRow;

export type RowVerdict = 'verified' | 'unknown' | 'failed';

export interface TeamPerson { personKey: string; name: string; role: OrgRole; relationship?: 'msp'; links: Record<string, string | number> }

export interface TeamAccessState {
  on: boolean;
  ownerPersonKey: string | null;
  people: Map<string, TeamPerson>;
  /** personKey → conversation ref → access. */
  grants: Map<string, Map<string, GrantAccess>>;
  /** conversation ref → the team person who created it. */
  owned: Map<string, string>;
  /** device key hash → who it belongs to: a personKey, or 'owner' / 'msp'. */
  bindings: Map<string, string>;
  highestSeq: number;
}

export type LogHealth = 'absent' | 'ok' | 'unreadable';

export interface ConfinedEntry { ref: string; placeKey?: string; personKey?: string }

export function emptyState(): TeamAccessState {
  return { on: false, ownerPersonKey: null, people: new Map(), grants: new Map(), owned: new Map(), bindings: new Map(), highestSeq: 0 };
}

/** The bytes a machine signs for a row. */
export function rowPayload(row: Omit<RequestRow, 'machineSig'> | Omit<MachineRow, 'machineSig'>): string {
  const content = row.kind === 'request' ? `${row.receivedAt}\n${row.signedOrigin.bodySha256}\n${row.signedOrigin.keyHash}` : `${row.at}\n${sha256Hex(JSON.stringify(row.events))}`;
  return `instar-team-access-row-v1\n${row.seq}\n${row.kind}\n${content}`;
}

function bodyEvents(row: RequestRow): RequestEvent[] | null {
  try {
    const body = Buffer.from(row.signedOrigin.bodyB64, 'base64');
    if (sha256Hex(body) !== row.signedOrigin.bodySha256) return null;
    return parseSignedEvents(JSON.parse(body.toString('utf8')));
  } catch {
    // @silent-fallback-ok — an unparseable signed body has no events; the row counts for nothing.
    return null;
  }
}

function applyRequestEvent(s: TeamAccessState, e: RequestEvent): void {
  switch (e.type) {
    case 'team-on': s.on = true; return;
    case 'team-off':
      s.on = false; s.people.clear(); s.grants.clear();
      return;
    case 'owner-pin':
      if (!s.ownerPersonKey) s.ownerPersonKey = e.personKey;
      return;
    case 'person-add':
      s.people.set(e.personKey, { personKey: e.personKey, name: e.name, role: e.role, links: e.links ?? {}, ...(e.relationship ? { relationship: e.relationship } : {}) });
      return;
    case 'person-set': {
      const p = s.people.get(e.personKey);
      if (p) p.role = e.role;
      return;
    }
    case 'person-remove': s.people.delete(e.personKey); s.grants.delete(e.personKey); return;
    case 'grant': {
      if (!s.people.has(e.personKey)) return;
      const g = s.grants.get(e.personKey) ?? new Map<string, GrantAccess>();
      g.set(e.ref, e.access);
      s.grants.set(e.personKey, g);
      return;
    }
    case 'grant-remove': s.grants.get(e.personKey)?.delete(e.ref); return;
  }
}

function applyMachineEvent(s: TeamAccessState, e: MachineEvent): void {
  switch (e.type) {
    case 'phone-bind': s.bindings.set(e.keyHash, e.boundTo); return;
    case 'conversation-own': s.owned.set(e.ref, e.personKey); return;
    case 'lower': {
      if (e.ref) { s.grants.get(e.personKey)?.delete(e.ref); return; }
      if (e.remove) { s.people.delete(e.personKey); s.grants.delete(e.personKey); return; }
      const p = s.people.get(e.personKey);
      if (p && e.role) p.role = e.role;
      return;
    }
  }
}

/**
 * The fold: `seq` order, signer standing checked at that point. A request row counts only if its key
 * was bound as the owner's by then (2a), and all its events apply or none: a row is one line.
 */
export function foldRows(rows: ReadonlyArray<TeamAccessRow>, verify: (row: TeamAccessRow) => RowVerdict): TeamAccessState {
  const s = emptyState();
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    s.highestSeq = Math.max(s.highestSeq, row.seq);
    if (verify(row) !== 'verified') continue;
    if (row.kind === 'machine') {
      for (const e of row.events) applyMachineEvent(s, e);
      continue;
    }
    if (s.bindings.get(row.signedOrigin.keyHash) !== 'owner') continue;
    const events = bodyEvents(row);
    if (!events) continue;
    for (const e of events) applyRequestEvent(s, e);
  }
  return s;
}

export interface TeamAccessLogOptions {
  stateDir: string;
  signer: MachineSigner | null;
  verify: (row: TeamAccessRow) => RowVerdict;
  now?: () => number;
}

export class TeamAccessLog {
  private readonly dir: string;
  private readonly lastGoodDir: string;
  private readonly logFile: string;
  private readonly confinedFile: string;
  private rows: TeamAccessRow[] = [];
  private folded: TeamAccessState = emptyState();
  private health: LogHealth = 'absent';
  private seedSeq = 0;

  constructor(private readonly opts: TeamAccessLogOptions) {
    this.dir = path.join(opts.stateDir, TEAM_ACCESS_DIR);
    this.lastGoodDir = path.join(opts.stateDir, TEAM_ACCESS_LAST_GOOD_DIR);
    this.logFile = path.join(this.dir, 'log.jsonl');
    this.confinedFile = path.join(this.dir, 'confined.json');
    this.load();
  }

  private lastGoodLog(): string { return path.join(this.lastGoodDir, 'log.jsonl'); }
  private lastGoodConfined(): string { return path.join(this.lastGoodDir, 'confined.json'); }

  private parseLines(raw: string): TeamAccessRow[] | null {
    const rows: TeamAccessRow[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as TeamAccessRow;
        if (!r || typeof r.seq !== 'number' || (r.kind !== 'request' && r.kind !== 'machine')) return null;
        if (r.kind === 'machine' && (!Array.isArray(r.events) || r.events.some((e) => !validateMachineEvent(e)))) return null;
        rows.push(r);
      } catch {
        // @silent-fallback-ok — an unparseable middle line makes the whole log unreadable, reported by health().
        return null;
      }
    }
    return rows;
  }

  private truncateTornTail(): void {
    const raw = fs.readFileSync(this.logFile);
    if (raw.length === 0 || raw[raw.length - 1] === 0x0a) return;
    const lastNewline = raw.lastIndexOf(0x0a);
    fs.truncateSync(this.logFile, lastNewline + 1);
  }

  /** Read both files. Never throws: a failure is health 'unreadable'. */
  load(): void {
    this.seedSeq = this.readLastGoodHighestSeq();
    if (!fs.existsSync(this.logFile)) {
      this.rows = []; this.folded = emptyState(); this.health = 'absent';
      return;
    }
    try {
      this.truncateTornTail();
      const rows = this.parseLines(fs.readFileSync(this.logFile, 'utf8'));
      if (!rows) { this.rows = []; this.folded = emptyState(); this.health = 'unreadable'; return; }
      this.rows = rows;
      this.folded = foldRows(rows, this.opts.verify);
      // A log below last-good was rolled back: count it as lost, whatever it says.
      this.health = this.folded.highestSeq < this.seedSeq ? 'unreadable' : 'ok';
    } catch (err) {
      console.warn(`[team-access] log unreadable: ${err instanceof Error ? err.message : String(err)}`);
      this.rows = []; this.folded = emptyState(); this.health = 'unreadable';
    }
  }

  private readLastGoodHighestSeq(): number {
    try {
      const rows = this.parseLines(fs.readFileSync(this.lastGoodLog(), 'utf8'));
      return rows ? rows.reduce((m, r) => Math.max(m, r.seq), 0) : 0;
    } catch {
      // @silent-fallback-ok — no or an unreadable last-good seeds from the log (§3.3).
      return 0;
    }
  }

  healthState(): LogHealth { return this.health; }
  state(): TeamAccessState { return this.folded; }

  private nextSeq(): number { return Math.max(this.folded.highestSeq, this.seedSeq) + 1; }

  private appendLine(row: TeamAccessRow): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(this.logFile, 'a', 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(row)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.rows.push(row);
    this.folded = foldRows(this.rows, this.opts.verify);
    this.health = 'ok';
  }

  private requireSigner(): MachineSigner {
    if (!this.opts.signer) throw new Error('team-access-no-identity');
    return this.opts.signer;
  }

  appendMachineEvents(events: MachineEvent[]): MachineRow {
    const signer = this.requireSigner();
    const base = { seq: this.nextSeq(), kind: 'machine' as const, at: new Date((this.opts.now ?? Date.now)()).toISOString(), events };
    const row: MachineRow = { ...base, machineSig: signer.sign(rowPayload(base)) };
    this.appendLine(row);
    return row;
  }

  appendSignedRequest(req: Pick<RequestRow, 'receivedAt' | 'signedOrigin' | 'receipt'>): RequestRow {
    const signer = this.requireSigner();
    const base = { seq: this.nextSeq(), kind: 'request' as const, ...req };
    const row: RequestRow = { ...base, machineSig: signer.sign(rowPayload(base)) };
    this.appendLine(row);
    return row;
  }

  // ── Grant lookups ───────────────────────────────────────────────────────

  grantOf(personKey: string, ref: string): GrantAccess | null {
    const access = this.folded.grants.get(personKey)?.get(ref);
    return isGrantAccessEvent(access) ? access : null;
  }

  ownerOf(ref: string): string | null { return this.folded.owned.get(ref) ?? null; }

  // ── The confined list ──────────────────────────────────────────────────

  /** null means it could not be read: the caller refuses. Empty means none. */
  readConfined(): ConfinedEntry[] | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.confinedFile, 'utf8')) as { entries?: unknown };
      if (!Array.isArray(raw.entries)) return null;
      return raw.entries.filter((e): e is ConfinedEntry => !!e && typeof (e as ConfinedEntry).ref === 'string');
    } catch (err) {
      // Missing is empty only on an agent that shows no team use here. Callers add the signs they hold.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return this.health === 'absent' && !this.hasLastGoodTeamOn() ? [] : null;
      return null;
    }
  }

  private writeConfined(entries: ConfinedEntry[]): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.confinedFile}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ entries }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.confinedFile);
  }

  /** Before the first `team-on`, so an invite with no grants does not read as a missing file. */
  ensureConfinedFile(): void {
    if (!fs.existsSync(this.confinedFile)) this.writeConfined([]);
  }

  /** Add a conversation, keeping its first audience: it is fixed for good. Throws if the list cannot be read. */
  confine(entry: ConfinedEntry): void {
    const entries = this.readConfined();
    if (!entries) throw new Error('team-access-confined-unreadable');
    if (entries.some((e) => e.ref === entry.ref)) return;
    this.writeConfined([...entries, entry]);
  }

  isConfined(ref: string): boolean | null {
    const entries = this.readConfined();
    return entries ? entries.some((e) => e.ref === ref) : null;
  }

  /** After a clean boot, kept outside the access folder. */
  writeLastGood(): void {
    if (this.health !== 'ok') return;
    const entries = this.readConfined();
    if (!entries) return;
    fs.mkdirSync(this.lastGoodDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(this.logFile, this.lastGoodLog());
    fs.writeFileSync(this.lastGoodConfined(), JSON.stringify({ entries }), { mode: 0o600 });
    this.seedSeq = this.folded.highestSeq;
  }

  /** Was this agent ever in team use, by what survives here? */
  hasLastGoodTeamOn(): boolean {
    try {
      const rows = this.parseLines(fs.readFileSync(this.lastGoodLog(), 'utf8'));
      return !!rows && foldRows(rows, this.opts.verify).on;
    } catch {
      // @silent-fallback-ok — no last-good is no evidence; other signs are checked by the caller.
      return false;
    }
  }

  /**
   * The owner's restore: every parseable row of the log and last-good, merged, and the confined list
   * rebuilt from what remains plus `teamRefs` (conversations with stored team-phone messages). With
   * both the list and the log lost, `allRefs` is confined too, because a read-only grantee leaves no
   * message behind.
   */
  restore(input: { teamRefs: ConfinedEntry[]; allRefs: () => ConfinedEntry[] }): { logLost: boolean; listLost: boolean } {
    const readRows = (file: string): TeamAccessRow[] => {
      let raw = '';
      try { raw = fs.readFileSync(file, 'utf8'); } catch {
        // @silent-fallback-ok — a missing file contributes no rows.
        return [];
      }
      return raw.split('\n').flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const one = this.parseLines(line);
          return one ?? [];
        } catch {
          // @silent-fallback-ok — restore keeps every row that still parses.
          return [];
        }
      });
    };
    const live = readRows(this.logFile);
    const logLost = live.length === 0;
    const bySeq = new Map<number, TeamAccessRow>();
    for (const r of [...readRows(this.lastGoodLog()), ...live]) bySeq.set(r.seq, r);
    const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

    const current = fs.existsSync(this.confinedFile) ? this.readConfined() : null;
    const listLost = current === null;
    let lastGood: ConfinedEntry[] = [];
    try {
      lastGood = (JSON.parse(fs.readFileSync(this.lastGoodConfined(), 'utf8')) as { entries?: ConfinedEntry[] }).entries ?? [];
    } catch {
      // @silent-fallback-ok — no snapshot of the list; the rebuild below stands alone.
      lastGood = [];
    }
    const byRef = new Map<string, ConfinedEntry>();
    const sources = [...(current ?? []), ...lastGood, ...input.teamRefs, ...(logLost && listLost ? input.allRefs() : [])];
    for (const e of sources) if (!byRef.has(e.ref)) byRef.set(e.ref, e);

    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.writeConfined([...byRef.values()]);
    const tmp = `${this.logFile}.restore`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      for (const r of merged) fs.writeSync(fd, `${JSON.stringify(r)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.logFile);
    this.rows = merged;
    this.folded = foldRows(merged, this.opts.verify);
    this.seedSeq = Math.max(this.seedSeq, this.folded.highestSeq);
    this.health = 'ok';
    return { logLost, listLost };
  }
}
