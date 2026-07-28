/**
 * ThreadlinePairingReplicatedStore — replicate ONLY the verified-IDENTITY RESULT of a
 * Secure A2A pairing across the agent's OWN machines (Secure A2A Verified Pairing §3.8 /
 * FD11). It is the EIGHTH concrete consumer of the HLC replicated-store foundation,
 * layering a `threadline-pairing-record` replicated kind onto the generic substrate
 * (ReplicatedRecordEnvelope / UnionReader / ReplicationBudget) so that a pairing a HUMAN
 * SAS-verified on machine A is HONORED on machine B — without ever re-deriving the SAS on B.
 *
 * It is the literal analog of the WS2 PII stores (RelationshipsReplicatedStore /
 * TopicOperatorReplicatedStore): type-clamp on receive, untrusted-envelope render,
 * fingerprint-keyed identity, tombstone on revoke, dark by default. THIS IS PURE LOGIC.
 * No fs, no Date directly, no network.
 *
 * ── THE SECURITY BOUNDARY THAT MAKES THIS SAFE (§3.8) ────────────────────────────────
 *
 * Only FIVE fields ever cross a machine boundary:
 *     { peerFp, peerIdentityPub, state:'mutual-verified', verifiedAt, verifiedOnMachine }
 * NEVER the SAS words, NEVER the shared secret, NEVER the relay token — those are bound to
 * the MACHINE-LOCAL handshake's ephemeral shared secret (machine A and B derive DIFFERENT
 * secrets/SAS for the same peer) and stay machine-local by design. This serializer
 * STRUCTURALLY cannot leak them: its INPUT type (`VerifiedPairingResult`) does not even
 * HAVE a sasWords/sharedSecret/relayToken field, and the projection enumerates the five
 * fields explicitly — there is no spread of an on-disk blob, so a secret that is not a
 * field of the input can never become a field of the output.
 *
 * ── HOW MACHINE B HONORS A REPLICATED RECORD (codex finding 1, MATERIAL) ──────────────
 *
 * Machine B honors a replicated `mutual-verified` record ONLY by PINNING the record's
 * `peerIdentityPub`. The honoring decision lives in the CONSUMER (AgentTrustManager.
 * inheritReplicatedVerification): a handshake on B for that `peerFp` whose presented
 * identity key does NOT match the pinned `peerIdentityPub` is REFUSED the inheritance and
 * downgraded to `pending-verification` (re-verify on B) — never auto-`mutual-verified`,
 * never silently-untrusted-but-honored. The replicated grant binds to the exact identity
 * key the human verified. (The `peerFp` is itself the first 16 bytes of that key, so a
 * mismatch is a fingerprint-collision/substitution attempt.)
 *
 * INHERITED = `identity-verified`, NOT channel-ready (codex round-2 finding 1): the
 * replicated record asserts only "this identity key was SAS-verified by a human somewhere".
 * Before B may open credential-share to that peer, B must ADDITIONALLY have its OWN live
 * encrypted+signed handshake channel (the outbound CredentialShareGate already enforces the
 * encrypted-path half). So credential-share on B = inherited `identity-verified` (key-pinned)
 * AND B's own live encrypted channel.
 *
 * A `verification-failed`/revoke propagates as a TOMBSTONE so an un-verify sticks pool-wide.
 *
 * SAFETY POSTURE (§3.8 / §3.10): MECHANISM, ships DARK behind
 * `multiMachine.stateSync.threadlinePairing.{enabled:false, dryRun:true}` — flag-off is a
 * strict no-op (single-machine agents unaffected). Nothing here blocks a user action.
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

/** The stateSync config sub-key + advert suffix for this store (e.g.
 *  `multiMachine.stateSync.threadlinePairing.enabled`). Equal to the advert flag key
 *  `stateSyncReceive['threadlinePairing']`. */
export const THREADLINE_PAIRING_STORE_KEY = 'threadlinePairing';

