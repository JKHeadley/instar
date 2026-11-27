/**
 * wireReadMarkerStore — build the read-marker store on the replication path at server boot
 * (docs/specs/mobile-unread-messages.md §3.3): the emitter hook for local advances, and the landing
 * of peers' records already on disk in the peer streams. Kept out of server.ts so the boot
 * function stays within the compiler's control-flow analysis bound.
 */
import { ConversationReadMarkerStore, READ_MARKERS_STORE_KEY, buildReadMarkerRecordData, deriveReadMarkerRecordKey } from './ConversationReadMarkers.js';
import type { ReplicatedRecordEmitter } from './ReplicatedRecordEmitter.js';

export interface ReadMarkerPeerStreams {
  listRecordKeys(store: string): Iterable<string>;
  loadOriginRecords(store: string, recordKey: string): Iterable<{ origin: string; data: Record<string, unknown> }>;
}

export interface WireReadMarkerStoreInput {
  stateDir: string;
  emitter: Pick<ReplicatedRecordEmitter, 'emit'> | null | undefined;
  peerStreams: ReadMarkerPeerStreams | null | undefined;
  ownMachineId: string | null | undefined;
  report: (what: string, detail: string) => void;
  removalEvidence: (reader: string, ref: string) => boolean;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/** The boot call: builds the store, or returns null (reported) when unread is off or the wiring fails. */
export function wireReadMarkerStoreSafe(input: WireReadMarkerStoreInput & { enabled: boolean }): ConversationReadMarkerStore | null {
  if (!input.enabled) return null;
  try { return wireReadMarkerStore(input); } catch (err) {
    // @silent-fallback-ok — reported loudly; without the store the read routes answer 503 and the list carries no read fields
    input.warn?.(`  [read-markers] wiring failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function wireReadMarkerStore(input: WireReadMarkerStoreInput): ConversationReadMarkerStore {
  const store = new ConversationReadMarkerStore({ stateDir: input.stateDir, report: input.report, removalEvidence: input.removalEvidence });
  if (input.emitter) {
    const emitter = input.emitter;
    store.setReplicationHook((w) => {
      const r = emitter.emit(READ_MARKERS_STORE_KEY, deriveReadMarkerRecordKey(w.reader, w.ref), buildReadMarkerRecordData(w));
      // A dark store or an unregistered kind has nothing to share: the key is not left due forever.
      if (r.outcome === 'emitted' || r.outcome === 'unconfirmed' || r.outcome === 'disabled' || r.outcome === 'skipped') return 'accepted';
      return r.outcome === 'dropped:deduped' ? 'deduped' : 'refused';
    });
  }
  if (input.peerStreams && input.ownMachineId) {
    try {
      let landed = 0;
      for (const rk of input.peerStreams.listRecordKeys(READ_MARKERS_STORE_KEY)) {
        for (const r of input.peerStreams.loadOriginRecords(READ_MARKERS_STORE_KEY, rk)) {
          if (r.origin !== input.ownMachineId && store.ingestReplicated(r.data) === 'accepted') landed++;
        }
      }
      if (landed > 0) input.log?.(`  [read-markers] landed ${landed} replicated marker(s) at boot`);
    } catch (err) { input.warn?.(`  [read-markers] boot replication read failed: ${err instanceof Error ? err.message : String(err)}`); } // @silent-fallback-ok — the boot catch-up refills from any peer
  }
  return store;
}
