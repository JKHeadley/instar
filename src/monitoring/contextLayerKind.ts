/**
 * The replicated layer kind (context-budget-layered-summaries §14 "Small layers
 * A, G (per entry), C (open and current-phase), C2, H1–H3, U referent stubs,
 * fold records and sidecars, backoff and breaker state, fold holds" — "a new
 * replicated kind registered in both `JOURNAL_KINDS` and
 * `ReplicatedKindRegistry`; the kind's bounds type gains `maxRecordBytes` and
 * `liveSetBudget` fields … caps derived from the journal constants (default
 * applier cap 8 KB, per-kind raise to 64 KB, 80 KB wire), enforced as
 * refuse-never-truncate only on content records (a fold record is state and
 * pointers and is never size-refusable; lists live in sidecars) … unique
 * record keys per entry with status changes re-emitting the record (HLC-latest
 * compaction), and the skew rule: a holder on a version without the kind
 * refuses the fold (`fold-path-unavailable: layers-not-replicated`)").
 *
 * This slice ships the KIND: its name, store key, field schema, bounds and a
 * record builder that refuses (never truncates) an oversize content record.
 * Registration is INERT: nothing emits until the layer store (Phase 1) writes
 * through it and `multiMachine.stateSync.contextLayers` is on. The skew rule
 * is the FoldCoordinator's `layerKindPresent` precondition: true only on a
 * build that registered this kind.
 *
 * FORWARD COMPATIBILITY (a wire contract from the first merge): every build
 * that has this kind pulls and validates its stream, and one refused entry
 * stalls the stream on that machine. So the receive side accepts a record type,
 * fold state or status it does not know, provided it is well-formed: a safe
 * name, a key bound to its fields, and — for an unknown type — an OPTIONAL
 * string body capped at the 64 KB raise (a non-string body is dropped, not
 * refused). Every reader MUST ignore types and states it does not know. A later
 * build can add a content or state type, a fold state or a status without
 * stalling peers that are still on this one; what it cannot do is change the
 * meaning of a type or field this build already knows.
 */
import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from '../core/ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from '../core/HybridLogicalClock.js';
import { DEFAULT_MAX_ENTRY_BYTES, REPLICATED_RECORD_MAX_ENTRY_BYTES } from '../core/CoherenceJournal.js';

export const CONTEXT_LAYER_RECORD_KIND = 'context-layer-record' as const;
export const CONTEXT_LAYER_STORE_KEY = 'contextLayers' as const;

/** Every record type this build writes (§14 row "Small layers …"). */
export const CONTEXT_LAYER_RECORD_TYPES = [
  'anchor', 'ledger-entry', 'chunk', 'c2', 'h1', 'h2', 'h3', 'u-stub',
  'fold-record', 'fold-sidecar', 'fold-hold', 'fold-backoff', 'fold-breaker',
] as const;
export type ContextLayerRecordType = typeof CONTEXT_LAYER_RECORD_TYPES[number];
const KNOWN_TYPES: ReadonlySet<string> = new Set(CONTEXT_LAYER_RECORD_TYPES);

/** State-and-pointer records: never size-refusable, never carry a body (§14). */
const STATE_TYPES: ReadonlySet<string> = new Set(['fold-record', 'fold-hold', 'fold-backoff', 'fold-breaker']);

/**
 * The kind's bounds, derived from the journal constants: the applier default
 * per-entry cap (8 KB) for most content, the per-kind raise (64 KB) for the
 * two record types that legitimately run large (H3, and fold sidecars, which
 * hold lists), all under the 80 KB wire cap (REPLICATED_RECORD_MAX_ENTRY_BYTES).
 * A body's size is its JSON-ESCAPED UTF-8 length (what the journal line
 * carries), so a body that passes here also fits the line. `liveSetBudget` is
 * sized in Phase 1 from measured G/C growth; until then it is `null` (no
 * live-set cap is enforced, and the dashboard says so).
 */
const PER_KIND_RAISE_BYTES = 64 * 1024;
/** Room left on the wire line for the envelope and the other fields. */
const ENVELOPE_HEADROOM_BYTES = 8 * 1024;
if (PER_KIND_RAISE_BYTES + ENVELOPE_HEADROOM_BYTES > REPLICATED_RECORD_MAX_ENTRY_BYTES) throw new Error('context layer cap must leave envelope room under the replicated wire cap');
export const CONTEXT_LAYER_KIND_BOUNDS = {
  maxRecordBytes: { default: DEFAULT_MAX_ENTRY_BYTES, h3: PER_KIND_RAISE_BYTES, 'fold-sidecar': PER_KIND_RAISE_BYTES } as const,
  liveSetBudget: null as number | null,
} as const;

