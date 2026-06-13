/**
 * EvolutionActionsReplicatedStore — the FIFTH concrete consumer of the HLC replicated-store
 * foundation (WS2.5) and the FOURTH memory-family kind (after WS2.4 knowledge, WS2.2
 * learnings, and WS2.3 relationships). It layers the `evolution-action-record` replicated
 * kind onto the generic substrate (ReplicatedRecordEnvelope / UnionReader / ConflictStore /
 * RollbackUnmerge / ReplicationBudget / StoreSnapshot) so that a self-improvement ACTION the
 * agent raised on machine A is known on machine B — ONE action queue, not one-per-machine.
 *
 * It is the literal analog of `KnowledgeReplicatedStore.ts` (the WS2.4 reference consumer)
 * and `LearningsReplicatedStore.ts` (the WS2.2 memory-family sibling). An action is a WORK
 * ITEM (a tracked thing the agent committed to do), lower-PII than a relationship — but its
 * `description`/`commitTo` CAN name a person or a platform, so it REUSES the established PII
 * machinery (type-clamp, disclosure-min projection, tombstones, flag-coherence) rather than
 * reinventing or downgrading it. THIS IS PURE LOGIC. No fs, no Date directly, no network. It
 * defines:
 *
 *   A. The `evolution-action-record` store schema — a STRICT typed validator that
 *      TYPE-CLAMPS every known field: `createdAt`/`dueBy`/`completedAt` ISO-8601-or-absent,
 *      `priority` ∈ the {critical,high,medium,low} enum, `status` ∈ the
 *      {pending,in_progress,completed,cancelled} enum, `tags[]`/free text length-clamped.
 *      The schema is a DISCRIMINATED UNION on `op` — an `op:'put'` VALUE schema AND an
 *      `op:'delete'` TOMBSTONE schema coexist under the one kind, so a tombstone is never
 *      marked invalid by the value schema.
 *
 *   B. The disclosure-minimized PROJECTION (fork #1/#2) — `buildEvolutionActionRecordData`
 *      emits ONLY the enumerated action fields, NEVER the local generated `ACT-NNN` id.
 *      `recordKey` is the cross-machine IDENTITY SURFACE, derived deterministically from the
 *      stable content (normalize(title) + normalize(commitTo) + createdAt) — never the
 *      per-machine, sequentially-assigned `ACT-NNN` id (the cross-machine-UNSTABLE id,
 *      exactly the relationship-UUID / LRN-id trap the prior kinds solved with a stable
 *      identity surface). The SAME committed action on two machines collapses to ONE record.
 *
 *   C. The TOMBSTONE builder — `buildEvolutionActionTombstoneData` emits an `op:'delete'`
 *      record `{ recordKey, op, hlc, origin, deletedAt }` so an actual queue-REMOVAL
 *      propagates as a positive signal across an offline-then-rejoining peer instead of a
 *      record absence. CRITICAL: a `completed`/`cancelled` action is a TERMINAL state — its
 *      record is RETAINED (history), NOT tombstoned. Only an action that is actually REMOVED
 *      from the queue (the prune-over-maxActions path) emits a tombstone; else a peer
 *      re-replicates the locally-removed action forever (resurrection).
 *
 *   D. The union-aware read — `mergeUnionToActions` collapses a
 *      `Map<recordKey, UnionResult>` into the merged action view. Actions are HIGH-impact at
 *      the REPLICATION layer (a concurrent divergent VALUE edit to the SAME recordKey — e.g.
 *      machine A marks an action `completed` while B still has it `in_progress` — goes through
 *      APPEND-BOTH-AND-FLAG; both versions surface, never a silent clobber). The CONSUMER
 *      READ path is ADVISORY (fork #3): it injects BOTH variants of an open conflict as
 *      guidance — an action is a work item to surface, not authority — and NEVER blocks on an
 *      unresolved conflict. The read NEVER writes a foreign record into the local store.
 *
 *   E. Foreign-record render safety — `renderForeignActionContext` wraps a replicated record
 *      in an explicit `<replicated-untrusted-data origin="…">` envelope and sanitizes EVERY
 *      rendered field. There is no "trusted because machine-set" render slot for a foreign
 *      record.
 *
 * DECIDED FORKS (Echo, 2026-06-13 — recorded verbatim in the PR ELI16):
 *   1. recordKey = a content fingerprint over the STABLE action identity
 *      (sha256(normalize(title) + '\x1f' + normalize(commitTo || '') + '\x1f' + createdAt)),
 *      NEVER the local `ACT-NNN` id (cross-machine identity surface — see
 *      deriveEvolutionActionRecordKey).
 *   2. `status`/`completedAt`/`priority` are MUTABLE fields → last-writer-witness wins; a
 *      concurrent divergence rides the SAME append-both-and-flag path (NOT a special CRDT
 *      merge). The canonical case: A marks an action `completed` while B still has it
 *      `in_progress` — the witness-ordered later write wins; a genuine concurrent divergence
 *      surfaces both states. A `completed`/`cancelled` action is a TERMINAL state — its record
 *      is retained (history), NOT tombstoned; only an actual queue-REMOVAL tombstones. A
 *      status change MUST re-emit (the whole point — a peer must SEE an action was already
 *      completed elsewhere so it does not redo it).
 *   3. Impact tier = HIGH at the REPLICATION layer (append-both-and-flag), ADVISORY at the
 *      READ layer (both variants injected as hints, never blocking) — see mergeUnionToActions
 *      + EVOLUTION_ACTION_IMPACT_TIER.
 *
 * SAFETY POSTURE: MECHANISM, dark by default. Nothing here blocks a user-initiated action.
 * The local `ACT-NNN` id is NEVER part of the replicated schema and is stripped from every
 * emitted projection (disclosure minimization).
 */

