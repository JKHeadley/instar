/**
 * ReplicatedRecordEnvelope — the GENERIC substrate for replicated-store journal
 * kinds (WS2 replicated-store foundation, Component 2 / Build-order step 2).
 *
 * Spec: docs/specs/multi-machine-replicated-store-foundation.md §4 (the
 * replicated-record envelope, flag-gated + flag-coherence-gated emission), §10
 * (config / advert / awareness), §13 build-order item 2, §14 (safety posture).
 *
 * This module is the REUSABLE machinery the concrete stores (WS2.1 preferences,
 * relationships, learnings, …) layer a kind onto. It adds NO concrete store
 * kind itself — the registry ships EMPTY. It provides exactly four pieces:
 *
 *   A. The replicated-record envelope type + a parameterizable STRICT validator
 *      (`validateReplicatedEnvelope`) that mirrors the CoherenceJournal typed-
 *      schema discipline: reject free text, drop unknown fields (counted), jail
 *      any path-shaped field, validate `hlc` + (when present) `observed` as
 *      well-formed HlcTimestamps. ABSENT `observed` is LEGAL ⇒ "no prior
 *      witness" ⇒ flag-on-conflict (the safe direction, §4 / §7.2). The validated
 *      envelope fields are AUTHORITATIVE: a store schema can never override a
 *      reserved envelope field on the reconstructed `data` (reserved keys the
 *      store returns are stripped + counted), and the path-jail is REUSABLE
 *      machinery for store fields too — a store declares `pathSensitiveFields`
 *      for auto-jailing, or calls the exported `jailStoreStringField` helper.
 *      Reserved-key collisions in a store's `knownFields` are rejected at
 *      registration time (a wiring-time programmer error), not trusted to a
 *      store's self-check.
 *
 *   B. A registry of replicated kinds (`ReplicatedKindRegistry`) — the generic
 *      registration mechanism a concrete store calls to register its kind +
 *      store-specific field schema. Initially empty (no concrete kind).
 *
 *   C. Flag-gated emission (`isStoreEmissionEnabled`) — a replicated kind is
 *      emitted ONLY when `multiMachine.stateSync.<store>.enabled` is true
 *      (default FALSE). When off, strict no-op.
 *
 *   D. Flag-coherence-gated emission (`shouldEmitToPeer`,
 *      `checkPoolFlagCoherence`) — a replicated kind is exchanged with a peer ONLY
 *      when that peer's `seamlessnessFlags` advertises the matching
 *      `stateSync.<store>` capability. The applier "silently drops unknown
 *      kinds" (forward-compat). The per-peer decision is correct for N peers
 *      (never assumes exactly 2); the boot-time pool-flag-coherence check
 *      coalesces ALL mixed-flag peers into ONE surfaced result.
 *
 * TRANSPORT IS PULL — `shouldEmitToPeer` is intentionally UNWIRED in Step 2.
 * The real journal-sync transport is RECEIVER-DRIVEN PULL: `PeerPresencePuller`
 * iterates the SENDER's advert (`CoherenceJournal.getOwnAdvert()`, over the static
 * `JOURNAL_KINDS` const) and pulls each kind it is behind on; serve + apply both
 * gate on `JOURNAL_KINDS`. There is NO push-forward step. The named "emit a new
 * kind to an OLD peer → silently dropped" mode therefore manifests as "an old
 * peer NEVER PULLS a kind absent from its own JOURNAL_KINDS" (nothing requested ⇒
 * nothing dropped). On this PULL transport the flag-coherence gate's role is the
 * boot-time pool surface (`checkPoolFlagCoherence`, wired in server.ts) PLUS the
 * serve/pull-decision gate the WS2.1 consumer PR will consult once a concrete
 * kind exists — that is where `shouldEmitToPeer` will be called. In Step 2 it is
 * a pure decision with no concrete kind to serve, hence intentionally unwired
 * (NOT an unintegrated push gate).
 *
 * DUAL-REGISTRY COUPLING — a replicated kind MUST be added to BOTH registries.
 * The new `ReplicatedKindRegistry` (read by the gate + the stateSyncReceive
 * advert) and the static `JOURNAL_KINDS` (in CoherenceJournal.ts, gating serve +
 * apply + enumerated by getOwnAdvert) are TWO parallel kind registries. A WS2.1
 * PR that registers into `ReplicatedKindRegistry` but forgets `JOURNAL_KINDS`
 * yields a store that advertises receive=true yet serves/applies/pulls nothing —
 * a SILENT no-replication. The wiring-integrity test asserts every replicated
 * kind is present in BOTH (a CI ratchet, not a memory item).
 *
 * SAFETY POSTURE (§14): this is MECHANISM, dark by default. NO gate here blocks
 * a user-initiated action. The only refusals are at the RECEIVE door (the
 * validator rejects malformed data) and the EMISSION door (don't forward a kind
 * to a non-advertising peer). Both protect data; neither blocks the user. A
 * single-machine install (no advertising peers) is a strict no-op — emission is
 * gated on having a peer advertising the matching flag.
 *
 * Purity: this module imports ONLY the HLC primitive + node:path (for the
 * path-shape jail's separator detection). No fs, no network, no Date. Every
 * function is a pure function of its inputs.
 */

