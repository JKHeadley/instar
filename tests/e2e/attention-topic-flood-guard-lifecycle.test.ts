/**
 * Tier-3 lifecycle test for the topic-flood circuit breaker (2026-05-28
 * lockdown).
 *
 * The single most important question for the FLEET: an already-deployed agent
 * that auto-updates to this version and NEVER touches its config — does it get
 * the flood protection? The guard ships ENABLED by default and is constructed
 * unconditionally inside TelegramAdapter, so the answer must be yes with zero
 * config. This test constructs the adapter exactly as a stock production config
 * would (NO `attentionTopicGuard` key) and proves a flooding source is capped.
 *
 * This is the migration-parity guarantee in test form: the previous two floods
 * (2026-05-22 sentinels, 2026-05-28 collaboration-redrive) both reached users
 * who had no special config — so the fix must protect them with no special
 * config too.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { DEFAULT_ATTENTION_TOPIC_GUARD } from '../../src/messaging/AttentionTopicGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Topic-flood guard — fleet default (no config) lifecycle', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;
  let forumTopicsCreated: number;
  let coalescedTopics: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-flood-e2e-'));
    // Stock production config: token + chatId ONLY. No attentionTopicGuard key —
    // exactly what an existing fleet agent has after a silent dist update.
    adapter = new TelegramAdapter({ token: 't', chatId: '-100999' }, tmpDir);

    forumTopicsCreated = 0;
    coalescedTopics = 0;
    let seq = 5000;
    vi.spyOn(
      adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> },
      'apiCall',
    ).mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'createForumTopic') {
        forumTopicsCreated++;
        if (String(params.name ?? '').includes('coalesced')) coalescedTopics++;
        return { message_thread_id: ++seq, name: params.name };
      }
      if (method === 'sendMessage') return { message_id: ++seq };
      return { ok: true };
    });
  });

  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'flood-guard-e2e cleanup' });
  });

  it('caps a flooding source at the default budget + one coalesced notice, with NO config', async () => {
    const budget = DEFAULT_ATTENTION_TOPIC_GUARD.maxTopicsPerSource;
    const FLOOD = budget + 25;

    for (let i = 0; i < FLOOD; i++) {
      await adapter.createAttentionItem({
        id: `collab-redrive-${i}`,
        title: `can't reach peer-${i} — unknown routing`,
        summary: 'housekeeping nudge failure',
        category: 'collaboration-redrive',
        priority: 'NORMAL',
        sourceContext: 'collaboration-redrive',
      });
    }

    // The flood is bounded EXACTLY: `budget` per-item topics + exactly ONE
    // coalesced notice topic, regardless of how many items arrived (pre-fix this
    // was FLOOD topics). A single flooding source's per-source cap fires before
    // the global cap, so it coalesces under its own bucket.
    expect(forumTopicsCreated).toBe(budget + 1);
    expect(coalescedTopics).toBe(1);

    // Every item is still durably recorded — nothing dropped — and everything
    // past the budget is flagged coalesced.
    const items = adapter.getAttentionItems();
    expect(items.length).toBe(FLOOD);
    expect(items.filter(a => a.coalesced).length).toBe(FLOOD - budget);
  });
});
