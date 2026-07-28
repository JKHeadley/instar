/**
 * LearningsReplicatedStore — the THIRD concrete consumer of the HLC replicated-store
 * foundation (WS2.2) and the SECOND memory-family kind (after WS2.3 relationships).
 * It layers the `learning-record` replicated kind onto the generic substrate
 * (ReplicatedRecordEnvelope / UnionReader / ConflictStore / RollbackUnmerge /
 * ReplicationBudget / StoreSnapshot) so that a lesson the agent learned on machine
 * A is known on machine B — ONE learning registry, not one-per-machine.
 *
 * It is the literal analog of `RelationshipsReplicatedStore.ts` (the WS2.3 PII
 * reference consumer). A learning is a LESSON, not a person, so it is lower-PII than a
 * relationship — but its `description`/`source` CAN reference people, content, or
 * platforms, so it REUSES the WS2.3 PII machinery (type-clamp, disclosure-min
 * projection, tombstones, flag-coherence) rather than reinventing or downgrading it.
 * THIS IS PURE LOGIC. No fs, no Date directly, no network. It defines:
 *
 *   A. The `learning-record` store schema — a STRICT typed validator that
 *      TYPE-CLAMPS every known field: `source.discoveredAt` ISO-8601-only, `applied`
 *      a boolean, `tags[]`/free text length-clamped. The schema is a DISCRIMINATED
 *      UNION on `op` — an `op:'put'` VALUE schema AND an `op:'delete'` TOMBSTONE
 *      schema coexist under the one kind, so a tombstone is never marked invalid by
 *      the value schema.
 *
 *   B. The disclosure-minimized PROJECTION — `buildLearningRecordData` emits ONLY the
 *      enumerated merge-relevant fields, NEVER the raw on-disk blob and NEVER the
 *      local `LRN-NNN` id. `recordKey` is the cross-machine IDENTITY SURFACE, derived
 *      deterministically from the stable content (normalize(title) + normalize(category)
 *      + (source.contentId || source.discoveredAt)) — never the per-machine,
 *      sequentially-assigned `LRN-NNN` id (the cross-machine-UNSTABLE id, exactly the
 *      relationship-UUID trap WS2.3 solved with the channel-set key). The SAME lesson
 *      learned on two machines collapses to ONE record.
 *
 *   C. The TOMBSTONE builder — `buildLearningTombstoneData` emits an `op:'delete'`
 *      record `{ recordKey, op, hlc, origin, deletedAt }` so a removal/prune propagates
 *      as a positive signal across an offline-then-rejoining peer instead of a record
 *      absence. CRITICAL: the EvolutionManager prune-over-maxLearnings path MUST emit
 *      a tombstone per pruned learning, else a peer re-replicates the locally-pruned
 *      learning forever (resurrection).
 *
 *   D. The union-aware read — `mergeUnionToLearnings` collapses a
 *      `Map<recordKey, UnionResult>` into the merged learning view. Learnings are
 *      HIGH-impact at the REPLICATION layer (a concurrent divergent edit to the SAME
 *      recordKey goes through APPEND-BOTH-AND-FLAG — both versions surface, never a
 *      silent clobber). The CONSUMER READ path is ADVISORY: it injects BOTH variants
 *      of an open conflict as guidance — a learning is guidance, not authority — and
 *      NEVER blocks on an unresolved conflict. The read NEVER writes a foreign record
 *      into the local store (read-only union).
 *
 *   E. Foreign-record render safety — `renderForeignLearningContext` wraps a replicated
 *      record in an explicit `<replicated-untrusted-data origin="…">` envelope and
 *      sanitizes EVERY rendered field. There is no "trusted because machine-set" render
 *      slot for a foreign record.
 *
 * DECIDED FORKS (Echo, 2026-06-13 — recorded verbatim in the PR ELI16):
 *   1. recordKey = a content fingerprint, NEVER the local `LRN-NNN` id (cross-machine
 *      identity surface — see deriveLearningRecordKey).
 *   2. Impact tier = HIGH at the REPLICATION layer (append-both-and-flag), ADVISORY at
 *      the READ layer (both variants injected as hints, never blocking) — see
 *      mergeUnionToLearnings + LEARNING_IMPACT_TIER.
 *   3. `applied`/`appliedTo` are LOCAL-merge fields, replicated but last-writer-witness
 *      wins; a concurrent applied-vs-unapplied divergence rides the SAME append-both-
 *      and-flag path (NOT a special CRDT merge) — the single conflict path.
 *
 * SAFETY POSTURE: MECHANISM, dark by default. Nothing here blocks a user-initiated
 * action. The local `LRN-NNN` id is NEVER part of the replicated schema and is stripped
 * from every emitted projection (disclosure minimization).
 */

