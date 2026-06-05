/**
 * NOTIFICATION-FLOOD BURST INVARIANT — the fundamental "features can't ship
 * a topic flood" test (docs/STANDARDS-REGISTRY.md "Bounded Notification
 * Surface").
 *
 * Born from the THIRD topic-spam incident (2026-06-05): a boot-time detector
 * mass-flagged 110 false positives, each with a UNIQUE sourceContext — which
 * dodged the per-source budget the 2026-05-28 lockdown added. Only the
 * global ceiling caught it, after 8 individual topics leaked.
 *
 * This test pins the invariant at the real pipeline with PRODUCTION-DEFAULT
 * budgets (not test-tuned ones): no matter how many notifications a feature
 * fires in a burst, and no matter how it varies its labels, the number of
 * forum topics actually created stays under a small constant. It applies to
 * every CURRENT and FUTURE caller automatically because it exercises the
 * chokepoints themselves:
 *
 *   Layer 1 — AttentionTopicGuard at createAttentionItem (the shaper).
 *   Layer 2 — topicCreationBudget INSIDE createForumTopic (the backstop —
 *             covers callers that never go through the attention path).
 *
 * If you arrived here because this test failed your build: your feature is
 * creating topics at volume. Aggregate your notifications (one summary item,
 * not one per element) — see AgentWorktreeDetector.runDetection for the
 * canonical pattern. Raising the budgets is almost never the right fix.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { TopicFloodBudgetError, DEFAULT_ATTENTION_TOPIC_GUARD } from '../../src/messaging/AttentionTopicGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Recorder {
  forumTopicsCreated: number;
  topicTitles: string[];
}

function installApiStub(adapter: TelegramAdapter): Recorder {
  const rec: Recorder = { forumTopicsCreated: 0, topicTitles: [] };
  let threadSeq = 5000;
  vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
    .mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'createForumTopic') {
        rec.forumTopicsCreated++;
        rec.topicTitles.push(String(params.name ?? ''));
        return { message_thread_id: ++threadSeq, name: params.name };
      }
      if (method === 'sendMessage') {
        return { message_id: threadSeq * 10 + rec.forumTopicsCreated };
      }
      return { ok: true };
    });
  return rec;
}

describe('Notification-flood burst invariant (production-default budgets)', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-burst-invariant-'));
    // DELIBERATELY no guard config — this test pins the SHIPPED defaults.
    adapter = new TelegramAdapter(
      { token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100 },
      tmpDir,
    );
  });

  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'burst-invariant cleanup' });
  });

  it('1,000 LOW attention items with UNIQUE sourceContexts (the 2026-06-05 dodge) create ≤ global-budget + 1 topics', async () => {
    const rec = installApiStub(adapter);

    const N = 1000;
    for (let i = 0; i < N; i++) {
      await adapter.createAttentionItem({
        id: `burst-${i}`,
        title: `synthetic notice ${i}`,
        summary: `burst item ${i}`,
        category: 'burst-test',
        priority: 'LOW',
        // Every item its own "source" — exactly how the worktree detector
        // dodged the per-source budget in the live incident.
        sourceContext: `/some/unique/path/${i}`,
      });
    }

    // The hard bound: the attention guard's GLOBAL ceiling worth of
    // individual topics, plus exactly ONE coalesced notice topic. With
    // shipped defaults that is 8 + 1 = 9 — never 1,000.
    const bound = DEFAULT_ATTENTION_TOPIC_GUARD.maxTopicsGlobal + 1;
    expect(rec.forumTopicsCreated).toBeLessThanOrEqual(bound);
    expect(rec.topicTitles.filter((t) => t.includes('coalesced')).length).toBe(1);

    // No item dropped: every one of the 1,000 is in the attention store.
    expect(adapter.getAttentionItems().filter((a) => a.category === 'burst-test').length).toBe(N);
  });

  it('BACKSTOP: with the attention guard disabled, the createForumTopic budget still bounds the flood', async () => {
    await adapter.stop();
    adapter = new TelegramAdapter(
      {
        token: 'test-token-123',
        chatId: '-100123456',
        pollIntervalMs: 100,
        // A mis-config (or a future feature bypassing the attention path
        // entirely). The chokepoint budget is the layer that must hold.
        attentionTopicGuard: { enabled: false },
      },
      tmpDir,
    );
    const rec = installApiStub(adapter);

    const N = 500;
    for (let i = 0; i < N; i++) {
      await adapter.createAttentionItem({
        id: `nofence-${i}`,
        title: `unfenced notice ${i}`,
        summary: `s`,
        category: 'burst-test',
        priority: 'LOW',
        sourceContext: `/unique/${i}`,
      });
    }

    // All attention-item topics share the 'attention-item' budget label —
    // shipped default 8 per label. No coalesce path here (guard disabled),
    // so the budget refuses the rest; items are still stored, topic-less.
    expect(rec.forumTopicsCreated).toBeLessThanOrEqual(12); // ≤ global ceiling
    expect(adapter.getAttentionItems().filter((a) => a.category === 'burst-test').length).toBe(N);
  });

  it('BACKSTOP: 1,000 raw createForumTopic calls from a hypothetical future feature are bounded and fail loudly', async () => {
    const rec = installApiStub(adapter);

    let refused = 0;
    for (let i = 0; i < 1000; i++) {
      try {
        // No origin declared — the default ('auto') must be the budgeted one,
        // so a feature that never heard of the budget is still bounded.
        await adapter.createForumTopic(`runaway feature topic ${i}`);
      } catch (err) {
        expect(err).toBeInstanceOf(TopicFloodBudgetError);
        refused++;
      }
    }

    expect(rec.forumTopicsCreated).toBeLessThanOrEqual(8); // per-label default
    expect(refused).toBeGreaterThanOrEqual(992);
  });

  it('label variation does NOT dodge the backstop (global ceiling)', async () => {
    const rec = installApiStub(adapter);

    let refused = 0;
    for (let i = 0; i < 200; i++) {
      try {
        // Unique label per call — the per-label budget never trips, the
        // global ceiling must.
        await adapter.createForumTopic(`varied ${i}`, undefined, { label: `feature-${i}` });
      } catch (err) {
        expect(err).toBeInstanceOf(TopicFloodBudgetError);
        refused++;
      }
    }

    expect(rec.forumTopicsCreated).toBeLessThanOrEqual(12); // global default
    expect(refused).toBeGreaterThanOrEqual(188);
  });

  it('user-initiated and system topics are exempt (humans and create-once infra are self-bounded)', async () => {
    const rec = installApiStub(adapter);

    for (let i = 0; i < 30; i++) {
      await adapter.createForumTopic(`user topic ${i}`, undefined, { origin: 'user' });
    }
    for (let i = 0; i < 30; i++) {
      await adapter.createForumTopic(`system topic ${i}`, undefined, { origin: 'system' });
    }

    expect(rec.forumTopicsCreated).toBe(60); // none refused
  });

  it('HIGH/URGENT attention items always get their own topic even mid-flood (critical never coalesced, never budget-refused)', async () => {
    const rec = installApiStub(adapter);

    // Saturate both layers with LOW noise.
    for (let i = 0; i < 50; i++) {
      await adapter.createAttentionItem({
        id: `noise-${i}`, title: `noise ${i}`, summary: 's',
        category: 'burst-test', priority: 'LOW', sourceContext: `/n/${i}`,
      });
    }
    const before = rec.forumTopicsCreated;

    const urgent = await adapter.createAttentionItem({
      id: 'the-real-emergency',
      title: 'disk is on fire',
      summary: 'act now',
      category: 'burst-test',
      priority: 'URGENT',
      sourceContext: '/n/0',
    });

    expect(rec.forumTopicsCreated).toBe(before + 1); // its own topic, no refusal
    expect(urgent.topicId).toBeDefined();
    expect(urgent.coalesced).not.toBe(true);
  });
});
