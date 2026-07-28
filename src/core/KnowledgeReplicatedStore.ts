/**
 * KnowledgeReplicatedStore — the FOURTH concrete consumer of the HLC replicated-store
 * foundation (WS2.4) and the THIRD memory-family kind (after WS2.3 relationships and
 * WS2.2 learnings). It layers the `knowledge-record` replicated kind onto the generic
 * substrate (ReplicatedRecordEnvelope / UnionReader / ConflictStore / RollbackUnmerge /
 * ReplicationBudget / StoreSnapshot) so that a knowledge SOURCE the agent ingested on
 * machine A is known on machine B — ONE knowledge catalog, not one-per-machine.
 *
 * It is the literal analog of `LearningsReplicatedStore.ts` (the WS2.2 memory-family
 * reference consumer) and `RelationshipsReplicatedStore.ts` (the WS2.3 PII reference
 * consumer). A knowledge source is a POINTER + SUMMARY (a `title`/`url`/`type` +
 * `summary`/`tags`/`wordCount`), lower-PII than a relationship — but its
 * `title`/`summary`/`url` CAN reference people or content, so it REUSES the established
 * PII machinery (type-clamp, disclosure-min projection, tombstones, flag-coherence)
 * rather than reinventing or downgrading it. THIS IS PURE LOGIC. No fs, no Date directly,
 * no network. It defines:
 *
 *   A. The `knowledge-record` store schema — a STRICT typed validator that
 *      TYPE-CLAMPS every known field: `ingestedAt` ISO-8601-only, `type` ∈ the
 *      {article,transcript,doc} enum, `wordCount` a finite number, `tags[]`/free text
 *      length-clamped. The schema is a DISCRIMINATED UNION on `op` — an `op:'put'` VALUE
 *      schema AND an `op:'delete'` TOMBSTONE schema coexist under the one kind, so a
 *      tombstone is never marked invalid by the value schema.
 *
 *   B. The disclosure-minimized PROJECTION (fork #2) — `buildKnowledgeRecordData` emits
 *      ONLY the enumerated catalog-metadata fields, NEVER the markdown file BODY (the
 *      separate `filePath` file can be a huge transcript — full-content sync is a
 *      TRACKED follow-up, CMT-1416) and NEVER the local generated `id` OR the local
 *      `filePath` (a per-machine artifact path — meaningless and a mild info-leak on a
 *      peer). `recordKey` is the cross-machine IDENTITY SURFACE, derived deterministically
 *      from the stable content (normalize(url || title) + normalize(type)) — never the
 *      per-machine `generateId()` id (the cross-machine-UNSTABLE id, exactly the
 *      relationship-UUID / LRN-id trap the prior kinds solved with a stable identity
 *      surface). The SAME article ingested on two machines collapses to ONE record.
 *
 *   C. The TOMBSTONE builder — `buildKnowledgeTombstoneData` emits an `op:'delete'`
 *      record `{ recordKey, op, hlc, origin, deletedAt }` so a `remove()` propagates as a
 *      positive signal across an offline-then-rejoining peer instead of a record absence.
 *      CRITICAL: the KnowledgeManager.remove() path MUST emit a tombstone per removed
 *      source, else a peer re-replicates the locally-removed source forever (resurrection).
 *
 *   D. The union-aware read — `mergeUnionToKnowledge` collapses a
 *      `Map<recordKey, UnionResult>` into the merged catalog view. Knowledge is
 *      HIGH-impact at the REPLICATION layer (a concurrent divergent edit to the SAME
 *      recordKey — e.g. two machines re-summarize the same url differently — goes through
 *      APPEND-BOTH-AND-FLAG; both versions surface, never a silent clobber). The CONSUMER
 *      READ path is ADVISORY (fork #3): it injects BOTH variants of an open conflict as
 *      guidance — a knowledge source is REFERENCE, not authority — and NEVER blocks on an
 *      unresolved conflict. The read NEVER writes a foreign record into the local store.
 *
 *   E. Foreign-record render safety — `renderForeignKnowledgeContext` wraps a replicated
 *      record in an explicit `<replicated-untrusted-data origin="…">` envelope and
 *      sanitizes EVERY rendered field. There is no "trusted because machine-set" render
 *      slot for a foreign record.
 *
 * DECIDED FORKS (Echo, 2026-06-13 — recorded verbatim in the PR ELI16):
 *   1. recordKey = a content fingerprint over the STABLE source identity
 *      (sha256(normalize(url || title) + '\x1f' + normalize(type))), NEVER the local
 *      generated `id` (cross-machine identity surface — see deriveKnowledgeRecordKey).
 *   2. Replicate the CATALOG ENTRY (metadata) ONLY — NOT the markdown file body. The
 *      projection carries { title, url, type, ingestedAt, tags[], summary, wordCount }
 *      and STRIPS the local `id` + `filePath`. Full-content-body sync is a TRACKED
 *      follow-up (CMT-1416).
 *   3. Impact tier = HIGH at the REPLICATION layer (append-both-and-flag), ADVISORY at
 *      the READ layer (both variants injected as hints, never blocking) — a knowledge
 *      source is reference, not authority. See mergeUnionToKnowledge + KNOWLEDGE_IMPACT_TIER.
 *
 * SAFETY POSTURE: MECHANISM, dark by default. Nothing here blocks a user-initiated
 * action. The local `id` + `filePath` are NEVER part of the replicated schema and are
 * stripped from every emitted projection (disclosure minimization).
 */

