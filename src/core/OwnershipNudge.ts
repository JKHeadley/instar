/**
 * ownership-nudge (docs/specs/session-pool-move-nudge.md) — after a move's claim lands, the
 * source tells its siblings to pull placements now, rather than at the next 30-second pull.
 *
 * A hint with no authority: the verb carries which claim to look for, and nothing writes it to
 * any store. Ownership still crosses only as signed journal entries, through the fast-forward
 * applier. If a nudge is lost, or the brakes here stop one, the normal timers deliver the same
 * entries later.
 */

// RULE 3: EXEMPT — receives a signed mesh verb from a sibling; it reads no provider output or terminal state.

/** One claim to look for. */
export interface OwnershipNudge {
  sessionKey: string;
  epoch: number;
  landedAt: number;
}

/** What the sender needs. `send` may throw or refuse: an older peer answers `claim-unauthorized`. */
export interface OwnershipNudgeSendDeps {
  selfMachineId: string;
  activeMachineIds: () => string[];
  /** Advertise what was just written: a sibling can only pull flushed entries. */
  flush: () => void;
  send: (machineId: string, nudge: OwnershipNudge) => Promise<unknown>;
}

/** Tell every other active machine. Never throws and never waits: the move does not depend on it. */
export function sendOwnershipNudges(d: OwnershipNudgeSendDeps, nudge: OwnershipNudge): void {
  try {
    d.flush();
  } catch { /* @silent-fallback-ok: an unflushed entry is delivered by the 30 s pull, and the receiver's evidence row says not reached */ }
  let peers: string[] = [];
  try {
    peers = d.activeMachineIds().filter((id) => id !== d.selfMachineId);
  } catch { /* @silent-fallback-ok: with no peer list there is nobody to tell; the 30 s pull is the fallback */ }
  for (const id of new Set(peers)) {
    try {
      void Promise.resolve(d.send(id, nudge)).catch(() => { /* @silent-fallback-ok: a lost or refused nudge is today's behaviour, the 30 s pull */ });
    } catch { /* @silent-fallback-ok: same as the rejected send above */ }
  }
}

export const NUDGE_MIN_PASS_GAP_MS = 1_000;
export const NUDGE_MAX_PASSES_PER_HOUR = 60;
export const NUDGE_FAILURE_STREAK_LIMIT = 5;
export const NUDGE_FAILURE_PAUSE_MS = 5 * 60_000;
export const NUDGE_MAX_PENDING_KEYS = 100;

/** Why a nudge did nothing, or how a key came out. */
export type OwnershipNudgeOutcome = 'reached' | 'not-reached' | 'off' | 'budget-stop' | 'failure-pause';

export interface OwnershipNudgeRow {
  outcome: OwnershipNudgeOutcome;
  sender: string;
  sessionKey?: string;
  epoch?: number;
  /** `landedAt` to reached. Crosses two clocks: read beside the sender's skew. */
  landedToReachedMs?: number;
  /** This machine's own pull and apply time. */
  processingMs?: number;
}

export interface OwnershipNudgeReceiverDeps {
  /** False when the journal is off or the puller and applier are not bound. */
  available: () => boolean;
  /** Pull `topic-placement` from this sender only. Resolves false if it could not reach the head. */
  pullPlacements: (sender: string) => Promise<boolean>;
  tickApplier: () => void;
  localEpoch: (sessionKey: string) => number | null;
  wake: (sessionKey: string) => void;
  record: (row: OwnershipNudgeRow) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface SenderState {
  pending: Map<string, OwnershipNudge>;
  running: boolean;
  lastPassAt: number;
  passAt: number[];
  failureStreak: number;
  pausedUntil: number;
}

/** Runs at most one pass per sender at a time, and only ever because of a nudge. */
export class OwnershipNudgeReceiver {
  private readonly senders = new Map<string, SenderState>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private settled: Promise<void> = Promise.resolve();

  constructor(private readonly d: OwnershipNudgeReceiverDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  }

