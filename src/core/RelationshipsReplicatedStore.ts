/**
 * RelationshipsReplicatedStore — the SECOND concrete consumer of the HLC
 * replicated-store foundation (WS2.3) and the FIRST PII kind. It layers the
 * `relationship-record` replicated kind onto the generic substrate
 * (ReplicatedRecordEnvelope / UnionReader / ConflictStore / RollbackUnmerge /
 * ReplicationBudget / StoreSnapshot) so that a person the agent knows on machine
 * A is known on machine B — ONE relationship graph, not one-per-machine.
 *
 * It is the literal analog of `PreferencesReplicatedStore.ts` (the WS2.1 reference
 * consumer), with the PII-specific hardening the security spec
 * (`ws23-relationships-userregistry-security.md`) demands. THIS IS PURE LOGIC. No
 * fs, no Date directly, no network. It defines:
 *
 *   A. The `relationship-record` store schema — a STRICT typed validator that
 *      TYPE-CLAMPS every known field (REQ-M3): ISO-8601-only dates, finite-number
 *      counts, length-clamped free text. A foreign record is fully attacker-
 *      controlled (§2.3 injection), so the clamp is the defense that makes markup
 *      un-smuggleable through a field that bypasses sanitize() on render. The
 *      schema is a DISCRIMINATED UNION on `op` (gap #8): an `op:'put'` VALUE schema
 *      AND an `op:'delete'` TOMBSTONE schema coexist under the one kind, so a
 *      tombstone is never marked invalid/suspect by the value schema (REQ-D6).
 *
 *   B. The disclosure-minimized PROJECTION (REQ-M4) — `buildRelationshipRecordData`
 *      emits ONLY the enumerated resolution + merge-relevant fields, NEVER the raw
 *      on-disk blob and NEVER the local UUID `id`. `recordKey` is the cross-machine
 *      IDENTITY SURFACE (REQ-D17), derived deterministically from the sorted
 *      channel-uids (a person is "the same" across machines by their channels,
 *      mirroring resolveByChannel) — never the per-machine `randomUUID()` id.
 *
 *   C. The TOMBSTONE builder — `buildRelationshipTombstoneData` emits an
 *      `op:'delete'` record `{ recordKey, op, hlc, origin, deletedAt }` (§4.2) so a
 *      delete/erasure propagates as a positive signal across an offline-then-
 *      rejoining peer (§4.3) instead of a record absence that cannot distinguish
 *      "deleted" from "never replicated".
 *
 *   D. The union-aware read — `mergeUnionToRelationships` collapses a
 *      `Map<recordKey, UnionResult>` (from ReplicatedStoreReader.readAll('relationships'))
 *      into the merged relationship view. HIGH-impact (preferences/relationships):
 *      an OPEN concurrent conflict is APPEND-BOTH-AND-FLAG — both versions surface,
 *      never a silent clobber; the read NEVER writes a foreign record into the local
 *      store (REQ-M7 read-only union).
 *
 *   E. Foreign-record render safety — `renderForeignRelationshipContext` wraps a
 *      replicated record in an explicit `<replicated-untrusted-data origin="…">`
 *      envelope (§2.3) and sanitizes EVERY rendered field (the ISO-8601/finite-
 *      number type-clamps on apply already make the date/count fields injection-
 *      safe; the free-text fields are escaped here). There is no "trusted because
 *      machine-set" render slot for a foreign record.
 *
 * SAFETY POSTURE (§14): MECHANISM, dark by default. Nothing here blocks a
 * user-initiated action. The local UUID `id`, the local `channelIndex`/`nameIndex`,
 * and any local-only bookkeeping are NEVER part of the replicated schema and are
 * stripped from every emitted projection (REQ-M4 disclosure minimization).
 */

import { createHash } from 'node:crypto';

import type {
  RelationshipRecord,
  UserChannel,
  InteractionSummary,
} from './types.js';
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
 *  `multiMachine.stateSync.relationships.enabled`). Equal to the advert flag key
 *  `stateSyncReceive['relationships']`. */
export const RELATIONSHIP_STORE_KEY = 'relationships';

/** The JournalKind string this store rides — the DUAL-REGISTRY's dynamic half.
 *  MUST also be present in CoherenceJournal.JOURNAL_KINDS (the static half), or the
 *  store advertises receive=true yet serves/applies/pulls nothing (§4 callout). */
export const RELATIONSHIP_RECORD_KIND = 'relationship-record';

