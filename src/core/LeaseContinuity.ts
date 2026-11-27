/**
 * LeaseContinuity — the pieces of docs/specs/planned-restart-keeps-lead.md that are pure or
 * file-shaped: the window a pending-restart renewal is set ahead, the signed continuity file this
 * machine writes beside its lease, the restart budget (this machine's measured boots), the episode
 * end rule, and the boot measurement.
 *
 * Nothing here talks to a peer. The coordinator (LeaseCoordinator) owns the decisions; this module
 * owns the arithmetic and the disk shape, so every boundary is unit-testable with a fake clock.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import type { LeaseRecord } from './types.js';

// ── Cadence, margin and window ────────────────────────────────────────

/** While a restart is pending, the renew tick runs this often on a tunnel transport (§1 step 4). */
export const PENDING_RENEW_CADENCE_MS = 10_000;
/** R1's own pull deadline, the time one evaluable round waits for answers (§2 step 2). */
export const ASK_DEADLINE_MS = 10_000;
/** Above the 21 s event-loop stall measured on the Laptop (§ The window). */
export const STALL_SLACK_MS = 25_000;
/** The parent's default for the stale-holder takeover threshold, assumed on peers (R3). */
export const ASSUMED_PEER_NON_RENEWAL_OBSERVATIONS = 6;
/** How many boot samples the budget keeps (R5's shape: slowest below twenty, p95 from twenty). */
export const RESTART_BUDGET_SAMPLES = 20;
/** The consumers' delivery bound a request can wait behind a hold: 3 h verify hold + 1 h (§1 step 3 (c)). */
export const EPISODE_CAP_MS = 4 * 60 * 60_000;
/** A file absent this long with no consumption row was withdrawn or discarded (§1 step 3 (b)). */
export const EPISODE_ABSENCE_MS = 60_000;

/** The request-file poll while holding: 2 s, doubling on a read error up to 60 s, back to 2 s on success. */
export const REQUEST_POLL_MS = 2_000;
export const REQUEST_POLL_MAX_MS = 60_000;
export function nextRequestPollMs(readOk: boolean, currentMs: number): number {
  if (readOk) return REQUEST_POLL_MS;
  return Math.min(REQUEST_POLL_MAX_MS, Math.max(REQUEST_POLL_MS, currentMs) * 2);
}

/**
 * Whether a pending renewal is due: one per pending cadence while the episode is open, none once the
 * episode's four-hour cap has passed (the cap is the give-up; the episode rule ends it then).
 */
export function pendingRenewalDue(i: { nowMs: number; lastRenewalMs: number | null; cadenceMs: number; episodeOpenedAtMs: number; capMs?: number }): boolean {
  if (i.nowMs - i.episodeOpenedAtMs >= (i.capMs ?? EPISODE_CAP_MS)) return false;
  return i.lastRenewalMs === null || i.nowMs - i.lastRenewalMs >= i.cadenceMs;
}

/** The pending cadence on this store: the fast cadence on a tunnel; a git-only mesh keeps its own. */
export function pendingCadenceMs(renewIntervalMs: number, hasTunnel: boolean): number {
  return hasTunnel ? Math.min(renewIntervalMs, PENDING_RENEW_CADENCE_MS) : renewIntervalMs;
}

export interface MarginInputs {
  /** The effective pending cadence on this store (`pendingCadenceMs`). */
  pendingRenewIntervalMs: number;
  askDeadlineMs?: number;
  broadcastDeadlineMs?: number;
  stallSlackMs?: number;
}

/** The time between the last pending renewal and the boot renewal's confirmation (§ The window). */
export function resolveMarginMs(i: MarginInputs): number {
  return i.pendingRenewIntervalMs + (i.askDeadlineMs ?? ASK_DEADLINE_MS) + (i.broadcastDeadlineMs ?? 8_000) + (i.stallSlackMs ?? STALL_SLACK_MS);
}

