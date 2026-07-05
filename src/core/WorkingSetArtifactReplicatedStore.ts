/**
 * WorkingSetArtifactReplicatedStore — the WS2 replicated kind that lets an agent-produced
 * artifact a conversation wrote INTERACTIVELY under the `.instar/` jail follow that
 * conversation when its topic moves machines (spec: intelligent-working-set-lazy-sync.md,
 * Layer 1). It is the literal analog of `KnowledgeReplicatedStore.ts` (WS2.4) — it layers
 * a `working-set-artifact` replicated kind onto the SAME generic substrate
 * (ReplicatedRecordEnvelope / UnionReader / ConflictStore / ReplicationBudget) so the
 * per-topic record of what an agent wrote is ONE index across machines, not one-per-machine.
 *
 * WHY A NEW KIND (not the computed engine): `WorkingSetManifest.computeWorkingSet` derives
 * the manifest from the `autonomous/<topic>.*` convention dir + `artifactPaths` on
 * `autonomous-run` journal entries. A file the agent wrote INTERACTIVELY (no autonomous
 * run) is invisible to it. This kind is the ONE new manifest source for that case — a
 * durable, replicated per-topic record of `{ relPath, contentHash?, lastWrittenAt, state }`
 * under the EXISTING `.instar/` jail. It does NOT widen the jail, lower a cap, or
 * re-implement the fetch engine (those bind verbatim — spec §50).
 *
 * THE PATH-PAYLOAD / ENVELOPE PATH-JAIL COLLISION (spec §59, M1): this is the FIRST
 * replicated kind whose payload is LEGITIMATELY a path. The envelope structurally auto-jails
 * path-shaped fields (KnowledgeReplicatedStore jails a path-shaped `url` to null). So here:
 *   - recordKey = sha256(jailedRelPath) + ':' + origin — a NON-path-shaped derivation
 *     (never the raw path), so it survives envelope validation and still gives the
 *     (relPath, producerMachine) identity. `origin` IS the authenticated producer machine
 *     (spec §62: producerMachineId ≡ the applier's authenticated entry.machine, never a
 *     separate trusted content field) — so a peer can never forge which machine produced a
 *     row (the envelope origin is authenticated at apply).
 *   - `relPath` lives in a store field explicitly CARVED OUT of the path-jail (so it may
 *     hold a path) but is STRICTLY validated on RECEIVE by the canonical `jailValidateRelPath`
 *     (relative-only; reject abs / drive / UNC / `..`-after-decode / NUL / empty; length-cap)
 *     — the filesystem serve-jail is downstream, so an invalid verdict must reject FIRST.
 *     This deliberately breaks the "envelope carries identifiers, never paths" invariant;
 *     the receive-side relPath validation is the compensating control (spec §61).
 *
 * ROW STATES (spec §64): `pendingHash` (recorded, hash deferred) → `ready(hash)` (hashed,
 * in scope) → terminal `tooLarge` / `secretFlagged`. ONLY `ready` rows enter fetch nominees
 * (the serve-boundary hash-verify remains the authority; a stored hash is advisory until the
 * pull re-reads live) — the wiring into computeWorkingSet (component 3) enforces that.
 *
 * IMPACT: HIGH at the REPLICATION layer (a concurrent divergent edit to the same recordKey
 * — same relPath+producer, different content — goes through APPEND-BOTH-AND-FLAG; both
 * surface, the fetch engine's no-clobber lands the second as `.from-<machine>`). ADVISORY at
 * the READ layer (both variants are hints; the read never blocks, never clobbers a local file).
 *
 * TOMBSTONE AUTHORITY — OWNER-ONLY (spec §91): only the PRODUCER of a row (origin ===
 * this machine) may tombstone it; a receiver deleting its FETCHED local copy is a
 * machine-local suppression, NOT a cross-peer delete. A peer can never tombstone another
 * producer's artifact.
 *
 * SAFETY POSTURE: MECHANISM, dark by default (`multiMachine.stateSync.workingSetArtifact`).
 * PURE LOGIC — no fs, no network, no Date directly.
 */

import { createHash } from 'node:crypto';

import type {
  StoreFieldSchema,
  StoreValidateContext,
  ReplicatedEnvelope,
  ReplicatedOp,
} from './ReplicatedRecordEnvelope.js';
import type { ImpactTier, OriginRecord, UnionResult } from './UnionReader.js';
import type { ReplicatedKindBounds } from './ReplicationBudget.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';

// ───────────────────────────────────────────────────────────────────────────
// A. Identity, tier, schema, bounds, caps
// ───────────────────────────────────────────────────────────────────────────

