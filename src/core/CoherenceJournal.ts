/**
 * CoherenceJournal — per-machine, per-kind append-only event streams
 * (P1.1 of multi-machine coherence).
 *
 * Spec: docs/specs/COHERENCE-JOURNAL-SPEC.md §3.1 (writer rules), §3.2 (typed
 * schemas), §3.7 (per-kind retention).
 *
 * This class is ONLY the writer + a minimal tolerant reader for the read API
 * (built later). It performs its OWN file I/O — it is not a StateManager
 * method — so the standby read-only guard is an injected seam
 * (`guardWrite?: (path) => void`); another workstream wires the real
 * `StateManager.guardJournalWrite` entrypoint into it.
 *
 * The load-bearing safety rule (§3.1): emit() is a NON-BLOCKING memory
 * operation. It validates + enqueues + returns in microseconds; a background
 * flusher drains the queue with single-line O_APPEND writes and batched
 * fdatasync on a cadence (default 250ms). NO synchronous I/O ever runs in a
 * caller's stack — the host has a documented event-loop-starvation history and
 * a blocking fsync at a placement/session/autonomous code path would reproduce
 * the originating incident class.
 *
 * Crash-safe meta ordering (§3.4 rule 3): data lines are appended +
 * fdatasync'd FIRST, then `meta.highWaterSeq` is advanced via atomic temp-file
 * rename — so `durable_tail >= highWaterSeq` holds at every instant, including
 * a kill-9 between the two steps. The incarnation token is re-minted IFF on
 * open the file's last seq is strictly below `meta.highWaterSeq` (a genuine
 * rewind / restore-from-backup); a trailing-partial-line repair is NEVER a
 * re-mint.
 *
 * The journal subsystem never emits journal events about itself.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { coerceHlc, serializeHlcKey } from './HybridLogicalClock.js';
import {
  validateReplicatedEnvelope,
  type ReplicatedKindRegistry,
  type EnvelopeValidationCounters,
} from './ReplicatedRecordEnvelope.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export type JournalKind = 'topic-placement' | 'session-lifecycle' | 'autonomous-run' | 'threadline-conversation' | 'guard-latch' | 'pref-record' | 'relationship-record' | 'learning-record' | 'knowledge-record' | 'evolution-action-record' | 'user-record' | 'topic-operator-record' | 'threadline-pairing-record' | 'subscription-account-meta' | 'topic-pin-record' | 'topic-claim-annotation' | 'working-set-artifact' | 'class-review-record';

export const JOURNAL_KINDS: JournalKind[] = ['topic-placement', 'session-lifecycle', 'autonomous-run', 'threadline-conversation', 'guard-latch', 'pref-record', 'relationship-record', 'learning-record', 'knowledge-record', 'evolution-action-record', 'user-record', 'topic-operator-record', 'threadline-pairing-record', 'subscription-account-meta', 'topic-pin-record', 'topic-claim-annotation', 'working-set-artifact', 'class-review-record'];
// 'subscription-account-meta' added for WS5.2 Account Follow-Me §6.1a (registry follow-me =
// METADATA ONLY): a redacted, credential-free projection of a SubscriptionAccount (id, nickname,
// email, provider, framework, status, quota) replicates so a peer KNOWS an account's depth/quota
// WITHOUT holding its login. configHome + every credential field are STRIPPED (never on the wire).
// Schema + strict whitelist/clamps live in SubscriptionAccountMetaReplicatedStore.ts; it rides the
// modern ReplicatedKindRegistry path (validated by both CoherenceJournal.validate() and
// JournalSyncApplier.validateData via the registry). Ships DARK behind multiMachine.accountFollowMe.
// 'threadline-pairing-record' added for Secure A2A Verified Pairing §3.8 (FD11): the EIGHTH
// replicated-store consumer. Unlike the WS2 memory/PII stores it replicates ONLY the verified-
// IDENTITY RESULT of a pairing { peerFp, peerIdentityPub, state:'mutual-verified', verifiedAt,
// verifiedOnMachine } — NEVER the SAS words, shared secret, or relay token (those are bound to the
// machine-local handshake's ephemeral secret and stay machine-local BY DESIGN). Like the other kinds
// it is the STATIC half of the DUAL REGISTRY — a kind in ReplicatedKindRegistry but NOT here would
// advertise stateSyncReceive=true yet serve/apply/pull NOTHING. Its schema (discriminated union on
// `op` for value + tombstone; state MUST equal 'mutual-verified'; verifiedAt ISO-8601-only;
// peerFp/peerIdentityPub hex-only), fingerprint recordKey, and consumer key-pinning honoring rule
// live in ThreadlinePairingReplicatedStore.ts. Machine B honors a replicated record ONLY by pinning
// peerIdentityPub (a mismatching handshake key is refused inheritance + downgraded to
// pending-verification); inherited = identity-verified, NOT channel-ready. A revoke/verification-failed
// propagates as a tombstone. Ships DARK behind multiMachine.stateSync.threadlinePairing
// (enabled:false, dryRun:true). Additive — readers ignore unknown kinds.
// 'user-record' + 'topic-operator-record' added for WS2.6 (multi-machine-replicated-store-foundation):
// the SIXTH + SEVENTH replicated-store consumers and the SECOND + THIRD PII kinds (after WS2.3
// relationships), completing the WS2 memory family. Like 'relationship-record' they are the STATIC
// half of the DUAL REGISTRY — a kind in ReplicatedKindRegistry but NOT here would advertise
// stateSyncReceive=true yet serve/apply/pull NOTHING (a silent no-replication). user-record's
// concrete schema (discriminated union on `op` for value + tombstone), disclosure-minimized
// projection (the local userId NEVER replicated), channel-set recordKey identity surface
// (sha256(sorted channel-set)), 64KB per-entry cap, and bounds live in UserRegistryReplicatedStore.ts;
// topic-operator-record's live in TopicOperatorReplicatedStore.ts (recordKey = sha256(topicId + ":" +
// verified-uid), NEVER a content-name). THE LOAD-BEARING SAFETY INVARIANT (topic-operator): a
// replicated topic-operator record is UNTRUSTED peer data — NEVER this machine's authoritative answer
// to "who is my verified operator?" (only the local authenticated setOperator binds the principal).
// Additive — readers ignore unknown kinds.
// 'evolution-action-record' added for WS2.5 (multi-machine-replicated-store-foundation): the
// FIFTH replicated-store consumer and the FOURTH memory-family kind, riding the same HLC
// foundation. Like 'knowledge-record' it is the STATIC half of the DUAL REGISTRY — a kind in
// ReplicatedKindRegistry but NOT here would advertise stateSyncReceive=true yet
// serve/apply/pull NOTHING (a silent no-replication). Its concrete schema (a discriminated
// union on `op` for value + tombstone), disclosure-minimized projection (the local ACT-NNN id
// NEVER replicated), content-fingerprint recordKey identity surface (normalize(title) +
// normalize(commitTo) + createdAt), 64KB per-entry cap, and bounds live in
// EvolutionActionsReplicatedStore.ts (the consumer); here it is just the kind tag the
// serve/apply/getOwnAdvert path enumerates. Additive — readers ignore unknown kinds. The
// load-bearing cross-machine field is `status`: a peer must SEE an action was already
// completed/in_progress elsewhere so it does not redo it.
// 'knowledge-record' added for WS2.4 (multi-machine-replicated-store-foundation): the
// FOURTH replicated-store consumer and the THIRD memory-family kind, riding the same HLC
// foundation. Like 'learning-record' it is the STATIC half of the DUAL REGISTRY — a kind
// in ReplicatedKindRegistry but NOT here would advertise stateSyncReceive=true yet
// serve/apply/pull NOTHING (a silent no-replication). Its concrete schema (a discriminated
// union on `op` for value + tombstone), disclosure-minimized projection (the local
// generated id + filePath NEVER replicated — only the catalog METADATA, never the file
// body), content-fingerprint recordKey identity surface (normalize(url||title) + type),
// 64KB per-entry cap, and bounds live in KnowledgeReplicatedStore.ts (the consumer); here
// it is just the kind tag the serve/apply/getOwnAdvert path enumerates. Additive — readers
// ignore unknown kinds.
// 'learning-record' added for WS2.2 (multi-machine-replicated-store-foundation): the
// THIRD replicated-store consumer and the SECOND memory-family kind, riding the same HLC
// foundation. Like 'relationship-record' it is the STATIC half of the DUAL REGISTRY — a
// kind in ReplicatedKindRegistry but NOT here would advertise stateSyncReceive=true yet
// serve/apply/pull NOTHING (a silent no-replication). Its concrete schema (a discriminated
// union on `op` for value + tombstone), disclosure-minimized projection (the local LRN-NNN
// id NEVER replicated), content-fingerprint recordKey identity surface, 64KB per-entry cap,
// and bounds live in LearningsReplicatedStore.ts (the consumer); here it is just the kind
// tag the serve/apply/getOwnAdvert path enumerates. Additive — readers ignore unknown kinds.
// 'relationship-record' added for WS2.3 (ws23-relationships-userregistry-security):
// the SECOND replicated-store consumer and the FIRST PII kind, riding the same HLC
// foundation. Like 'pref-record' it is the STATIC half of the DUAL REGISTRY — a kind
// in ReplicatedKindRegistry but NOT here would advertise stateSyncReceive=true yet
// serve/apply/pull NOTHING (a silent no-replication). Its concrete schema (a
// discriminated union on `op` for value + tombstone), disclosure-minimized projection,
// recordKey identity surface, 64KB per-entry cap, and bounds live in
// RelationshipsReplicatedStore.ts (the consumer); here it is just the kind tag the
// serve/apply/getOwnAdvert path enumerates. Additive — readers ignore unknown kinds.
// 'pref-record' added for WS2.1 (multi-machine-replicated-store-foundation §4): the
// FIRST concrete replicated-store kind, riding the HLC foundation. This is the
// STATIC half of the DUAL REGISTRY — a kind in ReplicatedKindRegistry but NOT here
// would advertise stateSyncReceive=true yet serve/apply/pull NOTHING (a silent
// no-replication, §4 callout). Its concrete schema/tier/bounds live in
// PreferencesReplicatedStore.ts (the consumer); here it is just the kind tag the
// serve/apply/getOwnAdvert path enumerates. Additive — readers ignore unknown
// kinds (the applier's forward-compat contract), so an old peer that lacks it
// simply never pulls it.

/** §3.2 enums. */
export type PlacementReason = 'user-move' | 'placed' | 'failover' | 'released' | 'quota-block-move' | 'reconcile';
// 'reconcile' added for WS1.3 (MULTI-MACHINE-SEAMLESSNESS-SPEC): the
// OwnershipReconciler's bounded pin/owner convergence CAS chain. Additive —
// readers ignore unknowns (the journal applier's forward-compat contract).
// 'failed' added at wiring time: Session records carry a real terminal
// 'failed' status the spec's §3.2 enum missed; recording it as 'completed'
// or 'killed' would misstate history. Additive — readers ignore unknowns.
export type SessionStatus = 'created' | 'completed' | 'killed' | 'reaped' | 'failed';
export type AutonomousAction = 'started' | 'stopped';
/** P3 (THREADLINE-CONVERSATION-COHERENCE-SPEC §3.1). */
export type ThreadlineConversationAction = 'started' | 'bound' | 'unbound' | 'closed';
/**
 * guard-latch (green-pr-automerge-enforcement R9/R7). A pool-visible latch or
 * marker that gates a guarded autonomous authority across the machine pool. The
 * `latchKind` namespaces independent latch families so they cannot collide; the
 * `action` is set/clear. ABSORBING ordering (set wins ties regardless of epoch)
 * is resolved by the consumer (GuardLatchStore), NOT here — the journal only
 * carries the content-free fact that a transition occurred.
 */
