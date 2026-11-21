/**
 * wireTelegramTopicNames — build the topic-name store on the replication path at server boot
 * (docs/specs/topic-name-replication.md §8), BEFORE the adapter starts polling so no name it learns
 * goes unpublished: land peers' rows already on disk, bring the adapter in line with every held
 * winner, share names held before this shipped (fill rows), attach the adapter hook, and start the
 * drain for rows the emitter refused. Kept out of server.ts so the boot function stays small.
 */
import {
  TelegramTopicNameStore, TopicNameDrain, TOPIC_NAMES_STORE_KEY, TOPIC_NAME_DRAIN_ROWS_PER_TICK,
  buildTopicNameRecordData, deriveTopicNameRecordKey, type TopicNameRow, type TopicNameTarget,
} from './TelegramTopicNameReplication.js';
import type { ReplicatedRecordEmitter } from '../core/ReplicatedRecordEmitter.js';
import type { TopicNameReplicationHook } from './TelegramAdapter.js';

export interface TopicNamePeerStreams {
  listRecordKeys(store: string): Iterable<string>;
  loadOriginRecords(store: string, recordKey: string): Iterable<{ origin: string; data: Record<string, unknown> }>;
}

/** The adapter surface the wiring needs (TelegramAdapter implements it). */
export interface TopicNameAdapter extends TopicNameTarget {
  setTopicNameReplicationHook(fn: TopicNameReplicationHook | null, authority?: ((topicId: number) => string | null) | null): void;
}

export interface WireTelegramTopicNamesInput {
  stateDir: string;
  /** This agent's Telegram group id (config chatId). */
  chat: string;
  /** True on the machine that polls Telegram (the lead): its pre-upgrade names outrank other machines' fills. */
  telegramLead?: boolean;
  adapter: TopicNameAdapter;
  emitter: Pick<ReplicatedRecordEmitter, 'emit'> | null | undefined;
  peerStreams: TopicNamePeerStreams | null | undefined;
  ownMachineId: string | null | undefined;
  now?: () => number;
  maxFutureMs?: number;
  report: (what: string, detail: string) => void;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  drainBaseMs?: number;
  drainMaxMs?: number;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
  clearTimer?: (t: unknown) => void;
}

export interface WiredTelegramTopicNames { store: TelegramTopicNameStore; drain: TopicNameDrain | null }

export function wireTelegramTopicNames(input: WireTelegramTopicNamesInput): WiredTelegramTopicNames {
  const store = new TelegramTopicNameStore({ stateDir: input.stateDir, chat: input.chat, now: input.now, maxFutureMs: input.maxFutureMs, report: input.report, setTimer: input.setTimer });
  store.setTarget(input.adapter);
  let drain: TopicNameDrain | null = null;
  if (input.emitter) {
    const emitter = input.emitter;
    store.setReplicationHook((row: TopicNameRow) => {
      const r = emitter.emit(TOPIC_NAMES_STORE_KEY, deriveTopicNameRecordKey(row.eventId), buildTopicNameRecordData(row));
      // Only outcomes that show the journal holds the row count as sent; everything else is retried by the drain.
      if (r.outcome === 'emitted' || r.outcome === 'dropped:deduped') return 'emitted';
      // The journal will never take a row it refused on schema or size: reported once, not retried hourly forever.
      if (r.outcome === 'dropped:schema-rejected' || r.outcome === 'dropped:oversize') return 'final';
      return 'refused';
    });
    drain = new TopicNameDrain(store, { baseMs: input.drainBaseMs, maxMs: input.drainMaxMs, report: input.report, setTimer: input.setTimer, clearTimer: input.clearTimer });
    const d = drain;
    store.onRecord(() => d.resume());
  }
  // The names this machine held itself, read BEFORE any peer row is applied: only these are shared by the
  // backfill, so a name this machine borrowed from a peer's fill never gains its own (lead) authority.
  const ownNames = input.adapter.listTopicNames();
  // Land peers' rows already on disk (applied to the adapter, carried into the own stream by the drain).
  if (input.peerStreams && input.ownMachineId) {
    try {
      const rows: unknown[] = [];
      for (const rk of input.peerStreams.listRecordKeys(TOPIC_NAMES_STORE_KEY)) {
        for (const r of input.peerStreams.loadOriginRecords(TOPIC_NAMES_STORE_KEY, rk)) {
          if (r.origin !== input.ownMachineId) rows.push((r.data as { row?: unknown }).row);
        }
      }
      const landed = store.ingestReplicatedAll(rows);
      if (landed > 0) input.log?.(`  [topic-names] landed ${landed} topic name(s) from other machines at boot`);
    } catch (err) { // @silent-fallback-ok — reported; later commits land through the journal observer
      input.warn?.(`  [topic-names] boot replication read failed: ${err instanceof Error ? err.message : String(err)}`);
      input.report('TelegramTopicNames.replication', `reading other machines' names at boot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // A crash between the store's write and the registry's, or an apply that failed: the winner is re-applied.
  const fixed = store.reconcileTarget();
  if (fixed > 0) input.log?.(`  [topic-names] brought ${fixed} topic name(s) in line with what the machines agreed`);
  // Names held before this shipped: fill rows, which only fill gaps elsewhere.
  const filled = store.backfill(ownNames, input.telegramLead === true);
  if (filled > 0) input.log?.(`  [topic-names] sharing ${filled} topic name(s) this machine already held`);
  if (input.emitter && input.peerStreams && input.ownMachineId) {
    const streams = input.peerStreams, self = input.ownMachineId;
    const lost = store.reconcileOwnStream((row) => [...streams.loadOriginRecords(TOPIC_NAMES_STORE_KEY, deriveTopicNameRecordKey(row.eventId))].some((r) => r.origin === self));
    if (lost > 0) input.warn?.(`  [topic-names] ${lost} name(s) marked sent were not in this machine's journal; sending again`);
  }
  input.adapter.setTopicNameReplicationHook(
    (topicId, name, source, evidence) => store.recordLocal(topicId, name, source, evidence),
    (topicId) => store.heldName(topicId),
  );
  if (drain) {
    const { emitted, held } = store.flushEmits(TOPIC_NAME_DRAIN_ROWS_PER_TICK);
    if (emitted > 0) input.log?.(`  [topic-names] sent ${emitted} topic name row(s)`);
    if (held > 0) input.log?.(`  [topic-names] ${held} topic name row(s) queued; sent in paced batches`);
    drain.arm();
  }
  return { store, drain };
}

/** The boot call: the store, or null (reported) when the feature is off or the wiring fails. */
export function wireTelegramTopicNamesSafe(input: WireTelegramTopicNamesInput & { enabled: boolean }): WiredTelegramTopicNames | null {
  if (!input.enabled) return null;
  try { return wireTelegramTopicNames(input); } catch (err) {
    // @silent-fallback-ok — reported loudly; without the store every machine keeps its topic names machine-local (today's behavior)
    try { input.adapter.setTopicNameReplicationHook(null, null); } catch { /* @silent-fallback-ok — the hook was never attached */ }
    input.warn?.(`  [topic-names] wiring failed: ${err instanceof Error ? err.message : String(err)}`);
    input.report('TelegramTopicNames.replication', `wiring failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
