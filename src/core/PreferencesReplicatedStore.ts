/**
 * PreferencesReplicatedStore — the FIRST concrete consumer of the HLC
 * replicated-store foundation (WS2.1, multi-machine-replicated-store-foundation
 * §4 + §7.2 + §13). It layers the `pref-record` replicated kind onto the generic
 * substrate (ReplicatedRecordEnvelope / UnionReader / ConflictStore /
 * RollbackUnmerge / ReplicationBudget / StoreSnapshot) so a user preference
 * learned on machine A is honored on machine B — ONE memory, not one-per-machine.
 *
 * THIS IS PURE LOGIC. No fs, no Date directly, no network. It defines:
 *   A. The `pref-record` store schema (the StoreFieldSchema the registry validates
 *      on top of the envelope) + the store's IMPACT TIER (high) + per-kind bounds.
 *   B. The emit-envelope builder: PreferenceEntry → the `data` object a journal
 *      `pref-record` entry carries (recordKey=dedupeKey, hlc, op, origin, observed).
 *   C. The union-aware read: a `Map<recordKey, UnionResult>` (from
 *      ReplicatedStoreReader.readAll('preferences')) → a `PreferenceEntry[]` for
 *      the session-start block. THE LOAD-BEARING ADVISORY RECONCILIATION (the §15.1
 *      decision): on an OPEN conflict for a dedupeKey, BOTH variants are injected as
 *      hints — they ARE advisory, both are usable guidance — rather than blocking on
 *      operator resolution. Operator resolution (POST /state/resolve-conflict) is
 *      OPTIONAL cleanup that collapses the flag; it is NEVER a gate on the hint
 *      being injected. A flag is observability + optional cleanup, not a blocked
 *      preference. This is what kills the §15.1 over-flag-fatigue concern.
 *
 * SUPERSESSION (CMT-1416): this foundation path SUPERSEDES the earlier advisory
 * `PreferencesSync.ts` (the seamlessness-spec WS2.1, behind
 * multiMachine.seamlessness.ws21PreferencesPool). BOTH ship dark/default-off, so
 * there is ZERO runtime duplication today. PreferencesSync is retained dark until
 * this path is validated, then removed (tracked CMT-1416 — a separate cleanup PR).
 * They are MUTUALLY EXCLUSIVE in practice: the consumer reads ONE path at a time
 * (the foundation reader is consulted only when `multiMachine.stateSync.preferences`
 * is enabled; the legacy merge only when `seamlessness.ws21PreferencesPool` is). An
 * operator who enables BOTH gets the foundation path's precedence (it is the
 * principled substrate); the legacy path is the fallback for an agent that has not
 * yet flipped to the foundation flag.
 *
 * SAFETY POSTURE (§14): MECHANISM, dark by default. Nothing here blocks a
 * user-initiated action. `violationPattern` (the operator's self-violation
 * detection regex/keywords) is a LOCAL-ONLY signal that reveals the operator's
 * security posture, so it is NEVER part of the replicated store schema and is
 * stripped from every emitted envelope (mirrors PreferencesSync finding #1).
 */

import type {
  PreferenceEntry,
  PreferenceProvenance,
} from './PreferencesManager.js';
import { formatPreferencesForSessionStart } from './PreferencesManager.js';
import type {
  StoreFieldSchema,
  StoreValidateContext,
  ReplicatedEnvelope,
  ReplicatedOp,
} from './ReplicatedRecordEnvelope.js';
import { jailStoreStringField } from './ReplicatedRecordEnvelope.js';
import type { ImpactTier, OriginRecord, UnionResult } from './UnionReader.js';
import type { ReplicatedKindBounds } from './ReplicationBudget.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';

// ───────────────────────────────────────────────────────────────────────────
// A. Identity, tier, schema, bounds
// ───────────────────────────────────────────────────────────────────────────

/** The stateSync config sub-key + advert suffix for this store (e.g.
 *  `multiMachine.stateSync.preferences.enabled`). Equal to the advert flag key
 *  `stateSyncReceive['preferences']`. */
export const PREF_STORE_KEY = 'preferences';