export interface WindowInputs extends MarginInputs {
  ttlMs: number;
  /** Measured boots, oldest first; non-finite values are discarded; each is clamped on read. */
  admissionMinimumMs?: number | null;
  bootSamplesMs: readonly number[];
  /** `plannedRestartLeaseContinuity.windowMs`, replacing the base when set. */
  windowMsOverride?: number | null;
  /** This machine's `nonRenewalMissedObservations`; peers are assumed at the parent's default. */
  ownNonRenewalMissedObservations?: number | null;
  failoverThresholdMs: number;
  /** R1's unsigned-answer ceiling (`UNSIGNED_WINDOW_CEILING_MS`). */
  unsignedCeilingMs: number;
}

export interface WindowVerdict {
  windowMs: number;
  marginMs: number;
  baseMs: number;
  floorMs: number;
  ceilingMs: number;
  /** Which cap decided the ceiling. */
  ceilingSource: 'stale-holder' | 'presumed-dead' | 'r1-ceiling';
  /** Set when the base was clamped. */
  clamped: 'floor' | 'ceiling' | null;
  measured: boolean;
}

/** Clamp a stored or supplied duration to what a window may ever be; non-finite → null. */
export function clampSampleMs(ms: unknown, unsignedCeilingMs: number): number | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return Math.max(0, Math.min(unsignedCeilingMs, ms));
}

export function resolveWindowMs(i: WindowInputs): WindowVerdict {
  const marginMs = resolveMarginMs(i);
  const samples = i.bootSamplesMs.map((s) => clampSampleMs(s, i.unsignedCeilingMs)).filter((s): s is number => s !== null);
  const measured = samples.length > 0;
  const override = clampSampleMs(i.windowMsOverride ?? null, i.unsignedCeilingMs);
  const baseMs = override !== null && override > 0
    ? override
    : measured ? Math.max(...samples) + marginMs : 3 * i.ttlMs + marginMs;
  const floorMs = Math.max(i.ttlMs + marginMs, i.admissionMinimumMs ?? 0);
  const ownN = typeof i.ownNonRenewalMissedObservations === 'number' && i.ownNonRenewalMissedObservations >= 1
    ? Math.floor(i.ownNonRenewalMissedObservations) : ASSUMED_PEER_NON_RENEWAL_OBSERVATIONS;
  const broadcast = i.broadcastDeadlineMs ?? 8_000;
  const caps: Array<[number, WindowVerdict['ceilingSource']]> = [
    [i.ttlMs * Math.min(ownN, ASSUMED_PEER_NON_RENEWAL_OBSERVATIONS) - broadcast, 'stale-holder'],
    [i.failoverThresholdMs - broadcast, 'presumed-dead'],
    [i.unsignedCeilingMs, 'r1-ceiling'],
  ];
  let [ceilingMs, ceilingSource] = caps[0];
  for (const [ms, src] of caps) if (ms < ceilingMs) { ceilingMs = ms; ceilingSource = src; }
  let windowMs = baseMs;
  let clamped: WindowVerdict['clamped'] = null;
  // The floor first, the ceiling last: peers enforce the ceiling, so it must win when the two conflict.
  if (windowMs < floorMs) { windowMs = floorMs; clamped = 'floor'; }
  if (windowMs > ceilingMs) { windowMs = ceilingMs; clamped = 'ceiling'; }
  if (!Number.isFinite(windowMs)) { windowMs = Math.min(3 * i.ttlMs + marginMs, ceilingMs); clamped = null; }
  return { windowMs, marginMs, baseMs, floorMs, ceilingMs, ceilingSource, clamped, measured };
}

// ── The continuity file ───────────────────────────────────────────────

export interface ContinuityMeta {
  requestedBy: string;
  reason: string;
  requestedAt: string | null;
  episodeOpenedAt: string;
  renewedAt: string;
  windowMs: number;
  confirmed: boolean;
  exitedAt: string | null;
  /** The episode opened for a role-change request on a machine whose boot role was standby. */
  afterLatePromotion?: boolean;
}

export interface ContinuityFile {
  v: 1;
  episodeId: string;
  lease: LeaseRecord;
  meta: ContinuityMeta;
  /** This machine's lease key over `canonicalContinuityMeta(lease.nonce, meta)`. */
  signature: string;
}

