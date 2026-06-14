/**
 * JournalSyncApplier — the RECEIVE (and own-stream SERVE) side of coherence
 * journal replication (P1.3 of multi-machine coherence).
 *
 * Spec: docs/specs/COHERENCE-JOURNAL-SPEC.md §3.4 (replication trust model —
 * ALL seven rules), §3.1 (stream/meta layout), §5 (trust model).
 *
 * This class is PURE and MESH-INDEPENDENT. It owns disk state only; another
 * workstream wires the `journal-sync` MeshRpc verb, the `session-status`
 * advert, and the delta-request loop on top of it. It NEVER imports MeshRpc,
 * the server, or the mesh dispatcher — it is the engine those call.
 *
 * Replica layout (§3.1): peer copies of machine M's stream of kind K live at
 *   <stateDir>/state/coherence-journal/peers/<safeMachineId(M)>.<kind>.jsonl
 * with one sidecar
 *   <stateDir>/state/coherence-journal/peers/<safeMachineId(M)>.meta.json
 * holding the stream-set incarnation token (top-level, mirroring the writer's
 * own meta so `CoherenceJournalReader.readIncarnation` parses it) plus per-kind
 * apply bookkeeping (lastHeldSeq, status, suspect/flap counters, gap sentinels)
 * and the bounded quarantine record.
 *
 * The receive-side §4.1 durability rule lives HERE: a replica append fsyncs
 * BEFORE the entries are reported `applied`, so a journal-sync ack is an
 * ack-after-durable-commit. Author-side durability is the writer's separate
 * best-effort flush window — this is the receiver's contract.
 *
 * Trust model enforced (§3.4):
 *  1. FIRST-HOP SENDER BINDING — every entry's `machine` must === the
 *     authenticated sender; the target file derives from the sender, NEVER a
 *     payload field. Forged entries are rejected + counted, never appended.
 *  2. SCHEMA-VALIDATED APPLY — per entry: parseable + size-cap, seq exactly
 *     lastHeldSeq+1, ts parses, kind known-or-ignorable, data passes the kind's
 *     typed schema. ANY failure marks the stream `suspect` and STOPS the batch
 *     at the last valid line. `suspect` self-clears after K=20 consecutive
 *     valid in-order applies.
 *  3. INCARNATION FENCING — a known stream arriving with a NEW incarnation
 *     quarantines the old replica (rename aside, ≤2 kept per stream), starts
 *     fresh, and surfaces a coalesced divergence signal (per-machine 10min
 *     window); >3 flips in the window → status `reset-flapping`, surfaced once.
 *  4. TRUNCATION SIGNALS — a batch may carry `oldestRetainedSeq`; when
 *     lastHeldSeq+1 < oldestRetainedSeq the receiver records a gap sentinel in
 *     the replica meta (NOT a fake journal line), fast-forwards lastHeldSeq to
 *     oldestRetainedSeq-1, and marks the stream `gapped` until the next clean
 *     apply. (Gap re-request PACING is the caller's job; this exposes status.)
 *
 * All replica writes go through the injected guardWrite seam (same seam as the
 * writer) and O_APPEND single-line writes. The applier is tolerant + bounded
 * everywhere and NEVER throws into its caller; degradation is surfaced via
 * counters and per-stream status.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  type ThreadlineConversationAction,
  type GuardLatchAction,
  JOURNAL_KINDS,
  sanitizeMachineId,
  readTailTolerant,
  type JournalEntry,
  type JournalKind,
  type JournalFs,
  type AutonomousAction,
  type PlacementReason,
  type SessionStatus,
} from './CoherenceJournal.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

// ---- tunables (§3.4) -------------------------------------------------------

/** Per-entry size cap on the receive side (§3.4 rule 2). Mirrors the writer's
 *  DEFAULT_MAX_ENTRY_BYTES (source of truth: CoherenceJournal.ts). */
export const APPLIER_MAX_ENTRY_BYTES = 8 * 1024;
/** Consecutive valid in-order applies that self-clear `suspect` (§3.4 rule 2). */
export const SUSPECT_CLEAR_THRESHOLD = 20;
/** Quarantined replica files kept per stream before evicting the oldest (rule 3). */
export const MAX_QUARANTINE_PER_STREAM = 2;
/** Incarnation-flap coalescing window per machine (rule 3). */
export const FLAP_WINDOW_MS = 10 * 60 * 1000;
/** Flips within the window past this → `reset-flapping`, surfaced once (rule 3). */
export const FLAP_RESET_THRESHOLD = 3;
/** Default serve-batch size cap (§3.4 rule 5 — journalSyncMaxBatchBytes). */
export const DEFAULT_MAX_BATCH_BYTES = 262144;
/** Reverse-tail read ceiling when reading own stream to serve. */
const SERVE_READ_BYTE_CEILING = 64 * 1024 * 1024;

// ---- public types ----------------------------------------------------------

/** Per-stream replication status surfaced to the caller (§3.4 rule 4). */
export type StreamReplStatus = 'current' | 'behind' | 'gapped' | 'suspect' | 'reset-flapping';

/** One stream's apply bookkeeping, persisted in the peer meta sidecar. */
export interface PeerKindState {
  /** Highest contiguously-applied seq held locally for this peer+kind. */
  lastHeldSeq: number;
  status: StreamReplStatus;
  /** Consecutive valid in-order applies since the stream last went `suspect`. */
  consecutiveValid: number;
  /** Gap sentinels recorded by truncation fast-forwards (§3.4 rule 4). */
  gaps: GapSentinel[];
}