import { createHash } from 'node:crypto';

import type { LearningEntry, LearningSource } from './types.js';
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
// A. Identity, tier, schema, bounds, caps
// ───────────────────────────────────────────────────────────────────────────

/** The stateSync config sub-key + advert suffix for this store (e.g.
 *  `multiMachine.stateSync.learnings.enabled`). Equal to the advert flag key
 *  `stateSyncReceive['learnings']`. */
export const LEARNING_STORE_KEY = 'learnings';

/** The JournalKind string this store rides — the DUAL-REGISTRY's dynamic half.
 *  MUST also be present in CoherenceJournal.JOURNAL_KINDS (the static half), or the
 *  store advertises receive=true yet serves/applies/pulls nothing. */
export const LEARNING_RECORD_KIND = 'learning-record';

/**
 * Learnings are HIGH-impact at the REPLICATION layer (fork #2): a concurrent
 * divergent VALUE edit to the SAME recordKey from different origins goes through
 * APPEND-BOTH-AND-FLAG — both versions preserved, ONE deduped conflict, never a
 * silent overwrite. The READ path (mergeUnionToLearnings) is ADVISORY — both variants
 * surface as guidance hints, the read never blocks on an open conflict — a learning is
 * guidance, not authority. Operator resolution via POST /state/resolve-conflict is
 * OPTIONAL cleanup that collapses the flag, never a gate on the hint.
 */
export const LEARNING_IMPACT_TIER: ImpactTier = 'high';

// ── Local-record caps mirrored on RECEIVE (length-clamp discipline). A value over a
//    cap REJECTS the whole record (never truncate-and-accept), EXCEPT free text which
//    is length-clamped on receive (a flood is bounded, not record-rejected). ───────
/** A learning `description` can be long (a full lesson write-up). Clamp on receive. */
export const MAX_DESCRIPTION_LENGTH = 20_000;
/** Per-free-text-string clamp for title / category / evolutionRelevance / appliedTo /
 *  each tag / each source sub-field. */
export const MAX_FREETEXT_LENGTH = 2_000;
/** A category is a short slug. */
export const MAX_CATEGORY_LENGTH = 128;
/** Tags cap (mirrors a reasonable per-learning tag count). */
export const MAX_TAGS = 50;

/**
 * Per-kind replication bounds. The learnings store is FEW + bounded (the
 * EvolutionManager prunes to maxLearnings=500), so the per-store retention mirrors the
 * pref-record store (a small window with a few archives). NEVER `rotateKeep: 0`
 * (rotate-but-never-delete would be a compliance defect for any memory-family kind).
 * The rate cap COALESCES (latest state per recordKey per interval) so a churny
 * apply/markApplied loop does not flood the stream.
 */
export const LEARNING_RECORD_BOUNDS: ReplicatedKindBounds = {
  retention: { maxFileBytes: 4 * 1024 * 1024, rotateKeep: 4 },
  // Few records, coalesced: capacity is the burst, refill the sustained rate.
  rateCap: { capacity: 30, refillPerSec: 5 },
};