const META_KEYS: Array<keyof ContinuityMeta> = [
  'requestedBy', 'reason', 'requestedAt', 'episodeOpenedAt', 'renewedAt', 'windowMs', 'confirmed', 'exitedAt', 'afterLatePromotion',
];

/** Domain-tagged, field-ordered form the meta signature covers (every field but the signature). */
export function canonicalContinuityMeta(nonce: number, meta: ContinuityMeta): string {
  const ordered: Record<string, unknown> = {};
  for (const k of META_KEYS) if (meta[k] !== undefined) ordered[k] = meta[k];
  return JSON.stringify(['lease-continuity-v1', nonce, ordered]);
}

export type ContinuityVerdict =
  | 'ok'
  | 'missing'
  | 'unreadable'
  | 'wrong-holder'
  | 'lease-signature-invalid'
  | 'meta-signature-invalid'
  | 'expired';

export interface LeaseContinuityStoreDeps {
  stateDir: string;
  selfMachineId: string;
  /** Sign canonical bytes with this machine's lease key (the FencedLease crypto seam). */
  sign: (canonical: string) => string;
  verify: (canonical: string, signature: string, holderMachineId: string) => boolean;
  /** The lease's own signature check (`FencedLease.verifyLease`). */
  verifyLease: (lease: LeaseRecord) => boolean;
  /** R1's unsigned-answer ceiling, the read clamp for budget samples. */
  unsignedCeilingMs: number;
  now?: () => number;
  logger?: (msg: string) => void;
}

export interface BootSample {
  at: string;
  ms: number;
  outcome: string;
  basis?: string;
}

/**
 * Reads, writes and verifies `state/lease-continuity.json` and `state/restart-budget.json`.
 * Both are this machine's own (machine-local by design, hardware-bound-resource). Mode 0600,
 * atomic rename; a write failure is logged and never thrown into a renewal.
 */
export class LeaseContinuityStore {
  private readonly d: LeaseContinuityStoreDeps;
  readonly filePath: string;
  readonly budgetPath: string;

  constructor(deps: LeaseContinuityStoreDeps) {
    this.d = deps;
    this.filePath = path.join(deps.stateDir, 'state', 'lease-continuity.json');
    this.budgetPath = path.join(deps.stateDir, 'state', 'restart-budget.json');
  }

  private now(): number { return (this.d.now ?? Date.now)(); }
  private log(m: string): void { this.d.logger?.(m); }

  newEpisodeId(): string { return randomUUID(); }

  sign(file: Omit<ContinuityFile, 'signature'>): ContinuityFile {
    return { ...file, signature: this.d.sign(canonicalContinuityMeta(file.lease.nonce, file.meta)) };
  }

  /** Write (atomic, 0600). Never throws: a failed write is logged and the renewal goes on. */
  write(file: ContinuityFile): boolean {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch (err) {
      this.log(`lease-continuity: the continuity file could not be written (${err instanceof Error ? err.message : String(err)}); the renewal goes on without it.`);
      return false;
    }
  }

  /** Read and verify this machine's own file. Epoch/nonce agreement with the store is the coordinator's check. */
  read(): { file: ContinuityFile | null; verdict: ContinuityVerdict } {
    let raw: ContinuityFile;
    try {
      if (!fs.existsSync(this.filePath)) return { file: null, verdict: 'missing' };
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as ContinuityFile;
    } catch {
      return { file: null, verdict: 'unreadable' }; // @silent-fallback-ok: an unreadable file is measured if possible, then discarded by the caller
    }
    if (!raw || raw.v !== 1 || !raw.lease || !raw.meta || typeof raw.signature !== 'string' || typeof raw.episodeId !== 'string') {
      return { file: raw ?? null, verdict: 'unreadable' };
    }
    if (raw.lease.holder !== this.d.selfMachineId) return { file: raw, verdict: 'wrong-holder' };
    if (!this.d.verifyLease(raw.lease)) return { file: raw, verdict: 'lease-signature-invalid' };
    if (!this.d.verify(canonicalContinuityMeta(raw.lease.nonce, raw.meta), raw.signature, this.d.selfMachineId)) {
      return { file: raw, verdict: 'meta-signature-invalid' };
    }
    const exp = Date.parse(raw.lease.expiresAt);
    if (!Number.isFinite(exp) || this.now() >= exp) return { file: raw, verdict: 'expired' };
    return { file: raw, verdict: 'ok' };
  }

