/**
 * The DISCRIMINATION CORPUS for Conversion #3 (the hub-bind recognizer) — the
 * first-class artifact of docs/specs/keyword-intent-conversions-1-and-3.md.
 *
 * It pits COMMAND vs DISCUSSION both directions, with paraphrase, plus the
 * unknown-target guardrail and fail-open cases. Two harnesses share ONE corpus:
 *
 *  1. DETERMINISTIC (runs in CI): for each case the classifier is fed a scripted
 *     "ideal model" verdict, and we assert the classifier's PIPELINE (parse →
 *     enum guardrail → confidence gate → intent map → fail-open) maps it to the
 *     correct final decision. This locks the contract + guardrails for every
 *     case SHAPE — including that an unknown-topic "tie" is rejected and that
 *     discussion never becomes a command (never swallows the message).
 *
 *  2. LIVE (opt-in, INSTAR_LIVE_HUB_INTENT=1): the SAME corpus run against the
 *     REAL shared IntelligenceProvider, asserting the model's discrimination
 *     accuracy — the true benchmark + the graduation gate before dryRun:false.
 *     Skipped by default (no creds / determinism in CI).
 */
import { describe, it, expect } from 'vitest';
import {
  classifyHubIntent,
  type ConversationTurn,
  type HubTopicCandidate,
} from '../../src/threadline/HubIntentClassifier.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const TOPICS: HubTopicCandidate[] = [
  { topicId: 101, topicName: 'roadmap' },
  { topicId: 202, topicName: 'GrowthBook rollout' },
  { topicId: 303, topicName: 'infra' },
];

interface CorpusCase {
  id: string;
  kind: 'command' | 'discussion' | 'guardrail' | 'fail-open';
  text: string;
  context?: ConversationTurn[];
  /** The verdict a CORRECT model would emit for this message (deterministic harness). */
  idealVerdict: { intent?: 'open' | 'tie' | null; targetTopicId?: number | null; confidence?: number };
  /** The classifier's expected FINAL decision. */
  expectCommand: boolean;
  expectedIntent?: 'open' | 'tie';
  expectedTarget?: number;
  /** For fail-open cases: make the provider throw instead of returning idealVerdict. */
  providerThrows?: boolean;
}

export const HUB_INTENT_CORPUS: CorpusCase[] = [
  // ── COMMAND (act) — varied paraphrase ──
  { id: 'cmd-open-this', kind: 'command', text: 'open this',
    idealVerdict: { intent: 'open', confidence: 0.96 }, expectCommand: true, expectedIntent: 'open' },
  { id: 'cmd-open-bare', kind: 'command', text: 'open',
    idealVerdict: { intent: 'open', confidence: 0.9 }, expectCommand: true, expectedIntent: 'open' },
  { id: 'cmd-open-this-one', kind: 'command', text: 'open this one',
    idealVerdict: { intent: 'open', confidence: 0.92 }, expectCommand: true, expectedIntent: 'open' },
  { id: 'cmd-tie-roadmap', kind: 'command', text: 'tie this to the roadmap topic',
    idealVerdict: { intent: 'tie', targetTopicId: 101, confidence: 0.95 }, expectCommand: true, expectedIntent: 'tie', expectedTarget: 101 },
  { id: 'cmd-bind-id', kind: 'command', text: 'bind this to #202',
    idealVerdict: { intent: 'tie', targetTopicId: 202, confidence: 0.94 }, expectCommand: true, expectedIntent: 'tie', expectedTarget: 202 },
  { id: 'cmd-context-resolved', kind: 'command', text: 'yes, tie it to that one',
    context: [{ fromUser: false, text: 'Want me to tie this conversation to the GrowthBook rollout topic?' }, { fromUser: true, text: 'yes, tie it to that one' }],
    idealVerdict: { intent: 'tie', targetTopicId: 202, confidence: 0.9 }, expectCommand: true, expectedIntent: 'tie', expectedTarget: 202 },

  // ── DISCUSSION (pass through) — the class the regex ate ──
  { id: 'dis-question-open', kind: 'discussion', text: 'should I open this?',
    idealVerdict: { intent: null, confidence: 0.9 }, expectCommand: false },
  { id: 'dis-open-new-tab', kind: 'discussion', text: 'open this in a new tab',
    idealVerdict: { intent: null, confidence: 0.88 }, expectCommand: false },
  { id: 'dis-open-and-explain', kind: 'discussion', text: 'can you open this and explain what it is?',
    idealVerdict: { intent: null, confidence: 0.9 }, expectCommand: false },
  { id: 'dis-ties-into', kind: 'discussion', text: 'this ties into the roadmap discussion',
    idealVerdict: { intent: null, confidence: 0.9 }, expectCommand: false },
  { id: 'dis-what-thread', kind: 'discussion', text: 'what is this thread about?',
    idealVerdict: { intent: null, confidence: 0.92 }, expectCommand: false },
  // STALE-CONTEXT false-positive vector: a bare "yes" answering an UNRELATED
  // question while a stale tie proposal still sits in the window. A correct model
  // must judge that the "yes" is not consenting to the bind.
  { id: 'dis-stale-context-yes', kind: 'discussion', text: 'yes',
    context: [
      { fromUser: false, text: 'Want me to tie this to the roadmap topic?' },
      { fromUser: true, text: 'not yet — first, is the deploy green?' },
      { fromUser: false, text: 'The deploy is green. Want me to tag the release?' },
    ],
    idealVerdict: { intent: null, confidence: 0.86 }, expectCommand: false },

  // ── GUARDRAIL — unknown topic; even a model slip must NOT become a command ──
  { id: 'guard-unknown-topic', kind: 'guardrail', text: 'tie this to the billing topic',
    idealVerdict: { intent: 'tie', targetTopicId: 555, confidence: 0.99 }, expectCommand: false },

  // ── FAIL-OPEN — provider unavailable / low confidence → never swallow ──
  { id: 'failopen-throw', kind: 'fail-open', text: 'open this', providerThrows: true,
    idealVerdict: { intent: 'open', confidence: 1 }, expectCommand: false },
  { id: 'failopen-lowconf', kind: 'fail-open', text: 'open this',
    idealVerdict: { intent: 'open', confidence: 0.4 }, expectCommand: false },
];

