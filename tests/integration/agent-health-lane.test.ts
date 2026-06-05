/**
 * Tier-2 integration test for the calm "🩺 Agent Health" lane — exercises the
 * REAL TelegramAdapter.createAttentionItem with the Telegram HTTP layer (apiCall)
 * stubbed, so we observe exactly how many forum topics self-health notices spawn.
 *
 * Regression for the 2026-06-04 incident: StaleSessionBackstop raised one HIGH
 * "Session topic-X is stale but unkillable" attention item per stall episode, and
 * because HIGH bypasses the flood guard, each spawned a brand-new forum topic → a
 * wall of "stale but unkillable" topics. The lane routes self-health notices into
 * ONE named topic from the first item, regardless of priority, and suppression-
 * dedups same-entity re-escalations.
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
  messagesByThread: Map<number, number>;
}

function installApiStub(adapter: TelegramAdapter): Recorder {
  const rec: Recorder = { forumTopicsCreated: 0, topicTitles: [], messagesByThread: new Map() };
  let threadSeq = 2000;
  vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
    .mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'createForumTopic') {
        rec.forumTopicsCreated++;
        rec.topicTitles.push(String(params.name ?? ''));
        return { message_thread_id: ++threadSeq, name: params.name };
      }
      if (method === 'sendMessage') {
        const tid = typeof params.message_thread_id === 'number' ? params.message_thread_id : 0;
        rec.messagesByThread.set(tid, (rec.messagesByThread.get(tid) ?? 0) + 1);
        return { message_id: Math.floor(threadSeq * 10 + 1) };
      }
      return { ok: true };
    });
  return rec;
}

describe('Agent-Health lane (integration with real TelegramAdapter)', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-agent-health-lane-'));
    adapter = new TelegramAdapter(
      { token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100 },
      tmpDir,
    );
  });

  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'agent-health-lane cleanup' });
  });

  it('routes N self-health notices into exactly ONE named lane topic (never topic-after-topic)', async () => {
    const rec = installApiStub(adapter);

    const N = 8;
    const items = [];
    for (let i = 0; i < N; i++) {
      items.push(await adapter.createAttentionItem({
        id: `stale-sess-${i}-1`,
        healthKey: `stale-sess-${i}`,         // distinct entities → all post, none suppressed
        lane: 'agent-health',
        title: `Heads-up on the "Session ${i}" session`,
        summary: `It hasn't shown progress. Reply "check Session ${i}".`,
        category: 'degradation',
        priority: 'NORMAL',
      }));
    }

    // Exactly ONE forum topic for all N notices — the lane — not N.
    expect(rec.forumTopicsCreated).toBe(1);
    expect(rec.topicTitles[0]).toContain('Agent Health');
    // Every item shares the one lane topic and is flagged coalesced.
    const laneTopicIds = new Set(items.map(a => a.topicId));
    expect(laneTopicIds.size).toBe(1);
    expect(items.every(a => a.coalesced === true)).toBe(true);
    // No item dropped — all recorded in the store.
    expect(adapter.getAttentionItems().filter(a => a.lane === 'agent-health').length).toBe(N);
  });

  it('a HIGH-priority self-health notice STILL goes to the lane (never its own topic)', async () => {
    const rec = installApiStub(adapter);
    const item = await adapter.createAttentionItem({
      id: 'stale-x-1', healthKey: 'stale-x', lane: 'agent-health',
      title: 'Heads-up on the "X" session', summary: 'maybe stuck. Reply "check X".',
      category: 'degradation', priority: 'HIGH',   // mis-tagged HIGH — lane wins
    });
    expect(rec.forumTopicsCreated).toBe(1);
    expect(rec.topicTitles[0]).toContain('Agent Health');
    expect(item.coalesced).toBe(true);
  });

  it('suppression-dedup: same healthKey re-escalating within the window does NOT repost', async () => {
    const rec = installApiStub(adapter);
    const laneOf = async (episode: number) => adapter.createAttentionItem({
      id: `stale-dup-${episode}`, healthKey: 'stale-dup', lane: 'agent-health',
      title: 'Heads-up on the "Dup" session', summary: 'still maybe stuck. Reply "check Dup".',
      category: 'degradation', priority: 'NORMAL',
    });
    await laneOf(1);
    await laneOf(2);
    await laneOf(3);
    const laneThread = Array.from(rec.messagesByThread.keys()).find(t => t !== 0)!;
    // One lane topic; the intro + exactly ONE notice line (episodes 2 & 3 suppressed).
    expect(rec.forumTopicsCreated).toBe(1);
    expect(rec.messagesByThread.get(laneThread)).toBe(2); // intro + 1 notice
    // The suppressed episodes are still in the store + audit trail.
    expect(adapter.getAttentionItems().filter(a => a.healthKey === 'stale-dup').length).toBe(3);
    const auditPath = path.join(tmpDir, 'state', 'attention-suppressed.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);
    expect(fs.readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).length).toBe(2);
  });

  it('a normal (non-lane) attention item is unaffected — still gets its own topic', async () => {
    const rec = installApiStub(adapter);
    const normal = await adapter.createAttentionItem({
      id: 'user-facing-1', title: 'A real user escalation', summary: 'please look',
      category: 'general', priority: 'HIGH', sourceContext: 'user',
    });
    expect(rec.forumTopicsCreated).toBe(1);
    expect(rec.topicTitles[0]).not.toContain('Agent Health');
    expect(normal.coalesced).toBeUndefined();
    expect(typeof normal.topicId).toBe('number');
  });
});
