/**
 * The DISCRIMINATION CORPUS — the first-class artifact of the offender #1
 * conversion (docs/specs/keyword-intent-conversions-1-and-3.md §Tests; standard
 * "Intelligence Infers, Keywords Only Guard").
 *
 * It pits CHANGE vs DISCUSSION both directions, with paraphrase, plus the
 * out-of-enum guardrail and fail-open cases — the exact discrimination a keyword
 * regex cannot make ("use codex here" is a command; "should we use codex here?"
 * is a question; "codex here keeps failing" is commentary). Two harnesses share
 * ONE corpus:
 *
 *  1. DETERMINISTIC (runs in CI): for each case the classifier is fed a scripted
 *     "ideal model" verdict, and we assert the classifier's PIPELINE (parse →
 *     enum guardrail → confidence gate → intent map → fail-open) maps it to the
 *     correct final decision. This locks the contract + guardrails for every
 *     case SHAPE — including that an out-of-enum "change" is rejected and that
 *     discussion never becomes a change.
 *
 *  2. LIVE (opt-in, INSTAR_LIVE_PROFILE_INTENT=1): the SAME corpus run against
 *     the REAL shared IntelligenceProvider, asserting the model's discrimination
 *     accuracy — the true benchmark. Skipped by default (no creds / determinism
 *     in CI); this is the harness the dev-agent soak and manual runs use.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyProfileIntent,
  defaultKnownModelValues,
  type ConversationTurn,
  type ProfileIntentKind,
} from '../../src/core/ProfileIntentClassifier.js';
import { SUPPORTED_FRAMEWORKS } from '../../src/core/TopicFrameworksStore.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const FRAMEWORKS = [...SUPPORTED_FRAMEWORKS];
const MODELS = defaultKnownModelValues();

interface CorpusCase {
  id: string;
  kind: 'change' | 'discussion' | 'guardrail' | 'fail-open';
  text: string;
  context?: ConversationTurn[];
  /** The verdict a CORRECT model would emit (deterministic harness). */
  idealVerdict: { isChange: boolean; intent?: ProfileIntentKind | null; value?: string | null; confidence?: number };
  /** The classifier's expected FINAL decision. */
  expectChange: boolean;
  expectedIntent?: ProfileIntentKind;
  expectedValue?: string;
  /** For fail-open cases: make the provider throw instead of returning idealVerdict. */
  providerThrows?: boolean;
}