import { createHash } from 'node:crypto';

import type { ActionItem } from './types.js';
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
 *  `multiMachine.stateSync.evolutionActions.enabled`). Equal to the advert flag key
 *  `stateSyncReceive['evolutionActions']`. */
export const EVOLUTION_ACTION_STORE_KEY = 'evolutionActions';

/** The JournalKind string this store rides — the DUAL-REGISTRY's dynamic half.
 *  MUST also be present in CoherenceJournal.JOURNAL_KINDS (the static half), or the
 *  store advertises receive=true yet serves/applies/pulls nothing. */
export const EVOLUTION_ACTION_RECORD_KIND = 'evolution-action-record';

/**
 * Evolution actions are HIGH-impact at the REPLICATION layer (fork #3): a concurrent
 * divergent VALUE edit to the SAME recordKey from different origins goes through
 * APPEND-BOTH-AND-FLAG — both versions preserved, ONE deduped conflict, never a silent
 * overwrite. The READ path (mergeUnionToActions) is ADVISORY — both variants surface as
 * guidance hints, the read never blocks on an open conflict — an action is a work item to
 * surface, not authority. Operator resolution via POST /state/resolve-conflict is OPTIONAL
 * cleanup that collapses the flag, never a gate on the hint.
 */
export const EVOLUTION_ACTION_IMPACT_TIER: ImpactTier = 'high';

/** The valid `priority` enum for an action (ActionItem.priority). A foreign record whose
 *  `priority` is outside this set is REJECTED (markup cannot survive an enum slot). */
export const EVOLUTION_ACTION_PRIORITIES: ReadonlyArray<string> = Object.freeze([
  'critical',
  'high',
  'medium',
  'low',
]);

/** The valid `status` enum for an action (ActionItem.status). A foreign record whose
 *  `status` is outside this set is REJECTED. This is the load-bearing cross-machine field
 *  (fork #2) — a peer must SEE that an action was already completed/in_progress elsewhere. */