export type GuardLatchAction = 'set' | 'clear';

export interface PlacementData {
  owner: string;
  prevOwner?: string;
  epoch: number;
  reason: PlacementReason;
  // Cross-machine ownership-reconciler convergence (Fix #3): the cooperative-handoff
  // INTERMEDIATE state, so a `transferring(owner=S → transferTo=T)` replicates and the
  // target's applier materializes it (today only `active` crosses, so T never learns to
  // claim → the stuck-move bug). All OPTIONAL + back-compat: an absent `status` is `active`
  // (today's behavior), so an older peer that omits them is unaffected.
  status?: 'active' | 'transferring';
  /** During `transferring`: the target machine the session is moving to. */
  transferTo?: string;
  /** The PRODUCER record's `timestamp` (the field the drain-grace + convergence deadline
   *  key on — OwnershipReconciler.ts). Carried so the target derives output-exclusion +
   *  recovery timing from the origin, never re-stamped to local now. Clamped on receive. */
  timestamp?: number;
  /** Whether a SessionDrainRunner is still draining the source (drain-grace input). */
  drainInFlight?: boolean;
}

export interface SessionLifecycleData {
  sessionId: string;
  status: SessionStatus;
  reapReason?: string;
  reapLogRef?: string;
}

export interface AutonomousRunData {
  action: AutonomousAction;
  runId: string;
  artifactPaths: string[];
}

/** P3 §3.1 — content-free conversation lifecycle (no titles, no text). */
export interface ThreadlineConversationData {
  action: ThreadlineConversationAction;
  conversationId: string;
  peerFingerprint: string;
  topicId?: number;
}

/**
 * guard-latch (green-pr-automerge-enforcement R9/R7). Content-free: the latch
 * family, the set/clear action, the lease epoch + a monotonic sequence the
 * consumer uses for ordering, and a stable `latchId` so `/enable` can clear a
 * SPECIFIC latch without touching siblings. No free text (the typed-schema
 * invariant); `reason` is a short enum-like slug, length-capped.
 */
export interface GuardLatchData {
  latchKind: string;
  latchId: string;
  action: GuardLatchAction;
  epoch: number;
  seq: number;
  reason?: string;
}

/** One line in a stream file. */
export interface JournalEntry {
  seq: number;
  ts: string;
  machine: string;
  kind: JournalKind;
  topic?: number;
  data: Record<string, unknown>;
}

/** A pending entry queued by emit(), assigned a seq, awaiting flush. */
interface QueuedEntry {
  kind: JournalKind;
  line: string; // the full serialized JSON line (no trailing newline)
  seq: number;
}

/** §3.7 per-kind retention. */
export interface KindRetention {
  maxFileBytes: number;
  /** N>0 = rotate at maxFileBytes, keep N archives, delete older. 0 = rotate but NEVER delete. */
  rotateKeep: number;
}

export const DEFAULT_RETENTION: Record<JournalKind, KindRetention> = {
  'topic-placement': { maxFileBytes: 8 * 1024 * 1024, rotateKeep: 0 },
  'session-lifecycle': { maxFileBytes: 16 * 1024 * 1024, rotateKeep: 4 },
  'autonomous-run': { maxFileBytes: 8 * 1024 * 1024, rotateKeep: 8 },
  'threadline-conversation': { maxFileBytes: 8 * 1024 * 1024, rotateKeep: 8 },
  // guard-latch: rare operator-initiated transitions; keep full history bounded.
  'guard-latch': { maxFileBytes: 4 * 1024 * 1024, rotateKeep: 4 },
  // pref-record (WS2.1): preferences are FEW (a tight per-store cap — the
  // PreferencesSync precedent's DEFAULT_MAX_REPLICATED_PREFERENCES=500). A small
  // window with a few archives bounds a runaway edit-churn stream. The store's own
  // ReplicatedKindBounds (PreferencesReplicatedStore.PREF_RECORD_BOUNDS) override
  // these for the replicated stream; this is the journal-level fallback.
  'pref-record': { maxFileBytes: 2 * 1024 * 1024, rotateKeep: 4 },
  // relationship-record (WS2.3): a PII store — NEVER rotateKeep:0 (rotate-but-never-
  // delete would be a compliance defect, REQ-D1). The chatty relationship stream
  // (recordInteraction fires every message) is coalesced by the store's rate cap
  // (RelationshipsReplicatedStore.RELATIONSHIP_RECORD_BOUNDS); this is the journal-
  // level fallback. The per-entry size cap is RAISED to 64KB on the relationship-
  // record applier path (RELATIONSHIP_MAX_ENTRY_BYTES) so a fat relationship replicates.
  'relationship-record': { maxFileBytes: 8 * 1024 * 1024, rotateKeep: 4 },
  // learning-record (WS2.2): a memory-family store — NEVER rotateKeep:0 (rotate-but-
  // never-delete would be a compliance defect). Learnings are FEW + bounded (the
  // EvolutionManager prunes to maxLearnings=500), so a small window with a few archives
  // mirrors the pref-record sibling. The churny apply/markApplied loop is coalesced by
  // the store's rate cap (LearningsReplicatedStore.LEARNING_RECORD_BOUNDS); this is the
  // journal-level fallback. The per-entry size cap is RAISED to 64KB on the
  // learning-record applier path (LEARNING_MAX_ENTRY_BYTES) so a fat learning replicates.
  'learning-record': { maxFileBytes: 4 * 1024 * 1024, rotateKeep: 4 },
  // knowledge-record (WS2.4): a memory-family store — NEVER rotateKeep:0 (rotate-but-
  // never-delete would be a compliance defect). Knowledge sources are FEW + bounded (a
  // catalog of ingested pointers), so a small window with a few archives mirrors the
  // learning-record sibling. The churny re-ingest loop is coalesced by the store's rate
  // cap (KnowledgeReplicatedStore.KNOWLEDGE_RECORD_BOUNDS); this is the journal-level
  // fallback. The per-entry size cap is RAISED to 64KB on the knowledge-record applier
  // path (KNOWLEDGE_MAX_ENTRY_BYTES) so a fat summary replicates (the file BODY is never
  // replicated — only the catalog metadata).
  'knowledge-record': { maxFileBytes: 4 * 1024 * 1024, rotateKeep: 4 },
  // working-set-artifact (intelligent-working-set-lazy-sync): FEW + bounded per-topic
  // interactive-write index rows; a small window mirrors the knowledge-record sibling.
  'working-set-artifact': { maxFileBytes: 4 * 1024 * 1024, rotateKeep: 4 },
  // Terminal-retained class-review lifecycle stream; journal archives are
  // bounded while the folded store retains every resolvable row.
  'class-review-record': { maxFileBytes: 8 * 1024 * 1024, rotateKeep: 8 },
  // evolution-action-record (WS2.5): a memory-family store — NEVER rotateKeep:0 (rotate-but-
  // never-delete would be a compliance defect). Actions are FEW + bounded (the
  // EvolutionManager prunes to maxActions=300), so a small window with a few archives mirrors
  // the learning-record sibling. The churny add/updateAction loop is coalesced by the store's
  // rate cap (EvolutionActionsReplicatedStore.EVOLUTION_ACTION_RECORD_BOUNDS); this is the
  // journal-level fallback. The per-entry size cap is RAISED to 64KB on the
  // evolution-action-record applier path (EVOLUTION_ACTION_MAX_ENTRY_BYTES) so a fat action
  // description replicates.
  'evolution-action-record': { maxFileBytes: 4 * 1024 * 1024, rotateKeep: 4 },
  // user-record (WS2.6): a PII store — NEVER rotateKeep:0 (rotate-but-never-delete would be a
  // compliance defect). Registered principals are FEW + bounded, so a small window with a few
  // archives mirrors the relationship-record sibling. The churny upsert loop is coalesced by the
  // store's rate cap (UserRegistryReplicatedStore.USER_RECORD_BOUNDS); this is the journal-level
  // fallback. The per-entry size cap is RAISED to 64KB on the user-record applier path
  // (USER_MAX_ENTRY_BYTES) so a fat profile replicates (the local userId is never replicated).
  'user-record': { maxFileBytes: 4 * 1024 * 1024, rotateKeep: 4 },
  // topic-operator-record (WS2.6): a PII store — NEVER rotateKeep:0. One binding per topic, so a
  // small window mirrors the user-record sibling. The per-message re-bind loop is coalesced by the
  // store's rate cap (TopicOperatorReplicatedStore.TOPIC_OPERATOR_RECORD_BOUNDS). The per-entry size
  // cap is RAISED to 64KB on the applier path (TOPIC_OPERATOR_MAX_ENTRY_BYTES). NOTE: this kind is
  // ADVISORY-only — a replicated topic-operator record is NEVER the authoritative principal.
  'topic-operator-record': { maxFileBytes: 2 * 1024 * 1024, rotateKeep: 4 },
  // threadline-pairing-record (Secure A2A Verified Pairing §3.8): the verified-IDENTITY
  // RESULT store — FEW records (one per verified peer), bounded. NEVER the SAS/secret/token
  // (those never enter the journal). The store's own bounds
  // (ThreadlinePairingReplicatedStore.THREADLINE_PAIRING_RECORD_BOUNDS) override the
  // replicated stream; this is the journal-level fallback.
  'threadline-pairing-record': { maxFileBytes: 1 * 1024 * 1024, rotateKeep: 4 },
  // subscription-account-meta (WS5.2 §6.1a): a metadata-only projection — NEVER rotateKeep:0
  // (rotate-but-never-delete parity with the other replicated kinds). Accounts are FEW + bounded
  // (a handful per operator), so a small window with a few archives suffices; the churny quota-
  // refresh loop is coalesced upstream. Carries NO credential and NO PII beyond email (the
  // configHome + every credential field are stripped at the projector).
  'subscription-account-meta': { maxFileBytes: 2 * 1024 * 1024, rotateKeep: 4 },
  // topic-pin-record (U4.1 §2C, fixes defect 4): rotateKeep 0 = rotate but NEVER
  // delete — the replication carrier must not drop pins by construction (the old
  // keep-4 window could rotate a long-untouched topic's winning record away as
  // other topics churned). Pin volume is tiny (operator actions, one compact
  // record per pin EVENT); the answer-complete READ is the fold view's job
  // (CoherenceJournalReader.foldPinRecords + TopicPinFoldView), bounded by the
  // loud ws13FoldMaxBytes byte-guard. Per-key rewrite-compaction at rotation is
  // the named tracked follow-up if volume ever grows toward the guard.
  'topic-pin-record': { maxFileBytes: 2 * 1024 * 1024, rotateKeep: 0 },
  // U4.2 (stale-owner-release §2.4): claim suspension + per-topic claim budget +
  // declined-demote pins. Written only on claim/decline transitions — tiny volume.
  'topic-claim-annotation': { maxFileBytes: 2 * 1024 * 1024, rotateKeep: 4 },
};

