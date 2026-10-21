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
 *
 * Revokes: a tombstone in force for a peer (the union resolved to it, or an open conflict
 * includes it) FORGETS the INHERITED (`identity-verified`) profile pinned to the revoked key
 * (AgentTrustManager.revokeInheritedVerification). A locally established pairing and a pin
 * to a different key are never touched; a newer put for the key wins over an older revoke
 * through the union's own ordering, and is then inherited again.
 *
 * The encryptedSeen mark (rollout step 6, D6/D11): each machine writes its own mark record when
 * it first receives encrypted ordinary chat from an invite peer, and an unpair record when the
 * person unpairs there. Every pass folds the UNIFIED mark (threadline-core's union keeping the
 * earliest time, voided by a later unpair) into each pinned profile with the same key, after
 * inheritance, so a machine that takes over the relay refuses the same downgrades.
 *
 * `attachThreadlinePairingReplication` holds ALL of the server's wiring (sender adapters,
 * read side, merge wiring, startup pass); server.ts calls it and forwards the journal
 * applier's commit observer to `onRecordsCommitted`.
 */

import {
  THREADLINE_PAIRING_RECORD_KIND,
  THREADLINE_PAIRING_STORE_KEY,
  addPairingMethodWitnesses,
  buildThreadlinePairingRecordData,
  buildThreadlinePairingTombstoneData,
  deriveThreadlinePairingRecordKey,
  buildEncryptedSeenRecordData,
  deriveEncryptedSeenRecordKey,
  encryptedSeenEventsFromUnion,
  encryptedSeenOrder,
  revokedPairings,
  type PairingRevocation,
  evaluateInheritedVerification,
  mergeUnionToPairings,
  threadlinePairingTierOf,
  type MergedPairingView,
} from '../core/ThreadlinePairingReplicatedStore.js';
import { ReplicatedStoreReader } from '../core/ReplicatedStoreReader.js';
import type { ReplicatedKindRegistry, StateSyncStores } from '../core/ReplicatedRecordEnvelope.js';
import type { OriginRecord } from '../core/UnionReader.js';
import type { BuildRecordData } from '../core/ReplicatedRecordEmitter.js';
import type { ConflictStore } from '../core/ConflictStore.js';
import type { DroppedOriginRegistry } from '../core/RollbackUnmerge.js';
import type { AgentTrustManager, AgentTrustProfile } from './AgentTrustManager.js';
import { unifyEncryptedSeen, type EncryptedSeenEvent } from './encryptedSeenMark.js';
import type { HlcTimestamp } from '../core/HybridLogicalClock.js';

/** What one merge pass reads: the honourable views and the revokes in force. */
export interface PairingReplicatedState {
  views: MergedPairingView[];
  revoked: ReadonlyMap<string, PairingRevocation>;
  /** Step 6: every machine's encryptedSeen mark/unpair records, by peer fingerprint. */
  marks?: ReadonlyMap<string, EncryptedSeenEvent<HlcTimestamp>[]>;
}

