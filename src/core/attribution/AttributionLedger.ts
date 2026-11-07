/**
 * AttributionLedger — the paper trail. One append-only row each time a claim about
 * what a person said is written or sent with new wording or a new verdict.
 * Spec: docs/specs/attribution-paper-trail.md section 3.
 *
 * `claimId` identifies a claim across rewordings; `id` identifies one check. Rotation
 * gzips into archives that are kept and never deleted.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { SourceRef } from './marker.js';

export type AttributionSurface = 'note-write' | 'send' | 'threadline' | 'memory-route' | 'audit';
export type ClaimRelation = 'origin' | 'reconstructed' | 'unconfirmed' | 'unsourced';
export type LinkedBy = 'edit' | 'judge';

export interface LedgerRow {
  id: string;
  claimId: string;
  parentClaimId?: string;
  linkedBy?: LinkedBy;
  ts: string;
  machineId: string;
  surface: AttributionSurface;
  path?: string;
  person: string;
  claim: string;
  kind: string;
  ref?: SourceRef;
  quote?: string;
  verdict: string;
  reason?: string;
  relation: ClaimRelation;
  strength?: string;
  /** False when a refusal was only recorded (`record` mode), so the text did reach its target. */
  enforced?: boolean;
  /** The full text and exact-fact results of an `unchecked` row, so the audit can re-judge it. */
  context?: { text: string; recentConversation?: string; exact?: Record<string, unknown> };
}

export type LedgerInput = Omit<LedgerRow, 'id' | 'claimId' | 'ts' | 'machineId'> & { claimId?: string; ts?: string };

export interface AttributionLedgerOptions {
  stateDir: string;
  machineId: string;
  scrub?: (text: string) => string;
  rotateAtRows?: number;
  now?: () => Date;
}

const REFUSED = new Set([
  'refuse',
  'malformed-marker',
  'unsourced',
  'quote-not-in-record',
  'date-mismatch',
  'record-not-theirs',
  'identity-unverified',
  'relayed',
  'overstated',
  'promoted-unsourced',
  'later-than-claim',
  'cannot-be-shown',
]);

/** A refused note write that was really refused, or a row the read-back found never landed. */
export function neverReachedItsTarget(row: LedgerRow): boolean {
  if (row.verdict === 'not-written') return true;
  return row.surface === 'note-write' && REFUSED.has(row.verdict) && row.enforced !== false;
}

function fingerprint(claimId: string, claim: string, verdict: string, parent?: string): string {
  return crypto.createHash('sha256').update(`${claimId}\0${claim}\0${verdict}\0${parent ?? ''}`).digest('hex');
}

function normalizedKey(person: string, claim: string): string {
  return `${person.trim().toLowerCase()}\0${claim.replace(/\s+/g, ' ').trim()}`;
}

function refKey(ref: SourceRef): string {
  return `${ref.channel}|${ref.conversation}|${ref.message}`;
}

export class AttributionLedger {
  private readonly dir: string;
  private readonly file: string;
  private readonly scrub: (text: string) => string;
  private readonly rotateAtRows: number;
  private readonly now: () => Date;
  private readonly machineId: string;
  private seen: Set<string> | null = null;
  private liveRows = 0;
  private cache: { size: number; rows: LedgerRow[] } | null = null;
  private claimIds = new Map<string, string>();
  private refs = new Set<string>();

  constructor(options: AttributionLedgerOptions) {
    this.dir = path.join(options.stateDir, 'attribution');
    this.file = path.join(this.dir, 'ledger.jsonl');
    this.scrub = options.scrub ?? ((text) => text);
    this.rotateAtRows = options.rotateAtRows ?? 50_000;
    this.now = options.now ?? (() => new Date());
    this.machineId = options.machineId;
  }

  /** Appends a row unless this claim already holds this wording and verdict. Returns the row either way. */
  record(input: LedgerInput): { row: LedgerRow; written: boolean } {
    this.load();
    const claimId = input.claimId ?? `clm_${crypto.randomUUID()}`;
    const claim = this.scrub(input.claim);
    const row: LedgerRow = {
      ...input,
      id: `chk_${crypto.randomUUID()}`,
      claimId,
      claim,
      ...(input.quote === undefined ? {} : { quote: this.scrub(input.quote) }),
      ...(input.reason === undefined ? {} : { reason: this.scrub(input.reason) }),
      ts: input.ts ?? this.now().toISOString(),
      machineId: this.machineId,
    };
    if (input.context) {
      row.context = {
        ...input.context,
        text: this.scrub(input.context.text),
        ...(input.context.recentConversation === undefined ? {} : { recentConversation: this.scrub(input.context.recentConversation) }),
      };
    }
    const key = fingerprint(claimId, claim, row.verdict, row.parentClaimId);
    if (this.seen!.has(key)) return { row, written: false };
    if (this.liveRows >= this.rotateAtRows) this.rotate();
    fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    this.seen!.add(key);
    this.liveRows += 1;
    this.index(row);
    this.cache = null;
    return { row, written: true };
  }

  /** The claim already holding this wording for this person, so a re-check adds no row. */
  claimIdFor(person: string, claim: string): string | null {
    this.load();
    return this.claimIds.get(normalizedKey(person, this.scrub(claim))) ?? null;
  }