export const EVOLUTION_ACTION_STATUSES: ReadonlyArray<string> = Object.freeze([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);

// ── Local-record caps mirrored on RECEIVE (length-clamp discipline). A value over a
//    cap REJECTS the whole record (never truncate-and-accept), EXCEPT free text which
//    is length-clamped on receive (a flood is bounded, not record-rejected). ───────
/** An action `description` can be a paragraph (a full commitment write-up). Clamp on receive. */
export const MAX_DESCRIPTION_LENGTH = 20_000;
/** Per-free-text-string clamp for title / commitTo / resolution / each tag / each source
 *  sub-field. */
export const MAX_FREETEXT_LENGTH = 2_000;
/** Tags cap (mirrors a reasonable per-action tag count). */
export const MAX_TAGS = 50;

/**
 * Per-kind replication bounds. The actions store is FEW + bounded (the EvolutionManager
 * prunes to maxActions=300), so the per-store retention mirrors the learning-record /
 * knowledge-record siblings (a small window with a few archives). NEVER `rotateKeep: 0`
 * (rotate-but-never-delete would be a compliance defect for any memory-family kind). The
 * rate cap COALESCES (latest state per recordKey per interval) so a churny
 * add/updateAction loop does not flood the stream.
 */
export const EVOLUTION_ACTION_RECORD_BOUNDS: ReplicatedKindBounds = {
  retention: { maxFileBytes: 4 * 1024 * 1024, rotateKeep: 4 },
  // Few records, coalesced: capacity is the burst, refill the sustained rate.
  rateCap: { capacity: 30, refillPerSec: 5 },
};

/**
 * Per-entry size cap RAISED to 64KB for this kind. The default
 * APPLIER_MAX_ENTRY_BYTES = 8KB is SMALLER than a fat action (a 20K description alone
 * exceeds it), so under it the longest actions would never replicate AND would wedge the
 * stream. 64KB is provably above the disclosure-minimized projection's maximum:
 * description(20k) is the dominant term — we additionally enforce a HARD post-projection
 * ceiling: a record that STILL exceeds 64KB after projection is REJECTED with a named
 * error (never silent-truncate, never suspect-wedge). See assertProjectionUnderCap.
 */
export const EVOLUTION_ACTION_MAX_ENTRY_BYTES = 64 * 1024;

/**
 * The store-specific field names the `evolution-action-record` VALUE schema OWNS (the
 * unknown-field counter's allowlist). The local `ACT-NNN` id is DELIBERATELY ABSENT — it
 * is per-machine + sequential and never replicated (the recordKey keys on the content
 * fingerprint, not the id). `recordKey`/`hlc`/`op`/`origin`/`observed` are reserved
 * envelope fields, never store fields.
 */
export const EVOLUTION_ACTION_STORE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'title',
  'description',
  'priority',
  'status',
  'commitTo',
  'createdAt',
  'dueBy',
  'completedAt',
  'resolution',
  'source',
  'tags',
]);

/** The tombstone's store-owned fields beyond the reserved envelope set. `deletedAt`
 *  is the only store field a delete carries. */
export const EVOLUTION_ACTION_TOMBSTONE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'deletedAt',
]);

/** The full set of known store fields across BOTH op-branches (the schema's
 *  knownFields the registry uses for unknown-field counting — a field legal in EITHER
 *  branch is "known", and the branch validate() enforces which is legal for THIS op). */
const ALL_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  ...EVOLUTION_ACTION_STORE_KNOWN_FIELDS,
  ...EVOLUTION_ACTION_TOMBSTONE_KNOWN_FIELDS,
]);

// ── ISO-8601 type-clamp: createdAt is the load-bearing date field. On a foreign record
//    it MUST validate as a real date or be normalized, so markup cannot survive the
//    clamp. ──────────────────────────────────────────────────────────────────────

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
 * Validate an ActionItem.source on RECEIVE: every free-text sub-field length-clamped +
 * jailed (a path-shaped source field is dropped). Returns the clamped source object (only
 * with the present clean sub-fields) or null when the value is not an object. The
 * ActionItem source is `{ platform?, contentId?, context? }`.
 */
function validateSource(raw: unknown, ctx: StoreValidateContext): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const platform = clampFreeText(s.platform);
  if (platform !== null && platform.length > 0 && jailStoreStringField(platform, ctx) !== null) out.platform = platform;
  const contentId = clampFreeText(s.contentId);
  if (contentId !== null && contentId.length > 0 && jailStoreStringField(contentId, ctx) !== null) out.contentId = contentId;
  const context = clampFreeText(s.context);
  if (context !== null && context.length > 0) out.context = context;
  return out;
}