/**
 * Per-entry size cap RAISED to 64KB for this kind. The default
 * APPLIER_MAX_ENTRY_BYTES = 8KB is SMALLER than a fat learning (a 20K description
 * alone exceeds it), so under it the longest learnings would never replicate AND
 * would wedge the stream. 64KB is provably above the disclosure-minimized
 * projection's maximum: description(20k) + 50 tags×2k(100k) is the dominant term, but
 * tags are SHORT slugs in practice and EACH free-text is clamped to 2k — we
 * additionally enforce a HARD post-projection ceiling: a record that STILL exceeds
 * 64KB after projection is REJECTED with a named error (never silent-truncate, never
 * suspect-wedge). See assertProjectionUnderCap.
 */
export const LEARNING_MAX_ENTRY_BYTES = 64 * 1024;

/**
 * The store-specific field names the `learning-record` VALUE schema OWNS (the
 * unknown-field counter's allowlist). The local `LRN-NNN` id is DELIBERATELY ABSENT
 * — it is per-machine + sequential and never replicated (the recordKey keys on the
 * content fingerprint, not the id). `recordKey`/`hlc`/`op`/`origin`/`observed` are
 * reserved envelope fields, never store fields.
 */
export const LEARNING_STORE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'title',
  'category',
  'description',
  'source',
  'tags',
  'applied',
  'appliedTo',
  'evolutionRelevance',
]);

/** The tombstone's store-owned fields beyond the reserved envelope set. `deletedAt`
 *  is the only store field a delete carries. */
export const LEARNING_TOMBSTONE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'deletedAt',
]);

/** The full set of known store fields across BOTH op-branches (the schema's
 *  knownFields the registry uses for unknown-field counting — a field legal in EITHER
 *  branch is "known", and the branch validate() enforces which is legal for THIS op). */
const ALL_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  ...LEARNING_STORE_KNOWN_FIELDS,
  ...LEARNING_TOMBSTONE_KNOWN_FIELDS,
]);

// ── ISO-8601 type-clamp: source.discoveredAt is the load-bearing date field. On a
//    foreign record it MUST validate as a real date or be normalized, so markup
//    cannot survive the clamp. ──────────────────────────────────────────────────

/** Is `v` a valid ISO-8601 date string (and ONLY a date — no smuggled markup)? A
 *  string Date.parse rejects, or that contains an injection char (`<`, `>`, `"`), is
 *  not a clean ISO date. */
export function isIso8601(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) return false;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return false;
  if (v.includes('<') || v.includes('>') || v.includes('"')) return false;
  return true;
}

function clampFreeText(v: unknown, max = MAX_FREETEXT_LENGTH): string | null {
  if (typeof v !== 'string') return null;
  return v.length > max ? v.slice(0, max) : v;
}

/**
 * Validate a LearningSource on RECEIVE: discoveredAt ISO-clamped, every free-text
 * sub-field length-clamped + jailed (a path-shaped source field is dropped). Returns
 * the clamped source (always with a discoveredAt — a non-date coerces to epoch-0, the
 * manager's tolerant-read posture) or null to reject the whole record only when the
 * value is not an object.
 */
function validateSource(raw: unknown, ctx: StoreValidateContext): LearningSource | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const discoveredAt = isIso8601(s.discoveredAt) ? (s.discoveredAt as string) : new Date(0).toISOString();
  const out: LearningSource = { discoveredAt };
  // Optional free-text sub-fields — present only when a clean clamped string. A
  // path-shaped contentId (a record/thread id is never path-shaped) is dropped.
  const agent = clampFreeText(s.agent);
  if (agent !== null && agent.length > 0 && jailStoreStringField(agent, ctx) !== null) out.agent = agent;
  const platform = clampFreeText(s.platform, MAX_CATEGORY_LENGTH);
  if (platform !== null && platform.length > 0 && jailStoreStringField(platform, ctx) !== null) out.platform = platform;
  const contentId = clampFreeText(s.contentId);
  if (contentId !== null && contentId.length > 0 && jailStoreStringField(contentId, ctx) !== null) out.contentId = contentId;
  const session = clampFreeText(s.session);
  if (session !== null && session.length > 0 && jailStoreStringField(session, ctx) !== null) out.session = session;
  return out;
}

