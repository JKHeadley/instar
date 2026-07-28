/**
 * GuardLatchStore — pool-visible kill-switch + marker latches for guarded
 * autonomous authorities (green-pr-automerge-enforcement R9/R7).
 *
 * Two independent gate families decide whether the GreenPrAutoMerger may act:
 *   - `rollback`        — set by POST /green-pr-automerge/rollback, cleared by
 *                         POST /green-pr-automerge/enable (PIN-gated re-arm)
 *   - `emergency-pause` — set by the MessageSentinel emergency stop, cleared by
 *                         its own resume path
 * BOTH must be open for a merge. A third family, `pool-armed`, is a posture
 * MARKER (not a gate): its presence makes a lease holder whose local config is
 * disabled grade `diverged-from-default` instead of healthy dark-default.
 *
 * Why a store and not a flag (round-2 finding): execution follows the lease, so
 * a machine-LOCAL latch would silently resurrect the watcher on a lease move.
 * Each transition is therefore written BOTH to a durable local file (authoritative
 * for this machine's own writes, present regardless of the journal feature flag)
 * AND to the replicated `guard-latch` coherence-journal kind, so a peer that
 * takes the lease reads the same disabled state.
 *
 * ABSORBING disable (round-4): a `rollback` set always wins ordering conflicts
 * regardless of epoch — "a stale-epoch standby's STOP can never be out-ordered
 * by an earlier /enable from a higher epoch." This is achieved structurally, not
 * by clock comparison: every `set` mints a FRESH globally-unique latchId
 * (`<machineId>:<seq>`), and `/enable` clears ONLY the specific latchId(s) it
 * names. A new STOP therefore introduces a latchId no prior enable could have
 * named, so it can never be pre-cleared. Ordering within a single latchId is by
 * (epoch, seq), NEVER wall-clock.
 *
 * arrive-disabled-on-unreadable (round-3): if the merged peer view cannot be
 * read, `isMergeAllowed()` returns false — absence of evidence is not "armed."
 */

import fs from 'node:fs';
import path from 'node:path';

import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import type { CoherenceJournal, GuardLatchAction } from '../core/CoherenceJournal.js';

/** A single latch transition (own or peer), as merged for resolution. */
export interface GuardLatchEntry {
  machine: string;
  latchKind: string;
  latchId: string;
  action: GuardLatchAction;
  epoch: number;
  seq: number;
  reason?: string;
  ts?: string;
}

export type MergeGateReason = 'allowed' | 'rollback' | 'emergency-pause' | 'unreadable-peers';

export interface MergeGateVerdict {
  allowed: boolean;
  reason: MergeGateReason;
  /** Active latch ids per blocking family (for the status surface / audit). */
  activeLatchIds: Record<string, string[]>;
}

/** Latch family names. */
export const ROLLBACK_FAMILY = 'rollback';
export const EMERGENCY_PAUSE_FAMILY = 'emergency-pause';
export const POOL_ARMED_FAMILY = 'pool-armed';
/** The fixed, pool-shared latchId for the single pool-armed marker. */
export const POOL_MARKER_ID = 'pool';

interface OwnTransition {
  action: GuardLatchAction;
  epoch: number;
  seq: number;
  reason?: string;
  ts: string;
}

interface LocalFile {
  machineId: string;
  ownSeq: number;
  /** latchKind → latchId → latest own transition. */
  transitions: Record<string, Record<string, OwnTransition>>;
}

export interface GuardLatchStoreConfig {
  /** Absolute path to the agent's `.instar/` directory. */
  stateDir: string;
  /** Stable id for THIS machine. */
  machineId: string;
  /** Replication writer (optional — single-machine installs pass none). */
  journal?: Pick<CoherenceJournal, 'emitGuardLatch'>;
  /** Current lease epoch (monotonic; stamped on every transition). */
  leaseEpoch: () => number;
  /**
   * Merged peer view: the latest guard-latch transition per (machine, kind, id)
   * from replicated peer streams. Throwing signals UNREADABLE → arrive-disabled.
   * Single-machine installs pass `() => []`.
   */
  readPeerEntries?: () => GuardLatchEntry[];
  now?: () => Date;
  logger?: (msg: string) => void;
}

export class GuardLatchStore {
  private readonly stateDir: string;
  private readonly machineId: string;
  private readonly journal?: Pick<CoherenceJournal, 'emitGuardLatch'>;
  private readonly leaseEpoch: () => number;
  private readonly readPeerEntries: () => GuardLatchEntry[];
  private readonly now: () => Date;
  private readonly logger?: (msg: string) => void;