import path from 'node:path';

import { coerceHlc, type HlcTimestamp } from './HybridLogicalClock.js';

// ───────────────────────────────────────────────────────────────────────────
// A. The replicated-record envelope + strict validator
// ───────────────────────────────────────────────────────────────────────────

/** The op a replicated record carries (§4). A delete is a tombstone, never a
 *  physical removal, so the last-writer-wins merge can resolve a delete↔put
 *  race deterministically. */
export type ReplicatedOp = 'put' | 'delete';

/**
 * The fields EVERY replicated store's journal `data` carries, on top of its
 * store-specific fields (§4):
 *  - `recordKey` — the store's primary key (e.g. a preference id). A non-empty,
 *    length-capped string; never path-shaped (jailed).
 *  - `hlc` — the HlcTimestamp from `clock.tick()` at AUTHOR time. The
 *    load-bearing total order the merge uses.
 *  - `op` — 'put' | 'delete'.
 *  - `origin` — the author machine id. Equal to `entry.machine`, kept EXPLICIT
 *    so the reader/un-merge does not have to infer it (§4).
 *  - `observed` — the single HlcTimestamp the author had ALREADY merged for THIS
 *    recordKey before writing, or ABSENT if none. The last-writer-witness the
 *    sound concurrency detector needs (§7.2): ONE bounded HLC, NOT a per-key
 *    vector. Absent ⇒ "no prior witness" ⇒ flag-on-conflict (the safe direction).
 */
export interface ReplicatedEnvelope {
  recordKey: string;
  hlc: HlcTimestamp;
  op: ReplicatedOp;
  origin: string;
  observed?: HlcTimestamp;
}

/** The envelope's own field names — the union of all reserved keys a store may
 *  not reuse for a store-specific field. Exported AND ENFORCED:
 *  ReplicatedKindRegistry.register() throws if a schema's `knownFields` claims any
 *  of these, and validateReplicatedEnvelope strips any reserved key a store's
 *  validate() returns (counting it as a dropped field) so the validated envelope
 *  fields are the sole authority for the reconstructed `data`. */
export const RESERVED_ENVELOPE_FIELDS: ReadonlyArray<string> = Object.freeze([
  'recordKey',
  'hlc',
  'op',
  'origin',
  'observed',
]);

/** Caps (mirror the CoherenceJournal length-cap discipline — a value over the
 *  cap is rejected, never truncated-and-accepted, so a record is whole or not). */
export const MAX_RECORD_KEY_LENGTH = 512;
export const MAX_ORIGIN_LENGTH = 256;

/**
 * The store-specific schema a concrete store (WS2.1) supplies ON TOP of the
 * envelope. `validate(raw, ctx)` receives the store-specific portion of `data`
 * (the envelope fields already stripped + validated) and must return the
 * validated, known-fields-only object, or null to REJECT the whole record. It
 * MUST NOT mutate `raw`. `knownFields` is the allowlist the envelope validator
 * uses to count dropped unknown fields across BOTH the envelope and the store
 * portion — a store reports the field names it owns here.
 *
 * Parameterizable by design: the envelope validator is generic; the store-
 * specific discipline (which extra fields, which enums) is the store's to define.
 */