  delete(): void {
    try {
      if (fs.existsSync(this.filePath)) SafeFsExecutor.safeUnlinkSync(this.filePath, { operation: 'src/core/LeaseContinuity.ts:delete' });
    } catch { /* @silent-fallback-ok: a file that cannot be removed is discarded by verification at the next boot */ }
  }

  /**
   * The shutdown handler's one synchronous action: stamp `exitedAt` when the file names a lease
   * this process confirmed (its nonce). Returns true when stamped.
   */
  stampExit(confirmedNonce: number | null): boolean {
    if (confirmedNonce === null) return false;
    try {
      if (!fs.existsSync(this.filePath)) return false;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as ContinuityFile;
      if (!raw?.lease || raw.lease.nonce !== confirmedNonce) return false;
      const meta: ContinuityMeta = { ...raw.meta, exitedAt: new Date(this.now()).toISOString() };
      const signed = this.sign({ v: 1, episodeId: raw.episodeId, lease: raw.lease, meta });
      const tmp = `${this.filePath}.${process.pid}.exit.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(signed, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch {
      return false; // @silent-fallback-ok: a missing stamp costs only the boot measurement's precision
    }
  }

  // ── Restart budget ────────────────────────────────────────────────

  readBudget(): BootSample[] {
    try {
      if (!fs.existsSync(this.budgetPath)) return [];
      const raw = JSON.parse(fs.readFileSync(this.budgetPath, 'utf8')) as { samples?: unknown };
      if (!raw || !Array.isArray(raw.samples)) return [];
      const out: BootSample[] = [];
      for (const s of raw.samples as Array<Partial<BootSample>>) {
        const ms = clampSampleMs(s?.ms, this.d.unsignedCeilingMs);
        if (ms === null || typeof s.at !== 'string') continue;
        out.push({ at: s.at, ms, outcome: typeof s.outcome === 'string' ? s.outcome : 'unknown', ...(typeof s.basis === 'string' ? { basis: s.basis } : {}) });
      }
      return out.slice(-RESTART_BUDGET_SAMPLES);
    } catch {
      return []; // @silent-fallback-ok: an unreadable budget means the unmeasured base, never a fabricated window
    }
  }

  /** Append a boot sample (the last twenty kept). Returns the previous slowest, for the creeping-boot log. */
  appendBootSample(ms: number, outcome: string, basis: string): { previousSlowestMs: number | null } {
    const clamped = clampSampleMs(ms, this.d.unsignedCeilingMs);
    const samples = this.readBudget();
    const previousSlowestMs = samples.length ? Math.max(...samples.map((s) => s.ms)) : null;
    if (clamped === null || ms < 0) return { previousSlowestMs };
    samples.push({ at: new Date(this.now()).toISOString(), ms: clamped, outcome, basis });
    try {
      fs.mkdirSync(path.dirname(this.budgetPath), { recursive: true });
      const tmp = `${this.budgetPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ samples: samples.slice(-RESTART_BUDGET_SAMPLES) }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.budgetPath);
    } catch (err) {
      // @silent-fallback-ok: logged; the budget is advisory, and a missing sample only leaves the next boot its wider default allowance
      this.log(`lease-continuity: the restart budget could not be written (${err instanceof Error ? err.message : String(err)}).`);
    }
    return { previousSlowestMs };
  }

  /** The slowest sample below twenty, the p95 from twenty (R5's shape); null with no samples. */
  restartBudgetMs(): number | null {
    const ms = this.readBudget().map((s) => s.ms).sort((a, b) => a - b);
    if (ms.length === 0) return null;
    if (ms.length < RESTART_BUDGET_SAMPLES) return ms[ms.length - 1];
    return ms[Math.min(ms.length - 1, Math.ceil(0.95 * ms.length) - 1)];
  }

  bootSamplesMs(): number[] {
    return this.readBudget().map((s) => s.ms);
  }
}

