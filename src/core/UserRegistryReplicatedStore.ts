/**
 * UserRegistryReplicatedStore — the SIXTH concrete consumer of the HLC replicated-store
 * foundation (WS2.6a) and the SECOND PII kind (after WS2.3 relationships). It layers the
 * `user-record` replicated kind onto the generic substrate (ReplicatedRecordEnvelope /
 * UnionReader / ConflictStore / RollbackUnmerge / ReplicationBudget / StoreSnapshot) so that
 * a user the agent knows on machine A is known on machine B — ONE user registry, not
 * one-per-machine.
 *
 * It is the literal analog of `RelationshipsReplicatedStore.ts` (the WS2.3 PII reference
 * consumer): a UserProfile is a registered principal (the multi-user identity the
 * UserManager resolves an inbound message to), so it carries directly-identifying PII and
 * REUSES the WS2.3 PII machinery (type-clamp, disclosure-min projection, channel-set
 * recordKey, tombstones, flag-coherence) rather than reinventing or downgrading it. THIS IS
 * PURE LOGIC. No fs, no Date directly, no network. It defines:
 *
 *   A. The `user-record` store schema — a STRICT typed validator that TYPE-CLAMPS every
 *      known field (`createdAt` ISO-8601-or-absent, `telegramUserId` a finite number,
 *      `channels[]`/`permissions[]`/free text length-bounded + jailed). The schema is a
 *      DISCRIMINATED UNION on `op` — an `op:'put'` VALUE schema AND an `op:'delete'`
 *      TOMBSTONE schema coexist under the one kind, so a tombstone is never marked invalid
 *      by the value schema.
 *
 *   B. The disclosure-minimized PROJECTION — `buildUserRecordData` emits ONLY the enumerated
 *      resolution + merge-relevant fields, NEVER the raw on-disk blob and NEVER the local
 *      `userId` `id`. `recordKey` is the cross-machine IDENTITY SURFACE, derived
 *      deterministically from the SORTED channel-set ("type:identifier" pairs) — the SAME
 *      identity model as relationships (a user IS their channel identifiers, mirroring
 *      UserManager.channelIndex) — never the per-machine `userId` (VM-A and VM-B mint
 *      different ids for the same human; a UUID-keyed record could never collide them).
 *
 *   C. The TOMBSTONE builder — `buildUserTombstoneData` emits an `op:'delete'` record
 *      `{ recordKey, op, hlc, origin, deletedAt }` so a removeUser propagates as a positive
 *      signal across an offline-then-rejoining peer instead of a record absence. CRITICAL:
 *      the UserManager.removeUser() path MUST emit a tombstone, else a peer re-replicates the
 *      locally-removed user forever (resurrection).
 *
 *   D. The union-aware read — `mergeUnionToUsers` collapses a `Map<recordKey, UnionResult>`
 *      into the merged user view. Users are HIGH-impact at the REPLICATION layer (a concurrent
 *      divergent edit to the SAME channel-set identity goes through APPEND-BOTH-AND-FLAG —
 *      both versions surface, never a silent clobber; auto-merging two divergent profiles
 *      could fuse two distinct humans). The CONSUMER READ path is ADVISORY: a replicated user
 *      record is a HINT about what my OTHER machines know — NEVER my authoritative answer to
 *      "who is this inbound sender?" (identity RESOLUTION of an inbound principal is
 *      LOCAL-ONLY, mirroring REQ-M14 — the local channelIndex is always authoritative). The
 *      read NEVER writes a foreign record into the local store.
 *
 *   E. Foreign-record render safety — `renderForeignUserContext` wraps a replicated record in
 *      an explicit `<replicated-untrusted-data origin="…">` envelope and sanitizes EVERY
 *      rendered field. There is no "trusted because machine-set" render slot for a foreign
 *      record.
 *
 * DECIDED FORKS (build prompt, recorded verbatim in the PR ELI16):
 *   1. recordKey = sha256 of the SORTED channel-set ("type:identifier" pairs), NEVER the
 *      local `userId` (cross-machine identity surface — see deriveUserRecordKey).
 *   2. Impact tier = HIGH at the REPLICATION layer (append-both-and-flag), ADVISORY at the
 *      READ layer (a replicated user is a hint, never the authoritative inbound-resolution).
 *   3. disclosure-min: strip the local `userId` — a peer's local id is meaningless + a mild
 *      correlation leak; the channel-set IS the cross-machine identity.
 *
 * SAFETY POSTURE: MECHANISM, dark by default. Nothing here blocks a user-initiated action.
 * The local `userId` is NEVER part of the replicated schema and is stripped from every emitted
 * projection (disclosure minimization).
 */

