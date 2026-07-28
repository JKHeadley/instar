/**
 * The DISCRIMINATION CORPUS — the deeper fix the operator demanded after the
 * 2026-07-03 hijack (docs/specs/nickname-move-intent-llm-rebuild.md §Tests).
 *
 * It pits COMMAND vs DISCUSSION both directions, with paraphrase, plus the
 * unknown-nickname guardrail and fail-open cases. Two harnesses share ONE corpus:
 *
 *  1. DETERMINISTIC (runs in CI): for each case the classifier is fed a scripted
 *     "ideal model" verdict, and we assert the classifier's PIPELINE (parse →
 *     enum guardrail → confidence gate → intent map → fail-open) maps it to the
 *     correct final decision. This locks the contract + guardrails for every
 *     case SHAPE — including that an unknown-machine "command" is rejected and
 *     that discussion never becomes a command.
 *
 *  2. LIVE (opt-in, INSTAR_LIVE_MOVE_INTENT=1): the SAME corpus run against the
 *     REAL shared IntelligenceProvider, asserting the model's discrimination
 *     accuracy — the true benchmark. Skipped by default (no creds / determinism
 *     in CI); this is the harness the dev-agent soak and manual runs use.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyRelocationIntent,
  type ConversationTurn,
} from '../../src/core/MoveIntentClassifier.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const NICKS = ['mini', 'laptop', 'mac mini', 'workstation'];

interface CorpusCase {
  id: string;
  kind: 'command' | 'discussion' | 'guardrail' | 'fail-open';
  text: string;
  context?: ConversationTurn[];
  /** The verdict a CORRECT model would emit for this message (deterministic harness). */
  idealVerdict: { isCommand: boolean; intent?: 'transfer' | 'pin' | null; targetNickname?: string | null; confidence?: number };
  /** The classifier's expected FINAL decision. */
  expectCommand: boolean;
  expectedTarget?: string;
  expectedIntent?: 'transfer' | 'pin';
  /** For fail-open cases: make the provider throw instead of returning idealVerdict. */
  providerThrows?: boolean;
}

export const MOVE_INTENT_CORPUS: CorpusCase[] = [
  // ── COMMAND (act) — varied paraphrase, no reliance on a single verb ──
  { id: 'cmd-move-mini', kind: 'command', text: 'move this to the mini',
    idealVerdict: { isCommand: true, intent: 'transfer', targetNickname: 'mini', confidence: 0.96 }, expectCommand: true, expectedTarget: 'mini', expectedIntent: 'transfer' },
  { id: 'cmd-run-laptop', kind: 'command', text: 'run this on the laptop',
    idealVerdict: { isCommand: true, intent: 'transfer', targetNickname: 'laptop', confidence: 0.95 }, expectCommand: true, expectedTarget: 'laptop', expectedIntent: 'transfer' },
  { id: 'cmd-noverb-takeover', kind: 'command', text: "let's have the mini take this one",
    idealVerdict: { isCommand: true, intent: 'transfer', targetNickname: 'mini', confidence: 0.9 }, expectCommand: true, expectedTarget: 'mini', expectedIntent: 'transfer' },
  { id: 'cmd-switch-please', kind: 'command', text: 'actually, switch this conversation to the laptop please',
    idealVerdict: { isCommand: true, intent: 'transfer', targetNickname: 'laptop', confidence: 0.94 }, expectCommand: true, expectedTarget: 'laptop', expectedIntent: 'transfer' },
  { id: 'cmd-pin', kind: 'command', text: 'pin this topic to the workstation',
    idealVerdict: { isCommand: true, intent: 'pin', targetNickname: 'workstation', confidence: 0.93 }, expectCommand: true, expectedTarget: 'workstation', expectedIntent: 'pin' },
  { id: 'cmd-context-resolved', kind: 'command', text: 'yes, move it',
    context: [{ fromUser: true, text: 'this is dragging — the mac mini is way faster' }, { fromUser: false, text: 'Want me to move this conversation to the mac mini?' }],
    idealVerdict: { isCommand: true, intent: 'transfer', targetNickname: 'mac mini', confidence: 0.9 }, expectCommand: true, expectedTarget: 'mac mini', expectedIntent: 'transfer' },

  // ── DISCUSSION (pass through) — the class the keyword list ate ──
  { id: 'dis-keep-laptop', kind: 'discussion', text: 'keep the work on the laptop for now',
    idealVerdict: { isCommand: false, confidence: 0.9 }, expectCommand: false },
  { id: 'dis-mini-failing', kind: 'discussion', text: 'the mini keeps failing',
    idealVerdict: { isCommand: false, confidence: 0.95 }, expectCommand: false },
  { id: 'dis-question', kind: 'discussion', text: 'should we move this to the mini?',
    idealVerdict: { isCommand: false, confidence: 0.88 }, expectCommand: false },
  { id: 'dis-continue-commentary', kind: 'discussion', text: 'continue — on the mini it was faster',
    idealVerdict: { isCommand: false, confidence: 0.82 }, expectCommand: false },
  { id: 'dis-mention', kind: 'discussion', text: 'the workstation handled that job fine',
    idealVerdict: { isCommand: false, confidence: 0.9 }, expectCommand: false },
  // STALE-CONTEXT false-positive vector (adversarial M3): a bare "yes" that answers
  // an UNRELATED question, while a stale move proposal still sits in the window.
  // A correct model must judge that the "yes" is not consenting to the move.
  { id: 'dis-stale-context-yes', kind: 'discussion', text: 'yes',
    context: [
      { fromUser: false, text: 'Want me to move this conversation to the mini?' },
      { fromUser: true, text: 'not yet — first, is the deploy green?' },
      { fromUser: false, text: 'The deploy is green. Want me to tag the release?' },
    ],
    idealVerdict: { isCommand: false, confidence: 0.86 }, expectCommand: false },

  // ── GUARDRAIL — unknown machine; even a model slip must NOT become a command ──
  { id: 'guard-toaster', kind: 'guardrail', text: 'move this to the toaster',
    idealVerdict: { isCommand: true, intent: 'transfer', targetNickname: 'toaster', confidence: 0.99 }, expectCommand: false },

  // ── FAIL-OPEN — provider unavailable / low confidence → never hijack ──
  { id: 'failopen-throw', kind: 'fail-open', text: 'move this to the mini', providerThrows: true,
    idealVerdict: { isCommand: true, intent: 'transfer', targetNickname: 'mini', confidence: 1 }, expectCommand: false },
  { id: 'failopen-lowconf', kind: 'fail-open', text: 'move this to the mini',
    idealVerdict: { isCommand: true, intent: 'transfer', targetNickname: 'mini', confidence: 0.4 }, expectCommand: false },
];

