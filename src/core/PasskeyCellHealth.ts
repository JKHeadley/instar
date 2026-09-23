/**
 * PasskeyCellHealth — the per-cell HEALTH state machine of the agent-held Google passkey
 * feature (spec docs/specs/agent-held-google-passkey.md §4 table + "Pool read degraded" +
 * flapping, §13 self-heal brakes) and the ONE digest item (§5.2) that reports every cell that
 * needs a human, coalesced across machines under the fixed key `passkey-health:digest`.
 *
 * What lives here is deterministic bookkeeping over PROOF OUTCOMES (§3.6): the proof worker
 * (cold proof / canary / repair — later increments) reports `ready` / `failed` / `unknown` /
 * `credential-rejected` / `removed-on-google` / `security`, and this module decides the cell's
 * state, the next due time, the unknown backoff, the flapping flag, and what the digest says.
 * It never drives a browser, never contacts Google, never grants anything: a state can only
 * move toward `healthy` on a `ready` proof (and, for the terminal states, only an operator
 * -triggered proof or a re-enrollment — §4 table), and terminal states take precedence over
 * every other row.
 *
 * The digest is a NOTIFICATION, not an action (§13 "self-heal before notify"): the same key is
 * upserted by the serving-lease holder on its tick (a new holder takes the key over), it
 * re-notifies at most once per 24h except for security and suspension changes (once per tick),
 * and unobserved-peer changes update it silently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const PASSKEY_HEALTH_FILE = path.join('state', 'passkey-health.json');
export const PASSKEY_DIGEST_LEDGER_FILE = path.join('state', 'passkey-health-digest.json');
export const PASSKEY_HEALTH_AUDIT_LOG = path.join('logs', 'passkey-health.jsonl');
export const PASSKEY_HEALTH_DIGEST_KEY = 'passkey-health:digest';

export const PASSKEY_HEALTH_STATES = [
  'healthy', 'degraded', 'breaker-open', 'unverified', 'unverified-stopped', 'rejected', 'security',
] as const;
export type PasskeyHealthState = typeof PASSKEY_HEALTH_STATES[number];
/** Terminal states: no automatic retry can leave them (§4 table). */
export const PASSKEY_TERMINAL_STATES: ReadonlySet<PasskeyHealthState> = new Set<PasskeyHealthState>(['breaker-open', 'unverified-stopped', 'security']);

export type PasskeyProofOutcome = 'ready' | 'failed' | 'unknown' | 'credential-rejected' | 'removed-on-google' | 'security';
export type PasskeyProofOrigin = 'watcher' | 'operator' | 'canary' | 'repair' | 'enrollment';
export type GoogleSideState = 'none' | 'pending-operator' | 'operator-attested' | 'removed-verified';

/** §4: proof cadence and the unknown backoff ladder (days). */
export const WEEKLY_PROOF_DAYS = 7;
export const NO_READY_UNVERIFIED_DAYS = 21;
export const UNKNOWN_BACKOFF_DAYS = [7, 14, 28] as const;
export const UNKNOWN_TO_UNVERIFIED = 3;
export const UNKNOWN_AT_CAP_TO_STOPPED = 3;
export const CONFIRMED_FAILURES_TO_BREAKER = 3;
/** §13: the confirming proof after a `failed` runs 1h later, once (max-attempts 2, wall-clock 90m). */
export const FAILED_CONFIRM_DELAY_MS = 60 * 60_000;
export const FAILED_CONFIRM_WINDOW_MS = 90 * 60_000;
/** Flapping: 3 healthy↔degraded flips within 30 days. */
export const FLAP_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const FLAP_THRESHOLD = 3;
export const DIGEST_BUZZ_MIN_INTERVAL_MS = 24 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

