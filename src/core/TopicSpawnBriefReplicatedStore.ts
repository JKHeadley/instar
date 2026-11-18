/**
 * TopicSpawnBriefReplicatedStore — the `topic-spawn-brief` replicated kind (store key
 * `topicSpawnBriefs`), placement Step 2 (docs/specs/topic-spawns-placed-by-load.md, "The brief
 * on every machine").
 *
 * Before an agent's topic spawn is handed to a peer, the origin emits the brief as one
 * replicated record keyed by the topic id, so any pool machine that has synced since holds the
 * task, the topic and the target. When the placed session ends, the machine that sees it end
 * emits an update with `status: "completed"`. Nothing here is tombstoned or deleted.
 *
 * Size: one brief is one record; the journal refuses a serialized line over
 * REPLICATED_RECORD_MAX_ENTRY_BYTES, and that refusal (or this module's pre-check of the same
 * bound) means the spawn stays local (`prompt-too-large`). The prompt is never truncated.
 */
import type { StoreFieldSchema, StoreValidateContext } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import type { OriginRecord } from './UnionReader.js';
import type { EmitResult, BuildRecordData } from './ReplicatedRecordEmitter.js';
import { REPLICATED_RECORD_MAX_ENTRY_BYTES } from './CoherenceJournal.js';
import { compareHlc } from './TopicPinReplicatedStore.js';
import { scrubSecrets } from '../monitoring/scrubSecrets.js';

export const TOPIC_SPAWN_BRIEF_KIND = 'topic-spawn-brief';
export const TOPIC_SPAWN_BRIEF_STORE_KEY = 'topicSpawnBriefs';
/** Room the envelope, the other fields and the journal line need besides the prompt itself. */
const ENVELOPE_MARGIN_BYTES = 2 * 1024;

export type TopicSpawnBriefStatus = 'placed' | 'completed';

export interface TopicSpawnBriefRecord {
  topicId: number;
  name: string;
  prompt: string;
  placedOn: string;
  originMachineId: string;
  createdAt: string;
  status: TopicSpawnBriefStatus;
  completedAt?: string;
}

const KNOWN = ['topicId', 'name', 'prompt', 'placedOn', 'originMachineId', 'createdAt', 'status', 'completedAt'];

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

export const topicSpawnBriefStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN,
  validate(raw: Readonly<Record<string, unknown>>, _ctx: StoreValidateContext): Record<string, unknown> | null {
    const topicId = typeof raw.topicId === 'number' && Number.isSafeInteger(raw.topicId) && raw.topicId > 0 ? raw.topicId : null;
    const name = str(raw.name, 200);
    // Never truncated: a brief that does not fit is refused whole (the spawn then stays local).
    const prompt = str(raw.prompt, REPLICATED_RECORD_MAX_ENTRY_BYTES);
    const placedOn = str(raw.placedOn, 256);
    const originMachineId = str(raw.originMachineId, 256);
    const createdAt = str(raw.createdAt, 64);
    if (topicId === null || !name || !prompt || !placedOn || !originMachineId || !createdAt) return null;
    const status: TopicSpawnBriefStatus = raw.status === 'completed' ? 'completed' : 'placed';
    const completedAt = str(raw.completedAt, 64);
    return { topicId, name, prompt, placedOn, originMachineId, createdAt, status, ...(status === 'completed' && completedAt ? { completedAt } : {}) };
  },
};

export const TOPIC_SPAWN_BRIEF_KIND_REGISTRATION = {
  kind: TOPIC_SPAWN_BRIEF_KIND,
  store: TOPIC_SPAWN_BRIEF_STORE_KEY,
  schema: topicSpawnBriefStoreSchema,
} as const;