/**
 * Relationships are HIGH-impact (security spec §5 REQ-M9 / parent §WS2): a
 * concurrent divergent VALUE edit to the SAME identity surface from different
 * origins goes through APPEND-BOTH-AND-FLAG — both versions preserved, ONE deduped
 * conflict, never a silent overwrite (auto-merging two divergent people could fuse
 * two distinct humans). The CONSUMER read path injects BOTH variants — see
 * mergeUnionToRelationships.
 */
export const RELATIONSHIP_IMPACT_TIER: ImpactTier = 'high';

// ── Local-record caps mirrored on RECEIVE (REQ-M3 length-clamp discipline). A
//    value over a cap REJECTS the whole record (never truncate-and-accept), EXCEPT
//    free-text which is length-clamped on receive (the spec's "mirror MAX_NOTES_LENGTH
//    on receive" rule — a flood is bounded, not record-rejected). ──────────────
/** Mirrors RelationshipManager.MAX_NOTES_LENGTH. */
export const MAX_NOTES_LENGTH = 10_000;
/** Mirrors RelationshipManager.MAX_CHANNELS. */
export const MAX_CHANNELS = 50;
/** Themes cap (RelationshipManager keeps themes ≤ 20). */
export const MAX_THEMES = 20;
/** Recent-interactions cap fallback (config `maxRecentInteractions`; the projection
 *  clamps to this hard ceiling so a hostile peer can't inflate the count). */
export const MAX_RECENT_INTERACTIONS = 50;
/** Per-free-text-string clamp for name / arcSummary / communicationStyle / category /
 *  each tag / each interaction summary / each channel identifier. */
export const MAX_FREETEXT_LENGTH = 2_000;
/** A channel `type` is a short slug. */
export const MAX_CHANNEL_TYPE_LENGTH = 64;
/** Tags cap. */
export const MAX_TAGS = 50;

/**
 * Per-kind replication bounds (§8 / REQ-D1). A PII store is NEVER `rotateKeep: 0`
 * (rotate but never delete) — unbounded PII history is a compliance defect. The
 * relationship store is chatty (recordInteraction fires on every message), so the
 * rate cap COALESCES (latest state per recordKey per interval, REQ-M12). The
 * per-kind maxFileBytes here is the journal-level fallback; the aggregate replicated
 * PII byte ceiling (REQ-D2, 64 MiB) caps the cross-(peer,kind) footprint.
 */
export const RELATIONSHIP_RECORD_BOUNDS: ReplicatedKindBounds = {
  retention: { maxFileBytes: 8 * 1024 * 1024, rotateKeep: 4 },
  // Chatty store, coalesced: capacity is the burst, refill the sustained rate.
  rateCap: { capacity: 50, refillPerSec: 10 },
};

/**
 * Per-entry size cap RAISED to 64KB for this PII kind (REQ-M3, gap #10). The
 * default APPLIER_MAX_ENTRY_BYTES = 8KB is SMALLER than a fat relationship
 * (MAX_NOTES_LENGTH=10_000 alone, PLUS bounded recentInteractions + MAX_CHANNELS),
 * so under it the highest-PII records would never replicate AND would wedge the
 * stream. 64KB is provably above the disclosure-minimized projection's maximum:
 *   name(2k) + notes(10k) + 20 themes×2k(40k) is already the dominant term, but
 *   themes are SHORT topic slugs in practice and EACH free-text is clamped to 2k —
 *   the realistic max (notes 10k + 50 channels×(64+2000) ≈ 103k worst-case) shows
 *   why we additionally enforce a HARD post-projection ceiling: a record that STILL
 *   exceeds 64KB after projection is REJECTED with a named error (not silent-
 *   truncate, not suspect-wedge). See assertProjectionUnderCap.
 */
export const RELATIONSHIP_MAX_ENTRY_BYTES = 64 * 1024;

/**
 * The store-specific field names the `relationship-record` VALUE schema OWNS (the
 * unknown-field counter's allowlist). The local UUID `id` is DELIBERATELY ABSENT
 * — it is per-machine and never replicated (REQ-D17 keys on the identity surface,
 * not the id). `recordKey`/`hlc`/`op`/`origin`/`observed` are reserved envelope
 * fields, never store fields.
 */
export const RELATIONSHIP_STORE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'name',
  'channels',
  'firstInteraction',
  'lastInteraction',
  'interactionCount',
  'themes',
  'notes',
  'communicationStyle',
  'significance',
  'arcSummary',
  'category',
  'tags',
  'recentInteractions',
]);

/** The tombstone's store-owned fields beyond the reserved envelope set (REQ-D6).
 *  `deletedAt` is the only store field a delete carries. */
