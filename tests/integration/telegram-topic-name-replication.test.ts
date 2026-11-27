// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * Integration (docs/specs/topic-name-replication.md): three machines, each with a real CoherenceJournal,
 * ReplicatedRecordEmitter, ReplicatedPeerStreamReader and a real TelegramAdapter (no network), wired by
 * the production wiring module. Committed records are handed between machines exactly as the
 * peer-commit observer line in server.ts does.
 *  - a rename on A lands on B, in B's map AND its registry file (survives a reload of the adapter);
 *  - B carries the row into its own stream;
 *  - a rebuilt machine C that only ever reads B's stream learns the name with A gone;
 *  - a standby that upgrades first cannot impose its stale pre-upgrade name over the lead's.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { TOPIC_NAMES_KIND_REGISTRATION, TOPIC_NAME_RECORD_KIND } from '../../src/messaging/TelegramTopicNameReplication.js';
import { wireTelegramTopicNames, type WiredTelegramTopicNames } from '../../src/messaging/TelegramTopicNameReplicationWiring.js';

const OP = 'tests/integration/telegram-topic-name-replication.test.ts';
const CHAT = '-100123';

interface Machine { id: string; dir: string; journal: CoherenceJournal; adapter: TelegramAdapter; wired: WiredTelegramTopicNames }

describe('Telegram topic names across machines', () => {
  const dirs: string[] = []; const open: Machine[] = [];
  afterEach(async () => {
    for (const m of open.splice(0)) { try { m.journal.close(); } catch { /* closed */ } await m.adapter.stop(); }
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  function machine(id: string, opts: { lead?: boolean; preload?: Array<[number, string]> } = {}): Machine {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tnr-int-${id}-`)); dirs.push(dir);
    const registry = new ReplicatedKindRegistry();
    registry.register(TOPIC_NAMES_KIND_REGISTRATION);
    const journal = new CoherenceJournal({ stateDir: dir, machineId: id, flushIntervalMs: 1_000_000 });
    journal.open();
    journal.setReplicatedKindRegistry(registry);
    const reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: id });
    let t = Date.now();
    const emitter = new ReplicatedRecordEmitter({
      journal, clock: new HybridLogicalClock({ node: id, now: () => (t += 1) }), registry, origin: id,
      stores: () => ({ telegramTopicNames: { enabled: true } }),
      loadWitness: (store, recordKey) => reader.loadWitness(store, recordKey),
    });
    const adapter = new TelegramAdapter({ token: 't', chatId: CHAT } as never, dir, { suppressLifelineAutoCreate: true });
    for (const [topic, name] of opts.preload ?? []) adapter.captureTopicName(topic, name, false);
    const wired = wireTelegramTopicNames({ stateDir: dir, chat: CHAT, telegramLead: opts.lead === true, adapter, emitter, peerStreams: reader, ownMachineId: id, report: () => {}, setTimer: () => ({}) });
    const m = { id, dir, journal, adapter, wired };
    open.push(m);
    return m;
  }

  /** The rows a machine's own stream holds, as the peer-commit observer would hand them on. */
  function ownRows(m: Machine): unknown[] {
    m.journal.flush();
    return m.journal.readTail(TOPIC_NAME_RECORD_KIND as never, 1000).entries.map((e) => (e.data as { row?: unknown }).row);
  }

  it('a rename on A reaches B (map and registry file), B carries it, and a rebuilt C learns it from B alone', () => {
    const a = machine('m_a', { lead: true });
    const b = machine('m_b');
    a.adapter.captureTopicName(146128, 'Docs from any computer', false);
    a.adapter.captureTopicName(146128, '📄 Docs from any computer', true, Date.now(), 9001);
    expect(b.wired.store.ingestReplicatedAll(ownRows(a))).toBeGreaterThan(0);
    expect(b.adapter.getTopicName(146128)).toBe('📄 Docs from any computer');
    const reg = JSON.parse(fs.readFileSync(path.join(b.dir, 'topic-session-registry.json'), 'utf-8'));
    expect(reg.topicToName['146128']).toBe('📄 Docs from any computer');

    // B's own stream now holds the carried row, so A can die.
    const carried = ownRows(b);
    expect(carried.some((r) => (r as { name?: string }).name === '📄 Docs from any computer')).toBe(true);
    a.journal.close();

    const c = machine('m_c');
    c.wired.store.ingestReplicatedAll(carried);
    expect(c.adapter.getTopicName(146128)).toBe('📄 Docs from any computer');
  });

  it('an old rename arriving after a newer one does not win, and the creation name never undoes a rename', () => {
    const a = machine('m_a', { lead: true });
    const b = machine('m_b');
    a.adapter.captureTopicName(77, 'Original', false);
    a.adapter.captureTopicName(77, 'Second name', true, Date.now() - 1_000, 20);
    const newer = ownRows(a);
    b.wired.store.ingestReplicatedAll(newer);
    // A delayed notice of an earlier rename, and a reply quoting the creation message, reach B's poller later.
    b.adapter.captureTopicName(77, 'First rename', true, Date.now() - 60_000, 10);
    b.adapter.captureTopicName(77, 'Original', false);
    expect(b.adapter.getTopicName(77)).toBe('Second name');
  });

  it('a standby that upgrades first cannot impose its stale pre-upgrade name over the lead\'s', () => {
    const standby = machine('m_standby', { preload: [[55, 'Created name']] });
    const lead = machine('m_lead', { lead: true, preload: [[55, 'Renamed by owner']] });
    // The lead boots after the standby's fill already landed (upgrade order: standby first).
    lead.wired.store.ingestReplicatedAll(ownRows(standby));
    lead.wired.store.backfill(lead.adapter.listTopicNames(), true);
    const fresh = machine('m_fresh');
    fresh.wired.store.ingestReplicatedAll([...ownRows(standby), ...ownRows(lead)]);
    expect(fresh.adapter.getTopicName(55)).toBe('Renamed by owner');
    // The standby keeps the name it held itself (fills never replace a held name).
    standby.wired.store.ingestReplicatedAll(ownRows(lead));
    expect(standby.adapter.getTopicName(55)).toBe('Created name');
  });
});