/**
 * The `learning-record` store schema — a DISCRIMINATED UNION on `op`. Strict typed
 * validation on top of the envelope: reject free text beyond the known fields,
 * TYPE-CLAMP every known field (discoveredAt ISO-8601, applied boolean, tags string[],
 * description/free text length-clamped) so markup cannot smuggle through a render slot
 * that bypasses sanitize(). Returns the validated store-specific object (known fields
 * only), or null to reject the WHOLE record. PURE (no I/O, no mutation of `raw`).
 *
 * The envelope validator has ALREADY validated `op` ∈ {put,delete} before calling this.
 * We branch on it so a tombstone `{recordKey, op:'delete', hlc, origin, deletedAt}`
 * passes (only `deletedAt` is a legal store field for a delete) WITHOUT being marked
 * invalid by the rich VALUE schema.
 */
export const learningRecordStoreSchema: StoreFieldSchema = {
  knownFields: ALL_KNOWN_FIELDS,
  validate(raw: Readonly<Record<string, unknown>>, ctx: StoreValidateContext): Record<string, unknown> | null {
    const op = raw.op;

    // ── DELETE (tombstone) branch. Only `deletedAt` is a legal store field; any
    //    VALUE field present is counted as a dropped field but does not reject — the
    //    tombstone's recordKey + hlc + op (envelope, already validated) carry the
    //    suppression. ────────────────────────────────────────────────────────────
    if (op === 'delete') {
      const deletedAt = isIso8601(raw.deletedAt) ? (raw.deletedAt as string) : undefined;
      for (const k of Object.keys(raw)) {
        if (k === 'op' || k === 'deletedAt') continue;
        if (LEARNING_STORE_KNOWN_FIELDS.includes(k)) ctx.countDroppedField();
      }
      return deletedAt !== undefined ? { deletedAt } : {};
    }

    // ── VALUE (put) branch. ──────────────────────────────────────────────────
    // title — required non-empty free text, clamped.
    const title = clampFreeText(raw.title);
    if (title === null || title.length === 0) return null;

    // category — required non-empty short slug, clamped.
    const category = clampFreeText(raw.category, MAX_CATEGORY_LENGTH);
    if (category === null || category.length === 0) return null;

    // description — free text, length-clamped on receive (a flood is bounded).
    const description = typeof raw.description === 'string'
      ? (raw.description.length > MAX_DESCRIPTION_LENGTH ? raw.description.slice(0, MAX_DESCRIPTION_LENGTH) : raw.description)
      : '';

    // source — required object, type-clamped (discoveredAt ISO, sub-fields clamped).
    const source = validateSource(raw.source, ctx);
    if (source === null) return null;

    // applied — strict BOOLEAN (a non-boolean is rejected; markup cannot survive a
    // boolean slot). This is a load-bearing local-merge field (fork #3).
    if (typeof raw.applied !== 'boolean') return null;
    const applied = raw.applied;

    // tags — array of clamped strings, ≤ MAX_TAGS.
    const tags = Array.isArray(raw.tags)
      ? raw.tags
          .filter((t): t is string => typeof t === 'string')
          .slice(0, MAX_TAGS)
          .map((t) => (t.length > MAX_FREETEXT_LENGTH ? t.slice(0, MAX_FREETEXT_LENGTH) : t))
      : [];

    const out: Record<string, unknown> = {
      title,
      category,
      description,
      source,
      applied,
      tags,
    };

    // Optional clamped free-text fields — present only when valid.
    const appliedTo = raw.appliedTo !== undefined ? clampFreeText(raw.appliedTo) : null;
    if (appliedTo !== null && appliedTo.length > 0) out.appliedTo = appliedTo;
    const evolutionRelevance = raw.evolutionRelevance !== undefined ? clampFreeText(raw.evolutionRelevance) : null;
    if (evolutionRelevance !== null && evolutionRelevance.length > 0) out.evolutionRelevance = evolutionRelevance;

    return out;
  },
};

