// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Every reader of ownership, decided (docs/specs/app-conversations-in-the-pool.md §2.7): the journal's
 * app rows from emit through the receive validator and the reader, and each consumer's arm.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { CoherenceJournalReader } from '../../src/core/CoherenceJournalReader.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { StrandedTopicSentinel, type StrandAttentionItem } from '../../src/monitoring/StrandedTopicSentinel.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';
import type { MachineCapacity } from '../../src/core/types.js';

const KEY = '0f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';
const KEY2 = '1f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';
const RK = `app:${KEY}`;
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'app-pool-cons-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/app-conversations-pool-consumers.test.ts' }); });

describe('the journal\'s app rows (§2.7)', () => {
  const journal = (dir: string) => { const j = new CoherenceJournal({ stateDir: dir, machineId: 'm_a', flushIntervalMs: 1_000_000 }); j.open(); return j; };

  it('topic absent, the key in the data, one op key per (key, epoch); two conversations never collapse', () => {
    const dir = tmp();
    const j = journal(dir);
    j.emitAppPlacement(RK, { owner: 'm_a', epoch: 3, reason: 'user-move' });
    j.emitAppPlacement(RK, { owner: 'm_a', epoch: 3, reason: 'user-move' }); // a replay of (key, epoch)
    j.emitAppPlacement(`app:${KEY2}`, { owner: 'm_b', epoch: 3, reason: 'user-move' }); // same epoch, another conversation
    j.emitPlacement(700, { owner: 'm_a', epoch: 3, reason: 'placed' });
    j.flush();
    j.close();
    const rows = new CoherenceJournalReader({ stateDir: dir }).query({ kind: 'topic-placement', limit: 100 }).entries;
    expect(rows).toHaveLength(3);
    const app = rows.filter((e) => typeof (e.data as { sessionKey?: string }).sessionKey === 'string');
    expect(app).toHaveLength(2);
    expect(app.every((e) => e.topic === undefined)).toBe(true);
    // opKeyOf rebuilds the same key after a restart: a reopened journal still dedupes.
    const again = journal(dir);
    again.emitAppPlacement(RK, { owner: 'm_a', epoch: 3, reason: 'user-move' });
    again.flush();
    again.close();
    expect(new CoherenceJournalReader({ stateDir: dir }).query({ kind: 'topic-placement', limit: 100 }).entries).toHaveLength(3);
  });

  it('the reader finds one conversation\'s rows by key', () => {
    const dir = tmp();
    const j = journal(dir);
    j.emitAppPlacement(RK, { owner: 'm_a', epoch: 4, reason: 'user-move' });
    j.emitAppPlacement(`app:${KEY2}`, { owner: 'm_b', epoch: 9, reason: 'user-move' });
    j.flush();
    j.close();
    const newest = new CoherenceJournalReader({ stateDir: dir }).query({ kind: 'topic-placement', sessionKey: RK, limit: 1 }).entries[0];
    expect((newest.data as { epoch: number }).epoch).toBe(4);
  });

  it('a bad key or a bad marker never reaches the file', () => {
    const dir = tmp();
    const j = journal(dir);
    j.emitAppPlacement('app:not-a-uuid', { owner: 'm_a', epoch: 1, reason: 'user-move' });
    j.emitAppPlacement(RK, { owner: 'm_a', epoch: 2, reason: 'user-move', takeover: 'yes' as never });
    j.flush();
    j.close();
    expect(new CoherenceJournalReader({ stateDir: dir }).query({ kind: 'topic-placement', limit: 10 }).entries).toHaveLength(0);
  });

  it('the receive validator accepts what the emit side writes: a rejection here halts the whole peer stream', () => {
    const a = new JournalSyncApplier({ stateDir: tmp() });
    const row = (seq: number, data: Record<string, unknown>) => ({ v: 1, ts: new Date().toISOString(), machine: 'm_peer', seq, kind: 'topic-placement', data });
    const res = a.apply('m_peer', [{
      machine: 'm_peer', kind: 'topic-placement', fromSeq: 1, toSeq: 2,
      entries: [row(1, { owner: 'm_peer', epoch: 7, reason: 'user-move', sessionKey: RK }), row(2, { owner: 'm_peer', epoch: 1000007, reason: 'failover', sessionKey: RK, takeover: true })],
    }] as never);
    expect(res.applied).toBe(2);
    expect(res.forgedEntries).toBe(0);
  });
});

