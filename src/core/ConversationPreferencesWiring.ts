/**
 * wirePreferenceStore — build the personal conversation preference store on the replication path at server boot
 * (docs/specs/conversation-mute-archive.md): the emitter hook for local changes, the landing of peers'
 * rows already in the peer streams, and the re-send of this machine's rows that never went out.
 * Kept out of server.ts so the boot function stays within the compiler's control-flow bound.
 */
import { ConversationPreferencesStore, PREFERENCES_STORE_KEY, buildPreferenceRecordData, derivePreferenceRecordKey } from './ConversationPreferences.js';
import type { ReplicatedRecordEmitter } from './ReplicatedRecordEmitter.js';

export interface PreferencePeerStreams {
  listRecordKeys(store: string): Iterable<string>;
  loadOriginRecords(store: string, recordKey: string): Iterable<{ origin: string; data: Record<string, unknown> }>;
}

export interface WirePreferenceStoreInput {
  stateDir: string;
  emitter: Pick<ReplicatedRecordEmitter, 'emit'> | null | undefined;
  peerStreams: PreferencePeerStreams | null | undefined;
  ownMachineId: string | null | undefined;
  report: (what: string, detail: string) => void;
  awaitDurable?: (seq: number) => Promise<void>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/** The boot call: builds the store, or returns null (reported) when the feature is off or the wiring fails. */
export function wirePreferenceStoreSafe(input: WirePreferenceStoreInput & { enabled: boolean }): ConversationPreferencesStore | null {
  if (!input.enabled) return null;
  try { return wirePreferenceStore(input); } catch (err) {
    // @silent-fallback-ok — reported loudly; without the store the preference route answers 503 and the list carries no preference fields
    input.warn?.(`  [conversation-preferences] wiring failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function wirePreferenceStore(input: WirePreferenceStoreInput): ConversationPreferencesStore {
  const store = new ConversationPreferencesStore({ stateDir: input.stateDir, report: input.report });
  if (input.peerStreams && input.ownMachineId) {
    try {
      let landed = 0;
      for (const rk of input.peerStreams.listRecordKeys(PREFERENCES_STORE_KEY)) {
        for (const r of input.peerStreams.loadOriginRecords(PREFERENCES_STORE_KEY, rk)) {
          if (r.origin !== input.ownMachineId && store.ingestReplicated((r.data as { row?: unknown }).row) === 'accepted') landed++;
        }
      }
      if (landed > 0) input.log?.(`  [conversation-preferences] landed ${landed} replicated preference row(s) at boot`);
    } catch (err) { input.warn?.(`  [conversation-preferences] boot replication read failed: ${err instanceof Error ? err.message : String(err)}`); } // @silent-fallback-ok — later commits land through the journal observer
  }
  if (input.emitter) {
    const emitter = input.emitter;
    const inFlight = new Set<string>();
    let batch: Array<{ eventId: string; durable: Promise<boolean> }> = [];
    let scheduled = false;
    const scheduleBatch = (): void => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        const group = batch; batch = [];
        void Promise.all(group.map(entry => entry.durable)).then(results => {
          store.confirmEmittedBatch(group.filter((_entry, index) => results[index]).map(entry => entry.eventId));
        }).catch(err => { // @silent-fallback-ok: report seam records the failure; pending rows remain durably retryable.
          input.report('ConversationPreferences.durableEmit', err instanceof Error ? err.message : String(err));
        }).finally(() => { for (const entry of group) inFlight.delete(entry.eventId); });
      });
    };
    store.setReplicationHook((row) => {
      if (inFlight.has(row.eventId)) return 'refused';
      const r = emitter.emit(PREFERENCES_STORE_KEY, derivePreferenceRecordKey(row.eventId), buildPreferenceRecordData(row));
      if (r.outcome === 'emitted' && typeof r.seq === 'number' && input.awaitDurable) {
        inFlight.add(row.eventId);
        const durable = Promise.resolve().then(() => input.awaitDurable!(r.seq!)).then(() => true, err => {
          input.report('ConversationPreferences.durableEmit', err instanceof Error ? err.message : String(err));
          return false;
        });
        batch.push({ eventId: row.eventId, durable });
        scheduleBatch();
      }
      // Enqueueing alone does not prove that the journal committed this row.
      return 'refused';
    });
    const { emitted, held } = store.flushEmits();
    if (emitted > 0) input.log?.(`  [conversation-preferences] shared ${emitted} preference row(s) written earlier`);
    if (held > 0) input.warn?.(`  [conversation-preferences] ${held} preference row(s) not shared yet; the existing maintenance tick retries them`);
  }
  return store;
}