  /** Returns at once. The verb's answer does not wait for the pull. */
  receive(sender: string, nudge: OwnershipNudge): void {
    if (!this.d.available()) {
      this.note({ outcome: 'off', sender, sessionKey: nudge.sessionKey, epoch: nudge.epoch });
      return;
    }
    const s = this.state(sender);
    if (this.now() < s.pausedUntil) {
      this.note({ outcome: 'failure-pause', sender, sessionKey: nudge.sessionKey, epoch: nudge.epoch });
      return;
    }
    s.pending.delete(nudge.sessionKey);
    s.pending.set(nudge.sessionKey, nudge);
    if (s.pending.size > NUDGE_MAX_PENDING_KEYS) {
      // The dropped key's message waits for the normal timers.
      const oldest = s.pending.keys().next().value as string;
      s.pending.delete(oldest);
    }
    if (!s.running) {
      s.running = true;
      this.settled = Promise.all([this.settled, this.drain(sender, s)]).then(() => undefined);
    }
  }

  /** Test seam: resolves when every pass started so far has finished. */
  whenSettled(): Promise<void> {
    return this.settled;
  }

  private state(sender: string): SenderState {
    let s = this.senders.get(sender);
    if (!s) {
      s = { pending: new Map(), running: false, lastPassAt: Number.NEGATIVE_INFINITY, passAt: [], failureStreak: 0, pausedUntil: 0 };
      this.senders.set(sender, s);
    }
    return s;
  }

  private async drain(sender: string, s: SenderState): Promise<void> {
    try {
      while (s.pending.size > 0) {
        const wait = s.lastPassAt + NUDGE_MIN_PASS_GAP_MS - this.now();
        if (wait > 0) await this.sleep(wait);
        const hourAgo = this.now() - 3_600_000;
        s.passAt = s.passAt.filter((t) => t > hourAgo);
        const batch = [...s.pending.values()];
        s.pending.clear();
        if (s.passAt.length >= NUDGE_MAX_PASSES_PER_HOUR) {
          for (const n of batch) this.note({ outcome: 'budget-stop', sender, sessionKey: n.sessionKey, epoch: n.epoch });
          continue;
        }
        await this.pass(sender, s, batch);
      }
    } finally {
      s.running = false;
    }
  }

  private async pass(sender: string, s: SenderState, batch: OwnershipNudge[]): Promise<void> {
    const startedAt = this.now();
    s.lastPassAt = startedAt;
    s.passAt.push(startedAt);
    let pulled = false;
    try {
      pulled = await this.d.pullPlacements(sender);
      this.d.tickApplier();
    } catch { /* @silent-fallback-ok: counted below as a failed pass, and the 30 s pull and 15 s applier timers carry on */
      pulled = false;
    }
    let allReached = pulled;
    for (const n of batch) {
      let epoch: number | null = null;
      try {
        epoch = this.d.localEpoch(n.sessionKey);
      } catch { /* @silent-fallback-ok: an unreadable key reads as not reached, so nothing is woken */ }
      const reached = epoch !== null && epoch >= n.epoch;
      if (reached) {
        try {
          this.d.wake(n.sessionKey);
        } catch { /* @silent-fallback-ok: the queue's own drain tick delivers it */ }
      } else {
        allReached = false;
      }
      const at = this.now();
      this.note({
        outcome: reached ? 'reached' : 'not-reached',
        sender,
        sessionKey: n.sessionKey,
        epoch: n.epoch,
        ...(reached ? { landedToReachedMs: at - n.landedAt } : {}),
        processingMs: at - startedAt,
      });
    }
    if (allReached) {
      s.failureStreak = 0;
      return;
    }
    s.failureStreak += 1;
    if (s.failureStreak >= NUDGE_FAILURE_STREAK_LIMIT) {
      s.failureStreak = 0;
      s.pausedUntil = this.now() + NUDGE_FAILURE_PAUSE_MS;
      for (const n of s.pending.values()) this.note({ outcome: 'failure-pause', sender, sessionKey: n.sessionKey, epoch: n.epoch });
      s.pending.clear();
    }
  }

  private note(row: OwnershipNudgeRow): void {
    try {
      this.d.record(row);
    } catch { /* @silent-fallback-ok: an evidence row must never break the hint */ }
  }
}

/** Reads the verb's fields; anything malformed is refused before any work happens. */
export function parseOwnershipNudge(cmd: { sessionKey?: unknown; epoch?: unknown; landedAt?: unknown }): OwnershipNudge | null {
  const { sessionKey, epoch, landedAt } = cmd;
  if (typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 256) return null;
  if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return null;
  if (typeof landedAt !== 'number' || !Number.isFinite(landedAt)) return null;
  return { sessionKey, epoch, landedAt };
}