import { createHash } from 'node:crypto';

import type { KnowledgeSource } from '../knowledge/KnowledgeManager.js';
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
 *  `multiMachine.stateSync.knowledge.enabled`). Equal to the advert flag key
 *  `stateSyncReceive['knowledge']`. */
export const KNOWLEDGE_STORE_KEY = 'knowledge';

/** The JournalKind string this store rides — the DUAL-REGISTRY's dynamic half.
 *  MUST also be present in CoherenceJournal.JOURNAL_KINDS (the static half), or the
 *  store advertises receive=true yet serves/applies/pulls nothing. */
export const KNOWLEDGE_RECORD_KIND = 'knowledge-record';

/**
 * Knowledge is HIGH-impact at the REPLICATION layer (fork #3): a concurrent divergent
 * VALUE edit to the SAME recordKey from different origins goes through
 * APPEND-BOTH-AND-FLAG — both versions preserved, ONE deduped conflict, never a silent
 * overwrite. The READ path (mergeUnionToKnowledge) is ADVISORY — both variants surface as
 * guidance hints, the read never blocks on an open conflict — a knowledge source is
 * reference, not authority. Operator resolution via POST /state/resolve-conflict is
 * OPTIONAL cleanup that collapses the flag, never a gate on the hint.
 */
export const KNOWLEDGE_IMPACT_TIER: ImpactTier = 'high';

/** The valid `type` enum for a knowledge source (KnowledgeManager.KnowledgeSource). A
 *  foreign record whose `type` is outside this set is REJECTED (markup cannot survive an
 *  enum slot). */
export const KNOWLEDGE_TYPES: ReadonlyArray<string> = Object.freeze(['article', 'transcript', 'doc']);

// ── Local-record caps mirrored on RECEIVE (length-clamp discipline). A value over a
//    cap REJECTS the whole record (never truncate-and-accept), EXCEPT free text which
//    is length-clamped on receive (a flood is bounded, not record-rejected). ───────
/** A knowledge `summary` can be a paragraph. Clamp on receive (NOT the file body — the
 *  body is never replicated; only this short catalog summary crosses the wire). */
export const MAX_SUMMARY_LENGTH = 20_000;
/** Per-free-text-string clamp for title / each tag. */
export const MAX_FREETEXT_LENGTH = 2_000;
/** A url is bounded (the catalog url; never a file body). */
export const MAX_URL_LENGTH = 2_048;
/** Tags cap (mirrors a reasonable per-source tag count). */
export const MAX_TAGS = 50;

/**
 * Per-kind replication bounds. The knowledge store is FEW + bounded (a catalog of
 * ingested sources), so the per-store retention mirrors the learning-record sibling (a
 * small window with a few archives). NEVER `rotateKeep: 0` (rotate-but-never-delete
 * would be a compliance defect for any memory-family kind). The rate cap COALESCES
 * (latest state per recordKey per interval) so a churny re-ingest loop does not flood
 * the stream.
 */
