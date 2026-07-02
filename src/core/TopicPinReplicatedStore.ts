/**
 * TopicPinReplicatedStore — replicate the user's topic PIN (move-intent) across the
 * agent's own machines so the OWNING machine's WS1.3 OwnershipReconciler can see "you
 * are pinned away" and start the cooperative transfer (Fix #2 of the cross-machine
 * stuck-move fix; spec docs/specs/cross-machine-reconciler-convergence.md).
 *
 * It rides the SAME generic WS2 replicated-record machinery the memory/PII stores use
 * (ReplicatedRecordEmitter + ReplicatedKindRegistry + the HLC envelope), so it inherits
 * HLC ordering (NEVER wall-clock — the clock-skew class this whole work fixes), the
 * provenance envelope, tombstone-on-clear, and per-kind retention/rate-cap. But a PIN is
 * NOT PII — it is just `{topic, preferredMachine, pinned}` — so this consumer is a LEAN
 * analog of EvolutionActionsReplicatedStore (no disclosure-minimization projection, no
 * divergent-value union; HLC-highest-wins is sufficient for a move-intent).
 *
 * CRITICAL POSTURE (Findings C1/AD4/LA1): a replicated pin is ADVISORY. It lands in this
 * SEPARATE store, never the authoritative local TopicPlacementPinStore. The reconciler
 * consults it as VALIDATED move-intent (known + online target) that can trigger ONLY the
 * owner's OWN cooperative transfer — never a force-claim / seat-steal. Under the declared
 * single-agent threat model the residual hazard is a STALE/CORRUPT peer stream, which HLC
 * ordering + known-machine validation + freshness defend against.
 */

import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';

/** The JournalKind string this store rides (the dual-registry's dynamic half; the static
 *  half is CoherenceJournal.JOURNAL_KINDS, which now lists 'topic-pin-record'). */
export const TOPIC_PIN_RECORD_KIND = 'topic-pin-record';
/** The store key used by the emitter dark-gate + the rollback-unmerge getByStore wiring. */
export const TOPIC_PIN_STORE_KEY = 'topicPins';

/** Machine-id charset clamp (consistent with sanitizeMachineId elsewhere): a peer-supplied
 *  preferredMachine that is not a plain id is rejected (it flows into placement decisions). */
const MACHINE_ID_RE = /^[\w-]{1,64}$/;

/** The same clamp for consumers outside this module (the U4.1 fold view's second pass —
 *  ONE validation authority, never a re-implemented regex). */
export function isValidPinMachineId(id: unknown): id is string {
  return typeof id === 'string' && MACHINE_ID_RE.test(id);
}

/** The store-owned fields (for the registry's unknown-field counting). */
const TOPIC_PIN_KNOWN_FIELDS = ['topic', 'preferredMachine', 'pinned', 'deletedAt'] as const;

/** recordKey = the cross-machine IDENTITY SURFACE = the topic id as a string (a pin is
 *  per-topic; a re-pin to a different machine is the SAME key with a newer HLC). */
export function deriveTopicPinRecordKey(topic: number | string): string | null {
  const n = typeof topic === 'number' ? topic : Number(topic);
  if (!Number.isFinite(n)) return null;
  return String(n);
}

export const topicPinRecordStoreSchema: StoreFieldSchema = {
  knownFields: TOPIC_PIN_KNOWN_FIELDS as unknown as ReadonlyArray<string>,
  pathSensitiveFields: ['preferredMachine'],
  validate(raw: Readonly<Record<string, unknown>>, ctx: StoreValidateContext): Record<string, unknown> | null {
    if (raw.op === 'delete') {
      // Tombstone (the CLEAR): only deletedAt is a legal store field; the recordKey + hlc +
      // op (envelope, already validated) carry the suppression.
      const deletedAt = typeof raw.deletedAt === 'string' ? raw.deletedAt : undefined;
      for (const k of Object.keys(raw)) {
        if (k === 'op' || k === 'deletedAt') continue;
        if ((TOPIC_PIN_KNOWN_FIELDS as ReadonlyArray<string>).includes(k)) ctx.countDroppedField();
      }
      return deletedAt !== undefined ? { deletedAt } : {};
    }
    // PUT (set the pin). topic — finite number; preferredMachine — charset-clamped machine
    // id; pinned — strict boolean. A malformed field rejects the whole record (quarantined
    // by the envelope machinery, never silently dropped).
    const topic = typeof raw.topic === 'number' && Number.isFinite(raw.topic) ? raw.topic : null;
    if (topic === null) return null;
    if (typeof raw.preferredMachine !== 'string' || !MACHINE_ID_RE.test(raw.preferredMachine)) return null;
    if (typeof raw.pinned !== 'boolean') return null;
    return { topic, preferredMachine: raw.preferredMachine, pinned: raw.pinned };
  },
};