export const PROFILE_INTENT_CORPUS: CorpusCase[] = [
  // ── CHANGE (act) — varied paraphrase across framework / model / thinking ──
  { id: 'cmd-use-codex', kind: 'change', text: 'use codex here',
    idealVerdict: { isChange: true, intent: 'framework', value: 'codex-cli', confidence: 0.96 }, expectChange: true, expectedIntent: 'framework', expectedValue: 'codex-cli' },
  { id: 'cmd-switch-gemini', kind: 'change', text: 'switch this topic to gemini',
    idealVerdict: { isChange: true, intent: 'framework', value: 'gemini-cli', confidence: 0.95 }, expectChange: true, expectedIntent: 'framework', expectedValue: 'gemini-cli' },
  { id: 'cmd-run-on-claude', kind: 'change', text: "let's run this topic on claude",
    idealVerdict: { isChange: true, intent: 'framework', value: 'claude-code', confidence: 0.9 }, expectChange: true, expectedIntent: 'framework', expectedValue: 'claude-code' },
  { id: 'cmd-pin-opus', kind: 'change', text: 'pin this topic to opus',
    idealVerdict: { isChange: true, intent: 'model', value: 'opus', confidence: 0.93 }, expectChange: true, expectedIntent: 'model', expectedValue: 'opus' },
  { id: 'cmd-high-thinking', kind: 'change', text: 'set high thinking on this topic',
    idealVerdict: { isChange: true, intent: 'thinking', value: 'high', confidence: 0.94 }, expectChange: true, expectedIntent: 'thinking', expectedValue: 'high' },
  // Context helps confirm it's a COMMAND, and the value ("codex") is GROUNDED in
  // the latest message → actuates.
  { id: 'cmd-context-confirms-grounded', kind: 'change', text: 'yeah, use codex',
    context: [{ fromUser: true, text: 'this topic has been on claude the whole time' }, { fromUser: false, text: 'Want me to switch the framework?' }],
    idealVerdict: { isChange: true, intent: 'framework', value: 'codex-cli', confidence: 0.9 }, expectChange: true, expectedIntent: 'framework', expectedValue: 'codex-cli' },

  // ── DISCUSSION (pass through) — the class the keyword regexes would misfire on ──
  { id: 'dis-question-codex', kind: 'discussion', text: 'should we use codex here?',
    idealVerdict: { isChange: false, confidence: 0.9 }, expectChange: false },
  { id: 'dis-codex-failing', kind: 'discussion', text: 'codex here keeps failing',
    idealVerdict: { isChange: false, confidence: 0.95 }, expectChange: false },
  { id: 'dis-gemini-better', kind: 'discussion', text: "gemini's been better on this topic",
    idealVerdict: { isChange: false, confidence: 0.9 }, expectChange: false },
  { id: 'dis-readout-question', kind: 'discussion', text: 'what model are we on?',
    idealVerdict: { isChange: false, confidence: 0.88 }, expectChange: false },
  { id: 'dis-opus-mention', kind: 'discussion', text: 'opus is expensive for this kind of task',
    idealVerdict: { isChange: false, confidence: 0.9 }, expectChange: false },
  // STALE-CONTEXT false-positive vector: a bare "yes" answering an UNRELATED
  // question, while a stale profile proposal still sits in the window.
  { id: 'dis-stale-context-yes', kind: 'discussion', text: 'yes',
    context: [
      { fromUser: false, text: 'Want me to switch this topic to gemini?' },
      { fromUser: true, text: 'not yet — first, is the build green?' },
      { fromUser: false, text: 'The build is green. Want me to tag the release?' },
    ],
    idealVerdict: { isChange: false, confidence: 0.86 }, expectChange: false },

  // ── GUARDRAIL — CONTEXT-ONLY value (the confirm-slot-bypass fix): even a model
  // slip that resolves a value purely from a STALE prior turn must NOT actuate a
  // respawn, because the value is absent from the LATEST message. This is the
  // adversarial-review MATERIAL finding: "yeah go with that" answering an old
  // "switch to gemini?" proposal. Grounding guard → pass-through.
  { id: 'guard-context-only-value', kind: 'guardrail', text: 'yeah go with that',
    context: [
      { fromUser: false, text: 'Want me to switch this topic to gemini?' },
      { fromUser: true, text: 'not now' },
      { fromUser: false, text: 'ok. anything else?' },
    ],
    idealVerdict: { isChange: true, intent: 'framework', value: 'gemini-cli', confidence: 0.95 }, expectChange: false },

  // ── GUARDRAIL — an out-of-enum value; even a model slip must NOT become a change ──
  { id: 'guard-unknown-framework', kind: 'guardrail', text: 'use rustlang here',
    idealVerdict: { isChange: true, intent: 'framework', value: 'rustlang-cli', confidence: 0.99 }, expectChange: false },
  { id: 'guard-unknown-model', kind: 'guardrail', text: 'pin this topic to gpt-imaginary',
    idealVerdict: { isChange: true, intent: 'model', value: 'gpt-imaginary', confidence: 0.99 }, expectChange: false },

  // ── FAIL-OPEN — provider unavailable / low confidence → never actuate ──
  { id: 'failopen-throw', kind: 'fail-open', text: 'use codex here', providerThrows: true,
    idealVerdict: { isChange: true, intent: 'framework', value: 'codex-cli', confidence: 1 }, expectChange: false },
  { id: 'failopen-lowconf', kind: 'fail-open', text: 'use codex here',
    idealVerdict: { isChange: true, intent: 'framework', value: 'codex-cli', confidence: 0.4 }, expectChange: false },
];