function scriptedProvider(c: CorpusCase): IntelligenceProvider {
  return {
    evaluate: async () => {
      if (c.providerThrows) throw new Error('provider unavailable');
      return JSON.stringify({
        isCommand: c.idealVerdict.isCommand,
        intent: c.idealVerdict.intent ?? null,
        targetNickname: c.idealVerdict.targetNickname ?? null,
        confidence: c.idealVerdict.confidence ?? 0,
      });
    },
  };
}

describe('move-intent discrimination corpus — DETERMINISTIC pipeline contract', () => {
  it('covers both directions + guardrail + fail-open', () => {
    expect(MOVE_INTENT_CORPUS.some((c) => c.kind === 'command')).toBe(true);
    expect(MOVE_INTENT_CORPUS.some((c) => c.kind === 'discussion')).toBe(true);
    expect(MOVE_INTENT_CORPUS.some((c) => c.kind === 'guardrail')).toBe(true);
    expect(MOVE_INTENT_CORPUS.some((c) => c.kind === 'fail-open')).toBe(true);
  });

  for (const c of MOVE_INTENT_CORPUS) {
    it(`[${c.kind}] ${c.id}: "${c.text}" → ${c.expectCommand ? 'COMMAND' : 'pass-through'}`, async () => {
      const r = await classifyRelocationIntent({
        text: c.text,
        knownNicknames: NICKS,
        conversationContext: c.context,
        intelligence: scriptedProvider(c),
        minConfidence: 0.85,
      });
      expect(r.isCommand).toBe(c.expectCommand);
      if (c.expectCommand) {
        expect(r.targetNickname).toBe(c.expectedTarget);
        expect(r.intent).toBe(c.expectedIntent);
      }
    });
  }
});

describe('regression: the keyword move recognizer is gone (the standard)', () => {
  it('NicknameCommand.ts no longer ships a verb-list decision', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/core/NicknameCommand.ts'), 'utf-8');
    // The DECLARATIONS must be gone (the docstring may still narrate the history).
    expect(src).not.toContain('export function recognizeNicknameCommand');
    expect(src).not.toMatch(/const\s+TRANSFER_VERBS\s*=/);
    expect(src).not.toMatch(/const\s+PIN_VERBS\s*=/);
  });
});

// ── LIVE benchmark (opt-in): the REAL model's discrimination accuracy ──
const LIVE = process.env.INSTAR_LIVE_MOVE_INTENT === '1';
describe.skipIf(!LIVE)('move-intent discrimination corpus — LIVE model accuracy', () => {
  it('the real IntelligenceProvider discriminates command vs discussion (≥90% + both canonical cases)', async () => {
    const { buildIntelligenceProvider, frameworkFromEnv } = await import('../../src/core/intelligenceProviderFactory.js');
    const provider = buildIntelligenceProvider({ framework: frameworkFromEnv() ?? 'claude-code' });
    if (!provider) {
      console.warn('[live-move-intent] no provider available — skipping');
      return;
    }
    // The two cases whose misclassification is the exact operator harm.
    const canonical = new Set(['cmd-move-mini', 'dis-keep-laptop']);
    const scored = MOVE_INTENT_CORPUS.filter((c) => c.kind === 'command' || c.kind === 'discussion');
    let correct = 0;
    const misses: string[] = [];
    for (const c of scored) {
      const r = await classifyRelocationIntent({
        text: c.text, knownNicknames: NICKS, conversationContext: c.context, intelligence: provider, minConfidence: 0.85,
      });
      const ok = r.isCommand === c.expectCommand && (!c.expectCommand || r.targetNickname === c.expectedTarget);
      if (ok) correct++;
      else {
        misses.push(`${c.id} (got isCommand=${r.isCommand} target=${r.targetNickname})`);
        expect(canonical.has(c.id), `canonical case regressed: ${c.id}`).toBe(false);
      }
    }
    console.log(`[live-move-intent] accuracy ${correct}/${scored.length}; misses: ${misses.join('; ') || 'none'}`);
    expect(correct / scored.length).toBeGreaterThanOrEqual(0.9);
  }, 120_000);
});