export const KNOWLEDGE_RECORD_BOUNDS: ReplicatedKindBounds = {
  retention: { maxFileBytes: 4 * 1024 * 1024, rotateKeep: 4 },
  // Few records, coalesced: capacity is the burst, refill the sustained rate.
  rateCap: { capacity: 30, refillPerSec: 5 },
};

/**
 * Per-entry size cap RAISED to 64KB for this kind. The default
 * APPLIER_MAX_ENTRY_BYTES = 8KB is SMALLER than a fat knowledge summary (a 20K summary
 * alone exceeds it), so under it the longest summaries would never replicate AND would
 * wedge the stream. 64KB is provably above the disclosure-minimized projection's maximum:
 * summary(20k) is the dominant term — we additionally enforce a HARD post-projection
 * ceiling: a record that STILL exceeds 64KB after projection is REJECTED with a named
 * error (never silent-truncate, never suspect-wedge). See assertProjectionUnderCap.
 */
export const KNOWLEDGE_MAX_ENTRY_BYTES = 64 * 1024;

/**
 * The store-specific field names the `knowledge-record` VALUE schema OWNS (the
 * unknown-field counter's allowlist). The local generated `id` AND the local `filePath`
 * are DELIBERATELY ABSENT — `id` is per-machine + generated and `filePath` is a local
 * artifact path; NEITHER is replicated (the recordKey keys on the content fingerprint,
 * not the id; the body the filePath points at is a tracked follow-up, CMT-1416).
 * `recordKey`/`hlc`/`op`/`origin`/`observed` are reserved envelope fields, never store
 * fields.
 */
export const KNOWLEDGE_STORE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'title',
  'url',
  'type',
  'ingestedAt',
  'tags',
  'summary',
  'wordCount',
]);

/** The tombstone's store-owned fields beyond the reserved envelope set. `deletedAt`
 *  is the only store field a delete carries. */
export const KNOWLEDGE_TOMBSTONE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'deletedAt',
]);

/** The full set of known store fields across BOTH op-branches (the schema's
 *  knownFields the registry uses for unknown-field counting — a field legal in EITHER
 *  branch is "known", and the branch validate() enforces which is legal for THIS op). */
const ALL_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  ...KNOWLEDGE_STORE_KNOWN_FIELDS,
  ...KNOWLEDGE_TOMBSTONE_KNOWN_FIELDS,
]);

// ── ISO-8601 type-clamp: ingestedAt is the load-bearing date field. On a foreign
//    record it MUST validate as a real date or be normalized, so markup cannot survive
//    the clamp. ──────────────────────────────────────────────────────────────────

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
 * The `knowledge-record` store schema — a DISCRIMINATED UNION on `op`. Strict typed
 * validation on top of the envelope: reject free text beyond the known fields,
 * TYPE-CLAMP every known field (`ingestedAt` ISO-8601, `type` enum, `wordCount` finite
 * number, `tags`/`summary`/`title` length-clamped, `url` jailed against a path-shaped
 * value) so markup cannot smuggle through a render slot that bypasses sanitize().
 * Returns the validated store-specific object (known fields only), or null to reject the
 * WHOLE record. PURE (no I/O, no mutation of `raw`).
 *
 * The envelope validator has ALREADY validated `op` ∈ {put,delete} before calling this.
 * We branch on it so a tombstone `{recordKey, op:'delete', hlc, origin, deletedAt}`
 * passes (only `deletedAt` is a legal store field for a delete) WITHOUT being marked
 * invalid by the rich VALUE schema.
 */