/** The dual-registry registration (mirrors EVOLUTION_ACTION_KIND_REGISTRATION). Registration
 *  is INERT — emission stays gated behind the store's enable flag (ws13PinReplicate). */
export const TOPIC_PIN_KIND_REGISTRATION = {
  kind: TOPIC_PIN_RECORD_KIND,
  store: TOPIC_PIN_STORE_KEY,
  schema: topicPinRecordStoreSchema,
} as const;

export function topicPinContributingKinds(): string[] {
  return [TOPIC_PIN_RECORD_KIND];
}

/** Build a PUT (set-pin) record's data, given the emitter-supplied envelope inputs. */
export function buildTopicPinPut(topic: number, preferredMachine: string, pinned: boolean) {
  return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> | null => {
    const recordKey = deriveTopicPinRecordKey(topic);
    if (recordKey === null || !MACHINE_ID_RE.test(preferredMachine)) return null;
    return {
      topic, preferredMachine, pinned,
      recordKey, hlc, op: 'put' as ReplicatedOp, origin,
      ...(observed !== undefined ? { observed } : {}),
    };
  };
}

/** Build a TOMBSTONE (clear-pin) record's data. */
export function buildTopicPinTombstone(topic: number, deletedAt: string) {
  return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> | null => {
    const recordKey = deriveTopicPinRecordKey(topic);
    if (recordKey === null) return null;
    return {
      deletedAt,
      recordKey, hlc, op: 'delete' as ReplicatedOp, origin,
      ...(observed !== undefined ? { observed } : {}),
    };
  };
}

/** Total order over HLC timestamps: physical, then logical, then node (the §7
 *  tie-breaker of last resort). >0 ⇒ a is newer than b. */
export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): number {
  if (a.physical !== b.physical) return a.physical - b.physical;
  if (a.logical !== b.logical) return a.logical - b.logical;
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}

/** A merged, advisory replicated pin for one topic (READ-ONLY; never written to the
 *  authoritative local pin store). `origin` is the machine that asserted it. */
export interface MergedReplicatedPin {
  topic: number;
  preferredMachine: string;
  pinned: boolean;
  origin: string;
  /** The winning HLC — used by the reconciler to HLC-order against the LOCAL pin. */
  hlc: HlcTimestamp;
}

/**
 * Collapse replicated `topic-pin-record` entries to ONE advisory pin per topic: the
 * HIGHEST-HLC record wins (skew-proof). A winning TOMBSTONE (op:'delete') resolves to
 * "no pin" for that topic (the clear superseded the set). A `pinned:false` PUT likewise
 * yields no effective pin. Input entries are the already-envelope-validated records.
 */
export function mergeUnionToPins(
  entries: Array<{ data: Record<string, unknown>; origin: string }>,
  hlcCompare: (a: HlcTimestamp, b: HlcTimestamp) => number,
): Map<number, MergedReplicatedPin> {
  // First pass: pick the highest-HLC record per recordKey (put OR delete).
  const winner = new Map<string, { data: Record<string, unknown>; origin: string; hlc: HlcTimestamp }>();
  for (const e of entries) {
    const hlc = e.data.hlc as HlcTimestamp | undefined;
    const recordKey = typeof e.data.recordKey === 'string' ? e.data.recordKey : null;
    if (!hlc || recordKey === null) continue;
    const cur = winner.get(recordKey);
    if (!cur || hlcCompare(hlc, cur.hlc) > 0) winner.set(recordKey, { data: e.data, origin: e.origin, hlc });
  }
  // Second pass: a winning delete/pinned:false → no effective pin.
  const out = new Map<number, MergedReplicatedPin>();
  for (const [recordKey, w] of winner) {
    if (w.data.op === 'delete') continue;
    const pinned = w.data.pinned === true;
    if (!pinned) continue;
    const topic = Number(recordKey);
    const preferredMachine = typeof w.data.preferredMachine === 'string' ? w.data.preferredMachine : '';
    if (!Number.isFinite(topic) || !MACHINE_ID_RE.test(preferredMachine)) continue;
    out.set(topic, { topic, preferredMachine, pinned: true, origin: w.origin, hlc: w.hlc });
  }
  return out;
}