/** The JournalKind string this store rides — the DUAL-REGISTRY's dynamic half.
 *  MUST also be present in CoherenceJournal.JOURNAL_KINDS (the static half), or the
 *  store advertises receive=true yet serves/applies/pulls nothing (§4 callout). */
export const PREF_RECORD_KIND = 'pref-record';

/**
 * Preferences are HIGH-impact (spec §614 / master-spec decision 2): a concurrent
 * divergent edit to the SAME dedupeKey from different origins goes through
 * APPEND-BOTH-AND-FLAG — both versions preserved, ONE deduped conflict, never a
 * silent overwrite. (The CONSUMER read path still injects BOTH variants as advisory
 * hints — see mergeUnionToPreferences — so the flag never suppresses guidance.)
 */
export const PREF_IMPACT_TIER: ImpactTier = 'high';

/**
 * Per-kind replication bounds (§8). Preferences are FEW — a tight window with a
 * coalescing rate cap (the burst of edits to one dedupeKey collapses to the latest
 * state per interval). Mirrors the PreferencesSync precedent's per-store cap
 * (DEFAULT_MAX_REPLICATED_PREFERENCES=500). The retention here matches the
 * journal-level `pref-record` fallback in CoherenceJournal.DEFAULT_RETENTION; the
 * aggregate journal budget (64 MiB default) trivially covers a 2 MiB pref stream.
 */
export const PREF_RECORD_BOUNDS: ReplicatedKindBounds = {
  retention: { maxFileBytes: 2 * 1024 * 1024, rotateKeep: 4 },
  // A few preferences, occasional edits — a tight cap with coalescing. Capacity is
  // the burst; refill is the sustained rate. Well under the aggregate budget.
  rateCap: { capacity: 50, refillPerSec: 10 },
};

/**
 * The store-specific field names the `pref-record` schema OWNS (the unknown-field
 * counter's allowlist). NOTE: `violationPattern` is DELIBERATELY ABSENT — it is a
 * LOCAL-ONLY signal (the operator's self-violation regex/keywords) that must never
 * replicate (PreferencesSync finding #1). `dedupeKey` is ABSENT too — it is the
 * recordKey (a reserved envelope field), never a store field. `lastMutatedSeq`,
 * `storeIncarnation` etc. are local replication bookkeeping, never replicated here.
 */
export const PREF_STORE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'learning',
  'confidence',
  'dedupeCount',
  'provenance',
  'recordedAt',
]);

/** Caps mirroring the PreferencesManager discipline — a value over the cap REJECTS
 *  the whole record (never truncate-and-accept). */
export const MAX_LEARNING_LENGTH = 8 * 1024;
export const MAX_PROVENANCE_LENGTH = 64;

/**
 * The `pref-record` store schema (§4). Strict typed validation on top of the
 * envelope: reject free text beyond the known fields, jail any path-shaped string,
 * narrow each field. Returns the validated store-specific object, or null to reject
 * the WHOLE record. PURE (no I/O, no mutation of `raw`).
 */