export interface StoreFieldSchema {
  /** The store-specific field names this schema owns (for unknown-field counting). */
  knownFields: ReadonlyArray<string>;
  /**
   * The SUBSET of `knownFields` that are path-sensitive — string fields that must
   * never hold a path (a `/`, `\`, `..`/`.` segment, or absolute path). The
   * envelope validator AUTO-JAILS every declared path-sensitive field BEFORE
   * calling the store's `validate()`: if any is a path-shaped string the WHOLE
   * record is rejected (`store-field-path-shaped`) and `bumpJailReject` fires —
   * the SAME jail discipline the envelope applies to `recordKey`/`origin`,
   * reusable machinery instead of per-store willpower (Structure > Willpower). A
   * field not declared here is the store's own responsibility (use
   * `jailStoreStringField` inside `validate()` to opt in imperatively). Optional;
   * absent ⇒ no auto-jailed store fields.
   */
  pathSensitiveFields?: ReadonlyArray<string>;
  /**
   * Validate the store-specific fields. Receives the FULL raw data object (so a
   * store may cross-validate a store field against `recordKey` if it wants) and
   * a context object. Returns the validated store-specific fields (known fields
   * only), or null to reject the whole record. Must be PURE (no I/O, no mutation).
   *
   * NOTE: any RESERVED_ENVELOPE_FIELDS key in the returned object is STRIPPED by
   * the envelope validator (and counted as a dropped field) — the validated
   * envelope fields are authoritative and a store can never override them. A
   * store MUST jail its own path-sensitive string fields (declare them in
   * `pathSensitiveFields` for auto-jailing, or call `jailStoreStringField`).
   */
  validate(raw: Readonly<Record<string, unknown>>, ctx: StoreValidateContext): Record<string, unknown> | null;
}

/** Context handed to a store schema's validate() — counters it may bump. */
export interface StoreValidateContext {
  /** Increment when the store drops an unknown/duplicate field (counted). */
  countDroppedField(): void;
  /** Increment when the store rejects a path-shaped string field via the jail
   *  (wired to the SAME jailRejects counter CoherenceJournal surfaces). Bumped
   *  automatically for a declared `pathSensitiveFields` reject; a store may also
   *  call it from `jailStoreStringField` for an imperative jail. */
  countJailReject(): void;
}

/**
 * Reusable store-field path-jail (the §4 "jail any path-shaped field" rule, made
 * reusable machinery instead of per-store re-implementation). Returns the value
 * unchanged when it is a NON-path-shaped string; returns null (and bumps the
 * shared jail counter) when it is path-shaped, so a store's validate() can reject
 * the whole record. A non-string is returned unchanged (the store does its own
 * type check) — this helper enforces the PATH discipline only.
 *
 * Usage inside a store's validate():
 *   const fp = jailStoreStringField(raw.filePath, ctx);
 *   if (fp === null) return null; // path-shaped → reject whole record
 */
export function jailStoreStringField(value: unknown, ctx: StoreValidateContext): unknown {
  if (typeof value === 'string' && isPathShaped(value)) {
    ctx.countJailReject();
    return null;
  }
  return value;
}

/** A counters bag the caller passes to the validator so degradation is counted
 *  by the SAME counters CoherenceJournal already surfaces (schemaRejects /
 *  droppedFields / jailRejects). The validator NEVER throws on bad data — it
 *  bumps a counter and returns a rejection; throwing is reserved for a
 *  programmer error (a kind that was never registered). */
export interface EnvelopeValidationCounters {
  /** A record dropped for failing the typed schema (any reason). */
  bumpSchemaReject(): void;
  /** An unknown field dropped from an otherwise-valid record. */
  bumpDroppedField(): void;
  /** A path-shaped field rejected by the jail (also a schema reject). */
  bumpJailReject(): void;
}

/** The result of validateReplicatedEnvelope. */
export type EnvelopeValidationResult =
  | { ok: true; envelope: ReplicatedEnvelope; storeFields: Record<string, unknown>; data: Record<string, unknown> }
  | { ok: false; reason: EnvelopeRejectReason };