export const RELATIONSHIP_TOMBSTONE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'deletedAt',
]);

/** The full set of known store fields across BOTH op-branches (the schema's
 *  knownFields the registry uses for unknown-field counting — a field legal in
 *  EITHER branch is "known", and the branch validate() enforces which is legal for
 *  THIS op). */
const ALL_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  ...RELATIONSHIP_STORE_KNOWN_FIELDS,
  ...RELATIONSHIP_TOMBSTONE_KNOWN_FIELDS,
]);

// ── ISO-8601 type-clamp (REQ-M3): firstInteraction/lastInteraction render
//    UNSANITIZED today, so on a foreign record they MUST validate as a real date
//    or the record is rejected — markup cannot survive the clamp. ───────────────

/** Is `v` a valid ISO-8601 date string (and ONLY a date — no trailing markup)? A
 *  string that Date.parse rejects, or that round-trips to a different string, is not
 *  a clean ISO date and is rejected. */
export function isIso8601(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) return false;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return false;
  // A clean ISO date round-trips through Date.toISOString within the same instant.
  // We accept any string Date.parse accepts whose value is finite AND that contains
  // no angle brackets/quotes (the injection vectors) — the round-trip equality test
  // would over-reject legitimate offsets (e.g. +00:00 vs Z), so we gate on the
  // injection chars directly: a real date never contains <, >, or a double-quote.
  if (v.includes('<') || v.includes('>') || v.includes('"')) return false;
  return true;
}

function clampFreeText(v: unknown, max = MAX_FREETEXT_LENGTH): string | null {
  if (typeof v !== 'string') return null;
  return v.length > max ? v.slice(0, max) : v;
}

function finiteNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Validate one channel `{ type, identifier }` on RECEIVE: both strings, type a
 *  short non-path slug, identifier length-clamped + jailed (no path-shape). Returns
 *  the clamped channel or null to reject the whole record. */
function validateChannel(raw: unknown, ctx: StoreValidateContext): UserChannel | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.type !== 'string' || c.type.length === 0 || c.type.length > MAX_CHANNEL_TYPE_LENGTH) return null;
  if (typeof c.identifier !== 'string' || c.identifier.length === 0) return null;
  // The channel identifier feeds the recordKey identity surface — a path-shaped
  // identifier is rejected (defense in depth; an email/uid is never path-shaped).
  if (jailStoreStringField(c.type, ctx) === null) return null;
  const ident = c.identifier.length > MAX_FREETEXT_LENGTH ? c.identifier.slice(0, MAX_FREETEXT_LENGTH) : c.identifier;
  return { type: c.type, identifier: ident };
}

/** Validate one interaction summary on RECEIVE (free text clamped, timestamp ISO). */
function validateInteraction(raw: unknown): InteractionSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const i = raw as Record<string, unknown>;
  const summary = clampFreeText(i.summary);
  if (summary === null) return null;
  const channel = clampFreeText(i.channel, MAX_CHANNEL_TYPE_LENGTH) ?? '';
  // timestamp clamped to ISO; a non-date timestamp coerces to epoch-0 (never rejects
  // the whole record for one bad interaction — the manager's tolerant-read posture).
  const timestamp = isIso8601(i.timestamp) ? (i.timestamp as string) : new Date(0).toISOString();
  const out: InteractionSummary = { timestamp, channel, summary };
  if (Array.isArray(i.topics)) {
    const topics = i.topics
      .filter((t): t is string => typeof t === 'string')
      .slice(0, MAX_THEMES)
      .map((t) => (t.length > MAX_FREETEXT_LENGTH ? t.slice(0, MAX_FREETEXT_LENGTH) : t));
    if (topics.length > 0) out.topics = topics;
  }
  return out;
}

/**
 * The `relationship-record` store schema (§4 / REQ-M3) — a DISCRIMINATED UNION on
 * `op` (gap #8). Strict typed validation on top of the envelope: reject free text
 * beyond the known fields, TYPE-CLAMP every known field, validate the date/number
 * fields so markup cannot smuggle through a render slot that bypasses sanitize().
 * Returns the validated store-specific object (known fields only), or null to reject
 * the WHOLE record. PURE (no I/O, no mutation of `raw`).
 *
 * The `op` discriminator: the envelope validator has ALREADY validated `op` ∈
 * {put,delete} before calling this. We branch on it so a tombstone
 * `{recordKey, op:'delete', hlc, origin, deletedAt}` passes (only `deletedAt` is a
 * legal store field for a delete) WITHOUT being marked invalid by the rich VALUE
 * schema (REQ-D6).
 */
