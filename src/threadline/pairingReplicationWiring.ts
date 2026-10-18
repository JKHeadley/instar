/**
 * Replicated-pairing inheritance on merge (docs/specs/threadline-standalone-pairing.md
 * D9/D11, rollout step 5b).
 *
 * Another of this agent's machines may become the relay holder. For encrypt-to-pinned to
 * hold there, it needs the SAME pin and the SAME method. This module is the merge half:
 * whenever pairing records are committed into this machine's replicated view (and once at
 * startup), it reads the merged view, evaluates each peer with
 * `evaluateInheritedVerification`, and calls `AgentTrustManager.inheritReplicatedVerification`
 * with the evaluated pin and method. It also runs the one-time upgrade migration that
 * re-sends local invite pairings so their method replicates.
 *
 * Gate: everything here runs ONLY when `multiMachine.stateSync.threadlinePairing.enabled`
 * is explicitly true (the same check that attaches the sender). Default false ⇒ nothing is
 * read, inherited or re-sent.
 *
 * Local authority wins. Inheritance is NOT attempted when this machine already holds its own
 * decision for the peer: a local `mutual-verified` pin (never swapped, never downgraded from
 * here), a local `verification-failed`, or a local `invite-accepted` (which is also how a
 * paused invite pairing looks). A local `pending-verification` live handshake is evaluated
 * with its own key as the presented key; a different replicated key is refused without
 * touching the profile.
 */

import {
  THREADLINE_PAIRING_RECORD_KIND,
  THREADLINE_PAIRING_STORE_KEY,
  addPairingMethodWitnesses,
  deriveThreadlinePairingRecordKey,
  evaluateInheritedVerification,
  mergeUnionToPairings,
  threadlinePairingTierOf,
  type MergedPairingView,
} from '../core/ThreadlinePairingReplicatedStore.js';
import { ReplicatedStoreReader } from '../core/ReplicatedStoreReader.js';
import type { ReplicatedKindRegistry, StateSyncStores } from '../core/ReplicatedRecordEnvelope.js';
import type { OriginRecord } from '../core/UnionReader.js';
import type { ConflictStore } from '../core/ConflictStore.js';
import type { DroppedOriginRegistry } from '../core/RollbackUnmerge.js';
import type { AgentTrustManager, AgentTrustProfile } from './AgentTrustManager.js';

/**
 * The read side the wiring needs, built over the replicated peer-stream reader (own +
 * peer journal streams). `readViews` is the no-clobber union (dropped origins excluded,
 * HIGH-impact conflicts recorded) plus method witnesses; `alreadyPublishedInvite` answers
 * from THIS machine's own stream (the migration's idempotency marker).
 */
export function buildPairingViewSource(deps: {
  registry: ReplicatedKindRegistry;
  stores: StateSyncStores | undefined;
  streams: {
    loadOriginRecords(store: string, recordKey: string): OriginRecord[];
    listRecordKeys(store: string): string[];
  };
  droppedOrigins: DroppedOriginRegistry;
  conflictStore: ConflictStore;
  ownOrigin: string;
}): { readViews: () => MergedPairingView[]; alreadyPublishedInvite: (peerFp: string, peerIdentityPub: string) => boolean } {
  const union = new ReplicatedStoreReader({
    registry: deps.registry,
    stores: deps.stores,
    tierOf: threadlinePairingTierOf,
    loadOriginRecords: (store, recordKey) => deps.streams.loadOriginRecords(store, recordKey),
    listRecordKeys: (store) => deps.streams.listRecordKeys(store),
    droppedOrigins: deps.droppedOrigins,
    conflictStore: deps.conflictStore,
  });
  return {
    readViews: () => addPairingMethodWitnesses(
      mergeUnionToPairings(union.readAll(THREADLINE_PAIRING_STORE_KEY)),
      (recordKey) => deps.streams.loadOriginRecords(THREADLINE_PAIRING_STORE_KEY, recordKey),
      deps.droppedOrigins.droppedOrigins(THREADLINE_PAIRING_STORE_KEY),
    ),
    alreadyPublishedInvite: (peerFp, peerIdentityPub) => {
      const rk = deriveThreadlinePairingRecordKey(peerFp);
      if (!rk) return false;
      const own = deps.streams.loadOriginRecords(THREADLINE_PAIRING_STORE_KEY, rk).find((r) => r.origin === deps.ownOrigin);
      return !!own && own.envelope.op === 'put' && own.data.pairingMethod === 'invite'
        && typeof own.data.peerIdentityPub === 'string'
        && own.data.peerIdentityPub.toLowerCase() === peerIdentityPub.toLowerCase();
    },
  };
}

/** The explicit replication gate (the same check server.ts uses to attach the sender). */
export function isThreadlinePairingReplicationEnabled(config: {
  multiMachine?: { stateSync?: unknown };
} | undefined): boolean {
  const ss = config?.multiMachine?.stateSync as { threadlinePairing?: { enabled?: unknown } } | undefined;
  return ss?.threadlinePairing?.enabled === true;
}

export type InheritanceTrust = Pick<AgentTrustManager, 'getProfileByFingerprint' | 'inheritReplicatedVerification'>;

export interface InheritanceSummary {
  /** Peers evaluated (distinct fingerprints in the view). */
  peers: number;
  /** inheritReplicatedVerification returned true. */
  inherited: number;
  /** Already inherited with the same key and method — nothing to write. */
  unchanged: number;
  /** A local decision exists for the peer (see module doc) — not attempted. */
  localWins: number;
  /** evaluateInheritedVerification refused (key mismatch / ambiguous keys / no record). */
  refused: number;
}

