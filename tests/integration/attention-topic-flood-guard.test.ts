/**
 * Tier-2 integration test for the topic-flood circuit breaker (2026-05-28
 * lockdown) — exercises the REAL TelegramAdapter.createAttentionItem with the
 * Telegram HTTP layer (apiCall) stubbed, so we observe exactly how many forum
 * topics a flooding source spawns.
 *
 * This is the regression for the live incident: CollaborationRedriveEngine
 * raised one "can't reach <peer>" attention item per failed sweep, and each
 * createAttentionItem spawned a brand-new forum topic → a wall of topics. The
 * guard caps per-item topics per source and coalesces the rest into one notice
 * topic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Recorder {
  forumTopicsCreated: number;
  topicTitles: string[];
}

function installApiStub(adapter: TelegramAdapter): Recorder {
  const rec: Recorder = { forumTopicsCreated: 0, topicTitles: [] };
  let threadSeq = 1000;
  // Spy on the private HTTP funnel. createForumTopic() and sendMessage()/
  // sendToTopic() all route through apiCall, so this is the single seam.
  vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
    .mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'createForumTopic') {
        rec.forumTopicsCreated++;
        rec.topicTitles.push(String(params.name ?? ''));
        return { message_thread_id: ++threadSeq, name: params.name };
      }
      if (method === 'sendMessage') {
        return { message_id: Math.floor(threadSeq * 10 + Math.random() * 9) };
      }
      return { ok: true };
    });
  return rec;
}

describe('Attention topic-flood guard (integration with real TelegramAdapter)', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-flood-guard-test-'));
    adapter = new TelegramAdapter(
      {
        token: 'test-token-123',
        chatId: '-100123456',
        pollIntervalMs: 100,
        // Tight per-source budget so the test is fast and deterministic; large
        // window + generous global ceiling so these per-source tests aren't
        // perturbed by the global cap (the global cap has its own unit coverage).
        attentionTopicGuard: { enabled: true, windowMs: 60 * 60 * 1000, maxTopicsPerSource: 3, maxTopicsGlobal: 500, maxTrackedSources: 1000 },
      },
      tmpDir,
    );
  });

  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'attention-topic-flood-guard cleanup' });
  });

  it('caps per-item topics for one flooding source and coalesces the rest into ONE notice topic', async () => {
    const rec = installApiStub(adapter);

    const N = 12;
    const items = [];
    for (let i = 0; i < N; i++) {
      items.push(await adapter.createAttentionItem({
        id: `collab-redrive-${i}`,
        title: `can't reach peer-${i} — unknown routing`,
        summary: `nudge attempt for peer-${i}`,
        category: 'collaboration-redrive',
        priority: 'NORMAL',
        sourceContext: 'collaboration-redrive',
      }));
    }

    // 3 per-item topics (the budget) + exactly 1 coalesced notice topic = 4.
    // NOT 12 (the pre-fix flood).
    expect(rec.forumTopicsCreated).toBe(4);
    expect(rec.topicTitles.filter(t => t.includes('coalesced')).length).toBe(1);

    // No item is dropped — all 12 are recorded in the attention store.
    const all = adapter.getAttentionItems();
    expect(all.filter(a => a.sourceContext === 'collaboration-redrive').length).toBe(N);

    // The coalesced items (4..11) all share the single reused notice topic,
    // and are flagged coalesced (so they don't corrupt the per-item topic maps).
    const coalescedTopicIds = new Set(items.slice(3).map(a => a.topicId));
    expect(coalescedTopicIds.size).toBe(1);
    expect(items.slice(3).every(a => a.coalesced === true)).toBe(true);
    expect(items.slice(0, 3).every(a => !a.coalesced)).toBe(true);

    // The suppression audit trail captured the housekeeping detail.
    const auditPath = path.join(tmpDir, 'state', 'attention-suppressed.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);
    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(N - 3); // 9 suppressed
  });

  it('a HIGH-priority item from the SAME flooding source still gets its own topic (critical never coalesced)', async () => {
    const rec = installApiStub(adapter);

    // Saturate the NORMAL budget for the source.
    for (let i = 0; i < 6; i++) {
      await adapter.createAttentionItem({
        id: `noise-${i}`, title: `noise ${i}`, summary: 's',
        category: 'svc', priority: 'NORMAL', sourceContext: 'svc',
      });
    }
    const topicsBefore = rec.forumTopicsCreated;

    const critical = await adapter.createAttentionItem({
      id: 'crit-1', title: 'real escalation', summary: 'user must see this',
      category: 'svc', priority: 'HIGH', sourceContext: 'svc',
    });

    // The HIGH item created a NEW dedicated topic of its own.
    expect(rec.forumTopicsCreated).toBe(topicsBefore + 1);
    expect(typeof critical.topicId).toBe('number');
    // And it is NOT the coalesced notice topic.
    const noticeTitle = rec.topicTitles.find(t => t.includes('coalesced'));
    expect(noticeTitle).toBeDefined();
    expect(rec.topicTitles[rec.topicTitles.length - 1]).toContain('real escalation');
  });

  it('a DIFFERENT source is unaffected by another source flooding', async () => {
    const rec = installApiStub(adapter);
    for (let i = 0; i < 8; i++) {
      await adapter.createAttentionItem({
        id: `flood-${i}`, title: `flood ${i}`, summary: 's',
        category: 'noisy', priority: 'NORMAL', sourceContext: 'noisy',
      });
    }
    const before = rec.forumTopicsCreated;
    const calm = await adapter.createAttentionItem({
      id: 'calm-1', title: 'a single legit item', summary: 's',
      category: 'quiet', priority: 'NORMAL', sourceContext: 'quiet',
    });
    expect(rec.forumTopicsCreated).toBe(before + 1);
    expect(typeof calm.topicId).toBe('number');
  });

  it('concurrent coalesced items for one source create exactly ONE notice topic (no double-create race)', async () => {
    const rec = installApiStub(adapter);
    // Burn the budget so everything after coalesces.
    for (let i = 0; i < 3; i++) {
      await adapter.createAttentionItem({
        id: `seed-${i}`, title: `seed ${i}`, summary: 's',
        category: 'racey', priority: 'NORMAL', sourceContext: 'racey',
      });
    }
    const ownTopics = rec.forumTopicsCreated; // 3 per-item topics
    // Fire many coalesced items for the SAME source concurrently — they must
    // share ONE in-flight notice-topic creation, not each create their own.
    const items = await Promise.all(
      Array.from({ length: 10 }, (_, i) => adapter.createAttentionItem({
        id: `race-${i}`, title: `race ${i}`, summary: 's',
        category: 'racey', priority: 'NORMAL', sourceContext: 'racey',
      })),
    );
    // Exactly one notice topic across all concurrent coalesced items.
    expect(rec.forumTopicsCreated).toBe(ownTopics + 1);
    expect(rec.topicTitles.filter(t => t.includes('coalesced')).length).toBe(1);
    expect(new Set(items.map(a => a.topicId)).size).toBe(1);
  });
});