export const relationshipRecordStoreSchema: StoreFieldSchema = {
  knownFields: ALL_KNOWN_FIELDS,
  // No store field holds an artifact path, so pathSensitiveFields is empty — the
  // channel `type` is jailed imperatively in validateChannel as defense-in-depth.
  validate(raw: Readonly<Record<string, unknown>>, ctx: StoreValidateContext): Record<string, unknown> | null {
    const op = raw.op;

    // ── DELETE (tombstone) branch (REQ-D6). Only `deletedAt` is a legal store
    //    field; any VALUE field present is an unknown-for-this-op field (counted)
    //    but does not reject the record — the tombstone's recordKey + hlc + op
    //    (envelope, already validated) carry the suppression. ──────────────────
    if (op === 'delete') {
      // deletedAt — ISO-8601 if present; tolerated-absent (the envelope hlc is the
      // load-bearing order). A non-date deletedAt is dropped, not record-rejecting.
      const deletedAt = isIso8601(raw.deletedAt) ? (raw.deletedAt as string) : undefined;
      // Count any VALUE field smuggled onto a tombstone as a dropped field.
      for (const k of Object.keys(raw)) {
        if (k === 'op' || k === 'deletedAt') continue;
        if (RELATIONSHIP_STORE_KNOWN_FIELDS.includes(k)) ctx.countDroppedField();
      }
      return deletedAt !== undefined ? { deletedAt } : {};
    }

    // ── VALUE (put) branch. ──────────────────────────────────────────────────
    // name — required non-empty free text, clamped.
    const name = clampFreeText(raw.name);
    if (name === null || name.length === 0) return null;

    // channels — an array, each clamped + jailed, ≤ MAX_CHANNELS. A bad channel
    // rejects the whole record (the identity surface must be trustworthy).
    if (!Array.isArray(raw.channels)) return null;
    if (raw.channels.length > MAX_CHANNELS) return null;
    const channels: UserChannel[] = [];
    for (const c of raw.channels) {
      const vc = validateChannel(c, ctx);
      if (vc === null) return null;
      channels.push(vc);
    }

    // firstInteraction / lastInteraction — ISO-8601 ONLY (REQ-M3): these render
    // UNSANITIZED in getContextForPerson, so a non-date string is REJECTED (markup
    // cannot survive). This is the load-bearing injection clamp (gap #4).
    if (!isIso8601(raw.firstInteraction)) return null;
    if (!isIso8601(raw.lastInteraction)) return null;
    const firstInteraction = raw.firstInteraction as string;
    const lastInteraction = raw.lastInteraction as string;

    // interactionCount / significance — FINITE NUMBERS (REQ-M3): these also render
    // unsanitized, so a string is rejected (markup cannot survive a number slot).
    if (typeof raw.interactionCount !== 'number' || !Number.isFinite(raw.interactionCount)) return null;
    if (typeof raw.significance !== 'number' || !Number.isFinite(raw.significance)) return null;
    const interactionCount = Math.max(0, Math.floor(raw.interactionCount));
    const significance = raw.significance;

    // themes — array of clamped strings, ≤ MAX_THEMES.
    const themes = Array.isArray(raw.themes)
      ? raw.themes
          .filter((t): t is string => typeof t === 'string')
          .slice(0, MAX_THEMES)
          .map((t) => (t.length > MAX_FREETEXT_LENGTH ? t.slice(0, MAX_FREETEXT_LENGTH) : t))
      : [];

    // notes — free text, length-clamped on receive (a flood is bounded, REQ-M3).
    const notes = typeof raw.notes === 'string' ? (raw.notes.length > MAX_NOTES_LENGTH ? raw.notes.slice(0, MAX_NOTES_LENGTH) : raw.notes) : '';

    // recentInteractions — array, each validated + clamped, ≤ MAX_RECENT_INTERACTIONS.
    const recentInteractions: InteractionSummary[] = [];
    if (Array.isArray(raw.recentInteractions)) {
      for (const i of raw.recentInteractions.slice(0, MAX_RECENT_INTERACTIONS)) {
        const vi = validateInteraction(i);
        if (vi !== null) recentInteractions.push(vi);
      }
    }

    const out: Record<string, unknown> = {
      name,
      channels,
      firstInteraction,
      lastInteraction,
      interactionCount,
      significance,
      themes,
      notes,
      recentInteractions,
    };

    // Optional clamped free-text fields — present only when valid.
    const communicationStyle = raw.communicationStyle !== undefined ? clampFreeText(raw.communicationStyle) : null;
    if (communicationStyle !== null && communicationStyle.length > 0) out.communicationStyle = communicationStyle;
    const arcSummary = raw.arcSummary !== undefined ? clampFreeText(raw.arcSummary) : null;
    if (arcSummary !== null && arcSummary.length > 0) out.arcSummary = arcSummary;
    const category = raw.category !== undefined ? clampFreeText(raw.category, MAX_CHANNEL_TYPE_LENGTH) : null;
    if (category !== null && category.length > 0) out.category = category;
    if (Array.isArray(raw.tags)) {
      const tags = raw.tags
        .filter((t): t is string => typeof t === 'string')
        .slice(0, MAX_TAGS)
        .map((t) => (t.length > MAX_FREETEXT_LENGTH ? t.slice(0, MAX_FREETEXT_LENGTH) : t));
      if (tags.length > 0) out.tags = tags;
    }

    return out;
  },
};

