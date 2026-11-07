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
import {
  canonicalStringFromHash, ledgerViewKey, receiptPayload, sha256Hex, verifyMachineSignature,
  type LedgerView, type MachineKeyLookup, type MachineSignature, type MachineSigner,
} from './AppRecordSignatures.js';
import { DEVICE_TIME_WINDOW_MS, isStrictLowSDer, parseDevicePublicKey } from './MobileDeviceKeys.js';
import type { GrantAccess } from '../permissions/TeamAccess.js';
import type { OrgRole } from '../permissions/types.js';

export const TEAM_ACCESS_DIR = path.join('state', 'team-access');
export const TEAM_ACCESS_LAST_GOOD_DIR = path.join('state', 'team-access-last-good');

export interface RequestRow {
  seq: number;
  kind: 'request';
  receivedAt: string;
  /** The phone's stored signed request and the machine's receipt (mobile-native-conversations §4.6). */
  signedOrigin: {
    keyHash: string; deviceId: string; bodyB64: string; bodySha256: string;
    publicKey?: string; host?: string; method?: string; pathWithQuery?: string; timeMs?: string; sig?: string;
  };
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

/** The routes whose signed requests may carry access events. */
export const TEAM_ACCESS_WRITE_PATHS: readonly RegExp[] = [
  /^\/mobile\/team\/invites$/, /^\/mobile\/team\/grants$/, /^\/mobile\/team\/people\/[^/]+$/, /^\/mobile\/team\/off$/,
];

/** Which events each route may carry. A row's signature covers its path, so this binds what was signed. */
export function eventsFitPath(pathWithQuery: string, events: ReadonlyArray<{ type: string; personKey?: string }>): boolean {
  const person = /^\/mobile\/team\/people\/([^/]+)$/.exec(pathWithQuery);
  if (person) {
    let key = person[1];
    try { key = decodeURIComponent(key); } catch { return false; } // @silent-fallback-ok — a malformed path fits nothing
    return events.every((e) => (e.type === 'person-set' || e.type === 'person-remove') && e.personKey === key);
  }
  const allowed = pathWithQuery === '/mobile/team/invites' ? ['team-on', 'owner-pin', 'person-add', 'grant']
    : pathWithQuery === '/mobile/team/grants' ? ['grant', 'grant-remove']
      : pathWithQuery === '/mobile/team/off' ? ['team-off'] : [];
  return events.every((e) => allowed.includes(e.type));
}

/**
 * A row's verdict. The phone's signature is re-checked over the stored body, the path must be an
 * access route, and the machine must have signed both the receipt and the row. A key this machine
 * cannot look up reads `unknown`, never `failed`.
 */
export function verifyTeamAccessRow(row: TeamAccessRow, ledger: LedgerView, machineKey: MachineKeyLookup): RowVerdict {
  const { machineSig, ...rest } = row;
  const atMs = Date.parse(row.kind === 'request' ? row.receivedAt : row.at);
  if (!Number.isFinite(atMs)) return 'failed';
  const rowSig = verifyMachineSignature(machineKey, machineSig, rowPayload(rest as Omit<RequestRow, 'machineSig'> | Omit<MachineRow, 'machineSig'>), atMs);
  if (rowSig === 'bad') return 'failed';
  if (row.kind === 'machine') return rowSig === 'ok' ? 'verified' : 'unknown';

  const o = row.signedOrigin;
  if (!ledger) return 'unknown';
  const entry = ledger.get(ledgerViewKey(o.keyHash, o.deviceId));
  if (!entry) return 'unknown';
  if (o.publicKey !== entry.publicKey || o.deviceId !== entry.deviceId) return 'failed';
  if (typeof o.host !== 'string' || typeof o.pathWithQuery !== 'string' || typeof o.timeMs !== 'string' || typeof o.sig !== 'string') return 'failed';
  if ((o.method ?? '').toUpperCase() !== 'POST' || !TEAM_ACCESS_WRITE_PATHS.some((re) => re.test(o.pathWithQuery as string))) return 'failed';
  const key = parseDevicePublicKey(entry.publicKey);
  const sigBytes = /^[A-Za-z0-9_-]+$/.test(o.sig) ? Buffer.from(o.sig, 'base64url') : null;
  if (!key || !sigBytes || !isStrictLowSDer(sigBytes)) return 'failed';
  const canonical = canonicalStringFromHash(o.deviceId, o.host, o.method as string, o.pathWithQuery, o.timeMs, o.bodySha256);
  let sigOk = false;
  try { sigOk = crypto.verify('sha256', Buffer.from(canonical), { key, dsaEncoding: 'der' }, sigBytes); } catch { sigOk = false; } // @silent-fallback-ok — a malformed signature is a failed row
  if (!sigOk) return 'failed';
  const activated = Date.parse(entry.activatedAt);
  const revoked = entry.revokedAt ? Date.parse(entry.revokedAt) : null;
  if (!Number.isFinite(activated) || atMs < activated || (revoked !== null && atMs >= revoked)) return 'failed';
  if (!/^\d{10,16}$/.test(o.timeMs) || Math.abs(Number(o.timeMs) - atMs) > DEVICE_TIME_WINDOW_MS) return 'failed';
  if (!row.receipt) return 'failed';
  // The signature binds the path, and the path binds what it may carry: `/off` is the Face ID route.
  let signed: ReturnType<typeof parseSignedEvents> = null;
  try { signed = parseSignedEvents(JSON.parse(Buffer.from(o.bodyB64 ?? '', 'base64').toString('utf8'))); } catch { signed = null; } // @silent-fallback-ok — an unparseable body is a failed row, on the next line
  if (!signed || !eventsFitPath(o.pathWithQuery as string, signed)) return 'failed';
  const receipt = verifyMachineSignature(machineKey, row.receipt, receiptPayload(sha256Hex(canonical), row.receivedAt, row.receipt.machineId), atMs);
  if (receipt === 'bad') return 'failed';
  return receipt === 'ok' && rowSig === 'ok' ? 'verified' : 'unknown';
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
    case 'restored': return;
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
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) foldRowInto(s, row, verify);
  return s;
}