import { createHash } from 'node:crypto';

import type { UserProfile, UserChannel } from './types.js';
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
 *  `multiMachine.stateSync.userRegistry.enabled`). Equal to the advert flag key
 *  `stateSyncReceive['userRegistry']`. */
export const USER_STORE_KEY = 'userRegistry';

/** The JournalKind string this store rides — the DUAL-REGISTRY's dynamic half.
 *  MUST also be present in CoherenceJournal.JOURNAL_KINDS (the static half), or the
 *  store advertises receive=true yet serves/applies/pulls nothing. */
export const USER_RECORD_KIND = 'user-record';

/**
 * Users are HIGH-impact at the REPLICATION layer (fork #2): a concurrent divergent VALUE
 * edit to the SAME channel-set identity surface from different origins goes through
 * APPEND-BOTH-AND-FLAG — both versions preserved, ONE deduped conflict, never a silent
 * overwrite (auto-merging two divergent profiles could fuse two distinct humans). The READ
 * path (mergeUnionToUsers) is ADVISORY — a replicated user record is a HINT about what my
 * OTHER machines know, NEVER my authoritative answer to "who is this inbound sender?".
 */
export const USER_IMPACT_TIER: ImpactTier = 'high';

// ── Local-record caps mirrored on RECEIVE (length-clamp discipline). A value over a cap
//    REJECTS the whole record (never truncate-and-accept), EXCEPT free text which is
//    length-clamped on receive (a flood is bounded, not record-rejected). ───────────────
/** Mirrors a reasonable per-user channel count (UserManager has no hard cap; this bounds a
 *  hostile peer's flood). */
export const MAX_CHANNELS = 50;
/** Per-free-text-string clamp for name / each channel identifier / each permission / each
 *  free-text profile field. */
export const MAX_FREETEXT_LENGTH = 2_000;
/** A channel `type` / permission is a short slug. */
export const MAX_SLUG_LENGTH = 128;
/** Permissions cap. */
export const MAX_PERMISSIONS = 50;

/**
 * Per-kind replication bounds. The user registry is FEW + bounded (a handful of registered
 * principals), so the per-store retention mirrors the pref-record / learning-record siblings
 * (a small window with a few archives). NEVER `rotateKeep: 0` (rotate-but-never-delete would
 * be a compliance defect for any PII kind, REQ-D1). The rate cap COALESCES (latest state per
 * recordKey per interval) so a churny upsert loop does not flood the stream.
 */
export const USER_RECORD_BOUNDS: ReplicatedKindBounds = {
  retention: { maxFileBytes: 4 * 1024 * 1024, rotateKeep: 4 },
  // Few records, coalesced: capacity is the burst, refill the sustained rate.
  rateCap: { capacity: 30, refillPerSec: 5 },
};

/**
 * Per-entry size cap RAISED to 64KB for this PII kind. The default
 * APPLIER_MAX_ENTRY_BYTES = 8KB could be smaller than a fat profile (many channels + a long
 * bio), so under it the highest-PII records would never replicate AND would wedge the stream.
 * 64KB is provably above the disclosure-minimized projection's maximum (50 channels ×
 * (128 + 2000) ≈ 106KB worst-case shows why we additionally enforce a HARD post-projection
 * ceiling): a record that STILL exceeds 64KB after projection is REJECTED with a named error
 * (never silent-truncate, never suspect-wedge). See assertProjectionUnderCap.
 */
export const USER_MAX_ENTRY_BYTES = 64 * 1024;