function scriptedProvider(c: CorpusCase): IntelligenceProvider {
  return {
    evaluate: async () => {
      if (c.providerThrows) throw new Error('provider unavailable');
      return JSON.stringify({
        isChange: c.idealVerdict.isChange,
        intent: c.idealVerdict.intent ?? null,
        value: c.idealVerdict.value ?? null,
        confidence: c.idealVerdict.confidence ?? 0,
      });
    },
  };
}

describe('profile-intent discrimination corpus — DETERMINISTIC pipeline contract', () => {
  it('covers all four case kinds', () => {
    expect(PROFILE_INTENT_CORPUS.some((c) => c.kind === 'change')).toBe(true);
    expect(PROFILE_INTENT_CORPUS.some((c) => c.kind === 'discussion')).toBe(true);
    expect(PROFILE_INTENT_CORPUS.some((c) => c.kind === 'guardrail')).toBe(true);
    expect(PROFILE_INTENT_CORPUS.some((c) => c.kind === 'fail-open')).toBe(true);
  });

  for (const c of PROFILE_INTENT_CORPUS) {
    it(`[${c.kind}] ${c.id}: "${c.text}" → ${c.expectChange ? 'CHANGE' : 'pass-through'}`, async () => {
      const r = await classifyProfileIntent({
        text: c.text,
        conversationContext: c.context,
        intelligence: scriptedProvider(c),
        minConfidence: 0.85,
      });
      expect(r.isChange).toBe(c.expectChange);
      if (c.expectChange) {
        expect(r.intent).toBe(c.expectedIntent);
        expect(r.value).toBe(c.expectedValue);
      }
    });
  }
});

describe('regression: the keyword framework/model/thinking decision is gone (the standard)', () => {
  it('parseProfileTrigger no longer ships the framework/model/thinking write regexes', () => {
    const src = readFileSync(join(process.cwd(), 'src/core/topicProfileIngress.ts'), 'utf-8');
    // The DECLARATIONS must be gone (the docstring may still narrate the history).
    expect(src).not.toMatch(/const\s+FRAMEWORK_WORDS\s*=/);
    expect(src).not.toMatch(/const\s+THINKING_WORDS\s*=/);
    expect(src).not.toMatch(/\^use \(codex\|codex-cli\|claude/);
    expect(src).not.toMatch(/\^switch this topic to \(codex/);
    expect(src).not.toMatch(/\^pin this topic to \(\[a-z0-9/);
  });
});

// ── LIVE benchmark (opt-in): the REAL model's discrimination accuracy ──
const LIVE = process.env.INSTAR_LIVE_PROFILE_INTENT === '1';
describe.skipIf(!LIVE)('profile-intent discrimination corpus — LIVE model accuracy', () => {
  it('the real IntelligenceProvider discriminates change vs discussion (≥90% + both canonical cases)', async () => {
    const { buildIntelligenceProvider, frameworkFromEnv } = await import('../../src/core/intelligenceProviderFactory.js');
    const provider = buildIntelligenceProvider({ framework: frameworkFromEnv() ?? 'claude-code' });
    if (!provider) {
      console.warn('[live-profile-intent] no provider available — skipping');
      return;
    }
    // The two cases whose misclassification is the exact operator harm.
    const canonical = new Set(['cmd-use-codex', 'dis-question-codex']);
    const scored = PROFILE_INTENT_CORPUS.filter((c) => c.kind === 'change' || c.kind === 'discussion');
    let correct = 0;
    const misses: string[] = [];
    for (const c of scored) {
      const r = await classifyProfileIntent({
        text: c.text, conversationContext: c.context, intelligence: provider, minConfidence: 0.85,
      });
      const ok = r.isChange === c.expectChange && (!c.expectChange || r.value === c.expectedValue);
      if (ok) correct++;
      else {
        misses.push(`${c.id} (got isChange=${r.isChange} value=${r.value})`);
        expect(canonical.has(c.id), `canonical case regressed: ${c.id}`).toBe(false);
      }
    }
    console.log(`[live-profile-intent] accuracy ${correct}/${scored.length}; misses: ${misses.join('; ') || 'none'}`);
    expect(correct / scored.length).toBeGreaterThanOrEqual(0.9);
  }, 120_000);
});