// ───────────────────────────────────────────────────────────────────────────
// recordKey — the cross-machine IDENTITY SURFACE (REQ-D17)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Normalize one channel into its stable uid form `type:identifier` (lowercased
 * type, trimmed identifier). This is the SAME `${type}:${identifier}` key
 * RelationshipManager.channelIndex uses to collide a person across platforms.
 */
export function channelUid(channel: UserChannel): string {
  const type = channel.type.trim().toLowerCase();
  const identifier = channel.identifier.trim();
  return `${type}:${identifier}`;
}

/**
 * Derive the cross-machine-stable recordKey for a relationship (REQ-D17). A person
 * is "the same" across machines by their CHANNEL SET (mirroring resolveByChannel),
 * NOT by the per-machine `randomUUID()` id — VM-A and VM-B mint different UUIDs for
 * the same human, so a UUID-keyed record could never collide them.
 *
 * The key is a deterministic, collision-resistant hash of the SORTED, de-duplicated
 * channel-uids: `sha256(sorted(channelUids).join('\n'))`, hex-truncated to 32 chars
 * (the same shape UnionReader.conflictId uses). Sorting makes it order-independent
 * (the two machines converge to the SAME key for the same channel set); the hash
 * makes it a bounded, non-path-shaped string (the envelope's recordKey jail accepts
 * it). A relationship with NO channels (a degenerate local-only record) is NOT
 * replicable — it has no cross-machine identity surface — and is reported as null so
 * the caller skips emission (it can never collide a stranger by an empty key).
 *
 * COLLISION SAFETY: two DIFFERENT people share a key ONLY if they share the EXACT
 * same full channel set — which is the manager's own definition of "the same
 * person" (resolveByChannel returns one record per channel-uid). SPLIT-IDENTITY
 * SAFETY: the same person derives the SAME key on both machines IFF both hold the
 * same channel set; when their channel sets differ (one machine learned an extra
 * channel) the keys differ — which is correct (they are not yet provably the same
 * person on the machine missing the channel), and the union/erasure intersection
 * logic (REQ-D17) reconciles them by channel-uid overlap, never by key equality.
 */
export function deriveRelationshipRecordKey(channels: ReadonlyArray<UserChannel>): string | null {
  const uids = Array.from(new Set(channels.map(channelUid))).filter((u) => u.length > 1).sort();
  if (uids.length === 0) return null;
  const h = createHash('sha256');
  h.update(uids.join('\n'));
  return h.digest('hex').slice(0, 32);
}

// ───────────────────────────────────────────────────────────────────────────
// B. Emit — RelationshipRecord → disclosure-minimized replicated `data` (REQ-M4)
// ───────────────────────────────────────────────────────────────────────────

/** The `data` object a `relationship-record` journal entry carries. */
export type RelationshipRecordData = Record<string, unknown>;

/** Input to buildRelationshipRecordData: the record to emit, the freshly-ticked
 *  hlc, this machine's origin id, and the observed-witness (the hlc already merged
 *  for THIS recordKey before writing, or absent — §7.2). */
export interface BuildRelationshipRecordInput {
  record: RelationshipRecord;
  hlc: HlcTimestamp;
  origin: string;
  /** The HLC already merged for THIS recordKey before writing, or absent (§7.2). */
  observed?: HlcTimestamp;
}

/** The named error a record-over-cap surfaces (REQ-M3): not silent-truncate, not
 *  suspect-wedge. */
export class RelationshipRecordTooLargeError extends Error {
  constructor(public readonly recordKey: string, public readonly bytes: number) {
    super(`relationship-record ${recordKey} is ${bytes} bytes after projection — over the ${RELATIONSHIP_MAX_ENTRY_BYTES}-byte per-entry cap; not replicated`);
    this.name = 'RelationshipRecordTooLargeError';
  }
}