/** The stateSync config sub-key + advert suffix (`multiMachine.stateSync.workingSetArtifact.enabled`). */
export const WORKING_SET_ARTIFACT_STORE_KEY = 'workingSetArtifact';

/** The JournalKind string this store rides — the DUAL-REGISTRY dynamic half. MUST also be
 *  in CoherenceJournal.JOURNAL_KINDS (the static half) or the store advertises receive=true
 *  yet serves/applies/pulls nothing (the silent no-replication trap). */
export const WORKING_SET_ARTIFACT_KIND = 'working-set-artifact';

/** HIGH-impact at replication (append-both-and-flag on a concurrent divergent edit to the
 *  same relPath+producer); ADVISORY at read. Same posture as knowledge/relationships. */
export const WORKING_SET_ARTIFACT_IMPACT_TIER: ImpactTier = 'high';

/** Row lifecycle states (spec §64). Only `ready` rows are fetch-eligible (enforced by the
 *  computeWorkingSet union wiring, component 3). A foreign row whose `state` is outside this
 *  set is rejected (markup cannot survive an enum slot). */
export const WORKING_SET_ARTIFACT_STATES: ReadonlyArray<string> = Object.freeze([
  'pendingHash',
  'ready',
  'tooLarge',
  'secretFlagged',
]);

/** A relPath under `.instar/` is short; a generous cap that still bounds a smuggled flood. */
export const MAX_RELPATH_LENGTH = 1_024;
/** A content hash is a fixed-width hex digest; bound it hard. */
export const MAX_CONTENT_HASH_LENGTH = 128;

/**
 * Per-kind replication bounds. Working-set artifact rows are FEW + bounded (a per-topic
 * catalog of interactive writes), coalesced so a churny re-edit loop does not flood the
 * stream. NEVER `rotateKeep: 0`.
 */
export const WORKING_SET_ARTIFACT_BOUNDS: ReplicatedKindBounds = {
  retention: { maxFileBytes: 4 * 1024 * 1024, rotateKeep: 4 },
  rateCap: { capacity: 30, refillPerSec: 5 },
};

/** Per-entry cap. A row is a tiny projection ({relPath, contentHash, lastWrittenAt, state});
 *  8KB is ample. A record over cap is REJECTED with a named error (never silent-truncate). */
export const WORKING_SET_ARTIFACT_MAX_ENTRY_BYTES = 8 * 1024;

/** The store-owned VALUE fields (the unknown-field allowlist). `producerMachineId` is
 *  DELIBERATELY ABSENT — it is the authenticated envelope `origin`, never a trusted content
 *  field (spec §62). `recordKey`/`hlc`/`op`/`origin`/`observed` are reserved envelope fields. */
export const WORKING_SET_ARTIFACT_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'relPath',
  'contentHash',
  'lastWrittenAt',
  'state',
]);

/** The tombstone's only store-owned field beyond the reserved envelope set. */
export const WORKING_SET_ARTIFACT_TOMBSTONE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'deletedAt',
]);

const ALL_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  ...WORKING_SET_ARTIFACT_KNOWN_FIELDS,
  ...WORKING_SET_ARTIFACT_TOMBSTONE_KNOWN_FIELDS,
]);

// ───────────────────────────────────────────────────────────────────────────
// jailValidateRelPath — THE ONE canonical relPath validator (spec §64)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The single canonical relative-path validator, used at ALL sites (record, replication
 * receive, serve-jail) so the rules can't drift between callers (spec §64). Returns the
 * relPath UNCHANGED if safe, else null (REJECT). Rules (spec §61/§92): relative-only —
 * reject absolute, Windows drive (`C:`), UNC (`\\`), any `..` segment after decode, a NUL
 * byte (isSafeRelPath does NOT catch NUL, and it would otherwise throw uncaught downstream —
 * fail CLEAN here), empty, or over-cap. This is a STRING check; the realpath / O_NOFOLLOW /
 * containment filesystem jail is the DOWNSTREAM serve-boundary control (this runs first,
 * before any fs touch, because an invalid replication verdict must reject before the fs).
 */
export function jailValidateRelPath(relPath: unknown): string | null {
  if (typeof relPath !== 'string') return null;
  if (relPath.length === 0 || relPath.length > MAX_RELPATH_LENGTH) return null;
  if (relPath.includes('\0')) return null; // NUL — fail clean, never throw downstream
  // Absolute (POSIX or drive-letter or UNC).
  if (relPath.startsWith('/') || relPath.startsWith('\\')) return null;
  if (/^[a-zA-Z]:/.test(relPath)) return null; // C:\ or C:/
  // Normalize separators and reject any `..` segment (after decode).
  const decoded = safeDecode(relPath);
  if (decoded === null) return null;
  const segments = decoded.split(/[/\\]+/);
  for (const seg of segments) {
    if (seg === '..') return null;
  }
  return relPath;
}

