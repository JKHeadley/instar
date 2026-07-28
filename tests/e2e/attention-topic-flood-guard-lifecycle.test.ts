/**
 * Tier-3 lifecycle test for attention-alert topic behavior at FLEET defaults.
 *
 * The single most important question for the FLEET: an already-deployed agent
 * that auto-updates to this version and NEVER touches its config — what happens
 * to its alerts? Since 2026-07-09 (operator directive, topic 11960) the answer
 * is SINGLE-TOPIC ROUTING: every attention item, all priorities included, posts
 * into the ONE durable "🔔 Attention" hub topic; per-item topics are never
 * spawned. This is a code default — no config, no migration — so this test
 * constructs the adapter exactly as a stock production config would (token +
 * chatId ONLY) and proves the flood surface is ONE topic, not a wall.
 *
 * The 2026-05-28 flood-guard lockdown remains load-bearing for agents that
 * deliberately opt back into per-item topics (`attentionRouting.mode:
 * 'per-item'`) — the second block proves that legacy path is still capped,
 * with zero further config, exactly as it protected the fleet through the
 * 2026-05-22 / 2026-05-28 / 2026-06-05 floods.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { DEFAULT_ATTENTION_TOPIC_GUARD } from '../../src/messaging/AttentionTopicGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Recorder {
  forumTopicsCreated: number;
  topicTitles: string[];
  coalescedTopics: number;
}

function installApiStub(adapter: TelegramAdapter): Recorder {
  const rec: Recorder = { forumTopicsCreated: 0, topicTitles: [], coalescedTopics: 0 };
  let seq = 5000;
  vi.spyOn(
    adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> },
    'apiCall',
  ).mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'createForumTopic') {
      rec.forumTopicsCreated++;
      rec.topicTitles.push(String(params.name ?? ''));
      if (String(params.name ?? '').includes('coalesced')) rec.coalescedTopics++;
      return { message_thread_id: ++seq, name: params.name };
    }
    if (method === 'sendMessage') return { message_id: ++seq };
    return { ok: true };
  });
  return rec;
}

describe('Attention alerts — fleet default (no config) lifecycle', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-flood-e2e-'));
    // Stock production config: token + chatId ONLY. No attentionRouting key,
    // no attentionTopicGuard key — exactly what an existing fleet agent has
    // after a silent dist update.
    adapter = new TelegramAdapter({ token: 't', chatId: '-100999' }, tmpDir);
  });

  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'flood-guard-e2e cleanup' });
  });

  it('routes a slow-drip AND a burst of alerts into ONE hub topic, with NO config', async () => {
    const rec = installApiStub(adapter);
    const N = 40;
    const priorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

    for (let i = 0; i < N; i++) {
      await adapter.createAttentionItem({
        id: `alert-${i}`,
        title: `alert ${i}`,
        summary: 'an ownerless notice',
        category: 'general',
        priority: priorities[i % priorities.length],
        // Distinct sources — the slow-drip shape (rope-recovery-probe,
        // credential-repointing, …) that accumulated ~317 junk topics because
        // hours-apart items never trip a burst budget.
        sourceContext: `slow-drip-source-${i}`,
      });
    }

    // The 2026-07-09 bound: ONE topic — the self-healed "🔔 Attention" hub —
    // no matter the volume, cadence, source labels, or priority.
    expect(rec.forumTopicsCreated).toBe(1);
    expect(rec.topicTitles[0]).toContain('Attention');
    // Every item is durably recorded and points at the hub.
    const items = adapter.getAttentionItems();
    expect(items.length).toBe(N);
    expect(new Set(items.map(a => a.topicId)).size).toBe(1);
    expect(items.every(a => a.coalesced === true)).toBe(true);
  });

  it('LEGACY opt-out (attentionRouting.mode per-item): the 2026-05-28 flood guard still caps a flooding source', async () => {
    await adapter.stop();
    // The ONLY config a legacy-mode agent needs — the guard itself still ships
    // enabled by default in code.
    adapter = new TelegramAdapter(
      { token: 't', chatId: '-100999', attentionRouting: { mode: 'per-item' } },
      tmpDir,
    );
    const rec = installApiStub(adapter);

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
    // coalesced notice topic, regardless of how many items arrived (pre-fix
    // this was FLOOD topics). A single flooding source's per-source cap fires
    // before the global cap, so it coalesces under its own bucket.
    expect(rec.forumTopicsCreated).toBe(budget + 1);
    expect(rec.coalescedTopics).toBe(1);

    // Every item is still durably recorded — nothing dropped — and everything
    // past the budget is flagged coalesced.
    const items = adapter.getAttentionItems();
    expect(items.length).toBe(FLOOD);
    expect(items.filter(a => a.coalesced).length).toBe(FLOOD - budget);
  });
});