  /** A pinned or earlier ledger row holds this ref, so it may stand without a live record. */
  hasRef(ref: SourceRef): boolean {
    this.load();
    return this.refs.has(refKey(ref));
  }

  /** The newest claim about this person whose words sit verbatim in the replaced text. Edit lineage. */
  parentInText(person: string, oldText: string): string | null {
    const haystack = oldText.replace(/\s+/g, ' ');
    const wanted = person.trim().toLowerCase();
    const rows = this.rows();
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (neverReachedItsTarget(row) || row.person.trim().toLowerCase() !== wanted) continue;
      if (row.claim.length >= 4 && haystack.includes(row.claim.replace(/\s+/g, ' ').trim())) return row.claimId;
    }
    return null;
  }

  /** Earlier claims about a person, newest first, one row per claim. Candidates for a judged link. */
  candidatesFor(person: string, exceptClaimId: string, limit = 20): LedgerRow[] {
    const wanted = person.trim().toLowerCase();
    const seen = new Set<string>([exceptClaimId]);
    const out: LedgerRow[] = [];
    const rows = this.rows();
    for (let i = rows.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const row = rows[i];
      if (seen.has(row.claimId) || neverReachedItsTarget(row) || row.person.trim().toLowerCase() !== wanted) continue;
      seen.add(row.claimId);
      out.push(row);
    }
    return out;
  }

  /** Every claim linked to this one, ancestors and descendants, oldest first. What a trace shows. */
  lineage(claimId: string, options: { includeArchives?: boolean } = {}): LedgerRow[] {
    const all = options.includeArchives ? [...this.archivedRows(), ...this.rows()] : this.rows();
    const neighbours = new Map<string, Set<string>>();
    const link = (a: string, b: string) => { if (!neighbours.has(a)) neighbours.set(a, new Set()); neighbours.get(a)!.add(b); };
    for (const row of all) if (row.parentClaimId) { link(row.claimId, row.parentClaimId); link(row.parentClaimId, row.claimId); }
    const members = new Set<string>();
    const queue = [claimId];
    while (queue.length) {
      const id = queue.pop()!;
      if (members.has(id)) continue;
      members.add(id);
      for (const next of neighbours.get(id) ?? []) queue.push(next);
    }
    return all.filter((row) => members.has(row.claimId)).sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /** Live rows only, oldest first. A trace asks for archives explicitly. */
  rows(): LedgerRow[] {
    // A check reads the ledger several times, so a parse is reused until the file changes.
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return [];
    }
    if (this.cache?.size === size) return this.cache.rows;
    const rows = this.parse(fs.readFileSync(this.file, 'utf8'));
    this.cache = { size, rows };
    return rows;
  }

  archivedRows(): LedgerRow[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((name) => /^ledger\.\d+\.jsonl\.gz$/.test(name))
      .sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
      .flatMap((name) => this.parse(zlib.gunzipSync(fs.readFileSync(path.join(this.dir, name))).toString('utf8')));
  }

  /** A claim's full chain: every row of it and of its ancestors, oldest first. */
  chain(claimId: string, options: { includeArchives?: boolean } = {}): LedgerRow[] {
    const all = options.includeArchives ? [...this.archivedRows(), ...this.rows()] : this.rows();
    const parentOf = new Map<string, string>();
    for (const row of all) if (row.parentClaimId) parentOf.set(row.claimId, row.parentClaimId);
    const members = new Set<string>();
    for (let id: string | undefined = claimId; id && !members.has(id); id = parentOf.get(id)) members.add(id);
    return all.filter((row) => members.has(row.claimId)).sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /** When a claim first appeared, following its parents to the root. Null when the ledger has no row. */
  firstSeen(claimId: string): string | null {
    // A refused attempt never reached the note, so it cannot be where the claim began.
    const rows = this.chain(claimId, { includeArchives: true });
    const notWritten = new Set(rows.filter((row) => row.verdict === 'not-written').map((row) => row.claim));
    const chain = rows.filter((row) => !neverReachedItsTarget(row) && !notWritten.has(row.claim));
    return chain.length ? chain[0].ts : null;
  }

  private load(): void {
    if (this.seen) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const rows = this.rows();
    this.liveRows = rows.length;
    this.seen = new Set(rows.map((row) => fingerprint(row.claimId, row.claim, row.verdict, row.parentClaimId)));
    for (const row of rows) this.index(row);
  }

  private index(row: LedgerRow): void {
    this.claimIds.set(normalizedKey(row.person, row.claim), row.claimId);
    if (row.ref && !neverReachedItsTarget(row)) this.refs.add(refKey(row.ref));
  }

  private rotate(): void {
    const numbers = fs
      .readdirSync(this.dir)
      .map((name) => /^ledger\.(\d+)\.jsonl\.gz$/.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
    const archive = path.join(this.dir, `ledger.${next}.jsonl.gz`);
    fs.writeFileSync(archive, zlib.gzipSync(fs.readFileSync(this.file)), { mode: 0o600 });
    fs.writeFileSync(this.file, '', { mode: 0o600 });
    this.liveRows = 0;
    this.cache = null;
  }

  private parse(text: string): LedgerRow[] {
    const rows: LedgerRow[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as LedgerRow);
      } catch {
        // A torn final line from a crash is skipped; the rest of the ledger still reads.
      }
    }
    return rows;
  }
}