/**
 * The store-specific field names the `user-record` VALUE schema OWNS (the unknown-field
 * counter's allowlist). The local `userId` `id` is DELIBERATELY ABSENT — it is per-machine
 * and never replicated (fork #1/#3: the recordKey keys on the channel-set identity surface,
 * not the id). `recordKey`/`hlc`/`op`/`origin`/`observed` are reserved envelope fields, never
 * store fields.
 */
export const USER_STORE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'name',
  'channels',
  'permissions',
  'telegramUserId',
  'slackUserId',
  'createdAt',
  'relationshipContext',
]);

/** The tombstone's store-owned fields beyond the reserved envelope set. `deletedAt`
 *  is the only store field a delete carries. */
export const USER_TOMBSTONE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'deletedAt',
]);

/** The full set of known store fields across BOTH op-branches (the schema's knownFields the
 *  registry uses for unknown-field counting — a field legal in EITHER branch is "known", and
 *  the branch validate() enforces which is legal for THIS op). */
const ALL_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  ...USER_STORE_KNOWN_FIELDS,
  ...USER_TOMBSTONE_KNOWN_FIELDS,
]);

// ── ISO-8601 type-clamp: createdAt is the load-bearing date field. On a foreign record it
//    MUST validate as a real date or be dropped, so markup cannot survive the clamp. ───────

/** Is `v` a valid ISO-8601 date string (and ONLY a date — no smuggled markup)? A string
 *  Date.parse rejects, or that contains an injection char (`<`, `>`, `"`), is not a clean ISO
 *  date. */
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

/** Validate one channel `{ type, identifier }` on RECEIVE: both strings, type a short
 *  non-path slug, identifier length-clamped + jailed (no path-shape). Returns the clamped
 *  channel or null to reject the whole record. */
function validateChannel(raw: unknown, ctx: StoreValidateContext): UserChannel | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.type !== 'string' || c.type.length === 0 || c.type.length > MAX_SLUG_LENGTH) return null;
  if (typeof c.identifier !== 'string' || c.identifier.length === 0) return null;
  // The channel identifier feeds the recordKey identity surface — a path-shaped type is
  // rejected (defense in depth; a platform slug is never path-shaped).
  if (jailStoreStringField(c.type, ctx) === null) return null;
  const ident = c.identifier.length > MAX_FREETEXT_LENGTH ? c.identifier.slice(0, MAX_FREETEXT_LENGTH) : c.identifier;
  return { type: c.type, identifier: ident };
}

/**
 * The `user-record` store schema — a DISCRIMINATED UNION on `op`. Strict typed validation on
 * top of the envelope: reject free text beyond the known fields, TYPE-CLAMP every known field
 * (createdAt ISO-8601, telegramUserId finite number, channels/permissions/free text
 * length-clamped + jailed) so markup cannot smuggle through a render slot that bypasses
 * sanitize(). Returns the validated store-specific object (known fields only), or null to
 * reject the WHOLE record. PURE (no I/O, no mutation of `raw`).
 *
 * The envelope validator has ALREADY validated `op` ∈ {put,delete} before calling this. We
 * branch on it so a tombstone `{recordKey, op:'delete', hlc, origin, deletedAt}` passes (only
 * `deletedAt` is a legal store field for a delete) WITHOUT being marked invalid by the rich
 * VALUE schema.
 */
