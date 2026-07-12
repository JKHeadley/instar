/**
 * Tier-1 unit tests for single-alerts-topic attention routing (2026-07-09
 * operator directive, topic 11960: "Alerts should all go into a SINGLE topic
 * with a dedicated name that is for alerts and NOTHING else").
 *
 * The DEFAULT `attentionRouting.mode` is 'single-topic': every attention item
 * — all priorities, HIGH/URGENT included — posts as one message into the
 * durable "🔔 Attention" hub topic and NEVER spawns a per-item forum topic.
 * The pre-flip behavior survives only behind the explicit 'per-item' legacy
 * opt-out. Exercises the REAL TelegramAdapter with the HTTP layer (apiCall)
 * stubbed.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter, type TelegramConfig, attentionBodyBlocks } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Recorder {
  forumTopicsCreated: number;
  topicTitles: string[];
  messagesByThread: Map<number, string[]>;
  /** Full sendMessage params per thread — lets tests assert parse_mode/_formatMode. */
  sendParamsByThread: Map<number, Array<Record<string, unknown>>>;
  closedTopics: number[];
  failSendToThread: number | null;
}

function installApiStub(adapter: TelegramAdapter): Recorder {
  const rec: Recorder = {
    forumTopicsCreated: 0,
    topicTitles: [],
    messagesByThread: new Map(),
    sendParamsByThread: new Map(),
    closedTopics: [],
    failSendToThread: null,
  };
  let threadSeq = 7000;
  vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
    .mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'createForumTopic') {
        rec.forumTopicsCreated++;
        rec.topicTitles.push(String(params.name ?? ''));
        return { message_thread_id: ++threadSeq, name: params.name };
      }
      if (method === 'sendMessage') {
        const tid = typeof params.message_thread_id === 'number' ? params.message_thread_id : 0;
        if (rec.failSendToThread !== null && tid === rec.failSendToThread) {
          throw new Error('Bad Request: message thread not found');
        }
        const texts = rec.messagesByThread.get(tid) ?? [];
        texts.push(String(params.text ?? ''));
        rec.messagesByThread.set(tid, texts);
        const allParams = rec.sendParamsByThread.get(tid) ?? [];
        allParams.push({ ...params });
        rec.sendParamsByThread.set(tid, allParams);
        return { message_id: threadSeq * 10 + texts.length };
      }
      if (method === 'closeForumTopic') {
        rec.closedTopics.push(Number(params.message_thread_id));
        return { ok: true };
      }
      return { ok: true };
    });
  return rec;
}