export const prefRecordStoreSchema: StoreFieldSchema = {
  knownFields: PREF_STORE_KNOWN_FIELDS,
  // `learning` is free-text user content — credential-scrubbed at SERVE time
  // (buildPrefEnvelope), not here. It is NOT path-sensitive in the path-jail sense
  // (a learning may legitimately mention a slash), so it is not auto-jailed; we
  // length-cap it instead. No store field holds an artifact path, so
  // pathSensitiveFields is empty — but we still jail `provenance` imperatively below
  // as defense-in-depth (a provenance value can never be path-shaped).
  validate(raw: Readonly<Record<string, unknown>>, ctx: StoreValidateContext): Record<string, unknown> | null {
    // learning — required non-empty string, length-capped.
    const learning = raw.learning;
    if (typeof learning !== 'string' || learning.length === 0 || learning.length > MAX_LEARNING_LENGTH) {
      return null;
    }
    // confidence — a finite number in [0,1] (clamped, not rejected, to match the
    // PreferencesManager clamp discipline; an absent/garbage value → 0.5).
    let confidence = 0.5;
    if (typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)) {
      confidence = raw.confidence < 0 ? 0 : raw.confidence > 1 ? 1 : raw.confidence;
    }
    // dedupeCount — a positive integer (≥1).
    let dedupeCount = 1;
    if (typeof raw.dedupeCount === 'number' && Number.isFinite(raw.dedupeCount)) {
      dedupeCount = Math.max(1, Math.floor(raw.dedupeCount));
    }
    // provenance — a short enum-like slug; jail (path-shaped → reject whole record).
    // Slice 1a only ever writes 'correction-loop'; any other (incl. an unknown
    // future) slug is COERCED to it (forward-compat — never reject for a future
    // provenance), so the field is effectively a constant today but the jail still
    // guards against a path-shaped value smuggled into the slot.
    const provenance: PreferenceProvenance = 'correction-loop';
    if (raw.provenance !== undefined) {
      const jailed = jailStoreStringField(raw.provenance, ctx);
      if (jailed === null) return null; // path-shaped provenance → reject whole record
    }
    // recordedAt — an ISO string; a missing/garbage one is coerced to epoch-0 (the
    // PreferencesManager read() discipline) rather than rejecting the record.
    const recordedAt =
      typeof raw.recordedAt === 'string' && raw.recordedAt.length > 0 && raw.recordedAt.length <= 64
        ? raw.recordedAt
        : new Date(0).toISOString();

    return { learning: learning.trim(), confidence, dedupeCount, provenance, recordedAt };
  },
};

// ───────────────────────────────────────────────────────────────────────────
// B. Emit — PreferenceEntry → replicated-record `data`
// ───────────────────────────────────────────────────────────────────────────

/** The `data` object a `pref-record` journal entry carries: the validated store
 *  fields PLUS the envelope fields. Deterministic shape; `observed` omitted when
 *  absent. */
export type PrefRecordData = Record<string, unknown>;

/** The credential scrubber seam (injected so this module stays pure — the real
 *  wiring passes `redactForLiveTail`). Returns the scrubbed text + whether anything
 *  was redacted. */
export type LearningScrubber = (input: string) => { text: string; redactedCount: number };

/** Input to buildPrefRecordData: the entry to emit, the freshly-ticked hlc, the op,
 *  this machine's origin id, and the observed-witness (the hlc already merged for
 *  THIS dedupeKey before writing, or absent). */
export interface BuildPrefRecordInput {
  entry: Pick<PreferenceEntry, 'learning' | 'confidence' | 'dedupeCount' | 'provenance' | 'recordedAt' | 'dedupeKey'>;
  hlc: HlcTimestamp;
  op: ReplicatedOp;
  origin: string;
  /** The HLC already merged for THIS dedupeKey before writing, or absent (§7.2). */
  observed?: HlcTimestamp;
  /** Credential scrubber applied to `learning` at emit time (PreferencesSync finding
   *  #5: usefulness never depends on the scan — a flagged learning still replicates,
   *  redacted). Omitted ⇒ no scrub (the in-process default is to pass the real
   *  scrubber). */
  scrub?: LearningScrubber;
}

/**
 * Build the `pref-record` envelope `data` for emission (§4). recordKey = the
 * preference `dedupeKey` (the natural primary key — the same dedupeKey on two
 * machines is the SAME learned lesson). `violationPattern` is NEVER included (local-
 * only). `learning` is credential-scrubbed when a scrubber is supplied. The returned
 * object is the journal entry's `data`; the envelope fields are authoritative.
 *
 * NOTE: this does NOT validate — it produces a well-formed `data` the journal emit
 * path serializes; the RECEIVE door (validateReplicatedEnvelope + the store schema)
 * re-validates on apply. Emission is GATED upstream by
 * `multiMachine.stateSync.preferences.enabled` (the caller checks
 * isStoreEmissionEnabled before calling this) — when off, this is never reached.
 */
