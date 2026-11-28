/**
 * CMT-2078 step 3: the item the never-silent fallback raises really lands on the Needs-you list.
 * Uses the real TelegramAdapter attention store (record only, no Telegram post) and the console's
 * own Needs model, so the `source: 'agent'` admission and the visible text are both proven.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LocalAttentionItems } from '../../src/core/LocalAttentionItems.js';
import { neverSilentNeedItem } from '../../src/monitoring/neverSilent/neverSilentWiring.js';
import { needId } from '../../src/monitoring/neverSilent/NeverSilentWatcher.js';
// @ts-expect-error Console runs as native ESM in the browser.
import { buildNeeds, needsOperator } from '../../dashboard/console/home-model.js';

describe('never-silent Needs-you item', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;
  const calls: string[] = [];
  function make(): TelegramAdapter {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-needs-'));
    adapter = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, attentionHubFilter: 'all', getAttentionHubTopicId: () => 4242 }, tmpDir);
    vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
      .mockImplementation(async (method) => { calls.push(method); return { ok: true, message_id: 1, message_thread_id: 9999 }; });
    return adapter;
  }
  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    calls.length = 0;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'never-silent needs test cleanup' });
  });
  const need = (topic: string, over = {}) => ({ id: needId(`nsi-${topic.padStart(12, '0')}`, 'waiting' as const), platform: 'telegram' as const, conversationKey: topic, kind: 'waiting' as const, tries: 3, reason: 'no-adapter', ...over });

  it('is stored open without a Telegram post, and the Needs-you list shows it with its conversation', async () => {
    make();
    await adapter.createAttentionItem(neverSilentNeedItem(need('145738')), { recordOnly: true });
    expect(calls).toEqual([]);
    const open = adapter.getAttentionItems('OPEN');
    expect(open).toHaveLength(1);
    expect(needsOperator(open[0])).toBe(true);
    const card = buildNeeds({ ok: true, data: { items: open } }, Date.now());
    const row = (card.all as Array<{ main: string; detail: string }>)[0];
    expect(row.main).toContain('topic 145738');
    expect(row.detail).toContain('topic 145738');
    expect(row.detail).toContain('had no connection to that chat service');
    expect(row.detail).not.toContain('no-adapter');
  });

  it('two waiting conversations are two rows, not one grouped row', async () => {
    make();
    await adapter.createAttentionItem(neverSilentNeedItem(need('145738')), { recordOnly: true });
    await adapter.createAttentionItem(neverSilentNeedItem(need('141385')), { recordOnly: true });
    const card = buildNeeds({ ok: true, data: { items: adapter.getAttentionItems('OPEN') } }, Date.now());
    expect((card.all as unknown[]).length).toBe(2);
  });

  it('closes, and a later failure streak reopens the same row', async () => {
    make();
    const item = neverSilentNeedItem(need('145738'));
    await adapter.createAttentionItem(item, { recordOnly: true });
    expect(await adapter.updateAttentionStatus(item.id, 'DONE', { silent: true, closedBy: 'cause-cleared' })).toBe(true);
    expect(adapter.getAttentionItems('OPEN')).toHaveLength(0);
    await adapter.createAttentionItem(item, { recordOnly: true });
    expect(adapter.getAttentionItems('OPEN').map((i) => i.id)).toEqual([item.id]);
    expect(calls).toEqual([]);
  });

  it('a thrown send and an unknown label read as plain words', () => {
    expect(neverSilentNeedItem(need('145738', { reason: 'threw:TypeError' })).description).toContain('the send failed with an error');
    expect(neverSilentNeedItem(need('145738', { platform: 'slack', conversationKey: 'C123' })).title).toContain('Slack conversation C123');
  });

  it('with no Telegram, the local attention list carries it to the Needs-you list, closes it and reopens it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-needs-local-'));
    try {
      const local = new LocalAttentionItems(dir);
      const item = neverSilentNeedItem(need('145738', { platform: 'slack', conversationKey: 'C0123' }));
      expect(local.raise(item)).toBe(true);
      const open = local.list('OPEN');
      expect(open.map((i) => i.id)).toEqual([item.id]);
      expect(needsOperator(open[0])).toBe(true);
      const row = (buildNeeds({ ok: true, data: { items: open } }, Date.now()).all as Array<{ main: string }>)[0];
      expect(row.main).toContain('Slack conversation C0123');
      // A second instance on the same folder (the agent server's own) sees and closes the same row.
      expect(new LocalAttentionItems(dir).setStatus(item.id, 'DONE', 'cleared')?.status).toBe('DONE');
      expect(local.list('OPEN')).toHaveLength(0);
      expect(local.raise(item)).toBe(true);
      expect(local.list('OPEN').map((i) => i.id)).toEqual([item.id]);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'never-silent local needs test cleanup' });
    }
  });
});