/** Local pairing states that are THIS machine's own decision and are never overridden here. */
const LOCAL_AUTHORITY_STATES = new Set(['mutual-verified', 'verification-failed', 'invite-accepted']);

/**
 * Apply the merged replicated view to the trust manager. PURE apart from the trust manager
 * calls. Idempotent: an already-inherited profile with the same pin and the same resulting
 * method is left untouched (no rewrite, no audit line).
 */
export function applyReplicatedPairingInheritance(
  views: ReadonlyArray<MergedPairingView>,
  trust: InheritanceTrust,
): InheritanceSummary {
  const summary: InheritanceSummary = { peers: 0, inherited: 0, unchanged: 0, localWins: 0, refused: 0 };
  const fps = new Set<string>();
  for (const v of views) {
    if (typeof v.data.peerFp === 'string' && v.data.peerFp.length > 0) fps.add(v.data.peerFp.toLowerCase());
  }
  for (const fp of fps) {
    summary.peers++;
    const local: AgentTrustProfile | null = trust.getProfileByFingerprint(fp);
    if (local?.pairingState && LOCAL_AUTHORITY_STATES.has(local.pairingState)) {
      summary.localWins++;
      continue;
    }
    const presented = local?.pairingState === 'pending-verification' ? local.peerIdentityPub : undefined;
    const decision = evaluateInheritedVerification(views, fp, presented);
    if (!decision.honor) {
      summary.refused++;
      continue;
    }
    const method = decision.pairingMethodKnown ? decision.pairingMethod : undefined;
    if (
      local?.pairingState === 'identity-verified' &&
      local.peerIdentityPub?.toLowerCase() === decision.pinnedKey.toLowerCase() &&
      (local.pairingMethod === (method ?? 'inherited') || local.pairingMethod === 'invite')
    ) {
      // Same pin; the method is unchanged, or already 'invite' (never downgraded).
      summary.unchanged++;
      continue;
    }
    const ok = trust.inheritReplicatedVerification(fp, {
      peerIdentityPub: decision.pinnedKey,
      verifiedAt: decision.verifiedAt,
      verifiedOnMachine: decision.verifiedOnMachine,
      ...(presented ? { presentedIdentityPub: presented } : {}),
      ...(method ? { pairingMethod: method } : {}),
    });
    if (ok) summary.inherited++;
    else summary.refused++;
  }
  return summary;
}

export interface PairingReplicationWiringDeps {
  /** The live config (gate read once at construction). */
  config: { multiMachine?: { stateSync?: unknown } } | undefined;
  trust: InheritanceTrust & Pick<AgentTrustManager, 'republishInvitePairingMethods'>;
  /** The merged replicated view (union + method witnesses). */
  readViews: () => MergedPairingView[];
  /** Does THIS machine's own replicated stream already hold an 'invite' record for this
   *  peer and key? (the migration's idempotency marker) */
  alreadyPublishedInvite: (peerFp: string, peerIdentityPub: string) => boolean;
  log?: (msg: string) => void;
}

export interface PairingReplicationWiring {
  /** Run on startup: the upgrade migration, then one inheritance pass. */
  start(): { republished: number; inheritance: InheritanceSummary };
  /** The journal commit observer hook: re-run inheritance when pairing records land. */
  onRecordsCommitted(kind: string): InheritanceSummary | null;
  /** One inheritance pass. */
  applyNow(): InheritanceSummary;
}

/**
 * Build the wiring, or null when the replication gate is off (the strict no-op default).
 * A failure inside a pass is logged and swallowed: replication never breaks the server.
 */
export function createPairingReplicationWiring(deps: PairingReplicationWiringDeps): PairingReplicationWiring | null {
  if (!isThreadlinePairingReplicationEnabled(deps.config)) return null;
  const log = deps.log ?? (() => {});
  const empty = (): InheritanceSummary => ({ peers: 0, inherited: 0, unchanged: 0, localWins: 0, refused: 0 });
  const applyNow = (): InheritanceSummary => {
    try {
      const s = applyReplicatedPairingInheritance(deps.readViews(), deps.trust);
      if (s.inherited > 0 || s.refused > 0) log(`pairing inheritance: ${JSON.stringify(s)}`);
      return s;
    } catch (err) {
      log(`pairing inheritance failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return empty();
    }
  };
  return {
    start() {
      let republished = 0;
      try {
        republished = deps.trust.republishInvitePairingMethods(deps.alreadyPublishedInvite);
        if (republished > 0) log(`re-sent ${republished} invite pairing record(s) with pairingMethod`);
      } catch (err) {
        log(`pairing method migration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
      return { republished, inheritance: applyNow() };
    },
    onRecordsCommitted(kind) {
      if (kind !== THREADLINE_PAIRING_RECORD_KIND) return null;
      return applyNow();
    },
    applyNow,
  };
}

/**
 * The startup note for item 7: enforce encrypt-to-pinned on a multi-machine agent needs
 * pairing replication, or a machine that takes over the relay has no pin and no method.
 * Returns the line to log, or null when it does not apply.
 */
export function encryptToPinnedMultiMachineNote(args: {
  encryptToPinnedMode: 'off' | 'watch' | 'enforce';
  activeMachineCount: number;
  pairingReplicationEnabled: boolean;
}): string | null {
  if (args.encryptToPinnedMode !== 'enforce' || args.activeMachineCount < 2 || args.pairingReplicationEnabled) return null;
  return `threadline.encryptToPinned is enforce on a ${args.activeMachineCount}-machine agent, but multiMachine.stateSync.threadlinePairing.enabled is off: another machine that takes the relay has no inherited pin, so invite peers get the older rule there (spec threadline-standalone-pairing D9, rollout step 5b).`;
}