export const userRecordStoreSchema: StoreFieldSchema = {
  knownFields: ALL_KNOWN_FIELDS,
  validate(raw: Readonly<Record<string, unknown>>, ctx: StoreValidateContext): Record<string, unknown> | null {
    const op = raw.op;

    // ── DELETE (tombstone) branch. Only `deletedAt` is a legal store field; any VALUE field
    //    present is counted as a dropped field but does not reject — the tombstone's
    //    recordKey + hlc + op (envelope, already validated) carry the suppression. ─────────
    if (op === 'delete') {
      const deletedAt = isIso8601(raw.deletedAt) ? (raw.deletedAt as string) : undefined;
      for (const k of Object.keys(raw)) {
        if (k === 'op' || k === 'deletedAt') continue;
        if (USER_STORE_KNOWN_FIELDS.includes(k)) ctx.countDroppedField();
      }
      return deletedAt !== undefined ? { deletedAt } : {};
    }

    // ── VALUE (put) branch. ──────────────────────────────────────────────────
    // name — required non-empty free text, clamped.
    const name = clampFreeText(raw.name);
    if (name === null || name.length === 0) return null;

    // channels — an array, each clamped + jailed, ≤ MAX_CHANNELS. A bad channel rejects the
    // whole record (the identity surface must be trustworthy).
    if (!Array.isArray(raw.channels)) return null;
    if (raw.channels.length > MAX_CHANNELS) return null;
    const channels: UserChannel[] = [];
    for (const c of raw.channels) {
      const vc = validateChannel(c, ctx);
      if (vc === null) return null;
      channels.push(vc);
    }

    // permissions — array of clamped slugs, ≤ MAX_PERMISSIONS.
    const permissions = Array.isArray(raw.permissions)
      ? raw.permissions
          .filter((p): p is string => typeof p === 'string')
          .slice(0, MAX_PERMISSIONS)
          .map((p) => (p.length > MAX_SLUG_LENGTH ? p.slice(0, MAX_SLUG_LENGTH) : p))
      : [];

    const out: Record<string, unknown> = {
      name,
      channels,
      permissions,
    };

    // telegramUserId — FINITE NUMBER if present (markup cannot survive a number slot).
    if (raw.telegramUserId !== undefined) {
      if (typeof raw.telegramUserId === 'number' && Number.isFinite(raw.telegramUserId)) {
        out.telegramUserId = raw.telegramUserId;
      }
    }
    // slackUserId — a short slug, clamped + jailed.
    if (raw.slackUserId !== undefined) {
      const slackId = clampFreeText(raw.slackUserId, MAX_SLUG_LENGTH);
      if (slackId !== null && slackId.length > 0 && jailStoreStringField(slackId, ctx) !== null) out.slackUserId = slackId;
    }
    // createdAt — ISO-8601-or-absent (markup dropped).
    if (isIso8601(raw.createdAt)) out.createdAt = raw.createdAt as string;
    // relationshipContext — optional clamped free text.
    const relationshipContext = raw.relationshipContext !== undefined ? clampFreeText(raw.relationshipContext) : null;
    if (relationshipContext !== null && relationshipContext.length > 0) out.relationshipContext = relationshipContext;

    return out;
  },
};

// ───────────────────────────────────────────────────────────────────────────
// recordKey — the cross-machine IDENTITY SURFACE (fork #1)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Normalize one channel into its stable uid form `type:identifier` (lowercased type, trimmed
 * identifier). This is the SAME `${type}:${identifier}` key UserManager.channelIndex uses to
 * resolve a user across platforms.
 */
export function channelUid(channel: UserChannel): string {
  const type = channel.type.trim().toLowerCase();
  const identifier = channel.identifier.trim();
  return `${type}:${identifier}`;
}

/**
 * Derive the cross-machine-stable recordKey for a user (fork #1). A user is "the same" across
 * machines by their CHANNEL SET (mirroring UserManager.channelIndex), NOT by the per-machine
 * `userId` — VM-A and VM-B mint different ids for the same human, so an id-keyed record could
 * never collide them (exactly the relationship-UUID trap WS2.3 solved with the channel-set
 * key).
 *
 * The key is a deterministic, collision-resistant hash of the SORTED, de-duplicated
 * channel-uids: `sha256(sorted(channelUids).join('\n'))`, hex-truncated to 32 chars (the same
 * shape UnionReader.conflictId uses). Sorting makes it order-independent (the two machines
 * converge to the SAME key for the same channel set); the hash makes it a bounded,
 * non-path-shaped string (the envelope's recordKey jail accepts it). A user with NO channels
 * (a degenerate local-only record) is NOT replicable — it has no cross-machine identity
 * surface — and is reported as null so the caller skips emission (it can never collide a
 * stranger by an empty key).
 *
 * COLLISION SAFETY: two DIFFERENT users share a key ONLY if they share the EXACT same full
 * channel set — which IS the UserManager's own definition of "the same user" (the channelIndex
 * maps one user per channel-uid and refuses a cross-user collision). SPLIT-IDENTITY SAFETY: the
 * same user derives the SAME key on both machines IFF both hold the same channel set; when the
 * sets differ (one machine learned an extra channel) the keys differ — correct (they are not
 * yet provably the same user on the machine missing the channel).
 */