export const DEFAULT_FLUSH_INTERVAL_MS = 250;
export const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024;
/**
 * Per-entry byte cap for a REPLICATED `*-record` kind (WS2 send-side). A
 * disclosure-minimized record's `data` is capped at 64 KB by its store builder
 * (e.g. LEARNING_MAX_ENTRY_BYTES); the serialized journal LINE adds the entry
 * envelope (seq/ts/machine/kind), so the line cap must sit a margin ABOVE the
 * data cap or a legal-but-fat record would be dropped as oversize. 80 KB clears
 * the 64 KB data ceiling with comfortable headroom while staying bounded. The
 * applier's receive-side cap (JournalSyncApplier) uses the SAME constant so a
 * record the writer emits can never be rejected as oversize on receive. */
export const REPLICATED_RECORD_MAX_ENTRY_BYTES = 80 * 1024;
/** Tail-scan window for op-key dedupe reconstruction (§3.1). */
export const DEDUPE_WINDOW = 200;
/** Token-bucket defaults per kind (emits/sec sustained; burst = capacity). */
export const DEFAULT_RATE_CAP = { capacity: 100, refillPerSec: 50 };
/** Reverse-tail read byte ceiling for the tolerant reader. */
export const DEFAULT_READ_BYTE_CEILING = 1 * 1024 * 1024;

export interface RateCapConfig {
  capacity: number;
  refillPerSec: number;
}

export interface CoherenceJournalConfig {
  /** Absolute path to the agent's `.instar/` directory (the stateDir). */
  stateDir: string;
  /** Stable id for THIS machine (the single producer of its own streams). */
  machineId: string;
  /** Flush cadence (ms). Default 250. */
  flushIntervalMs?: number;
  /** Per-entry size cap (bytes). Default 8KB. */
  maxEntryBytes?: number;
  /** Per-kind retention overrides; missing kinds fall back to DEFAULT_RETENTION. */
  retention?: Partial<Record<JournalKind, KindRetention>>;
  /** Per-kind rate cap (token bucket). Default applied to every kind. */
  rateCap?: RateCapConfig;
  /**
   * Allowlisted roots that artifactPaths must canonicalize under (§3.1 write-time
   * jail). Absolute paths. Defaults to [`.instar/autonomous/`, the stateDir].
   */
  artifactRoots?: string[];
  /**
   * Injected standby read-only guard (§3.1). The flusher calls this with the
   * target file path before each append batch; throwing skips the batch + counts.
   * Another workstream wires the real `StateManager.guardJournalWrite`.
   */
  guardWrite?: (filePath: string) => void;
  /** Optional clock override (tests). */
  now?: () => Date;
  /** Optional logger; called once per failure class. */
  logger?: (msg: string) => void;
  /**
   * Optional derived-index observer for replicated records. Called only after a
   * replicated-kind batch has been written and fdatasync has returned, so callers
   * never witness data that is merely queued in memory.
   */
  onReplicatedRecordsCommitted?: (kind: JournalKind, entries: JournalEntry[]) => void;
  /**
   * Optional fs seam for fault-injection tests (wedge the flusher). Defaults to
   * node:fs primitives. Only the primitives the flusher uses are seamed.
   */
  fsImpl?: JournalFs;
}

/** The fs primitives the flusher/opener use (seamable for fault injection). */
export interface JournalFs {
  /** Optional (lock mtime heartbeat, #925). Defaults to fs.futimesSync. */
  futimesSync?: (fd: number, atime: Date, mtime: Date) => void;
  openSync: typeof fs.openSync;
  writeSync: typeof fs.writeSync;
  fdatasyncSync: typeof fs.fdatasyncSync;
  closeSync: typeof fs.closeSync;
  existsSync: typeof fs.existsSync;
  statSync: typeof fs.statSync;
  renameSync: typeof fs.renameSync;
  writeFileSync: typeof fs.writeFileSync;
  readFileSync: typeof fs.readFileSync;
  readdirSync: typeof fs.readdirSync;
  truncateSync: typeof fs.truncateSync;
  mkdirSync: typeof fs.mkdirSync;
  openReadSync?: typeof fs.openSync;
  readSync: typeof fs.readSync;
}

function realFs(): JournalFs {
  return {
    futimesSync: fs.futimesSync,
    openSync: fs.openSync,
    writeSync: fs.writeSync,
    fdatasyncSync: fs.fdatasyncSync,
    closeSync: fs.closeSync,
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    renameSync: fs.renameSync,
    writeFileSync: fs.writeFileSync,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    truncateSync: fs.truncateSync,
    mkdirSync: fs.mkdirSync,
    readSync: fs.readSync,
  };
}

/** Degradation counters surfaced to the read API (§3.1). */
export interface JournalDegradation {
  /** Trailing-partial-line truncations on open (Distrust Temporary Success). */
  repairs: number;
  /** Genuine rewinds detected (last seq < highWaterSeq) → re-mint. */
  remints: number;
  /** Entries dropped for failing the typed schema. */
  schemaRejects: number;
  /** Unknown fields dropped from otherwise-valid data. */
  droppedFields: number;
  /** Entries dropped for exceeding the per-entry size cap. */
  oversize: number;
  /** Emits dropped by the rate cap. */
  rateLimited: number;
  /** artifactPaths rejected by the write-time jail. */
  jailRejects: number;
  /** Append batches skipped because guardWrite threw (read-only standby). */
  guardSkips: number;
  /** Flush failures (write/fsync errors). */
  flushErrors: number;
  /** Idempotent emits collapsed by the op-key dedupe. */
  dedupeHits: number;
}

/** Per-stream status surfaced to the read API. */
export interface StreamStatus {
  kind: JournalKind;
  machine: string;
  incarnation: string;
  lastSeq: number;
  highWaterSeq: number;
}

/** Result of a tolerant reverse-tail read. */
export interface TolerantReadResult {
  entries: JournalEntry[];
  skippedCorrupt: number;
  truncated: boolean;
}

/** Per-kind meta sidecar contents. */
interface KindMeta {
  highWaterSeq: number;
}

interface MetaFile {
  incarnation: string;
  kinds: Partial<Record<JournalKind, KindMeta>>;
}

interface RateBucket {
  tokens: number;
  lastRefillMs: number;
}

type WriterState = 'active' | 'writer-locked-out' | 'closed';

/**
 * Sanitize a machine id for use in a file name. Mirrors MachineHeartbeat:
 * percent-encode anything outside [A-Za-z0-9_-] so a stray slash or `..`
 * cannot escape, and the mapping is injective + traversal-safe.
 */
