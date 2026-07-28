/**
 * WarmSessionPool — Layer 2 core (THREADLINE-A2A-COHERENCE-SPEC).
 *
 * Keeps an agent-to-agent session "warm" for a TTL so rapid follow-ups inject into the running
 * session (via the existing live-injection path) instead of respawning each message. The
 * operator-confirmed model is **per-peer** with a **global + per-peer cap** and **TTL + LRU
 * eviction**, so an inbound flood (many threads / one chatty peer) can't pin unbounded live
 * Claude processes. This is the pure registry + eviction policy; the server wires it to the real
 * session lifecycle (keep-alive, inject, kill-on-evict) and the SessionReaper (warm sessions are
 * evict-eligible under resource pressure — eviction is lossless because the next message falls
 * back to Layer 1 resume).
 *
 * Pure + clock-injected → fully testable. Eviction is reported (the caller kills the tmux/Claude
 * session); the pool itself holds no I/O.
 */

export interface WarmSessionRecord {
  threadId: string;
  /** Peer identity the warm session belongs to (the per-peer cap key). */
  peerId: string;
  /** The tmux/session name to inject into / kill on eviction. */
  sessionName: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface WarmSessionPoolConfig {
  /** Max warm sessions across all peers. */
  globalCap: number;
  /** Max warm sessions for any one peer (the inbound-flood bound). */
  perPeerCap: number;
  /** Idle TTL — a warm session unused for this long is reapable. */
  ttlMs: number;
}

/**
 * Thrown by `admit` when an existing thread record is owned by a DIFFERENT peer
 * than the caller presents (defense-in-depth, spec §3.5). The upstream
 * ThreadlineRouter ownership guard (identity-match) already blocks a peer
 * injecting into another's thread, but the pool MUST additionally refuse to
 * cross-bind a thread to a new peer — it must never silently overwrite the
 * owner. The caller treats this as a reject and falls back to a fresh
 * cold-spawn (no warm session).
 */
export class WarmSessionPeerConflictError extends Error {
  constructor(
    public readonly threadId: string,
    public readonly existingPeerId: string,
    public readonly attemptedPeerId: string,
  ) {
    super(
      `WarmSessionPool: thread ${threadId} is owned by peer ${existingPeerId}; ` +
      `refusing to re-bind to peer ${attemptedPeerId}`,
    );
    this.name = 'WarmSessionPeerConflictError';
  }
}

export class WarmSessionPool {
  private readonly byThread = new Map<string, WarmSessionRecord>();

  constructor(
    private readonly config: WarmSessionPoolConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  size(): number {
    return this.byThread.size;
  }

  private peerCount(peerId: string): number {
    let n = 0;
    for (const r of this.byThread.values()) if (r.peerId === peerId) n++;
    return n;
  }

  /** LRU among a predicate set (oldest lastUsedAt first). */
  private lru(filter?: (r: WarmSessionRecord) => boolean): WarmSessionRecord[] {
    const rs = [...this.byThread.values()].filter(r => (filter ? filter(r) : true));
    rs.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    return rs;
  }

  /**
   * Admit (or refresh) a warm session for a thread. Returns the records that must be EVICTED
   * (killed by the caller) to honor the caps — LRU first, per-peer cap before global cap. An
   * existing thread is refreshed in place (no eviction).
   */
  admit(input: { threadId: string; peerId: string; sessionName: string }): WarmSessionRecord[] {
    const now = this.now();
    const existing = this.byThread.get(input.threadId);
    if (existing) {
      // SECURITY (spec §3.5): never cross-bind a thread to a new peer. Refresh
      // in place only when the same peer owns it; otherwise throw so the caller
      // falls back to a fresh cold-spawn rather than silently overwriting the
      // owner's warm session.
      if (existing.peerId !== input.peerId) {
        throw new WarmSessionPeerConflictError(input.threadId, existing.peerId, input.peerId);
      }
      existing.lastUsedAt = now;
      existing.sessionName = input.sessionName;
      return [];
    }

    const evicted: WarmSessionRecord[] = [];

    // Per-peer cap: evict the peer's LRU until under the cap (leaving room for the new one).
    while (this.peerCount(input.peerId) >= this.config.perPeerCap) {
      const victim = this.lru(r => r.peerId === input.peerId)[0];
      if (!victim) break;
      this.byThread.delete(victim.threadId);
      evicted.push(victim);
    }

    // Global cap: evict the global LRU until under the cap.
    while (this.byThread.size >= this.config.globalCap) {
      const victim = this.lru()[0];
      if (!victim) break;
      this.byThread.delete(victim.threadId);
      evicted.push(victim);
    }

    this.byThread.set(input.threadId, {
      threadId: input.threadId,
      peerId: input.peerId,
      sessionName: input.sessionName,
      createdAt: now,
      lastUsedAt: now,
    });
    return evicted;
  }

  /** Mark a thread's warm session used (LRU refresh). */
  touch(threadId: string): void {
    const r = this.byThread.get(threadId);
    if (r) r.lastUsedAt = this.now();
  }

  /**
   * The raw record for a thread, IGNORING the idle TTL (unlike `get`). Used for
   * a pre-spawn peer-conflict check so the router can refuse a cross-peer warm
   * spawn BEFORE spending a spawn (admit would throw, but only after the worker
   * is already launched). Returns undefined when no record exists.
   */
  peek(threadId: string): WarmSessionRecord | undefined {
    return this.byThread.get(threadId);
  }

  /** The warm session for a thread, if present and not past its idle TTL; else undefined. */
  get(threadId: string): WarmSessionRecord | undefined {
    const r = this.byThread.get(threadId);
    if (!r) return undefined;
    if (this.now() - r.lastUsedAt >= this.config.ttlMs) return undefined;
    return r;
  }

  remove(threadId: string): WarmSessionRecord | undefined {
    const r = this.byThread.get(threadId);
    if (r) this.byThread.delete(threadId);
    return r;
  }

  /** Reap warm sessions idle past the TTL. Returns the evicted records (caller kills them). */
  reapExpired(): WarmSessionRecord[] {
    const now = this.now();
    const expired = [...this.byThread.values()].filter(r => now - r.lastUsedAt >= this.config.ttlMs);
    for (const r of expired) this.byThread.delete(r.threadId);
    return expired;
  }

  /** Reap up to n warm sessions under resource pressure (LRU first). Returns evicted records. */
  reapUnderPressure(n: number): WarmSessionRecord[] {
    const victims = this.lru().slice(0, Math.max(0, n));
    for (const r of victims) this.byThread.delete(r.threadId);
    return victims;
  }
}