  private local: LocalFile;

  constructor(cfg: GuardLatchStoreConfig) {
    this.stateDir = cfg.stateDir;
    this.machineId = cfg.machineId;
    this.journal = cfg.journal;
    this.leaseEpoch = cfg.leaseEpoch;
    this.readPeerEntries = cfg.readPeerEntries ?? (() => []);
    this.now = cfg.now ?? (() => new Date());
    this.logger = cfg.logger;
    this.local = this.load();
  }

  // ---- mutation -----------------------------------------------------------

  /**
   * Set (mint) a latch in `latchKind`. Returns the fresh, globally-unique
   * latchId. Use for the absorbing families (rollback, emergency-pause): every
   * call introduces a NEW latchId that no prior clear could have named.
   */
  set(latchKind: string, reason?: string): string {
    const seq = ++this.local.ownSeq;
    const latchId = `${this.machineId}:${seq}`;
    this.record(latchKind, latchId, 'set', seq, reason);
    return latchId;
  }

  /** Clear the SPECIFIC named latchId(s) in `latchKind` (the /enable semantics). */
  clear(latchKind: string, latchIds: string[], reason?: string): void {
    for (const latchId of latchIds) {
      const seq = ++this.local.ownSeq;
      this.record(latchKind, latchId, 'clear', seq, reason);
    }
  }

  /** Set/clear a FIXED-id marker (pool-armed): last-(epoch,seq)-wins, not absorbing. */
  setMarker(latchKind: string, latchId: string, on: boolean, reason?: string): void {
    const seq = ++this.local.ownSeq;
    this.record(latchKind, latchId, on ? 'set' : 'clear', seq, reason);
  }

  private record(latchKind: string, latchId: string, action: GuardLatchAction, seq: number, reason?: string): void {
    const epoch = safeEpoch(this.leaseEpoch);
    const ts = this.now().toISOString();
    const fam = this.local.transitions[latchKind] ?? (this.local.transitions[latchKind] = {});
    fam[latchId] = { action, epoch, seq, ...(reason ? { reason: reason.slice(0, 80) } : {}), ts };
    // Durable local write FIRST (safety never waits on the journal/network).
    this.persist();
    // Then replicate (best-effort; non-blocking inside the journal).
    try {
      this.journal?.emitGuardLatch({ latchKind, latchId, action, epoch, seq, ...(reason ? { reason: reason.slice(0, 80) } : {}) });
    } catch (e) { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      this.log(`guard-latch journal emit failed (swallowed): ${(e as Error)?.message}`);
    }
  }

  // ---- resolution ---------------------------------------------------------

  /**
   * Resolve a family to the winning action per latchId across own + peers.
   * Within one latchId, the highest (epoch, seq) transition wins. Distinct
   * latchIds are independent — that is what makes `set` absorbing for the
   * fresh-id families.
   * @throws if the peer view is unreadable (caller maps to arrive-disabled).
   */
  resolveFamily(latchKind: string): Map<string, GuardLatchEntry> {
    const winners = new Map<string, GuardLatchEntry>();
    const consider = (e: GuardLatchEntry) => {
      if (e.latchKind !== latchKind) return;
      const cur = winners.get(e.latchId);
      if (!cur || dominates(e, cur)) winners.set(e.latchId, e);
    };
    // Own transitions.
    const ownFam = this.local.transitions[latchKind] ?? {};
    for (const [latchId, t] of Object.entries(ownFam)) {
      consider({ machine: this.machineId, latchKind, latchId, action: t.action, epoch: t.epoch, seq: t.seq, reason: t.reason, ts: t.ts });
    }
    // Peer transitions (throws → unreadable).
    for (const e of this.readPeerEntries()) consider(e);
    return winners;
  }

  /** Active (currently-set) latch ids in a family. */
  activeLatchIds(latchKind: string): string[] {
    const out: string[] = [];
    for (const [latchId, e] of this.resolveFamily(latchKind)) {
      if (e.action === 'set') out.push(latchId);
    }
    return out;
  }