function scriptedProvider(c: CorpusCase): IntelligenceProvider {
  return {
    evaluate: async () => {
      if (c.providerThrows) throw new Error('provider unavailable');
      return JSON.stringify({
        intent: c.idealVerdict.intent ?? null,
        targetTopicId: c.idealVerdict.targetTopicId ?? null,
        confidence: c.idealVerdict.confidence ?? 0,
      });
    },
  };
}

describe('hub-intent discrimination corpus — DETERMINISTIC pipeline contract', () => {
  it('covers both directions + guardrail + fail-open', () => {
    expect(HUB_INTENT_CORPUS.some((c) => c.kind === 'command')).toBe(true);
    expect(HUB_INTENT_CORPUS.some((c) => c.kind === 'discussion')).toBe(true);
    expect(HUB_INTENT_CORPUS.some((c) => c.kind === 'guardrail')).toBe(true);
    expect(HUB_INTENT_CORPUS.some((c) => c.kind === 'fail-open')).toBe(true);
  });

  for (const c of HUB_INTENT_CORPUS) {
    it(`[${c.kind}] ${c.id}: "${c.text}" → ${c.expectCommand ? 'COMMAND' : 'pass-through'}`, async () => {
      const r = await classifyHubIntent({
        text: c.text,
        bindableTopics: TOPICS,
        conversationContext: c.context,
        intelligence: scriptedProvider(c),
        minConfidence: 0.85,
      });
      expect(r.isCommand).toBe(c.expectCommand);
      if (c.expectCommand) {
        expect(r.intent).toBe(c.expectedIntent);
        if (c.expectedTarget !== undefined) expect(r.targetTopicId).toBe(c.expectedTarget);
      }
    });
  }
});

// ── LIVE benchmark (opt-in): the REAL model's discrimination accuracy ──
const LIVE = process.env.INSTAR_LIVE_HUB_INTENT === '1';
describe.skipIf(!LIVE)('hub-intent discrimination corpus — LIVE model accuracy', () => {
  it('the real IntelligenceProvider discriminates command vs discussion (≥90% + both canonical cases)', async () => {
    const { buildIntelligenceProvider, frameworkFromEnv } = await import('../../src/core/intelligenceProviderFactory.js');
    const provider = buildIntelligenceProvider({ framework: frameworkFromEnv() ?? 'claude-code' });
    if (!provider) {
      console.warn('[live-hub-intent] no provider available — skipping');
      return;
    }
    // The two cases whose misclassification is the exact operator harm (swallow).
    const canonical = new Set(['cmd-open-this', 'dis-open-and-explain']);
    const scored = HUB_INTENT_CORPUS.filter((c) => c.kind === 'command' || c.kind === 'discussion');
    let correct = 0;
    const misses: string[] = [];
    for (const c of scored) {
      const r = await classifyHubIntent({
        text: c.text, bindableTopics: TOPICS, conversationContext: c.context, intelligence: provider, minConfidence: 0.85,
      });
      const ok = r.isCommand === c.expectCommand
        && (!c.expectCommand || (r.intent === c.expectedIntent && (c.expectedTarget === undefined || r.targetTopicId === c.expectedTarget)));
      if (ok) correct++;
      else {
        misses.push(`${c.id} (got isCommand=${r.isCommand} intent=${r.intent} target=${r.targetTopicId})`);
        expect(canonical.has(c.id), `canonical case regressed: ${c.id}`).toBe(false);
      }
    }
    console.log(`[live-hub-intent] accuracy ${correct}/${scored.length}; misses: ${misses.join('; ') || 'none'}`);
    expect(correct / scored.length).toBeGreaterThanOrEqual(0.9);
  }, 120_000);
});