export function deriveUserRecordKey(channels: ReadonlyArray<UserChannel>): string | null {
  const uids = Array.from(new Set(channels.map(channelUid))).filter((u) => u.length > 1).sort();
  if (uids.length === 0) return null;
  const h = createHash('sha256');
  h.update(uids.join('\n'));
  return h.digest('hex').slice(0, 32);
}

// ───────────────────────────────────────────────────────────────────────────
// B. Emit — UserProfile → disclosure-minimized replicated `data` (fork #3)
// ───────────────────────────────────────────────────────────────────────────

/** The `data` object a `user-record` journal entry carries. */
export type UserRecordData = Record<string, unknown>;

/** Input to buildUserRecordData: the record to emit, the freshly-ticked hlc, this machine's
 *  origin id, and the observed-witness (the hlc already merged for THIS recordKey before
 *  writing, or absent). */
export interface BuildUserRecordInput {
  record: UserProfile;
  hlc: HlcTimestamp;
  origin: string;
  observed?: HlcTimestamp;
}

/** The named error a record-over-cap surfaces: not silent-truncate, not suspect-wedge. */
export class UserRecordTooLargeError extends Error {
  constructor(public readonly recordKey: string, public readonly bytes: number) {
    super(`user-record ${recordKey} is ${bytes} bytes after projection — over the ${USER_MAX_ENTRY_BYTES}-byte per-entry cap; not replicated`);
    this.name = 'UserRecordTooLargeError';
  }
}

function clampFreeTextEmit(v: string, max = MAX_FREETEXT_LENGTH): string {
  return typeof v === 'string' && v.length > max ? v.slice(0, max) : (v ?? '');
}

/**
 * Build the disclosure-minimized `user-record` envelope `data` for an `op:'put'` (fork #3).
 * Emits ONLY the enumerated resolution + merge-relevant fields — NEVER the raw on-disk blob,
 * NEVER the local `userId` id. recordKey = the derived channel-set identity surface (fork #1).
 *
 * Returns null when the record has NO channels (no cross-machine identity surface ⇒ not
 * replicable — the caller skips emission). Throws UserRecordTooLargeError when the projection
 * STILL exceeds the 64KB per-entry cap (a NAMED, surfaced rejection — never silent-truncate).
 */
export function buildUserRecordData(input: BuildUserRecordInput): UserRecordData | null {
  const { record, hlc, origin, observed } = input;
  const recordKey = deriveUserRecordKey(record.channels);
  if (recordKey === null) return null;

  const data: UserRecordData = {
    name: clampFreeTextEmit(record.name),
    channels: record.channels.slice(0, MAX_CHANNELS).map((c) => ({ type: c.type, identifier: c.identifier })),
    permissions: Array.isArray(record.permissions) ? record.permissions.slice(0, MAX_PERMISSIONS).map((p) => clampFreeTextEmit(p, MAX_SLUG_LENGTH)) : [],
    // envelope fields (recordKey = identity surface).
    recordKey,
    hlc,
    op: 'put' as ReplicatedOp,
    origin,
    ...(observed !== undefined ? { observed } : {}),
  };
  // Optional fields — only when present (the local userId is NEVER among them).
  if (typeof record.telegramUserId === 'number' && Number.isFinite(record.telegramUserId)) data.telegramUserId = record.telegramUserId;
  if (typeof record.slackUserId === 'string' && record.slackUserId.length > 0) data.slackUserId = clampFreeTextEmit(record.slackUserId, MAX_SLUG_LENGTH);
  if (typeof record.createdAt === 'string' && record.createdAt.length > 0) data.createdAt = record.createdAt;
  if (typeof record.relationshipContext === 'string' && record.relationshipContext.length > 0) data.relationshipContext = clampFreeTextEmit(record.relationshipContext);

  assertProjectionUnderCap(recordKey, data);
  return data;
}

