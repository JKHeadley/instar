import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotificationSelectivityGate, verifiedReplyEnvelope } from '../../src/messaging/NotificationSelectivityGate.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.unstubAllGlobals(); });
function setup(dryRun = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-gate-'));
  const gate = new NotificationSelectivityGate(root, 'test-machine', () => ({ enabled: true, dryRun }));
  cleanup.push(async () => { await gate.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/notification-selectivity.test.ts' }); });
  return { root, gate };
}
describe('Quiet by Default delivery', () => {
  it('records 1000 unstamped mixed source sends with zero Telegram calls', async () => {
    const { root, gate } = setup();
    const adapter = new TelegramAdapter({ token: '123:test', chatId: '-1001' }, root);
    (adapter as any).selectivity = gate;
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (let i = 0; i < 1000; i++) {
      const receipt = await adapter.sendToTopic(42, `routine finding ${i}`);
      expect(receipt).toMatchObject({ delivered: false, recorded: true });
      expect(receipt).not.toHaveProperty('messageId');
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(gate.store.list({ limit: 200 }).reduce((sum, row) => sum + row.count, 0)).toBe(1000);
    expect(adapter.getTopicHistory(42, 20)).toHaveLength(0);
  });
  it('does not accept a forged reply envelope', async () => {
    const { gate } = setup();
    expect((await gate.route(42, 'automation', { origin: 'verified-reply', category: 'uncategorized', sourceContext: 'fake' })).receipt?.recorded).toBe(true);
    expect((await gate.route(42, 'hours-late reply', verifiedReplyEnvelope('reply-route'))).receipt).toBeUndefined();
  });
  it('dry run records counterfactual decisions without unread quiet rows', async () => {
    const { gate } = setup(true);
    expect((await gate.route(42, 'observed')).receipt).toBeUndefined();
    expect(gate.store.counters().total).toBe(0);
  });
  it('binds command replies to a specific recent inbound', async () => {
    const { gate } = setup();
    const envelope = { origin: 'automated' as const, category: 'command-response' as const, sourceContext: 'command', inboundMessageId: '7' };
    expect(gate.decide(42, envelope).decision).toBe('record');
    gate.observeInbound(42, 7, true);
    expect(gate.decide(42, envelope).decision).toBe('deliver');
    expect(gate.decide(42, envelope).decision).toBe('record');
  });
  it('preserves cold-map delivery-loss floors but never unsolicited presence', () => {
    const { gate } = setup();
    expect(gate.decide(42, { origin: 'automated', category: 'message-loss-notice', sourceContext: 'loss', inboundMessageId: '7' }).decision).toBe('deliver');
    expect(gate.decide(42, { origin: 'automated', category: 'presence-standby', sourceContext: 'presence', inboundMessageId: '7' }).decision).toBe('record');
  });
});

describe('quiet store ordering and conservation', () => {
  it('coalesces concurrent emissions without losing occurrence counts', async () => {
    const { gate } = setup();
    await Promise.all(Array.from({ length: 1000 }, (_, i) => gate.route(42, `event ${i}`, {
      origin: 'automated', category: 'job-status', sourceContext: 'one-source',
    })));
    const rows = gate.store.list({ limit: 200 });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1000);
    expect(fs.readFileSync(gate.store.file, 'utf8').trim().split('\n')).toHaveLength(1);
  });
  it('retains an acknowledgement across flush and restart', async () => {
    const { root, gate } = setup();
    const first = await gate.route(42, 'one');
    await gate.route(42, 'two');
    await gate.store.ack(first.receipt!.quietId);
    await gate.store.flush();
    const { QuietNotificationStore } = await import('../../src/messaging/QuietNotificationStore.js');
    const reopened = new QuietNotificationStore(root, 'test-machine');
    await reopened.ready;
    expect(reopened.list()[0]).toMatchObject({ count: 2, read: true });
    await reopened.close();
  });
  it('keeps attribution to separate conversations for the same source', async () => {
    const { gate } = setup();
    await gate.route(42, 'first'); await gate.route(43, 'second');
    expect(gate.store.list({ topicId: 42 })[0].text).toBe('first');
    expect(gate.store.list({ topicId: 43 })[0].text).toBe('second');
  });
  it('does not skip rows sharing a timestamp when paging', async () => {
    const { root } = setup();
    const { QuietNotificationStore } = await import('../../src/messaging/QuietNotificationStore.js');
    const store = new QuietNotificationStore(root, 'test', () => 1800000000000);
    for (let i = 0; i < 5; i++) await store.record({ category: 'job-status', sourceContext: `source-${i}`, topicId: 42, text: String(i) });
    const first = store.list({ limit: 2 });
    const second = store.list({ limit: 2, before: `${first[1].createdAt}|${first[1].id}` });
    const third = store.list({ limit: 2, before: `${second[1].createdAt}|${second[1].id}` });
    expect(new Set([...first, ...second, ...third].map(row => row.id)).size).toBe(5);
    await store.close();
  });
  it('never creates attention topics for routine items even marked urgent', async () => {
    const { root, gate } = setup();
    const adapter = new TelegramAdapter({ token: '123:test', chatId: '-1001' }, root);
    adapter.selectivity = gate;
    const transport = vi.fn(); vi.stubGlobal('fetch', transport);
    for (const priority of ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const) {
      const row = await adapter.createAttentionItem({ id: priority, title: 'Routine', category: 'system', priority });
      expect(row.hubHeld).toBe(true);
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it('generic adapter sends share the same gate', async () => {
    const { root, gate } = setup();
    const adapter = new TelegramAdapter({ token: '123:test', chatId: '-1001' }, root);
    adapter.selectivity = gate;
    const transport = vi.fn(); vi.stubGlobal('fetch', transport);
    expect(await adapter.send({ userId: '1', content: 'background' })).toMatchObject({ recorded: true });
    expect(transport).not.toHaveBeenCalled();
  });
  it('presence cannot cite an inbound after it has been answered', () => {
    const { gate } = setup(); gate.observeInbound(42, 7, true);
    const envelope = { origin: 'automated' as const, category: 'presence-standby' as const, sourceContext: 'presence', inboundMessageId: '7' };
    expect(gate.decide(42, envelope).decision).toBe('deliver');
    gate.markAnswered(42);
    expect(gate.decide(42, envelope).decision).toBe('record');
  });
});

describe('failure and retry floors', () => {
  it('repairs a torn final row boundary before later appends', async () => {
    const { root, gate } = setup(); await gate.close();
    fs.mkdirSync(path.dirname(gate.store.file), { recursive: true });
    fs.writeFileSync(gate.store.file, '{"type":"put","row":');
    const { QuietNotificationStore } = await import('../../src/messaging/QuietNotificationStore.js');
    const recovered = new QuietNotificationStore(root, 'test'); await recovered.ready;
    await recovered.record({ category: 'job-status', sourceContext: 'after-crash', text: 'retained' }); await recovered.close();
    const restarted = new QuietNotificationStore(root, 'test'); await restarted.ready;
    expect(restarted.list()[0].text).toBe('retained'); expect(restarted.health.tornLines).toBeGreaterThan(0); await restarted.close();
  });
  it('reserves a command disposition for retries of its original operation', async () => {
    const { gate } = setup(); gate.observeInbound(42, 7, true);
    const envelope = { origin: 'automated' as const, category: 'command-response' as const, sourceContext: 'command', inboundMessageId: '7' };
    expect((await gate.route(42, 'reply', envelope, 'operation-1')).verdict.decision).toBe('deliver');
    expect((await gate.route(42, 'reply', envelope, 'operation-1')).verdict.decision).toBe('deliver');
    expect((await gate.route(42, 'second unsolicited response', envelope, 'operation-2')).receipt?.recorded).toBe(true);
  });
  it('requires a real delivered receipt for one command completion edit', async () => {
    const { root, gate } = setup(); gate.observeInbound(42, 7, true);
    const adapter = new TelegramAdapter({ token: '123:test', chatId: '-1001' }, root); adapter.selectivity = gate;
    const network = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: { message_id: 123 } }) }); vi.stubGlobal('fetch', network);
    const response = await adapter.sendToTopic(42, 'Open the login URL', { envelope: { origin: 'automated', category: 'command-response', sourceContext: 'command', inboundMessageId: '7' } });
    if (response.recorded) throw new Error('Command should deliver');
    await expect(adapter.editCommandResponse(42, { messageId: 123 }, 'forged')).rejects.toThrow('receipt');
    await expect(adapter.editCommandResponse(43, response, 'wrong topic')).rejects.toThrow('receipt');
    await adapter.editCommandResponse(42, response, 'Authentication complete');
    await expect(adapter.editCommandResponse(42, response, 'repeat')).rejects.toThrow('receipt');
    expect(network).toHaveBeenCalledTimes(2);
    expect(String(network.mock.calls[1][0])).toContain('editMessageText');
  });
  it('routine module stampers cannot inherit inbound response authority', async () => {
    const { notificationContext } = await import('../../src/messaging/NotificationSelectivityGate.js');
    const { notificationStamper } = await import('../../src/messaging/notificationStampers.js');
    const envelope = { origin: 'automated' as const, category: 'command-response' as const, sourceContext: 'inbound', inboundMessageId: '7' };
    const actual = notificationContext.run(envelope, () => notificationStamper('src/scheduler/JobScheduler.ts')());
    expect(actual.category).toBe('job-status'); expect(actual.inboundMessageId).toBeUndefined();
  });
});

describe('deterministic producer floor composition', () => {
  it('keeps an inbound-bound cold-start notice and records routine deterministic output', async () => {
    const { root, gate } = setup(); gate.observeInbound(42, 7, true);
    const { notificationContext } = await import('../../src/messaging/NotificationSelectivityGate.js');
    const { sendDeterministicTelegramNotice } = await import('../../src/messaging/telegram-origin/OriginDeterministicSend.js');
    const adapter = new TelegramAdapter({ token: '123:test', chatId: '-1001' }, root); adapter.selectivity = gate;
    const network = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) }); vi.stubGlobal('fetch', network);
    await notificationContext.run({ origin: 'automated', category: 'cold-start-fallback', sourceContext: 'inbound', inboundMessageId: '7' }, async () => {
      expect(await sendDeterministicTelegramNotice(adapter, 'cold-start-fallback', 42, 'Your message is saved')).not.toHaveProperty('recorded', true);
      expect(await sendDeterministicTelegramNotice(adapter, 'auto-updater', 42, 'Routine update housekeeping')).toMatchObject({ recorded: true });
    });
    expect(network).toHaveBeenCalledOnce();
  });
});