/**
 * Build the disclosure-minimized `relationship-record` envelope `data` for an
 * `op:'put'` (REQ-M4). Emits ONLY the enumerated resolution + merge-relevant
 * fields — NEVER the raw on-disk blob, NEVER the local UUID `id`. recordKey = the
 * derived channel-set identity surface (REQ-D17).
 *
 * Returns null when the record has NO channels (no cross-machine identity surface ⇒
 * not replicable — the caller skips emission). Throws RelationshipRecordTooLargeError
 * when the projection STILL exceeds the 64KB per-entry cap (a record that big is a
 * NAMED, surfaced rejection, REQ-M3 gap #10 — never silent-truncate).
 */
export function buildRelationshipRecordData(input: BuildRelationshipRecordInput): RelationshipRecordData | null {
  const { record, hlc, origin, observed } = input;
  const recordKey = deriveRelationshipRecordKey(record.channels);
  if (recordKey === null) return null;

  // Disclosure-minimized projection (REQ-M4): the enumerated fields ONLY. Every
  // free-text field is clamped to the same maxima the receive-side schema enforces,
  // so a legal record round-trips and a fat one is bounded BEFORE the cap check.
  const data: RelationshipRecordData = {
    name: clampFreeTextEmit(record.name),
    channels: record.channels.slice(0, MAX_CHANNELS).map((c) => ({ type: c.type, identifier: c.identifier })),
    firstInteraction: record.firstInteraction,
    lastInteraction: record.lastInteraction,
    interactionCount: finiteNumber(record.interactionCount, 0),
    significance: finiteNumber(record.significance, 1),
    themes: record.themes.slice(0, MAX_THEMES).map((t) => clampFreeTextEmit(t)),
    notes: typeof record.notes === 'string' ? (record.notes.length > MAX_NOTES_LENGTH ? record.notes.slice(0, MAX_NOTES_LENGTH) : record.notes) : '',
    recentInteractions: record.recentInteractions.slice(0, MAX_RECENT_INTERACTIONS).map((i) => ({
      timestamp: i.timestamp,
      channel: clampFreeTextEmit(i.channel, MAX_CHANNEL_TYPE_LENGTH),
      summary: clampFreeTextEmit(i.summary),
      ...(i.topics ? { topics: i.topics.slice(0, MAX_THEMES).map((t) => clampFreeTextEmit(t)) } : {}),
    })),
    // envelope fields (recordKey = identity surface).
    recordKey,
    hlc,
    op: 'put' as ReplicatedOp,
    origin,
    ...(observed !== undefined ? { observed } : {}),
  };
  // Optional fields — only when present (the local id is NEVER among them).
  if (record.communicationStyle) data.communicationStyle = clampFreeTextEmit(record.communicationStyle);
  if (record.arcSummary) data.arcSummary = clampFreeTextEmit(record.arcSummary);
  if (record.category) data.category = clampFreeTextEmit(record.category, MAX_CHANNEL_TYPE_LENGTH);
  if (record.tags && record.tags.length > 0) data.tags = record.tags.slice(0, MAX_TAGS).map((t) => clampFreeTextEmit(t));

  assertProjectionUnderCap(recordKey, data);
  return data;
}

function clampFreeTextEmit(v: string, max = MAX_FREETEXT_LENGTH): string {
  return typeof v === 'string' && v.length > max ? v.slice(0, max) : (v ?? '');
}

/** Throw RelationshipRecordTooLargeError if the projected data serializes over the
 *  per-entry cap (REQ-M3). The cap is set so a legal disclosure-minimized record can
 *  never reach it; this is the belt-and-suspenders named rejection. */
export function assertProjectionUnderCap(recordKey: string, data: RelationshipRecordData): void {
  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf-8');
  if (bytes > RELATIONSHIP_MAX_ENTRY_BYTES) {
    throw new RelationshipRecordTooLargeError(recordKey, bytes);
  }
}

/** Input to buildRelationshipTombstoneData: the channel set of the deleted person
 *  (to derive the recordKey identity surface), the freshly-ticked hlc, the origin,
 *  and the deletedAt timestamp. */
export interface BuildRelationshipTombstoneInput {
  channels: ReadonlyArray<UserChannel>;
  hlc: HlcTimestamp;
  origin: string;
  deletedAt: string;
  observed?: HlcTimestamp;
}

