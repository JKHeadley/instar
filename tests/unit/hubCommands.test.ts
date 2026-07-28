/**
 * Unit tests for the Threadline hub binder (CMT-529): bindHubConversation + the
 * legacy-ordering fix. The keyword/regex DECISION (`parseHubCommand`) is GONE —
 * it moved to the LLM-with-context HubIntentClassifier (Conversion #3,
 * docs/specs/keyword-intent-conversions-1-and-3.md); see
 * HubIntentClassifier.test.ts + hub-intent-discrimination.test.ts for the
 * recognizer. This file covers only the binder, whose behavior is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindHubConversation, type HubBindDeps } from '../../src/threadline/hubCommands.js';
import { CollaborationSurfacer, type SurfacerTelegram } from '../../src/threadline/CollaborationSurfacer.js';
import { ConversationStore } from '../../src/threadline/ConversationStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('regression: the keyword hub-command recognizer is gone (the standard)', () => {
  it('hubCommands.ts no longer ships a parseHubCommand regex decision', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/threadline/hubCommands.ts'), 'utf-8');
    // The DECLARATION must be gone (the docstring may still narrate the history).
    expect(src).not.toContain('export function parseHubCommand');
    // No executable regex decision remains: the `.test(`/`.match(` calls that
    // classified the message are gone (the docstring narrates the old regexes as
    // prose, but there is no runtime matcher left).
    expect(src).not.toMatch(/\.test\(t\)/);
    expect(src).not.toMatch(/t\.match\(/);
  });
});

function fakeTelegram() {
  const tg = {
    posts: [] as Array<{ topicId: number; text: string }>,
    next: 5000,
    created: [] as string[],
    async findOrCreateForumTopic(name: string) { tg.created.push(name); return { topicId: tg.next++, name, reused: false }; },
    async sendToTopic(topicId: number, text: string) { tg.posts.push({ topicId, text }); return { ok: true }; },
  };
  return tg;
}

describe('bindHubConversation', () => {
  let tmp: string; let stateDir: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hubcmd-')); stateDir = path.join(tmp, '.instar'); fs.mkdirSync(stateDir, { recursive: true }); });
  afterEach(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/hubCommands.test.ts' }));

  function deps(tg: ReturnType<typeof fakeTelegram>, surfacer: CollaborationSurfacer, store: ConversationStore): HubBindDeps {
    return { collaborationSurfacer: surfacer, conversationStore: store, commitmentTracker: null, telegram: tg };
  }

  it('open with one unbound conversation binds it + sets boundTopicId', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    await surfacer.surface({ threadId: 't-1', senderName: 'codey', text: 'verify the build please', hasParentTopic: false, warrants: true });
    const r = await bindHubConversation(deps(tg, surfacer, store), { action: 'open' });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.threadId).toBe('t-1'); expect(store.get('t-1')?.boundTopicId).toBe(r.topicId); }
  });

  it('open with zero unbound → 404', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    const r = await bindHubConversation(deps(tg, surfacer, store), { action: 'open' });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it('open with >1 unbound → 409 WITHOUT autoPick (API path)', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    await surfacer.surface({ threadId: 't-a', senderName: 'codey', text: 'a', hasParentTopic: false, warrants: true });
    await new Promise(r => setTimeout(r, 5));
    await surfacer.surface({ threadId: 't-b', senderName: 'aiguy', text: 'b', hasParentTopic: false, warrants: true });
    const r = await bindHubConversation(deps(tg, surfacer, store), { action: 'open' });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it('open with >1 unbound + autoPick → binds the MOST RECENT (intercept path)', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    await surfacer.surface({ threadId: 't-old', senderName: 'codey', text: 'old', hasParentTopic: false, warrants: true });
    await new Promise(r => setTimeout(r, 5));
    await surfacer.surface({ threadId: 't-new', senderName: 'aiguy', text: 'new', hasParentTopic: false, warrants: true });
    const r = await bindHubConversation(deps(tg, surfacer, store), { action: 'open', autoPick: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.threadId).toBe('t-new'); // most-recent, not a 409
  });

  it('tie binds an explicit targetTopicId', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    await surfacer.surface({ threadId: 't-tie', senderName: 'codey', text: 'x', hasParentTopic: false, warrants: true });
    const r = await bindHubConversation(deps(tg, surfacer, store), { action: 'tie', threadId: 't-tie', targetTopicId: 4242 });
    expect(r.ok).toBe(true);
    expect(store.get('t-tie')?.boundTopicId).toBe(4242);
  });

  it('open derives a readable topic name from the conversation gist (not peer·threadId)', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    // Seed a conversation with a meaningful subject.
    await store.mutate('t-named', (c) => { c.subject = 'GrowthBook rollout coordination'; c.participants = { peers: ['codey'] }; return c; });
    await surfacer.surface({ threadId: 't-named', senderName: 'codey', text: 'about GrowthBook rollout', hasParentTopic: false, warrants: true });
    const r = await bindHubConversation(deps(tg, surfacer, store), { action: 'open', threadId: 't-named' });
    expect(r.ok).toBe(true);
    // The created topic name reflects the gist, not "codey · t-named".
    expect(tg.created.some(n => /GrowthBook/i.test(n))).toBe(true);
  });

  // ── CMT-567: brief deps (LLM name + summary first message) ──────────────
  function briefDeps(messages: number, evaluate?: (p: string) => Promise<string>): import('../../src/threadline/openConversationBrief.js').BriefDeps {
    return {
      observability: { getThread: () => ({ messages: Array.from({ length: messages }, (_, i) => ({ direction: (i % 2 === 0 ? 'in' : 'out') as 'in' | 'out', text: `m${i}`, remoteAgentName: 'Codey', timestamp: `2026-05-27T19:0${i}:00Z` })) }) },
      llmQueue: evaluate ? ({ enqueue: async (_l: string, fn: (s: AbortSignal) => Promise<string>) => fn(new AbortController().signal) } as unknown as import('../../src/threadline/openConversationBrief.js').BriefDeps['llmQueue']) : null,
      intelligence: evaluate ? { evaluate } : null,
      topicNameFallback: (_c: unknown, t: string) => `codey · ${t.slice(0, 8)}`,
    };
  }

  it('open with brief + LLM → topic named from PURPOSE, summary is first message', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    await store.mutate('t-llm', (c) => { c.participants = { peers: ['codey'] }; return c; });
    await surfacer.surface({ threadId: 't-llm', senderName: 'codey', text: 'hi', hasParentTopic: false, warrants: true });
    const d = { ...deps(tg, surfacer, store), brief: briefDeps(4, async () => 'PURPOSE: GrowthBook rollout plan\n\nCodey wants to coordinate the GrowthBook rollout. Awaiting your sign-off.') };
    const r = await bindHubConversation(d, { action: 'open', threadId: 't-llm' });
    expect(r.ok).toBe(true);
    expect(tg.created.some(n => /GrowthBook rollout plan/i.test(n))).toBe(true);
    expect(tg.posts.some(p => /Codey wants to coordinate/i.test(p.text))).toBe(true);
    expect(tg.posts.some(p => /now tied to this topic/i.test(p.text))).toBe(false); // NOT the legacy marker
  });

  it('open with brief but LLM throws → slug name + template summary (NOT empty marker)', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    await store.mutate('t-fb', (c) => { c.participants = { peers: ['codey'] }; c.messageCount = 4; return c; });
    await surfacer.surface({ threadId: 't-fb', senderName: 'codey', text: 'hi', hasParentTopic: false, warrants: true });
    const d = { ...deps(tg, surfacer, store), brief: briefDeps(4, async () => { throw new Error('LLM timeout'); }) };
    const r = await bindHubConversation(d, { action: 'open', threadId: 't-fb' });
    expect(r.ok).toBe(true);
    expect(tg.posts.some(p => /Conversation with/i.test(p.text))).toBe(true); // template brief
  });

  it('open with brief but no backing conversation messages → slug + legacy marker', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    await surfacer.surface({ threadId: 't-empty', senderName: 'codey', text: 'hi', hasParentTopic: false, warrants: true });
    const d = { ...deps(tg, surfacer, store), brief: briefDeps(0, async () => 'PURPOSE: x\n\ny') };
    const r = await bindHubConversation(d, { action: 'open', threadId: 't-empty' });
    expect(r.ok).toBe(true);
    expect(tg.posts.some(p => /now tied to this topic/i.test(p.text))).toBe(true); // Tier-C legacy marker
  });

  it('tie with brief deps → operator name + legacy marker, brief NOT invoked', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    await surfacer.surface({ threadId: 't-tie2', senderName: 'codey', text: 'x', hasParentTopic: false, warrants: true });
    let called = false;
    const d = { ...deps(tg, surfacer, store), brief: briefDeps(4, async () => { called = true; return 'PURPOSE: x\n\ny'; }) };
    const r = await bindHubConversation(d, { action: 'tie', threadId: 't-tie2', targetTopicId: 9999 });
    expect(r.ok).toBe(true);
    expect(called).toBe(false);
    expect(tg.posts.some(p => /now tied to this topic/i.test(p.text))).toBe(true);
  });
});