export function buildPrefRecordData(input: BuildPrefRecordInput): PrefRecordData {
  const { entry, hlc, op, origin, observed, scrub } = input;
  const scrubbed = scrub ? scrub(entry.learning) : { text: entry.learning, redactedCount: 0 };
  const learning = scrubbed.redactedCount > 0 ? scrubbed.text : entry.learning;
  const data: PrefRecordData = {
    // store-specific fields FIRST (the envelope fields are appended authoritatively
    // by the journal's validateReplicatedEnvelope on the receive side; on emit we
    // include them so the on-disk shape is complete).
    learning,
    confidence: clamp01(entry.confidence),
    dedupeCount: Math.max(1, Math.floor(entry.dedupeCount || 1)),
    provenance: entry.provenance ?? 'correction-loop',
    recordedAt: entry.recordedAt,
    // envelope fields (recordKey = dedupeKey).
    recordKey: entry.dedupeKey,
    hlc,
    op,
    origin,
    ...(observed !== undefined ? { observed } : {}),
  };
  return data;
}

function clamp01(v: number): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0.5;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ───────────────────────────────────────────────────────────────────────────
// C. Union-aware read — the LOAD-BEARING advisory reconciliation (§15.1)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Reconstruct a PreferenceEntry from an OriginRecord's store `data` (the envelope
 * fields stripped). Defensive: a field that does not narrow falls back to the same
 * safe default PreferencesManager.read() uses. `dedupeKey` is the recordKey.
 */
export function prefEntryFromOriginRecord(rec: OriginRecord): PreferenceEntry {
  const d = rec.data;
  const learning = typeof d.learning === 'string' ? d.learning : '';
  const confidence = typeof d.confidence === 'number' && Number.isFinite(d.confidence) ? clamp01(d.confidence) : 0.5;
  const dedupeCount =
    typeof d.dedupeCount === 'number' && Number.isFinite(d.dedupeCount) ? Math.max(1, Math.floor(d.dedupeCount)) : 1;
  const recordedAt = typeof d.recordedAt === 'string' && d.recordedAt.length > 0 ? d.recordedAt : new Date(0).toISOString();
  return {
    learning,
    provenance: 'correction-loop',
    dedupeKey: rec.envelope.recordKey,
    recordedAt,
    confidence,
    dedupeCount,
  };
}

/**
 * Build an OriginRecord for the OWN preference store (the single-origin
 * materialization the union reader merges). recordKey = dedupeKey; the envelope
 * carries a SYNTHETIC own-origin stamp. NOTE: this is the OWN record at rest — it
 * is NOT the wire/journal hlc (that is minted by clock.tick() at the EMIT path);
 * here we only need a stable own-origin record for the union to merge against peer
 * replicas. `lastMutatedSeq` is folded into a deterministic logical counter so the
 * own record has a well-formed, monotone HLC position relative to its own edits.
 * `violationPattern` is NEVER carried into the replicated namespace (local-only).
 */
export function prefEntryToOriginRecord(entry: PreferenceEntry, origin: string): OriginRecord {
  const physical = Date.parse(entry.recordedAt);
  const hlc: HlcTimestamp = {
    physical: Number.isFinite(physical) ? physical : 0,
    logical: Math.max(0, Math.floor(entry.lastMutatedSeq ?? 0)),
    node: origin,
  };
  const data: Record<string, unknown> = {
    learning: entry.learning,
    confidence: clamp01(entry.confidence),
    dedupeCount: Math.max(1, Math.floor(entry.dedupeCount || 1)),
    provenance: entry.provenance ?? 'correction-loop',
    recordedAt: entry.recordedAt,
  };
  const envelope: ReplicatedEnvelope = {
    recordKey: entry.dedupeKey,
    hlc,
    op: 'put',
    origin,
  };
  return { origin, envelope, data };
}

/**
 * THE LOAD-BEARING ADVISORY RECONCILIATION (§15.1 decision, recorded verbatim).
 *
 * Collapse a `Map<recordKey, UnionResult>` (from
 * ReplicatedStoreReader.readAll('preferences')) into the PreferenceEntry[] the
 * session-start block consumes. The §15.1 contract:
 *   - A resolved single value ⇒ inject that one entry.
 *   - An OPEN HIGH-impact conflict ⇒ inject BOTH (all) concurrent variants as
 *     separate hints. They ARE advisory — both are usable guidance — so the open
 *     conflict NEVER suppresses a usable hint. Operator resolution (POST
 *     /state/resolve-conflict) is OPTIONAL cleanup that collapses the flag; it is
 *     NEVER a gate on the hint being injected.
 *   - A LOW-impact divergence ⇒ the HLC-winner is `value`; inject it (the overwrite
 *     was flagged for observability, but the value is usable).
 *   - A null `value` with no conflict (every origin deleted, or no record) ⇒ nothing
 *     to inject for that key.
 *
 * This is the proof obligation the §12 wiring test exercises: an OPEN conflict for a
 * dedupeKey STILL yields both variants in the output (it can never suppress a usable
 * hint waiting on operator resolution). The conflict's `versions` carry every
 * concurrent origin's record; we map EACH to a PreferenceEntry hint.
 *
 * Determinism: variants from a conflict are emitted in the union reader's stable
 * (HLC-sorted) version order, so the injected block is stable across reads.
 */
