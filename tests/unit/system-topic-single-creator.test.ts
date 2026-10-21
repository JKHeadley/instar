/**
 * One agent-wide record of the system topics (📢 Updates, 🔔 Attention,
 * 🩺 Agent Health). Only the lease holder may create one; a standby adopts the
 * holder's ids. Before this, a standby could not save the id of a topic it had
 * just created (standby state is read-only), so it created another on every
 * boot — one machine minted 41 "Updates" topics that way.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter, type TelegramConfig } from '../../src/messaging/TelegramAdapter.js';
import { StateManager, SYSTEM_TOPIC_STATE_KEYS } from '../../src/core/StateManager.js';
import {
  adoptHolderSystemTopics, parseSystemTopicIds, readSystemTopicIds, withAdoptionBrake, MAX_ADOPTS_PER_KIND_PER_BOOT, type SystemTopicAdoptionDeps,
} from '../../src/messaging/SystemTopicAdoption.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'system-topic test cleanup' });
});

function stubApi(adapter: TelegramAdapter) {
  const rec = { created: [] as string[], sentTo: [] as number[] };
  let seq = 9000;
  vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
    .mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'createForumTopic') { rec.created.push(String(params.name)); return { message_thread_id: ++seq, name: params.name }; }
      if (method === 'sendMessage') { rec.sentTo.push(typeof params.message_thread_id === 'number' ? params.message_thread_id : 0); return { message_id: ++seq }; }
      return { ok: true };
    });
  return rec;
}
const adapters: TelegramAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(a => a.stop())); });
function makeAdapter(config: Partial<TelegramConfig>): TelegramAdapter {
  const a = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, ...config }, tmp('instar-systopic-'));
  adapters.push(a);
  return a;
}
const laneItem = (id: string) => ({ id, healthKey: id, lane: 'agent-health' as const, title: 'Heads-up', summary: 'maybe stuck', category: 'degradation', priority: 'HIGH' as const });

describe('TelegramAdapter — a standby never mints a system topic', () => {
  it('standby, nothing adopted yet: an agent-health item creates NO topic', async () => {
    const a = makeAdapter({ systemTopics: { canCreate: () => false, getAgentHealthTopicId: () => null } });
    const rec = stubApi(a);
    await a.createAttentionItem(laneItem('lane-a'));
    expect(rec.created).toEqual([]);
  });
  it('standby with the adopted lane id: posts into the holder\'s lane topic, creates nothing', async () => {
    const a = makeAdapter({ systemTopics: { canCreate: () => false, getAgentHealthTopicId: () => 48183 } });
    const rec = stubApi(a);
    const item = await a.createAttentionItem(laneItem('lane-b'));
    expect(rec.created).toEqual([]);
    expect(item.topicId).toBe(48183);
    expect(rec.sentTo).toContain(48183);
  });
  it('standby, no adopted hub: an attention item creates NO hub topic', async () => {
    const a = makeAdapter({ getAttentionHubTopicId: () => null, systemTopics: { canCreate: () => false } });
    const rec = stubApi(a);
    await a.createAttentionItem({ id: 'hub-a', title: 't', summary: 's', category: 'general', priority: 'HIGH' });
    expect(rec.created).toEqual([]);
  });
  it('an unreadable lease (canCreate throws) never mints a topic', async () => {
    const a = makeAdapter({ getAttentionHubTopicId: () => null, systemTopics: { canCreate: () => { throw new Error('lease unreadable'); } } });
    const rec = stubApi(a);
    await a.createAttentionItem({ id: 'hub-b', title: 't', summary: 's', category: 'general', priority: 'HIGH' });
    await a.createAttentionItem(laneItem('lane-c'));
    expect(rec.created).toEqual([]);
  });
});

describe('TelegramAdapter — the lease holder creates once and records the lane id', () => {
  it('creates the lane topic once and records it for restarts and standbys', async () => {
    const recorded: number[] = [];
    const a = makeAdapter({ systemTopics: { canCreate: () => true, getAgentHealthTopicId: () => null, recordAgentHealthTopicId: id => recorded.push(id) } });
    const rec = stubApi(a);
    const first = await a.createAttentionItem(laneItem('lane-d'));
    await a.createAttentionItem(laneItem('lane-e'));
    expect(rec.created).toHaveLength(1);
    expect(rec.created[0]).toContain('Agent Health');
    expect(recorded).toEqual([first.topicId]);
  });
  it('a recorded lane id is reused after a restart — no new topic', async () => {
    const a = makeAdapter({ systemTopics: { canCreate: () => true, getAgentHealthTopicId: () => 30286 } });
    const rec = stubApi(a);
    const item = await a.createAttentionItem(laneItem('lane-f'));
    expect(rec.created).toEqual([]);
    expect(item.topicId).toBe(30286);
  });
  it('the holder\'s lazily created attention hub is recorded so standbys can adopt it', async () => {
    const recorded: number[] = [];
    const a = makeAdapter({ getAttentionHubTopicId: () => null, systemTopics: { canCreate: () => true, recordAttentionHubTopicId: id => recorded.push(id) } });
    const rec = stubApi(a);
    const item = await a.createAttentionItem({ id: 'hub-c', title: 't', summary: 's', category: 'general', priority: 'HIGH' });
    expect(rec.created).toHaveLength(1);
    expect(recorded).toEqual([item.topicId]);
  });
  it('no systemTopics config (single machine) keeps creating when needed', async () => {
    const a = makeAdapter({});
    const rec = stubApi(a);
    await a.createAttentionItem(laneItem('lane-g'));
    expect(rec.created).toHaveLength(1);
  });
});

describe('StateManager.adoptSystemTopicId — the one write a standby may make for these keys', () => {
  it('writes an adopted system topic id while read-only; ordinary writes stay blocked', () => {
    const state = new StateManager(tmp('instar-systopic-state-'));
    state.setReadOnly(true);
    state.adoptSystemTopicId(SYSTEM_TOPIC_STATE_KEYS.updates, 48153);
    expect(state.get(SYSTEM_TOPIC_STATE_KEYS.updates)).toBe(48153);
    expect(() => state.set(SYSTEM_TOPIC_STATE_KEYS.updates, 1234)).toThrow(/read-only/);
  });
  it('refuses any other key and any non-topic value', () => {
    const state = new StateManager(tmp('instar-systopic-state-'));
    state.setReadOnly(true);
    expect(() => state.adoptSystemTopicId('agent-something-else', 5)).toThrow(/not a system topic key/);
    expect(() => state.adoptSystemTopicId(SYSTEM_TOPIC_STATE_KEYS.attention, 1)).toThrow(/invalid topic id/);
    expect(() => state.adoptSystemTopicId(SYSTEM_TOPIC_STATE_KEYS.attention, 1.5)).toThrow(/invalid topic id/);
  });
});

describe('adoptHolderSystemTopics', () => {
  function deps(overrides: Partial<SystemTopicAdoptionDeps> = {}) {
    const store = new Map<string, unknown>();
    const fetchHolder = vi.fn(async () => ({ topics: { updates: 48153, attention: 48154, agentHealth: 48183 }, holdsLease: true }));
    const d: SystemTopicAdoptionDeps = {
      holdsLease: () => false, leaseHolder: () => 'studio', selfMachineId: 'mama-pc', fetchHolder,
      get: k => store.get(k), adopt: (k, v) => { store.set(k, v); }, ...overrides,
    };
    return { d, store, fetchHolder };
  }
  it('a standby with no ids adopts all three of the holder\'s', async () => {
    const { d, store } = deps();
    expect(await adoptHolderSystemTopics(d)).toEqual({ outcome: 'adopted', adopted: ['updates', 'attention', 'agentHealth'] });
    expect(store.get('agent-updates-topic')).toBe(48153);
    expect(store.get('agent-health-topic')).toBe(48183);
  });
  it('replaces a standby\'s own stale id with the holder\'s, and is a no-op once converged', async () => {
    const { d, store } = deps();
    store.set('agent-updates-topic', 127430);
    expect((await adoptHolderSystemTopics(d)).adopted).toContain('updates');
    expect(store.get('agent-updates-topic')).toBe(48153);
    expect(await adoptHolderSystemTopics(d)).toEqual({ outcome: 'unchanged', adopted: [] });
  });
  it('the holder itself never fetches or adopts; it ensures its own topics instead (a late promotion)', async () => {
    const ensureOwn = vi.fn(async () => undefined);
    const { d, fetchHolder } = deps({ holdsLease: () => true, ensureOwn });
    expect((await adoptHolderSystemTopics(d)).outcome).toBe('holder');
    expect(fetchHolder).not.toHaveBeenCalled();
    expect(ensureOwn).toHaveBeenCalledTimes(1);
    const failing = deps({ holdsLease: () => true, ensureOwn: async () => { throw new Error('telegram down'); } }).d;
    await expect(adoptHolderSystemTopics(failing)).resolves.toEqual({ outcome: 'holder', adopted: [] });
  });
  it('no holder, or the holder is self: nothing to adopt', async () => {
    expect((await adoptHolderSystemTopics(deps({ leaseHolder: () => null }).d)).outcome).toBe('no-holder');
    expect((await adoptHolderSystemTopics(deps({ leaseHolder: () => 'mama-pc' }).d)).outcome).toBe('no-holder');
  });
  it('a failed fetch changes nothing and never throws', async () => {
    const { d, store } = deps({ fetchHolder: async () => { throw new Error('ECONNREFUSED'); } });
    store.set('agent-updates-topic', 57691);
    expect(await adoptHolderSystemTopics(d)).toEqual({ outcome: 'fetch-failed', adopted: [] });
    expect(store.get('agent-updates-topic')).toBe(57691);
  });
  it('a malformed holder answer adopts nothing and never clears a local id', async () => {
    const { d, store } = deps({ fetchHolder: async () => ({ topics: { updates: 'x', attention: -4, agentHealth: 1 } }) });
    store.set('agent-attention-topic', 57692);
    expect(await adoptHolderSystemTopics(d)).toEqual({ outcome: 'holder-has-none', adopted: [] });
    expect(store.get('agent-attention-topic')).toBe(57692);
  });
  it('the brake: a flapping holder record is followed at most MAX_ADOPTS_PER_KIND_PER_BOOT times per kind, then held', async () => {
    const store = new Map<string, unknown>();
    const log: string[] = [];
    let pass = 0;
    const d: SystemTopicAdoptionDeps = {
      holdsLease: () => false, leaseHolder: () => 'studio', selfMachineId: 'mama-pc',
      fetchHolder: async () => ({ topics: { updates: 100 + (++pass) } }),
      get: k => store.get(k), adopt: withAdoptionBrake((k, v) => { store.set(k, v); }, l => log.push(l)),
    };
    for (let i = 0; i < 10; i++) await adoptHolderSystemTopics(d);
    expect(store.get('agent-updates-topic')).toBe(100 + MAX_ADOPTS_PER_KIND_PER_BOOT);
    expect(log.filter(l => l.includes('flapping'))).toHaveLength(1);
  });
  it('parse/read helpers keep only real topic ids', () => {
    expect(parseSystemTopicIds({ topics: { updates: 7849, attention: '7848', agentHealth: 0 } })).toEqual({ updates: 7849 });
    expect(parseSystemTopicIds(null)).toEqual({});
    expect(readSystemTopicIds(k => ({ 'agent-updates-topic': 7849, 'agent-attention-topic': 7848 } as Record<string, unknown>)[k]))
      .toEqual({ updates: 7849, attention: 7848 });
  });
});

describe('startSystemTopicAdoptionLoop — a failed first pass retries soon, bounded, then the cadence owns it', () => {
  it('retries every retryMs while the holder is unknown, stops retrying once a pass reads the holder, and never exceeds maxShortRetries', async () => {
    vi.useFakeTimers();
    try {
      const { startSystemTopicAdoptionLoop } = await import('../../src/messaging/SystemTopicAdoption.js');
      const store = new Map<string, unknown>();
      let holderKnown = false;
      const passes: string[] = [];
      const stop = startSystemTopicAdoptionLoop({
        holdsLease: () => false,
        leaseHolder: () => { passes.push(holderKnown ? 'known' : 'unknown'); return holderKnown ? 'studio' : null; },
        selfMachineId: 'mama-pc',
        fetchHolder: async () => ({ topics: { updates: 48153, attention: 48154 } }),
        get: k => store.get(k), adopt: (k, v) => { store.set(k, v); },
      }, { firstDelayMs: 20_000, intervalMs: 30 * 60_000, retryMs: 2 * 60_000, maxShortRetries: 3 });
      await vi.advanceTimersByTimeAsync(20_000);           // first pass: no holder
      expect(passes).toEqual(['unknown']);
      await vi.advanceTimersByTimeAsync(2 * 60_000);       // short retry 1
      await vi.advanceTimersByTimeAsync(2 * 60_000);       // short retry 2
      expect(passes).toHaveLength(3);
      holderKnown = true;
      await vi.advanceTimersByTimeAsync(2 * 60_000);       // short retry 3 → adopts
      expect(store.get('agent-updates-topic')).toBe(48153);
      expect(passes).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(2 * 60_000);       // no 4th short retry: converged
      expect(passes).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(30 * 60_000);      // the cadence still runs
      expect(passes.length).toBeGreaterThanOrEqual(5);
      stop();
    } finally { vi.useRealTimers(); }
  });
  it('gives up short retries after maxShortRetries and leaves the cadence in charge', async () => {
    vi.useFakeTimers();
    try {
      const { startSystemTopicAdoptionLoop } = await import('../../src/messaging/SystemTopicAdoption.js');
      let passes = 0;
      const stop = startSystemTopicAdoptionLoop({
        holdsLease: () => false, leaseHolder: () => { passes++; return null; }, selfMachineId: 'x',
        fetchHolder: async () => ({}), get: () => undefined, adopt: () => {},
      }, { firstDelayMs: 1_000, intervalMs: 60 * 60_000, retryMs: 10_000, maxShortRetries: 2 });
      await vi.advanceTimersByTimeAsync(1_000 + 10_000 * 5); // first + 2 retries, then nothing
      expect(passes).toBe(3);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(passes).toBe(4);
      stop();
    } finally { vi.useRealTimers(); }
  });
});