export interface PasskeyCellHealthRecord {
  canonicalEmail: string;
  machineId: string;
  state: PasskeyHealthState;
  stateSince: string;
  lastProofAt: string | null;
  lastProofOutcome: PasskeyProofOutcome | null;
  lastReadyAt: string | null;
  /** When the next automatic proof is due (null in a terminal state or while stopped). */
  nextProofDueAt: string | null;
  /** A `failed` awaiting its 1h confirming proof (§13 self-heal): set when the first failure lands. */
  pendingConfirmFailedAt: string | null;
  consecutiveConfirmedFailures: number;
  consecutiveUnknown: number;
  /** Index into UNKNOWN_BACKOFF_DAYS while `unverified`. */
  unknownBackoffIndex: number;
  /** Unknowns observed while already at the 28-day cap. */
  unknownAtCap: number;
  /** ISO instants of healthy↔degraded flips (bounded to the flap window). */
  flips: string[];
  flapping: boolean;
  googleSide: GoogleSideState;
  /** While the pool read path is degraded for this account, the 21-day and unknown clocks pause. */
  clocksPausedSince: string | null;
  /** Accumulated paused time, subtracted from the clocks (ms). */
  pausedMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface PasskeyHealthTransition {
  canonicalEmail: string;
  machineId: string;
  from: PasskeyHealthState;
  to: PasskeyHealthState;
  cause: string;
  at: string;
  flapping?: boolean;
}

export function newPasskeyCellHealth(canonicalEmail: string, machineId: string, nowMs: number): PasskeyCellHealthRecord {
  const at = new Date(nowMs).toISOString();
  return {
    canonicalEmail, machineId, state: 'healthy', stateSince: at, lastProofAt: null, lastProofOutcome: null, lastReadyAt: null,
    nextProofDueAt: at, pendingConfirmFailedAt: null, consecutiveConfirmedFailures: 0, consecutiveUnknown: 0, unknownBackoffIndex: 0, unknownAtCap: 0,
    flips: [], flapping: false, googleSide: 'none', clocksPausedSince: null, pausedMs: 0, createdAt: at, updatedAt: at,
  };
}

export interface ApplyOutcomeInput {
  cell: PasskeyCellHealthRecord;
  outcome: PasskeyProofOutcome;
  origin: PasskeyProofOrigin;
  nowMs: number;
  /** The cell was just re-enrolled (a fresh credential): the only way out of `security`. */
  reenrolled?: boolean;
}

export interface ApplyOutcomeResult {
  cell: PasskeyCellHealthRecord;
  transition: PasskeyHealthTransition | null;
  /** Something the watcher should schedule (the §13 confirming proof), if any. */
  scheduleConfirmAt: string | null;
}

function withState(cell: PasskeyCellHealthRecord, to: PasskeyHealthState, cause: string, nowMs: number): { cell: PasskeyCellHealthRecord; transition: PasskeyHealthTransition | null } {
  const at = new Date(nowMs).toISOString();
  if (cell.state === to) return { cell: { ...cell, updatedAt: at }, transition: null };
  const from = cell.state;
  const flipsWindow = nowMs - FLAP_WINDOW_MS;
  const isFlip = (from === 'healthy' && to === 'degraded') || (from === 'degraded' && to === 'healthy');
  const flips = [...cell.flips.filter((f) => Date.parse(f) > flipsWindow), ...(isFlip ? [at] : [])];
  // The flag tracks the 30-day window: it clears by itself once the flips age out (never sticky).
  const flapping = flips.length >= FLAP_THRESHOLD;
  const next: PasskeyCellHealthRecord = { ...cell, state: to, stateSince: at, updatedAt: at, flips, flapping };
  return { cell: next, transition: { canonicalEmail: cell.canonicalEmail, machineId: cell.machineId, from, to, cause, at, ...(flapping && !cell.flapping ? { flapping: true } : {}) } };
}

function dueIn(nowMs: number, days: number): string { return new Date(nowMs + days * DAY_MS).toISOString(); }

/**
 * Apply one proof outcome (§4 table; §13 self-heal). Pure: returns the new record and the
 * transition (null when the state did not change). Terminal states take precedence: nothing
 * but the named exits moves `security` / `breaker-open` / `unverified-stopped`.
 */
export function applyPasskeyProofOutcome(input: ApplyOutcomeInput): ApplyOutcomeResult {
  const { outcome, origin, nowMs } = input;
  const at = new Date(nowMs).toISOString();
  let cell: PasskeyCellHealthRecord = { ...input.cell, lastProofAt: at, lastProofOutcome: outcome, updatedAt: at };
  const operatorExit = origin === 'operator' || input.reenrolled === true;

  // `security` — any → security, no retry; only a re-enrollment leaves it.
  if (outcome === 'security') {
    const r = withState({ ...cell, pendingConfirmFailedAt: null, nextProofDueAt: null }, 'security', 'security-outcome', nowMs);
    return { ...r, scheduleConfirmAt: null };
  }
  if (cell.state === 'security' && !(outcome === 'ready' && input.reenrolled)) {
    return { cell, transition: null, scheduleConfirmAt: null };
  }
  // `removed-on-google` is recorded and never counts toward anything (§3.6).
  if (outcome === 'removed-on-google') return { cell, transition: null, scheduleConfirmAt: null };

  if (outcome === 'credential-rejected') {
    if (cell.state === 'healthy' || cell.state === 'degraded' || cell.state === 'unverified' || cell.state === 'rejected') {
      // No immediate retry: the weekly retry rides the unverified backoff (§4).
      const r = withState({ ...cell, pendingConfirmFailedAt: null, consecutiveUnknown: 0, nextProofDueAt: dueIn(nowMs, UNKNOWN_BACKOFF_DAYS[Math.min(cell.unknownBackoffIndex, UNKNOWN_BACKOFF_DAYS.length - 1)]) }, 'rejected', 'credential-rejected', nowMs);
      return { ...r, scheduleConfirmAt: null };
    }
    return { cell, transition: null, scheduleConfirmAt: null };
  }

  if (outcome === 'ready') {
    const reset = { ...cell, lastReadyAt: at, pendingConfirmFailedAt: null, consecutiveConfirmedFailures: 0, consecutiveUnknown: 0, unknownBackoffIndex: 0, unknownAtCap: 0, clocksPausedSince: null, pausedMs: 0, nextProofDueAt: dueIn(nowMs, WEEKLY_PROOF_DAYS) };
    switch (cell.state) {
      case 'healthy': return { cell: reset, transition: null, scheduleConfirmAt: null };
      case 'degraded': case 'unverified': case 'rejected': { const r = withState(reset, 'healthy', `ready-from-${cell.state}`, nowMs); return { ...r, scheduleConfirmAt: null }; }
      case 'breaker-open': case 'unverified-stopped':
        if (operatorExit) { const r = withState(reset, 'healthy', input.reenrolled ? 'reenrolled' : 'operator-proof-ready', nowMs); return { ...r, scheduleConfirmAt: null }; }
        // An automatic ready in a terminal state is recorded but does not reopen it.
        return { cell: { ...cell, lastReadyAt: at }, transition: null, scheduleConfirmAt: null };
      case 'security': { const r = withState(reset, 'healthy', 'reenrolled', nowMs); return { ...r, scheduleConfirmAt: null }; }
    }
  }

  if (outcome === 'failed') {
    // The table has no failed-row for rejected / unverified / terminal states: recorded, nothing moves
    // (unverified keeps its backoff — a failure must never SHORTEN the ladder into more sign-ins).
    if (PASSKEY_TERMINAL_STATES.has(cell.state) || cell.state === 'rejected' || cell.state === 'unverified') return { cell, transition: null, scheduleConfirmAt: null };
    cell = { ...cell, consecutiveUnknown: 0 };
    const pendingAt = cell.pendingConfirmFailedAt ? Date.parse(cell.pendingConfirmFailedAt) : null;
    const withinWindow = pendingAt !== null && nowMs - pendingAt <= FAILED_CONFIRM_WINDOW_MS;
    const confirms = withinWindow && nowMs - pendingAt! >= FAILED_CONFIRM_DELAY_MS;
    if (withinWindow && !confirms) {
      // A second failure BEFORE the hour keeps the ORIGINAL anchor (§13 max-attempts 2 / 90m): it can
      // never re-arm the window and so defeat the heal ceiling by failing fast.
      return { cell, transition: null, scheduleConfirmAt: null };
    }
    if (!confirms) {
      // First failure (or one past the 90m wall clock): arm the single confirming proof 1h out (§13).
      const confirmAt = new Date(nowMs + FAILED_CONFIRM_DELAY_MS).toISOString();
      return { cell: { ...cell, pendingConfirmFailedAt: at, nextProofDueAt: confirmAt }, transition: null, scheduleConfirmAt: confirmAt };
    }
    const confirmed = cell.consecutiveConfirmedFailures + 1;
    const base = { ...cell, pendingConfirmFailedAt: null, consecutiveConfirmedFailures: confirmed, nextProofDueAt: dueIn(nowMs, WEEKLY_PROOF_DAYS) };
    if (confirmed >= CONFIRMED_FAILURES_TO_BREAKER) {
      const r = withState({ ...base, nextProofDueAt: null }, 'breaker-open', 'three-confirmed-failures', nowMs);
      return { ...r, scheduleConfirmAt: null };
    }
    const r = withState(base, 'degraded', 'confirmed-failure', nowMs);
    return { ...r, scheduleConfirmAt: null };
  }

  // outcome === 'unknown'
  if (PASSKEY_TERMINAL_STATES.has(cell.state)) return { cell, transition: null, scheduleConfirmAt: null };
  const consecutive = cell.consecutiveUnknown + 1;
  if (cell.state === 'unverified') {
    const atCap = cell.unknownBackoffIndex >= UNKNOWN_BACKOFF_DAYS.length - 1;
    if (atCap) {
      const capCount = cell.unknownAtCap + 1;
      if (capCount >= UNKNOWN_AT_CAP_TO_STOPPED) {
        const r = withState({ ...cell, consecutiveUnknown: consecutive, unknownAtCap: capCount, nextProofDueAt: null }, 'unverified-stopped', 'three-unknown-at-cap', nowMs);
        return { ...r, scheduleConfirmAt: null };
      }
      return { cell: { ...cell, consecutiveUnknown: consecutive, unknownAtCap: capCount, nextProofDueAt: dueIn(nowMs, UNKNOWN_BACKOFF_DAYS[UNKNOWN_BACKOFF_DAYS.length - 1]) }, transition: null, scheduleConfirmAt: null };
    }
    const idx = cell.unknownBackoffIndex + 1;
    return { cell: { ...cell, consecutiveUnknown: consecutive, unknownBackoffIndex: idx, nextProofDueAt: dueIn(nowMs, UNKNOWN_BACKOFF_DAYS[idx]) }, transition: null, scheduleConfirmAt: null };
  }
  // `rejected` keeps its name (the table's unverified row starts from healthy/degraded only): unknowns
  // there just ride the backoff, so the "Google rejected this key" fact is never overwritten.
  if (cell.state === 'rejected') return { cell: { ...cell, consecutiveUnknown: consecutive, nextProofDueAt: dueIn(nowMs, UNKNOWN_BACKOFF_DAYS[Math.min(cell.unknownBackoffIndex, UNKNOWN_BACKOFF_DAYS.length - 1)]) }, transition: null, scheduleConfirmAt: null };
  if (consecutive >= UNKNOWN_TO_UNVERIFIED && (cell.state === 'healthy' || cell.state === 'degraded')) {
    const r = withState({ ...cell, consecutiveUnknown: consecutive, unknownBackoffIndex: 0, unknownAtCap: 0, pendingConfirmFailedAt: null, nextProofDueAt: dueIn(nowMs, UNKNOWN_BACKOFF_DAYS[0]) }, 'unverified', 'three-consecutive-unknown', nowMs);
    return { ...r, scheduleConfirmAt: null };
  }
  return { cell: { ...cell, consecutiveUnknown: consecutive, nextProofDueAt: dueIn(nowMs, WEEKLY_PROOF_DAYS) }, transition: null, scheduleConfirmAt: null };
}

/**
 * Advance the time-based rows (§4): no `ready` for 21 days ⇒ `unverified`; while the pool read
 * path is degraded for the account the clock PAUSES (the cell shows "not proved: pool degraded"
 * instead of drifting toward unverified). Pure.
 */
export function advancePasskeyHealthClocks(input: { cell: PasskeyCellHealthRecord; nowMs: number; poolDegraded: boolean }): { cell: PasskeyCellHealthRecord; transition: PasskeyHealthTransition | null } {
  const { nowMs, poolDegraded } = input;
  let cell = input.cell;
  const at = new Date(nowMs).toISOString();
  if (poolDegraded) {
    if (!cell.clocksPausedSince) cell = { ...cell, clocksPausedSince: at, updatedAt: at };
    return { cell, transition: null };
  }
  if (cell.clocksPausedSince) {
    const paused = Math.max(0, nowMs - Date.parse(cell.clocksPausedSince));
    cell = { ...cell, clocksPausedSince: null, pausedMs: cell.pausedMs + paused, updatedAt: at };
  }
  if (cell.state !== 'healthy' && cell.state !== 'degraded') return { cell, transition: null };
  const anchor = cell.lastReadyAt ? Date.parse(cell.lastReadyAt) : Date.parse(cell.createdAt);
  const effective = nowMs - anchor - cell.pausedMs;
  if (effective >= NO_READY_UNVERIFIED_DAYS * DAY_MS) {
    return withState({ ...cell, unknownBackoffIndex: 0, unknownAtCap: 0, pendingConfirmFailedAt: null, nextProofDueAt: dueIn(nowMs, UNKNOWN_BACKOFF_DAYS[0]) }, 'unverified', 'no-ready-21-days', nowMs);
  }
  return { cell, transition: null };
}

/** Whether an automatic proof may run for this cell now (terminal/stopped never; due time reached). */
export function proofDue(cell: PasskeyCellHealthRecord, nowMs: number): boolean {
  if (PASSKEY_TERMINAL_STATES.has(cell.state)) return false;
  if (!cell.nextProofDueAt) return false;
  return Date.parse(cell.nextProofDueAt) <= nowMs;
}

// ── Store (machine-local) + audit ────────────────────────────────────────────

interface HealthFile { version: 1; cells: Record<string, PasskeyCellHealthRecord> }

function atomicWriteJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class PasskeyHealthStore {
  private readonly file: string;
  private readonly auditFile: string;
  private readonly machineId: string;
  private readonly now: () => number;
  constructor(opts: { stateDir: string; machineId: string; now?: () => number }) {
    this.file = path.join(opts.stateDir, PASSKEY_HEALTH_FILE);
    this.auditFile = path.join(opts.stateDir, PASSKEY_HEALTH_AUDIT_LOG);
    this.machineId = opts.machineId;
    this.now = opts.now ?? Date.now;
  }
  private read(): HealthFile {
    if (!fs.existsSync(this.file)) return { version: 1, cells: {} };
    // A corrupt file THROWS (fail closed): a cell that silently read `healthy` would re-admit a repair.
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as HealthFile;
    if (raw.version !== 1 || !raw.cells || typeof raw.cells !== 'object' || Array.isArray(raw.cells)) throw new Error('passkey-health-corrupt');
    // A record outside the closed state set is corrupt too: an unknown state would fall through the
    // table and be counted as `unknown` (fail closed instead).
    for (const c of Object.values(raw.cells)) {
      if (!c || typeof c !== 'object' || !(PASSKEY_HEALTH_STATES as readonly string[]).includes((c as PasskeyCellHealthRecord).state)) throw new Error('passkey-health-corrupt');
    }
    return raw;
  }
  list(): PasskeyCellHealthRecord[] { return Object.values(this.read().cells).map((c) => ({ ...c })); }
  get(canonicalEmail: string): PasskeyCellHealthRecord | null { const c = this.read().cells[canonicalEmail]; return c ? { ...c } : null; }
  /** The cell's record, created `healthy` (due now) on first sight. */
  ensure(canonicalEmail: string): PasskeyCellHealthRecord {
    const data = this.read();
    if (data.cells[canonicalEmail]) return { ...data.cells[canonicalEmail] };
    const cell = newPasskeyCellHealth(canonicalEmail, this.machineId, this.now());
    atomicWriteJson(this.file, { ...data, cells: { ...data.cells, [canonicalEmail]: cell } });
    return { ...cell };
  }
  /** Record a proof outcome; persists the new record and appends the transition (if any) to the audit log. */
  recordOutcome(input: Omit<ApplyOutcomeInput, 'cell' | 'nowMs'> & { canonicalEmail: string }): ApplyOutcomeResult {
    const nowMs = this.now();
    const cell = this.ensure(input.canonicalEmail);
    const r = applyPasskeyProofOutcome({ cell, outcome: input.outcome, origin: input.origin, nowMs, reenrolled: input.reenrolled });
    this.put(r.cell);
    if (r.transition) this.audit(r.transition);
    return r;
  }
  /** Advance every cell's clocks (the watcher tick); returns the transitions. */
  advanceClocks(poolDegradedFor: (canonicalEmail: string) => boolean): PasskeyHealthTransition[] {
    const nowMs = this.now();
    const out: PasskeyHealthTransition[] = [];
    for (const cell of this.list()) {
      const r = advancePasskeyHealthClocks({ cell, nowMs, poolDegraded: poolDegradedFor(cell.canonicalEmail) });
      if (r.cell !== cell) this.put(r.cell);
      if (r.transition) { this.audit(r.transition); out.push(r.transition); }
    }
    return out;
  }
  /** Set the Google-side state of an EXISTING cell record; null when the cell was never held here (never mints a record). */
  setGoogleSide(canonicalEmail: string, googleSide: GoogleSideState): PasskeyCellHealthRecord | null {
    const cell = this.get(canonicalEmail);
    if (!cell) return null;
    const next = { ...cell, googleSide, updatedAt: new Date(this.now()).toISOString() };
    this.put(next);
    return next;
  }
  remove(canonicalEmail: string): boolean {
    const data = this.read();
    if (!data.cells[canonicalEmail]) return false;
    const { [canonicalEmail]: _gone, ...rest } = data.cells;
    atomicWriteJson(this.file, { ...data, cells: rest });
    return true;
  }
  private put(cell: PasskeyCellHealthRecord): void {
    const data = this.read();
    atomicWriteJson(this.file, { ...data, cells: { ...data.cells, [cell.canonicalEmail]: cell } });
  }
  private audit(t: PasskeyHealthTransition): void {
    // States only — never an email in the log line (the cell is named by its machine-local hash).
    const line = { ts: t.at, machineId: t.machineId, cell: createHash('sha256').update(`${t.machineId}:${t.canonicalEmail}`).digest('hex').slice(0, 16), from: t.from, to: t.to, cause: t.cause, ...(t.flapping ? { flapping: true } : {}) };
    try {
      fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
      fs.appendFileSync(this.auditFile, `${JSON.stringify(line)}\n`);
    } catch {
      // @silent-fallback-ok — the state file (the authority) is already written; a failed audit
      // append is a lost breadcrumb, never lost state. Nothing here to retry safely.
    }
  }
}

// ── The digest (§5.2): one item, one key, coalesced across machines ──────────

export interface PasskeyDigestCellLine {
  canonicalEmail: string;
  machineId: string;
  state: PasskeyHealthState | 'quarantined' | 'legacy-overdue' | 'orphan-on-google';
  googleSide: GoogleSideState;
  detail: string;
  flapping?: boolean;
  poolDegraded?: boolean;
}

export interface PasskeyDigestInput {
  cells: PasskeyDigestCellLine[];
  pendingRevokes: Array<{ canonicalEmail: string; targetMachineId: string; state: string; attempts: number }>;
  chromeGateFailures: string[];
  suspension: { state: string; note?: string } | null;
  unobservedPeers: string[];
  poolDegraded: boolean;
  nowIso: string;
}

export interface PasskeyDigest {
  title: string;
  body: string;
  /** Sha256 of the body WITHOUT the unobserved-peer section (those changes are silent, §5.2). */
  buzzHash: string;
  /** Sha256 of the full body (any change re-upserts the item silently). */
  bodyHash: string;
  /** Sha256 of the SECURITY + suspension lines only: a change HERE may buzz per tick; anything else waits for the floor. */
  urgentHash: string;
  empty: boolean;
  /** Security or suspension content present (the urgent title); the per-tick buzz is gated on `urgentHash` CHANGING. */
  urgent: boolean;
  counts: { cells: number; pendingRevokes: number; chromeGateFailures: number; unobservedPeers: number };
}

const DIGEST_STATES: ReadonlySet<PasskeyDigestCellLine['state']> = new Set(['degraded', 'breaker-open', 'unverified', 'unverified-stopped', 'rejected', 'security', 'quarantined', 'legacy-overdue', 'orphan-on-google']);

/** Build the digest text from its inputs. Pure. Lists ONLY what needs a human (§5.2). */
export function buildPasskeyHealthDigest(input: PasskeyDigestInput): PasskeyDigest {
  const lines: string[] = [];
  const cells = input.cells.filter((c) => DIGEST_STATES.has(c.state) || c.googleSide === 'pending-operator' || c.googleSide === 'operator-attested');
  const urgent = cells.some((c) => c.state === 'security') || input.suspension !== null;
  if (cells.length > 0) {
    lines.push('Cells needing attention:');
    for (const c of cells.sort((a, b) => a.canonicalEmail.localeCompare(b.canonicalEmail) || a.machineId.localeCompare(b.machineId))) {
      const flags = [c.flapping ? 'flapping' : null, c.poolDegraded ? 'not proved: pool degraded' : null, c.googleSide !== 'none' ? `google-side: ${c.googleSide}` : null].filter(Boolean).join('; ');
      lines.push(`- ${c.canonicalEmail} on ${c.machineId}: ${c.state}${c.detail ? ` — ${c.detail}` : ''}${flags ? ` (${flags})` : ''}`);
    }
  }
  if (input.pendingRevokes.length > 0) {
    lines.push('Revokes still awaiting a peer:');
    for (const r of input.pendingRevokes) lines.push(`- ${r.canonicalEmail} → ${r.targetMachineId}: ${r.state}, ${r.attempts} attempt(s)`);
  }
  if (input.chromeGateFailures.length > 0) lines.push(`Chrome gate failed on: ${input.chromeGateFailures.join(', ')}`);
  if (input.suspension) lines.push(`Suspension: ${input.suspension.state}${input.suspension.note ? ` — ${input.suspension.note}` : ''}`);
  const bodyWithoutPeers = lines.join('\n');
  if (input.unobservedPeers.length > 0) lines.push(`Peers unobserved by the pool read path: ${input.unobservedPeers.join(', ')}${input.poolDegraded ? ' (enrollment and proofs are paused here until they answer or are excluded)' : ''}`);
  // Both hashes cover the CONTENT only — the "As of" stamp is appended after hashing, so a tick that
  // changes nothing but the clock is `none`, never a silent re-upsert.
  const content = lines.join('\n');
  const body = lines.length > 0 ? `${content}\nAs of ${input.nowIso}.` : '';
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const counts = { cells: cells.length, pendingRevokes: input.pendingRevokes.length, chromeGateFailures: input.chromeGateFailures.length, unobservedPeers: input.unobservedPeers.length };
  const title = cells.some((c) => c.state === 'security') ? 'Passkey SECURITY event — a cell signed in as a different account'
    : input.suspension ? `Passkey sign-ins suspended (${input.suspension.state})`
    : `Passkey health: ${counts.cells} cell(s) need attention${counts.pendingRevokes ? `, ${counts.pendingRevokes} revoke(s) pending` : ''}`;
  const urgentLines = [
    ...cells.filter((c) => c.state === 'security').map((c) => `${c.canonicalEmail}@${c.machineId}`).sort(),
    input.suspension ? `suspension:${input.suspension.state}` : '',
  ];
  return { title, body, buzzHash: sha(bodyWithoutPeers), bodyHash: sha(content), urgentHash: sha(urgentLines.join('\n')), empty: body === '', urgent, counts };
}

interface DigestLedgerFile { version: 1; lastBuzzAt: string | null; lastBuzzHash: string | null; lastUrgentHash: string | null; lastBodyHash: string | null; lastUpsertAt: string | null; resolvedAt: string | null }
const EMPTY_LEDGER: DigestLedgerFile = { version: 1, lastBuzzAt: null, lastBuzzHash: null, lastUrgentHash: null, lastBodyHash: null, lastUpsertAt: null, resolvedAt: null };

/** Decides buzz vs silent update vs resolve for the ONE digest key; persists what it last did. */
export class PasskeyDigestLedger {
  private readonly file: string;
  private readonly now: () => number;
  constructor(opts: { stateDir: string; now?: () => number }) {
    this.file = path.join(opts.stateDir, PASSKEY_DIGEST_LEDGER_FILE);
    this.now = opts.now ?? Date.now;
  }
  /** The ledger, plus whether it could be read — an unreadable ledger DENIES buzzing until it is rewritten. */
  read(): DigestLedgerFile & { unreadable?: true } {
    if (!fs.existsSync(this.file)) return { ...EMPTY_LEDGER };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as DigestLedgerFile;
      if (raw.version !== 1) return { ...EMPTY_LEDGER, unreadable: true };
      return { ...EMPTY_LEDGER, ...raw };
    } catch {
      // @silent-fallback-ok — NOT permissive: an unreadable ledger means "the last buzz time is
      // unknown", and `decide` answers SILENT (never buzz) until a successful record rewrites it.
      return { ...EMPTY_LEDGER, unreadable: true };
    }
  }
  /**
   * `buzz`: content changed since the LAST BUZZ (ignoring the silent peer section) and either 24h
   * passed or the SECURITY/suspension section itself changed; `silent`: body changed but no buzz is
   * allowed (or only peers changed, or the ledger is unreadable); `resolve`: nothing left to report
   * and an item was open; `none`: nothing changed.
   */
  decide(digest: PasskeyDigest): 'buzz' | 'silent' | 'resolve' | 'none' {
    const s = this.read();
    if (digest.empty) return s.lastBodyHash && !s.resolvedAt ? 'resolve' : 'none';
    if (s.unreadable) return 'silent';
    // Buzz eligibility is measured against the LAST BUZZ, not the last silent update: content that
    // changed silently inside the 24h floor buzzes once the floor passes, even if the body itself
    // has not changed since that silent update.
    const contentChanged = s.lastBuzzHash !== digest.buzzHash || !!s.resolvedAt;
    // Only a CHANGE in the security/suspension section may buzz inside the floor — a standing
    // security line does not turn every unrelated delta into a buzz.
    const urgentChanged = digest.urgent && (s.lastUrgentHash !== digest.urgentHash || !!s.resolvedAt);
    const since = s.lastBuzzAt ? this.now() - Date.parse(s.lastBuzzAt) : Number.POSITIVE_INFINITY;
    if (contentChanged && (urgentChanged || since >= DIGEST_BUZZ_MIN_INTERVAL_MS)) return 'buzz';
    if (s.lastBodyHash === digest.bodyHash && !s.resolvedAt) return 'none';
    return 'silent';
  }
  record(digest: PasskeyDigest, action: 'buzz' | 'silent' | 'resolve'): void {
    const { unreadable: _u, ...s } = this.read();
    const at = new Date(this.now()).toISOString();
    const next: DigestLedgerFile = action === 'resolve'
      ? { ...s, lastBodyHash: null, lastBuzzHash: null, lastUrgentHash: null, lastUpsertAt: at, resolvedAt: at }
      : { ...s, lastBodyHash: digest.bodyHash, lastUpsertAt: at, resolvedAt: null, ...(action === 'buzz' ? { lastBuzzAt: at, lastBuzzHash: digest.buzzHash, lastUrgentHash: digest.urgentHash } : {}) };
    atomicWriteJson(this.file, next);
  }
}