/**
 * Build an `op:'delete'` TOMBSTONE `data` for a relationship erasure (§4.2 REQ-D4).
 * recordKey = the SAME channel-set identity surface the value records key on, so the
 * tombstone reaches the same human's record on every machine even though the local
 * UUIDs differ. Returns null when the person has no channels (no identity surface to
 * tombstone). The exact field set is `{ recordKey, op:'delete', hlc, origin,
 * deletedAt }` (the REQ-D6 tombstone schema branch).
 */
export function buildRelationshipTombstoneData(input: BuildRelationshipTombstoneInput): RelationshipRecordData | null {
  const recordKey = deriveRelationshipRecordKey(input.channels);
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
// C. Union-aware read — HIGH-impact append-both-and-flag (REQ-M7/M9)
// ───────────────────────────────────────────────────────────────────────────

/** A merged relationship view entry: the projected record fields PLUS its origin
 *  machine id (so a foreign record is rendered inside the untrusted-data envelope).
 *  This is READ-ONLY — it is NEVER written back into the local store (REQ-M7). */
export interface MergedRelationshipView {
  recordKey: string;
  origin: string;
  /** The validated, type-clamped projection fields (the receive-side schema already
   *  ran on apply; here `data` is that validated portion). */
  data: Record<string, unknown>;
  /** True when this view entry is one of ≥2 concurrent variants of an OPEN conflict
   *  (append-both — both surface; the read NEVER suppresses a usable view). */
  conflicted: boolean;
}

/**
 * Reconstruct a MergedRelationshipView from an OriginRecord (the envelope stripped).
 */
function viewFromOriginRecord(rec: OriginRecord, conflicted: boolean): MergedRelationshipView {
  return { recordKey: rec.envelope.recordKey, origin: rec.origin, data: rec.data, conflicted };
}

/**
 * Collapse a `Map<recordKey, UnionResult>` (from
 * ReplicatedStoreReader.readAll('relationships')) into the merged relationship view.
 * HIGH-impact contract (REQ-M9):
 *   - A resolved single value ⇒ that one view entry.
 *   - An OPEN concurrent conflict ⇒ BOTH (all) `put` variants as separate entries
 *     (append-both — the read NEVER suppresses a usable view waiting on operator
 *     resolution). A `delete` variant contributes nothing to display.
 *   - A delete-resolved key (every origin's latest is a tombstone) ⇒ nothing.
 * The read is READ-ONLY: a replicated record NEVER clobbers a divergent local
 * record (REQ-M7) — the local store files are never written here.
 */
export function mergeUnionToRelationships(union: Map<string, UnionResult>): MergedRelationshipView[] {
  const out: MergedRelationshipView[] = [];
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
// E. Foreign-record render safety — quoted untrusted data (§2.3)
// ───────────────────────────────────────────────────────────────────────────

/** Sanitize a string for inclusion in the context block (mirrors
 *  RelationshipManager.getContextForPerson's escaper). */
function sanitize(s: string): string {
  return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render a FOREIGN (replicated) relationship record into a session-context block,
 * wrapped in an explicit `<replicated-untrusted-data origin="…">` envelope (§2.3)
 * so the session model treats it as a PEER'S CLAIM to re-ground against, never a
 * directive. EVERY rendered field is escaped — there is no "trusted because machine-
 * set" slot. (The date/count fields were already ISO-8601/finite-number type-clamped
 * on apply, so they cannot carry markup; we escape defensively regardless.)
 *
 * This is the foreign-record analog of RelationshipManager.getContextForPerson — a
 * caller asking "what do my OTHER machines know about this person" gets this block,
 * NEVER the local-authoritative context. A null `data.name` (a malformed view) yields
 * null.
 */
export function renderForeignRelationshipContext(view: MergedRelationshipView): string | null {
  const d = view.data;
  if (typeof d.name !== 'string' || d.name.length === 0) return null;
  const safeName = sanitize(d.name);
  const safeOrigin = sanitize(view.origin);
  const lines: string[] = [
    `<replicated-untrusted-data origin="${safeOrigin}">`,
    `Name: ${safeName}`,
  ];
  if (typeof d.firstInteraction === 'string') lines.push(`Known since: ${sanitize(d.firstInteraction)}`);
  if (typeof d.lastInteraction === 'string') lines.push(`Last interaction: ${sanitize(d.lastInteraction)}`);
  if (typeof d.interactionCount === 'number') lines.push(`Total interactions: ${sanitize(String(d.interactionCount))}`);
  if (typeof d.significance === 'number') lines.push(`Significance: ${sanitize(String(d.significance))}/10`);
  if (Array.isArray(d.channels)) {
    const platforms = [...new Set((d.channels as UserChannel[]).map((c) => c.type))];
    if (platforms.length > 0) lines.push(`Platforms: ${platforms.map(sanitize).join(', ')}`);
  }
  if (typeof d.category === 'string') lines.push(`Category: ${sanitize(d.category)}`);
  if (Array.isArray(d.tags) && d.tags.length > 0) lines.push(`Tags: ${(d.tags as string[]).map(sanitize).join(', ')}`);
  if (Array.isArray(d.themes) && d.themes.length > 0) lines.push(`Key themes: ${(d.themes as string[]).map(sanitize).join(', ')}`);
  if (typeof d.communicationStyle === 'string') lines.push(`Communication style: ${sanitize(d.communicationStyle)}`);
  if (typeof d.arcSummary === 'string') lines.push(`Relationship arc: ${sanitize(d.arcSummary)}`);
  if (typeof d.notes === 'string' && d.notes.length > 0) lines.push(`Notes: ${sanitize(d.notes)}`);
  if (Array.isArray(d.recentInteractions) && d.recentInteractions.length > 0) {
    lines.push('Recent interactions:');
    for (const i of (d.recentInteractions as InteractionSummary[]).slice(-5)) {
      lines.push(`  - [${sanitize(i.timestamp)}] ${sanitize(i.summary)}`);
    }
  }
  lines.push('</replicated-untrusted-data>');
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// Own-origin materialization for the union reader (mirrors WS2.1)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build an OriginRecord for the OWN relationship store (the single-origin
 * materialization the union reader merges against peer replicas). recordKey =
 * derived channel-set identity surface; the envelope carries a SYNTHETIC own-origin
 * HLC stamp derived deterministically from the record's lastInteraction (physical)
 * so the own record has a well-formed, stable position relative to peer records.
 * Returns null for a channel-less record (no identity surface). The local UUID `id`
 * is NEVER carried into the replicated namespace (REQ-M4 / REQ-D17).
 */
export function relationshipToOriginRecord(record: RelationshipRecord, origin: string): OriginRecord | null {
  const recordKey = deriveRelationshipRecordKey(record.channels);
  if (recordKey === null) return null;
  const physical = Date.parse(record.lastInteraction);
  const hlc: HlcTimestamp = {
    physical: Number.isFinite(physical) ? physical : 0,
    logical: Math.max(0, Math.floor(record.interactionCount || 0)),
    node: origin,
  };
  const data: Record<string, unknown> = {
    name: record.name,
    channels: record.channels.map((c) => ({ type: c.type, identifier: c.identifier })),
    firstInteraction: record.firstInteraction,
    lastInteraction: record.lastInteraction,
    interactionCount: finiteNumber(record.interactionCount, 0),
    significance: finiteNumber(record.significance, 1),
    themes: record.themes,
    notes: record.notes ?? '',
    recentInteractions: record.recentInteractions,
  };
  if (record.communicationStyle) data.communicationStyle = record.communicationStyle;
  if (record.arcSummary) data.arcSummary = record.arcSummary;
  if (record.category) data.category = record.category;
  if (record.tags && record.tags.length > 0) data.tags = record.tags;
  const envelope: ReplicatedEnvelope = { recordKey, hlc, op: 'put', origin };
  return { origin, envelope, data };
}

// ───────────────────────────────────────────────────────────────────────────
// Registration descriptor (consumed by server.ts to register the dual registry)
// ───────────────────────────────────────────────────────────────────────────

/** The ReplicatedKindRegistry registration for the `relationship-record` store.
 *  server.ts registers this onto the shared registry; the dual-registry coupling
 *  test asserts `kind` is also present in JOURNAL_KINDS. */
export const RELATIONSHIP_KIND_REGISTRATION = {
  kind: RELATIONSHIP_RECORD_KIND,
  store: RELATIONSHIP_STORE_KEY,
  schema: relationshipRecordStoreSchema,
} as const;

/** Convenience: the store's contributing journal kinds (for rollback-unmerge's
 *  kindsForStore('relationships') wiring). */
export function relationshipContributingKinds(): string[] {
  return [RELATIONSHIP_RECORD_KIND];
}

/** The store's impact tier resolver, for ReplicatedStoreReader.tierOf. Returns HIGH
 *  for the `relationships` store (and HIGH for any unknown store — the conservative
 *  append-both-and-flag direction, never a silent clobber). */
export function relationshipTierOf(_store: string): ImpactTier {
  return RELATIONSHIP_IMPACT_TIER;
}

/** Re-export the envelope type for callers building/applying relationship-record envelopes. */
export type { ReplicatedEnvelope };