/** Why a record was rejected (for the typed result + tests). Never free text. */
export type EnvelopeRejectReason =
  | 'not-an-object'
  | 'bad-record-key'
  | 'record-key-path-shaped'
  | 'bad-hlc'
  | 'bad-op'
  | 'bad-origin'
  | 'bad-observed'
  | 'store-field-path-shaped'
  | 'store-schema-rejected';

/**
 * Is a string PATH-SHAPED? (The §4 "jail any path-shaped field" rule, applied
 * to the envelope's string fields — recordKey/origin — so a path can never
 * smuggle in as a primary key.) A value is path-shaped if it contains a path
 * separator, a `..` traversal segment, or is an absolute path. This is a
 * STRUCTURAL reject (the field has no business holding a path), not a
 * filesystem jail — the envelope carries identifiers, never artifact paths.
 */
export function isPathShaped(value: string): boolean {
  if (path.isAbsolute(value)) return true;
  if (value.includes('/') || value.includes('\\')) return true;
  // A bare `..` or any `..`-as-segment.
  const segments = value.split(/[/\\]/);
  if (segments.some((s) => s === '..' || s === '.')) return true;
  return false;
}

/** Validate one HLC field, returning the narrowed value or null (never throws). */
function tryCoerceHlc(raw: unknown): HlcTimestamp | null {
  try {
    return coerceHlc(raw);
  } catch {
    // @silent-fallback-ok: coerceHlc throws on malformed input by contract; here
    // we are deliberately converting that into a typed rejection (null) so the
    // validator can bump a counter and reject the WHOLE record — a malformed hlc
    // is a schema reject, never a silent default. The reject is counted + surfaced
    // by the caller via EnvelopeValidationCounters; nothing is swallowed.
    return null;
  }
}

/**
 * The strict envelope validator (§4). Mirrors the CoherenceJournal typed-schema
 * discipline:
 *   - rejects a non-object,
 *   - validates recordKey (non-empty, length-capped, NOT path-shaped → jail),
 *   - validates hlc as a well-formed HlcTimestamp,
 *   - validates op ∈ {'put','delete'},
 *   - validates origin (non-empty, length-capped, NOT path-shaped),
 *   - validates observed when present (well-formed HlcTimestamp); ABSENT is LEGAL,
 *   - delegates store-specific fields to the supplied StoreFieldSchema,
 *   - DROPS every field not in (RESERVED_ENVELOPE_FIELDS ∪ schema.knownFields),
 *     counting each drop.
 *
 * Returns a typed result. NEVER throws on bad DATA — it bumps a counter and
 * returns `{ ok: false }`. The reconstructed `data` object on success is the
 * validated store fields + the validated envelope fields, in a deterministic
 * shape (only known fields, observed omitted when absent), ready to serialize as
 * the journal entry's `data`. The validated envelope fields are AUTHORITATIVE:
 * any RESERVED_ENVELOPE_FIELDS key the store's validate() returns is stripped
 * (and counted as a dropped field) before merge, so a store can NEVER override a
 * load-bearing envelope field (op/recordKey/hlc/origin/observed) on `data` — the
 * on-disk `data.op/recordKey/hlc/origin/observed` always equal the validated
 * `envelope.*`. `storeFields` on the result is likewise reserved-key-stripped.
 */