/** A recorded hole in a replica stream (rule 4) — meta bookkeeping, NOT a line. */
export interface GapSentinel {
  /** First seq known-missing (the old lastHeldSeq+1). */
  fromSeq: number;
  /** Last seq known-missing (oldestRetainedSeq-1). */
  toSeq: number;
  /** When this machine recorded the gap. */
  recordedAt: string;
}

/** The peer meta sidecar (§3.1) — incarnation top-level (reader-compatible). */
export interface PeerMeta {
  incarnation: string;
  /** Per-kind apply bookkeeping. */
  kinds: Partial<Record<JournalKind, PeerKindState>>;
  /** Incarnation flips observed (timestamps ms) for the flap window. */
  flipsMs: number[];
  /** Sticky once a machine has been flagged reset-flapping (surfaced once). */
  resetFlapping: boolean;
}

/** A divergence signal coalesced per machine within FLAP_WINDOW_MS (rule 3). */
export interface DivergenceSignal {
  machineId: string;
  kind: JournalKind;
  oldIncarnation: string;
  newIncarnation: string;
  at: string;
}

/** One stream's slice of an inbound batch. */
export interface ApplyBatchStream {
  kind: JournalKind;
  incarnation: string;
  entries: JournalEntry[];
  /** Optional truncation watermark (§3.4 rule 4). */
  oldestRetainedSeq?: number;
}

/** Result of an apply() call — never thrown, fully observable. */
export interface ApplyResult {
  /** Total entries durably appended across all streams in this call. */
  applied: number;
  /** Entries rejected by first-hop sender binding (rule 1). */
  forgedEntries: number;
  /** Entries dropped as duplicates (seq <= lastHeldSeq) — silent (rule 2). */
  duplicates: number;
  /** Entries failing schema/seq/size/ts validation (rule 2). */
  invalidEntries: number;
  /** Streams marked suspect in this call (rule 2). */
  suspectStreams: number;
  /** Streams quarantined for a new incarnation in this call (rule 3). */
  quarantined: number;
  /** Truncation gaps recorded in this call (rule 4). */
  gapsRecorded: number;
  /** Append batches skipped because guardWrite refused (never thrown). */
  guardSkips: number;
  /** Divergence signals emitted (coalesced) in this call (rule 3). */
  signals: DivergenceSignal[];
  /** Per-stream final status after this call. */
  statuses: Record<string, StreamReplStatus>;
}

/** Aggregate degradation counters (lifetime). */
export interface ApplierDegradation {
  applied: number;
  forgedEntries: number;
  duplicates: number;
  invalidEntries: number;
  suspectMarks: number;
  quarantines: number;
  gapsRecorded: number;
  guardSkips: number;
  appendErrors: number;
  signals: number;
}

export interface JournalSyncApplierConfig {
  /** Absolute path to the agent's `.instar/` directory (the stateDir). */
  stateDir: string;
  /**
   * Injected standby read-only guard (§3.1). Called with the target replica
   * file path before each append batch; throwing skips the batch + counts.
   * Same seam the writer uses (`StateManager.guardJournalWrite`).
   */
  guardWrite?: (filePath: string) => void;
  /** Optional clock override (tests). */
  now?: () => Date;
  /** Optional logger; called once per failure class. */
  logger?: (msg: string) => void;
  /** Optional fs seam for fault-injection tests. Defaults to node:fs. */
  fsImpl?: JournalFs;
  /** Per-entry size cap override. Default APPLIER_MAX_ENTRY_BYTES. */
  maxEntryBytes?: number;
}

