/**
 * peerHomebaseBackfill — give an ALREADY-paired peer its homebase topic.
 *
 * Spec: docs/specs/peer-conversation-homebase-topic.md (§6 originally cut the backfill).
 *
 * Creation used to fire only from the pairing-confirm route, at the moment a pairing became
 * mutual-verified. A peer paired before the feature shipped (`pp`, paired 2026-10-21, a day
 * before the code merged) therefore never got one and never would. Two triggers close that:
 *
 *  - `onContact(peer)` — called from the canonical thread-log funnel on every inbound or
 *    outbound A2A message. A mutual-verified peer with no recorded homebase gets one.
 *  - `sweep()` — every mutual-verified profile at once (kept for callers and tests; the
 *    server's boot pass is `backfillPeerHomebases` in peerHomebase.ts, which also renames
 *    legacy-named topics).
 *
 * Both go through `ensurePeerHomebase`, so the discipline is unchanged: create-once (the
 * recorded id wins, then find-or-create by name), lease holder only, best-effort and never
 * throwing into the caller. A failed creation waits `retryAfterFailureMs` before the next
 * attempt for that peer, so a Telegram outage cannot turn every message into an API call.
 */

import { ensurePeerHomebase, type EnsureHomebaseDeps, type EnsureHomebaseResult } from './peerHomebase.js';

export interface BackfillPeer {
  fingerprint: string;
  name: string;
}

export interface PeerHomebaseBackfillDeps {
  /** Read live, so a config edit takes effect without a restart. */
  enabled: () => boolean;
  /** Read live: the lease can move after boot. */
  holdsLease: () => boolean;
  /** A mutual-verified peer for this name or fingerprint, or null for anyone else. */
  resolveMutualVerified: (nameOrFingerprint: string) => BackfillPeer | null;
  /** Every mutual-verified peer (the sweep's input). */
  listMutualVerified: () => BackfillPeer[];
  findOrCreateTopic: EnsureHomebaseDeps['findOrCreateTopic'];
  getRecorded: EnsureHomebaseDeps['getRecorded'];
  record: EnsureHomebaseDeps['record'];
  /** Forwarded so a contact-time creation names and adopts topics exactly as the boot pass does. */
  findTopicByName?: EnsureHomebaseDeps['findTopicByName'];
  renameTopic?: EnsureHomebaseDeps['renameTopic'];
  nameCollides?: EnsureHomebaseDeps['nameCollides'];
  log?: (msg: string) => void;
  /** Quiet period after a failed attempt for one peer. Default 10 minutes. */
  retryAfterFailureMs?: number;
  now?: () => number;
}

export class PeerHomebaseBackfill {
  private readonly d: PeerHomebaseBackfillDeps;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<EnsureHomebaseResult>>();
  private readonly failedAt = new Map<string, number>();

  constructor(deps: PeerHomebaseBackfillDeps) {
    this.d = deps;
    this.retryMs = deps.retryAfterFailureMs ?? 10 * 60_000;
    this.now = deps.now ?? Date.now;
  }

  /** Fire-and-forget hook for the message funnel. Never throws, never blocks the caller. */
  onContact(nameOrFingerprint: string | undefined): void {
    if (!nameOrFingerprint) return;
    void this.ensureFor(nameOrFingerprint).catch(() => { /* @silent-fallback-ok — ensureFor already logs; a homebase must never affect delivery */ });
  }

  /** Ensure every mutual-verified peer has a homebase. Sequential: one topic at a time. */
  async sweep(): Promise<Array<{ fingerprint: string; result: EnsureHomebaseResult | null }>> {
    const out: Array<{ fingerprint: string; result: EnsureHomebaseResult | null }> = [];
    let peers: BackfillPeer[] = [];
    try { peers = this.d.listMutualVerified(); } catch (err) {
      this.d.log?.(`[homebase-backfill] sweep could not list peers: ${err instanceof Error ? err.message : String(err)}`);
      return out;
    }
    for (const p of peers) out.push({ fingerprint: p.fingerprint, result: await this.ensureFor(p.fingerprint) });
    return out;
  }

  /** The cheap checks run before anything touches Telegram; null means "nothing to do". */
  async ensureFor(nameOrFingerprint: string): Promise<EnsureHomebaseResult | null> {
    try {
      if (!this.d.enabled() || !this.d.holdsLease()) return null;
      const peer = this.d.resolveMutualVerified(nameOrFingerprint);
      if (!peer) return null;
      if (typeof this.d.getRecorded(peer.fingerprint) === 'number') return null;
      const last = this.failedAt.get(peer.fingerprint);
      if (last !== undefined && this.now() - last < this.retryMs) return null;

      const running = this.inFlight.get(peer.fingerprint);
      if (running) return await running;
      const p = ensurePeerHomebase(peer.fingerprint, peer.name, {
        enabled: true,
        holdsLease: true,
        findOrCreateTopic: this.d.findOrCreateTopic,
        getRecorded: this.d.getRecorded,
        record: this.d.record,
        findTopicByName: this.d.findTopicByName,
        renameTopic: this.d.renameTopic,
        nameCollides: this.d.nameCollides,
        log: this.d.log,
      });
      this.inFlight.set(peer.fingerprint, p);
      try {
        const result = await p;
        if (result.created) {
          this.failedAt.delete(peer.fingerprint);
          this.d.log?.(`[homebase-backfill] ${peer.name} (${peer.fingerprint.slice(0, 12)}) → topic ${result.topicId}${result.reused ? ' (existing topic reused)' : ' (created)'}`);
        } else if (result.reason === 'create-failed' || result.reason === 'record-refused') {
          this.failedAt.set(peer.fingerprint, this.now());
        }
        return result;
      } finally {
        this.inFlight.delete(peer.fingerprint);
      }
    } catch (err) {
      this.d.log?.(`[homebase-backfill] skipped for ${nameOrFingerprint.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}

/** The slice of `ThreadMessageRecorder` the contact hook needs. */
interface RecordsLegs {
  record(input: { peerFingerprint?: string }): { status: string };
}

/**
 * Hang `onContact` off the canonical thread-log funnel: every NEW leg (inbound or outbound)
 * with a known peer triggers it after the append. Wrapping from here, rather than adding a
 * dependency inside the recorder, leaves the canonical store's producer untouched — this is a
 * consumer of "a message happened", not a change to what is recorded. The callback is
 * fire-and-forget and a throw is swallowed, so it can never affect recording or delivery.
 */
export function attachPeerContactHook<R extends RecordsLegs>(recorder: R, onContact: (peer: string) => void): R {
  const recordLeg = recorder.record.bind(recorder) as R['record'];
  recorder.record = ((input: Parameters<R['record']>[0]) => {
    const result = recordLeg(input);
    if (result.status === 'appended' && input.peerFingerprint) {
      try { onContact(input.peerFingerprint); } catch { /* @silent-fallback-ok — a contact hook must never affect recording */ }
    }
    return result;
  }) as R['record'];
  return recorder;
}
