/**
 * PasskeyPoolState — the POOL READ PATH for the agent-held Google passkey feature
 * (spec docs/specs/agent-held-google-passkey.md §5.1, the §3.7 rate limits, the §4
 * peer classification and the §5.1 "what each machine may do" table).
 *
 * Every pool-wide RESTRICTIVE check — the enrollment rate limit, the same-account
 * proof gap, throttle/risk pauses, the suspension inputs and the outbox rows — reads
 * peer state through ONE path: each machine publishes a `PasskeyMachineState` at
 * `GET /passkeys/pool-state`, and the `PasskeyPoolReader` on each machine queries
 * every peer once per tick (5 s per peer, 5 s overall, in parallel), classifies each
 * peer with the rope-health signal, keeps each peer's LAST-KNOWN rows durably, and
 * serves one memo to every check and to `GET /passkeys?scope=pool`.
 *
 * Authority posture (§5.1, §11): peer rows can only RESTRICT enrollment, proofs and
 * pauses — never grant, never load a credential. An unobserved peer makes a
 * multi-machine agent refuse enrollment and proofs ("pool checks degraded"); repair
 * and revoke are unaffected. A single-machine agent has no peers and is never
 * degraded. Rows are keyed on CANONICAL EMAILS (each machine derives its own entry
 * keys); no credential material, no entry key and no bundle body ever enters a row.
 *
 * Nothing here drives a browser or contacts Google: this increment is the ledger,
 * the classification and the admission rules the enrollment / cold-proof / health
 * increments consume.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RopeHealthCondition } from '../monitoring/RopeHealthMonitor.js';
import { PASSKEY_HEALTH_STATES, type PasskeyHealthState, type GoogleSideState } from './PasskeyCellHealth.js';

export const PASSKEY_ATTEMPTS_FILE = path.join('state', 'passkey-attempts.json');
export const PASSKEY_PEER_EXCLUSIONS_FILE = path.join('state', 'passkey-peer-exclusions.json');
export const PASSKEY_POOL_LASTKNOWN_FILE = path.join('state', 'passkey-pool-lastknown.json');

/** Attempt rows older than this are pruned (§3.7 "Rows older than 24h are pruned"). */
export const ATTEMPT_RETENTION_MS = 24 * 60 * 60_000;
/** A peer unobserved for longer than this is offered for exclusion (§4). */
export const PEER_UNOBSERVED_EXCLUDE_OFFER_MS = 72 * 60 * 60_000;
/** Default per-peer and overall query budgets (§5.1: 5 s each). */
export const POOL_PEER_TIMEOUT_MS = 5_000;
export const POOL_OVERALL_TIMEOUT_MS = 5_000;
/** The lease holder's last-known suspension state is trusted for at most this long (§2). */
export const LEASE_HOLDER_LASTKNOWN_MAX_MS = 24 * 60 * 60_000;
/** A peer's pool-state body larger than this is refused as `malformed` BEFORE parsing (unattended tick). */
export const PASSKEY_POOL_STATE_MAX_BYTES = 1_000_000;

export type PasskeyAttemptKind = 'enrollment' | 'proof' | 'canary' | 'repair';

export interface PasskeyAttemptRow {
  canonicalEmail: string;
  kind: PasskeyAttemptKind;
  /** ISO instant. */
  at: string;
  machineId: string;
}

export type PasskeyPauseReason = 'throttled' | 'risk';

export interface PasskeyPauseRow {
  id: string;
  /** The account paused, or null for a machine-wide pause. */
  canonicalEmail: string | null;
  scope: 'account' | 'machine';
  reason: PasskeyPauseReason;
  from: string;
  until: string;
  machineId: string;
}

interface AttemptsFile { version: 1; attempts: PasskeyAttemptRow[]; pauses: PasskeyPauseRow[] }

function atomicWriteJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJsonOrNull<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  // A corrupt file THROWS (fail closed): a ledger that silently reads as empty would
  // let a rate limit or a pause evaporate.
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function canonicalPasskeyPoolEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return EMAIL_RE.test(v) && v.length <= 254 ? v : null;
}

// ── Attempt + pause ledger (machine-local, one file) ─────────────────────────

export class PasskeyAttemptLedger {
  private readonly file: string;
  private readonly machineId: string;
  private readonly now: () => number;

  constructor(opts: { stateDir: string; machineId: string; now?: () => number }) {
    this.file = path.join(opts.stateDir, PASSKEY_ATTEMPTS_FILE);
    this.machineId = opts.machineId;
    this.now = opts.now ?? Date.now;
  }

  private read(): AttemptsFile {
    const raw = readJsonOrNull<AttemptsFile>(this.file);
    if (!raw) return { version: 1, attempts: [], pauses: [] };
    if (raw.version !== 1 || !Array.isArray(raw.attempts) || !Array.isArray(raw.pauses)) throw new Error('passkey-attempts-corrupt');
    return raw;
  }

  private write(data: AttemptsFile): void { atomicWriteJson(this.file, data); }