/** The JournalKind string this store rides — the DUAL-REGISTRY's dynamic half.
 *  MUST also be present in CoherenceJournal.JOURNAL_KINDS (the static half), or the
 *  store advertises receive=true yet serves/applies/pulls nothing. */
export const THREADLINE_PAIRING_RECORD_KIND = 'threadline-pairing-record';

/**
 * Pairing results are HIGH-impact at the REPLICATION layer (a divergent concurrent
 * edit goes through APPEND-BOTH-AND-FLAG — never a silent clobber). In practice a
 * verified-identity result is monotonic per (peerFp, identity key) and the consumer
 * key-pins, so a genuine concurrent divergence (two machines verifying a DIFFERENT
 * identity key for the SAME peerFp) is exactly the fingerprint-substitution case the
 * append-both surfaces rather than auto-merges.
 */
export const THREADLINE_PAIRING_IMPACT_TIER: ImpactTier = 'high';

/** The single state value a verified-identity result may carry across the wire (§3.8):
 *  ONLY `mutual-verified`. A `pending-verification` (machine-local SAS state) NEVER
 *  replicates; an un-verify propagates as a tombstone, not a state value. */
export const REPLICATED_PAIRING_STATE = 'mutual-verified' as const;

/** A peer fingerprint is the first 16 bytes (32 hex chars) of the Ed25519 public key. */
export const PAIRING_FP_MIN_LEN = 4; // tolerant lower bound (test fixtures use short fps)
export const PAIRING_FP_MAX_LEN = 128;
/** An Ed25519 public key is 32 bytes = 64 hex chars; allow a tolerant range. */
export const PAIRING_PUB_MAX_LEN = 256;
/** verifiedOnMachine is a machine id (origin-shaped); length-bounded. */
export const PAIRING_MACHINE_ID_MAX_LEN = 256;

/**
 * Per-kind replication bounds. The pairing store is FEW + bounded (one record per
 * verified peer — single digits in practice). The rate cap COALESCES (latest state per
 * recordKey per interval) so a re-handshake/re-verify loop cannot flood the stream.
 * NEVER `rotateKeep: 0`.
 */
export const THREADLINE_PAIRING_RECORD_BOUNDS: ReplicatedKindBounds = {
  retention: { maxFileBytes: 1 * 1024 * 1024, rotateKeep: 4 },
  rateCap: { capacity: 20, refillPerSec: 5 },
};

/** Per-entry size cap. A pairing record is tiny (5 short fields); 8KB is generous. */
export const THREADLINE_PAIRING_MAX_ENTRY_BYTES = 8 * 1024;

/**
 * The store-specific field names the VALUE schema OWNS. DELIBERATELY a CLOSED set of
 * FOUR (the fifth replicated field, `peerFp`, is carried by the envelope `recordKey` —
 * see deriveThreadlinePairingRecordKey). The SAS words, shared secret, and relay token
 * are NOT in this allowlist by construction, so the envelope validator DROPS any such
 * field a hostile/buggy peer smuggles in. `recordKey`/`hlc`/`op`/`origin`/`observed`
 * are reserved envelope fields, never store fields.
 */
export const THREADLINE_PAIRING_STORE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'peerFp',
  'peerIdentityPub',
  'state',
  'verifiedAt',
  'verifiedOnMachine',
]);

/** The tombstone's store-owned fields beyond the reserved envelope set. `deletedAt`
 *  is the only store field a delete (revoke/verification-failed) carries. */
export const THREADLINE_PAIRING_TOMBSTONE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  'deletedAt',
]);

/** The full set of known store fields across BOTH op-branches. */
const ALL_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
  ...THREADLINE_PAIRING_STORE_KNOWN_FIELDS,
  ...THREADLINE_PAIRING_TOMBSTONE_KNOWN_FIELDS,
]);

// ── ISO-8601 type-clamp (§3.8 explicitly requires `verifiedAt` ISO-8601-only). ───────

/** Is `v` a valid ISO-8601 date string (and ONLY a date — no smuggled markup)? */
export function isIso8601(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) return false;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return false;
  if (v.includes('<') || v.includes('>') || v.includes('"')) return false;
  return true;
}