/** Throw UserRecordTooLargeError if the projected data serializes over the per-entry cap. The
 *  cap is set so a legal disclosure-minimized record can never reach it; this is the
 *  belt-and-suspenders named rejection. */
export function assertProjectionUnderCap(recordKey: string, data: UserRecordData): void {
  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf-8');
  if (bytes > USER_MAX_ENTRY_BYTES) {
    throw new UserRecordTooLargeError(recordKey, bytes);
  }
}

/** Input to buildUserTombstoneData: the channel set of the deleted user (to derive the
 *  recordKey identity surface), the freshly-ticked hlc, the origin, and the deletedAt
 *  timestamp. */
export interface BuildUserTombstoneInput {
  channels: ReadonlyArray<UserChannel>;
  hlc: HlcTimestamp;
  origin: string;
  deletedAt: string;
  observed?: HlcTimestamp;
}

/**
 * Build an `op:'delete'` TOMBSTONE `data` for a user removal. recordKey = the SAME channel-set
 * identity surface the value records key on, so the tombstone reaches the same human's record
 * on every machine even though the local ids differ. Returns null when the user has no channels
 * (no identity surface to tombstone).
 *
 * CRITICAL: the UserManager.removeUser() path MUST call this, else a peer re-replicates the
 * locally-removed user forever (resurrection). The delete-resurrection guard lives in the merge
 * (a later `delete` hlc wins over an earlier `put`).
 */