export function validateReplicatedEnvelope(
  raw: unknown,
  schema: StoreFieldSchema,
  counters: EnvelopeValidationCounters,
): EnvelopeValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    counters.bumpSchemaReject();
    return { ok: false, reason: 'not-an-object' };
  }
  const obj = raw as Record<string, unknown>;

  // recordKey — non-empty, length-capped, not path-shaped (jailed).
  const recordKey = obj.recordKey;
  if (typeof recordKey !== 'string' || recordKey.length === 0 || recordKey.length > MAX_RECORD_KEY_LENGTH) {
    counters.bumpSchemaReject();
    return { ok: false, reason: 'bad-record-key' };
  }
  if (isPathShaped(recordKey)) {
    counters.bumpJailReject();
    counters.bumpSchemaReject();
    return { ok: false, reason: 'record-key-path-shaped' };
  }

  // hlc — well-formed HlcTimestamp (required).
  const hlc = tryCoerceHlc(obj.hlc);
  if (hlc === null) {
    counters.bumpSchemaReject();
    return { ok: false, reason: 'bad-hlc' };
  }

  // op — enum.
  const op = obj.op;
  if (op !== 'put' && op !== 'delete') {
    counters.bumpSchemaReject();
    return { ok: false, reason: 'bad-op' };
  }

  // origin — non-empty, length-capped, not path-shaped.
  const origin = obj.origin;
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > MAX_ORIGIN_LENGTH) {
    counters.bumpSchemaReject();
    return { ok: false, reason: 'bad-origin' };
  }
  if (isPathShaped(origin)) {
    counters.bumpJailReject();
    counters.bumpSchemaReject();
    return { ok: false, reason: 'bad-origin' };
  }

  // observed — well-formed HlcTimestamp WHEN PRESENT; absent is legal.
  let observed: HlcTimestamp | undefined;
  if (obj.observed !== undefined && obj.observed !== null) {
    const witness = tryCoerceHlc(obj.observed);
    if (witness === null) {
      counters.bumpSchemaReject();
      return { ok: false, reason: 'bad-observed' };
    }
    observed = witness;
  }

  // Auto-jail every DECLARED path-sensitive store field BEFORE the store's own
  // validate() — the §4 path-jail discipline applied to store fields as reusable
  // machinery (Structure > Willpower), not left to each store to re-implement.
  // A path-shaped declared field rejects the whole record (jail counter bumped),
  // exactly as recordKey/origin do.
  if (schema.pathSensitiveFields) {
    for (const field of schema.pathSensitiveFields) {
      const v = obj[field];
      if (typeof v === 'string' && isPathShaped(v)) {
        counters.bumpJailReject();
        counters.bumpSchemaReject();
        return { ok: false, reason: 'store-field-path-shaped' };
      }
    }
  }

  // Store-specific fields. The store validator may reject the whole record. The
  // context carries BOTH counters so a store-side drop (countDroppedField) and a
  // store-side imperative jail (countJailReject, e.g. via jailStoreStringField)
  // feed the SAME counters CoherenceJournal surfaces — uniform accounting.
  let storeRejected = false;
  const storeCtx: StoreValidateContext = {
    countDroppedField: () => counters.bumpDroppedField(),
    countJailReject: () => counters.bumpJailReject(),
  };
  const storeFields = schema.validate(obj, storeCtx);
  if (storeFields === null) {
    storeRejected = true;
  }
  if (storeRejected || storeFields === null) {
    counters.bumpSchemaReject();
    return { ok: false, reason: 'store-schema-rejected' };
  }

  // Count dropped unknown fields across the WHOLE object: any key not in the
  // reserved envelope fields and not owned by the store schema is dropped.
  const known = new Set<string>([...RESERVED_ENVELOPE_FIELDS, ...schema.knownFields]);
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) counters.bumpDroppedField();
  }

  const envelope: ReplicatedEnvelope = {
    recordKey,
    hlc,
    op,
    origin,
    ...(observed !== undefined ? { observed } : {}),
  };

  // Defense-in-depth: a store schema's validate() returns the store-specific
  // portion, but a buggy/hostile store COULD echo a RESERVED envelope key (op,
  // recordKey, hlc, origin, observed) in its returned object. Those keys are
  // load-bearing — op decides put/delete tombstone semantics, hlc is the merge
  // total-order, recordKey is the primary key — and the store's copy is the
  // UN-validated, UN-jailed value. We therefore STRIP every reserved key from
  // the store's returned fields (counting each as a dropped field, the same as
  // an unknown field) BEFORE merging, so the VALIDATED envelope fields are the
  // sole authority for the reconstructed `data`. This makes the reserved keys
  // un-overridable by construction — not "spread the envelope last and hope".
  const reserved = new Set<string>(RESERVED_ENVELOPE_FIELDS);
  const storeFieldsSafe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(storeFields)) {
    if (reserved.has(k)) {
      counters.bumpDroppedField();
      continue;
    }
    storeFieldsSafe[k] = v;
  }

  // The reconstructed data shape: validated store fields (reserved keys stripped)
  // FIRST, then the validated envelope fields LAST so a store can never clobber a
  // load-bearing envelope field on a key collision. observed omitted when absent
  // so the on-disk shape is deterministic.
  const data: Record<string, unknown> = {
    ...storeFieldsSafe,
    recordKey,
    hlc,
    op,
    origin,
    ...(observed !== undefined ? { observed } : {}),
  };

  return { ok: true, envelope, storeFields: storeFieldsSafe, data };
}

