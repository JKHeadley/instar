/**
 * PlaceSessionRegistry — the live sessions running in other agents' places.
 * Spec: docs/specs/memory-privacy-agent-places.md §4.
 *
 * One live session per peer fingerprint. A second thread from the same peer goes into
 * that peer's live session. At the cap the registry REFUSES: it never ends a live
 * session to make room, so one peer can never cut another off (unlike WarmSessionPool,
 * which caps by evicting).
 *
 * Reservation is synchronous and atomic within the process: a place counts from the
 * moment it is reserved, not from launch, so two peers can never both pass the cap.
 * A record moves from `reserved` to `running` once its session exists, and is removed
 * when the launch fails or the session ends. In memory only: at boot every session with
 * the place marker is ended, because its `mps_` token was revoked anyway.
 */

export interface PlaceSessionRecord {
  fingerprint: string;
  state: 'reserved' | 'running';
  sessionName: string | null;
  reservedAt: number;
  lastDeliveryAt: number;
  /** Set while a reply is awaited or an inject is pending; the idle end skips it. */
  busyUntil: number;
}

export interface PlaceSessionRegistryOptions {
  /** Most places live at once. */
  globalCap: () => number;
  /** A place session ends this long after its last delivered message. */
  idleMs: () => number;
  now?: () => number;
}

export type PlaceReservation =
  | { kind: 'reserved'; release: () => void; markRunning: (sessionName: string) => void }
  | { kind: 'live'; sessionName: string }
  | { kind: 'refused'; reason: 'cap' | 'launching' };

export const DEFAULT_PLACE_GLOBAL_CAP = 3;
export const DEFAULT_PLACE_IDLE_MS = 600_000;

export class PlaceSessionRegistry {
  private readonly records = new Map<string, PlaceSessionRecord>();
  private readonly now: () => number;

  constructor(private readonly opts: PlaceSessionRegistryOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** The live session for a peer, or null. */
  live(fingerprint: string): string | null {
    const r = this.records.get(fingerprint);
    return r?.state === 'running' && r.sessionName ? r.sessionName : null;
  }

  /** Records still `reserved` (launching). Running ones are already counted as sessions. */
  reservedCount(): number {
    let n = 0;
    for (const r of this.records.values()) if (r.state === 'reserved') n++;
    return n;
  }

  /** All records, for status and the tick. */
  list(): PlaceSessionRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  /**
   * Check and reserve in one synchronous step. A peer with a live session gets it back;
   * a peer whose session is launching is refused (its message queues and drains); a new
   * peer at the cap is refused. Nothing live is ever ended here.
   */
  reserve(fingerprint: string): PlaceReservation {
    const existing = this.records.get(fingerprint);
    if (existing?.state === 'running' && existing.sessionName) return { kind: 'live', sessionName: existing.sessionName };
    if (existing?.state === 'reserved') return { kind: 'refused', reason: 'launching' };
    const cap = Math.max(0, Math.floor(this.opts.globalCap()));
    if (this.records.size >= cap) return { kind: 'refused', reason: 'cap' };
    const at = this.now();
    const record: PlaceSessionRecord = { fingerprint, state: 'reserved', sessionName: null, reservedAt: at, lastDeliveryAt: at, busyUntil: 0 };
    this.records.set(fingerprint, record);
    let settled = false;
    return {
      kind: 'reserved',
      release: () => {
        if (settled) return;
        settled = true;
        if (this.records.get(fingerprint) === record) this.records.delete(fingerprint);
      },
      markRunning: (sessionName: string) => {
        if (settled) return;
        settled = true;
        if (this.records.get(fingerprint) !== record) return;
        record.state = 'running';
        record.sessionName = sessionName;
        record.lastDeliveryAt = this.now();
      },
    };
  }

  /** A message was delivered into this peer's place session. */
  touch(fingerprint: string, busyForMs = 0): void {
    const r = this.records.get(fingerprint);
    if (!r) return;
    const at = this.now();
    r.lastDeliveryAt = at;
    if (busyForMs > 0) r.busyUntil = Math.max(r.busyUntil, at + busyForMs);
  }

  /** The session ended (any cause): forget it. */
  forgetSession(sessionName: string): void {
    for (const [fp, r] of this.records) {
      if (r.sessionName === sessionName) this.records.delete(fp);
    }
  }

  /** Forget a peer outright (its session was ended on refusal). */
  forget(fingerprint: string): void {
    this.records.delete(fingerprint);
  }

  /** Running records idle past the limit and not busy: the tick ends these. */
  idle(): PlaceSessionRecord[] {
    const at = this.now();
    const limit = this.opts.idleMs();
    return [...this.records.values()].filter((r) => r.state === 'running' && at - r.lastDeliveryAt >= limit && r.busyUntil <= at);
  }
}