// ───────────────────────────────────────────────────────────────────────────
// recordKey — the cross-machine IDENTITY SURFACE (fork #1)
// ───────────────────────────────────────────────────────────────────────────

/** Normalize a string for the content fingerprint: trim + lowercase + collapse
 *  internal whitespace, so trivial formatting differences across machines do not
 *  split the same lesson into two records. */
export function normalizeForKey(v: string): string {
  return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Derive the cross-machine-stable recordKey for a learning (fork #1). A lesson is "the
 * same" across machines by its CONTENT, NOT by the per-machine, sequentially-assigned
 * `LRN-NNN` id — VM-A and VM-B mint different LRN ids for the same lesson, so an
 * id-keyed record could never collide them (exactly the relationship-UUID trap WS2.3
 * solved with the channel-set key).
 *
 * The key is a deterministic, collision-resistant hash:
 *   sha256(normalize(title) + '\x1f' + normalize(category) + '\x1f' + (source.contentId || source.discoveredAt))
 * hex-truncated to 32 chars (the same shape UnionReader.conflictId uses). The `\x1f`
 * (unit separator) is an un-typeable delimiter so two lessons cannot collide by
 * straddling the field boundary (e.g. title "a" + category "b" vs title "a b").
 *
 * `source.contentId` (a post/thread id) is the stronger disambiguator when present —
 * two distinct lessons from different content never collide even with the same
 * title+category; when ABSENT we fall back to `source.discoveredAt`. Returns null when
 * title OR category is empty (a degenerate record with no stable identity surface — the
 * caller skips emission; it can never collide a stranger by an empty key).
 *
 * COLLISION SAFETY: two DIFFERENT lessons share a key ONLY if they share the EXACT same
 * normalized title AND category AND (contentId || discoveredAt) — which IS the
 * definition of "the same lesson". SPLIT-IDENTITY SAFETY: the same lesson derives the
 * SAME key on both machines IFF both hold the same title/category/content anchor; the
 * normalization absorbs trivial formatting drift.
 */
export function deriveLearningRecordKey(title: string, category: string, source: LearningSource): string | null {
  const t = normalizeForKey(title ?? '');
  const c = normalizeForKey(category ?? '');
  if (t.length === 0 || c.length === 0) return null;
  const anchor = (typeof source?.contentId === 'string' && source.contentId.trim().length > 0)
    ? source.contentId.trim()
    : (typeof source?.discoveredAt === 'string' ? source.discoveredAt.trim() : '');
  const h = createHash('sha256');
  h.update(`${t}\x1f${c}\x1f${anchor}`);
  return h.digest('hex').slice(0, 32);
}

// ───────────────────────────────────────────────────────────────────────────
// B. Emit — LearningEntry → disclosure-minimized replicated `data`
// ───────────────────────────────────────────────────────────────────────────

/** The `data` object a `learning-record` journal entry carries. */
export type LearningRecordData = Record<string, unknown>;

/** Input to buildLearningRecordData: the record to emit, the freshly-ticked hlc, this
 *  machine's origin id, and the observed-witness (the hlc already merged for THIS
 *  recordKey before writing, or absent). */
export interface BuildLearningRecordInput {
  record: LearningEntry;
  hlc: HlcTimestamp;
  origin: string;
  observed?: HlcTimestamp;
}

/** The named error a record-over-cap surfaces: not silent-truncate, not suspect-wedge. */
export class LearningRecordTooLargeError extends Error {
  constructor(public readonly recordKey: string, public readonly bytes: number) {
    super(`learning-record ${recordKey} is ${bytes} bytes after projection — over the ${LEARNING_MAX_ENTRY_BYTES}-byte per-entry cap; not replicated`);
    this.name = 'LearningRecordTooLargeError';
  }
}

function clampFreeTextEmit(v: string, max = MAX_FREETEXT_LENGTH): string {
  return typeof v === 'string' && v.length > max ? v.slice(0, max) : (v ?? '');
}

/** Emit-side disclosure-minimized source projection: the enumerated source sub-fields
 *  ONLY, each clamped to the receive-side maxima (so a legal record round-trips). */
function projectSource(source: LearningSource): Record<string, unknown> {
  const out: Record<string, unknown> = { discoveredAt: source.discoveredAt };
  if (source.agent) out.agent = clampFreeTextEmit(source.agent);
  if (source.platform) out.platform = clampFreeTextEmit(source.platform, MAX_CATEGORY_LENGTH);
  if (source.contentId) out.contentId = clampFreeTextEmit(source.contentId);
  if (source.session) out.session = clampFreeTextEmit(source.session);
  return out;
}

/**
 * Build the disclosure-minimized `learning-record` envelope `data` for an `op:'put'`.
 * Emits ONLY the enumerated projection — NEVER the raw on-disk blob, NEVER the local
 * `LRN-NNN` id. recordKey = the derived content-fingerprint identity surface (fork #1).
 *
 * Returns null when the record has no stable identity surface (empty title/category ⇒
 * deriveLearningRecordKey null — the caller skips emission). Throws
 * LearningRecordTooLargeError when the projection STILL exceeds the 64KB per-entry cap
 * (a NAMED, surfaced rejection — never silent-truncate).
 */
export function buildLearningRecordData(input: BuildLearningRecordInput): LearningRecordData | null {
  const { record, hlc, origin, observed } = input;
  const recordKey = deriveLearningRecordKey(record.title, record.category, record.source);
  if (recordKey === null) return null;

  const data: LearningRecordData = {
    title: clampFreeTextEmit(record.title),
    category: clampFreeTextEmit(record.category, MAX_CATEGORY_LENGTH),
    description: typeof record.description === 'string'
      ? (record.description.length > MAX_DESCRIPTION_LENGTH ? record.description.slice(0, MAX_DESCRIPTION_LENGTH) : record.description)
      : '',
    source: projectSource(record.source),
    applied: record.applied === true,
    tags: Array.isArray(record.tags) ? record.tags.slice(0, MAX_TAGS).map((t) => clampFreeTextEmit(t)) : [],
    // envelope fields (recordKey = identity surface).
    recordKey,
    hlc,
    op: 'put' as ReplicatedOp,
    origin,
    ...(observed !== undefined ? { observed } : {}),
  };
  // Optional fields — only when present (the local LRN id is NEVER among them).
  if (record.appliedTo) data.appliedTo = clampFreeTextEmit(record.appliedTo);
  if (record.evolutionRelevance) data.evolutionRelevance = clampFreeTextEmit(record.evolutionRelevance);

  assertProjectionUnderCap(recordKey, data);
  return data;
}

/** Throw LearningRecordTooLargeError if the projected data serializes over the
 *  per-entry cap. The cap is set so a legal disclosure-minimized record can never reach
 *  it; this is the belt-and-suspenders named rejection. */
export function assertProjectionUnderCap(recordKey: string, data: LearningRecordData): void {
  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf-8');
  if (bytes > LEARNING_MAX_ENTRY_BYTES) {
    throw new LearningRecordTooLargeError(recordKey, bytes);
  }
}

/** Input to buildLearningTombstoneData: the title/category/source of the deleted
 *  learning (to derive the recordKey identity surface), the freshly-ticked hlc, the
 *  origin, and the deletedAt timestamp. */
export interface BuildLearningTombstoneInput {
  title: string;
  category: string;
  source: LearningSource;
  hlc: HlcTimestamp;
  origin: string;
  deletedAt: string;
  observed?: HlcTimestamp;
}

/**
 * Build an `op:'delete'` TOMBSTONE `data` for a learning removal/prune. recordKey = the
 * SAME content-fingerprint identity surface the value records key on, so the tombstone
 * reaches the same lesson's record on every machine even though the local LRN ids
 * differ. Returns null when title/category are empty (no identity surface to tombstone).
 *
 * CRITICAL (fork-adjacent): the EvolutionManager prune-over-maxLearnings path MUST call
 * this for each pruned learning, else a peer re-replicates the locally-pruned learning
 * forever (resurrection). The delete-resurrection guard lives in the merge (a later
 * `delete` hlc wins over an earlier `put`).
 */
export function buildLearningTombstoneData(input: BuildLearningTombstoneInput): LearningRecordData | null {
  const recordKey = deriveLearningRecordKey(input.title, input.category, input.source);
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
// C. Union-aware read — HIGH-impact append-both, ADVISORY at the read layer (fork #2)
// ───────────────────────────────────────────────────────────────────────────

/** A merged learning view entry: the projected record fields PLUS its origin machine
 *  id (so a foreign record is rendered inside the untrusted-data envelope). READ-ONLY —
 *  NEVER written back into the local store. */
export interface MergedLearningView {
  recordKey: string;
  origin: string;
  /** The validated, type-clamped projection fields (the receive-side schema already
   *  ran on apply; here `data` is that validated portion). */
  data: Record<string, unknown>;
  /** True when this view entry is one of ≥2 concurrent variants of an OPEN conflict
   *  (append-both — both surface as advisory hints; the read NEVER suppresses a usable
   *  view AND NEVER blocks on the unresolved conflict). */
  conflicted: boolean;
}

/** Reconstruct a MergedLearningView from an OriginRecord (the envelope stripped). */
function viewFromOriginRecord(rec: OriginRecord, conflicted: boolean): MergedLearningView {
  return { recordKey: rec.envelope.recordKey, origin: rec.origin, data: rec.data, conflicted };
}

/**
 * Collapse a `Map<recordKey, UnionResult>` into the merged learning view.
 * HIGH-impact-at-replication / ADVISORY-at-read contract (fork #2):
 *   - A resolved single value ⇒ that one view entry.
 *   - An OPEN concurrent conflict ⇒ BOTH (all) `put` variants as separate entries
 *     (append-both — both surface as ADVISORY guidance; the read NEVER suppresses a
 *     usable view AND NEVER BLOCKS waiting on operator resolution — a learning is
 *     guidance, not authority). A `delete` variant contributes nothing to display.
 *   - A delete-resolved key (every origin's latest is a tombstone) ⇒ nothing (the
 *     delete-resurrection guard: a later delete wins over an earlier put).
 * The read is READ-ONLY: a replicated record NEVER clobbers a divergent local record —
 * the local store files are never written here.
 */
export function mergeUnionToLearnings(union: Map<string, UnionResult>): MergedLearningView[] {
  const out: MergedLearningView[] = [];
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
// E. Foreign-record render safety — quoted untrusted data
// ───────────────────────────────────────────────────────────────────────────

/** Sanitize a string for inclusion in a context block (escape the envelope-break +
 *  markup vectors). */
function sanitize(s: string): string {
  return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render a FOREIGN (replicated) learning record into a session-context block, wrapped
 * in an explicit `<replicated-untrusted-data origin="…">` envelope so the session model
 * treats it as a PEER'S learning to re-ground against, never a directive. EVERY rendered
 * field is escaped — there is no "trusted because machine-set" slot. A null `data.title`
 * (a malformed view) yields null.
 */
export function renderForeignLearningContext(view: MergedLearningView): string | null {
  const d = view.data;
  if (typeof d.title !== 'string' || d.title.length === 0) return null;
  const safeOrigin = sanitize(view.origin);
  const lines: string[] = [
    `<replicated-untrusted-data origin="${safeOrigin}">`,
    `Learning: ${sanitize(d.title)}`,
  ];
  if (typeof d.category === 'string') lines.push(`Category: ${sanitize(d.category)}`);
  if (typeof d.applied === 'boolean') lines.push(`Applied: ${d.applied ? 'yes' : 'no'}`);
  if (typeof d.appliedTo === 'string' && d.appliedTo.length > 0) lines.push(`Applied to: ${sanitize(d.appliedTo)}`);
  if (Array.isArray(d.tags) && d.tags.length > 0) lines.push(`Tags: ${(d.tags as string[]).map(sanitize).join(', ')}`);
  if (d.source && typeof d.source === 'object') {
    const src = d.source as Record<string, unknown>;
    if (typeof src.discoveredAt === 'string') lines.push(`Discovered: ${sanitize(src.discoveredAt)}`);
    if (typeof src.agent === 'string') lines.push(`From: ${sanitize(src.agent)}`);
    if (typeof src.platform === 'string') lines.push(`Platform: ${sanitize(src.platform)}`);
  }
  if (typeof d.evolutionRelevance === 'string' && d.evolutionRelevance.length > 0) {
    lines.push(`Evolution relevance: ${sanitize(d.evolutionRelevance)}`);
  }
  if (typeof d.description === 'string' && d.description.length > 0) lines.push(`Details: ${sanitize(d.description)}`);
  lines.push('</replicated-untrusted-data>');
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// Own-origin materialization for the union reader (mirrors WS2.3)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build an OriginRecord for the OWN learning store (the single-origin materialization
 * the union reader merges against peer replicas). recordKey = derived content-
 * fingerprint identity surface; the envelope carries a SYNTHETIC own-origin HLC stamp
 * derived deterministically from the source.discoveredAt (physical) so the own record
 * has a well-formed, stable position relative to peer records. Returns null for a
 * degenerate record (no identity surface). The local `LRN-NNN` id is NEVER carried into
 * the replicated namespace.
 */
export function learningToOriginRecord(record: LearningEntry, origin: string): OriginRecord | null {
  const recordKey = deriveLearningRecordKey(record.title, record.category, record.source);
  if (recordKey === null) return null;
  const physical = Date.parse(record.source?.discoveredAt ?? '');
  const hlc: HlcTimestamp = {
    physical: Number.isFinite(physical) ? physical : 0,
    // `applied` nudges the logical clock so a later applied-true edit positions after
    // the original unapplied put (fork #3 last-writer-witness, single conflict path).
    logical: record.applied ? 1 : 0,
    node: origin,
  };
  const data: Record<string, unknown> = {
    title: record.title,
    category: record.category,
    description: record.description ?? '',
    source: projectSource(record.source),
    applied: record.applied === true,
    tags: Array.isArray(record.tags) ? record.tags : [],
  };
  if (record.appliedTo) data.appliedTo = record.appliedTo;
  if (record.evolutionRelevance) data.evolutionRelevance = record.evolutionRelevance;
  const envelope: ReplicatedEnvelope = { recordKey, hlc, op: 'put', origin };
  return { origin, envelope, data };
}

// ───────────────────────────────────────────────────────────────────────────
// Registration descriptor (consumed by server.ts to register the dual registry)
// ───────────────────────────────────────────────────────────────────────────

/** The ReplicatedKindRegistry registration for the `learning-record` store. server.ts
 *  registers this onto the shared registry; the dual-registry coupling test asserts
 *  `kind` is also present in JOURNAL_KINDS. */
export const LEARNING_KIND_REGISTRATION = {
  kind: LEARNING_RECORD_KIND,
  store: LEARNING_STORE_KEY,
  schema: learningRecordStoreSchema,
} as const;

/** Convenience: the store's contributing journal kinds (for rollback-unmerge's
 *  kindsForStore('learnings') wiring). */
export function learningContributingKinds(): string[] {
  return [LEARNING_RECORD_KIND];
}

/** The store's impact tier resolver, for ReplicatedStoreReader.tierOf. Returns HIGH for
 *  the `learnings` store (and HIGH for any unknown store — the conservative
 *  append-both-and-flag direction, never a silent clobber). */
export function learningTierOf(_store: string): ImpactTier {
  return LEARNING_IMPACT_TIER;
}

/** Re-export the envelope type for callers building/applying learning-record envelopes. */
export type { ReplicatedEnvelope };