export const knowledgeRecordStoreSchema: StoreFieldSchema = {
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
        if (KNOWLEDGE_STORE_KNOWN_FIELDS.includes(k)) ctx.countDroppedField();
      }
      return deletedAt !== undefined ? { deletedAt } : {};
    }

    // ── VALUE (put) branch. ──────────────────────────────────────────────────
    // title — required non-empty free text, clamped.
    const title = clampFreeText(raw.title);
    if (title === null || title.length === 0) return null;

    // type — required enum membership (markup cannot survive an enum slot).
    if (typeof raw.type !== 'string' || !KNOWLEDGE_TYPES.includes(raw.type)) return null;
    const type = raw.type;

    // ingestedAt — required ISO-8601. A non-date coerces to epoch-0 (tolerant-read
    // posture, the manager treats catalog dates as soft) — never record-rejects, but
    // markup can never survive the clamp.
    const ingestedAt = isIso8601(raw.ingestedAt) ? (raw.ingestedAt as string) : new Date(0).toISOString();

    // url — OPTIONAL (null when absent). A url is path-sensitive: jail it against a
    // path-shaped value (defense-in-depth — a peer could smuggle a relative artifact
    // path into `url`). null when absent, jailed-out, or over-cap-clamped.
    let url: string | null = null;
    if (typeof raw.url === 'string' && raw.url.length > 0) {
      const clampedUrl = raw.url.length > MAX_URL_LENGTH ? raw.url.slice(0, MAX_URL_LENGTH) : raw.url;
      url = jailStoreStringField(clampedUrl, ctx) !== null ? clampedUrl : null;
    }

    // summary — free text, length-clamped on receive (a flood is bounded). NEVER the
    // markdown file body — only this short catalog summary crosses the wire (fork #2).
    const summary = typeof raw.summary === 'string'
      ? (raw.summary.length > MAX_SUMMARY_LENGTH ? raw.summary.slice(0, MAX_SUMMARY_LENGTH) : raw.summary)
      : '';

    // wordCount — a FINITE number (a non-finite/non-number coerces to 0; markup cannot
    // survive a numeric slot).
    const wordCount = typeof raw.wordCount === 'number' && Number.isFinite(raw.wordCount) ? raw.wordCount : 0;

    // tags — array of clamped strings, ≤ MAX_TAGS.
    const tags = Array.isArray(raw.tags)
      ? raw.tags
          .filter((t): t is string => typeof t === 'string')
          .slice(0, MAX_TAGS)
          .map((t) => (t.length > MAX_FREETEXT_LENGTH ? t.slice(0, MAX_FREETEXT_LENGTH) : t))
      : [];

    return {
      title,
      url,
      type,
      ingestedAt,
      tags,
      summary,
      wordCount,
    };
  },
};

// ───────────────────────────────────────────────────────────────────────────
// recordKey — the cross-machine IDENTITY SURFACE (fork #1)
// ───────────────────────────────────────────────────────────────────────────

/** Normalize a string for the content fingerprint: trim + lowercase + collapse
 *  internal whitespace, so trivial formatting differences across machines do not split
 *  the same source into two records. */