/** The body cap for a type; `null` for state records (never size-refused). Unknown types get the default. */
export function maxRecordBytesFor(type: string): number | null {
  if (STATE_TYPES.has(type)) return null;
  const caps = CONTEXT_LAYER_KIND_BOUNDS.maxRecordBytes as Record<string, number>;
  return caps[type] ?? caps.default;
}

/** The body's size on the journal line: its JSON-escaped UTF-8 length, without the quotes. */
export function bodyWireBytes(body: string): number {
  return Buffer.byteLength(JSON.stringify(body), 'utf-8') - 2;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ENTRY_KEY = /^[A-Za-z0-9_.:-]{1,256}$/;
/** A well-formed name for a type or fold state this build may not know. */
const SAFE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
/** A status: any jail-safe token (no path separators), so later builds may add values freely. */
const SAFE_STATUS = /^[A-Za-z0-9_.:-]{1,64}$/;
export const FOLD_STATES: ReadonlySet<string> = new Set(['prepared', 'shadow-probing', 'locked', 'snapshotted', 'staged', 'replacing', 'probing', 'committed', 'rolled-back', 'quarantined', 'aborted']);
const COUNTERS = ['seq', 'generation', 'count', 'untilMs'] as const;

const KNOWN_FIELDS = ['recordType', 'topicKey', 'foldId', 'entryKey', 'status', 'body', 'state', 'seq', 'generation', 'count', 'untilMs', 'deletedAt'] as const;

/** The record key for one entry; unique per (topic, type, entry). */
export function contextLayerRecordKey(topicKey: string, recordType: string, entryKey: string): string {
  // `:`-joined: the envelope jails path-shaped keys, and `/` would read as a path.
  return `${topicKey}:${recordType}:${entryKey}`;
}

export const contextLayerRecordStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN_FIELDS as unknown as ReadonlyArray<string>,
  pathSensitiveFields: ['topicKey', 'foldId', 'status', 'state'],
  validate(raw: Readonly<Record<string, unknown>>, ctx: StoreValidateContext): Record<string, unknown> | null {
    const type = raw.recordType;
    // Known types, or a well-formed type from a later build (forward compatibility).
    if (typeof type !== 'string' || !(KNOWN_TYPES.has(type) || SAFE_NAME.test(type))) return null;
    if (typeof raw.topicKey !== 'string' || !SAFE_ID.test(raw.topicKey)) return null;
    const out: Record<string, unknown> = { recordType: type, topicKey: raw.topicKey };
    if (raw.entryKey !== undefined) {
      if (typeof raw.entryKey !== 'string' || !ENTRY_KEY.test(raw.entryKey)) return null;
      out.entryKey = raw.entryKey;
    }
    // The record key is BOUND to the record's own fields: a put (and a
    // tombstone that names its entry) must sit at <topic>:<type>:<entryKey>.
    const boundKey = typeof out.entryKey === 'string' ? contextLayerRecordKey(raw.topicKey, type, out.entryKey) : null;
    if (raw.op === 'delete') {
      if (boundKey !== null && raw.recordKey !== undefined && raw.recordKey !== boundKey) return null;
      // A tombstone without an entry key must still sit under its own topic and type.
      if (boundKey === null && (typeof raw.recordKey !== 'string' || !raw.recordKey.startsWith(`${raw.topicKey}:${type}:`))) return null;
      if (raw.body !== undefined) ctx.countDroppedField();
      if (typeof raw.deletedAt === 'string') out.deletedAt = raw.deletedAt;
      return out;
    }
    if (boundKey === null || raw.recordKey !== boundKey) return null;
    if (raw.foldId !== undefined) {
      if (typeof raw.foldId !== 'string' || !SAFE_ID.test(raw.foldId)) return null;
      out.foldId = raw.foldId;
    }
    if (raw.status !== undefined) {
      if (typeof raw.status !== 'string' || !SAFE_STATUS.test(raw.status) || raw.status === '.' || raw.status === '..') return null;
      out.status = raw.status;
    }
    for (const k of COUNTERS) {
      const v = raw[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return null;
      out[k] = v;
    }
    if (STATE_TYPES.has(type)) {
      // State and pointers only: no body, never refused for size.
      if (raw.body !== undefined) ctx.countDroppedField();
      if (raw.state !== undefined) {
        // Known fold states, or a well-formed state from a later build.
        if (typeof raw.state !== 'string' || !(FOLD_STATES.has(raw.state) || SAFE_NAME.test(raw.state))) return null;
        out.state = raw.state;
      }
      if (type === 'fold-record' && out.state === undefined) return null;
      return out;
    }
    if (!KNOWN_TYPES.has(type)) {
      // A later build's type: state carried if well-formed, body optional and
      // capped at the per-kind raise; anything else is dropped, never refused.
      if (raw.state !== undefined) {
        if (typeof raw.state === 'string' && SAFE_NAME.test(raw.state)) out.state = raw.state;
        else ctx.countDroppedField();
      }
      if (raw.body !== undefined) {
        if (typeof raw.body !== 'string') ctx.countDroppedField();
        else if (bodyWireBytes(raw.body) > PER_KIND_RAISE_BYTES) return null;
        else out.body = raw.body;
      }
      return out;
    }
    // Content record of a known type: refuse, never truncate, past its cap.
    if (typeof raw.body !== 'string') return null;
    const cap = maxRecordBytesFor(type);
    if (cap !== null && bodyWireBytes(raw.body) > cap) return null;
    if (raw.state !== undefined) ctx.countDroppedField();
    out.body = raw.body;
    return out;
  },
};

export const CONTEXT_LAYER_KIND_REGISTRATION = {
  kind: CONTEXT_LAYER_RECORD_KIND,
  store: CONTEXT_LAYER_STORE_KEY,
  schema: contextLayerRecordStoreSchema,
} as const;

export type LayerBuildResult =
  | { ok: true; recordKey: string; build: (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp) => Record<string, unknown> }
  | { ok: false; reason: 'oversize' | 'invalid' };

/** A field the envelope would refuse as path-shaped (the same rule as `isPathShaped`). */
function pathShaped(v: unknown): boolean {
  return typeof v === 'string' && (v.includes('/') || v.includes('\\') || v === '.' || v === '..');
}

/**
 * Build a put for one layer record. The record key is unique per entry
 * (`<topic>:<type>:<entryKey>`); a status change re-emits the same key (the
 * HLC-latest record wins). An oversize content record is REFUSED here —
 * never truncated — measured the way the journal line carries it. The built
 * record carries only the VALIDATED fields, and a field the schema would drop
 * or the envelope would jail is refused (`invalid`) rather than dropped. The
 * journal's emit outcome remains the authority: a writer treats any outcome
 * but `accepted` as not written.
 */
export function buildContextLayerPut(input: {
  recordType: ContextLayerRecordType;
  topicKey: string;
  entryKey: string;
  body?: string;
  foldId?: string;
  status?: string;
  state?: string;
  seq?: number;
  generation?: number;
  count?: number;
  untilMs?: number;
}): LayerBuildResult {
  if (!KNOWN_TYPES.has(input.recordType)) return { ok: false, reason: 'invalid' };
  if (typeof input.entryKey !== 'string' || typeof input.topicKey !== 'string') return { ok: false, reason: 'invalid' };
  const given: Record<string, unknown> = { recordType: input.recordType, topicKey: input.topicKey, entryKey: input.entryKey };
  for (const k of ['body', 'foldId', 'status', 'state', 'seq', 'generation', 'count', 'untilMs'] as const) if (input[k] !== undefined) given[k] = input[k];
  if (!STATE_TYPES.has(input.recordType) && typeof input.body === 'string') {
    const cap = maxRecordBytesFor(input.recordType);
    if (cap !== null && bodyWireBytes(input.body) > cap) return { ok: false, reason: 'oversize' };
  }
  // Known states only on this build's own writes (a reader may meet later ones).
  if (input.state !== undefined && !FOLD_STATES.has(input.state)) return { ok: false, reason: 'invalid' };
  if (['topicKey', 'foldId', 'status', 'state'].some((k) => pathShaped(given[k]))) return { ok: false, reason: 'invalid' };
  const recordKey = contextLayerRecordKey(input.topicKey, input.recordType, input.entryKey);
  let dropped = 0;
  const v = contextLayerRecordStoreSchema.validate({ ...given, recordKey, op: 'put' }, { countDroppedField() { dropped++; }, countJailReject() {} });
  if (!v || dropped > 0) return { ok: false, reason: 'invalid' };
  if (Object.keys(given).some((k) => !(k in v))) return { ok: false, reason: 'invalid' };
  const validated = v;
  const op: ReplicatedOp = 'put';
  return { ok: true, recordKey, build: (hlc, origin, observed) => ({ ...validated, recordKey, hlc, op, origin, ...(observed !== undefined ? { observed } : {}) }) };
}

export function contextLayerContributingKinds(): string[] {
  return [CONTEXT_LAYER_RECORD_KIND];
}
