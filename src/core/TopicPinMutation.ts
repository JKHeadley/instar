/**
 * TopicPinMutation — the ONE-HLC pin mutation funnel (U4.1 §2B,
 * docs/specs/u4-1-pin-persistence.md).
 *
 * THE CONTRACT (R-r2): every pin mutation mints ONE HLC and stamps BOTH the
 * local `TopicPlacementPinStore.set()/clear()` AND the replicated journal
 * emit (`buildTopicPinPut` / `buildTopicPinTombstone`) with that same stamp.
 * The transfer route previously called `set()` WITHOUT the `hlc` argument
 * (the routes.ts gap) — the local-vs-replicated comparison then degraded to a
 * derived wall-clock and HLC-highest-wins was a symbol, not the state.
 *
 * UNPIN (fixes defect 2 — the live un-pin propagation bug): `clearPin` wires
 * the previously ZERO-caller `buildTopicPinTombstone` at the clear()
 * chokepoint, so a cleared pin can never be resurrected by a stale replicated
 * PUT (`effectivePins()` / the fold honor tombstones by HLC order). A later
 * re-pin is the same key with a newer HLC — the store's documented model.
 *
 * The emitter mints the HLC (its `clock.tick()` is the author-side authority);
 * the funnel CAPTURES the minted stamp from inside the build closure and hands
 * it to the local store. When emission is dark (`ws13PinReplicate` off /
 * single-machine) the build closure never runs → no stamp is minted → the
 * local write proceeds without one (today's exact behavior; the reconciler's
 * documented `updatedAt` fallback derivation covers it).
 */

import type { HlcTimestamp } from './HybridLogicalClock.js';
import type { TopicPlacementPinStore, TopicPinnedBy } from './TopicPlacementPinStore.js';
import {
  TOPIC_PIN_STORE_KEY,
  deriveTopicPinRecordKey,
  buildTopicPinPut,
  buildTopicPinTombstone,
} from './TopicPinReplicatedStore.js';

/** The emitter seam (ReplicatedRecordEmitter.emit — synchronous, never throws). */
export interface PinMutationEmitter {
  emit(
    store: string,
    recordKey: string | null | undefined,
    build: (hlc: HlcTimestamp, origin: string, observed: HlcTimestamp | undefined) => Record<string, unknown> | null,
  ): void;
}

export interface PinMutationDeps {
  pinStore: TopicPlacementPinStore;
  /** Absent/null ⇒ replication un-wired (single-machine / early boot) — local-only write. */
  emitter?: PinMutationEmitter | null;
  now?: () => Date;
}

/** Pin a topic to a machine: ONE HLC stamps both the journal PUT and the local set(). */
export function setPinWithOneHlc(
  deps: PinMutationDeps,
  sessionKey: string,
  preferredMachine: string,
  pinned = true,
  pinnedBy?: TopicPinnedBy,
): { hlc?: HlcTimestamp } {
  const topicNum = Number(sessionKey);
  let minted: HlcTimestamp | undefined;
  if (deps.emitter && Number.isFinite(topicNum)) {
    const recordKey = deriveTopicPinRecordKey(topicNum);
    if (recordKey) {
      const build = buildTopicPinPut(topicNum, preferredMachine, pinned);
      deps.emitter.emit(TOPIC_PIN_STORE_KEY, recordKey, (hlc, origin, observed) => {
        const data = build(hlc, origin, observed);
        if (data !== null) minted = hlc; // capture ONLY a stamp that actually rode a record
        return data;
      });
    }
  }
  deps.pinStore.set(sessionKey, preferredMachine, pinned, minted, pinnedBy);
  return minted !== undefined ? { hlc: minted } : {};
}

/** Unpin a topic: the tombstone rides the SAME stamp the local clear is ordered by. */
export function clearPinWithTombstone(
  deps: PinMutationDeps,
  sessionKey: string,
): { hadPin: boolean; hlc?: HlcTimestamp } {
  const hadPin = deps.pinStore.get(sessionKey) !== null;
  const topicNum = Number(sessionKey);
  let minted: HlcTimestamp | undefined;
  if (deps.emitter && Number.isFinite(topicNum)) {
    const recordKey = deriveTopicPinRecordKey(topicNum);
    if (recordKey) {
      const deletedAt = (deps.now ?? (() => new Date()))().toISOString();
      const build = buildTopicPinTombstone(topicNum, deletedAt);
      deps.emitter.emit(TOPIC_PIN_STORE_KEY, recordKey, (hlc, origin, observed) => {
        const data = build(hlc, origin, observed);
        if (data !== null) minted = hlc;
        return data;
      });
    }
  }
  deps.pinStore.clear(sessionKey);
  return minted !== undefined ? { hadPin, hlc: minted } : { hadPin };
}
