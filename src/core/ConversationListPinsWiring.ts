/**
 * wireListPinStore — build the conversation-list pin store on the replication path at server boot
 * (docs/specs/conversation-list-pins.md): the emitter hook for local changes, the landing of peers'
 * rows already in the peer streams, and the re-send of this machine's rows that never went out.
 * Kept out of server.ts so the boot function stays within the compiler's control-flow bound.
 */
import { ConversationListPinStore, LIST_PINS_STORE_KEY, buildListPinRecordData, deriveListPinRecordKey } from './ConversationListPins.js';
import type { ReplicatedRecordEmitter } from './ReplicatedRecordEmitter.js';

export interface ListPinPeerStreams {
  listRecordKeys(store: string): Iterable<string>;
  loadOriginRecords(store: string, recordKey: string): Iterable<{ origin: string; data: Record<string, unknown> }>;
}

export interface WireListPinStoreInput {
  stateDir: string;
  emitter: Pick<ReplicatedRecordEmitter, 'emit'> | null | undefined;
  peerStreams: ListPinPeerStreams | null | undefined;
  ownMachineId: string | null | undefined;
  report: (what: string, detail: string) => void;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/** The boot call: builds the store, or returns null (reported) when the feature is off or the wiring fails. */
export function wireListPinStoreSafe(input: WireListPinStoreInput & { enabled: boolean }): ConversationListPinStore | null {
  if (!input.enabled) return null;
  try { return wireListPinStore(input); } catch (err) {
    // @silent-fallback-ok — reported loudly; without the store the pin route answers 503 and the list carries no pin fields
    input.warn?.(`  [list-pins] wiring failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function wireListPinStore(input: WireListPinStoreInput): ConversationListPinStore {
  const store = new ConversationListPinStore({ stateDir: input.stateDir, report: input.report });
  if (input.peerStreams && input.ownMachineId) {
    try {
      let landed = 0;
      for (const rk of input.peerStreams.listRecordKeys(LIST_PINS_STORE_KEY)) {
        for (const r of input.peerStreams.loadOriginRecords(LIST_PINS_STORE_KEY, rk)) {
          if (r.origin !== input.ownMachineId && store.ingestReplicated((r.data as { row?: unknown }).row) === 'accepted') landed++;
        }
      }
      if (landed > 0) input.log?.(`  [list-pins] landed ${landed} replicated pin row(s) at boot`);
    } catch (err) { input.warn?.(`  [list-pins] boot replication read failed: ${err instanceof Error ? err.message : String(err)}`); } // @silent-fallback-ok — later commits land through the journal observer
  }
  if (input.emitter) {
    const emitter = input.emitter;
    store.setReplicationHook((row) => {
      const r = emitter.emit(LIST_PINS_STORE_KEY, deriveListPinRecordKey(row.eventId), buildListPinRecordData(row));
      // A dark store, a skip or an error leaves the row unshared: it is sent again at the next boot.
      return r.outcome === 'emitted' || r.outcome === 'unconfirmed' || r.outcome === 'dropped:deduped' ? 'emitted' : 'refused';
    });
    const { emitted, held } = store.flushEmits();
    if (emitted > 0) input.log?.(`  [list-pins] shared ${emitted} pin row(s) written earlier`);
    if (held > 0) input.warn?.(`  [list-pins] ${held} pin row(s) not shared yet; they are sent again at the next boot`);
  }
  return store;
}