  /**
   * The dual-latch gate (R9): both rollback and emergency-pause must be open.
   * An unreadable peer view arrives DISABLED (absence of evidence ≠ armed).
   */
  isMergeAllowed(): MergeGateVerdict {
    let rollback: string[];
    let pause: string[];
    try {
      rollback = this.activeLatchIds(ROLLBACK_FAMILY);
      pause = this.activeLatchIds(EMERGENCY_PAUSE_FAMILY);
    } catch (e) { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      this.log(`guard-latch peer view unreadable — arriving DISABLED: ${(e as Error)?.message}`);
      return { allowed: false, reason: 'unreadable-peers', activeLatchIds: {} };
    }
    if (rollback.length > 0) {
      return { allowed: false, reason: 'rollback', activeLatchIds: { [ROLLBACK_FAMILY]: rollback } };
    }
    if (pause.length > 0) {
      return { allowed: false, reason: 'emergency-pause', activeLatchIds: { [EMERGENCY_PAUSE_FAMILY]: pause } };
    }
    return { allowed: true, reason: 'allowed', activeLatchIds: {} };
  }

  // ---- pool-armed marker (R7) --------------------------------------------

  markPoolArmed(): void {
    this.setMarker(POOL_ARMED_FAMILY, POOL_MARKER_ID, true, 'armed');
  }

  /** PIN-gated disarm: superseding entry, grades back to healthy dark-default. */
  markPoolDisarmed(): void {
    this.setMarker(POOL_ARMED_FAMILY, POOL_MARKER_ID, false, 'disarmed');
  }

  /**
   * Is this pool deliberately armed (per the replicated marker)? Used by guard
   * posture to grade a local-disabled + pool-armed machine `diverged-from-default`.
   * Unreadable peers → false (we never INVENT a divergence alarm on a read error).
   */
  isPoolArmed(): boolean {
    try {
      const winner = this.resolveFamily(POOL_ARMED_FAMILY).get(POOL_MARKER_ID);
      return winner?.action === 'set';
    } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      return false;
    }
  }

  // ---- status -------------------------------------------------------------

  /** Snapshot for the status route + posture grading. Never throws. */
  snapshot(): { rollback: string[]; emergencyPause: string[]; poolArmed: boolean; mergeAllowed: boolean; reason: MergeGateReason } {
    const verdict = this.isMergeAllowed();
    let rollback: string[] = [];
    let pause: string[] = [];
    try {
      rollback = this.activeLatchIds(ROLLBACK_FAMILY);
      pause = this.activeLatchIds(EMERGENCY_PAUSE_FAMILY);
    } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ /* unreadable — leave empty; verdict already reflects it */ }
    return {
      rollback,
      emergencyPause: pause,
      poolArmed: this.isPoolArmed(),
      mergeAllowed: verdict.allowed,
      reason: verdict.reason,
    };
  }

  // ---- durable local file -------------------------------------------------

  private filePath(): string {
    return path.join(this.stateDir, 'state', 'green-pr-automerge-latches.json');
  }

  private load(): LocalFile {
    const fresh: LocalFile = { machineId: this.machineId, ownSeq: 0, transitions: {} };
    try {
      const raw = fs.readFileSync(this.filePath(), 'utf-8');
      const obj = JSON.parse(raw) as Partial<LocalFile>;
      if (obj && typeof obj.ownSeq === 'number' && obj.transitions && typeof obj.transitions === 'object') {
        return { machineId: this.machineId, ownSeq: obj.ownSeq, transitions: obj.transitions as LocalFile['transitions'] };
      }
    } catch (e) { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.log(`guard-latch local file unreadable, starting fresh: ${(e as Error)?.message}`);
      }
    }
    return fresh;
  }

  private persist(): void {
    const p = this.filePath();
    const dir = path.dirname(p);
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.local, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, p);
    } catch (e) { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      // A failed durable write is a SAFETY problem for a STOP (the latch might
      // not survive a restart). We surface it loudly but do not throw into the
      // route — the journal emit + the in-memory state still gate this process.
      this.log(`guard-latch durable write FAILED: ${(e as Error)?.message}`);
    }
  }

  private log(msg: string): void {
    this.logger?.(`[guard-latch] ${msg}`);
  }
}

/** (epoch, seq) lexicographic domination — NEVER wall-clock. */
function dominates(a: GuardLatchEntry, b: GuardLatchEntry): boolean {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch;
  return a.seq > b.seq;
}

function safeEpoch(fn: () => number): number {
  try {
    const e = fn();
    return Number.isFinite(e) ? e : 0;
  } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
    return 0;
  }
}