function realFs(): JournalFs {
  return {
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class JournalSyncApplier {
  private readonly stateDir: string;
  private readonly guardWrite?: (filePath: string) => void;
  private readonly now: () => Date;
  private readonly logger?: (msg: string) => void;
  private readonly io: JournalFs;
  private readonly maxEntryBytes: number;

  /** In-memory meta cache per peer machine (keyed by RAW machineId). */
  private metaCache = new Map<string, PeerMeta>();

  private degradation: ApplierDegradation = {
    applied: 0,
    forgedEntries: 0,
    duplicates: 0,
    invalidEntries: 0,
    suspectMarks: 0,
    quarantines: 0,
    gapsRecorded: 0,
    guardSkips: 0,
    appendErrors: 0,
    signals: 0,
  };
  private loggedClasses = new Set<string>();

  constructor(config: JournalSyncApplierConfig) {
    this.stateDir = config.stateDir;
    this.guardWrite = config.guardWrite;
    this.now = config.now ?? (() => new Date());
    this.logger = config.logger;
    this.io = config.fsImpl ?? realFs();
    this.maxEntryBytes = config.maxEntryBytes ?? APPLIER_MAX_ENTRY_BYTES;
  }

  getDegradation(): Readonly<ApplierDegradation> {
    return { ...this.degradation };
  }

  // ---- advert state (for delta requests) ---------------------------------

  /**
   * What this machine holds per peer stream — `{ machineId → { kind →
   * { incarnation, lastSeq } } }` — so the caller can compare against a peer's
   * advert and request only the missing ranges (§3.4 rule 5). Sourced from the
   * persisted peer meta (incarnation + per-kind lastHeldSeq).
   */
  getAdvertState(): Record<string, Record<string, { incarnation: string; lastSeq: number }>> {
    const out: Record<string, Record<string, { incarnation: string; lastSeq: number }>> = {};
    for (const machineId of this.discoverPeerMachines()) {
      const meta = this.loadMeta(machineId);
      const perKind: Record<string, { incarnation: string; lastSeq: number }> = {};
      for (const kind of JOURNAL_KINDS) {
        const ks = meta.kinds[kind];
        // Surface a stream only if we hold something for it (lastHeldSeq > 0)
        // OR it has bookkeeping (a gap/suspect). A bare zero is "nothing held".
        if (ks && (ks.lastHeldSeq > 0 || ks.status !== 'current' || ks.gaps.length > 0)) {
          perKind[kind] = { incarnation: meta.incarnation, lastSeq: ks.lastHeldSeq };
        }
      }
      if (Object.keys(perKind).length > 0) out[machineId] = perKind;
    }
    return out;
  }

  /** Per-stream replication status (§3.4 rule 4 — caller drives gap pacing). */
  getStreamStatus(): Record<string, StreamReplStatus> {
    const out: Record<string, StreamReplStatus> = {};
    for (const machineId of this.discoverPeerMachines()) {
      const meta = this.loadMeta(machineId);
      if (meta.resetFlapping) {
        // A reset-flapping machine surfaces that status across all its kinds.
        for (const kind of JOURNAL_KINDS) {
          if (meta.kinds[kind]) out[`${machineId}.${kind}`] = 'reset-flapping';
        }
      }
      for (const kind of JOURNAL_KINDS) {
        const ks = meta.kinds[kind];
        if (!ks) continue;
        const key = `${machineId}.${kind}`;
        if (out[key]) continue; // reset-flapping already wins
        out[key] = ks.status;
      }
    }
    return out;
  }

  // ---- apply (the RECEIVE side, §3.4 rules 1-4) --------------------------

  /**
   * Apply an inbound batch from `senderMachineId` (the AUTHENTICATED envelope
   * identity). Implements §3.4 rules 1-4. Never throws; the result is fully
   * observable. The target replica files derive from `senderMachineId` only —
   * NEVER from any payload field.
   */
  apply(senderMachineId: string, batch: ApplyBatchStream[]): ApplyResult {
    const result: ApplyResult = {
      applied: 0,
      forgedEntries: 0,
      duplicates: 0,
      invalidEntries: 0,
      suspectStreams: 0,
      quarantined: 0,
      gapsRecorded: 0,
      guardSkips: 0,
      signals: [],
      statuses: {},
    };
    try {
      if (!senderMachineId || typeof senderMachineId !== 'string') return result;
      const meta = this.loadMeta(senderMachineId);

      for (const stream of batch || []) {
        try {
          this.applyStream(senderMachineId, meta, stream, result);
        } catch (e) {
          // A single bad stream slice must never poison the rest of the batch.
          this.log('apply-stream', `[journal-sync] applyStream failed for ${stream?.kind}: ${(e as Error)?.message}`);
        }
      }

      // Persist the (possibly mutated) meta once per apply call.
      this.persistMeta(senderMachineId, meta);

      // Final per-stream statuses for the caller.
      for (const kind of JOURNAL_KINDS) {
        const ks = meta.kinds[kind];
        if (ks) {
          result.statuses[`${senderMachineId}.${kind}`] = meta.resetFlapping ? 'reset-flapping' : ks.status;
        }
      }
    } catch (e) {
      this.log('apply', `[journal-sync] apply failed (swallowed): ${(e as Error)?.message}`);
    }
    return result;
  }

  private applyStream(
    senderMachineId: string,
    meta: PeerMeta,
    stream: ApplyBatchStream,
    result: ApplyResult,
  ): void {
    if (!stream || !JOURNAL_KINDS.includes(stream.kind)) {
      // Unknown / ignorable kind: nothing applied, no poisoning (forward-compat).
      return;
    }
    const kind = stream.kind;
    const incarnation = typeof stream.incarnation === 'string' ? stream.incarnation : '';

    // First batch ever for this peer: adopt its incarnation (no quarantine —
    // there is no old history to fence against).
    if (!meta.incarnation) {
      meta.incarnation = incarnation || this.mintIncarnation();
    }

    // §3.4 rule 3 — INCARNATION FENCING. A KNOWN stream arriving with a NEW
    // incarnation quarantines the old replica + starts fresh + signals.
    if (incarnation && incarnation !== meta.incarnation) {
      this.handleIncarnationFlip(senderMachineId, meta, kind, incarnation, result);
    }

    const ks = this.ensureKind(meta, kind);

    // §3.4 rule 4 — TRUNCATION SIGNAL. If our next-needed seq fell below what
    // the peer still retains, record a gap sentinel + fast-forward + mark gapped.
    if (typeof stream.oldestRetainedSeq === 'number' && Number.isFinite(stream.oldestRetainedSeq)) {
      const nextNeeded = ks.lastHeldSeq + 1;
      if (nextNeeded < stream.oldestRetainedSeq) {
        ks.gaps.push({
          fromSeq: nextNeeded,
          toSeq: stream.oldestRetainedSeq - 1,
          recordedAt: this.now().toISOString(),
        });
        // Bound the gap record (No Unbounded Loops) — keep the most recent few.
        if (ks.gaps.length > 16) ks.gaps.splice(0, ks.gaps.length - 16);
        ks.lastHeldSeq = stream.oldestRetainedSeq - 1;
        ks.status = 'gapped';
        ks.consecutiveValid = 0;
        this.degradation.gapsRecorded++;
        result.gapsRecorded++;
      }
    }

    // §3.4 rules 1 + 2 — validate every entry IN ORDER, append durably, stop at
    // the first failure (suspect), skip duplicates silently.
    const toAppend: string[] = [];
    let stopped = false;
    for (const entry of stream.entries || []) {
      const verdict = this.validateEntry(senderMachineId, kind, entry, ks.lastHeldSeq + toAppend.length);
      if (verdict === 'forged') {
        this.degradation.forgedEntries++;
        result.forgedEntries++;
        // Rule 1: a forged entry is rejected + counted. It is NOT a torn write
        // (it's a trust violation), so it does NOT mark the stream suspect; we
        // simply do not append it and stop the batch (cannot trust ordering past it).
        stopped = true;
        break;
      }
      if (verdict === 'duplicate') {
        this.degradation.duplicates++;
        result.duplicates++;
        continue; // silent drop, keep scanning (rule 2)
      }
      if (verdict === 'invalid') {
        this.degradation.invalidEntries++;
        result.invalidEntries++;
        // Rule 2: ANY failure marks suspect + STOPS the batch at the last valid.
        this.markSuspect(ks);
        this.degradation.suspectMarks++;
        result.suspectStreams++;
        stopped = true;
        break;
      }
      // valid + in order → queue for durable append.
      toAppend.push(JSON.stringify(entry));
    }

    if (toAppend.length === 0) {
      return; // nothing to durably write (all dup/forged/invalid, or empty)
    }

    const appendedCount = this.durablyAppend(senderMachineId, kind, toAppend, result);
    if (appendedCount > 0) {
      ks.lastHeldSeq += appendedCount;
      // §3.4 rule 2 — `suspect` self-clears after K consecutive valid in-order
      // applies. A clean apply that advances the stream out of `gapped` returns
      // it to `current`/`behind` honestly.
      if (ks.status === 'suspect') {
        ks.consecutiveValid += appendedCount;
        if (ks.consecutiveValid >= SUSPECT_CLEAR_THRESHOLD) {
          ks.status = 'current';
          ks.consecutiveValid = 0;
        }
      } else if (ks.status === 'gapped') {
        // A clean apply after a gap returns the stream to current (the hole is
        // recorded in meta; the read API reports it honestly via the sentinel).
        ks.status = 'current';
        ks.consecutiveValid = 0;
      } else {
        ks.consecutiveValid += appendedCount;
        ks.status = 'current';
      }
    }

    // If the batch stopped short (invalid/forged) the stream is "behind" the
    // peer's advert from the caller's POV — but suspect/quarantine status wins.
    if (stopped && ks.status === 'current') {
      ks.status = 'behind';
    }
  }

  /**
   * Per-entry verdict (§3.4 rules 1 + 2). `expectedSeq` is lastHeldSeq + count
   * already queued this batch, so seq must be exactly contiguous.
   */
  private validateEntry(
    senderMachineId: string,
    kind: JournalKind,
    entry: JournalEntry,
    lastHeldSeq: number,
  ): 'valid' | 'forged' | 'duplicate' | 'invalid' {
    if (!entry || typeof entry !== 'object') return 'invalid';

    // Rule 1: FIRST-HOP SENDER BINDING. entry.machine must === the sender.
    if (typeof entry.machine !== 'string' || entry.machine !== senderMachineId) {
      return 'forged';
    }

    // Size cap (parseable ≤ cap). The line we'd write is the serialized entry.
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      return 'invalid';
    }
    if (Buffer.byteLength(line, 'utf-8') > this.maxEntryBytes) return 'invalid';

    // kind binding — the entry must belong to the stream slice it arrived in.
    if (entry.kind !== kind) return 'invalid';

    // seq must be a finite integer; <= lastHeld is a duplicate (silent drop),
    // != lastHeld+1 (a forward gap) is invalid (stop the batch).
    const seq = entry.seq;
    if (typeof seq !== 'number' || !Number.isFinite(seq) || Math.floor(seq) !== seq) return 'invalid';
    if (seq <= lastHeldSeq) return 'duplicate';
    if (seq !== lastHeldSeq + 1) return 'invalid';

    // ts must parse.
    if (typeof entry.ts !== 'string' || Number.isNaN(Date.parse(entry.ts))) return 'invalid';

    // topic, when present, must be a finite number.
    if (entry.topic !== undefined && (typeof entry.topic !== 'number' || !Number.isFinite(entry.topic))) {
      return 'invalid';
    }

    // data must pass the kind's typed schema.
    if (!this.validateData(kind, entry.data)) return 'invalid';

    return 'valid';
  }

  /**
   * §3.2 typed schema validation — MIRRORED from CoherenceJournal.validate()
   * (source of truth: src/core/CoherenceJournal.ts). The applier validates
   * STRICTLY (reject on unknown/extra fields too) so a peer's buggy/forged
   * writer cannot smuggle free text past the receiver. Returns true if the
   * data is a well-formed instance of the kind's schema.
   */
  private validateData(kind: JournalKind, data: unknown): boolean {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const raw = data as Record<string, unknown>;
    const keys = Object.keys(raw);

    if (kind === 'topic-placement') {
      const reasons: PlacementReason[] = ['user-move', 'placed', 'failover', 'released', 'quota-block-move'];
      if (typeof raw.owner !== 'string' || !raw.owner) return false;
      if (typeof raw.epoch !== 'number' || !Number.isFinite(raw.epoch)) return false;
      if (typeof raw.reason !== 'string' || !reasons.includes(raw.reason as PlacementReason)) return false;
      if (raw.prevOwner !== undefined && typeof raw.prevOwner !== 'string') return false;
      const known = ['owner', 'epoch', 'reason', 'prevOwner'];
      return keys.every((k) => known.includes(k));
    }
    if (kind === 'session-lifecycle') {
      const statuses: SessionStatus[] = ['created', 'completed', 'killed', 'reaped', 'failed'];
      if (typeof raw.sessionId !== 'string' || !raw.sessionId) return false;
      if (typeof raw.status !== 'string' || !statuses.includes(raw.status as SessionStatus)) return false;
      if (raw.reapReason !== undefined && typeof raw.reapReason !== 'string') return false;
      if (raw.reapLogRef !== undefined && typeof raw.reapLogRef !== 'string') return false;
      const known = ['sessionId', 'status', 'reapReason', 'reapLogRef'];
      return keys.every((k) => known.includes(k));
    }
    if (kind === 'autonomous-run') {
      const actions: AutonomousAction[] = ['started', 'stopped'];
      if (typeof raw.action !== 'string' || !actions.includes(raw.action as AutonomousAction)) return false;
      if (typeof raw.runId !== 'string' || !raw.runId) return false;
      if (!Array.isArray(raw.artifactPaths)) return false;
      if (!raw.artifactPaths.every((p) => typeof p === 'string')) return false;
      const known = ['action', 'runId', 'artifactPaths'];
      return keys.every((k) => known.includes(k));
    }
    if (kind === 'threadline-conversation') {
      // P3 §3.1 — the receive-side mirror of CoherenceJournal.validate
      // (round-1: without this branch the applier rejects the kind and
      // suspect-flags the sending peer).
      const actions: ThreadlineConversationAction[] = ['started', 'bound', 'unbound', 'closed'];
      if (typeof raw.action !== 'string' || !actions.includes(raw.action as ThreadlineConversationAction)) return false;
      if (typeof raw.conversationId !== 'string' || !raw.conversationId || raw.conversationId.length > 256) return false;
      if (typeof raw.peerFingerprint !== 'string' || !raw.peerFingerprint || raw.peerFingerprint.length > 256) return false;
      if (raw.topicId !== undefined && (typeof raw.topicId !== 'number' || !Number.isFinite(raw.topicId))) return false;
      const known = ['action', 'conversationId', 'peerFingerprint', 'topicId'];
      return keys.every((k) => known.includes(k));
    }
    if (kind === 'guard-latch') {
      // green-pr-automerge R9/R7 — receive-side mirror of CoherenceJournal.validate.
      const actions: GuardLatchAction[] = ['set', 'clear'];
      if (typeof raw.latchKind !== 'string' || !raw.latchKind || raw.latchKind.length > 64) return false;
      if (typeof raw.latchId !== 'string' || !raw.latchId || raw.latchId.length > 128) return false;
      if (typeof raw.action !== 'string' || !actions.includes(raw.action as GuardLatchAction)) return false;
      if (typeof raw.epoch !== 'number' || !Number.isFinite(raw.epoch)) return false;
      if (typeof raw.seq !== 'number' || !Number.isFinite(raw.seq)) return false;
      if (raw.reason !== undefined && typeof raw.reason !== 'string') return false;
      const known = ['latchKind', 'latchId', 'action', 'epoch', 'seq', 'reason'];
      return keys.every((k) => known.includes(k));
    }
    return false;
  }

  // ---- incarnation fencing (§3.4 rule 3) ---------------------------------

  private handleIncarnationFlip(
    senderMachineId: string,
    meta: PeerMeta,
    kind: JournalKind,
    newIncarnation: string,
    result: ApplyResult,
  ): void {
    const oldIncarnation = meta.incarnation;

    // Quarantine every existing replica file for this peer (rename aside),
    // bounded at MAX_QUARANTINE_PER_STREAM per stream (oldest evicted).
    for (const k of JOURNAL_KINDS) {
      this.quarantineReplica(senderMachineId, k);
    }
    this.degradation.quarantines++;
    result.quarantined++;

    // Reset ALL per-kind apply state — a fresh incarnation is a fresh history.
    meta.incarnation = newIncarnation;
    meta.kinds = {};

    // Record the flip in the coalescing window and decide flapping.
    const nowMs = this.now().getTime();
    meta.flipsMs.push(nowMs);
    meta.flipsMs = meta.flipsMs.filter((t) => nowMs - t <= FLAP_WINDOW_MS);

    if (meta.flipsMs.length > FLAP_RESET_THRESHOLD) {
      // Past the threshold → reset-flapping, surfaced ONCE.
      if (!meta.resetFlapping) {
        meta.resetFlapping = true;
        this.log(
          `flap-${senderMachineId}`,
          `[journal-sync] peer ${senderMachineId} is reset-flapping (${meta.flipsMs.length} incarnation flips in window)`,
        );
      }
      // No per-flip divergence signal once flapping — coalesced to the one above.
    } else {
      // Coalesce the divergence signal per machine within the window: emit one
      // signal per flip up to the threshold (these are the "loud" ones), but
      // only the FIRST flip in a fresh window emits to the caller — subsequent
      // ones within the window are folded (coalesced) into the lifetime count.
      const signal: DivergenceSignal = {
        machineId: senderMachineId,
        kind,
        oldIncarnation,
        newIncarnation,
        at: this.now().toISOString(),
      };
      // Coalescing: only surface to the caller if this is the first flip in the
      // current window (flipsMs has exactly 1 entry after the filter above).
      if (meta.flipsMs.length === 1) {
        result.signals.push(signal);
        this.degradation.signals++;
        this.log(
          `diverge-${senderMachineId}`,
          `[journal-sync] divergence: peer ${senderMachineId} new incarnation ${newIncarnation.slice(0, 8)} (old ${oldIncarnation.slice(0, 8)})`,
        );
      }
    }
  }

  /**
   * Rename a peer replica file aside as `<file>.quarantine.<stamp>`, keeping at
   * most MAX_QUARANTINE_PER_STREAM per stream (oldest evicted). Bounded disk.
   */
  private quarantineReplica(senderMachineId: string, kind: JournalKind): void {
    const file = this.replicaFilePath(senderMachineId, kind);
    if (!this.io.existsSync(file)) return;
    const stamp = this.now().getTime();
    const safe = sanitizeMachineId(senderMachineId);
    const target = path.join(this.peersDirPath(), `${safe}.${kind}.quarantine.${stamp}.jsonl`);
    try {
      if (this.guardWrite) this.guardWrite(target);
      this.io.renameSync(file, target);
    } catch (e) {
      this.log('quarantine', `[journal-sync] quarantine rename failed for ${kind}: ${(e as Error)?.message}`);
      return;
    }
    this.pruneQuarantine(senderMachineId, kind);
  }

  private pruneQuarantine(senderMachineId: string, kind: JournalKind): void {
    const safe = sanitizeMachineId(senderMachineId);
    const re = new RegExp(`^${escapeRegExp(`${safe}.${kind}.quarantine.`)}(\\d+)\\.jsonl$`);
    let names: string[];
    try {
      names = this.io.readdirSync(this.peersDirPath()) as string[];
    } catch {
      return;
    }
    const matched: { name: string; stamp: number }[] = [];
    for (const n of names) {
      const m = re.exec(n);
      if (m) matched.push({ name: n, stamp: Number(m[1]) });
    }
    if (matched.length <= MAX_QUARANTINE_PER_STREAM) return;
    matched.sort((a, b) => a.stamp - b.stamp); // oldest first
    const drop = matched.slice(0, matched.length - MAX_QUARANTINE_PER_STREAM);
    for (const d of drop) {
      const p = path.join(this.peersDirPath(), d.name);
      try {
        // Receiver-managed peer replica eviction — through the destructive-fs
        // funnel (mirrors CoherenceJournal.pruneArchives, the source of truth
        // for journal file deletion).
        SafeFsExecutor.safeRmSync(p, { force: true, operation: 'journal-sync:prune-quarantine' });
      } catch (e) {
        this.log('quarantine-prune', `[journal-sync] quarantine prune failed for ${d.name}: ${(e as Error)?.message}`);
      }
    }
  }

  // ---- durable append (§4.1 — ack-after-fsync) ---------------------------

  /**
   * Append validated lines to the peer replica file with O_APPEND single-line
   * writes, then fdatasync BEFORE returning the applied count (§4.1 — the
   * receiver's durability-before-ack rule lives HERE). Returns the number of
   * lines durably committed (0 if the guard refused or the open/write failed
   * before any byte landed). Never throws.
   */
  private durablyAppend(senderMachineId: string, kind: JournalKind, lines: string[], result: ApplyResult): number {
    const file = this.replicaFilePath(senderMachineId, kind);
    this.ensurePeersDir();

    // Injected standby guard — throwing skips the batch + counts (never thrown).
    try {
      if (this.guardWrite) this.guardWrite(file);
    } catch (e) { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      this.degradation.guardSkips++;
      result.guardSkips++;
      this.log('guard', `[journal-sync] guardWrite refused ${kind}: ${(e as Error)?.message}`);
      return 0;
    }

    let fd: number | null = null;
    let bytesWritten = false;
    let committed = 0;
    try {
      fd = this.io.openSync(file, 'a');
      for (const line of lines) {
        const buf = Buffer.from(line + '\n', 'utf-8');
        this.io.writeSync(fd, buf, 0, buf.length);
        bytesWritten = true;
        committed++;
      }
      // §4.1 — fsync BEFORE we report applied. This is the ack-after-durable
      // boundary: nothing past this line treats the entries as committed until
      // fdatasync has returned.
      this.io.fdatasyncSync(fd);
    } catch (e) {
      this.degradation.appendErrors++;
      this.log('append', `[journal-sync] replica append/fsync failed for ${kind}: ${(e as Error)?.message}`);
      if (!bytesWritten) {
        committed = 0; // nothing landed — caller advances nothing.
      } else {
        // Bytes landed but fsync did not confirm. We cannot prove durability,
        // so we do NOT report them applied (ack-after-durable-commit). A torn
        // tail is repaired by the tolerant reader; the caller will re-request.
        committed = 0;
      }
    } finally {
      if (fd !== null) {
        try {
          this.io.closeSync(fd);
        } catch {
          /* best-effort */
        }
      }
    }

    if (committed > 0) {
      this.degradation.applied += committed;
      result.applied += committed;
    }
    return committed;
  }

  // ---- SERVE side (§3.4 rule 5/7 — own stream only, durably-flushed only) -

  /**
   * Build a delta batch from THIS machine's OWN stream for a peer that is
   * behind (§3.4 rule 5). Reads the FILE (never any queue) so only
   * durably-flushed entries are served — a §3.4-rule-3 corollary the writer
   * guarantees by advertising only flushed seqs. First-hop only: this serves
   * exactly one own stream of one kind.
   *
   * @param kind          which own stream to serve.
   * @param fromSeq       serve entries with seq > fromSeq (the peer's lastSeq).
   * @param maxBatchBytes total serialized byte cap (default DEFAULT_MAX_BATCH_BYTES).
   * @param ownMachineId  this machine's id (the producer of the served stream).
   */
  buildServeBatch(
    kind: JournalKind,
    fromSeq: number,
    ownMachineId: string,
    maxBatchBytes = DEFAULT_MAX_BATCH_BYTES,
  ): { kind: JournalKind; incarnation: string; entries: JournalEntry[]; oldestRetainedSeq?: number } {
    const out: { kind: JournalKind; incarnation: string; entries: JournalEntry[]; oldestRetainedSeq?: number } = {
      kind,
      incarnation: this.readOwnIncarnation(ownMachineId),
      entries: [],
    };
    if (!JOURNAL_KINDS.includes(kind)) return out;

    // Read own current file + archives newest→oldest, collect entries with
    // seq > fromSeq, then return them ascending and byte-capped.
    const files = this.ownStreamFilesNewestFirst(ownMachineId, kind);
    const collected: JournalEntry[] = [];
    // Track the smallest seq we can still serve (for oldestRetainedSeq honesty).
    let minServableSeq = Number.POSITIVE_INFINITY;

    for (const f of files) {
      const read = readTailTolerant(this.io, f, Number.MAX_SAFE_INTEGER, SERVE_READ_BYTE_CEILING);
      for (const e of read.entries) {
        if (typeof e.seq !== 'number') continue;
        if (e.seq < minServableSeq) minServableSeq = e.seq;
        if (e.seq > fromSeq) collected.push(e);
      }
    }

    // Ascending by seq (the apply side requires contiguous in-order).
    collected.sort((a, b) => a.seq - b.seq);

    // Byte-cap mid-batch: include entries until adding the next would exceed
    // maxBatchBytes. At least one entry is always included if any exists and it
    // fits; an entry that alone exceeds the cap is still included (so a single
    // over-cap line is served rather than the stream stalling forever).
    let bytes = 0;
    for (const e of collected) {
      const lineBytes = Buffer.byteLength(JSON.stringify(e), 'utf-8') + 1; // +newline
      if (out.entries.length > 0 && bytes + lineBytes > maxBatchBytes) break;
      out.entries.push(e);
      bytes += lineBytes;
    }

    // §3.4 rule 4 — include oldestRetainedSeq when fromSeq has rotated out: the
    // peer asked from `fromSeq` but the oldest seq we can still serve is higher,
    // so signal the truncation. Only set it when there IS a hole below what we hold.
    if (Number.isFinite(minServableSeq) && minServableSeq > fromSeq + 1) {
      out.oldestRetainedSeq = minServableSeq;
    }

    return out;
  }

  // ---- meta (load / persist / cache) -------------------------------------

  private ensureKind(meta: PeerMeta, kind: JournalKind): PeerKindState {
    let ks = meta.kinds[kind];
    if (!ks) {
      ks = { lastHeldSeq: 0, status: 'current', consecutiveValid: 0, gaps: [] };
      meta.kinds[kind] = ks;
    }
    return ks;
  }

  private markSuspect(ks: PeerKindState): void {
    ks.status = 'suspect';
    ks.consecutiveValid = 0;
  }

  private loadMeta(machineId: string): PeerMeta {
    const cached = this.metaCache.get(machineId);
    if (cached) return cached;

    const metaPath = this.metaPath(machineId);
    let meta: PeerMeta = { incarnation: '', kinds: {}, flipsMs: [], resetFlapping: false };
    if (this.io.existsSync(metaPath)) {
      try {
        const raw = this.io.readFileSync(metaPath, 'utf-8') as string;
        const obj = JSON.parse(raw) as Partial<PeerMeta>;
        if (obj && typeof obj === 'object') {
          meta = {
            incarnation: typeof obj.incarnation === 'string' ? obj.incarnation : '',
            kinds: this.normalizeKinds(obj.kinds),
            flipsMs: Array.isArray(obj.flipsMs) ? obj.flipsMs.filter((n) => typeof n === 'number') : [],
            resetFlapping: obj.resetFlapping === true,
          };
        }
      } catch {
        // malformed meta → start clean (tolerant).
      }
    }
    this.metaCache.set(machineId, meta);
    return meta;
  }

  private normalizeKinds(raw: unknown): Partial<Record<JournalKind, PeerKindState>> {
    const out: Partial<Record<JournalKind, PeerKindState>> = {};
    if (!raw || typeof raw !== 'object') return out;
    const r = raw as Record<string, unknown>;
    const validStatus: StreamReplStatus[] = ['current', 'behind', 'gapped', 'suspect', 'reset-flapping'];
    for (const kind of JOURNAL_KINDS) {
      const ks = r[kind] as Partial<PeerKindState> | undefined;
      if (!ks || typeof ks !== 'object') continue;
      out[kind] = {
        lastHeldSeq: typeof ks.lastHeldSeq === 'number' && Number.isFinite(ks.lastHeldSeq) ? ks.lastHeldSeq : 0,
        status: validStatus.includes(ks.status as StreamReplStatus) ? (ks.status as StreamReplStatus) : 'current',
        consecutiveValid: typeof ks.consecutiveValid === 'number' ? ks.consecutiveValid : 0,
        gaps: Array.isArray(ks.gaps)
          ? ks.gaps.filter(
              (g): g is GapSentinel =>
                !!g && typeof g === 'object' && typeof (g as GapSentinel).fromSeq === 'number',
            )
          : [],
      };
    }
    return out;
  }

  private persistMeta(machineId: string, meta: PeerMeta): void {
    this.ensurePeersDir();
    const metaPath = this.metaPath(machineId);
    const tmp = metaPath + '.tmp';
    try {
      if (this.guardWrite) this.guardWrite(metaPath);
      this.io.writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o644 });
      this.io.renameSync(tmp, metaPath);
    } catch (e) { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      this.log('persist-meta', `[journal-sync] persistMeta failed for ${machineId}: ${(e as Error)?.message}`);
    }
  }

  private mintIncarnation(): string {
    return crypto.randomBytes(12).toString('hex');
  }

  // ---- peer / own discovery ----------------------------------------------

  /** Discover peer machine ids from the peers/ meta sidecars + replica files. */
  private discoverPeerMachines(): string[] {
    const dir = this.peersDirPath();
    let names: string[];
    try {
      names = this.io.readdirSync(dir) as string[];
    } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      return [];
    }
    const ids = new Set<string>();
    // Pull machineIds from `<machineId>.meta.json` first (authoritative set).
    for (const n of names) {
      const m = /^(.+)\.meta\.json$/.exec(n);
      if (m) {
        ids.add(this.unsanitizeBestEffort(m[1]));
      }
    }
    // Also pull from replica files for machines without a meta yet.
    for (const kind of JOURNAL_KINDS) {
      const k = escapeRegExp(kind);
      const re = new RegExp(`^(.+)\\.${k}(?:\\.(?:\\d+|quarantine\\.\\d+))?\\.jsonl$`);
      for (const n of names) {
        const m = re.exec(n);
        if (m) ids.add(this.unsanitizeBestEffort(m[1]));
      }
    }
    return [...ids];
  }

  /**
   * The peer file grammar uses the SANITIZED machine id as the literal. The raw
   * id is only needed for first-hop binding (which uses the sender id directly,
   * not a derived one) — for advert/status keys we surface the on-disk literal
   * (already sanitized + injective), so reverse-mapping is unnecessary and we
   * keep the literal as the machine key. (sanitizeMachineId is injective, so
   * the literal is a faithful, stable handle.)
   */
  private unsanitizeBestEffort(safeLiteral: string): string {
    return safeLiteral;
  }

  /** Own current + archive stream files (newest-first) for serve reads. */
  private ownStreamFilesNewestFirst(ownMachineId: string, kind: JournalKind): string[] {
    const safe = sanitizeMachineId(ownMachineId);
    const dir = this.dirPath();
    const current = path.join(dir, `${safe}.${kind}.jsonl`);
    const out: string[] = [];
    if (this.io.existsSync(current)) out.push(current);

    let names: string[];
    try {
      names = this.io.readdirSync(dir) as string[];
    } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      return out;
    }
    const re = new RegExp(`^${escapeRegExp(`${safe}.${kind}.`)}(\\d+)\\.jsonl$`);
    const archives: { file: string; stamp: number }[] = [];
    for (const n of names) {
      const m = re.exec(n);
      if (m) archives.push({ file: path.join(dir, n), stamp: Number(m[1]) });
    }
    archives.sort((a, b) => b.stamp - a.stamp); // newest first
    return [...out, ...archives.map((a) => a.file)];
  }

  private readOwnIncarnation(ownMachineId: string): string {
    const safe = sanitizeMachineId(ownMachineId);
    const metaPath = path.join(this.dirPath(), `${safe}.meta.json`);
    try {
      if (!this.io.existsSync(metaPath)) return '';
      const raw = this.io.readFileSync(metaPath, 'utf-8') as string;
      const obj = JSON.parse(raw);
      return typeof obj?.incarnation === 'string' ? obj.incarnation : '';
    } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      return '';
    }
  }

  // ---- paths -------------------------------------------------------------

  private dirPath(): string {
    return path.join(this.stateDir, 'state', 'coherence-journal');
  }

  private peersDirPath(): string {
    return path.join(this.dirPath(), 'peers');
  }

  private replicaFilePath(senderMachineId: string, kind: JournalKind): string {
    return path.join(this.peersDirPath(), `${sanitizeMachineId(senderMachineId)}.${kind}.jsonl`);
  }

  private metaPath(machineId: string): string {
    return path.join(this.peersDirPath(), `${sanitizeMachineId(machineId)}.meta.json`);
  }

  private ensurePeersDir(): void {
    const p = this.peersDirPath();
    if (!this.io.existsSync(p)) this.io.mkdirSync(p, { recursive: true });
  }

  private log(cls: string, msg: string): void {
    if (this.loggedClasses.has(cls)) return;
    this.loggedClasses.add(cls);
    this.logger?.(msg);
  }
}
