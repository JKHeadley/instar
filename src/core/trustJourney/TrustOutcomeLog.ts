/**
 * The trust journey's outcome store (spec section 4 and Multi-machine posture): store
 * `trustJourneyOutcomes`, kind `trust-outcome-record`, bounded retention. Stage 0 writes one row per
 * governed effect the holder admits, labelled "not yet checked" (the server sets the source type;
 * nothing an agent reports is ever "checked"). Stage 2 reads these rows into the record line and
 * adds checked, corrected and undone outcomes from the person's own messages.
 */
import path from 'node:path';
import type { StoreFieldSchema } from '../ReplicatedRecordEnvelope.js';
import { LocalFileTrustSink, type TrustRecord, type TrustRecordSink } from './TrustJourneyStore.js';

export const TRUST_OUTCOME_RECORD_KIND = 'trust-outcome-record';
export const TRUST_OUTCOMES_STORE_KEY = 'trustJourneyOutcomes';

export const OUTCOMES = ['done-and-checked', 'corrected', 'undone', 'signal-only', 'not-yet-checked'] as const;
export type Outcome = typeof OUTCOMES[number];

const KNOWN = ['recordType', 'at', 'minReader', 'kind', 'actionIdentity', 'grantKey', 'outcome', 'sourceType', 'evidenceRef', 'person', 'machine'];

export const trustOutcomeRecordStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN,
  validate(raw) {
    if (raw.op === 'delete') return null;
    if (raw.recordType !== 'outcome' || typeof raw.at !== 'string') return null;
    if (typeof raw.outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(raw.outcome)) return null;
    const out: Record<string, unknown> = {};
    for (const k of KNOWN) if (raw[k] !== undefined) out[k] = raw[k];
    return out;
  },
};

export const TRUST_OUTCOME_KIND_REGISTRATION = { kind: TRUST_OUTCOME_RECORD_KIND, store: TRUST_OUTCOMES_STORE_KEY, schema: trustOutcomeRecordStoreSchema } as const;

export class TrustOutcomeLog {
  constructor(private readonly sink: TrustRecordSink) {}

  static localSink(stateDir: string): TrustRecordSink {
    return new LocalFileTrustSink(path.join(stateDir, 'state', 'trust-journey-outcomes.jsonl'));
  }

  /** Records that the holder admitted a governed effect. Its outcome stays unchecked until stage 2. */
  async admitted(p: { kind: string; actionIdentity: string; person: string; machine: string; via: 'grant' | 'approved-once' }): Promise<boolean> {
    const rec = {
      recordType: 'outcome', at: new Date().toISOString(), minReader: 1,
      kind: p.kind, actionIdentity: p.actionIdentity, grantKey: p.kind, outcome: 'not-yet-checked' as Outcome,
      sourceType: p.via === 'grant' ? 'admitted-by-grant' : 'admitted-once', person: p.person, machine: p.machine,
    } as unknown as TrustRecord;
    return this.sink.append(`to:${p.actionIdentity}:${rec.at}`, rec);
  }

  all(): TrustRecord[] { return this.sink.loadAll(); }
}