export function normalizeForKey(v: string): string {
  return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Derive the cross-machine-stable recordKey for a knowledge source (fork #1). A source is
 * "the same" across machines by its STABLE CONTENT IDENTITY, NOT by the per-machine
 * `generateId()` id — VM-A and VM-B mint different `kb_…` ids for the same article, so an
 * id-keyed record could never collide them (exactly the relationship-UUID / LRN-id trap
 * the prior kinds solved with a stable identity surface).
 *
 * The key is a deterministic, collision-resistant hash:
 *   sha256(normalize(url || title) + '\x1f' + normalize(type))
 * hex-truncated to 32 chars (the same shape UnionReader.conflictId uses). The `\x1f`
 * (unit separator) is an un-typeable delimiter so two sources cannot collide by
 * straddling the field boundary.
 *
 * `url` is the NATURAL identity when present (the same article fetched on two machines
 * has the same url even if its title was edited); when ABSENT we fall back to the title.
 * Returns null when the identity anchor (url || title) is empty (a degenerate record with
 * no stable identity surface — the caller skips emission; it can never collide a stranger
 * by an empty key).
 *
 * COLLISION SAFETY: two DIFFERENT sources share a key ONLY if they share the EXACT same
 * normalized (url || title) AND type — which IS the definition of "the same source".
 * SPLIT-IDENTITY SAFETY: the same source derives the SAME key on both machines IFF both
 * hold the same anchor + type; the normalization absorbs trivial formatting drift.
 */
export function deriveKnowledgeRecordKey(title: string, url: string | null | undefined, type: string): string | null {
  const anchor = (typeof url === 'string' && url.trim().length > 0)
    ? normalizeForKey(url)
    : normalizeForKey(title ?? '');
  const t = normalizeForKey(type ?? '');
  if (anchor.length === 0) return null;
  const h = createHash('sha256');
  h.update(`${anchor}\x1f${t}`);
  return h.digest('hex').slice(0, 32);
}

// ───────────────────────────────────────────────────────────────────────────
// B. Emit — KnowledgeSource → disclosure-minimized replicated `data` (fork #2)
// ───────────────────────────────────────────────────────────────────────────

/** The `data` object a `knowledge-record` journal entry carries. */
export type KnowledgeRecordData = Record<string, unknown>;

/** Input to buildKnowledgeRecordData: the record to emit, the freshly-ticked hlc, this
 *  machine's origin id, and the observed-witness (the hlc already merged for THIS
 *  recordKey before writing, or absent). */
export interface BuildKnowledgeRecordInput {
  record: KnowledgeSource;
  hlc: HlcTimestamp;
  origin: string;
  observed?: HlcTimestamp;
}

/** The named error a record-over-cap surfaces: not silent-truncate, not suspect-wedge. */
export class KnowledgeRecordTooLargeError extends Error {
  constructor(public readonly recordKey: string, public readonly bytes: number) {
    super(`knowledge-record ${recordKey} is ${bytes} bytes after projection — over the ${KNOWLEDGE_MAX_ENTRY_BYTES}-byte per-entry cap; not replicated`);
    this.name = 'KnowledgeRecordTooLargeError';
  }
}

function clampFreeTextEmit(v: string, max = MAX_FREETEXT_LENGTH): string {
  return typeof v === 'string' && v.length > max ? v.slice(0, max) : (v ?? '');
}

/**
 * Build the disclosure-minimized `knowledge-record` envelope `data` for an `op:'put'`
 * (fork #2). Emits ONLY the enumerated CATALOG-METADATA projection — NEVER the markdown
 * file BODY (the `filePath` file), NEVER the local generated `id`, NEVER the local
 * `filePath` (a local artifact path — meaningless + a mild info-leak on a peer).
 * recordKey = the derived content-fingerprint identity surface (fork #1).
 *
 * Returns null when the record has no stable identity surface (empty url+title ⇒
 * deriveKnowledgeRecordKey null — the caller skips emission). Throws
 * KnowledgeRecordTooLargeError when the projection STILL exceeds the 64KB per-entry cap
 * (a NAMED, surfaced rejection — never silent-truncate).
 */
export function buildKnowledgeRecordData(input: BuildKnowledgeRecordInput): KnowledgeRecordData | null {
  const { record, hlc, origin, observed } = input;
  const recordKey = deriveKnowledgeRecordKey(record.title, record.url, record.type);
  if (recordKey === null) return null;

  const data: KnowledgeRecordData = {
    title: clampFreeTextEmit(record.title),
    // url — emit as a string when present, else null (a NULL url is a legal absence; the
    // local filePath is NEVER emitted — fork #2).
    url: typeof record.url === 'string' && record.url.length > 0
      ? clampFreeTextEmit(record.url, MAX_URL_LENGTH)
      : null,
    type: record.type,
    ingestedAt: record.ingestedAt,
    tags: Array.isArray(record.tags) ? record.tags.slice(0, MAX_TAGS).map((t) => clampFreeTextEmit(t)) : [],
    summary: typeof record.summary === 'string'
      ? (record.summary.length > MAX_SUMMARY_LENGTH ? record.summary.slice(0, MAX_SUMMARY_LENGTH) : record.summary)
      : '',
    wordCount: typeof record.wordCount === 'number' && Number.isFinite(record.wordCount) ? record.wordCount : 0,
    // envelope fields (recordKey = identity surface).
    recordKey,
    hlc,
    op: 'put' as ReplicatedOp,
    origin,
    ...(observed !== undefined ? { observed } : {}),
  };

  assertProjectionUnderCap(recordKey, data);
  return data;
}

/** Throw KnowledgeRecordTooLargeError if the projected data serializes over the
 *  per-entry cap. The cap is set so a legal disclosure-minimized record can never reach
 *  it; this is the belt-and-suspenders named rejection. */
export function assertProjectionUnderCap(recordKey: string, data: KnowledgeRecordData): void {
  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf-8');
  if (bytes > KNOWLEDGE_MAX_ENTRY_BYTES) {
    throw new KnowledgeRecordTooLargeError(recordKey, bytes);
  }
}

/** Input to buildKnowledgeTombstoneData: the title/url/type of the removed source (to
 *  derive the recordKey identity surface), the freshly-ticked hlc, the origin, and the
 *  deletedAt timestamp. */
export interface BuildKnowledgeTombstoneInput {
  title: string;
  url: string | null | undefined;
  type: string;
  hlc: HlcTimestamp;
  origin: string;
  deletedAt: string;
  observed?: HlcTimestamp;
}

/**
 * Build an `op:'delete'` TOMBSTONE `data` for a knowledge-source removal. recordKey = the
 * SAME content-fingerprint identity surface the value records key on, so the tombstone
 * reaches the same source's record on every machine even though the local ids differ.
 * Returns null when the identity anchor (url || title) is empty (no identity surface to
 * tombstone).
 *
 * CRITICAL (fork-adjacent): the KnowledgeManager.remove() path MUST call this for the
 * removed source, else a peer re-replicates the locally-removed source forever
 * (resurrection). The delete-resurrection guard lives in the merge (a later `delete` hlc
 * wins over an earlier `put`).
 */
export function buildKnowledgeTombstoneData(input: BuildKnowledgeTombstoneInput): KnowledgeRecordData | null {
  const recordKey = deriveKnowledgeRecordKey(input.title, input.url, input.type);
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
// C. Union-aware read — HIGH-impact append-both, ADVISORY at the read layer (fork #3)
// ───────────────────────────────────────────────────────────────────────────

/** A merged knowledge view entry: the projected record fields PLUS its origin machine id
 *  (so a foreign record is rendered inside the untrusted-data envelope). READ-ONLY —
 *  NEVER written back into the local store. */
export interface MergedKnowledgeView {
  recordKey: string;
  origin: string;
  /** The validated, type-clamped projection fields (the receive-side schema already ran
   *  on apply; here `data` is that validated portion). */
  data: Record<string, unknown>;
  /** True when this view entry is one of ≥2 concurrent variants of an OPEN conflict
   *  (append-both — both surface as advisory hints; the read NEVER suppresses a usable
   *  view AND NEVER blocks on the unresolved conflict). */
  conflicted: boolean;
}

/** Reconstruct a MergedKnowledgeView from an OriginRecord (the envelope stripped). */
function viewFromOriginRecord(rec: OriginRecord, conflicted: boolean): MergedKnowledgeView {
  return { recordKey: rec.envelope.recordKey, origin: rec.origin, data: rec.data, conflicted };
}

/**
 * Collapse a `Map<recordKey, UnionResult>` into the merged knowledge view.
 * HIGH-impact-at-replication / ADVISORY-at-read contract (fork #3):
 *   - A resolved single value ⇒ that one view entry.
 *   - An OPEN concurrent conflict ⇒ BOTH (all) `put` variants as separate entries
 *     (append-both — both surface as ADVISORY guidance; the read NEVER suppresses a
 *     usable view AND NEVER BLOCKS waiting on operator resolution — a knowledge source is
 *     reference, not authority). A `delete` variant contributes nothing to display.
 *   - A delete-resolved key (every origin's latest is a tombstone) ⇒ nothing (the
 *     delete-resurrection guard: a later delete wins over an earlier put).
 * The read is READ-ONLY: a replicated record NEVER clobbers a divergent local record —
 * the local store files are never written here.
 */
export function mergeUnionToKnowledge(union: Map<string, UnionResult>): MergedKnowledgeView[] {
  const out: MergedKnowledgeView[] = [];
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
 * Render a FOREIGN (replicated) knowledge record into a session-context block, wrapped in
 * an explicit `<replicated-untrusted-data origin="…">` envelope so the session model
 * treats it as a PEER'S knowledge source to re-ground against, never a directive. EVERY
 * rendered field is escaped — there is no "trusted because machine-set" slot. A null
 * `data.title` (a malformed view) yields null.
 */
export function renderForeignKnowledgeContext(view: MergedKnowledgeView): string | null {
  const d = view.data;
  if (typeof d.title !== 'string' || d.title.length === 0) return null;
  const safeOrigin = sanitize(view.origin);
  const lines: string[] = [
    `<replicated-untrusted-data origin="${safeOrigin}">`,
    `Knowledge source: ${sanitize(d.title)}`,
  ];
  if (typeof d.type === 'string') lines.push(`Type: ${sanitize(d.type)}`);
  if (typeof d.url === 'string' && d.url.length > 0) lines.push(`URL: ${sanitize(d.url)}`);
  if (typeof d.ingestedAt === 'string') lines.push(`Ingested: ${sanitize(d.ingestedAt)}`);
  if (Array.isArray(d.tags) && d.tags.length > 0) lines.push(`Tags: ${(d.tags as string[]).map(sanitize).join(', ')}`);
  if (typeof d.wordCount === 'number') lines.push(`Word count: ${d.wordCount}`);
  if (typeof d.summary === 'string' && d.summary.length > 0) lines.push(`Summary: ${sanitize(d.summary)}`);
  lines.push('</replicated-untrusted-data>');
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// Own-origin materialization for the union reader (mirrors WS2.2)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build an OriginRecord for the OWN knowledge store (the single-origin materialization
 * the union reader merges against peer replicas). recordKey = derived content-fingerprint
 * identity surface; the envelope carries a SYNTHETIC own-origin HLC stamp derived
 * deterministically from `ingestedAt` (physical) so the own record has a well-formed,
 * stable position relative to peer records. Returns null for a degenerate record (no
 * identity surface). The local `id` + `filePath` are NEVER carried into the replicated
 * namespace.
 */
export function knowledgeToOriginRecord(record: KnowledgeSource, origin: string): OriginRecord | null {
  const recordKey = deriveKnowledgeRecordKey(record.title, record.url, record.type);
  if (recordKey === null) return null;
  const physical = Date.parse(record.ingestedAt ?? '');
  const hlc: HlcTimestamp = {
    physical: Number.isFinite(physical) ? physical : 0,
    logical: 0,
    node: origin,
  };
  const data: Record<string, unknown> = {
    title: record.title,
    url: typeof record.url === 'string' && record.url.length > 0 ? record.url : null,
    type: record.type,
    ingestedAt: record.ingestedAt,
    tags: Array.isArray(record.tags) ? record.tags : [],
    summary: record.summary ?? '',
    wordCount: typeof record.wordCount === 'number' && Number.isFinite(record.wordCount) ? record.wordCount : 0,
  };
  const envelope: ReplicatedEnvelope = { recordKey, hlc, op: 'put', origin };
  return { origin, envelope, data };
}

// ───────────────────────────────────────────────────────────────────────────
// Registration descriptor (consumed by server.ts to register the dual registry)
// ───────────────────────────────────────────────────────────────────────────

/** The ReplicatedKindRegistry registration for the `knowledge-record` store. server.ts
 *  registers this onto the shared registry; the dual-registry coupling test asserts
 *  `kind` is also present in JOURNAL_KINDS. */
export const KNOWLEDGE_KIND_REGISTRATION = {
  kind: KNOWLEDGE_RECORD_KIND,
  store: KNOWLEDGE_STORE_KEY,
  schema: knowledgeRecordStoreSchema,
} as const;

/** Convenience: the store's contributing journal kinds (for rollback-unmerge's
 *  kindsForStore('knowledge') wiring). */
export function knowledgeContributingKinds(): string[] {
  return [KNOWLEDGE_RECORD_KIND];
}

/** The store's impact tier resolver, for ReplicatedStoreReader.tierOf. Returns HIGH for
 *  the `knowledge` store (and HIGH for any unknown store — the conservative
 *  append-both-and-flag direction, never a silent clobber). */
export function knowledgeTierOf(_store: string): ImpactTier {
  return KNOWLEDGE_IMPACT_TIER;
}

/** Re-export the envelope type for callers building/applying knowledge-record envelopes. */
export type { ReplicatedEnvelope };