describe('category push is an effective choice', () => {
  it('allows the explicit Agent Health opt-in through the earlier routine-health hold', async () => {
    const { root, gate: original } = setup(); await original.close();
    const gate = new NotificationSelectivityGate(root, 'test-machine', () => ({ enabled: true, dryRun: false, push: { categories: { 'agent-health': true } } }));
    cleanup.unshift(async () => gate.close());
    const adapter = new TelegramAdapter({ token: '123:test', chatId: '-1001', systemTopics: { getAgentHealthTopicId: () => 55 } }, root); adapter.selectivity = gate;
    const network = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: { message_id: 123 } }) }); vi.stubGlobal('fetch', network);
    const row = await adapter.createAttentionItem({ id: 'health-choice', title: 'Chosen health report', summary: 'A routine condition', category: 'system', priority: 'NORMAL', lane: 'agent-health' });
    expect(row.topicId).toBe(55); expect(row.hubHeld).toBe(false); expect(network).toHaveBeenCalledOnce();
  });
});


describe('durable conservative soak evidence', () => {
  it('retains clean restart counts and resets a possibly incomplete crash window', async () => {
    const { root, gate } = setup();
    await gate.route(42, 'response', verifiedReplyEnvelope('trusted-reply')); await gate.close();
    const restarted = new NotificationSelectivityGate(root, 'test-machine', () => ({ enabled: true, dryRun: true }));
    await restarted.route(42, 'response', verifiedReplyEnvelope('trusted-reply'));
    expect((restarted.status() as any).soakEvidence.replySends).toBe(2); await restarted.close();
    const file = path.join(root, 'state', 'notification-selectivity-evidence.json');
    const checkpoint = JSON.parse(fs.readFileSync(file, 'utf8')); checkpoint.cleanShutdown = false;
    fs.writeFileSync(file, JSON.stringify(checkpoint));
    const crashed = new NotificationSelectivityGate(root, 'test-machine', () => ({ enabled: true, dryRun: true }));
    await crashed.route(42, 'response', verifiedReplyEnvelope('trusted-reply'));
    expect((crashed.status() as any).soakEvidence.replySends).toBe(1); await crashed.close();
  });
});
