/**
 * Integration: the hub-bind path end-to-end — classifier → binder.
 *
 * The onTopicMessage hub intercept (server.ts) runs exactly this chain:
 *   classifyHubIntent → toHubCommand → bindHubConversation.
 * This test composes those real units (no server spawn) to prove the DECISION
 * flows into the right ACTION: a genuine command binds the conversation;
 * discussion / fail-open binds NOTHING (the message would pass through to the
 * agent — never swallowed); and the dry-run gate withholds the bind while still
 * classifying. It is the regression guard for the exact message-swallowing harm.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyHubIntent,
  toHubCommand,
  type HubTopicCandidate,
} from '../../src/threadline/HubIntentClassifier.js';
import { bindHubConversation, type HubBindDeps } from '../../src/threadline/hubCommands.js';
import { CollaborationSurfacer, type SurfacerTelegram } from '../../src/threadline/CollaborationSurfacer.js';
import { ConversationStore } from '../../src/threadline/ConversationStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const TOPICS: HubTopicCandidate[] = [
  { topicId: 101, topicName: 'roadmap' },
  { topicId: 202, topicName: 'GrowthBook rollout' },
];

function stub(raw: string): IntelligenceProvider {
  return { evaluate: async () => raw };
}
function verdict(o: object): string { return JSON.stringify(o); }

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

describe('hub-bind path — decision → action', () => {
  let tmp: string; let stateDir: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hubintent-')); stateDir = path.join(tmp, '.instar'); fs.mkdirSync(stateDir, { recursive: true }); });
  afterEach(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/hub-intent-bind-path.test.ts' }));

  function setup() {
    const tg = fakeTelegram();
    const store = new ConversationStore(stateDir);
    const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    const deps: HubBindDeps = { collaborationSurfacer: surfacer, conversationStore: store, commitmentTracker: null, telegram: tg };
    return { tg, store, surfacer, deps };
  }

  /** Mirror of the wiring's decision: act only on a command AND not in dry-run. */
  async function hubDecision(text: string, intelligence: IntelligenceProvider, dryRun: boolean, deps: HubBindDeps) {
    const result = await classifyHubIntent({ text, bindableTopics: TOPICS, intelligence, minConfidence: 0.85 });
    const willAct = result.isCommand && !dryRun;
    if (!willAct) return { handled: false as const, result };
    const cmd = toHubCommand(result);
    if (!cmd) return { handled: false as const, result };
    const bindResult = await bindHubConversation(deps, { ...cmd, autoPick: true });
    return { handled: true as const, result, bindResult };
  }

  it('a real "open this" command binds the surfaced conversation', async () => {
    const { tg, store, surfacer, deps } = setup();
    await surfacer.surface({ threadId: 't-1', senderName: 'codey', text: 'verify the build please', hasParentTopic: false, warrants: true });
    const out = await hubDecision('open this', stub(verdict({ intent: 'open', confidence: 0.96 })), /* dryRun */ false, deps);
    expect(out.handled).toBe(true);
    expect(out.bindResult!.ok).toBe(true);
    if (out.bindResult!.ok) expect(store.get('t-1')?.boundTopicId).toBe(out.bindResult!.topicId);
  });

  it('a real "tie" command binds to the enum-resolved existing topic', async () => {
    const { store, surfacer, deps } = setup();
    await surfacer.surface({ threadId: 't-tie', senderName: 'codey', text: 'x', hasParentTopic: false, warrants: true });
    const out = await hubDecision('tie this to the roadmap topic', stub(verdict({ intent: 'tie', targetTopicId: 101, confidence: 0.95 })), false, deps);
    expect(out.handled).toBe(true);
    expect(out.bindResult!.ok).toBe(true);
    expect(store.get('t-tie')?.boundTopicId).toBe(101);
  });

  it('THE SWALLOW REGRESSION: "should I open this?" is discussion → NOT handled (message passes through)', async () => {
    const { surfacer, deps } = setup();
    await surfacer.surface({ threadId: 't-q', senderName: 'codey', text: 'x', hasParentTopic: false, warrants: true });
    const out = await hubDecision('should I open this?', stub(verdict({ intent: null, confidence: 0.92 })), false, deps);
    expect(out.handled).toBe(false); // the message reaches the agent, never eaten
    expect(out.result.isCommand).toBe(false);
  });

  it('FAIL-OPEN: provider down → NOT handled (never swallow under uncertainty)', async () => {
    const { surfacer, deps } = setup();
    await surfacer.surface({ threadId: 't-fo', senderName: 'codey', text: 'x', hasParentTopic: false, warrants: true });
    const provider: IntelligenceProvider = { evaluate: async () => { throw new Error('down'); } };
    const out = await hubDecision('open this', provider, false, deps);
    expect(out.handled).toBe(false);
    expect(out.result.source).toBe('fail-open');
  });

  it('DRY-RUN: a real command is classified as a command but NOT acted on (soak)', async () => {
    const { surfacer, deps } = setup();
    await surfacer.surface({ threadId: 't-dr', senderName: 'codey', text: 'x', hasParentTopic: false, warrants: true });
    const out = await hubDecision('open this', stub(verdict({ intent: 'open', confidence: 0.96 })), /* dryRun */ true, deps);
    expect(out.result.isCommand).toBe(true); // would-swallow recorded
    expect(out.handled).toBe(false);          // but the message passes through
  });

  it('GUARDRAIL: an unknown tie target → NOT handled even though the model claimed a command', async () => {
    const { surfacer, deps } = setup();
    await surfacer.surface({ threadId: 't-g', senderName: 'codey', text: 'x', hasParentTopic: false, warrants: true });
    const out = await hubDecision('tie this to the billing topic', stub(verdict({ intent: 'tie', targetTopicId: 999, confidence: 0.99 })), false, deps);
    expect(out.handled).toBe(false); // no valid topic → no bind
    expect(out.result.isCommand).toBe(false);
  });
});