export function mergeUnionToPreferences(union: Map<string, UnionResult>): PreferenceEntry[] {
  const out: PreferenceEntry[] = [];
  for (const result of union.values()) {
    if (result.conflict) {
      // OPEN HIGH-impact conflict: inject BOTH (all) concurrent variants as hints —
      // NEVER suppress a usable hint waiting on operator resolution (§15.1). A `put`
      // tombstone variant (op==='delete') contributes no usable guidance, so it is
      // skipped, but every surviving `put` variant is injected.
      for (const v of result.conflict.versions) {
        if (v.envelope.op === 'delete') continue;
        out.push(prefEntryFromOriginRecord(v));
      }
      continue;
    }
    // Resolved value (single origin, clean sequential chain, or LOW-impact HLC-win).
    // `value` is null when the resolved winner is a delete tombstone (or no record) —
    // nothing usable to inject for that key.
    if (result.value && result.value.envelope.op !== 'delete') {
      out.push(prefEntryFromOriginRecord(result.value));
    }
  }
  return out;
}

/**
 * Build the session-start preferences block from a union read (the foundation
 * path's equivalent of PreferencesManager.sessionContext()). Reuses the SAME
 * deterministic, byte-bounded, priority-ordered renderer
 * (`formatPreferencesForSessionStart`) so the injected block shape is identical to
 * the single-machine path — only the SOURCE differs (the no-clobber union vs the
 * local store). An open conflict yields BOTH variants in the block (§15.1).
 */
export function buildUnionSessionContext(
  union: Map<string, UnionResult>,
  maxBytes = 4000,
): { present: boolean; block: string; count: number; scope: 'mesh' } {
  const preferences = mergeUnionToPreferences(union);
  const block = formatPreferencesForSessionStart(
    { schemaVersion: 1, preferences },
    maxBytes,
  );
  return { present: block.length > 0, block, count: preferences.length, scope: 'mesh' };
}

// ───────────────────────────────────────────────────────────────────────────
// Registration descriptor (consumed by server.ts to register the dual registry)
// ───────────────────────────────────────────────────────────────────────────

/** The ReplicatedKindRegistry registration for the `pref-record` store. server.ts
 *  registers this onto the shared registry; the dual-registry coupling test asserts
 *  `kind` is also present in JOURNAL_KINDS. */
export const PREF_KIND_REGISTRATION = {
  kind: PREF_RECORD_KIND,
  store: PREF_STORE_KEY,
  schema: prefRecordStoreSchema,
} as const;

/** Convenience re-export for the rollback-unmerge `kindsForStore('preferences')`
 *  wiring + any caller that needs the store's contributing journal kinds. */
export function prefContributingKinds(): string[] {
  return [PREF_RECORD_KIND];
}

/**
 * The store's impact tier resolver, for ReplicatedStoreReader.tierOf. Returns the
 * preferences tier (high) for the `preferences` store. An UNKNOWN store also
 * resolves to `high` — the CONSERVATIVE direction (append-both-and-flag never
 * silently clobbers), so a future store wired before its own tierOf lands can never
 * accidentally get the silent-overwrite path. The reader composes per-store; this is
 * the default a server wires for the preferences store specifically.
 */
export function prefTierOf(_store: string): ImpactTier {
  return PREF_IMPACT_TIER;
}

/** Re-export the envelope type for callers building/applying pref-record envelopes. */
export type { ReplicatedEnvelope };