/** Every conversation the log shows as ever shared or owned. An owned one keeps its person. */
export function confinedFromRows(rows: ReadonlyArray<TeamAccessRow>, verify: (row: TeamAccessRow) => RowVerdict): ConfinedEntry[] {
  const owned = new Map<string, string>();
  const shared = new Set<string>();
  for (const row of rows) {
    if (verify(row) !== 'verified') continue;
    if (row.kind === 'machine') {
      for (const e of row.events) if (e.type === 'conversation-own') owned.set(e.ref, e.personKey);
      continue;
    }
    for (const e of bodyEvents(row) ?? []) if (e.type === 'grant') shared.add(e.ref);
  }
  const entryFor = (ref: string): ConfinedEntry => (ref.startsWith('telegram:') ? { ref } : { ref, placeKey: `app:${ref}` });
  return [
    ...[...owned].map(([ref, personKey]) => ({ ...entryFor(ref), personKey })),
    ...[...shared].filter((ref) => !owned.has(ref)).map(entryFor),
  ];
}

/** One row onto a state. Rows must arrive in `seq` order, as an append does. */
export function foldRowInto(s: TeamAccessState, row: TeamAccessRow, verify: (row: TeamAccessRow) => RowVerdict): void {
  s.highestSeq = Math.max(s.highestSeq, row.seq);
  if (verify(row) !== 'verified') return;
  if (row.kind === 'machine') {
    for (const e of row.events) applyMachineEvent(s, e);
    return;
  }
  if (s.bindings.get(row.signedOrigin.keyHash) !== 'owner') return;
  const events = bodyEvents(row);
  if (!events) return;
  for (const e of events) applyRequestEvent(s, e);
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
  private refoldPending = false;

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
      // A log below last-good was rolled back: count it as lost, whatever it says. On one machine every
      // phone is in the ledger, so a row it cannot place means the ledger failed: strict, not empty.
      const unplaced = rows.some((r) => r.kind === 'request' && this.opts.verify(r) === 'unknown');
      // A lost or altered row in the middle could be a downgrade: the fold would quietly give back
      // what it took away. Past the last accepted restore, every row must be there and verify.
      this.health = this.folded.highestSeq < this.seedSeq || unplaced || !this.intact(rows) ? 'unreadable' : 'ok';
    } catch (err) {
      console.warn(`[team-access] log unreadable: ${err instanceof Error ? err.message : String(err)}`);
      this.rows = []; this.folded = emptyState(); this.health = 'unreadable';
    }
  }

  private intact(rows: ReadonlyArray<TeamAccessRow>): boolean {
    const sorted = [...rows].sort((a, b) => a.seq - b.seq);
    let from = 0;
    for (const r of sorted) {
      if (r.kind !== 'machine' || this.opts.verify(r) !== 'verified') continue;
      for (const e of r.events) if (e.type === 'restored') from = Math.max(from, e.throughSeq);
    }
    let expected = from + 1;
    for (const r of sorted) {
      if (r.seq <= from) continue;
      if (r.seq !== expected || this.opts.verify(r) === 'failed') return false;
      expected += 1;
    }
    return true;
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
  allRows(): ReadonlyArray<TeamAccessRow> { return this.rows; }
  state(): TeamAccessState {
    if (this.refoldPending) {
      this.folded = foldRows(this.rows, this.opts.verify);
      this.refoldPending = this.rows.some((r) => this.opts.verify(r) === 'unknown');
    }
    return this.folded;
  }

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
    foldRowInto(this.folded, row, this.opts.verify);
    // A row that cannot be placed yet (a key cache after an identity change) must not be lost.
    if (this.opts.verify(row) === 'unknown') this.refoldPending = true;
    this.health = 'ok';
    this.snapshot();
  }

  /** The snapshot a rollback is judged against. Failing to take one never undoes a change. */
  private snapshot(): void {
    try { this.writeLastGood(); } catch (err) {
      console.warn(`[team-access] last-good not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private requireSigner(): MachineSigner {
    if (!this.opts.signer) throw new Error('team-access-no-identity');
    return this.opts.signer;
  }

  appendMachineEvents(events: MachineEvent[]): MachineRow {
    const signer = this.requireSigner();
    if (this.health === 'unreadable') throw new Error('team-access-unreadable');
    const base = { seq: this.nextSeq(), kind: 'machine' as const, at: new Date((this.opts.now ?? Date.now)()).toISOString(), events };
    const row: MachineRow = { ...base, machineSig: signer.sign(rowPayload(base)) };
    this.appendLine(row);
    return row;
  }

  appendSignedRequest(req: Pick<RequestRow, 'receivedAt' | 'signedOrigin' | 'receipt'>): RequestRow {
    const signer = this.requireSigner();
    const base = { seq: this.nextSeq(), kind: 'request' as const, ...req };
    const row: RequestRow = { ...base, machineSig: signer.sign(rowPayload(base)) };
    if (this.health === 'unreadable') throw new Error('team-access-unreadable');
    // A row the fold would ignore must never answer ok: the change would not have happened.
    if (this.opts.verify(row) !== 'verified') throw new Error('team-access-row-refused');
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
    this.snapshot();
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
   * rebuilt from what remains, what the log shows, and `teamRefs` (conversations with stored team-phone
   * messages). With no list left and a visibly damaged log, `allRefs` is confined too: a read-only
   * grantee leaves no message behind. A lost final row leaves no gap, so that one case cannot be seen.
   */
  restore(input: { teamRefs: ConfinedEntry[]; allRefs: () => ConfinedEntry[] }): { logLost: boolean; listLost: boolean } {
    const wasUnreadable = this.health === 'unreadable';
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
    // The log says what was ever shared or owned, even where nothing was said there: a read-only grant
    // leaves no message, so a list rebuilt from messages alone would drop it.
    const fromLog = confinedFromRows(merged, this.opts.verify);
    // With no list left and a log visibly damaged, nothing may be released: every conversation is
    // confined. A surviving log with no gap is taken at its word, since it holds every grant.
    const damaged = logLost || wasUnreadable || merged.some((r, i) => r.seq !== i + 1 || this.opts.verify(r) !== 'verified');
    const noList = listLost && lastGood.length === 0;
    const sources = [...(current ?? []), ...lastGood, ...fromLog, ...input.teamRefs, ...(noList && damaged ? input.allRefs() : [])];
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
    // Recorded, or the gap a repair accepted would read as damage again at the next boot.
    if (this.opts.signer) this.appendMachineEvents([{ type: 'restored', throughSeq: this.folded.highestSeq }]);
    return { logLost, listLost };
  }
}