// ───────────────────────────────────────────────────────────────────────────
// B. The registry of replicated kinds
// ───────────────────────────────────────────────────────────────────────────

/**
 * One registered replicated kind. The `kind` is the JournalKind string (e.g.
 * 'pref-record' — registered later by WS2.1, NOT here). `store` is the stateSync
 * config sub-key + the advert flag suffix (e.g. 'pref'); ONE store may own one
 * kind. `schema` is the store-specific field schema layered on the envelope.
 */
export interface ReplicatedKindRegistration {
  /** The JournalKind string for this replicated store's stream. */
  kind: string;
  /** The stateSync config sub-key / advert suffix (e.g. 'pref'). */
  store: string;
  /** The store-specific field schema validated on top of the envelope. */
  schema: StoreFieldSchema;
}

/**
 * A registry of replicated kinds. Ships EMPTY — Step 2 adds the GENERIC
 * registration mechanism; the first concrete kind is registered by WS2.1.
 *
 * Why a registry (not a hardcoded union extension): the spec mandates "add the
 * GENERIC registration mechanism" and "do NOT hardcode the future concrete
 * kinds into the union in a way that forces them to exist now". A registry lets
 * each store register independently at wiring time; an unregistered/never-
 * emitted kind is simply absent on read (the reader filters by kind), and the
 * applier already drops unknown kinds forward-compat — so an old peer that does
 * not know a kind poisons nothing.
 */
export class ReplicatedKindRegistry {
  private readonly byKind = new Map<string, ReplicatedKindRegistration>();
  private readonly byStore = new Map<string, ReplicatedKindRegistration>();

  /**
   * Register a replicated kind. Idempotent for an IDENTICAL re-registration of
   * the same (kind, store); THROWS on a CONFLICTING registration (a different
   * store claiming an already-claimed kind, or a store re-registered with a
   * different kind) — a registration conflict is a programmer error at wiring
   * time, surfaced loudly, never a silent overwrite.
   */
  register(reg: ReplicatedKindRegistration): void {
    if (typeof reg.kind !== 'string' || reg.kind.length === 0) {
      throw new Error('ReplicatedKindRegistry.register: kind must be a non-empty string');
    }
    if (typeof reg.store !== 'string' || reg.store.length === 0) {
      throw new Error('ReplicatedKindRegistry.register: store must be a non-empty string');
    }
    if (!reg.schema || typeof reg.schema.validate !== 'function' || !Array.isArray(reg.schema.knownFields)) {
      throw new Error(`ReplicatedKindRegistry.register: kind "${reg.kind}" needs a StoreFieldSchema with knownFields[] + validate()`);
    }
    // ENFORCE non-collision with the reserved envelope fields (not merely
    // documented for the store author to self-check). A schema that claims a
    // reserved key in knownFields would defeat the unknown-field counter for that
    // key (it'd be treated as store-owned), letting a store quietly opt a
    // load-bearing envelope field into its own control surface. This is a
    // wiring-time programmer error, surfaced loudly — same class as the conflict
    // throws below, never a silent acceptance.
    const reservedSet = new Set<string>(RESERVED_ENVELOPE_FIELDS);
    const claimedReserved = reg.schema.knownFields.filter((f) => reservedSet.has(f));
    if (claimedReserved.length > 0) {
      throw new Error(`ReplicatedKindRegistry.register: kind "${reg.kind}" schema.knownFields claims reserved envelope field(s) [${claimedReserved.join(',')}] — reserved fields are owned by the envelope and may not be store-owned`);
    }
    const existingByKind = this.byKind.get(reg.kind);
    if (existingByKind) {
      if (existingByKind.store !== reg.store) {
        throw new Error(`ReplicatedKindRegistry: kind "${reg.kind}" already registered for store "${existingByKind.store}", cannot reassign to "${reg.store}"`);
      }
      // Same (kind, store) — idempotent; keep the first registration's schema.
      return;
    }
    const existingByStore = this.byStore.get(reg.store);
    if (existingByStore && existingByStore.kind !== reg.kind) {
      throw new Error(`ReplicatedKindRegistry: store "${reg.store}" already owns kind "${existingByStore.kind}", cannot also claim "${reg.kind}"`);
    }
    this.byKind.set(reg.kind, reg);
    this.byStore.set(reg.store, reg);
  }