export function sanitizeMachineId(machineId: string): string {
  return machineId.replace(/[^A-Za-z0-9_-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export class CoherenceJournal {
  private readonly stateDir: string;
  private readonly machineId: string;
  private readonly safeMachineId: string;
  private readonly flushIntervalMs: number;
  private readonly maxEntryBytes: number;
  private readonly retention: Record<JournalKind, KindRetention>;
  private readonly rateCapCfg: RateCapConfig;
  private readonly artifactRoots: string[];
  private readonly guardWrite?: (filePath: string) => void;
  private readonly now: () => Date;
  private readonly logger?: (msg: string) => void;
  private replicatedCommitObserver?: (kind: JournalKind, entries: JournalEntry[]) => void;
  private readonly io: JournalFs;
  /**
   * The replicated-kind registry (WS2 send-side). Injected via
   * setReplicatedKindRegistry so the journal can validate + accept a registered
   * `*-record` kind's envelope. ABSENT ⇒ unchanged behavior (only the 5 hardcoded
   * lifecycle kinds validate; a `*-record` kind schema-rejects exactly as before
   * this seam landed). The journal never depends on the registry being present.
   */
  private replicatedRegistry?: ReplicatedKindRegistry;

  private state: WriterState = 'closed';
  private incarnation = '';
  /** Next seq to assign at enqueue, per kind (in-memory counter seeded at open). */
  private nextSeq: Record<JournalKind, number> = { 'topic-placement': 1, 'session-lifecycle': 1, 'autonomous-run': 1, 'threadline-conversation': 1, 'guard-latch': 1, 'pref-record': 1, 'relationship-record': 1, 'learning-record': 1, 'knowledge-record': 1, 'evolution-action-record': 1, 'user-record': 1, 'topic-operator-record': 1, 'threadline-pairing-record': 1, 'subscription-account-meta': 1, 'topic-pin-record': 1, 'topic-claim-annotation': 1, 'working-set-artifact': 1, 'class-review-record': 1 };
  /** Durable highWaterSeq per kind (advanced after data fdatasync). */
  private highWaterSeq: Record<JournalKind, number> = {
    'topic-placement': 0,
    'session-lifecycle': 0,
    'autonomous-run': 0,
    'threadline-conversation': 0,
    'guard-latch': 0,
    'pref-record': 0,
    'relationship-record': 0,
    'learning-record': 0,
    'knowledge-record': 0,
    'evolution-action-record': 0,
    'user-record': 0,
    'topic-operator-record': 0,
    'threadline-pairing-record': 0,
    'subscription-account-meta': 0,
    'topic-pin-record': 0,
    'topic-claim-annotation': 0,
    'working-set-artifact': 0,
    'class-review-record': 0,
  };
  /** In-memory enqueue order; drained by the flusher in seq order per kind. */
  private queue: QueuedEntry[] = [];
  /** Recent-window op-key set per kind (reconstructed on open by tail-scan). */
  private opKeys: Record<JournalKind, Set<string>> = {
    'topic-placement': new Set(),
    'session-lifecycle': new Set(),
    'autonomous-run': new Set(),
    'threadline-conversation': new Set(),
    'guard-latch': new Set(),
    'pref-record': new Set(),
    'relationship-record': new Set(),
    'learning-record': new Set(),
    'knowledge-record': new Set(),
    'evolution-action-record': new Set(),
    'user-record': new Set(),
    'topic-operator-record': new Set(),
    'threadline-pairing-record': new Set(),
    'subscription-account-meta': new Set(),
    'topic-pin-record': new Set(),
    'topic-claim-annotation': new Set(),
    'working-set-artifact': new Set(),
    'class-review-record': new Set(),
  };
  private rateBuckets: Record<JournalKind, RateBucket>;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Lock-retry timer while writer-locked-out (issue #925). */
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  /** Flush counter for the lock mtime heartbeat (pid-reuse defense, #925). */
  private flushCount = 0;
  private lockFd: number | null = null;
  private flushing = false;
  /** Monotonic suffix so rapid rotations within one ms get unique archive names. */
  private rotationCounter = 0;

  private degradation: JournalDegradation = {
    repairs: 0,
    remints: 0,
    schemaRejects: 0,
    droppedFields: 0,
    oversize: 0,
    rateLimited: 0,
    jailRejects: 0,
    guardSkips: 0,
    flushErrors: 0,
    dedupeHits: 0,
  };
  /** Has the one-time repair signal already fired this lifetime? */
  private repairSignalled = false;
  private loggedClasses = new Set<string>();

  constructor(config: CoherenceJournalConfig) {
    this.stateDir = config.stateDir;
    this.machineId = config.machineId;
    this.safeMachineId = sanitizeMachineId(config.machineId);
    this.flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxEntryBytes = config.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
    this.retention = {
      'topic-placement': config.retention?.['topic-placement'] ?? DEFAULT_RETENTION['topic-placement'],
      'session-lifecycle': config.retention?.['session-lifecycle'] ?? DEFAULT_RETENTION['session-lifecycle'],
      'autonomous-run': config.retention?.['autonomous-run'] ?? DEFAULT_RETENTION['autonomous-run'],
      'threadline-conversation': config.retention?.['threadline-conversation'] ?? DEFAULT_RETENTION['threadline-conversation'],
      'guard-latch': config.retention?.['guard-latch'] ?? DEFAULT_RETENTION['guard-latch'],
      'pref-record': config.retention?.['pref-record'] ?? DEFAULT_RETENTION['pref-record'],
      'relationship-record': config.retention?.['relationship-record'] ?? DEFAULT_RETENTION['relationship-record'],
      'learning-record': config.retention?.['learning-record'] ?? DEFAULT_RETENTION['learning-record'],
      'knowledge-record': config.retention?.['knowledge-record'] ?? DEFAULT_RETENTION['knowledge-record'],
      'evolution-action-record': config.retention?.['evolution-action-record'] ?? DEFAULT_RETENTION['evolution-action-record'],
      'user-record': config.retention?.['user-record'] ?? DEFAULT_RETENTION['user-record'],
      'topic-operator-record': config.retention?.['topic-operator-record'] ?? DEFAULT_RETENTION['topic-operator-record'],
      'threadline-pairing-record': config.retention?.['threadline-pairing-record'] ?? DEFAULT_RETENTION['threadline-pairing-record'],
      'subscription-account-meta': config.retention?.['subscription-account-meta'] ?? DEFAULT_RETENTION['subscription-account-meta'],
      'topic-pin-record': config.retention?.['topic-pin-record'] ?? DEFAULT_RETENTION['topic-pin-record'],
      'topic-claim-annotation': config.retention?.['topic-claim-annotation'] ?? DEFAULT_RETENTION['topic-claim-annotation'],
      'working-set-artifact': config.retention?.['working-set-artifact'] ?? DEFAULT_RETENTION['working-set-artifact'],
      'class-review-record': config.retention?.['class-review-record'] ?? DEFAULT_RETENTION['class-review-record'],
    };
    this.rateCapCfg = config.rateCap ?? DEFAULT_RATE_CAP;
    this.artifactRoots = (config.artifactRoots ?? [path.join(this.stateDir, 'autonomous'), this.stateDir]).map((r) => {
      const resolved = path.resolve(r);
      // Realpath the root too, so a realpath'd candidate (e.g. macOS
      // /var → /private/var) compares against a realpath'd root, not a raw one.
      try {
        return fs.realpathSync(resolved);
      } catch {
        return resolved;
      }
    });
    this.guardWrite = config.guardWrite;
    this.now = config.now ?? (() => new Date());
    this.logger = config.logger;
    this.replicatedCommitObserver = config.onReplicatedRecordsCommitted;
    this.io = config.fsImpl ?? realFs();
    const initMs = this.now().getTime();
    this.rateBuckets = {
      'topic-placement': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'session-lifecycle': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'autonomous-run': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'threadline-conversation': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'guard-latch': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'pref-record': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'relationship-record': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'learning-record': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'knowledge-record': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'evolution-action-record': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'user-record': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'topic-operator-record': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'threadline-pairing-record': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'subscription-account-meta': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'topic-pin-record': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'topic-claim-annotation': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'working-set-artifact': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
      'class-review-record': { tokens: this.rateCapCfg.capacity, lastRefillMs: initMs },
    };
  }

  // ---- lifecycle ----------------------------------------------------------

  /**
   * Acquire the single-process lock, recover any torn trailing lines, seed the
   * seq counters + op-key index, and start the background flusher. Idempotent —
   * a second `open()` on an already-open instance is a no-op.
   */
  open(): void {
    if (this.state !== 'closed') return;
    this.ensureDirs();

    if (!this.tryActivate()) {
      // Loser: disable the writer — but KEEP TRYING on a bounded cadence.
      // Issue #925 (live 2026-06-06): a restart cascade left a stale lock the
      // boot-time reclaim couldn't take (the old process lingered through the
      // handoff, then died) — with no retry, the writer stayed silently
      // read-only until the NEXT restart. The retry timer closes that hole:
      // the moment the holder exits (or its lock goes mtime-stale), this
      // process takes over and the writer recovers in place.
      this.state = 'writer-locked-out';
      this.log('lock', `[coherence-journal] writer locked out for ${this.machineId} — another process holds the lock; retrying in background`);
      const retryMs = Math.max(this.flushIntervalMs * 40, 10_000);
      this.retryTimer = setInterval(() => {
        if (this.state !== 'writer-locked-out') return;
        if (this.tryActivate()) {
          this.log('lock', `[coherence-journal] writer lock RECOVERED for ${this.machineId} — emissions resume`);
          if (this.retryTimer) {
            clearInterval(this.retryTimer);
            this.retryTimer = null;
          }
        }
      }, retryMs);
      if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
      return;
    }
  }

  /** Acquire + recover + start the flusher. Returns false when the lock is held. */
  private tryActivate(): boolean {
    if (!this.acquireLock()) return false;
    this.loadOrInitMeta();
    for (const kind of JOURNAL_KINDS) {
      this.recoverKind(kind);
    }
    this.state = 'active';
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return true;
  }

  /** Stop the flusher, drain once synchronously (best-effort), release the lock. */
  close(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.state === 'active') {
      this.flush(); // final best-effort drain
    }
    this.releaseLock();
    this.state = 'closed';
  }

  /** Writer status (queryable from the instance per §3.1). */
  get status(): WriterState {
    return this.state;
  }

  get isLockedOut(): boolean {
    return this.state === 'writer-locked-out';
  }

  getDegradation(): Readonly<JournalDegradation> {
    return { ...this.degradation };
  }

  /** Per-stream status (incarnation, lastSeq, highWaterSeq) for the read API. */
  streamStatuses(): StreamStatus[] {
    return JOURNAL_KINDS.map((kind) => ({
      kind,
      machine: this.machineId,
      incarnation: this.incarnation,
      lastSeq: Math.max(this.highWaterSeq[kind], this.nextSeq[kind] - 1),
      highWaterSeq: this.highWaterSeq[kind],
    }));
  }

  /**
   * The OWN-stream replication advert for the journal-sync transport (§3.4 rule
   * 5): per kind, the incarnation + the highest DURABLY-FLUSHED seq this writer
   * can serve. Unlike `streamStatuses().lastSeq`, this advertises `highWaterSeq`
   * (advanced only after data fdatasync) — NEVER an enqueued-but-unflushed seq —
   * so a peer never requests a delta we cannot serve from the file. Returns `{}`
   * with a zeroed entry per kind when nothing has been flushed yet; callers may
   * forward it verbatim (old peers ignore unknown fields).
   */
  getOwnAdvert(): Record<JournalKind, { incarnation: string; lastSeq: number }> {
    const out = {} as Record<JournalKind, { incarnation: string; lastSeq: number }>;
    for (const kind of JOURNAL_KINDS) {
      out[kind] = { incarnation: this.incarnation, lastSeq: this.highWaterSeq[kind] };
    }
    return out;
  }

  /** Number of entries enqueued but not yet flushed (tests / observability). */
  get pendingCount(): number {
    return this.queue.length;
  }

  // ---- emit (the hot path — NON-BLOCKING) --------------------------------

  /** topic-placement (§3.2). Op key: (topic, epoch). */
  emitPlacement(topic: number, data: PlacementData): void {
    this.emit('topic-placement', topic, data as unknown as Record<string, unknown>, `${topic}:${data?.epoch}`);
  }

  /** session-lifecycle (§3.2). Op key: (sessionId, status). topic optional. */
  emitLifecycle(data: SessionLifecycleData, topic?: number): void {
    this.emit(
      'session-lifecycle',
      topic,
      data as unknown as Record<string, unknown>,
      `${data?.sessionId}:${data?.status}`,
    );
  }

  /** autonomous-run (§3.2). Op key: (topic, runId, action). */
  emitAutonomousRun(topic: number, data: AutonomousRunData): void {
    this.emit(
      'autonomous-run',
      topic,
      data as unknown as Record<string, unknown>,
      `${topic}:${data?.runId}:${data?.action}`,
    );
  }

  /** threadline-conversation (P3 §3.1). Op key: (conversationId, action, topicId?). */
  emitThreadlineConversation(data: ThreadlineConversationData): void {
    this.emit(
      'threadline-conversation',
      data?.topicId,
      data as unknown as Record<string, unknown>,
      `${data?.conversationId}:${data?.action}:${typeof data?.topicId === 'number' ? data.topicId : ''}`,
    );
  }

  /**
   * guard-latch (green-pr-automerge R9/R7). Op key: (latchKind, latchId, seq) —
   * each transition carries a fresh monotonic `seq`, so distinct transitions are
   * never deduped away while a genuine retry of the SAME (kind,id,seq) collapses.
   */
  emitGuardLatch(data: GuardLatchData): void {
    this.emit(
      'guard-latch',
      undefined,
      data as unknown as Record<string, unknown>,
      `${data?.latchKind}:${data?.latchId}:${data?.seq}`,
    );
  }

  /**
   * Inject the replicated-kind registry (WS2 send-side). Idempotent + optional:
   * the journal validates a registered `*-record` kind's envelope via the store
   * schema the registry carries; absent ⇒ unchanged behavior. Called once at
   * wiring time (server.ts), after the concrete stores register their kinds.
   */
  setReplicatedKindRegistry(registry: ReplicatedKindRegistry | undefined): void {
    this.replicatedRegistry = registry;
  }

  /**
   * Attach/replace the derived-index observer after boot wiring has constructed
   * the reader. This observer is NOT authoritative: the journal remains the source
   * of truth and the observer can always rebuild from disk.
   */
  setReplicatedRecordCommitObserver(observer: ((kind: JournalKind, entries: JournalEntry[]) => void) | undefined): void {
    this.replicatedCommitObserver = observer;
  }

  /**
   * Emit a replicated-store record (WS2 send-side). `data` MUST be a built,
   * disclosure-minimized envelope `data` (the store's `build*RecordData` output)
   * carrying `recordKey`/`hlc`/`op`/`origin` (+ optional `observed`). The op-key
   * is `recordKey:serializeHlcKey(hlc)` so a retry of the EXACT logical event
   * (same key + same HLC) dedupes, while a new HLC is a distinct event — the §4
   * idempotency rule. Validation runs in the shared `emit()` path (which delegates
   * a registered replicated kind to `validateReplicatedEnvelope`), so a malformed
   * record is a counted schema-reject, never a throw. Non-blocking; never throws
   * into the caller (the manager emit hooks are best-effort). A no-op when the
   * kind is not a registered replicated kind (the registry is the authority).
   */
  emitReplicatedRecord(kind: JournalKind, data: Record<string, unknown>): void {
    try {
      if (!this.replicatedRegistry?.isReplicatedKind(kind)) return; // not a registered replicated kind ⇒ no-op
      const opKey = this.replicatedOpKey(data);
      this.emit(kind, undefined, data, opKey);
    } catch (e) { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      this.log('emit-record', `[coherence-journal] emitReplicatedRecord failed (swallowed): ${(e as Error)?.message}`);
    }
  }

  /** Derive the restart-proof op-key for a replicated record: `recordKey:hlcKey`.
   *  Best-effort — a malformed key/hlc still yields a stable string (the record is
   *  then rejected by validate(), so the op-key only matters for well-formed ones). */
  private replicatedOpKey(data: Record<string, unknown>): string {
    const recordKey = typeof data.recordKey === 'string' ? data.recordKey : '';
    let hlcKey = '';
    try {
      hlcKey = serializeHlcKey(coerceHlc(data.hlc));
    } catch { /* @silent-fallback-ok: a malformed hlc yields an empty hlcKey; validate() then rejects the whole record (schemaRejects) — the op-key never gates a malformed record's acceptance. */
      hlcKey = '';
    }
    return `${recordKey}:${hlcKey}`;
  }

  /** The per-entry byte cap for a kind — RAISED for replicated `*-record` kinds
   *  (a disclosure-minimized record can exceed the 8 KB lifecycle cap; §4). */
  private maxEntryBytesForKind(kind: JournalKind): number {
    return this.replicatedRegistry?.isReplicatedKind(kind)
      ? REPLICATED_RECORD_MAX_ENTRY_BYTES
      : this.maxEntryBytes;
  }

  /**
   * Generic non-blocking emit: validate + jail + dedupe + rate-cap + serialize,
   * assign a seq, enqueue, and RETURN. No synchronous file I/O on this stack —
   * the flusher does all of it. Never throws into the caller.
   */
  private emit(kind: JournalKind, topic: number | undefined, rawData: Record<string, unknown>, opKey: string): void {
    try {
      if (this.state !== 'active') return; // locked-out or closed: silent no-op (never block)

      // Rate cap (token bucket) — over-cap emits drop + count.
      if (!this.takeToken(kind)) {
        this.degradation.rateLimited++;
        return;
      }

      // Typed-schema validation: rejects free text, coerces enums, DROPS unknown
      // fields (counted), jails artifactPaths.
      const validated = this.validate(kind, rawData);
      if (!validated) {
        this.degradation.schemaRejects++;
        return;
      }

      // Op-key idempotency (restart-proof — the index is reconstructed on open).
      if (this.opKeys[kind].has(opKey)) {
        this.degradation.dedupeHits++;
        return;
      }

      const seq = this.nextSeq[kind];
      const entry: JournalEntry = {
        seq,
        ts: this.now().toISOString(),
        machine: this.machineId,
        kind,
        ...(typeof topic === 'number' ? { topic } : {}),
        data: validated,
      };
      const line = JSON.stringify(entry);

      // Per-entry size cap (8KB lifecycle / 80KB replicated record) — over-cap drop + count.
      if (Buffer.byteLength(line, 'utf-8') > this.maxEntryBytesForKind(kind)) {
        this.degradation.oversize++;
        return;
      }

      // Commit to in-memory state: bump the counter, mark the op key, enqueue.
      this.nextSeq[kind] = seq + 1;
      this.opKeys[kind].add(opKey);
      this.trimOpKeys(kind);
      this.queue.push({ kind, line, seq });
    } catch (e) { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      // The journal never throws into its caller (§3.1).
      this.log('emit', `[coherence-journal] emit failed (swallowed): ${(e as Error)?.message}`);
    }
  }

  // ---- validation + jail --------------------------------------------------

  /**
   * §3.2 typed schema. Returns the validated `data` object (only known fields,
   * enums enforced) or null to reject. Unknown fields are dropped + counted.
   */
  private validate(kind: JournalKind, raw: Record<string, unknown>): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object') return null;

    // WS2 send-side: a registered replicated `*-record` kind validates through the
    // GENERIC envelope validator + its store-specific schema (the same strict
    // discipline as the lifecycle kinds — reject free text, drop unknown fields,
    // jail path-shaped fields, validate hlc/observed). The reconstructed `data`
    // (validated envelope fields authoritative) is what enqueues. Absent registry
    // ⇒ falls through to the lifecycle switch (which rejects an unknown kind).
    const reg = this.replicatedRegistry?.getByKind(kind);
    if (reg) {
      const counters: EnvelopeValidationCounters = {
        // emit() bumps schemaRejects ONCE when validate() returns null (the
        // lifecycle path's contract) — so the validator's schema-reject is a no-op
        // here to avoid double-counting; the single emit()-side bump stands.
        bumpSchemaReject: () => { /* counted once by emit() on a null return */ },
        bumpDroppedField: () => { this.degradation.droppedFields++; },
        bumpJailReject: () => { this.degradation.jailRejects++; },
      };
      const result = validateReplicatedEnvelope(raw, reg.schema, counters);
      return result.ok ? result.data : null;
    }

    const seen = Object.keys(raw);
    let out: Record<string, unknown> | null = null;
    let known: string[] = [];

    if (kind === 'topic-placement') {
      const owner = raw.owner;
      const epoch = raw.epoch;
      const reason = raw.reason;
      if (typeof owner !== 'string' || !owner) return null;
      if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return null;
      // KEEP IN SYNC with the PlacementReason union above — the type annotation
      // does NOT enforce completeness (a subset is type-legal), so extending the
      // union without this list silently schema-rejects the new reason at the
      // source (caught by the WS1.3 second-pass review, 2026-06-12).
      const reasons: PlacementReason[] = ['user-move', 'placed', 'failover', 'released', 'quota-block-move', 'reconcile'];
      if (typeof reason !== 'string' || !reasons.includes(reason as PlacementReason)) return null;
      out = { owner, epoch, reason };
      known = ['owner', 'epoch', 'reason', 'prevOwner', 'status', 'transferTo', 'timestamp', 'drainInFlight'];
      if (raw.prevOwner !== undefined) {
        if (typeof raw.prevOwner !== 'string') return null;
        out.prevOwner = raw.prevOwner;
      }
      // Cross-machine convergence (Fix #3) — OPTIONAL handoff fields. Back-compat:
      // an absent `status` is `active` (today's behavior). A present-but-malformed
      // field schema-rejects the whole record (never a silent partial accept).
      if (raw.status !== undefined) {
        if (raw.status !== 'active' && raw.status !== 'transferring') return null;
        out.status = raw.status;
      }
      if (raw.transferTo !== undefined) {
        if (typeof raw.transferTo !== 'string') return null;
        out.transferTo = raw.transferTo;
      }
      if (raw.timestamp !== undefined) {
        if (typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp)) return null;
        out.timestamp = raw.timestamp;
      }
      if (raw.drainInFlight !== undefined) {
        if (typeof raw.drainInFlight !== 'boolean') return null;
        out.drainInFlight = raw.drainInFlight;
      }
    } else if (kind === 'session-lifecycle') {
      const sessionId = raw.sessionId;
      const status = raw.status;
      if (typeof sessionId !== 'string' || !sessionId) return null;
      const statuses: SessionStatus[] = ['created', 'completed', 'killed', 'reaped', 'failed'];
      if (typeof status !== 'string' || !statuses.includes(status as SessionStatus)) return null;
      out = { sessionId, status };
      known = ['sessionId', 'status', 'reapReason', 'reapLogRef'];
      if (raw.reapReason !== undefined) {
        if (typeof raw.reapReason !== 'string') return null;
        out.reapReason = raw.reapReason;
      }
      if (raw.reapLogRef !== undefined) {
        if (typeof raw.reapLogRef !== 'string') return null;
        out.reapLogRef = raw.reapLogRef;
      }
    } else if (kind === 'autonomous-run') {
      const action = raw.action;
      const runId = raw.runId;
      const actions: AutonomousAction[] = ['started', 'stopped'];
      if (typeof action !== 'string' || !actions.includes(action as AutonomousAction)) return null;
      if (typeof runId !== 'string' || !runId) return null;
      const paths = raw.artifactPaths;
      if (!Array.isArray(paths)) return null;
      const jailed = this.jailArtifactPaths(paths);
      if (jailed === null) return null; // any path failed the jail → reject the entry
      out = { action, runId, artifactPaths: jailed };
      known = ['action', 'runId', 'artifactPaths'];
    } else if (kind === 'threadline-conversation') {
      // P3 §3.1 — content-free lifecycle: ids + fingerprint only, free text
      // structurally excluded (the P1 typed-schema invariant).
      const action = raw.action;
      const conversationId = raw.conversationId;
      const peerFingerprint = raw.peerFingerprint;
      const actions: ThreadlineConversationAction[] = ['started', 'bound', 'unbound', 'closed'];
      if (typeof action !== 'string' || !actions.includes(action as ThreadlineConversationAction)) return null;
      if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 256) return null;
      if (typeof peerFingerprint !== 'string' || !peerFingerprint || peerFingerprint.length > 256) return null;
      const topicId = raw.topicId;
      if (topicId !== undefined && (typeof topicId !== 'number' || !Number.isFinite(topicId))) return null;
      out = { action, conversationId, peerFingerprint, ...(topicId !== undefined ? { topicId } : {}) };
      known = ['action', 'conversationId', 'peerFingerprint', 'topicId'];
    } else if (kind === 'guard-latch') {
      // green-pr-automerge R9/R7 — content-free latch transition. Free text
      // structurally excluded; `reason` is a short slug, length-capped.
      const latchKind = raw.latchKind;
      const latchId = raw.latchId;
      const action = raw.action;
      const epoch = raw.epoch;
      const seq = raw.seq;
      const actions: GuardLatchAction[] = ['set', 'clear'];
      if (typeof latchKind !== 'string' || !latchKind || latchKind.length > 64) return null;
      if (typeof latchId !== 'string' || !latchId || latchId.length > 128) return null;
      if (typeof action !== 'string' || !actions.includes(action as GuardLatchAction)) return null;
      if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return null;
      if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
      out = { latchKind, latchId, action, epoch, seq };
      known = ['latchKind', 'latchId', 'action', 'epoch', 'seq', 'reason'];
      if (raw.reason !== undefined) {
        if (typeof raw.reason !== 'string') return null;
        out.reason = raw.reason.slice(0, 80);
      }
    } else {
      return null;
    }

    // Count dropped unknown fields (defense-in-depth against free text /
    // secret-shaped fields entering the stream — they structurally cannot).
    for (const k of seen) {
      if (!known.includes(k)) this.degradation.droppedFields++;
    }
    return out;
  }

  /**
   * §3.1 write-time jail. Each path must resolve (and, if it exists, realpath)
   * to a location contained under an allowlisted root. `..` segments, absolute
   * paths outside the jail, and symlink escapes are rejected. Returns the
   * canonicalized path list, or null if ANY path escapes (the whole entry is
   * then rejected + counted by the caller).
   */
  private jailArtifactPaths(paths: unknown[]): string[] | null {
    const out: string[] = [];
    for (const p of paths) {
      if (typeof p !== 'string' || !p) {
        this.degradation.jailRejects++;
        return null;
      }
      const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(this.stateDir, p);
      // realpath the deepest existing ancestor to defeat symlink escapes.
      const real = this.realpathContained(resolved);
      if (real === null) {
        this.degradation.jailRejects++;
        return null;
      }
      out.push(real);
    }
    return out;
  }

  /**
   * Returns the realpath-resolved candidate IF it is contained under an
   * allowlisted root (symlink-safe), else null. We realpath the deepest
   * existing ancestor and re-append the non-existent tail so a path that does
   * not exist yet still gets symlink-escape protection on its existing prefix.
   */
  private realpathContained(candidate: string): string | null {
    let existing = candidate;
    const tail: string[] = [];
    while (!this.io.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break; // reached fs root
      tail.unshift(path.basename(existing));
      existing = parent;
    }
    let realExisting: string;
    try {
      realExisting = fs.realpathSync(existing);
    } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      realExisting = existing;
    }
    const finalPath = tail.length ? path.join(realExisting, ...tail) : realExisting;
    for (const root of this.artifactRoots) {
      if (this.isContained(root, realExisting) && this.isContained(root, finalPath)) {
        return finalPath;
      }
    }
    return null;
  }

  private isContained(root: string, p: string): boolean {
    const rel = path.relative(root, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  // ---- rate cap (token bucket) -------------------------------------------

  private takeToken(kind: JournalKind): boolean {
    const b = this.rateBuckets[kind];
    const nowMs = this.now().getTime();
    const elapsedSec = Math.max(0, (nowMs - b.lastRefillMs) / 1000);
    if (elapsedSec > 0) {
      b.tokens = Math.min(this.rateCapCfg.capacity, b.tokens + elapsedSec * this.rateCapCfg.refillPerSec);
      b.lastRefillMs = nowMs;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  // ---- flusher (background — the ONLY thing that touches stream files) ----

  /**
   * Drain the queue: per kind, append data lines (single-line O_APPEND writes),
   * batch fdatasync, THEN advance meta.highWaterSeq via atomic temp rename.
   * Crash-safe ordering: data durable BEFORE meta. Never throws.
   */
  flush(): void {
    // Lock mtime heartbeat (issue #925, pid-reuse defense): refresh the lock
    // file's mtime on a slow cadence so a LIVE holder is distinguishable from
    // a dead one whose pid was reused — reclaim treats an mtime-stale lock as
    // dead even when kill(pid, 0) succeeds.
    if (this.state === 'active' && this.lockFd !== null && ++this.flushCount % 40 === 0) {
      try {
        this.io.futimesSync?.(this.lockFd, new Date(), new Date());
      } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      }
    }
    if (this.state !== 'active') return;
    if (this.flushing) return; // re-entrancy guard (the timer can overlap a slow flush)
    if (this.queue.length === 0) return;
    this.flushing = true;
    try {
      // Group the drained queue by kind, preserving seq order.
      const batch = this.queue;
      this.queue = [];
      const byKind = new Map<JournalKind, QueuedEntry[]>();
      for (const q of batch) {
        const arr = byKind.get(q.kind);
        if (arr) arr.push(q);
        else byKind.set(q.kind, [q]);
      }

      for (const [kind, items] of byKind) {
        items.sort((a, b) => a.seq - b.seq);
        // Rotate-if-full BEFORE appending, so a current file always exists after
        // a flush and seq continues into a fresh file (§3.7). Seq is untouched.
        this.maybeRotate(kind);
        const filePath = this.currentFilePath(kind);
        let appended: QueuedEntry[] = [];
        try {
          // Injected standby guard — throwing skips this kind's batch + counts.
          if (this.guardWrite) this.guardWrite(filePath);
        } catch (e) { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
          this.degradation.guardSkips++;
          this.log('guard', `[coherence-journal] guardWrite refused ${kind}: ${(e as Error)?.message}`);
          // Re-queue this kind's items so a transient guard refusal doesn't lose them.
          this.queue.push(...items);
          continue;
        }

        let fd: number | null = null;
        let bytesWritten = false; // any byte appended to the O_APPEND file?
        try {
          fd = this.io.openSync(filePath, 'a');
          for (const it of items) {
            const buf = Buffer.from(it.line + '\n', 'utf-8');
            this.io.writeSync(fd, buf, 0, buf.length);
            bytesWritten = true;
            appended.push(it);
          }
          this.io.fdatasyncSync(fd);
        } catch (e) {
          this.degradation.flushErrors++;
          this.log('flush', `[coherence-journal] append/fsync failed for ${kind}: ${(e as Error)?.message}`);
          if (!bytesWritten) {
            // Open failed (or threw before any write): zero bytes hit the file,
            // so re-queue ALL items — no torn line, no duplicate seq on disk.
            this.queue.push(...items);
          } else {
            // Some bytes were appended to the O_APPEND file but fsync did not
            // confirm durability. Re-queuing would risk duplicate seqs on disk
            // (the bytes may already be persisted). Per §3.1 the flush window is
            // the accepted loss bound, so we DROP these (counted) rather than
            // fork the on-disk seq line. Recovery-on-open repairs any torn tail.
          }
          appended = [];
        } finally {
          if (fd !== null) {
            try {
              this.io.closeSync(fd);
            } catch {
              /* best-effort */
            }
          }
        }

        if (appended.length > 0) {
          // Data is durable — NOW advance meta.highWaterSeq (atomic rename).
          const top = appended[appended.length - 1].seq;
          this.highWaterSeq[kind] = Math.max(this.highWaterSeq[kind], top);
          this.persistMeta();
          this.notifyReplicatedRecordsCommitted(kind, appended);
        }
      }
    } catch (e) { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      this.degradation.flushErrors++;
      this.log('flush', `[coherence-journal] flush failed (swallowed): ${(e as Error)?.message}`);
    } finally {
      this.flushing = false;
    }
  }

  private notifyReplicatedRecordsCommitted(kind: JournalKind, appended: QueuedEntry[]): void {
    if (!this.replicatedRegistry?.isReplicatedKind(kind) || !this.replicatedCommitObserver) return;
    const entries: JournalEntry[] = [];
    for (const it of appended) {
      try {
        const entry = JSON.parse(it.line) as JournalEntry;
        if (entry && entry.kind === kind && typeof entry.seq === 'number') entries.push(entry);
      } catch { /* @silent-fallback-ok: observer notification is derived-index maintenance; the durable journal line remains authoritative and can be rebuilt from disk. */
      }
    }
    if (entries.length === 0) return;
    try {
      this.replicatedCommitObserver(kind, entries);
    } catch (e) { /* @silent-fallback-ok: derived-index observer failure must never endanger journal durability; reader parity/rebuild falls back to the authoritative stream. */
      this.log('replicated-commit-observer', `[coherence-journal] replicated commit observer failed for ${kind}: ${(e as Error)?.message}`);
    }
  }

  // ---- meta (incarnation + highWaterSeq) ---------------------------------

  private loadOrInitMeta(): void {
    const metaPath = this.metaPath();
    let meta: MetaFile | null = null;
    if (this.io.existsSync(metaPath)) {
      try {
        const raw = this.io.readFileSync(metaPath, 'utf-8') as string;
        const obj = JSON.parse(raw);
        if (obj && typeof obj.incarnation === 'string' && obj.kinds && typeof obj.kinds === 'object') {
          meta = obj as MetaFile;
        }
      } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
        meta = null; // malformed meta → re-init below
      }
    }
    if (meta) {
      this.incarnation = meta.incarnation;
      for (const kind of JOURNAL_KINDS) {
        this.highWaterSeq[kind] = Math.max(0, Number(meta.kinds[kind]?.highWaterSeq ?? 0) | 0);
      }
    } else {
      this.incarnation = this.mintIncarnation();
      for (const kind of JOURNAL_KINDS) this.highWaterSeq[kind] = 0;
      this.persistMeta();
    }
  }

  private persistMeta(): void {
    const meta: MetaFile = {
      incarnation: this.incarnation,
      kinds: {
        'topic-placement': { highWaterSeq: this.highWaterSeq['topic-placement'] },
        'session-lifecycle': { highWaterSeq: this.highWaterSeq['session-lifecycle'] },
        'autonomous-run': { highWaterSeq: this.highWaterSeq['autonomous-run'] },
        'threadline-conversation': { highWaterSeq: this.highWaterSeq['threadline-conversation'] },
        'guard-latch': { highWaterSeq: this.highWaterSeq['guard-latch'] },
      },
    };
    const metaPath = this.metaPath();
    const tmp = metaPath + '.tmp';
    this.io.writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o644 });
    this.io.renameSync(tmp, metaPath);
  }

  private mintIncarnation(): string {
    return crypto.randomBytes(12).toString('hex');
  }

  // ---- open-time recovery (per kind) -------------------------------------

  /**
   * Open a kind's current stream file: repair any torn trailing line, seed
   * `nextSeq` from the durable tail, reconstruct the op-key window, and apply
   * the incarnation re-mint rule (re-mint IFF last seq < highWaterSeq).
   */
  private recoverKind(kind: JournalKind): void {
    const filePath = this.currentFilePath(kind);
    if (!this.io.existsSync(filePath)) {
      // Fresh stream: nextSeq seeds from highWaterSeq+1 (handles a brand-new
      // stream where highWaterSeq is 0, and a meta-ahead-of-missing-file case).
      this.nextSeq[kind] = this.highWaterSeq[kind] + 1;
      return;
    }

    let content: string;
    try {
      content = this.io.readFileSync(filePath, 'utf-8') as string;
    } catch (e) {
      this.log('recover', `[coherence-journal] could not read ${kind} on open: ${(e as Error)?.message}`);
      this.nextSeq[kind] = this.highWaterSeq[kind] + 1;
      return;
    }

    // Repair a torn trailing line: a file that does NOT end in '\n' has a
    // partial final line from a crash mid-append. Truncate to the last newline.
    if (content.length > 0 && !content.endsWith('\n')) {
      const lastNl = content.lastIndexOf('\n');
      const keepLen = lastNl + 1; // bytes up to and including the last newline (0 if none)
      try {
        this.io.truncateSync(filePath, Buffer.byteLength(content.slice(0, keepLen), 'utf-8'));
      } catch (e) {
        this.log('repair', `[coherence-journal] truncate repair failed for ${kind}: ${(e as Error)?.message}`);
      }
      content = content.slice(0, keepLen);
      this.degradation.repairs++;
      if (!this.repairSignalled) {
        this.repairSignalled = true;
        this.log('repair-signal', `[coherence-journal] repaired a torn trailing line in ${kind} (one-time signal)`);
      }
    }

    // Find the last well-formed entry's seq (the durable tail).
    const lines = content.length > 0 ? content.split('\n') : [];
    let lastSeq = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (!ln) continue;
      try {
        const obj = JSON.parse(ln);
        if (typeof obj.seq === 'number') {
          lastSeq = obj.seq;
          break;
        }
      } catch {
        // interior corruption — keep scanning back for the last good seq
      }
    }

    // §3.4 rule 3: re-mint IFF the file's last seq is STRICTLY below the durable
    // highWaterSeq (a genuine rewind / restore-from-backup). A trailing-partial
    // repair is NOT a re-mint: the repaired tail still has lastSeq == highWater
    // because the meta is only advanced AFTER data is fsync'd.
    if (lastSeq < this.highWaterSeq[kind]) {
      this.incarnation = this.mintIncarnation();
      this.degradation.remints++;
      this.log('remint', `[coherence-journal] re-minted incarnation for ${kind} (rewind: last ${lastSeq} < hw ${this.highWaterSeq[kind]})`);
      // Adopt the file tail as the new durable truth and persist the new meta.
      this.highWaterSeq[kind] = lastSeq;
      this.persistMeta();
    } else if (lastSeq > this.highWaterSeq[kind]) {
      // Durable data ahead of meta (kill-9 AFTER data fsync, BEFORE meta write).
      // Adopt the file tail; this is NOT a rewind. Advance meta to match.
      this.highWaterSeq[kind] = lastSeq;
      this.persistMeta();
    }

    this.nextSeq[kind] = Math.max(lastSeq, this.highWaterSeq[kind]) + 1;
    this.reconstructOpKeys(kind, lines);
  }

  /** Tail-scan the last DEDUPE_WINDOW lines to rebuild the op-key index. */
  private reconstructOpKeys(kind: JournalKind, lines: string[]): void {
    const start = Math.max(0, lines.length - DEDUPE_WINDOW - 1);
    for (let i = start; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln) continue;
      try {
        const obj = JSON.parse(ln) as JournalEntry;
        const key = this.opKeyOf(kind, obj);
        if (key) this.opKeys[kind].add(key);
      } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
        // skip corrupt lines
      }
    }
    this.trimOpKeys(kind);
  }

  private opKeyOf(kind: JournalKind, entry: JournalEntry): string | null {
    const d = entry.data as Record<string, unknown>;
    if (kind === 'topic-placement') {
      if (typeof entry.topic !== 'number' || typeof d.epoch !== 'number') return null;
      return `${entry.topic}:${d.epoch}`;
    }
    if (kind === 'session-lifecycle') {
      if (typeof d.sessionId !== 'string' || typeof d.status !== 'string') return null;
      return `${d.sessionId}:${d.status}`;
    }
    if (kind === 'autonomous-run') {
      if (typeof entry.topic !== 'number' || typeof d.runId !== 'string' || typeof d.action !== 'string') return null;
      return `${entry.topic}:${d.runId}:${d.action}`;
    }
    if (kind === 'threadline-conversation') {
      // P3 §3.1: (conversationId, action, topicId?) — conversationId lives in
      // data, not entry.topic (round-1 integration finding).
      if (typeof d.conversationId !== 'string' || typeof d.action !== 'string') return null;
      return `${d.conversationId}:${d.action}:${typeof d.topicId === 'number' ? d.topicId : ''}`;
    }
    if (kind === 'guard-latch') {
      if (typeof d.latchKind !== 'string' || typeof d.latchId !== 'string' || typeof d.seq !== 'number') return null;
      return `${d.latchKind}:${d.latchId}:${d.seq}`;
    }
    return null;
  }

  /** Keep the op-key window bounded (No Unbounded Loops). */
  private trimOpKeys(kind: JournalKind): void {
    const set = this.opKeys[kind];
    const cap = DEDUPE_WINDOW * 2;
    if (set.size <= cap) return;
    // Sets preserve insertion order; drop the oldest down to DEDUPE_WINDOW.
    const drop = set.size - DEDUPE_WINDOW;
    let i = 0;
    for (const k of set) {
      if (i++ >= drop) break;
      set.delete(k);
    }
  }

  // ---- rotation (§3.7) ----------------------------------------------------

  /**
   * Rotate the current file when it exceeds maxFileBytes. rotateKeep N>0 keeps
   * N archives + deletes older; rotateKeep 0 rotates but NEVER deletes. Seq
   * continues across rotation (the in-memory counter is untouched).
   */
  private maybeRotate(kind: JournalKind): void {
    const ret = this.retention[kind];
    const filePath = this.currentFilePath(kind);
    let size = 0;
    try {
      size = this.io.statSync(filePath).size;
    } catch {
      return;
    }
    if (size < ret.maxFileBytes) return;

    // Archive name: <safeMachineId>.<kind>.<ts><counter>.jsonl. The numeric
    // suffix is (ts * 1000 + counter), so it stays in the `\d+` archive regex,
    // sorts oldest→newest, AND is unique even for multiple rotations in one ms.
    const stamp = `${this.now().getTime() * 1000 + (this.rotationCounter++ % 1000)}`;
    const archive = path.join(this.dirPath(), `${this.safeMachineId}.${kind}.${stamp}.jsonl`);
    try {
      // Guard the rename target too (own-stream prefix).
      if (this.guardWrite) this.guardWrite(archive);
      this.io.renameSync(filePath, archive);
    } catch (e) {
      this.log('rotate', `[coherence-journal] rotate failed for ${kind}: ${(e as Error)?.message}`);
      return;
    }

    if (ret.rotateKeep > 0) {
      this.pruneArchives(kind, ret.rotateKeep);
    }
    // rotateKeep === 0 → never delete (history forever in bounded files).
  }

  private pruneArchives(kind: JournalKind, keep: number): void {
    const archives = this.listArchives(kind);
    if (archives.length <= keep) return;
    // archives is sorted oldest→newest; delete the oldest beyond `keep`.
    const toDelete = archives.slice(0, archives.length - keep);
    for (const a of toDelete) {
      try {
        SafeFsExecutor.safeRmSync(path.join(this.dirPath(), a), { force: true, operation: 'coherence-journal:prune-archive' });
      } catch (e) { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
        this.log('prune', `[coherence-journal] prune failed for ${a}: ${(e as Error)?.message}`);
      }
    }
  }

  /** Archive file names for a kind, sorted oldest→newest by the embedded ts. */
  private listArchives(kind: JournalKind): string[] {
    const prefix = `${this.safeMachineId}.${kind}.`;
    let names: string[];
    try {
      names = this.io.readdirSync(this.dirPath()) as string[];
    } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      return [];
    }
    const re = new RegExp(`^${escapeRegExp(prefix)}(\\d+)\\.jsonl$`);
    const matched: { name: string; ts: number }[] = [];
    for (const n of names) {
      const m = re.exec(n);
      if (m) matched.push({ name: n, ts: Number(m[1]) });
    }
    matched.sort((a, b) => a.ts - b.ts);
    return matched.map((m) => m.name);
  }

  // ---- minimal tolerant reader (for the read API, built later) -----------

  /** Enumerate this writer's own stream files present on disk (current + archives). */
  enumerateStreams(): { kind: JournalKind; file: string; isArchive: boolean }[] {
    const out: { kind: JournalKind; file: string; isArchive: boolean }[] = [];
    for (const kind of JOURNAL_KINDS) {
      const cur = this.currentFilePath(kind);
      if (this.io.existsSync(cur)) out.push({ kind, file: cur, isArchive: false });
      for (const a of this.listArchives(kind)) {
        out.push({ kind, file: path.join(this.dirPath(), a), isArchive: true });
      }
    }
    return out;
  }

  /**
   * Tolerantly read up to `limit` most-recent entries from a kind's CURRENT
   * file via a bounded reverse tail read (per-line try/catch; corrupt lines are
   * skipped + counted). Reads at most `byteCeiling` bytes from the file end.
   */
  readTail(kind: JournalKind, limit = 100, byteCeiling = DEFAULT_READ_BYTE_CEILING): TolerantReadResult {
    const filePath = this.currentFilePath(kind);
    return readTailTolerant(this.io, filePath, limit, byteCeiling);
  }

  // ---- single-process lock ------------------------------------------------

  private acquireLock(): boolean {
    const lockPath = this.lockPath();
    try {
      // 'wx' fails if the file exists → advisory lock. Stale locks from a crash
      // are reclaimed if the recorded pid is no longer alive.
      const fd = this.io.openSync(lockPath, 'wx');
      this.lockFd = fd;
      try {
        const buf = Buffer.from(JSON.stringify({ pid: process.pid, at: this.now().toISOString() }), 'utf-8');
        this.io.writeSync(fd, buf, 0, buf.length);
      } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
        /* best-effort lock annotation */
      }
      return true;
    } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      // Lock exists — check whether the holder is still alive (stale reclaim).
      if (this.reclaimStaleLock(lockPath)) {
        try {
          const fd = this.io.openSync(lockPath, 'wx');
          this.lockFd = fd;
          const buf = Buffer.from(JSON.stringify({ pid: process.pid, at: this.now().toISOString() }), 'utf-8');
          try {
            this.io.writeSync(fd, buf, 0, buf.length);
          } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
            /* best-effort */
          }
          return true;
        } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
          return false;
        }
      }
      return false;
    }
  }

  /** Returns true (and removes the lock) if the recorded pid is dead. */
  private reclaimStaleLock(lockPath: string): boolean {
    try {
      const raw = this.io.readFileSync(lockPath, 'utf-8') as string;
      const obj = JSON.parse(raw);
      const pid = Number(obj?.pid);
      if (!Number.isFinite(pid) || pid <= 0) return false;
      if (pid === process.pid) return false;
      // pid-reuse defense (#925): a LIVE holder heartbeats the lock mtime
      // every ~10s; a lock untouched for 5+ minutes is dead regardless of
      // whether some unrelated process now wears its pid.
      try {
        const st = this.io.statSync(lockPath);
        const mt = (st as { mtimeMs?: number }).mtimeMs;
        if (typeof mt === 'number' && this.now().getTime() - mt > 5 * 60 * 1000) {
          SafeFsExecutor.safeRmSync(lockPath, { force: true, operation: 'coherence-journal:reclaim-mtime-stale-lock (#925)' });
          return true;
        }
      } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      }
      try {
        process.kill(pid, 0); // throws if the process does not exist
        return false; // still alive — do NOT reclaim
      } catch (err) { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
        if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') {
          SafeFsExecutor.safeRmSync(lockPath, { force: true, operation: 'coherence-journal:reclaim-stale-lock' });
          return true;
        }
        return false; // EPERM etc. — be conservative, don't reclaim
      }
    } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      return false;
    }
  }

  private releaseLock(): void {
    if (this.lockFd !== null) {
      try {
        this.io.closeSync(this.lockFd);
      } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
        /* best-effort */
      }
      this.lockFd = null;
    }
    try {
      SafeFsExecutor.safeRmSync(this.lockPath(), { force: true, operation: 'coherence-journal:release-lock' });
    } catch {
      /* best-effort */
    }
  }

  // ---- paths --------------------------------------------------------------

  private dirPath(): string {
    return path.join(this.stateDir, 'state', 'coherence-journal');
  }

  private currentFilePath(kind: JournalKind): string {
    return path.join(this.dirPath(), `${this.safeMachineId}.${kind}.jsonl`);
  }

  private metaPath(): string {
    return path.join(this.dirPath(), `${this.safeMachineId}.meta.json`);
  }

  private lockPath(): string {
    return path.join(this.dirPath(), `${this.safeMachineId}.lock`);
  }

  private ensureDirs(): void {
    const p = this.dirPath();
    if (!this.io.existsSync(p)) this.io.mkdirSync(p, { recursive: true });
  }

  private log(cls: string, msg: string): void {
    // One log line per failure class per lifetime (avoid log floods).
    if (this.loggedClasses.has(cls)) return;
    this.loggedClasses.add(cls);
    this.logger?.(msg);
  }
}