/**
 * The read side the wiring needs, built over the replicated peer-stream reader (own +
 * peer journal streams). `readState` reads the no-clobber union once (dropped origins
 * excluded, HIGH-impact conflicts recorded) and returns the views plus method witnesses
 * and the revokes in force; `alreadyPublishedInvite` answers from THIS machine's own
 * stream (the migration's idempotency marker).
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
}): { readState: () => PairingReplicatedState; alreadyPublishedInvite: (peerFp: string, peerIdentityPub: string) => boolean } {
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
    readState: () => {
      const all = union.readAll(THREADLINE_PAIRING_STORE_KEY);
      const load = (recordKey: string) => deps.streams.loadOriginRecords(THREADLINE_PAIRING_STORE_KEY, recordKey);
      const dropped = deps.droppedOrigins.droppedOrigins(THREADLINE_PAIRING_STORE_KEY);
      return {
        views: addPairingMethodWitnesses(mergeUnionToPairings(all), load, dropped),
        revoked: revokedPairings(all, load, dropped),
        marks: encryptedSeenEventsFromUnion(all),
      };
    },
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

export type InheritanceTrust = Pick<
  AgentTrustManager,
  'getProfileByFingerprint' | 'inheritReplicatedVerification' | 'listProfiles' | 'revokeInheritedVerification'
> & Partial<Pick<AgentTrustManager, 'mergeEncryptedSeen'>>;

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
  /** Inherited profiles forgotten because a revoke for their key is in force. */
  revoked: number;
  /** Peers with a revoke in force whose put variants were NOT inherited (fail closed). */
  revokeHeld: number;
  /** Step 6: pinned profiles whose encryptedSeen mark was set or moved earlier by the union. */
  marksMerged: number;
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
  revoked: ReadonlyMap<string, PairingRevocation> = new Map(),
  marks: ReadonlyMap<string, EncryptedSeenEvent<HlcTimestamp>[]> = new Map(),
): InheritanceSummary {
  const summary: InheritanceSummary = { peers: 0, inherited: 0, unchanged: 0, localWins: 0, refused: 0, revoked: 0, revokeHeld: 0, marksMerged: 0 };

  // 1. Revokes first. Only INHERITED profiles (identity-verified — the state only
  //    inheritance sets); revokeInheritedVerification enforces that and the key match.
  if (revoked.size > 0) {
    for (const profile of trust.listProfiles()) {
      if (profile.pairingState !== 'identity-verified' || !profile.fingerprint) continue;
      const rk = deriveThreadlinePairingRecordKey(profile.fingerprint);
      const revoke = rk ? revoked.get(rk) : undefined;
      if (revoke && trust.revokeInheritedVerification(profile.fingerprint, revoke)) summary.revoked++;
    }
  }

  // 2. Inheritance for peers whose records are not revoked.
  const fps = new Set<string>();
  for (const v of views) {
    if (typeof v.data.peerFp === 'string' && v.data.peerFp.length > 0) fps.add(v.data.peerFp.toLowerCase());
  }
  for (const fp of fps) {
    summary.peers++;
    const rk = deriveThreadlinePairingRecordKey(fp);
    if (rk && revoked.has(rk)) {
      summary.revokeHeld++;
      continue;
    }
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

  // 3. The unified encryptedSeen mark (step 6), AFTER inheritance so a pin inherited in this
  //    pass gets its mark in the same pass. Only into a profile pinned to the SAME key; a mark
  //    is only ever set or moved earlier here, never cleared (clearing is the unpair's job).
  if (trust.mergeEncryptedSeen) {
    for (const [fp, events] of marks) {
      const profile = trust.getProfileByFingerprint(fp);
      const key = profile?.peerIdentityPub?.toLowerCase();
      if (!key) continue;
      const at = unifyEncryptedSeen(events, key, encryptedSeenOrder);
      if (at && trust.mergeEncryptedSeen(fp, key, at)) summary.marksMerged++;
    }
  }
  return summary;
}

export interface PairingReplicationWiringDeps {
  /** The live config (gate read once at construction). */
  config: { multiMachine?: { stateSync?: unknown } } | undefined;
  trust: InheritanceTrust & Pick<AgentTrustManager, 'republishInvitePairingMethods'>;
  /** The merged replicated view (union + method witnesses) and the revokes in force. */
  readState: () => PairingReplicatedState;
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
  const empty = (): InheritanceSummary => ({ peers: 0, inherited: 0, unchanged: 0, localWins: 0, refused: 0, revoked: 0, revokeHeld: 0, marksMerged: 0 });
  const applyNow = (): InheritanceSummary => {
    try {
      const state = deps.readState();
      const s = applyReplicatedPairingInheritance(state.views, deps.trust, state.revoked, state.marks);
      if (s.inherited > 0 || s.refused > 0 || s.revoked > 0 || s.marksMerged > 0) log(`pairing inheritance: ${JSON.stringify(s)}`);
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

/** The journal-backed emitter the sender adapters use (ReplicatedRecordEmitter). */
export interface PairingRecordEmitter {
  emit(store: string, recordKey: string | null | undefined, build: BuildRecordData): void;
}

/**
 * Everything server.ts wires for the pairing store, behind the explicit gate. Attaches the
 * SENDER (verified results carry the method; revokes carry the key) to the trust manager,
 * builds the read side over the replicated streams, creates the merge wiring and runs its
 * startup pass (migration, then one inheritance/revoke pass). Returns the wiring whose
 * `onRecordsCommitted` the journal applier's commit observer must call, or null with the
 * gate off (nothing attached — strict no-op).
 */
export function attachThreadlinePairingReplication(deps: {
  config: { multiMachine?: { stateSync?: unknown } } | undefined;
  trust: InheritanceTrust & Pick<AgentTrustManager, 'republishInvitePairingMethods' | 'setPairingReplicationEmitter'>;
  emitter: PairingRecordEmitter;
  ownOrigin: string;
  registry: ReplicatedKindRegistry;
  stores: StateSyncStores | undefined;
  streams: {
    loadOriginRecords(store: string, recordKey: string): OriginRecord[];
    listRecordKeys(store: string): string[];
  };
  droppedOrigins: DroppedOriginRegistry;
  conflictStore: ConflictStore;
  log?: (msg: string) => void;
}): PairingReplicationWiring | null {
  if (!isThreadlinePairingReplicationEnabled(deps.config)) return null;
  const emitter = deps.emitter;
  deps.trust.setPairingReplicationEmitter(
    {
      emitVerified: (result) =>
        emitter.emit(
          THREADLINE_PAIRING_STORE_KEY,
          deriveThreadlinePairingRecordKey(result.peerFp),
          (hlc, origin, observed) =>
            buildThreadlinePairingRecordData({ result: { ...result, state: 'mutual-verified' }, hlc, origin, observed }),
        ),
      emitRevoke: (peerFp, deletedAt, peerIdentityPub) =>
        emitter.emit(
          THREADLINE_PAIRING_STORE_KEY,
          deriveThreadlinePairingRecordKey(peerFp),
          (hlc, origin, observed) =>
            buildThreadlinePairingTombstoneData({ peerFp, hlc, origin, deletedAt, observed, peerIdentityPub }),
        ),
      // Step 6: this machine's own mark / unpair record for the peer (one recordKey per origin).
      emitEncryptedSeen: (peerFp, peerIdentityPub, at) =>
        emitter.emit(
          THREADLINE_PAIRING_STORE_KEY,
          deriveEncryptedSeenRecordKey(peerFp, deps.ownOrigin),
          (hlc, origin, observed) =>
            buildEncryptedSeenRecordData({ peerFp, peerIdentityPub, kind: 'seen', at, hlc, origin, observed }),
        ),
      emitEncryptedSeenUnpaired: (peerFp, peerIdentityPub, at) =>
        emitter.emit(
          THREADLINE_PAIRING_STORE_KEY,
          deriveEncryptedSeenRecordKey(peerFp, deps.ownOrigin),
          (hlc, origin, observed) =>
            buildEncryptedSeenRecordData({ peerFp, peerIdentityPub, kind: 'unpaired', at, hlc, origin, observed }),
        ),
    },
    deps.ownOrigin,
  );
  const source = buildPairingViewSource(deps);
  const wiring = createPairingReplicationWiring({
    config: deps.config,
    trust: deps.trust,
    readState: source.readState,
    alreadyPublishedInvite: source.alreadyPublishedInvite,
    log: deps.log,
  });
  const started = wiring?.start();
  if (started) {
    deps.log?.(`replication merge wired (re-sent ${started.republished}, inherited ${started.inheritance.inherited}, revoked ${started.inheritance.revoked}, peers ${started.inheritance.peers})`);
  }
  return wiring;
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
  return `threadline.encryptToPinned is enforce on a ${args.activeMachineCount}-machine agent, but multiMachine.stateSync.threadlinePairing.enabled is off: another machine that takes the relay has no inherited pin, so invite peers get the older rule there (encrypted only when the relay supplied their keys). This machine still always encrypts to them. Turn pairing replication on so every machine does (spec threadline-standalone-pairing D9, rollout step 5b).`;
}