/**
 * The `evolution-action-record` store schema — a DISCRIMINATED UNION on `op`. Strict typed
 * validation on top of the envelope: reject free text beyond the known fields, TYPE-CLAMP
 * every known field (`createdAt`/`dueBy`/`completedAt` ISO-8601-or-absent, `priority`/
 * `status` enum, `tags` string[], `description`/free text length-clamped) so markup cannot
 * smuggle through a render slot that bypasses sanitize(). Returns the validated
 * store-specific object (known fields only), or null to reject the WHOLE record. PURE (no
 * I/O, no mutation of `raw`).
 *
 * The envelope validator has ALREADY validated `op` ∈ {put,delete} before calling this.
 * We branch on it so a tombstone `{recordKey, op:'delete', hlc, origin, deletedAt}` passes
 * (only `deletedAt` is a legal store field for a delete) WITHOUT being marked invalid by
 * the rich VALUE schema.
 */
export const evolutionActionRecordStoreSchema: StoreFieldSchema = {
  knownFields: ALL_KNOWN_FIELDS,
  validate(raw: Readonly<Record<string, unknown>>, ctx: StoreValidateContext): Record<string, unknown> | null {
    const op = raw.op;

    // ── DELETE (tombstone) branch. Only `deletedAt` is a legal store field; any VALUE
    //    field present is counted as a dropped field but does not reject — the tombstone's
    //    recordKey + hlc + op (envelope, already validated) carry the suppression. ──────
    if (op === 'delete') {
      const deletedAt = isIso8601(raw.deletedAt) ? (raw.deletedAt as string) : undefined;
      for (const k of Object.keys(raw)) {
        if (k === 'op' || k === 'deletedAt') continue;
        if (EVOLUTION_ACTION_STORE_KNOWN_FIELDS.includes(k)) ctx.countDroppedField();
      }
      return deletedAt !== undefined ? { deletedAt } : {};
    }

    // ── VALUE (put) branch. ──────────────────────────────────────────────────
    // title — required non-empty free text, clamped.
    const title = clampFreeText(raw.title);
    if (title === null || title.length === 0) return null;

    // priority — required enum membership (markup cannot survive an enum slot).
    if (typeof raw.priority !== 'string' || !EVOLUTION_ACTION_PRIORITIES.includes(raw.priority)) return null;
    const priority = raw.priority;

    // status — required enum membership. The load-bearing cross-machine field (fork #2):
    // a peer must SEE the real status so it does not redo a completed action.
    if (typeof raw.status !== 'string' || !EVOLUTION_ACTION_STATUSES.includes(raw.status)) return null;
    const status = raw.status;

    // createdAt — required ISO-8601. A non-date coerces to epoch-0 (tolerant-read posture)
    // — never record-rejects, but markup can never survive the clamp.
    const createdAt = isIso8601(raw.createdAt) ? (raw.createdAt as string) : new Date(0).toISOString();

    // description — free text, length-clamped on receive (a flood is bounded).
    const description = typeof raw.description === 'string'
      ? (raw.description.length > MAX_DESCRIPTION_LENGTH ? raw.description.slice(0, MAX_DESCRIPTION_LENGTH) : raw.description)
      : '';

    // tags — array of clamped strings, ≤ MAX_TAGS.
    const tags = Array.isArray(raw.tags)
      ? raw.tags
          .filter((t): t is string => typeof t === 'string')
          .slice(0, MAX_TAGS)
          .map((t) => (t.length > MAX_FREETEXT_LENGTH ? t.slice(0, MAX_FREETEXT_LENGTH) : t))
      : [];

    const out: Record<string, unknown> = {
      title,
      description,
      priority,
      status,
      createdAt,
      tags,
    };

    // Optional clamped free-text fields — present only when valid.
    const commitTo = raw.commitTo !== undefined ? clampFreeText(raw.commitTo) : null;
    if (commitTo !== null && commitTo.length > 0) out.commitTo = commitTo;
    const resolution = raw.resolution !== undefined ? clampFreeText(raw.resolution) : null;
    if (resolution !== null && resolution.length > 0) out.resolution = resolution;

    // Optional ISO date fields — present only when a clean ISO date (markup dropped).
    if (isIso8601(raw.dueBy)) out.dueBy = raw.dueBy as string;
    if (isIso8601(raw.completedAt)) out.completedAt = raw.completedAt as string;

    // source — optional object, type-clamped (sub-fields clamped/jailed). Present only when
    // a non-empty validated object.
    if (raw.source !== undefined) {
      const source = validateSource(raw.source, ctx);
      if (source !== null && Object.keys(source).length > 0) out.source = source;
    }

    return out;
  },
};