  /** Is this kind a registered replicated kind? */
  isReplicatedKind(kind: string): boolean {
    return this.byKind.has(kind);
  }

  /** The registration for a kind, or undefined if unregistered. */
  getByKind(kind: string): ReplicatedKindRegistration | undefined {
    return this.byKind.get(kind);
  }

  /** The registration for a store, or undefined if unregistered. */
  getByStore(store: string): ReplicatedKindRegistration | undefined {
    return this.byStore.get(store);
  }

  /** All registered kinds (the JournalKind strings). Empty until a store registers. */
  kinds(): string[] {
    return [...this.byKind.keys()];
  }

  /** All registered store keys. Empty until a store registers. */
  stores(): string[] {
    return [...this.byStore.keys()];
  }

  /** Count of registered kinds (0 in the Step-2 substrate-only state). */
  get size(): number {
    return this.byKind.size;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// C. Flag-gated emission (ships dark per store)
// ───────────────────────────────────────────────────────────────────────────

/** A per-store stateSync flag block (the minimal shape this module reads). */
export interface StoreStateSyncFlags {
  enabled?: boolean;
  dryRun?: boolean;
}

/** The stateSync config block as a map of store-key → per-store flags, plus the
 *  foundation-level knobs. Only the per-store `enabled` is read by the emission
 *  gate; the knobs are validated by validateStateSyncInvariants (stateSyncConfig.ts). */
export type StateSyncStores = Record<string, StoreStateSyncFlags>;

/**
 * Is emission ENABLED for a store? (§4 flag-gated emission.) True ONLY when
 * `stateSync[store].enabled === true` (default false). When off, the store
 * NEVER emits its kind — a strict no-op. Nullish/absent ⇒ false.
 */
export function isStoreEmissionEnabled(stores: StateSyncStores | undefined, store: string): boolean {
  return stores?.[store]?.enabled === true;
}

// ───────────────────────────────────────────────────────────────────────────
// D. Flag-coherence-gated emission (the named skew-failure defense)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The seamlessnessFlags subset this module needs from a peer's advert: the
 * per-store stateSync receive booleans. ABSENT (older peer or feature dark) =
 * non-participant for that store (the conservative side — a sender never
 * forwards a store's kind to a peer that cannot durably receive it). Keyed by
 * the SAME `store` key the registry + config use, so a store added later needs
 * no change here.
 */
export interface PeerStateSyncAdvert {
  /** The peer's machine id (for the coalesced coherence surface). */
  machineId: string;
  /** Whether the peer is currently online (an offline peer is not a forward target). */
  online?: boolean;
  /** Per-store receive capability: stateSyncReceive[store] === true ⇒ advertises it. */
  stateSyncReceive?: Record<string, boolean>;
}

/** Does THIS peer advertise the matching stateSync.<store> receive capability? */
export function peerAdvertisesStore(peer: PeerStateSyncAdvert, store: string): boolean {
  return peer.stateSyncReceive?.[store] === true;
}

/**
 * The per-peer emission decision (§4 flag-coherence gating). Emit a replicated
 * kind to a peer ONLY when:
 *   - emission is enabled for the store locally (isStoreEmissionEnabled), AND
 *   - the peer is online, AND
 *   - the peer advertises the matching stateSync.<store> capability.
 * Withhold otherwise — emitting to a non-advertising peer is the NAMED data-loss
 * skew mode (the applier silently drops the unknown kind). Returns a typed
 * decision so the caller can surface a withhold.
 *
 * This is PER-PEER and correct for N peers — the caller iterates peers and calls
 * this once each; there is no "exactly 2" assumption anywhere.
 */
export function shouldEmitToPeer(
  stores: StateSyncStores | undefined,
  store: string,
  peer: PeerStateSyncAdvert,
): { emit: boolean; reason: 'emit' | 'store-disabled' | 'peer-offline' | 'peer-not-advertising' } {
  if (!isStoreEmissionEnabled(stores, store)) return { emit: false, reason: 'store-disabled' };
  if (peer.online === false) return { emit: false, reason: 'peer-offline' };
  if (!peerAdvertisesStore(peer, store)) return { emit: false, reason: 'peer-not-advertising' };
  return { emit: true, reason: 'emit' };
}

/** Per-store coherence: which online peers advertise this store, which don't. */
export interface StoreFlagCoherence {
  store: string;
  /** Online peers advertising the store's capability. */
  advertising: string[];
  /** Online peers NOT advertising it (would silently drop our kind). */
  notAdvertising: string[];
  /** True iff the store is locally enabled AND there is ≥1 online non-advertiser
   *  alongside ≥1 advertiser (or local emission) — a genuine MIXED state worth
   *  surfacing once. A pool where everyone advertises (or no one does, with the
   *  store locally off) is coherent and not surfaced. */
  mixed: boolean;
}

/** The boot-time pool-flag-coherence result. ONE result, coalescing ALL stores
 *  + ALL peers — never per-peer-per-tick. `mixedStores` lists exactly the stores
 *  in a mixed state; empty ⇒ fully coherent (nothing to surface). */
export interface PoolFlagCoherenceResult {
  /** Per-store breakdown for every locally-enabled store. */
  stores: StoreFlagCoherence[];
  /** Stores in a MIXED state (the only ones worth a surfaced notice). */
  mixedStores: string[];
  /** A single, deterministic, content-free summary line per mixed store, for the
   *  coalesced surface (never free text from peers — only ids + counts). */
  summary: string[];
}

/**
 * The boot-time pool-flag-coherence check (§4: "A boot-time pool-flag-coherence
 * check surfaces (ONCE) any mixed state"). Iterates ALL registered replicated
 * stores × ALL advertising peers and computes, per store, the advertising vs
 * non-advertising online peers. A store is MIXED when it is locally enabled AND
 * has at least one online peer that does NOT advertise it (that peer would
 * silently drop our kind) alongside at least one online peer that DOES (or there
 * is anyone at all to forward to). The result is ONE coalesced object — the
 * caller surfaces it once (e.g. one Attention item / one log line), never one
 * per peer per tick. Correct for N peers.
 *
 * PURE: no I/O, no surfacing — it computes the verdict; the caller decides how
 * to surface (and dedupes across boots).
 */
export function checkPoolFlagCoherence(
  registry: ReplicatedKindRegistry,
  stores: StateSyncStores | undefined,
  peers: ReadonlyArray<PeerStateSyncAdvert>,
): PoolFlagCoherenceResult {
  const onlinePeers = peers.filter((p) => p.online !== false);
  const out: StoreFlagCoherence[] = [];
  const mixedStores: string[] = [];
  const summary: string[] = [];

  for (const store of registry.stores()) {
    // Only locally-enabled stores can emit, so only they can suffer the skew.
    if (!isStoreEmissionEnabled(stores, store)) continue;

    const advertising: string[] = [];
    const notAdvertising: string[] = [];
    for (const peer of onlinePeers) {
      if (peerAdvertisesStore(peer, store)) advertising.push(peer.machineId);
      else notAdvertising.push(peer.machineId);
    }
    // MIXED = locally enabled (we will emit) AND ≥1 online peer cannot receive
    // it. That non-advertiser is the silent-drop victim — the named skew mode.
    const mixed = notAdvertising.length > 0;
    out.push({ store, advertising, notAdvertising, mixed });
    if (mixed) {
      mixedStores.push(store);
      // Content-free: store key + counts + the non-advertiser ids (machine ids
      // are routing identifiers, not user content).
      summary.push(
        `stateSync.${store}: ${advertising.length} peer(s) ready, ${notAdvertising.length} peer(s) cannot receive (would silently drop) [${notAdvertising.join(',')}]`,
      );
    }
  }

  return { stores: out, mixedStores, summary };
}
