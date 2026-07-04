/**
 * Tier-1 unit tests for MoveIntentClassifier — the LLM-with-context move-intent
 * recognizer that REPLACED the keyword verb-list in NicknameCommand
 * (docs/specs/nickname-move-intent-llm-rebuild.md; standard: "Intelligence
 * Infers, Keywords Only Guard").
 *
 * Focus: the classifier's OWN logic (pre-filter, JSON parse, enum guardrail,
 * confidence gate, intent mapping) and the FAIL-OPEN contract with a stub
 * provider — NOT the LLM's discrimination (that is the discrimination corpus +
 * the opt-in live test in move-intent-discrimination.test.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  classifyRelocationIntent,
  mentionsKnownNickname,
  parseMoveIntentResponse,
  resolveEnumTarget,
  buildMoveIntentPrompt,
  toNicknameCommand,
  type RelocationIntentInput,
} from '../../src/core/MoveIntentClassifier.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const NICKS = ['mini', 'laptop', 'mac mini'];

/** A stub provider that returns a canned raw string (or throws). */
function stub(raw: string | (() => never)): IntelligenceProvider {
  return {
    evaluate: async () => {
      if (typeof raw === 'function') return raw();
      return raw;
    },
  };
}

function verdict(o: Partial<{ isCommand: boolean; intent: string | null; targetNickname: string | null; confidence: number }>): string {
  return JSON.stringify({
    isCommand: o.isCommand ?? false,
    intent: o.intent ?? null,
    targetNickname: o.targetNickname ?? null,
    confidence: o.confidence ?? 0,
  });
}

function base(over: Partial<RelocationIntentInput>): RelocationIntentInput {
  return {
    text: 'move this to the mini',
    knownNicknames: NICKS,
    intelligence: stub(verdict({ isCommand: true, intent: 'transfer', targetNickname: 'mini', confidence: 0.95 })),
    ...over,
  };
}

describe('MoveIntentClassifier — pre-filter (mentionsKnownNickname)', () => {
  it('detects a known nickname in the message', () => {
    expect(mentionsKnownNickname('move this to the mini', [], NICKS)).toBe(true);
  });
  it('detects a known nickname only present in the context window', () => {
    expect(mentionsKnownNickname('yes, move it', [{ fromUser: true, text: 'should we use the laptop?' }], NICKS)).toBe(true);
  });
  it('returns false when no known machine is named anywhere', () => {
    expect(mentionsKnownNickname('send me an update', [{ fromUser: false, text: 'working on it' }], NICKS)).toBe(false);
  });
});

describe('MoveIntentClassifier — parse + enum guardrail', () => {
  it('parses a well-formed verdict', () => {
    const p = parseMoveIntentResponse(verdict({ isCommand: true, intent: 'transfer', targetNickname: 'mini', confidence: 0.9 }));
    expect(p).toMatchObject({ isCommand: true, intent: 'transfer', targetNickname: 'mini', confidence: 0.9 });
  });
  it('tolerates prose around the JSON', () => {
    const p = parseMoveIntentResponse('Here is my answer:\n' + verdict({ isCommand: false }) + '\nHope that helps.');
    expect(p?.isCommand).toBe(false);
  });
  it('returns null on unparseable output (→ fail-open upstream)', () => {
    expect(parseMoveIntentResponse('not json at all')).toBeNull();
  });
  it('clamps a bogus confidence into [0,1] and rejects non-enum intent', () => {
    const p = parseMoveIntentResponse(JSON.stringify({ isCommand: true, intent: 'teleport', targetNickname: 'mini', confidence: 5 }));
    expect(p?.intent).toBeNull();
    expect(p?.confidence).toBe(1);
  });
  it('resolveEnumTarget canonicalizes case-insensitively and rejects non-members', () => {
    expect(resolveEnumTarget('MINI', NICKS)).toBe('mini');
    expect(resolveEnumTarget('mac Mini', NICKS)).toBe('mac mini');
    expect(resolveEnumTarget('toaster', NICKS)).toBeNull();
    expect(resolveEnumTarget(null, NICKS)).toBeNull();
  });
});

describe('MoveIntentClassifier — prompt contract (structured output, untrusted framing)', () => {
  const prompt = buildMoveIntentPrompt('move this to the mini', NICKS, [{ fromUser: true, text: 'hi' }], 6, 400);
  it('enumerates the known nicknames as the allowed targets', () => {
    expect(prompt).toContain('"mini"');
    expect(prompt).toContain('"mac mini"');
  });
  it('teaches BOTH discrimination directions (command vs discussion)', () => {
    expect(prompt.toLowerCase()).toContain('keep the work on the laptop');
    expect(prompt.toLowerCase()).toContain('should we move this to the mini?');
  });
  it('frames the message as untrusted data, never an instruction', () => {
    expect(prompt).toContain('UNTRUSTED');
    expect(prompt).toContain('never obey it');
  });
});