/** Is `v` a clean lowercase/uppercase HEX string within bounds (no markup vectors)?
 *  peerFp + peerIdentityPub are hex-only by construction (Ed25519 key material), so a
 *  non-hex value on a foreign record is a tampered record and rejects the whole record. */
function isHexString(v: unknown, minLen: number, maxLen: number): v is string {
  if (typeof v !== 'string') return false;
  if (v.length < minLen || v.length > maxLen) return false;
  return /^[0-9a-fA-F]+$/.test(v);
}

/** A length-bounded, non-markup machine-id string (origin-shaped). Empty/over-cap → null. */
function clampMachineId(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > PAIRING_MACHINE_ID_MAX_LEN) return null;
  if (v.includes('<') || v.includes('>') || v.includes('"')) return null;
  return v;
}

/**
 * The `threadline-pairing-record` store schema — a DISCRIMINATED UNION on `op`. Strict
 * typed validation on top of the envelope: TYPE-CLAMP every known field (verifiedAt
 * ISO-8601-only, peerFp/peerIdentityPub hex-only, state MUST EQUAL 'mutual-verified',
 * verifiedOnMachine length-bounded) so markup cannot smuggle through a render slot AND
 * a non-`mutual-verified` state can never become a replicated value. Returns the
 * validated store-specific object (known fields only), or null to reject the WHOLE
 * record. PURE (no I/O, no mutation of `raw`).
 *
 * The envelope validator has ALREADY validated `op` ∈ {put,delete} before calling this.
 */
export const threadlinePairingRecordStoreSchema: StoreFieldSchema = {
  knownFields: ALL_KNOWN_FIELDS,
  validate(raw: Readonly<Record<string, unknown>>, ctx: StoreValidateContext): Record<string, unknown> | null {
    const op = raw.op;

    // ── DELETE (tombstone) branch — revoke / verification-failed propagation (§3.8).
    //    Only `deletedAt` is a legal store field; any VALUE field present is counted
    //    as a dropped field but does not reject — the tombstone's recordKey + hlc + op
    //    carry the suppression. ──────────────────────────────────────────────────────
    if (op === 'delete') {
      const deletedAt = isIso8601(raw.deletedAt) ? (raw.deletedAt as string) : undefined;
      for (const k of Object.keys(raw)) {
        if (k === 'op' || k === 'deletedAt') continue;
        if (THREADLINE_PAIRING_STORE_KNOWN_FIELDS.includes(k)) ctx.countDroppedField();
      }
      return deletedAt !== undefined ? { deletedAt } : {};
    }

    // ── VALUE (put) branch. ──────────────────────────────────────────────────────────
    // peerFp — required hex (the cross-machine identity surface; the recordKey is
    // derived from it). A non-hex peerFp is a tampered record → reject.
    if (!isHexString(raw.peerFp, PAIRING_FP_MIN_LEN, PAIRING_FP_MAX_LEN)) return null;
    const peerFp = raw.peerFp as string;

    // peerIdentityPub — required hex (the PINNED key the consumer honors against, §3.8).
    if (!isHexString(raw.peerIdentityPub, PAIRING_FP_MIN_LEN, PAIRING_PUB_MAX_LEN)) return null;
    const peerIdentityPub = raw.peerIdentityPub as string;

    // state — MUST be exactly 'mutual-verified' (§3.8). Anything else (incl.
    // 'pending-verification' / 'verification-failed' / arbitrary markup) is REJECTED:
    // a machine-local-only state never replicates as a value.
    if (raw.state !== REPLICATED_PAIRING_STATE) return null;

    // verifiedAt — ISO-8601 ONLY (§3.8). A non-date is rejected (markup cannot survive).
    if (!isIso8601(raw.verifiedAt)) return null;
    const verifiedAt = raw.verifiedAt as string;

    // verifiedOnMachine — required length-bounded machine id.
    const verifiedOnMachine = clampMachineId(raw.verifiedOnMachine);
    if (verifiedOnMachine === null) return null;

    return {
      peerFp,
      peerIdentityPub,
      state: REPLICATED_PAIRING_STATE,
      verifiedAt,
      verifiedOnMachine,
    };
  },
};