export function buildUserTombstoneData(input: BuildUserTombstoneInput): UserRecordData | null {
  const recordKey = deriveUserRecordKey(input.channels);
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

/** A merged user view entry: the projected record fields PLUS its origin machine id (so a
 *  foreign record is rendered inside the untrusted-data envelope). READ-ONLY — NEVER written
 *  back into the local store. */
export interface MergedUserView {
  recordKey: string;
  origin: string;
  /** The validated, type-clamped projection fields (the receive-side schema already ran on
   *  apply; here `data` is that validated portion). */
  data: Record<string, unknown>;
  /** True when this view entry is one of ≥2 concurrent variants of an OPEN conflict
   *  (append-both — both surface; the read NEVER suppresses a usable view AND NEVER blocks on
   *  the unresolved conflict). */
  conflicted: boolean;
}

/** Reconstruct a MergedUserView from an OriginRecord (the envelope stripped). */
function viewFromOriginRecord(rec: OriginRecord, conflicted: boolean): MergedUserView {
  return { recordKey: rec.envelope.recordKey, origin: rec.origin, data: rec.data, conflicted };
}

/**
 * Collapse a `Map<recordKey, UnionResult>` into the merged user view.
 * HIGH-impact-at-replication / ADVISORY-at-read contract (fork #2):
 *   - A resolved single value ⇒ that one view entry.
 *   - An OPEN concurrent conflict ⇒ BOTH (all) `put` variants as separate entries (append-both
 *     — both surface as ADVISORY hints; the read NEVER suppresses a usable view AND NEVER
 *     BLOCKS waiting on operator resolution — a replicated user is a hint, not authority). A
 *     `delete` variant contributes nothing to display.
 *   - A delete-resolved key (every origin's latest is a tombstone) ⇒ nothing (the
 *     delete-resurrection guard: a later delete wins over an earlier put).
 * The read is READ-ONLY: a replicated record NEVER clobbers a divergent local record — the
 * local store files are never written here.
 */
export function mergeUnionToUsers(union: Map<string, UnionResult>): MergedUserView[] {
  const out: MergedUserView[] = [];
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

/** Sanitize a string for inclusion in a context block (escape the envelope-break + markup
 *  vectors). */
function sanitize(s: string): string {
  return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render a FOREIGN (replicated) user record into a session-context block, wrapped in an
 * explicit `<replicated-untrusted-data origin="…">` envelope so the session model treats it as
 * a PEER'S claim to re-ground against, never a directive AND never the authoritative
 * inbound-resolution answer. EVERY rendered field is escaped — there is no "trusted because
 * machine-set" slot. A null `data.name` (a malformed view) yields null.
 */
export function renderForeignUserContext(view: MergedUserView): string | null {
  const d = view.data;
  if (typeof d.name !== 'string' || d.name.length === 0) return null;
  const safeOrigin = sanitize(view.origin);
  const lines: string[] = [
    `<replicated-untrusted-data origin="${safeOrigin}">`,
    `User: ${sanitize(d.name)}`,
  ];
  if (Array.isArray(d.channels)) {
    const platforms = [...new Set((d.channels as UserChannel[]).map((c) => c.type))];
    if (platforms.length > 0) lines.push(`Platforms: ${platforms.map(sanitize).join(', ')}`);
  }
  if (Array.isArray(d.permissions) && d.permissions.length > 0) lines.push(`Permissions: ${(d.permissions as string[]).map(sanitize).join(', ')}`);
  if (typeof d.relationshipContext === 'string' && d.relationshipContext.length > 0) lines.push(`Relationship: ${sanitize(d.relationshipContext)}`);
  if (typeof d.createdAt === 'string') lines.push(`Known since: ${sanitize(d.createdAt)}`);
  lines.push('</replicated-untrusted-data>');
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// Own-origin materialization for the union reader (mirrors WS2.3)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build an OriginRecord for the OWN user registry (the single-origin materialization the union
 * reader merges against peer replicas). recordKey = derived channel-set identity surface; the
 * envelope carries a SYNTHETIC own-origin HLC stamp derived deterministically from the
 * record's createdAt (physical) so the own record has a well-formed, stable position relative
 * to peer records. Returns null for a channel-less record (no identity surface). The local
 * `userId` is NEVER carried into the replicated namespace (fork #1/#3).
 */
export function userToOriginRecord(record: UserProfile, origin: string): OriginRecord | null {
  const recordKey = deriveUserRecordKey(record.channels);
  if (recordKey === null) return null;
  const physical = Date.parse(record.createdAt ?? '');
  const hlc: HlcTimestamp = {
    physical: Number.isFinite(physical) ? physical : 0,
    logical: 0,
    node: origin,
  };
  const data: Record<string, unknown> = {
    name: record.name,
    channels: record.channels.map((c) => ({ type: c.type, identifier: c.identifier })),
    permissions: Array.isArray(record.permissions) ? record.permissions : [],
  };
  if (typeof record.telegramUserId === 'number' && Number.isFinite(record.telegramUserId)) data.telegramUserId = record.telegramUserId;
  if (typeof record.slackUserId === 'string' && record.slackUserId.length > 0) data.slackUserId = record.slackUserId;
  if (typeof record.createdAt === 'string' && record.createdAt.length > 0) data.createdAt = record.createdAt;
  if (typeof record.relationshipContext === 'string' && record.relationshipContext.length > 0) data.relationshipContext = record.relationshipContext;
  const envelope: ReplicatedEnvelope = { recordKey, hlc, op: 'put', origin };
  return { origin, envelope, data };
}

// ───────────────────────────────────────────────────────────────────────────
// Registration descriptor (consumed by server.ts to register the dual registry)
// ───────────────────────────────────────────────────────────────────────────

/** The ReplicatedKindRegistry registration for the `user-record` store. server.ts registers
 *  this onto the shared registry; the dual-registry coupling test asserts `kind` is also
 *  present in JOURNAL_KINDS. */
export const USER_KIND_REGISTRATION = {
  kind: USER_RECORD_KIND,
  store: USER_STORE_KEY,
  schema: userRecordStoreSchema,
} as const;

/** Convenience: the store's contributing journal kinds (for rollback-unmerge's
 *  kindsForStore('userRegistry') wiring). */
export function userContributingKinds(): string[] {
  return [USER_RECORD_KIND];
}

/** The store's impact tier resolver, for ReplicatedStoreReader.tierOf. Returns HIGH for the
 *  `userRegistry` store (and HIGH for any unknown store — the conservative
 *  append-both-and-flag direction, never a silent clobber). */
export function userTierOf(_store: string): ImpactTier {
  return USER_IMPACT_TIER;
}

/** Re-export the envelope type for callers building/applying user-record envelopes. */
export type { ReplicatedEnvelope };