/** Decode percent-encoding defensively (a `%2e%2e` traversal must be caught). Returns null
 *  if decoding throws (a malformed sequence — reject, never accept ambiguous input). */
function safeDecode(s: string): string | null {
  try {
    return s.includes('%') ? decodeURIComponent(s) : s;
  } catch {
    // @silent-fallback-ok: a malformed percent-encoding is an INVALID path — reject (null) so the
    // jail validator rejects the whole record; this is a fail-closed security decision, not a fallback.
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// isIso8601 (shared date type-clamp) + free-text clamp
// ───────────────────────────────────────────────────────────────────────────

/** Is `v` a clean ISO-8601 date string (no smuggled markup)? Mirrors KnowledgeReplicatedStore. */
export function isIso8601(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) return false;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return false;
  if (v.includes('<') || v.includes('>') || v.includes('"')) return false;
  return true;
}

/** A content hash must be hex (a stored hash is advisory, but markup cannot survive). */
function clampContentHash(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_CONTENT_HASH_LENGTH) return null;
  return /^[a-fA-F0-9]+$/.test(v) ? v : null;
}

// ───────────────────────────────────────────────────────────────────────────
// The store schema — a DISCRIMINATED UNION on `op`
// ───────────────────────────────────────────────────────────────────────────

/**
 * The `working-set-artifact` store schema. Strict typed validation on top of the envelope:
 * TYPE-CLAMP every known field, and — critically — validate `relPath` with the canonical
 * `jailValidateRelPath` (NOT the envelope's auto path-jail, which relPath is carved out of).
 * A record whose relPath fails the jail-validator is REJECTED WHOLE (never landed with a
 * null path). Returns the validated store-specific object, or null to reject the record.
 * PURE (no I/O). The envelope validator has ALREADY validated `op` ∈ {put,delete}.
 */
export const workingSetArtifactStoreSchema: StoreFieldSchema = {
  knownFields: ALL_KNOWN_FIELDS,
  validate(raw: Readonly<Record<string, unknown>>, ctx: StoreValidateContext): Record<string, unknown> | null {
    const op = raw.op;

    // ── DELETE (tombstone) branch — only `deletedAt` is a legal store field. ──────
    if (op === 'delete') {
      const deletedAt = isIso8601(raw.deletedAt) ? (raw.deletedAt as string) : undefined;
      for (const k of Object.keys(raw)) {
        if (k === 'op' || k === 'deletedAt') continue;
        if (WORKING_SET_ARTIFACT_KNOWN_FIELDS.includes(k)) ctx.countDroppedField();
      }
      return deletedAt !== undefined ? { deletedAt } : {};
    }

    // ── VALUE (put) branch. ──────────────────────────────────────────────────────
    // relPath — REQUIRED + jail-validated (the compensating control for the path-payload
    // carve-out). Reject the WHOLE record on an unsafe path — never land a null path.
    const relPath = jailValidateRelPath(raw.relPath);
    if (relPath === null) return null;

    // state — REQUIRED enum membership.
    if (typeof raw.state !== 'string' || !WORKING_SET_ARTIFACT_STATES.includes(raw.state)) return null;
    const state = raw.state;

    // lastWrittenAt — REQUIRED ISO-8601 (a non-date coerces to epoch-0, tolerant-read).
    const lastWrittenAt = isIso8601(raw.lastWrittenAt) ? (raw.lastWrittenAt as string) : new Date(0).toISOString();

    // contentHash — OPTIONAL (null when absent / a pendingHash row / non-hex). A stored hash
    // is advisory; the serve-boundary hash-verify is the authority.
    const contentHash = clampContentHash(raw.contentHash);

    return { relPath, contentHash, lastWrittenAt, state };
  },
};