// ── Silence as evidence (pure) ────────────────────────────────────────

/**
 * planned-restart-keeps-lead §2 — whether a peer's settled silence may count as death for the survivor
 * hold. It may not when every one of the last `silentProbes` probes carries a cause: then every route
 * this machine dialed failed on this machine's side (no route, a Local Network permission), or the peer
 * advertises nothing dialable, and the peer is alive-and-unknown, never dead. Boot claim safety's own
 * rules are unchanged by this: only the reclaim's survivor hold reads it.
 */
export function silenceIsEvidence(record: { probes: Array<{ answer: string; cause?: string }> } | undefined, silentProbes: number): boolean {
  if (!record) return false;
  const tail = record.probes.slice(-Math.max(1, silentProbes));
  if (tail.length === 0) return false;
  return !tail.every((p) => p.answer === 'silent' && !!p.cause);
}

// ── Episode end rule (pure) ───────────────────────────────────────────

export interface EpisodeEndInputs {
  nowMs: number;
  openedAtMs: number;
  /** When the request file was last seen present (null = never seen since the announce). */
  fileLastSeenMs: number | null;
  filePresent: boolean;
  /** The ledger's consumption row for this request, when one exists (its `at`). */
  consumptionAtMs: number | null;
  /** Whether the ledger could be read far enough back; unreadable or cut reads as "row present". */
  ledgerCoverage: 'full' | 'cut' | 'unreadable';
  /** Whether this process announced the request's withdrawal. */
  withdrawn: boolean;
  /** The resolved shutdown deadline, for exit (e). */
  shutdownDeadlineMs?: number;
  capMs?: number;
}

export type EpisodeEnd =
  | { ended: false }
  | { ended: true; cause: 'withdrawn' | 'removed-without-consumption' | 'consumed-process-alive' | 'cap' };

/** Exit (e)'s bound: `max(60 s, deadline + 3 s + 25 s)`. */
export function consumedAliveBoundMs(shutdownDeadlineMs = 20_000): number {
  return Math.max(EPISODE_ABSENCE_MS, shutdownDeadlineMs + 3_000 + STALL_SLACK_MS);
}

export function evaluateEpisodeEnd(i: EpisodeEndInputs): EpisodeEnd {
  if (i.withdrawn) return { ended: true, cause: 'withdrawn' };
  const cap = i.capMs ?? EPISODE_CAP_MS;
  if (i.nowMs - i.openedAtMs >= cap) return { ended: true, cause: 'cap' };
  if (i.consumptionAtMs !== null) {
    if (i.nowMs - i.consumptionAtMs >= consumedAliveBoundMs(i.shutdownDeadlineMs)) return { ended: true, cause: 'consumed-process-alive' };
    return { ended: false };
  }
  if (!i.filePresent) {
    const absentSince = i.fileLastSeenMs ?? i.openedAtMs;
    if (i.nowMs - absentSince >= EPISODE_ABSENCE_MS) {
      // No row: withdrawn by another process or discarded by a consumer without acting. An unreadable
      // or cut ledger reads as "row present" (the safe side), so only a full read may end the episode.
      if (i.ledgerCoverage === 'full') return { ended: true, cause: 'removed-without-consumption' };
    }
  }
  return { ended: false };
}

/** Boot duration from the later of the exit stamp, the last renewal and the consumption row; null when negative. */
export function bootDurationMs(i: { nowMs: number; exitedAt: string | null; renewedAt: string; consumptionAtMs: number | null }): number | null {
  const exit = i.exitedAt ? Date.parse(i.exitedAt) : NaN;
  const renewed = Date.parse(i.renewedAt);
  const start = Math.max(Number.isFinite(exit) ? exit : -Infinity, Number.isFinite(renewed) ? renewed : -Infinity, i.consumptionAtMs ?? -Infinity);
  if (!Number.isFinite(start)) return null;
  const ms = i.nowMs - start;
  return ms < 0 ? null : ms;
}
