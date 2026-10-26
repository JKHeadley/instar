/**
 * Tier-1 unit tests for the attention store's lifecycle layer
 * (docs/specs/attention-lifecycle-close-on-cause.md §3.1 / §3.2 / §3.4) on
 * the REAL TelegramAdapter with the HTTP layer stubbed: one row per
 * condition, refresh-on-change, reopen-in-place, clear-on-cause, the
 * reconciliation pass (supersede → verified clears → expiry) and the
 * first-pass expiry dry run.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter, type TelegramConfig } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HUB = 4242;
const DAY = 86_400_000;

function stubApi(adapter: TelegramAdapter): { hubPosts: string[] } {
  const rec = { hubPosts: [] as string[] };
  vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
    .mockImplementation(async (method, params) => {
      if (method === 'sendMessage' && params.message_thread_id === HUB) rec.hubPosts.push(String(params.text ?? ''));
      if (method === 'createForumTopic') return { message_thread_id: 9999, name: params.name };
      return { ok: true, message_id: 1 };
    });
  return rec;
}

describe('attention store lifecycle', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  function makeAdapter(config: Partial<TelegramConfig> = {}, dir?: string): TelegramAdapter {
    tmpDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'instar-attn-lifecycle-'));
    adapter = new TelegramAdapter(
      { token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, attentionHubFilter: 'all', getAttentionHubTopicId: () => HUB, ...config },
      tmpDir,
    );
    return adapter;
  }
  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'attention-lifecycle test cleanup' });
  });

  const obs = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: 'Claude Code sign-in repair', summary: 'Open Subscriptions and tap Repair sign-in.', category: 'subscription-relogin',
    priority: 'HIGH' as const, sourceContext: 'assisted-subscription-relogin', ...over,
  });

  it('two observations with the same conditionKey land on ONE row; a repeat is silent and counted', async () => {
    makeAdapter();
    const rec = stubApi(adapter);
    const key = 'subscription-relogin:acct:m1';
    const a = await adapter.createAttentionItem(obs('relogin-ep1-suggested', { conditionKey: key }));
    const b = await adapter.createAttentionItem(obs('relogin-ep2-suggested', { conditionKey: key }));
    expect(b.id).toBe(a.id);
    expect(adapter.getAttentionItems('OPEN')).toHaveLength(1);
    expect(b.occurrences).toBe(2);
    expect(b.aliases).toEqual(['relogin-ep2-suggested']);
    expect(adapter.getAttentionItem('relogin-ep2-suggested')?.id).toBe(a.id);
    expect(rec.hubPosts).toHaveLength(1);
  });

  it('a changed ask (approve → tap your phone now) refreshes the row and re-posts; a mere repeat keeps ACKNOWLEDGED', async () => {
    makeAdapter();
    const rec = stubApi(adapter);
    const key = 'subscription-relogin:acct:m1';
    const a = await adapter.createAttentionItem(obs('r-1', { conditionKey: key }));
    await adapter.updateAttentionStatus(a.id, 'ACKNOWLEDGED');
    await adapter.createAttentionItem(obs('r-2', { conditionKey: key }));
    expect(adapter.getAttentionItem(a.id)?.status).toBe('ACKNOWLEDGED');
    expect(rec.hubPosts).toHaveLength(1);
    const c = await adapter.createAttentionItem(obs('r-3', { conditionKey: key, priority: 'URGENT', summary: 'Tap "Yes, it\'s me" on your phone now.' }));
    expect(c.id).toBe(a.id);
    expect(c.status).toBe('OPEN');
    expect(c.priority).toBe('URGENT');
    expect(c.summary).toMatch(/phone/);
    expect(rec.hubPosts).toHaveLength(2);
  });

  it('a closed row reopens in place for a new episode (visibly); an operator WONT_DO holds it closed and silent', async () => {
    makeAdapter();
    const rec = stubApi(adapter);
    const a = await adapter.createAttentionItem(obs('standdown:latched:49701', { conditionKey: 'standdown:latched:49701' }));
    await adapter.updateAttentionStatus(a.id, 'DONE');
    expect(adapter.getAttentionItem(a.id)?.closedBy).toBe('operator');
    const b = await adapter.createAttentionItem(obs('standdown:latched:49701', { conditionKey: 'standdown:latched:49701' }));
    expect(b.status).toBe('OPEN');
    expect(b.episode).toBe(2);
    expect(b.closedBy).toBeUndefined();
    expect(rec.hubPosts).toHaveLength(2);
    await adapter.updateAttentionStatus(a.id, 'WONT_DO');
    const c = await adapter.createAttentionItem(obs('standdown:latched:49701', { conditionKey: 'standdown:latched:49701' }));
    expect(c.status).toBe('WONT_DO');
    expect(rec.hubPosts).toHaveLength(2);
  });

  it('without a producer key, the derived key collapses timestamped ids with the same title/source but keeps other topics apart', async () => {
    makeAdapter();
    stubApi(adapter);
    const held = (topic: number, ts: number) => ({ id: `telegram-origin-held:${topic}:${ts}`, title: 'A reply is held', summary: 's', category: 'telegram-origin', priority: 'NORMAL' as const, sourceContext: 'telegram-origin-forward-to-holder' });
    const a = await adapter.createAttentionItem(held(7, 1761400000000));
    const b = await adapter.createAttentionItem(held(7, 1761500000000));
    const c = await adapter.createAttentionItem(held(8, 1761500000000));
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    expect(adapter.getAttentionItems('OPEN')).toHaveLength(2);
  });

  it('enabled:false restores exact pre-feature behavior (exact-id dedupe only)', async () => {
    makeAdapter({ attentionLifecycle: { enabled: false } });
    stubApi(adapter);
    await adapter.createAttentionItem(obs('r-1', { conditionKey: 'k' }));
    await adapter.createAttentionItem(obs('r-2', { conditionKey: 'k' }));
    expect(adapter.getAttentionItems('OPEN')).toHaveLength(2);
    expect(adapter.clearAttentionCondition({ conditionKey: 'k' }, 'x')).toEqual({ closed: 0, refusedSticky: 0 });
  });

  it('clearAttentionCondition closes by key / id (incl. alias) / delimited prefix, silently, and refuses sticky + security rows', async () => {
    makeAdapter();
    const rec = stubApi(adapter);
    await adapter.createAttentionItem(obs('r-1', { conditionKey: 'subscription-relogin:acct:m1' }));
    await adapter.createAttentionItem(obs('r-2', { conditionKey: 'subscription-relogin:acct:m1' }));
    await adapter.createAttentionItem({ id: 'stale:x:ep-1', title: 'ambiguous owner', summary: 's', category: 'ownership', priority: 'NORMAL' });
    await adapter.createAttentionItem({ id: 'stale:x:ep-10', title: 'ambiguous owner again', summary: 's', category: 'ownership', priority: 'NORMAL' });
    await adapter.createAttentionItem({ id: 'sec-1', title: 'Rotate exposed GitHub access token', summary: 's', category: 'security', priority: 'HIGH' });
    await adapter.createAttentionItem({ id: 'stick-1', title: 'keep me', summary: 's', category: 'general', priority: 'NORMAL', sticky: true });
    const posts = rec.hubPosts.length;
    expect(adapter.clearAttentionCondition({ conditionKey: 'subscription-relogin:acct:m1' }, 'sign-in repaired and verified')).toEqual({ closed: 1, refusedSticky: 0 });
    const r1 = adapter.getAttentionItem('r-2')!;
    expect(r1.status).toBe('DONE');
    expect(r1.closedBy).toBe('cause-cleared');
    expect(r1.resolution).toBe('sign-in repaired and verified');
    expect(() => adapter.clearAttentionCondition({ idPrefix: 'stale:x:ep-1' }, 'x')).toThrow(/delimiter/);
    expect(adapter.clearAttentionCondition({ idPrefix: 'stale:x:ep-' }, 'owner back').closed).toBe(2);
    expect(adapter.clearAttentionCondition({ id: 'sec-1' }, 'x')).toEqual({ closed: 0, refusedSticky: 1 });
    expect(adapter.clearAttentionCondition({ id: 'stick-1' }, 'x')).toEqual({ closed: 0, refusedSticky: 1 });
    expect(adapter.getAttentionItem('sec-1')?.status).toBe('OPEN');
    expect(rec.hubPosts).toHaveLength(posts);
    const log = fs.readFileSync(path.join(tmpDir, 'logs', 'attention-lifecycle.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log.filter((e) => e.closedBy === 'cause-cleared')).toHaveLength(3);
  });

  it('the reconciliation pass supersedes legacy duplicates, applies verified clears, lists expiry on the FIRST pass and applies it on the second', async () => {
    makeAdapter();
    stubApi(adapter);
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    const young = new Date(Date.now() - 2 * DAY).toISOString();
    // Seed the store the way a pre-feature install looks: rows written straight to disk.
    const seed = [
      { id: 'telegram-origin-held:7:1761400000000', title: 'A reply is held', summary: 's', category: 'telegram-origin', priority: 'NORMAL', sourceContext: 'telegram-origin-forward-to-holder', status: 'OPEN', createdAt: old, updatedAt: old },
      { id: 'telegram-origin-held:7:1761500000000', title: 'A reply is held', summary: 's', category: 'telegram-origin', priority: 'NORMAL', sourceContext: 'telegram-origin-forward-to-holder', status: 'OPEN', createdAt: young, updatedAt: young },
      { id: 'subscription-relogin-aaaa-terminal', title: 'Claude Code sign-in repair', summary: 's', category: 'subscription-relogin', priority: 'HIGH', sourceContext: 'assisted-subscription-relogin', status: 'OPEN', createdAt: young, updatedAt: young },
      { id: 'rope-health-urgent:ep-3', title: 'rope down', summary: 's', category: 'mesh', priority: 'NORMAL', sourceContext: 'rope-health', status: 'OPEN', createdAt: old, updatedAt: old },
      { id: 'agent:ask-1', title: 'Your call: clear stale to-dos?', summary: 's', category: 'decision', priority: 'NORMAL', sourceContext: 'agent', status: 'OPEN', createdAt: old, updatedAt: old },
      { id: 'sec-1', title: 'Rotate exposed GitHub access token', summary: 's', category: 'security', priority: 'HIGH', status: 'OPEN', createdAt: old, updatedAt: old },
      { id: 'ack-1', title: 'operator is on it', summary: 's', category: 'general', priority: 'NORMAL', sourceContext: 'x', status: 'ACKNOWLEDGED', createdAt: old, updatedAt: old },
      { id: 'active-cond:ep-2', title: 'still happening', summary: 's', category: 'general', priority: 'NORMAL', sourceContext: 'stale-owner-release', status: 'OPEN', createdAt: old, updatedAt: old },
    ];
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'state', 'attention-items.json'), JSON.stringify({ items: seed }));
    await adapter.stop();
    makeAdapter({}, tmpDir);
    stubApi(adapter);
    adapter.registerAttentionConditionResolver('subscription-relogin', (item) => item.id.startsWith('subscription-relogin-') ? 'cleared' : 'unknown');
    adapter.setAttentionConditionActiveCheck((item) => item.id.startsWith('active-cond:'));

    const first = adapter.runAttentionLifecyclePass();
    expect(first.firstPass).toBe(true);
    expect(first.dryRun).toBe(true);
    expect(first.superseded).toBe(1);
    expect(first.causeCleared).toBe(1);
    expect(first.expired).toBe(0);
    // would expire: the old automated rope row + the 40-day agent question. NOT: security, ACKNOWLEDGED, active condition, the kept young held row.
    expect(first.wouldExpire).toBe(2);
    expect(adapter.getAttentionItem('telegram-origin-held:7:1761400000000')).toMatchObject({ status: 'DONE', closedBy: 'superseded' });
    expect(adapter.getAttentionItem('telegram-origin-held:7:1761500000000')).toMatchObject({ status: 'OPEN', occurrences: 2 });
    expect(adapter.getAttentionItem('subscription-relogin-aaaa-terminal')).toMatchObject({ status: 'DONE', closedBy: 'cause-cleared' });
    expect(adapter.getAttentionItem('rope-health-urgent:ep-3')?.status).toBe('OPEN');
    expect(first.actions.filter((a) => a.dryRun).map((a) => a.id).sort()).toEqual(['agent:ask-1', 'rope-health-urgent:ep-3']);

    const second = adapter.runAttentionLifecyclePass();
    expect(second.firstPass).toBe(false);
    expect(second.dryRun).toBe(false);
    expect(second.expired).toBe(2);
    expect(adapter.getAttentionItem('rope-health-urgent:ep-3')).toMatchObject({ status: 'DONE', closedBy: 'expired' });
    expect(adapter.getAttentionItem('rope-health-urgent:ep-3')?.resolution).toMatch(/expired: never confirmed cleared/);
    expect(adapter.getAttentionItem('agent:ask-1')?.resolution).toMatch(/operator did not answer within 30 days/);
    for (const id of ['sec-1', 'ack-1', 'active-cond:ep-2', 'telegram-origin-held:7:1761500000000']) {
      expect(adapter.getAttentionItem(id)?.status).not.toBe('DONE');
    }
    // Idempotent: a third pass changes nothing.
    const third = adapter.runAttentionLifecyclePass();
    expect(third).toMatchObject({ superseded: 0, causeCleared: 0, expired: 0, wouldExpire: 0 });
    const status = adapter.getAttentionLifecycleStatus();
    expect(status).toMatchObject({ enabled: true, dryRun: false, resolvers: ['subscription-relogin'] });
    expect(status.lastSweepAt).toBeTruthy();
    // Durable across a restart: aliases resolve, first-pass marker persists.
    await adapter.stop();
    makeAdapter({}, tmpDir);
    stubApi(adapter);
    // The superseded row still exists (closed) and resolves to itself; the keeper remembers it as an alias.
    expect(adapter.getAttentionItem('telegram-origin-held:7:1761400000000')).toMatchObject({ status: 'DONE', closedBy: 'superseded' });
    expect(adapter.getAttentionItem('telegram-origin-held:7:1761500000000')?.aliases).toContain('telegram-origin-held:7:1761400000000');
    expect(adapter.runAttentionLifecyclePass().firstPass).toBe(false);
  });

  it('expiry.dryRun keeps expiry listed-only on every pass; dedupe and verified clears still run', async () => {
    makeAdapter({ attentionLifecycle: { expiry: { dryRun: true } } });
    stubApi(adapter);
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'state', 'attention-items.json'), JSON.stringify({ items: [
      { id: 'x-1', title: 'old notice', summary: 's', category: 'general', priority: 'LOW', sourceContext: 'x', status: 'OPEN', createdAt: old, updatedAt: old },
    ] }));
    await adapter.stop();
    makeAdapter({ attentionLifecycle: { expiry: { dryRun: true } } }, tmpDir);
    stubApi(adapter);
    adapter.runAttentionLifecyclePass();
    const r = adapter.runAttentionLifecyclePass();
    expect(r).toMatchObject({ dryRun: true, expired: 0, wouldExpire: 1 });
    expect(adapter.getAttentionItem('x-1')?.status).toBe('OPEN');
  });
});