// ───────────────────────────────────────────────────────────────────────────
// recordKey — the cross-machine IDENTITY SURFACE
// ───────────────────────────────────────────────────────────────────────────

/**
 * Derive the cross-machine-stable recordKey for a pairing. A peer is "the same" across
 * machines by their FINGERPRINT (the first 16 bytes of their Ed25519 identity key), which
 * is itself stable + machine-independent. We hash it to a bounded, non-path-shaped string
 * (the same shape UnionReader.conflictId uses) so the envelope's recordKey jail accepts it.
 * Returns null for an empty/degenerate fingerprint (no identity surface — skip emission).
 */
export function deriveThreadlinePairingRecordKey(peerFp: string): string | null {
  const fp = (peerFp ?? '').trim();
  if (fp.length === 0) return null;
  const h = createHash('sha256');
  h.update(`threadline-pairing\x1f${fp.toLowerCase()}`);
  return h.digest('hex').slice(0, 32);
}

// ───────────────────────────────────────────────────────────────────────────
// B. Emit — VerifiedPairingResult → the replicated `data` (the 5-field projection)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The MINIMAL verified-identity RESULT — the ONLY shape that ever crosses a machine
 * boundary (§3.8). This type STRUCTURALLY prevents the SAS, shared secret, and relay
 * token from being replicated: it does not have those fields, so the serializer below
 * (which projects ONLY this object's enumerated fields) can never emit them.
 */
export interface VerifiedPairingResult {
  /** The peer's fingerprint (first 16 bytes of their Ed25519 key, hex). */
  peerFp: string;
  /** The peer's Ed25519 identity public key (hex) — the value machine B PINS against. */
  peerIdentityPub: string;
  /** The single replicated state. Always 'mutual-verified' (a value record never carries
   *  any other state — an un-verify is a tombstone). */
  state: typeof REPLICATED_PAIRING_STATE;
  /** When the local operator SAS-confirmed the peer (ISO-8601). */
  verifiedAt: string;
  /** The machine id whose operator did the SAS comparison. */
  verifiedOnMachine: string;
}

/** The `data` object a `threadline-pairing-record` journal entry carries. */
export type ThreadlinePairingRecordData = Record<string, unknown>;

/** Input to buildThreadlinePairingRecordData: the result to emit, the freshly-ticked
 *  hlc, this machine's origin id, and the observed-witness (or absent). */
export interface BuildThreadlinePairingRecordInput {
  result: VerifiedPairingResult;
  hlc: HlcTimestamp;
  origin: string;
  observed?: HlcTimestamp;
}

/** The named error a record-over-cap surfaces (never silent-truncate). A pairing record
 *  is tiny so this is purely belt-and-suspenders. */
export class ThreadlinePairingRecordTooLargeError extends Error {
  constructor(public readonly recordKey: string, public readonly bytes: number) {
    super(`threadline-pairing-record ${recordKey} is ${bytes} bytes after projection — over the ${THREADLINE_PAIRING_MAX_ENTRY_BYTES}-byte per-entry cap; not replicated`);
    this.name = 'ThreadlinePairingRecordTooLargeError';
  }
}

/**
 * Build the `threadline-pairing-record` envelope `data` for an `op:'put'`. Emits ONLY
 * the FIVE allowed fields (§3.8) — peerFp + peerIdentityPub + state + verifiedAt +
 * verifiedOnMachine (peerFp via the envelope recordKey AND as an explicit field for the
 * consumer). NEVER the SAS / shared secret / relay token — structurally impossible,
 * since they are not fields of `VerifiedPairingResult` and the projection is an explicit
 * enumeration (no blob spread).
 *
 * Returns null when the fingerprint has no identity surface (the caller skips emission).
 * Throws ThreadlinePairingRecordTooLargeError if the projection somehow exceeds the cap.
 */
export function buildThreadlinePairingRecordData(input: BuildThreadlinePairingRecordInput): ThreadlinePairingRecordData | null {
  const { result, hlc, origin, observed } = input;
  const recordKey = deriveThreadlinePairingRecordKey(result.peerFp);
  if (recordKey === null) return null;

  const data: ThreadlinePairingRecordData = {
    // The FIVE allowed fields — an EXPLICIT enumeration, never a spread of an on-disk
    // blob (so a secret that is not enumerated here can never be emitted).
    peerFp: result.peerFp,
    peerIdentityPub: result.peerIdentityPub,
    state: REPLICATED_PAIRING_STATE,
    verifiedAt: result.verifiedAt,
    verifiedOnMachine: result.verifiedOnMachine,
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

/** Throw ThreadlinePairingRecordTooLargeError if the projected data serializes over the
 *  per-entry cap. */
export function assertProjectionUnderCap(recordKey: string, data: ThreadlinePairingRecordData): void {
  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf-8');
  if (bytes > THREADLINE_PAIRING_MAX_ENTRY_BYTES) {
    throw new ThreadlinePairingRecordTooLargeError(recordKey, bytes);
  }
}

/** Input to buildThreadlinePairingTombstoneData: the peer fingerprint of the un-verified
 *  pairing, the freshly-ticked hlc, the origin, and the deletedAt timestamp. */
export interface BuildThreadlinePairingTombstoneInput {
  peerFp: string;
  hlc: HlcTimestamp;
  origin: string;
  deletedAt: string;
  observed?: HlcTimestamp;
}

/**
 * Build an `op:'delete'` TOMBSTONE `data` for a pairing revoke / verification-failed
 * (§3.8). recordKey = the SAME fingerprint identity surface the value records key on, so
 * the tombstone reaches the same peer's record on every machine — an un-verify sticks
 * pool-wide even on a machine that was offline at revoke time. Returns null for an empty
 * fingerprint (no identity surface to tombstone).
 */
export function buildThreadlinePairingTombstoneData(input: BuildThreadlinePairingTombstoneInput): ThreadlinePairingRecordData | null {
  const recordKey = deriveThreadlinePairingRecordKey(input.peerFp);
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
// C. Union-aware read — HIGH-impact append-both-and-flag
// ───────────────────────────────────────────────────────────────────────────

/** A merged pairing view entry: the projected record fields PLUS its origin machine id.
 *  READ-ONLY — it is NEVER written back into the local store. */
export interface MergedPairingView {
  recordKey: string;
  origin: string;
  /** The validated, type-clamped projection fields. */
  data: Record<string, unknown>;
  /** True when this view entry is one of ≥2 concurrent variants of an OPEN conflict
   *  (append-both — both surface, never a silent clobber). */
  conflicted: boolean;
}

function viewFromOriginRecord(rec: OriginRecord, conflicted: boolean): MergedPairingView {
  return { recordKey: rec.envelope.recordKey, origin: rec.origin, data: rec.data, conflicted };
}

/**
 * Collapse a `Map<recordKey, UnionResult>` into the merged pairing view.
 *   - A resolved single value ⇒ that one view entry.
 *   - An OPEN concurrent conflict ⇒ BOTH (all) `put` variants (append-both — never a
 *     silent clobber; two machines verifying a DIFFERENT identity key for the SAME
 *     peerFp is exactly the substitution case to surface, not auto-merge).
 *   - A delete-resolved key (every origin's latest is a tombstone) ⇒ nothing (the
 *     revoke-resurrection guard: a later delete wins over an earlier put).
 * READ-ONLY: a replicated record NEVER clobbers a divergent local record.
 */
export function mergeUnionToPairings(union: Map<string, UnionResult>): MergedPairingView[] {
  const out: MergedPairingView[] = [];
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
// D. Consumer honoring — key-pinning (§3.8, codex finding 1)
// ───────────────────────────────────────────────────────────────────────────

/** The verdict of evaluating whether machine B may INHERIT a replicated pairing for a
 *  peer it is handshaking with, given the identity key B's live handshake presented. */
export type InheritDecision =
  /** No replicated mutual-verified record for this peer — nothing to inherit. */
  | { honor: false; reason: 'no-replicated-record' }
  /** A replicated record exists but its pinned key does NOT match B's handshake key —
   *  REFUSE inheritance + downgrade to pending-verification (re-verify on B). A
   *  fingerprint-substitution attempt. */
  | { honor: false; reason: 'identity-key-mismatch'; pinnedKey: string; presentedKey: string }
  /** Honor: the pinned identity key matches → B inherits `identity-verified` (NOT
   *  channel-ready; the credential gate still requires B's own encrypted channel). */
  | { honor: true; pinnedKey: string; verifiedAt?: string; verifiedOnMachine?: string };

/**
 * Decide whether machine B HONORS a replicated mutual-verified pairing for `peerFp`,
 * given the identity public key B's OWN live handshake presented for that peer
 * (`presentedIdentityPub`, or undefined if B has no live handshake yet).
 *
 * The honoring rule (§3.8): pin the record's `peerIdentityPub`. If B has a live handshake
 * AND its presented key differs from the pinned key → REFUSE (identity-key-mismatch →
 * downgrade to pending-verification). If B has no live handshake yet, the inheritance is
 * honored as `identity-verified` against the pinned key (B's own encrypted channel is a
 * SEPARATE precondition the credential gate enforces — inherited ≠ channel-ready).
 *
 * Reads the merged view (the union of peer replicas) and resolves the record for `peerFp`.
 * A null `presentedIdentityPub` means "no live handshake key to contradict the pin yet" —
 * the inheritance is honored (key-pinned) but stays NOT-channel-ready.
 */
export function evaluateInheritedVerification(
  views: ReadonlyArray<MergedPairingView>,
  peerFp: string,
  presentedIdentityPub: string | undefined,
): InheritDecision {
  const recordKey = deriveThreadlinePairingRecordKey(peerFp);
  if (recordKey === null) return { honor: false, reason: 'no-replicated-record' };

  // Find a mutual-verified value view for this peer. An open conflict (two divergent
  // pinned keys) is NOT auto-honored — we require a single, unambiguous pinned key, so
  // a conflicted record falls through to no-honor (the safe direction).
  const matching = views.filter(
    (v) =>
      v.recordKey === recordKey &&
      v.data.state === REPLICATED_PAIRING_STATE &&
      typeof v.data.peerIdentityPub === 'string',
  );
  if (matching.length === 0) return { honor: false, reason: 'no-replicated-record' };

  // Distinct pinned keys across the matching views. >1 distinct key (a genuine
  // substitution divergence) is never auto-honored.
  const pinnedKeys = new Set(matching.map((v) => (v.data.peerIdentityPub as string).toLowerCase()));
  if (pinnedKeys.size !== 1) {
    // Treat as a mismatch against B's presented key (or no-record when B has none) — the
    // safe direction. We surface the first key for the audit.
    const pinnedKey = matching[0].data.peerIdentityPub as string;
    if (presentedIdentityPub) {
      return { honor: false, reason: 'identity-key-mismatch', pinnedKey, presentedKey: presentedIdentityPub };
    }
    return { honor: false, reason: 'no-replicated-record' };
  }

  const view = matching[0];
  const pinnedKey = view.data.peerIdentityPub as string;

  // Key-pin: a live handshake whose key differs from the pin is REFUSED inheritance.
  if (presentedIdentityPub && presentedIdentityPub.toLowerCase() !== pinnedKey.toLowerCase()) {
    return { honor: false, reason: 'identity-key-mismatch', pinnedKey, presentedKey: presentedIdentityPub };
  }

  return {
    honor: true,
    pinnedKey,
    verifiedAt: typeof view.data.verifiedAt === 'string' ? (view.data.verifiedAt as string) : undefined,
    verifiedOnMachine: typeof view.data.verifiedOnMachine === 'string' ? (view.data.verifiedOnMachine as string) : undefined,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// E. Foreign-record render safety — quoted untrusted data
// ───────────────────────────────────────────────────────────────────────────

function sanitize(s: string): string {
  return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render a FOREIGN (replicated) pairing record into a context block, wrapped in an
 * explicit `<replicated-untrusted-data origin="…">` envelope so a reader treats it as a
 * PEER MACHINE'S claim to re-ground against, never a directive. EVERY field is escaped.
 * A malformed view (no peerFp) yields null. The SAS / secret / token can never appear
 * here — they are never fields of the record.
 */
export function renderForeignPairingContext(view: MergedPairingView): string | null {
  const d = view.data;
  if (typeof d.peerFp !== 'string' || d.peerFp.length === 0) return null;
  const safeOrigin = sanitize(view.origin);
  const lines: string[] = [
    `<replicated-untrusted-data origin="${safeOrigin}">`,
    `Verified pairing (peer fingerprint): ${sanitize(d.peerFp)}`,
    `State: ${sanitize(typeof d.state === 'string' ? d.state : '')}`,
  ];
  if (typeof d.verifiedAt === 'string') lines.push(`Verified at: ${sanitize(d.verifiedAt)}`);
  if (typeof d.verifiedOnMachine === 'string') lines.push(`Verified on machine: ${sanitize(d.verifiedOnMachine)}`);
  lines.push('</replicated-untrusted-data>');
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// Own-origin materialization for the union reader
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build an OriginRecord for the OWN pairing store (the single-origin materialization the
 * union reader merges against peer replicas). recordKey = derived fingerprint identity
 * surface; the envelope carries a SYNTHETIC own-origin HLC stamp derived deterministically
 * from verifiedAt (physical) so the own record has a well-formed, stable position relative
 * to peer records. Returns null for a degenerate record (no identity surface). The
 * machine-local SAS / pending state is NEVER carried into the replicated namespace.
 */
export function pairingResultToOriginRecord(result: VerifiedPairingResult, origin: string): OriginRecord | null {
  const recordKey = deriveThreadlinePairingRecordKey(result.peerFp);
  if (recordKey === null) return null;
  const physical = Date.parse(result.verifiedAt);
  const hlc: HlcTimestamp = {
    physical: Number.isFinite(physical) ? physical : 0,
    logical: 0,
    node: origin,
  };
  const data: Record<string, unknown> = {
    peerFp: result.peerFp,
    peerIdentityPub: result.peerIdentityPub,
    state: REPLICATED_PAIRING_STATE,
    verifiedAt: result.verifiedAt,
    verifiedOnMachine: result.verifiedOnMachine,
  };
  const envelope: ReplicatedEnvelope = { recordKey, hlc, op: 'put', origin };
  return { origin, envelope, data };
}

// ───────────────────────────────────────────────────────────────────────────
// Registration descriptor (consumed by server.ts to register the dual registry)
// ───────────────────────────────────────────────────────────────────────────

/** The ReplicatedKindRegistry registration for the `threadline-pairing-record` store. */
export const THREADLINE_PAIRING_KIND_REGISTRATION = {
  kind: THREADLINE_PAIRING_RECORD_KIND,
  store: THREADLINE_PAIRING_STORE_KEY,
  schema: threadlinePairingRecordStoreSchema,
} as const;

/** Convenience: the store's contributing journal kinds (for rollback-unmerge wiring). */
export function threadlinePairingContributingKinds(): string[] {
  return [THREADLINE_PAIRING_RECORD_KIND];
}

/** The store's impact tier resolver, for ReplicatedStoreReader.tierOf. */
export function threadlinePairingTierOf(_store: string): ImpactTier {
  return THREADLINE_PAIRING_IMPACT_TIER;
}

/** Re-export the envelope type for callers building/applying pairing-record envelopes. */
export type { ReplicatedEnvelope };