describe('every other reader (§2.2, §2.7)', () => {
  const server = fs.readFileSync('src/commands/server.ts', 'utf-8');

  it('the overload shed never picks an app key', () => {
    const at = server.indexOf('ownedTopics: () => ownReg.all()');
    const block = server.slice(at, at + 500);
    expect(block).toContain("!r.sessionKey.startsWith('app:')");
  });

  it('the receiving side uses the strict Slack grammar, so a forwarded `app:` key is never rebuilt as Slack', () => {
    const at = server.indexOf('deliverMod.createDeliverMessageHandler({');
    const block = server.slice(at, server.indexOf('// ── WS1.2 owner-side drain runner', at));
    expect(block).not.toContain('isSlackSessionKey(');
    expect(block).toContain('isSlackConversationKey(cmd.session)');
    expect(block).toContain('isSlackConversationKey(slackKey)');
    expect(block.indexOf("cmd.session.startsWith('app:')")).toBeLessThan(block.indexOf('parseDashboardCreatePayload(cmd.payload) && typeof cmd.messageId') + 10_000);
  });

  it('the queue\'s drain delivers by kind: app, Slack, Telegram', () => {
    const at = server.indexOf('_drainLocalDeliver = async (dmsg, handover) => {');
    const block = server.slice(at, at + 1600);
    const app = block.indexOf('_appDrainDeliver(dmsg, handover)');
    const slack = block.indexOf('_slackInboundDispatch(reconstructSlackMessage(');
    const tg = block.indexOf('const topicId = Number(dmsg.sessionKey)');
    expect(app).toBeGreaterThan(-1);
    expect(slack).toBeGreaterThan(app);
    expect(tg).toBeGreaterThan(slack);
  });

  it('a queue loss on an app key finishes the phone\'s request in words, not a Telegram notice, in the drain and the boot sweep both', () => {
    expect(server.split('settleAppQueueLoss(allItems, reason)').length - 1).toBe(2);
    expect(server).toContain("settleAppQueueLoss(expired, 'gate:no-mesh-identity')"); // the orphan-store backstop
    expect(server.split('settleAppNotInjected(allItems)').length - 1).toBe(2);
    const at = server.indexOf('function settleAppQueueLoss');
    const body = server.slice(at, at + 500);
    expect(body).toContain('finishExpiredForward');
    // With no service the row keeps today's notice: it must never vanish silently.
    expect(body.indexOf('if (!_appConversationService) return items;')).toBeLessThan(body.indexOf('finishExpiredForward'));
  });

  it('the queue\'s local retry never dispatches a message already handled, or one still dispatching', () => {
    const at = server.indexOf('_appDrainDeliver = async (dmsg, handover) => {');
    const block = server.slice(at, at + 4600);
    const check = block.indexOf("appDrainDispatching.has(dmsg.messageId) || (already !== null && already !== 'pending' && already !== 'unknown')");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(block.indexOf('dispatchStoredAppMessage('));
    expect(block).toContain('appDrainDispatching.delete(dmsg.messageId)');
    expect(block).toContain("r.outcome === 'refused' ? 'unknown' : r.outcome");
  });

  it('the drain closes an app session through terminateWithAuthority, found by tmux name', () => {
    const at = server.indexOf('terminateSession: async (sk, reason, opts) => {');
    const block = server.slice(at, at + 800);
    expect(block).toContain("skipped: 'app-session-record-missing'");
    expect(block).toContain('terminateWithAuthority(rec.id, reason');
  });

  it('losing a conversation closes with the runtime-private exception and a reason beginning "topic moved"', () => {
    const at = server.indexOf('closeLostSession: async (key, tmux) => {');
    const block = server.slice(at, at + 500);
    expect(block).toContain('`topic moved:');
    expect(block).toContain('localPostTransferCloseout: true');
  });

  it('`session-status` carries the app records this machine holds', () => {
    expect(server).toContain('..._appPoolStatusRows()');
  });

  it('the flag is advertised only with durable ownership and replication live', () => {
    const at = server.indexOf('const appActive = (): boolean =>');
    const line = server.slice(at, server.indexOf('\n', at));
    expect(server).toContain('_refreshPoolHeartbeat(); }'); // it re-advertises the moment it turns on
    expect(line).toContain("_sessionPoolStage() !== 'dark'");
    expect(line).toContain('!!durableOwnershipStore');
    expect(line).toContain('_placementReplicationOn === true');
  });

  it('the stranded sentinel words an app conversation and offers to bring it back', () => {
    const raised: StrandAttentionItem[] = [];
    const NOW = 10_000_000;
    let clock = NOW;
    const rec: SessionOwnershipRecord = { sessionKey: RK, ownerMachineId: 'm_owner', ownershipEpoch: 3, status: 'active', nonce: 'n', timestamp: 0, updatedAt: '' };
    const fresh = new Date(NOW).toISOString();
    const self = { machineId: 'm_self', online: true, clockSkewStatus: 'ok', servesChannels: {} } as unknown as MachineCapacity;
    const owner = { machineId: 'm_owner', online: true, clockSkewStatus: 'ok', quotaState: { blocked: true }, selfReportedLastSeen: fresh, routerReceivedAt: fresh, fullHeartbeatReceivedAt: fresh } as unknown as MachineCapacity;
    const s = new StrandedTopicSentinel({
      listOwnershipRecords: () => [rec], listCapacities: () => [self, owner], selfMachineId: () => 'm_self', holdsLease: () => true,
      raiseAttention: (i: StrandAttentionItem) => raised.push(i), nicknameOf: (id: string) => (id === 'm_owner' ? 'Laptop' : id), now: () => clock,
    } as never, { enabled: true, dwellMs: 30_000 });
    s.tick();
    clock += 31_000;
    s.tick();
    expect(raised.length).toBeGreaterThan(0);
    const d = raised[0].description;
    expect(d).toContain('Bring it back here');
    expect(d).toContain('an app conversation');
    expect(d).not.toContain(KEY);
  });
});