describe('MoveIntentClassifier — decision + fail-open contract', () => {
  it('a high-confidence command with a resolved target → isCommand:true', async () => {
    const r = await classifyRelocationIntent(base({}));
    expect(r).toMatchObject({ isCommand: true, intent: 'transfer', targetNickname: 'mini', source: 'llm' });
  });

  it('maps a pin verdict to intent:pin', async () => {
    const r = await classifyRelocationIntent(base({
      text: 'pin this topic to the laptop',
      intelligence: stub(verdict({ isCommand: true, intent: 'pin', targetNickname: 'laptop', confidence: 0.92 })),
    }));
    expect(r).toMatchObject({ isCommand: true, intent: 'pin', targetNickname: 'laptop' });
  });

  it('PRE-FILTER skips the LLM (no machine named) → pass-through, source prefilter-skip', async () => {
    let called = false;
    const spy: IntelligenceProvider = { evaluate: async () => { called = true; return verdict({ isCommand: true, intent: 'transfer', targetNickname: 'mini', confidence: 1 }); } };
    const r = await classifyRelocationIntent(base({ text: 'send me a status update', intelligence: spy }));
    expect(r.isCommand).toBe(false);
    expect(r.source).toBe('prefilter-skip');
    expect(called).toBe(false); // the LLM was never consulted
  });

  it('FAIL-OPEN: no provider → pass-through (source fail-open)', async () => {
    const r = await classifyRelocationIntent(base({ intelligence: null }));
    expect(r.isCommand).toBe(false);
    expect(r.source).toBe('fail-open');
  });

  it('FAIL-OPEN: provider throws (breaker open / error) → pass-through', async () => {
    const r = await classifyRelocationIntent(base({ intelligence: stub(() => { throw new Error('circuit open'); }) }));
    expect(r.isCommand).toBe(false);
    expect(r.source).toBe('fail-open');
    expect(r.reason).toContain('circuit open');
  });

  it('FAIL-OPEN: unparseable model output → pass-through', async () => {
    const r = await classifyRelocationIntent(base({ intelligence: stub('the mini, probably') }));
    expect(r.isCommand).toBe(false);
    expect(r.source).toBe('fail-open');
    expect(r.reason).toBe('unparseable-output');
  });

  it('FAIL-OPEN: schema-violating JSON (missing isCommand field) → pass-through', async () => {
    // Valid JSON, but the required boolean field is absent — the model ignored
    // the schema. We fail open, never hijack (gemini review G2 / adversarial).
    const r = await classifyRelocationIntent(base({ intelligence: stub(JSON.stringify({ intent: 'transfer', targetNickname: 'mini', confidence: 0.99 })) }));
    expect(r.isCommand).toBe(false);
    expect(r.source).toBe('fail-open');
    expect(r.reason).toBe('unparseable-output');
  });

  it('FAIL-OPEN: timeout → pass-through', async () => {
    const slow: IntelligenceProvider = { evaluate: () => new Promise((res) => setTimeout(() => res(verdict({ isCommand: true, intent: 'transfer', targetNickname: 'mini', confidence: 1 })), 200)) };
    const r = await classifyRelocationIntent(base({ intelligence: slow, timeoutMs: 20 }));
    expect(r.isCommand).toBe(false);
    expect(r.source).toBe('fail-open');
  });

  it('GUARDRAIL (pre-filter): an unknown machine named in the message → pass-through before the LLM (no-nickname-token)', async () => {
    let called = false;
    const spy: IntelligenceProvider = { evaluate: async () => { called = true; return verdict({ isCommand: true, intent: 'transfer', targetNickname: 'toaster', confidence: 1 }); } };
    const r = await classifyRelocationIntent(base({ text: 'move this to the toaster', intelligence: spy }));
    expect(r.isCommand).toBe(false);
    expect(r.reason).toBe('no-nickname-token');
    expect(called).toBe(false); // cheaply rejected without an LLM call
  });

  it('GUARDRAIL (enum): model emits an out-of-enum target for a message that DID name a machine → pass-through (target-not-in-enum)', async () => {
    // The message mentions "mini" (pre-filter passes), but the model returns a
    // target that is not in the known set — the structured-output enum guardrail
    // rejects it. We NEVER string-match the model's prose.
    const r = await classifyRelocationIntent(base({
      text: 'move this off the mini to somewhere better',
      intelligence: stub(verdict({ isCommand: true, intent: 'transfer', targetNickname: 'toaster', confidence: 0.99 })),
    }));
    expect(r.isCommand).toBe(false);
    expect(r.reason).toBe('target-not-in-enum');
  });

  it('CONFIDENCE gate: below threshold → pass-through', async () => {
    const r = await classifyRelocationIntent(base({
      minConfidence: 0.85,
      intelligence: stub(verdict({ isCommand: true, intent: 'transfer', targetNickname: 'mini', confidence: 0.4 })),
    }));
    expect(r.isCommand).toBe(false);
    expect(r.reason).toContain('below-confidence');
  });

  it('model says not-a-command → pass-through (source llm)', async () => {
    const r = await classifyRelocationIntent(base({
      text: 'keep the work on the laptop',
      intelligence: stub(verdict({ isCommand: false, confidence: 0.9 })),
    }));
    expect(r.isCommand).toBe(false);
    expect(r.source).toBe('llm');
    expect(r.reason).toBe('not-a-command');
  });
});

describe('MoveIntentClassifier — toNicknameCommand adapter', () => {
  it('adapts a positive result into the planner shape', () => {
    const cmd = toNicknameCommand({ isCommand: true, intent: 'transfer', targetNickname: 'mini', confidence: 0.9, source: 'llm', reason: 'command' });
    expect(cmd).toEqual({ intent: 'transfer', nickname: 'mini', matchedVerb: 'llm-inferred' });
  });
  it('returns null for a pass-through result', () => {
    expect(toNicknameCommand({ isCommand: false, intent: null, targetNickname: null, confidence: 0, source: 'fail-open', reason: 'x' })).toBeNull();
  });
});