// ───────────────────────────────────────────────────────────────────────────
// recordKey — the cross-machine IDENTITY SURFACE (non-path-shaped, spec §60)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Derive the cross-machine recordKey for a working-set artifact row: a NON-path-shaped
 * `sha256(jailedRelPath) + ':' + producerMachineId` (spec §60). `producerMachineId` IS the
 * authenticated envelope `origin` — so the SAME relPath from the SAME producer collapses to
 * ONE record, while divergent producers of the same path coexist (distinct recordKeys → the
 * fetch engine's no-clobber lands the second as `.from-<machine>`). Returns null when the
 * relPath fails the jail-validator or the producer id is empty (a degenerate row — the caller
 * skips emission; it can never collide a stranger by an empty key).
 */
export function deriveWorkingSetArtifactRecordKey(
  relPath: string,
  producerMachineId: string,
): string | null {
  const safe = jailValidateRelPath(relPath);
  if (safe === null) return null;
  if (typeof producerMachineId !== 'string' || producerMachineId.trim().length === 0) return null;
  const h = createHash('sha256');
  h.update(safe);
  return `${h.digest('hex').slice(0, 32)}:${producerMachineId}`;
}

// ───────────────────────────────────────────────────────────────────────────
// B. Emit — a local row → disclosure-minimized replicated `data`
// ───────────────────────────────────────────────────────────────────────────

/** A local working-set artifact row (the record shape the manager holds). */
export interface WorkingSetArtifactRow {
  relPath: string;
  contentHash?: string | null;
  lastWrittenAt: string;
  producerMachineId: string;
  state: string;
}

/** The `data` object a `working-set-artifact` journal entry carries. */
export type WorkingSetArtifactData = Record<string, unknown>;

/** The named error a record-over-cap surfaces (never silent-truncate, never suspect-wedge). */
export class WorkingSetArtifactTooLargeError extends Error {
  constructor(public readonly recordKey: string, public readonly bytes: number) {
    super(`working-set-artifact ${recordKey} is ${bytes} bytes after projection — over the ${WORKING_SET_ARTIFACT_MAX_ENTRY_BYTES}-byte per-entry cap; not replicated`);
    this.name = 'WorkingSetArtifactTooLargeError';
  }
}

export interface BuildWorkingSetArtifactInput {
  row: WorkingSetArtifactRow;
  hlc: HlcTimestamp;
  /** This machine's origin id — the authenticated producer; recordKey binds to it. */
  origin: string;
  observed?: HlcTimestamp;
}

/**
 * Build the disclosure-minimized `op:'put'` envelope `data`. recordKey binds relPath to the
 * `origin` (the producer) — NOT to any content field (spec §62). Returns null when the row
 * has no stable identity surface (relPath fails jail / empty origin). Throws
 * WorkingSetArtifactTooLargeError if the projection exceeds the per-entry cap.
 */
export function buildWorkingSetArtifactData(input: BuildWorkingSetArtifactInput): WorkingSetArtifactData | null {
  const { row, hlc, origin, observed } = input;
  const recordKey = deriveWorkingSetArtifactRecordKey(row.relPath, origin);
  if (recordKey === null) return null;
  const safeRel = jailValidateRelPath(row.relPath);
  if (safeRel === null) return null;

  const data: WorkingSetArtifactData = {
    relPath: safeRel,
    contentHash: clampContentHash(row.contentHash) ,
    lastWrittenAt: row.lastWrittenAt,
    state: WORKING_SET_ARTIFACT_STATES.includes(row.state) ? row.state : 'pendingHash',
    recordKey,
    hlc,
    op: 'put' as ReplicatedOp,
    origin,
    ...(observed !== undefined ? { observed } : {}),
  };
  assertProjectionUnderCap(recordKey, data);
  return data;
}

/** Throw WorkingSetArtifactTooLargeError if the projected data serializes over the cap. */
export function assertProjectionUnderCap(recordKey: string, data: WorkingSetArtifactData): void {
  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf-8');
  if (bytes > WORKING_SET_ARTIFACT_MAX_ENTRY_BYTES) {
    throw new WorkingSetArtifactTooLargeError(recordKey, bytes);
  }
}

export interface BuildWorkingSetArtifactTombstoneInput {
  relPath: string;
  /** The producer of the row being tombstoned — MUST equal `origin` (owner-only, spec §91). */
  producerMachineId: string;
  hlc: HlcTimestamp;
  origin: string;
  deletedAt: string;
  observed?: HlcTimestamp;
}

/**
 * Build an `op:'delete'` TOMBSTONE. OWNER-ONLY (spec §91): the recordKey binds relPath to the
 * PRODUCER, and a tombstone is only legitimate from that producer (origin === producerMachineId).
 * Returns null when origin !== producerMachineId (a peer can never tombstone another producer's
 * artifact — a remote-delete authority hole) or the identity surface is degenerate.
 */
export function buildWorkingSetArtifactTombstoneData(input: BuildWorkingSetArtifactTombstoneInput): WorkingSetArtifactData | null {
  if (input.origin !== input.producerMachineId) return null; // owner-only
  const recordKey = deriveWorkingSetArtifactRecordKey(input.relPath, input.producerMachineId);
  if (recordKey === null) return null;
  return {
    deletedAt: input.deletedAt,
    recordKey,
    hlc: input.hlc,
    op: 'delete' as ReplicatedOp,
    origin: input.origin,
    ...(input.observed !== undefined ? { observed: input.observed } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// C. Union-aware read — HIGH-impact append-both, ADVISORY at read
// ───────────────────────────────────────────────────────────────────────────

/** A merged working-set artifact view entry. READ-ONLY — never written back locally. */
export interface MergedWorkingSetArtifactView {
  recordKey: string;
  origin: string;
  data: Record<string, unknown>;
  /** True when this is one of ≥2 concurrent variants of an OPEN conflict (append-both). */
  conflicted: boolean;
}

function viewFromOriginRecord(rec: OriginRecord, conflicted: boolean): MergedWorkingSetArtifactView {
  return { recordKey: rec.envelope.recordKey, origin: rec.origin, data: rec.data, conflicted };
}

/**
 * Collapse a `Map<recordKey, UnionResult>` into the merged view. HIGH-at-replication /
 * ADVISORY-at-read: an OPEN conflict surfaces BOTH `put` variants (append-both, both are
 * hints, the read never blocks); a delete-resolved key contributes nothing (the
 * delete-resurrection guard). READ-ONLY — never clobbers a local file.
 */
export function mergeUnionToWorkingSetArtifacts(union: Map<string, UnionResult>): MergedWorkingSetArtifactView[] {
  const out: MergedWorkingSetArtifactView[] = [];
  for (const result of union.values()) {
    if (result.conflict) {
      for (const v of result.conflict.versions) {
        if (v.envelope.op === 'delete') continue;
        out.push(viewFromOriginRecord(v, true));
      }
      continue;
    }
    if (result.value && result.value.envelope.op !== 'delete') {
      out.push(viewFromOriginRecord(result.value, false));
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Own-origin materialization for the union reader
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build an OriginRecord for the OWN working-set store (the single-origin materialization the
 * union reader merges against peer replicas). recordKey binds relPath to `origin`; the
 * envelope carries a SYNTHETIC own-origin HLC derived from lastWrittenAt (physical) so the
 * own record has a stable position relative to peer records. Returns null for a degenerate
 * row (relPath fails jail).
 */
export function workingSetArtifactToOriginRecord(row: WorkingSetArtifactRow, origin: string): OriginRecord | null {
  const recordKey = deriveWorkingSetArtifactRecordKey(row.relPath, origin);
  if (recordKey === null) return null;
  const safeRel = jailValidateRelPath(row.relPath);
  if (safeRel === null) return null;
  const physical = Date.parse(row.lastWrittenAt ?? '');
  const hlc: HlcTimestamp = {
    physical: Number.isFinite(physical) ? physical : 0,
    logical: 0,
    node: origin,
  };
  const data: Record<string, unknown> = {
    relPath: safeRel,
    contentHash: clampContentHash(row.contentHash),
    lastWrittenAt: row.lastWrittenAt,
    state: WORKING_SET_ARTIFACT_STATES.includes(row.state) ? row.state : 'pendingHash',
  };
  const envelope: ReplicatedEnvelope = { recordKey, hlc, op: 'put', origin };
  return { origin, envelope, data };
}

// ───────────────────────────────────────────────────────────────────────────
// Registration descriptor (consumed by server.ts to register the dual registry)
// ───────────────────────────────────────────────────────────────────────────

/** The ReplicatedKindRegistry registration. server.ts registers this; the dual-registry
 *  coupling test asserts `kind` is also present in JOURNAL_KINDS. */
export const WORKING_SET_ARTIFACT_KIND_REGISTRATION = {
  kind: WORKING_SET_ARTIFACT_KIND,
  store: WORKING_SET_ARTIFACT_STORE_KEY,
  schema: workingSetArtifactStoreSchema,
} as const;

/** The store's contributing journal kinds (for rollback-unmerge's kindsForStore wiring). */
export function workingSetArtifactContributingKinds(): string[] {
  return [WORKING_SET_ARTIFACT_KIND];
}

/** Impact-tier resolver for ReplicatedStoreReader.tierOf — HIGH (append-both-and-flag). */
export function workingSetArtifactTierOf(_store: string): ImpactTier {
  return WORKING_SET_ARTIFACT_IMPACT_TIER;
}

export type { ReplicatedEnvelope };
