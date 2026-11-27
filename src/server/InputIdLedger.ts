/**
 * InputIdLedger — the serving machine's record of dashboard input ids
 * (native-conversation-any-machine-access §3e item 3).
 *
 * A dashboard `input`/`key` frame may carry a `clientInputId`, made at random in
 * the browser. The serving machine records `(session, clientInputId)` BEFORE it
 * writes to tmux and answers a repeated id with the original acknowledgement,
 * without writing again. Ids are keyed by session and id only: the server has
 * no stable client identity, and a relayed frame arrives on a peer link that is
 * new after every drop, so a per-connection key would make every retry after a
 * reconnect an unknown id.
 *
 * Floor (holds whatever the retention): an id this ledger does not know is
 * never typed on a flagged retry — the caller refuses it `input-retry-unknown`.
 * Forgetting an id can therefore refuse a retry and can never cause a second
 * write. Retention (the newest 256 ids per session, in memory) is tuning within
 * that floor; `evicted` and `retryUnknown` per session are the evidence the
 * 2026-11-25 check reads.
 *
 * Machine-local by design (hardware-bound-resource): the ids guard writes into
 * one tmux pane on this machine and live only in this server's memory.
 */

/** The browser-made id format; anything else is refused before it is echoed. */
export const CLIENT_INPUT_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** Ids kept per session (a memory bound, about 64 bytes an id; see the spec's decision points). */
export const INPUT_IDS_PER_SESSION = 256;

export interface InputAckFrame {
  type: 'input_ack';
  session: string;
  success: boolean;
  clientInputId: string;
}

type Entry<W> =
  | { state: 'pending'; waiters: W[] }
  | { state: 'done'; ack: InputAckFrame };

export interface SessionInputCounters {
  /** Ids dropped because the session's set was full. */
  evicted: number;
  /** Flagged retries refused because the id was not known. */
  retryUnknown: number;
  /** Repeated ids answered from the record without writing again. */
  repeated: number;
}

export type LedgerLookup<W> =
  | { kind: 'unknown' }
  | { kind: 'done'; ack: InputAckFrame }
  | { kind: 'pending'; addWaiter: (w: W) => void };

export class InputIdLedger<W = unknown> {
  /** session → (id → entry), in insertion order (oldest first). */
  private readonly bySession = new Map<string, Map<string, Entry<W>>>();
  private readonly counters = new Map<string, SessionInputCounters>();
  private readonly totals: SessionInputCounters = { evicted: 0, retryUnknown: 0, repeated: 0 };

  constructor(private readonly perSession: number = INPUT_IDS_PER_SESSION) {}

  private countersFor(session: string): SessionInputCounters {
    let c = this.counters.get(session);
    if (!c) {
      c = { evicted: 0, retryUnknown: 0, repeated: 0 };
      this.counters.set(session, c);
      // Bounded: per-session counters for the most recent 1024 sessions; totals keep everything.
      if (this.counters.size > 1024) this.counters.delete(this.counters.keys().next().value as string);
    }
    return c;
  }

  /** What the ledger knows about this id. A known id counts as a repeat. */
  lookup(session: string, id: string): LedgerLookup<W> {
    const entry = this.bySession.get(session)?.get(id);
    if (!entry) return { kind: 'unknown' };
    this.countersFor(session).repeated++;
    this.totals.repeated++;
    if (entry.state === 'done') return { kind: 'done', ack: entry.ack };
    return { kind: 'pending', addWaiter: (w) => { entry.waiters.push(w); } };
  }

  /** Count a flagged retry refused because its id is unknown. */
  noteRetryUnknown(session: string): void {
    this.countersFor(session).retryUnknown++;
    this.totals.retryUnknown++;
  }

  /** Record the id BEFORE the write. Evicts the oldest id past the bound. */
  begin(session: string, id: string): void {
    let ids = this.bySession.get(session);
    if (!ids) { ids = new Map(); this.bySession.set(session, ids); }
    ids.set(id, { state: 'pending', waiters: [] });
    while (ids.size > this.perSession) {
      const oldest = ids.keys().next().value as string;
      ids.delete(oldest);
      this.countersFor(session).evicted++;
      this.totals.evicted++;
    }
  }

  /** Store the original acknowledgement; returns the clients that asked mid-write. */
  complete(session: string, id: string, ack: InputAckFrame): W[] {
    const ids = this.bySession.get(session);
    const entry = ids?.get(id);
    if (!ids || !entry) return [];
    ids.set(id, { state: 'done', ack });
    return entry.state === 'pending' ? entry.waiters : [];
  }

  /** Drop the ids of sessions no longer running (counters are kept for the check). */
  prune(running: Set<string>): void {
    for (const session of [...this.bySession.keys()]) {
      if (!running.has(session)) this.bySession.delete(session);
    }
  }

  /** Counters for the maturation check: totals and every session with a non-zero count. */
  stats(): { totals: SessionInputCounters; sessions: Record<string, SessionInputCounters>; idsPerSession: number } {
    const sessions: Record<string, SessionInputCounters> = {};
    for (const [s, c] of this.counters) sessions[s] = { ...c };
    return { totals: { ...this.totals }, sessions, idsPerSession: this.perSession };
  }
}
