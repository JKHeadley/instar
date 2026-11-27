// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e (docs/specs/topic-name-replication.md): Telegram topic-name replication is ALIVE on the production
 * init path. The kind is registered the way server.ts does it, a real CoherenceJournal,
 * ReplicatedRecordEmitter (with the store's resolved flag) and ReplicatedPeerStreamReader carry it, the
 * real boot wiring builds the store around a real TelegramAdapter, and:
 *  - a captured topic name emits exactly one record into this machine's own stream;
 *  - a restart sends nothing again (the row is in the own stream);
 *  - with the store's flag off (the kill-switch path) nothing is emitted.
 * Plus WIRED source checks that server.ts registers the kind, resolves the switch, lands peers' commits,
 * wires the store before the adapter starts polling, and labels sessions on every machine.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';

const OP = 'tests/e2e/telegram-topic-name-replication-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KIND = 'telegram-topic-name-record';

describe('Telegram topic names — alive on the production init path', () => {
  const dirs: string[] = [];
  const adapters: TelegramAdapter[] = [];
  afterEach(async () => {
    for (const a of adapters.splice(0)) await a.stop();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function boot(stateDir: string, storeOn = true) {
    const registry = new ReplicatedKindRegistry();
    // Exactly server.ts's registration statement.
    const { TOPIC_NAMES_KIND_REGISTRATION } = await import('../../src/messaging/TelegramTopicNameReplication.js');
    registry.register(TOPIC_NAMES_KIND_REGISTRATION);
    const journal = new CoherenceJournal({ stateDir, machineId: 'm_e2e', flushIntervalMs: 1_000_000 });
    journal.open();
    journal.setReplicatedKindRegistry(registry);
    const reader = new ReplicatedPeerStreamReader({ stateDir, registry, selfMachineId: 'm_e2e' });
    let t = Date.now();
    const emitter = new ReplicatedRecordEmitter({
      journal, clock: new HybridLogicalClock({ node: 'm_e2e', now: () => (t += 1000) }), registry, origin: 'm_e2e',
      stores: () => (storeOn ? { telegramTopicNames: { enabled: true } } : {}),
      loadWitness: (store, recordKey) => reader.loadWitness(store, recordKey),
    });
    const adapter = new TelegramAdapter({ token: 't', chatId: '-100123' } as never, stateDir, { suppressLifelineAutoCreate: true });
    adapters.push(adapter);
    const tn = await import('../../src/messaging/TelegramTopicNameReplicationWiring.js');
    const wired = tn.wireTelegramTopicNamesSafe({
      enabled: true, stateDir, chat: '-100123', telegramLead: true, adapter, emitter, peerStreams: reader, ownMachineId: 'm_e2e',
      now: () => Date.now(), report: () => undefined, setTimer: () => ({}),
    });
    return { journal, adapter, wired };
  }

  it('a captured name emits one record into the own stream; a restart sends nothing again', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-alive-')); dirs.push(stateDir);
    const a = await boot(stateDir);
    expect(a.wired).not.toBeNull();
    a.adapter.captureTopicName(146128, '📄 Docs from any computer', false);
    a.journal.flush();
    const entries = a.journal.readTail(KIND as never, 10).entries;
    expect(entries).toHaveLength(1);
    expect((entries[0].data as { row: { name: string; topicId: number } }).row).toMatchObject({ topicId: 146128, name: '📄 Docs from any computer' });
    expect(a.wired!.store.dueCount()).toBe(0);
    a.journal.close();

    const again = await boot(stateDir);
    try {
      again.journal.flush();
      expect(again.journal.readTail(KIND as never, 10).entries).toHaveLength(1);
      expect(again.adapter.getTopicName(146128)).toBe('📄 Docs from any computer');
    } finally { again.journal.close(); }
  });

  it('with the store flag off nothing is emitted and the row stays unsent', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-alive-off-')); dirs.push(stateDir);
    const a = await boot(stateDir, false);
    try {
      a.adapter.captureTopicName(77, 'A topic name', false);
      a.journal.flush();
      expect(a.journal.readTail(KIND as never, 10).entries).toHaveLength(0);
      expect(a.wired!.store.dueCount()).toBe(1);
    } finally { a.journal.close(); }
  });

  it('WIRED: server.ts registers the kind, resolves the switch, lands peers\' commits and wires before polling starts', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(src).toContain('replicatedKindRegistry.register(TOPIC_NAMES_KIND_REGISTRATION)');
    expect(src).toContain('_telegramTopicNamesOn = !!coherenceJournal && _stateSyncStoresBase?.telegramTopicNames?.enabled !== false;');
    expect(src).toContain('if (_telegramTopicNamesOn) s = { ...s, telegramTopicNames: { enabled: true } };');
    expect(src).toContain('|| _telegramTopicNamesOn ||');
    expect(src).toContain("if (kind === 'telegram-topic-name-record') _telegramTopicNames?.store.ingestReplicatedAll(");
    expect(src).toContain('_telegramTopicNames = tn.wireTelegramTopicNamesSafe({');
    // Wired before the adapter polls, and on the send-only (standby) branch too, with the session label.
    const startIdx = src.indexOf('await telegram.start();');
    const wireIdx = src.lastIndexOf('await wireTopicNameReplication(telegram);', startIdx);
    expect(wireIdx).toBeGreaterThan(0);
    expect(startIdx - wireIdx).toBeLessThan(200);
    const sendOnly = src.indexOf("Telegram routing + command callbacks wired (send-only)");
    const sendOnlyTail = src.slice(sendOnly, sendOnly + 300);
    expect(sendOnlyTail).toContain('wireTopicRenameLabel(telegram);');
    expect(sendOnlyTail).toContain('await wireTopicNameReplication(telegram);');
  });
});
