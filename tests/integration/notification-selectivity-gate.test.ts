import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { NotificationSelectivityGate, verifiedJobEnvelope, verifiedReplyEnvelope } from '../../src/messaging/NotificationSelectivityGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Quiet by Default mixed production funnels', () => {
  it('records 1,000 mixed raw, monitor, job and urgent attention sends with zero transport calls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-mixed-'));
    const gate = new NotificationSelectivityGate(root, 'test', () => ({ enabled: true, dryRun: false }));
    const adapter = new TelegramAdapter({ token: '123:test', chatId: '-1001' }, root); adapter.selectivity = gate;
    const network = vi.fn(); vi.stubGlobal('fetch', network);
    try {
      for (let i = 0; i < 1000; i++) {
        if (i % 4 === 0) await adapter.createAttentionItem({ id: `attention-${i}`, title: 'Routine repair', summary: 'Automatically recovered', category: 'system', priority: 'URGENT', sourceContext: `unique-${i}` });
        else if (i % 4 === 1) await expect((adapter as any).apiCall('sendMessage', { chat_id: '-1001', message_thread_id: 42, text: `raw ${i}` })).rejects.toMatchObject({ receipt: { recorded: true } });
        else await adapter.sendToTopic(42, `routine ${i}`, { envelope: { origin: 'automated', category: i % 4 === 2 ? 'job-status' : 'agent-health', sourceContext: `producer-${i}` } });
      }
      expect(network).not.toHaveBeenCalled();
      const counts = gate.store.summarySince(0);
      expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(1000);
      expect(adapter.getTopicHistory(42, 200)).toHaveLength(0);
    } finally { vi.unstubAllGlobals(); await gate.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'quiet mixed fixture' }); }
  });
  it('sends one opted-in job through the adapter while another job and a forged slug stay quiet', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-job-'));
    const gate = new NotificationSelectivityGate(root, 'test', () => ({ enabled: true, dryRun: false, push: { jobs: { 'instar2-checkin': true } } }));
    const adapter = new TelegramAdapter({ token: '123:test', chatId: '-1001' }, root); adapter.selectivity = gate;
    const network = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 77, date: 1, chat: { id: -1001 } } }), { status: 200 })); vi.stubGlobal('fetch', network);
    try {
      const quiet = await adapter.sendToTopic(42, 'other job', { envelope: verifiedJobEnvelope('bugs-overseer') });
      const forged = await adapter.sendToTopic(42, 'forged', { envelope: { origin: 'automated', category: 'job-status', sourceContext: 'instar2-checkin', verifiedJobSlug: 'instar2-checkin' } });
      expect(quiet).toMatchObject({ recorded: true }); expect(forged).toMatchObject({ recorded: true });
      expect(network).not.toHaveBeenCalled();
      const sent = await adapter.sendToTopic(42, 'the check-in', { envelope: verifiedJobEnvelope('instar2-checkin') });
      expect(sent).toMatchObject({ messageId: 77 });
      expect(network).toHaveBeenCalledOnce();
      expect(gate.store.summarySince(0)['job-status']).toBe(3);
    } finally { vi.unstubAllGlobals(); await gate.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'quiet job fixture' }); }
  });
  it('bounds an opted-in 500-event storm and preserves a late verified reply', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-optin-'));
    const gate = new NotificationSelectivityGate(root, 'test', () => ({ enabled: true, dryRun: false, push: { categories: { 'job-status': true } } }));
    try {
      const decisions = await Promise.all(Array.from({ length: 500 }, (_, i) => gate.route(42, `status ${i}`, { origin: 'automated', category: 'job-status', sourceContext: 'job' })));
      expect(decisions.filter(row => row.verdict.decision === 'deliver-push')).toHaveLength(3);
      expect(decisions.filter(row => row.receipt?.recorded)).toHaveLength(497);
      expect((await gate.route(42, 'The requested work is complete', verifiedReplyEnvelope('trusted-reply'))).verdict.decision).toBe('deliver');
    } finally { await gate.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'quiet optin fixture' }); }
  });
});