/** Escape a string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Standalone tolerant reverse-tail reader — shared by the writer's `readTail`
 * and (later) the read API's direct-file path. Reads at most `byteCeiling`
 * bytes from the end of `filePath`, parses lines newest-first, skips + counts
 * corrupt lines, and returns up to `limit` entries (newest first).
 */
export function readTailTolerant(
  io: JournalFs,
  filePath: string,
  limit: number,
  byteCeiling: number,
): TolerantReadResult {
  const result: TolerantReadResult = { entries: [], skippedCorrupt: 0, truncated: false };
  if (!io.existsSync(filePath)) return result;

  let size: number;
  try {
    size = io.statSync(filePath).size;
  } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
    return result;
  }
  if (size === 0) return result;

  const readBytes = Math.min(size, byteCeiling);
  if (readBytes < size) result.truncated = true;
  const start = size - readBytes;

  let buf: Buffer;
  let fd: number | null = null;
  try {
    fd = io.openSync(filePath, 'r');
    buf = Buffer.alloc(readBytes);
    io.readSync(fd, buf, 0, readBytes, start);
  } catch {
    return result;
  } finally {
    if (fd !== null) {
      try {
        io.closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }

  let text = buf.toString('utf-8');
  // If we started mid-file, the first (partial) line is not a whole record.
  if (start > 0) {
    const nl = text.indexOf('\n');
    if (nl >= 0) text = text.slice(nl + 1);
    result.truncated = true;
  }

  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && result.entries.length < limit; i--) {
    const ln = lines[i];
    if (!ln) continue;
    try {
      const obj = JSON.parse(ln) as JournalEntry;
      if (typeof obj.seq === 'number' && typeof obj.kind === 'string') {
        result.entries.push(obj);
      } else {
        result.skippedCorrupt++;
      }
    } catch {
      result.skippedCorrupt++;
    }
  }
  return result;
}