// ───────────────────────────────────────────────────────────────────────────
// recordKey — the cross-machine IDENTITY SURFACE (fork #1)
// ───────────────────────────────────────────────────────────────────────────

/** Normalize a string for the content fingerprint: trim + lowercase + collapse internal
 *  whitespace, so trivial formatting differences across machines do not split the same
 *  action into two records. */
export function normalizeForKey(v: string): string {
  return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Derive the cross-machine-stable recordKey for an action (fork #1). An action is "the
 * same" across machines by its STABLE CONTENT IDENTITY, NOT by the per-machine,
 * sequentially-assigned `ACT-NNN` id — VM-A and VM-B mint different ACT ids for the same
 * committed action, so an id-keyed record could never collide them (exactly the
 * relationship-UUID / LRN-id trap the prior kinds solved with a stable identity surface).
 *
 * The key is a deterministic, collision-resistant hash:
 *   sha256(normalize(title) + '\x1f' + normalize(commitTo || '') + '\x1f' + createdAt)
 * hex-truncated to 32 chars (the same shape UnionReader.conflictId uses). The `\x1f`
 * (unit separator) is an un-typeable delimiter so two actions cannot collide by straddling
 * the field boundary.
 *
 * `createdAt` is the strong disambiguator: two distinct actions with the same title +
 * commitTo created at different instants never collide. `commitTo` (who the commitment was
 * made to) further distinguishes the same-titled action made to two people. Returns null
 * when title OR createdAt is empty (a degenerate record with no stable identity surface —
 * the caller skips emission; it can never collide a stranger by an empty key).
 *
 * COLLISION SAFETY: two DIFFERENT actions share a key ONLY if they share the EXACT same
 * normalized title AND commitTo AND createdAt — which IS the definition of "the same
 * action". SPLIT-IDENTITY SAFETY: the same action derives the SAME key on both machines IFF
 * both hold the same title/commitTo/createdAt; the normalization absorbs trivial formatting
 * drift. NOTE: status/priority/completedAt are DELIBERATELY excluded from the key — they
 * are the MUTABLE fields (fork #2); keying on them would split the same action into a new
 * record on every status change instead of updating the one record.
 */
export function deriveEvolutionActionRecordKey(
  title: string,
  commitTo: string | null | undefined,
  createdAt: string,
): string | null {
  const t = normalizeForKey(title ?? '');
  const created = typeof createdAt === 'string' ? createdAt.trim() : '';
  if (t.length === 0 || created.length === 0) return null;
  const c = normalizeForKey(commitTo ?? '');
  const h = createHash('sha256');
  h.update(`${t}\x1f${c}\x1f${created}`);
  return h.digest('hex').slice(0, 32);
}

// ───────────────────────────────────────────────────────────────────────────
// B. Emit — ActionItem → disclosure-minimized replicated `data` (fork #1/#2)
// ───────────────────────────────────────────────────────────────────────────

/** The `data` object an `evolution-action-record` journal entry carries. */
export type EvolutionActionRecordData = Record<string, unknown>;

/** Input to buildEvolutionActionRecordData: the record to emit, the freshly-ticked hlc,
 *  this machine's origin id, and the observed-witness (the hlc already merged for THIS
 *  recordKey before writing, or absent). */
export interface BuildEvolutionActionRecordInput {
  record: ActionItem;
  hlc: HlcTimestamp;
  origin: string;
  observed?: HlcTimestamp;
}

/** The named error a record-over-cap surfaces: not silent-truncate, not suspect-wedge. */
export class EvolutionActionRecordTooLargeError extends Error {
  constructor(public readonly recordKey: string, public readonly bytes: number) {
    super(`evolution-action-record ${recordKey} is ${bytes} bytes after projection — over the ${EVOLUTION_ACTION_MAX_ENTRY_BYTES}-byte per-entry cap; not replicated`);
    this.name = 'EvolutionActionRecordTooLargeError';
  }
}

function clampFreeTextEmit(v: string, max = MAX_FREETEXT_LENGTH): string {
  return typeof v === 'string' && v.length > max ? v.slice(0, max) : (v ?? '');
}

/** Emit-side disclosure-minimized source projection: the enumerated source sub-fields
 *  ONLY, each clamped to the receive-side maxima (so a legal record round-trips). */
function projectSource(source: ActionItem['source']): Record<string, unknown> | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  if (source.platform) out.platform = clampFreeTextEmit(source.platform);
  if (source.contentId) out.contentId = clampFreeTextEmit(source.contentId);
  if (source.context) out.context = clampFreeTextEmit(source.context);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build the disclosure-minimized `evolution-action-record` envelope `data` for an
 * `op:'put'` (fork #1/#2). Emits ONLY the enumerated action projection — NEVER the local
 * `ACT-NNN` id. recordKey = the derived content-fingerprint identity surface (fork #1).
 *
 * Returns null when the record has no stable identity surface (empty title/createdAt ⇒
 * deriveEvolutionActionRecordKey null — the caller skips emission). Throws
 * EvolutionActionRecordTooLargeError when the projection STILL exceeds the 64KB per-entry
 * cap (a NAMED, surfaced rejection — never silent-truncate).
 */
export function buildEvolutionActionRecordData(input: BuildEvolutionActionRecordInput): EvolutionActionRecordData | null {
  const { record, hlc, origin, observed } = input;
  const recordKey = deriveEvolutionActionRecordKey(record.title, record.commitTo, record.createdAt);
  if (recordKey === null) return null;

  const data: EvolutionActionRecordData = {
    title: clampFreeTextEmit(record.title),
    description: typeof record.description === 'string'
      ? (record.description.length > MAX_DESCRIPTION_LENGTH ? record.description.slice(0, MAX_DESCRIPTION_LENGTH) : record.description)
      : '',
    priority: record.priority,
    status: record.status,
    createdAt: record.createdAt,
    tags: Array.isArray(record.tags) ? record.tags.slice(0, MAX_TAGS).map((t) => clampFreeTextEmit(t)) : [],
    // envelope fields (recordKey = identity surface).
    recordKey,
    hlc,
    op: 'put' as ReplicatedOp,
    origin,
    ...(observed !== undefined ? { observed } : {}),
  };
  // Optional fields — only when present (the local ACT id is NEVER among them).
  if (record.commitTo) data.commitTo = clampFreeTextEmit(record.commitTo);
  if (record.resolution) data.resolution = clampFreeTextEmit(record.resolution);
  if (typeof record.dueBy === 'string' && record.dueBy.length > 0) data.dueBy = record.dueBy;
  if (typeof record.completedAt === 'string' && record.completedAt.length > 0) data.completedAt = record.completedAt;
  const source = projectSource(record.source);
  if (source !== undefined) data.source = source;

  assertProjectionUnderCap(recordKey, data);
  return data;
}

/** Throw EvolutionActionRecordTooLargeError if the projected data serializes over the
 *  per-entry cap. The cap is set so a legal disclosure-minimized record can never reach
 *  it; this is the belt-and-suspenders named rejection. */
export function assertProjectionUnderCap(recordKey: string, data: EvolutionActionRecordData): void {
  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf-8');
  if (bytes > EVOLUTION_ACTION_MAX_ENTRY_BYTES) {
    throw new EvolutionActionRecordTooLargeError(recordKey, bytes);
  }
}

/** Input to buildEvolutionActionTombstoneData: the title/commitTo/createdAt of the removed
 *  action (to derive the recordKey identity surface), the freshly-ticked hlc, the origin,
 *  and the deletedAt timestamp. */
export interface BuildEvolutionActionTombstoneInput {
  title: string;
  commitTo: string | null | undefined;
  createdAt: string;
  hlc: HlcTimestamp;
  origin: string;
  deletedAt: string;
  observed?: HlcTimestamp;
}

/**
 * Build an `op:'delete'` TOMBSTONE `data` for an action queue-REMOVAL. recordKey = the SAME
 * content-fingerprint identity surface the value records key on, so the tombstone reaches
 * the same action's record on every machine even though the local ACT ids differ. Returns
 * null when title/createdAt are empty (no identity surface to tombstone).
 *
 * CRITICAL (fork #2): a `completed`/`cancelled` action is a TERMINAL state, NOT a delete —
 * its record is retained (history). This tombstone fires ONLY when an action is actually
 * REMOVED from the queue (the prune-over-maxActions path), else a peer re-replicates the
 * locally-removed action forever (resurrection). The delete-resurrection guard lives in the
 * merge (a later `delete` hlc wins over an earlier `put`).
 */
export function buildEvolutionActionTombstoneData(input: BuildEvolutionActionTombstoneInput): EvolutionActionRecordData | null {
  const recordKey = deriveEvolutionActionRecordKey(input.title, input.commitTo, input.createdAt);
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

/** A merged action view entry: the projected record fields PLUS its origin machine id (so
 *  a foreign record is rendered inside the untrusted-data envelope). READ-ONLY — NEVER
 *  written back into the local store. */
export interface MergedActionView {
  recordKey: string;
  origin: string;
  /** The validated, type-clamped projection fields (the receive-side schema already ran
   *  on apply; here `data` is that validated portion). */
  data: Record<string, unknown>;
  /** True when this view entry is one of ≥2 concurrent variants of an OPEN conflict
   *  (append-both — both surface as advisory hints; the read NEVER suppresses a usable view
   *  AND NEVER blocks on the unresolved conflict). */
  conflicted: boolean;
}

/** Reconstruct a MergedActionView from an OriginRecord (the envelope stripped). */
function viewFromOriginRecord(rec: OriginRecord, conflicted: boolean): MergedActionView {
  return { recordKey: rec.envelope.recordKey, origin: rec.origin, data: rec.data, conflicted };
}

/**
 * Collapse a `Map<recordKey, UnionResult>` into the merged action view.
 * HIGH-impact-at-replication / ADVISORY-at-read contract (fork #3):
 *   - A resolved single value ⇒ that one view entry.
 *   - An OPEN concurrent conflict ⇒ BOTH (all) `put` variants as separate entries
 *     (append-both — both surface as ADVISORY guidance, e.g. one machine's `completed` and
 *     another's `in_progress`; the read NEVER suppresses a usable view AND NEVER BLOCKS
 *     waiting on operator resolution — an action is a work item to surface, not authority).
 *     A `delete` variant contributes nothing to display.
 *   - A delete-resolved key (every origin's latest is a tombstone) ⇒ nothing (the
 *     delete-resurrection guard: a later delete wins over an earlier put).
 * The read is READ-ONLY: a replicated record NEVER clobbers a divergent local record — the
 * local store files are never written here.
 */
export function mergeUnionToActions(union: Map<string, UnionResult>): MergedActionView[] {
  const out: MergedActionView[] = [];
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
 * Render a FOREIGN (replicated) action record into a session-context block, wrapped in an
 * explicit `<replicated-untrusted-data origin="…">` envelope so the session model treats it
 * as a PEER'S work item to re-ground against, never a directive. EVERY rendered field is
 * escaped — there is no "trusted because machine-set" slot. A null `data.title` (a
 * malformed view) yields null.
 */
export function renderForeignActionContext(view: MergedActionView): string | null {
  const d = view.data;
  if (typeof d.title !== 'string' || d.title.length === 0) return null;
  const safeOrigin = sanitize(view.origin);
  const lines: string[] = [
    `<replicated-untrusted-data origin="${safeOrigin}">`,
    `Evolution action: ${sanitize(d.title)}`,
  ];
  if (typeof d.status === 'string') lines.push(`Status: ${sanitize(d.status)}`);
  if (typeof d.priority === 'string') lines.push(`Priority: ${sanitize(d.priority)}`);
  if (typeof d.commitTo === 'string' && d.commitTo.length > 0) lines.push(`Committed to: ${sanitize(d.commitTo)}`);
  if (typeof d.createdAt === 'string') lines.push(`Created: ${sanitize(d.createdAt)}`);
  if (typeof d.dueBy === 'string' && d.dueBy.length > 0) lines.push(`Due by: ${sanitize(d.dueBy)}`);
  if (typeof d.completedAt === 'string' && d.completedAt.length > 0) lines.push(`Completed: ${sanitize(d.completedAt)}`);
  if (Array.isArray(d.tags) && d.tags.length > 0) lines.push(`Tags: ${(d.tags as string[]).map(sanitize).join(', ')}`);
  if (typeof d.resolution === 'string' && d.resolution.length > 0) lines.push(`Resolution: ${sanitize(d.resolution)}`);
  if (typeof d.description === 'string' && d.description.length > 0) lines.push(`Details: ${sanitize(d.description)}`);
  lines.push('</replicated-untrusted-data>');
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// Own-origin materialization for the union reader (mirrors WS2.4)
// ───────────────────────────────────────────────────────────────────────────

/** Map an action status to a logical-clock nudge so a later status edit positions AFTER
 *  the original on the own-origin HLC stamp (fork #2 last-writer-witness, single conflict
 *  path). A monotone progression pending → in_progress → completed/cancelled. */
function statusLogical(status: string): number {
  switch (status) {
    case 'in_progress': return 1;
    case 'completed': return 2;
    case 'cancelled': return 2;
    default: return 0; // pending
  }
}

/**
 * Build an OriginRecord for the OWN actions store (the single-origin materialization the
 * union reader merges against peer replicas). recordKey = derived content-fingerprint
 * identity surface; the envelope carries a SYNTHETIC own-origin HLC stamp derived
 * deterministically from `createdAt` (physical) nudged by the status progression (logical)
 * so the own record has a well-formed, stable position relative to peer records — a later
 * `completed` edit positions after the original `pending` put. Returns null for a degenerate
 * record (no identity surface). The local `ACT-NNN` id is NEVER carried into the replicated
 * namespace.
 */
export function evolutionActionToOriginRecord(record: ActionItem, origin: string): OriginRecord | null {
  const recordKey = deriveEvolutionActionRecordKey(record.title, record.commitTo, record.createdAt);
  if (recordKey === null) return null;
  const physical = Date.parse(record.createdAt ?? '');
  const hlc: HlcTimestamp = {
    physical: Number.isFinite(physical) ? physical : 0,
    logical: statusLogical(record.status),
    node: origin,
  };
  const data: Record<string, unknown> = {
    title: record.title,
    description: record.description ?? '',
    priority: record.priority,
    status: record.status,
    createdAt: record.createdAt,
    tags: Array.isArray(record.tags) ? record.tags : [],
  };
  if (record.commitTo) data.commitTo = record.commitTo;
  if (record.resolution) data.resolution = record.resolution;
  if (typeof record.dueBy === 'string' && record.dueBy.length > 0) data.dueBy = record.dueBy;
  if (typeof record.completedAt === 'string' && record.completedAt.length > 0) data.completedAt = record.completedAt;
  const source = projectSource(record.source);
  if (source !== undefined) data.source = source;
  const envelope: ReplicatedEnvelope = { recordKey, hlc, op: 'put', origin };
  return { origin, envelope, data };
}

// ───────────────────────────────────────────────────────────────────────────
// Registration descriptor (consumed by server.ts to register the dual registry)
// ───────────────────────────────────────────────────────────────────────────

/** The ReplicatedKindRegistry registration for the `evolution-action-record` store.
 *  server.ts registers this onto the shared registry; the dual-registry coupling test
 *  asserts `kind` is also present in JOURNAL_KINDS. */
export const EVOLUTION_ACTION_KIND_REGISTRATION = {
  kind: EVOLUTION_ACTION_RECORD_KIND,
  store: EVOLUTION_ACTION_STORE_KEY,
  schema: evolutionActionRecordStoreSchema,
} as const;

/** Convenience: the store's contributing journal kinds (for rollback-unmerge's
 *  kindsForStore('evolutionActions') wiring). */
export function evolutionActionContributingKinds(): string[] {
  return [EVOLUTION_ACTION_RECORD_KIND];
}

/** The store's impact tier resolver, for ReplicatedStoreReader.tierOf. Returns HIGH for the
 *  `evolutionActions` store (and HIGH for any unknown store — the conservative
 *  append-both-and-flag direction, never a silent clobber). */
export function evolutionActionTierOf(_store: string): ImpactTier {
  return EVOLUTION_ACTION_IMPACT_TIER;
}

/** Re-export the envelope type for callers building/applying evolution-action-record
 *  envelopes. */
export type { ReplicatedEnvelope };