describe('Single-alerts-topic routing (default mode)', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  function makeAdapter(config: Partial<TelegramConfig> = {}): TelegramAdapter {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-single-topic-'));
    adapter = new TelegramAdapter(
      { token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, ...config },
      tmpDir,
    );
    return adapter;
  }

  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'single-topic-routing cleanup' });
  });

  it('EVERY priority — LOW through URGENT — posts into the injected hub with ZERO forum topics created', async () => {
    const HUB = 777;
    makeAdapter({ getAttentionHubTopicId: () => HUB });
    const rec = installApiStub(adapter);

    const priorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
    const items = [];
    for (const priority of priorities) {
      items.push(await adapter.createAttentionItem({
        id: `hub-${priority}`,
        title: `${priority} alert`,
        summary: `an alert with priority ${priority}`,
        category: 'general',
        priority,
        sourceContext: `source-${priority}`,
      }));
    }

    expect(rec.forumTopicsCreated).toBe(0);
    expect(rec.messagesByThread.get(HUB)?.length).toBe(priorities.length);
    expect(items.every(a => a.topicId === HUB)).toBe(true);
    expect(items.every(a => a.coalesced === true)).toBe(true);
    expect(adapter.getAttentionItems().length).toBe(priorities.length);
  });

  it('the hub message carries title, category | priority, summary, clipped description, and source', async () => {
    const HUB = 778;
    makeAdapter({ getAttentionHubTopicId: () => HUB });
    const rec = installApiStub(adapter);

    await adapter.createAttentionItem({
      id: 'hub-detail',
      title: 'A real <escalation>',
      summary: 'please look',
      description: 'x'.repeat(900),
      category: 'general',
      priority: 'HIGH',
      sourceContext: 'rope-recovery-probe',
    });

    const [msg] = rec.messagesByThread.get(HUB)!;
    expect(msg).toContain('<b>A real &lt;escalation&gt;</b>');
    expect(msg).toContain('general | Priority: HIGH');
    expect(msg).toContain('please look');
    expect(msg).toContain('x'.repeat(500));
    expect(msg).not.toContain('x'.repeat(501));
    expect(msg).toContain('<i>Source: rope-recovery-probe</i>');
  });

  it('the hub post rides parse_mode HTML + _formatMode html (the 2026-07-11 literal-tag fix)', async () => {
    const HUB = 781;
    makeAdapter({ getAttentionHubTopicId: () => HUB });
    const rec = installApiStub(adapter);

    await adapter.createAttentionItem({
      id: 'hub-html-mode',
      title: 'Machine coherence: my machines have drifted apart',
      summary: 'drift summary',
      category: 'machine-coherence',
      priority: 'HIGH',
      sourceContext: 'machine-coherence-guard',
    });

    const [params] = rec.sendParamsByThread.get(HUB)!;
    // Without these two the default markdown formatter escapes the authored
    // <b>/<i> tags and the user sees them as literal text in Telegram.
    expect(params.parse_mode).toBe('HTML');
    expect(params._formatMode).toBe('html');
  });

  it('a description that begins with the summary renders the paragraph ONCE (the 2026-07-11 duplication fix)', async () => {
    const HUB = 782;
    makeAdapter({ getAttentionHubTopicId: () => HUB });
    const rec = installApiStub(adapter);

    const summary = 'My machines have drifted apart — Mac Mini and Laptop aren\'t running as the same me.';
    await adapter.createAttentionItem({
      id: 'hub-dedupe',
      title: 'Machine coherence',
      summary,
      // Episode renderers build description as `${summary}\n\n${fix}\n\n${tech}`.
      description: `${summary}\n\nReply fix it and I will align them.\n\nTechnical detail:\nversion · instarVersion`,
      category: 'machine-coherence',
      priority: 'HIGH',
    });

    const [msg] = rec.messagesByThread.get(HUB)!;
    const occurrences = msg.split('drifted apart').length - 1;
    expect(occurrences).toBe(1); // summary paragraph exactly once
    expect(msg).toContain('Reply fix it'); // the description tail still renders
    expect(msg).toContain('Technical detail:');
  });

  it('a description that does NOT begin with the summary still renders both blocks', async () => {
    const HUB = 783;
    makeAdapter({ getAttentionHubTopicId: () => HUB });
    const rec = installApiStub(adapter);

    await adapter.createAttentionItem({
      id: 'hub-both-blocks',
      title: 'T',
      summary: 'short impact line',
      description: 'a longer independent explanation',
      category: 'general',
      priority: 'NORMAL',
    });

    const [msg] = rec.messagesByThread.get(HUB)!;
    expect(msg).toContain('short impact line');
    expect(msg).toContain('a longer independent explanation');
  });

  it('resolving a hub-routed item NEVER closes the shared hub topic', async () => {
    const HUB = 779;
    makeAdapter({ getAttentionHubTopicId: () => HUB });
    const rec = installApiStub(adapter);

    await adapter.createAttentionItem({
      id: 'hub-resolve', title: 'resolve me', summary: 's',
      category: 'general', priority: 'URGENT',
    });
    const updated = await adapter.updateAttentionStatus('hub-resolve', 'DONE');

    expect(updated).toBe(true);
    expect(adapter.getAttentionItem('hub-resolve')!.status).toBe('DONE');
    expect(rec.closedTopics).toEqual([]);
    expect(adapter.isAttentionTopic(HUB)).toBe(false);
  });

  it('SELF-HEAL: with no injected hub id, the hub is found-or-created ONCE and reused for N items — never a per-item topic', async () => {
    makeAdapter();
    const rec = installApiStub(adapter);

    const N = 6;
    const items = [];
    for (let i = 0; i < N; i++) {
      items.push(await adapter.createAttentionItem({
        id: `heal-${i}`, title: `alert ${i}`, summary: 's',
        category: 'general', priority: i % 2 === 0 ? 'HIGH' : 'LOW',
        sourceContext: `/unique/source/${i}`,
      }));
    }

    expect(rec.forumTopicsCreated).toBe(1);
    expect(rec.topicTitles[0]).toContain('Attention');
    const hubIds = new Set(items.map(a => a.topicId));
    expect(hubIds.size).toBe(1);
    expect(items.every(a => a.coalesced === true)).toBe(true);
  });

  it('SELF-HEAL: when the injected hub send fails (deleted hub), routing falls back to a found-or-created hub — never a per-item topic', async () => {
    const DEAD_HUB = 666;
    makeAdapter({ getAttentionHubTopicId: () => DEAD_HUB });
    const rec = installApiStub(adapter);
    rec.failSendToThread = DEAD_HUB;

    const item = await adapter.createAttentionItem({
      id: 'heal-dead-hub', title: 'still delivered', summary: 's',
      category: 'general', priority: 'HIGH',
    });

    expect(rec.forumTopicsCreated).toBe(1);
    expect(rec.topicTitles[0]).toContain('Attention');
    expect(item.topicId).not.toBe(DEAD_HUB);
    expect(typeof item.topicId).toBe('number');
    expect(item.coalesced).toBe(true);
    const healedThread = item.topicId!;
    expect(rec.messagesByThread.get(healedThread)?.length).toBe(1);
  });

  it('an agent-health-lane item STILL routes to the lane topic, not the hub', async () => {
    const HUB = 780;
    makeAdapter({ getAttentionHubTopicId: () => HUB });
    const rec = installApiStub(adapter);

    const item = await adapter.createAttentionItem({
      id: 'lane-1', healthKey: 'lane-entity', lane: 'agent-health',
      title: 'Heads-up on the "X" session', summary: 'maybe stuck',
      category: 'degradation', priority: 'HIGH',
    });

    expect(rec.forumTopicsCreated).toBe(1);
    expect(rec.topicTitles[0]).toContain('Agent Health');
    expect(item.topicId).not.toBe(HUB);
    expect(rec.messagesByThread.get(HUB)).toBeUndefined();
  });

  it("LEGACY 'per-item' mode preserves the pre-flip behavior: own topic, registered maps, /done closes it", async () => {
    makeAdapter({ attentionRouting: { mode: 'per-item' } });
    const rec = installApiStub(adapter);

    const item = await adapter.createAttentionItem({
      id: 'legacy-1', title: 'A real user escalation', summary: 'please look',
      category: 'general', priority: 'HIGH', sourceContext: 'user',
    });

    expect(rec.forumTopicsCreated).toBe(1);
    expect(rec.topicTitles[0]).toContain('A real user escalation');
    expect(item.coalesced).toBeUndefined();
    expect(typeof item.topicId).toBe('number');
    expect(adapter.isAttentionTopic(item.topicId!)).toBe(true);

    await adapter.updateAttentionStatus('legacy-1', 'DONE');
    expect(rec.closedTopics).toEqual([item.topicId]);
  });

  it('server.ts wires the hub resolver into BOTH TelegramAdapter construction sites', () => {
    const serverSrc = fs.readFileSync(
      path.join(process.cwd(), 'src', 'commands', 'server.ts'),
      'utf-8',
    );
    const wirings = serverSrc.match(/getAttentionHubTopicId: \(\) => state\.get<number>\('agent-attention-topic'\) \?\? null/g) ?? [];
    expect(wirings.length).toBe(2);
  });
});

describe('attentionBodyBlocks (pure) — summary/description dedupe', () => {
  it('description starting with summary → one block (description only)', () => {
    expect(attentionBodyBlocks('sum', 'sum\n\nmore detail', 500)).toEqual(['sum\n\nmore detail']);
  });
  it('identical summary and description → one block', () => {
    expect(attentionBodyBlocks('same text', 'same text', 500)).toEqual(['same text']);
  });
  it('independent description → both blocks, blank-line separated', () => {
    expect(attentionBodyBlocks('impact', 'independent detail', 500)).toEqual(['impact', '\nindependent detail']);
  });
  it('no description → summary only; nothing → empty', () => {
    expect(attentionBodyBlocks('impact', null, 500)).toEqual(['impact']);
    expect(attentionBodyBlocks('impact', undefined, 500)).toEqual(['impact']);
    expect(attentionBodyBlocks('', '', 500)).toEqual([]);
  });
  it('description is clipped to the slice bound', () => {
    const [only] = attentionBodyBlocks('s', 's' + 'x'.repeat(900), 500);
    expect(only.length).toBe(500);
  });
});