  /** Record one attempt for a cell on THIS machine (the row carries this machine's id). */
  recordAttempt(input: { canonicalEmail: string; kind: PasskeyAttemptKind; at?: string }): PasskeyAttemptRow {
    const data = this.read();
    const row: PasskeyAttemptRow = { canonicalEmail: input.canonicalEmail, kind: input.kind, at: input.at ?? new Date(this.now()).toISOString(), machineId: this.machineId };
    data.attempts = pruneAttempts([...data.attempts, row], this.now());
    this.write(data);
    return row;
  }

  /** Attempts within the retention window (pruning persisted as a side effect). */
  attempts(): PasskeyAttemptRow[] {
    const data = this.read();
    const kept = pruneAttempts(data.attempts, this.now());
    if (kept.length !== data.attempts.length) this.write({ ...data, attempts: kept });
    return kept.map((r) => ({ ...r }));
  }

  /** Open a pause. An identical open pause (same scope/email/reason) is EXTENDED, never duplicated. */
  pause(input: { canonicalEmail: string | null; scope: 'account' | 'machine'; reason: PasskeyPauseReason; durationMs: number }): PasskeyPauseRow {
    const data = this.read();
    const nowMs = this.now();
    const until = new Date(nowMs + Math.max(0, input.durationMs)).toISOString();
    const existing = data.pauses.find((p) => p.scope === input.scope && p.canonicalEmail === input.canonicalEmail && p.reason === input.reason && Date.parse(p.until) > nowMs);
    if (existing) {
      if (Date.parse(until) > Date.parse(existing.until)) existing.until = until;
      this.write({ ...data, pauses: pruneExpired(data.pauses, nowMs) });
      return { ...existing };
    }
    const row: PasskeyPauseRow = {
      id: `pause-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      canonicalEmail: input.canonicalEmail, scope: input.scope, reason: input.reason,
      from: new Date(nowMs).toISOString(), until, machineId: this.machineId,
    };
    this.write({ ...data, pauses: [...pruneExpired(data.pauses, nowMs), row] });
    return { ...row };
  }

  /** Pauses still in force now (expired ones pruned from disk). */
  activePauses(): PasskeyPauseRow[] {
    const data = this.read();
    const kept = pruneExpired(data.pauses, this.now());
    if (kept.length !== data.pauses.length) this.write({ ...data, pauses: kept });
    return kept.map((p) => ({ ...p }));
  }
}

function pruneAttempts(rows: PasskeyAttemptRow[], nowMs: number): PasskeyAttemptRow[] {
  return rows.filter((r) => { const t = Date.parse(r.at); return Number.isFinite(t) && nowMs - t <= ATTEMPT_RETENTION_MS; });
}
function pruneExpired(rows: PasskeyPauseRow[], nowMs: number): PasskeyPauseRow[] {
  return rows.filter((p) => { const t = Date.parse(p.until); return Number.isFinite(t) && t > nowMs; });
}

// ── Peer exclusions (§4: 72h-unobserved peer, operator "exclude machine X") ──

export interface PasskeyPeerExclusion { machineId: string; excludedAt: string; excludedBy: string }
interface ExclusionsFile { version: 1; excluded: PasskeyPeerExclusion[] }

export class PasskeyPeerExclusions {
  private readonly file: string;
  private readonly now: () => number;
  constructor(opts: { stateDir: string; now?: () => number }) {
    this.file = path.join(opts.stateDir, PASSKEY_PEER_EXCLUSIONS_FILE);
    this.now = opts.now ?? Date.now;
  }
  private read(): ExclusionsFile {
    const raw = readJsonOrNull<ExclusionsFile>(this.file);
    if (!raw) return { version: 1, excluded: [] };
    if (raw.version !== 1 || !Array.isArray(raw.excluded)) throw new Error('passkey-peer-exclusions-corrupt');
    return raw;
  }
  list(): PasskeyPeerExclusion[] { return this.read().excluded.map((e) => ({ ...e })); }
  isExcluded(machineId: string): boolean { return this.read().excluded.some((e) => e.machineId === machineId); }
  exclude(machineId: string, excludedBy: string): { changed: boolean; entry: PasskeyPeerExclusion } {
    const data = this.read();
    const existing = data.excluded.find((e) => e.machineId === machineId);
    if (existing) return { changed: false, entry: { ...existing } };
    const entry: PasskeyPeerExclusion = { machineId, excludedAt: new Date(this.now()).toISOString(), excludedBy };
    atomicWriteJson(this.file, { ...data, excluded: [...data.excluded, entry] });
    return { changed: true, entry };
  }
  include(machineId: string): { changed: boolean } {
    const data = this.read();
    const kept = data.excluded.filter((e) => e.machineId !== machineId);
    if (kept.length === data.excluded.length) return { changed: false };
    atomicWriteJson(this.file, { ...data, excluded: kept });
    return { changed: true };
  }
}

// ── The per-machine state a peer publishes ───────────────────────────────────

export type PoolCustodyState = 'present' | 'quarantined' | 'legacy-adopted' | 'pending' | 'absent';

export interface PasskeyPoolCell {
  canonicalEmail: string;
  granted: boolean;
  grantLocalSeq: number | null;
  grantedAt: string | null;
  custody: PoolCustodyState;
  googleCreatedAt: string | null;
  /** The §4 health state (PasskeyCellHealth); `unknown` when the cell has no health record yet. */
  health: PasskeyHealthState | 'unknown';
  /** The §3.2 Google-side removal state, when a health record carries one. */
  googleSide?: 'none' | 'pending-operator' | 'operator-attested' | 'removed-verified';
}

export interface PasskeyPoolOutboxRow {
  canonicalEmail: string;
  targetMachineId: string;
  state: string;
  attempts: number;
  issuedAt: string;
  nextAttemptAt: string;
}

export interface PasskeyPoolGrantEcho { canonicalEmail: string; targetMachineId: string; targetLocalSeq: number | null; issuedAt: string }

export interface PasskeyMachineState {
  schemaVersion: 1;
  machineId: string;
  generatedAt: string;
  cells: PasskeyPoolCell[];
  attempts: PasskeyAttemptRow[];
  pauses: PasskeyPauseRow[];
  /** Grants this machine issued to peers, with the seq the peer acknowledged (never a credential). */
  grantEchoes: PasskeyPoolGrantEcho[];
  revokeHighWater: number;
  outbox: PasskeyPoolOutboxRow[];
  /** Whether this machine is the secret-sync push authority (§3.7 backup-code rung). */
  pushEnabled: boolean;
  /** The suspension record, published by the serving-lease holder only (later increment); null elsewhere. */
  suspension: null;
}

/** Clamp a peer-supplied state to the schema: peers are mesh-peer data, never trusted shape. */
export function clampPasskeyMachineState(raw: unknown, expectedMachineId: string): PasskeyMachineState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1 || r.machineId !== expectedMachineId) return null;
  const str = (v: unknown, max = 320): string | null => (typeof v === 'string' && v.length <= max ? v : null);
  const iso = (v: unknown): string | null => { const s = str(v, 40); return s && Number.isFinite(Date.parse(s)) ? s : null; };
  const int = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);
  const bounded = <T>(v: unknown, map: (x: unknown) => T | null, cap: number): T[] =>
    Array.isArray(v) ? v.slice(0, cap).map(map).filter((x): x is T => x !== null) : [];
  const cells = bounded<PasskeyPoolCell>(r.cells, (c) => {
    const o = c as Record<string, unknown>;
    const email = canonicalPasskeyPoolEmail(o?.canonicalEmail);
    if (!email) return null;
    const custody = str(o.custody, 20);
    const health = str(o.health, 24);
    const googleSide = str(o.googleSide, 24);
    return {
      canonicalEmail: email, granted: o.granted === true, grantLocalSeq: int(o.grantLocalSeq), grantedAt: iso(o.grantedAt),
      custody: (['present', 'quarantined', 'legacy-adopted', 'pending', 'absent'] as const).includes(custody as PoolCustodyState) ? custody as PoolCustodyState : 'absent',
      googleCreatedAt: iso(o.googleCreatedAt),
      // A peer's health is one of the closed §4 states or `unknown` — never free text.
      health: (PASSKEY_HEALTH_STATES as readonly string[]).includes(health ?? '') ? health as PasskeyHealthState : 'unknown',
      ...((['none', 'pending-operator', 'operator-attested', 'removed-verified'] as const).includes(googleSide as GoogleSideState) ? { googleSide: googleSide as GoogleSideState } : {}),
    };
  }, 500);
  const attempts = bounded<PasskeyAttemptRow>(r.attempts, (a) => {
    const o = a as Record<string, unknown>;
    const email = canonicalPasskeyPoolEmail(o?.canonicalEmail); const at = iso(o?.at); const kind = str(o?.kind, 12);
    if (!email || !at || !(['enrollment', 'proof', 'canary', 'repair'] as const).includes(kind as PasskeyAttemptKind)) return null;
    // A peer's rows are audited per ORIGIN machine: the row carries the peer's id, whatever it claims.
    return { canonicalEmail: email, at, kind: kind as PasskeyAttemptKind, machineId: expectedMachineId };
  }, 2_000);
  const pauses = bounded<PasskeyPauseRow>(r.pauses, (p) => {
    const o = p as Record<string, unknown>;
    const email = o?.canonicalEmail === null ? null : canonicalPasskeyPoolEmail(o?.canonicalEmail);
    const from = iso(o?.from); const until = iso(o?.until); const reason = str(o?.reason, 12); const scope = str(o?.scope, 12); const id = str(o?.id, 80);
    if (email === undefined || !from || !until || !id || !(['throttled', 'risk'] as const).includes(reason as PasskeyPauseReason) || !(['account', 'machine'] as const).includes(scope as 'account' | 'machine')) return null;
    if (scope === 'account' && !email) return null;
    return { id, canonicalEmail: email, scope: scope as 'account' | 'machine', reason: reason as PasskeyPauseReason, from, until, machineId: expectedMachineId };
  }, 500);
  const grantEchoes = bounded<PasskeyPoolGrantEcho>(r.grantEchoes, (g) => {
    const o = g as Record<string, unknown>;
    const email = canonicalPasskeyPoolEmail(o?.canonicalEmail); const target = str(o?.targetMachineId, 120); const issuedAt = iso(o?.issuedAt);
    if (!email || !target || !issuedAt) return null;
    return { canonicalEmail: email, targetMachineId: target, targetLocalSeq: int(o.targetLocalSeq), issuedAt };
  }, 500);
  const outbox = bounded<PasskeyPoolOutboxRow>(r.outbox, (e) => {
    const o = e as Record<string, unknown>;
    const email = canonicalPasskeyPoolEmail(o?.canonicalEmail); const target = str(o?.targetMachineId, 120); const state = str(o?.state, 20);
    const issuedAt = iso(o?.issuedAt); const next = iso(o?.nextAttemptAt);
    if (!email || !target || !state || !issuedAt || !next) return null;
    return { canonicalEmail: email, targetMachineId: target, state, attempts: int(o.attempts) ?? 0, issuedAt, nextAttemptAt: next };
  }, 500);
  return {
    schemaVersion: 1, machineId: expectedMachineId, generatedAt: iso(r.generatedAt) ?? new Date(0).toISOString(),
    cells, attempts, pauses, grantEchoes, revokeHighWater: int(r.revokeHighWater) ?? 0, outbox,
    pushEnabled: r.pushEnabled === true, suspension: null,
  };
}

/** Inputs the local state is assembled from (all machine-local readers; nothing secret crosses). */
export interface LocalPasskeyStateSources {
  machineId: string;
  grants: Array<{ canonicalEmail: string; status: string; localSeq: number; grantedAt: string; googleCreatedAt?: string | null }>;
  issuedPeerGrants: Array<{ canonicalEmail: string; targetMachineId: string; issuedAt: string; targetLocalSeq?: number }>;
  revokeHighWater: number;
  /** Names-only credential index (custody per canonical email) — null when no store exists on disk. */
  custody: Array<{ canonicalEmail: string; state: 'present' | 'quarantined' | 'legacy-adopted' }> | null;
  pendingEmails: string[];
  outbox: Array<{ canonicalEmail: string; targetMachineId: string; state: string; attempts: number; issuedAt: string; nextAttemptAt: string }>;
  ledger: PasskeyAttemptLedger;
  pushEnabled: boolean;
  /** The cell's §4 health record (state + Google-side), or null when none exists yet. */
  healthOf?: (canonicalEmail: string) => { state: PasskeyHealthState; googleSide: GoogleSideState } | null;
  now?: () => number;
}

/** Build this machine's publishable state: one row per granted OR held cell, no secrets. */
export function buildLocalPasskeyMachineState(src: LocalPasskeyStateSources): PasskeyMachineState {
  const now = src.now ?? Date.now;
  const custodyByEmail = new Map((src.custody ?? []).map((c) => [c.canonicalEmail, c.state]));
  const pending = new Set(src.pendingEmails);
  const emails = new Set<string>([...src.grants.filter((g) => g.status === 'active').map((g) => g.canonicalEmail), ...custodyByEmail.keys(), ...pending]);
  const cells: PasskeyPoolCell[] = [...emails].sort().map((email) => {
    const grant = src.grants.filter((g) => g.canonicalEmail === email && g.status === 'active').sort((a, b) => b.localSeq - a.localSeq)[0] ?? null;
    const custody: PoolCustodyState = custodyByEmail.get(email) ?? (pending.has(email) ? 'pending' : 'absent');
    const health = src.healthOf?.(email) ?? null;
    return {
      canonicalEmail: email, granted: grant !== null, grantLocalSeq: grant?.localSeq ?? null, grantedAt: grant?.grantedAt ?? null,
      custody, googleCreatedAt: grant?.googleCreatedAt ?? null, health: health?.state ?? 'unknown',
      ...(health ? { googleSide: health.googleSide } : {}),
    };
  });
  return {
    schemaVersion: 1, machineId: src.machineId, generatedAt: new Date(now()).toISOString(), cells,
    attempts: src.ledger.attempts(), pauses: src.ledger.activePauses(),
    grantEchoes: src.issuedPeerGrants.map((g) => ({ canonicalEmail: g.canonicalEmail, targetMachineId: g.targetMachineId, targetLocalSeq: Number.isSafeInteger(g.targetLocalSeq) ? g.targetLocalSeq! : null, issuedAt: g.issuedAt })),
    revokeHighWater: src.revokeHighWater,
    outbox: src.outbox.map((e) => ({ canonicalEmail: e.canonicalEmail, targetMachineId: e.targetMachineId, state: e.state, attempts: e.attempts, issuedAt: e.issuedAt, nextAttemptAt: e.nextAttemptAt })),
    pushEnabled: src.pushEnabled, suspension: null,
  };
}

// ── Peer classification (§4 / §5.1) ──────────────────────────────────────────

/**
 * `observed`     — answered this tick (its rows are current).
 * `peer-offline` — did not answer AND rope health says its heartbeat stopped (a closed laptop):
 *                  EXCLUDED from pool checks, last-known rows still count (§4).
 * `excluded`     — the operator excluded it (72h-unobserved offer / `exclude-peer`): treated like offline.
 * `partitioned`  — did not answer and is NOT provably offline (rope `ok`/`degraded`/`urgent`/
 *                  `auth-rejected`/`unknown`, or rope health absent): BLOCKS enrollment and proofs.
 */
export type PasskeyPeerCondition = 'observed' | 'peer-offline' | 'excluded' | 'partitioned';

export function classifyPasskeyPeer(input: {
  answered: boolean;
  excluded: boolean;
  ropeAvailable: boolean;
  rope: RopeHealthCondition | null;
}): PasskeyPeerCondition {
  if (input.answered) return 'observed';
  if (input.excluded) return 'excluded';
  if (input.ropeAvailable && input.rope === 'peer-offline') return 'peer-offline';
  return 'partitioned';
}

// ── Merged pool view + the pure checks ───────────────────────────────────────

export interface PasskeyPoolPeerView {
  machineId: string;
  nickname: string | null;
  condition: PasskeyPeerCondition;
  /** Why the fetch did not answer (pool fan-out vocabulary, never a URL). */
  fetch: 'ok' | 'no-known-url' | 'url-rejected' | 'route-missing' | 'unauthorized' | 'refused' | 'error' | 'timeout' | 'unreachable' | 'malformed';
  rope: RopeHealthCondition | null;
  /** The rows in force for this peer: current when observed, last-known otherwise (null = never seen). */
  state: PasskeyMachineState | null;
  lastObservedAt: string | null;
  /** True when this peer has been unobserved past the 72h exclude-offer window. */
  excludeOfferDue: boolean;
}

export interface PasskeyPoolSnapshot {
  generatedAt: string;
  selfMachineId: string;
  self: PasskeyMachineState;
  peers: PasskeyPoolPeerView[];
  /** Enrollment and proofs refuse while true (a partitioned peer, §5.1). */
  degraded: boolean;
  degradedReasons: string[];
  singleMachine: boolean;
}

/** Every row in force across the pool (self + each peer's current or last-known rows). */
export function poolRows(snapshot: PasskeyPoolSnapshot): { attempts: PasskeyAttemptRow[]; pauses: PasskeyPauseRow[] } {
  const attempts = [...snapshot.self.attempts];
  const pauses = [...snapshot.self.pauses];
  for (const p of snapshot.peers) {
    if (!p.state) continue;
    // A partitioned peer's last-known rows still BOUND the rate limit (restrictive direction).
    attempts.push(...p.state.attempts);
    pauses.push(...p.state.pauses);
  }
  return { attempts, pauses };
}

export interface PasskeyRateLimitConfig { minIntervalMinutes: number; maxPerAccountPerDay: number }
export const DEFAULT_PASSKEY_RATE_LIMIT: PasskeyRateLimitConfig = { minIntervalMinutes: 30, maxPerAccountPerDay: 3 };

/**
 * §3.7: one enrollment attempt per cell per 30 minutes and 3 per account per day POOL-WIDE.
 * Proofs, canaries and repairs COUNT toward the daily figure (they are attempts on the account)
 * but are never refused by it — only an enrollment is.
 */
export function enrollmentRateLimit(input: {
  rows: PasskeyAttemptRow[]; canonicalEmail: string; machineId: string; nowMs: number; config?: PasskeyRateLimitConfig;
}): { allowed: true } | { allowed: false; reason: 'cell-interval' | 'account-daily-cap'; retryAfterMs: number } {
  const cfg = input.config ?? DEFAULT_PASSKEY_RATE_LIMIT;
  const account = input.rows.filter((r) => r.canonicalEmail === input.canonicalEmail && Number.isFinite(Date.parse(r.at)));
  const dayAgo = input.nowMs - 24 * 60 * 60_000;
  const lastDay = account.filter((r) => Date.parse(r.at) > dayAgo);
  const cellEnrollments = lastDay.filter((r) => r.machineId === input.machineId && r.kind === 'enrollment');
  const intervalMs = cfg.minIntervalMinutes * 60_000;
  const recentCell = cellEnrollments.map((r) => Date.parse(r.at)).filter((t) => input.nowMs - t < intervalMs).sort((a, b) => b - a)[0];
  if (recentCell !== undefined) return { allowed: false, reason: 'cell-interval', retryAfterMs: intervalMs - (input.nowMs - recentCell) };
  if (lastDay.length >= cfg.maxPerAccountPerDay) {
    // The cap clears when enough rows have aged out that (cap − 1) remain: the (n − cap + 1)-th
    // oldest row's expiry, not the oldest row's (with 5 rows and a cap of 3, the oldest expiring
    // still leaves 4).
    const ascending = lastDay.map((r) => Date.parse(r.at)).sort((a, b) => a - b);
    const clearsAt = ascending[lastDay.length - cfg.maxPerAccountPerDay] + 24 * 60 * 60_000;
    return { allowed: false, reason: 'account-daily-cap', retryAfterMs: Math.max(0, clearsAt - input.nowMs) };
  }
  return { allowed: true };
}

/** §4: proofs of the same account from DIFFERENT machines ≥ 6 hours apart. */
export function sameAccountGap(input: { rows: PasskeyAttemptRow[]; canonicalEmail: string; machineId: string; nowMs: number; gapHours?: number }): { allowed: true } | { allowed: false; retryAfterMs: number; blockedBy: string } {
  const gapMs = (input.gapHours ?? 6) * 60 * 60_000;
  const other = input.rows
    .filter((r) => r.canonicalEmail === input.canonicalEmail && r.machineId !== input.machineId && (r.kind === 'proof' || r.kind === 'canary' || r.kind === 'enrollment'))
    .map((r) => ({ t: Date.parse(r.at), m: r.machineId })).filter((r) => Number.isFinite(r.t) && input.nowMs - r.t < gapMs)
    .sort((a, b) => b.t - a.t)[0];
  if (!other) return { allowed: true };
  return { allowed: false, retryAfterMs: gapMs - (input.nowMs - other.t), blockedBy: other.m };
}

/** The pause (if any) that stops automated passkey sign-ins for this cell right now (account OR this machine). */
export function activePauseFor(input: { pauses: PasskeyPauseRow[]; canonicalEmail: string; machineId: string; nowMs: number }): PasskeyPauseRow | null {
  return input.pauses
    .filter((p) => Number.isFinite(Date.parse(p.until)) && Date.parse(p.until) > input.nowMs)
    .filter((p) => (p.scope === 'account' && p.canonicalEmail === input.canonicalEmail) || (p.scope === 'machine' && p.machineId === input.machineId))
    .sort((a, b) => Date.parse(b.until) - Date.parse(a.until))[0] ?? null;
}

// ── The "what each machine may do" table (§5.1) ──────────────────────────────

export type PasskeyPoolAction = 'enroll' | 'prove' | 'canary' | 'repair' | 'revoke';
export type PasskeyAdmissionMode = 'normal' | 'last-known' | 'canary-only' | 'degraded-override' | 'queued';

export interface PasskeyPoolConditions {
  peers: PasskeyPeerCondition[];
  suspension: { state: 'none' | 'suspended' | 'suspended-stopped'; killSwitch: boolean };
  /** The serving-lease holder: reachable now, or how old its last-known state is (null = never). */
  leaseHolder: { isSelf: boolean; reachable: boolean; lastKnownAgeMs: number | null };
}

export function poolAdmission(action: PasskeyPoolAction, c: PasskeyPoolConditions): { allowed: boolean; mode: PasskeyAdmissionMode; reason: string | null } {
  // "When several rows apply, the most restrictive cell wins" (§5.1): every REFUSING row is
  // evaluated before any admitting carve-out (the suspended-canary allowance, the last-known
  // mode), so a canary under suspension is still refused by a partitioned peer or a stale lease
  // holder (second-pass finding, 2026-09-23).
  if (action === 'revoke') return { allowed: true, mode: c.peers.some((p) => p !== 'observed') ? 'queued' : 'normal', reason: null };
  const stopped = c.suspension.state === 'suspended-stopped' || c.suspension.killSwitch;
  const stopReason = c.suspension.killSwitch ? 'kill-switch' : c.suspension.state === 'suspended-stopped' ? 'suspended-stopped' : null;
  const leaseUnreachable = !c.leaseHolder.isSelf && !c.leaseHolder.reachable;
  const leaseStale = leaseUnreachable && (c.leaseHolder.lastKnownAgeMs === null || c.leaseHolder.lastKnownAgeMs > LEASE_HOLDER_LASTKNOWN_MAX_MS);
  const partitioned = c.peers.some((p) => p === 'partitioned');
  if (action === 'repair') {
    // Repair is never blocked by pool state; under any degraded condition it runs by the explicit
    // method override (§2 "degraded operating mode"), named by the most severe reason.
    if (stopped) return { allowed: true, mode: 'degraded-override', reason: stopReason };
    if (c.suspension.state === 'suspended') return { allowed: true, mode: 'degraded-override', reason: 'suspended' };
    if (leaseStale) return { allowed: true, mode: 'degraded-override', reason: 'lease-holder-unreachable' };
    return { allowed: true, mode: leaseUnreachable ? 'last-known' : 'normal', reason: null };
  }
  // Refusing rows, most restrictive first.
  if (stopped) return { allowed: false, mode: 'normal', reason: stopReason };
  if (leaseStale) return { allowed: false, mode: 'normal', reason: 'passkey-suspension-unknown' };
  if (partitioned) return { allowed: false, mode: leaseUnreachable ? 'last-known' : 'normal', reason: 'passkey-pool-state-unavailable' };
  if (c.suspension.state === 'suspended') {
    if (action === 'canary') return { allowed: true, mode: 'canary-only', reason: null };
    return { allowed: false, mode: 'normal', reason: 'suspended' };
  }
  return { allowed: true, mode: leaseUnreachable ? 'last-known' : 'normal', reason: null };
}

// ── The reader: one query per peer per tick, memo + durable last-known ──────
// RULE 3: EXEMPT — PasskeyPoolReader reads instar's OWN peers' typed JSON (`GET /passkeys/pool-state`,
// schema-clamped above), never a provider CLI/TUI/transcript surface; there is no external state
// detection here to drift.

export interface PasskeyPoolPeer { machineId: string; nickname?: string | null; url: string | null; online?: boolean | null }

export type PeerStateFetch =
  | { ok: true; body: unknown }
  | { ok: false; reason: Exclude<PasskeyPoolPeerView['fetch'], 'ok'> };

export interface PasskeyPoolReaderDeps {
  stateDir: string;
  selfMachineId: string;
  localState: () => PasskeyMachineState;
  listPeers: () => PasskeyPoolPeer[];
  fetchPeerState: (peer: PasskeyPoolPeer, timeoutMs: number) => Promise<PeerStateFetch>;
  /** Rope-health condition for a peer, or null when the monitor has no row / is absent. */
  ropeCondition: (machineId: string) => RopeHealthCondition | null;
  ropeAvailable: () => boolean;
  exclusions: PasskeyPeerExclusions;
  now?: () => number;
  perPeerTimeoutMs?: number;
  overallTimeoutMs?: number;
  /** A memo younger than this is served without re-querying (`read()`); the tick loop ignores it. */
  memoTtlMs?: number;
  log?: (line: string) => void;
}

interface LastKnownFile { version: 1; peers: Record<string, { state: PasskeyMachineState; observedAt: string }> }

export class PasskeyPoolReader {
  private readonly now: () => number;
  private readonly lastKnownFile: string;
  private memo: PasskeyPoolSnapshot | null = null;
  private memoAt = 0;
  private inflight: Promise<PasskeyPoolSnapshot> | null = null;

  constructor(private readonly deps: PasskeyPoolReaderDeps) {
    this.now = deps.now ?? Date.now;
    this.lastKnownFile = path.join(deps.stateDir, PASSKEY_POOL_LASTKNOWN_FILE);
  }

  /** The current memo and its age (null memo ⇒ no tick has run yet). */
  memoView(): { snapshot: PasskeyPoolSnapshot | null; ageMs: number | null } {
    return { snapshot: this.memo, ageMs: this.memo ? this.now() - this.memoAt : null };
  }

  /** Serve the memo when fresh enough, else run one tick (single-flight). */
  async read(): Promise<{ snapshot: PasskeyPoolSnapshot; ageMs: number }> {
    const ttl = this.deps.memoTtlMs ?? 60_000;
    if (this.memo && this.now() - this.memoAt <= ttl) return { snapshot: this.memo, ageMs: this.now() - this.memoAt };
    const snapshot = await this.tick();
    return { snapshot, ageMs: 0 };
  }

  /**
   * One pass: query every peer in parallel under the per-peer + overall budgets. Peer failures never
   * throw (they classify); a corrupt LOCAL ledger or exclusion file REJECTS the tick (fail closed —
   * the route answers 500 rather than serving a pool view built on rows it could not read).
   */
  tick(): Promise<PasskeyPoolSnapshot> {
    if (this.inflight) return this.inflight;
    this.inflight = this.tickBody().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /**
   * The last-known cache. An unreadable / wrong-version file is NOT treated as empty: an
   * offline peer's last-known rows may hold a pause or attempts that bound the pool, so losing
   * them silently would RELAX the pool (second-pass finding). Instead the tick treats every
   * non-answering peer as `partitioned` (blocks enrollment/proofs), never overwrites the file,
   * and names the condition in `degradedReasons` — the operator repairs or removes the file.
   */
  private readLastKnown(): { data: LastKnownFile; unreadable: string | null } {
    try {
      const raw = readJsonOrNull<LastKnownFile>(this.lastKnownFile);
      if (raw === null) return { data: { version: 1, peers: {} }, unreadable: null };
      if (raw.version === 1 && raw.peers && typeof raw.peers === 'object') return { data: raw, unreadable: null };
      return { data: { version: 1, peers: {} }, unreadable: 'unsupported-version' };
    } catch (err) {
      // @silent-fallback-ok — NOT swallowed: the tick marks every silent peer partitioned, refuses
      // to overwrite the file, reports `last-known-cache-unreadable`, and the parse error is logged.
      this.deps.log?.(`[passkey-pool] last-known cache unreadable — silent peers read as partitioned until the file is repaired: ${err instanceof Error ? err.message : String(err)}`);
      return { data: { version: 1, peers: {} }, unreadable: 'unreadable' };
    }
  }

  private async tickBody(): Promise<PasskeyPoolSnapshot> {
    const nowMs = this.now();
    const self = this.deps.localState();
    const peers = this.deps.listPeers().filter((p) => p.machineId !== this.deps.selfMachineId);
    const { data: lastKnown, unreadable: cacheUnreadable } = this.readLastKnown();
    const perPeer = this.deps.perPeerTimeoutMs ?? POOL_PEER_TIMEOUT_MS;
    const overall = this.deps.overallTimeoutMs ?? POOL_OVERALL_TIMEOUT_MS;
    const ropeAvailable = this.deps.ropeAvailable();

    const query = async (peer: PasskeyPoolPeer): Promise<{ peer: PasskeyPoolPeer; fetch: PasskeyPoolPeerView['fetch']; state: PasskeyMachineState | null }> => {
      if (!peer.url) return { peer, fetch: 'no-known-url', state: null };
      try {
        const out = await this.deps.fetchPeerState(peer, perPeer);
        if (!out.ok) return { peer, fetch: out.reason, state: null };
        const clamped = clampPasskeyMachineState(out.body, peer.machineId);
        return clamped ? { peer, fetch: 'ok', state: clamped } : { peer, fetch: 'malformed', state: null };
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        return { peer, fetch: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable', state: null };
      }
    };
    // Overall budget: a peer still pending when it elapses is `timeout` (its last-known rows count).
    const overallTimer = new Promise<'overall-timeout'>((resolve) => { const t = setTimeout(() => resolve('overall-timeout'), overall); t.unref?.(); });
    const results = await Promise.all(peers.map(async (peer) => {
      const r = await Promise.race([query(peer), overallTimer]);
      return r === 'overall-timeout' ? { peer, fetch: 'timeout' as const, state: null } : r;
    }));

    const views: PasskeyPoolPeerView[] = [];
    const nextLastKnown: LastKnownFile = { version: 1, peers: { ...lastKnown.peers } };
    for (const r of results) {
      const answered = r.fetch === 'ok' && r.state !== null;
      let excluded = this.deps.exclusions.isExcluded(r.peer.machineId);
      if (answered && excluded) {
        // §4: an exclusion clears automatically when the peer is observed again.
        this.deps.exclusions.include(r.peer.machineId);
        excluded = false;
      }
      const rope = this.deps.ropeCondition(r.peer.machineId);
      // With the last-known cache unreadable, a silent peer's bounding rows may be lost, so it
      // cannot be the non-blocking `peer-offline` / `excluded`: it reads `partitioned` until the
      // file is repaired (restrictive direction).
      const condition = answered || cacheUnreadable === null
        ? classifyPasskeyPeer({ answered, excluded, ropeAvailable, rope })
        : 'partitioned';
      const prior = lastKnown.peers[r.peer.machineId] ?? null;
      const observedAt = answered ? new Date(nowMs).toISOString() : prior?.observedAt ?? null;
      if (answered && r.state) nextLastKnown.peers[r.peer.machineId] = { state: r.state, observedAt: observedAt! };
      const state = answered ? r.state : prior?.state ?? null;
      const unobservedMs = observedAt ? nowMs - Date.parse(observedAt) : Number.POSITIVE_INFINITY;
      views.push({
        machineId: r.peer.machineId, nickname: r.peer.nickname ?? null, condition, fetch: r.fetch, rope, state, lastObservedAt: observedAt,
        // Offered only for a peer that WAS observed once and has been silent past the window — a peer
        // never observed may be brand new (its exclusion is the operator's call from the registry, not this).
        excludeOfferDue: !answered && !excluded && observedAt !== null && unobservedMs > PEER_UNOBSERVED_EXCLUDE_OFFER_MS,
      });
    }
    if (cacheUnreadable === null) {
      try { atomicWriteJson(this.lastKnownFile, nextLastKnown); }
      catch (err) { this.deps.log?.(`[passkey-pool] could not persist last-known peer rows: ${err instanceof Error ? err.message : String(err)}`); }
    }
    // A file that failed to parse is never overwritten — its rows may still be recoverable by hand.

    const partitioned = views.filter((v) => v.condition === 'partitioned');
    const snapshot: PasskeyPoolSnapshot = {
      generatedAt: new Date(nowMs).toISOString(), selfMachineId: this.deps.selfMachineId, self, peers: views,
      degraded: partitioned.length > 0,
      degradedReasons: [
        ...(cacheUnreadable && peers.length > 0 ? [`last-known-cache-${cacheUnreadable}`] : []),
        ...partitioned.map((v) => `${v.machineId}:${v.fetch}${v.rope ? `:rope-${v.rope}` : ropeAvailable ? '' : ':rope-absent'}`),
      ],
      singleMachine: peers.length === 0,
    };
    this.memo = snapshot;
    this.memoAt = nowMs;
    return snapshot;
  }
}