export function buildTopicSpawnBriefData(rec: TopicSpawnBriefRecord, hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> {
  return {
    topicId: rec.topicId, name: rec.name, prompt: rec.prompt, placedOn: rec.placedOn,
    originMachineId: rec.originMachineId, createdAt: rec.createdAt, status: rec.status,
    ...(rec.completedAt ? { completedAt: rec.completedAt } : {}),
    recordKey: String(rec.topicId), hlc, op: 'put', origin,
    ...(observed ? { observed } : {}),
  };
}

/** What an emit means for the spawn: replicated, or stay local with this reason. */
export type BriefEmitOutcome = 'emitted' | 'prompt-too-large' | 'brief-not-replicated';

export function briefEmitOutcome(r: EmitResult | null | undefined): BriefEmitOutcome {
  if (!r) return 'brief-not-replicated';
  if (r.outcome === 'emitted') return 'emitted';
  if (r.outcome === 'dropped:oversize') return 'prompt-too-large';
  return 'brief-not-replicated';
}

/** Does this prompt (JSON-escaped) fit one replicated record? */
export function briefFitsOneRecord(prompt: string): boolean {
  return Buffer.byteLength(JSON.stringify(prompt), 'utf-8') + ENVELOPE_MARGIN_BYTES <= REPLICATED_RECORD_MAX_ENTRY_BYTES;
}

export function briefFromOriginRecord(r: OriginRecord): TopicSpawnBriefRecord | null {
  if (r.envelope.op !== 'put') return null;
  const v = topicSpawnBriefStoreSchema.validate(r.data, { countDroppedField: () => undefined, countJailReject: () => undefined });
  return v ? v as unknown as TopicSpawnBriefRecord : null;
}

export interface TopicSpawnBriefReplicationDeps {
  emitter: { emit(store: string, recordKey: string | null | undefined, build: BuildRecordData): EmitResult } | null;
  reader: { loadOriginRecords(store: string, recordKey: string): OriginRecord[] } | null;
  /** Extra secrets to redact from the prompt (the agent's own tokens and PIN). */
  secrets?: () => Array<string | undefined | null>;
  now?: () => Date;
}

export interface TopicSpawnBriefReplication {
  /** Emit the brief for a placement (or a local fallback). Never throws. */
  emit(rec: Omit<TopicSpawnBriefRecord, 'status' | 'createdAt'> & { createdAt?: string }): BriefEmitOutcome;
  /** The latest record for the topic across every origin this machine holds, or null. */
  read(topicId: number): TopicSpawnBriefRecord | null;
  /** Mark the topic's brief completed (an update, never a delete). */
  markCompleted(topicId: number, placedOnMustBe?: string): BriefEmitOutcome | 'nothing-to-mark';
}

export function redactBrief(prompt: string, secrets: Array<string | undefined | null>): string {
  let out = scrubSecrets(prompt);
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 6) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

export function createTopicSpawnBriefReplication(d: TopicSpawnBriefReplicationDeps): TopicSpawnBriefReplication {
  const now = d.now ?? (() => new Date());
  const put = (rec: TopicSpawnBriefRecord): BriefEmitOutcome => {
    if (!d.emitter) return 'brief-not-replicated';
    if (!briefFitsOneRecord(rec.prompt)) return 'prompt-too-large';
    try {
      return briefEmitOutcome(d.emitter.emit(TOPIC_SPAWN_BRIEF_STORE_KEY, String(rec.topicId), (hlc, origin, observed) => buildTopicSpawnBriefData(rec, hlc, origin, observed)));
    } catch {
      return 'brief-not-replicated'; // @silent-fallback-ok — the spawn stays local with this reason
    }
  };
  const read = (topicId: number): TopicSpawnBriefRecord | null => {
    if (!d.reader) return null;
    let records: OriginRecord[];
    try { records = d.reader.loadOriginRecords(TOPIC_SPAWN_BRIEF_STORE_KEY, String(topicId)); } catch { return null; /* @silent-fallback-ok — an unreadable stream reads as no record */ }
    let best: { hlc: HlcTimestamp; rec: TopicSpawnBriefRecord } | null = null;
    for (const r of records) {
      const rec = briefFromOriginRecord(r);
      if (!rec) continue;
      if (!best || compareHlc(r.envelope.hlc, best.hlc) > 0) best = { hlc: r.envelope.hlc, rec };
    }
    return best?.rec ?? null;
  };
  return {
    emit: (rec) => put({
      ...rec,
      prompt: redactBrief(rec.prompt, d.secrets?.() ?? []),
      createdAt: rec.createdAt ?? now().toISOString(),
      status: 'placed',
    }),
    read,
    markCompleted: (topicId, placedOnMustBe) => {
      const cur = read(topicId);
      if (!cur || cur.status === 'completed') return 'nothing-to-mark';
      if (placedOnMustBe !== undefined && cur.placedOn !== placedOnMustBe) return 'nothing-to-mark';
      return put({ ...cur, status: 'completed', completedAt: now().toISOString() });
    },
  };
}
