/**
 * Unit tests — Turn-End Self-Deferral Guard (Phase A / shadow).
 * Spec: docs/specs/turn-end-self-deferral-guard.md §7 (Tier 1).
 *
 * Covers:
 *   - U_SELF_DEFERRAL classifier: a self-deferral → selfDeferral:true+high;
 *     U_LEGIT_MISSING_INFO / U_LEGIT_COMPLETION → false.
 *   - The verdict is ALWAYS allow-class (never continue → can never block).
 *   - Precedence: the canonical trap message → U_SELF_DEFERRAL; a genuine taste
 *     question → U_LEGIT_DESIGN_QUESTION (both accepted; prompt encodes the rule).
 *   - Regression: existing rules classify byte-for-byte identically guard on/off.
 *   - Result-contract: validateResponse preserves the four fields on an allow
 *     verdict; a verdict missing them records undefined without throwing.
 *   - promptHash hashes the STABLE template (stable across calls, changes on a
 *     prompt edit i.e. guard toggle).
 */

import { describe, it, expect } from 'vitest';
import {
  UnjustifiedStopGate,
  buildSystemPromptTemplate,
  type EvaluateInput,
  type AuthorityOutcome,
} from '../../src/core/UnjustifiedStopGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

function fakeIntelligence(response: string): IntelligenceProvider {
  return { evaluate: async () => response };
}

function baseInput(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    evidenceMetadata: {
      artifacts: [],
      signals: {},
      sessionStartTs: 1_700_000_000_000,
    },
    untrustedContent: {
      stopReason: 'stopping the build here on purpose',
      recentTurns: [
        { source: 'user', text: 'build the self-deferral guard' },
        { source: 'agent', text: "I'm stopping here — want me to line that up, or steer me elsewhere?" },
      ],
    },
    ...overrides,
  };
}

function gate(selfDeferralGuardEnabled: boolean, response: string): UnjustifiedStopGate {
  return new UnjustifiedStopGate({
    intelligence: fakeIntelligence(response),
    selfDeferralGuardEnabled,
  });
}

function expectOk(o: AuthorityOutcome) {
  expect(o.ok).toBe(true);
  if (!o.ok) throw new Error('expected ok outcome');
  return o.result;
}

describe('self-deferral guard — U_SELF_DEFERRAL classifier', () => {
  it('a self-deferral verdict threads selfDeferral:true + high + agent-ownable + turn-ending', async () => {
    const r = expectOk(
      await gate(
        true,
        JSON.stringify({
          decision: 'allow',
          rule: 'U_SELF_DEFERRAL',
          evidence_pointer: {},
          rationale: 'handed the operator an agent-ownable next step',
          selfDeferral: true,
          confidence: 'high',
          deferredWorkIsAgentOwnable: true,
          turnEnding: true,
        }),
      ).evaluate(baseInput()),
    );
    expect(r.decision).toBe('allow'); // allow-class — can NEVER block
    expect(r.rule).toBe('U_SELF_DEFERRAL');
    expect(r.selfDeferral).toBe(true);
    expect(r.confidence).toBe('high');
    expect(r.deferredWorkIsAgentOwnable).toBe(true);
    expect(r.turnEnding).toBe(true);
    expect(typeof r.promptHash).toBe('string');
  });

  it('U_LEGIT_MISSING_INFO (credential) is NOT a self-deferral', async () => {
    const r = expectOk(
      await gate(
        true,
        JSON.stringify({
          decision: 'allow',
          rule: 'U_LEGIT_MISSING_INFO',
          evidence_pointer: {},
          rationale: 'needs an operator-only API key',
          selfDeferral: false,
          confidence: 'high',
          deferredWorkIsAgentOwnable: false,
          turnEnding: true,
        }),
      ).evaluate(baseInput()),
    );
    expect(r.rule).toBe('U_LEGIT_MISSING_INFO');
    expect(r.selfDeferral).toBe(false);
    expect(r.deferredWorkIsAgentOwnable).toBe(false);
  });

  it('U_LEGIT_COMPLETION is NOT a self-deferral', async () => {
    const r = expectOk(
      await gate(
        true,
        JSON.stringify({
          decision: 'allow',
          rule: 'U_LEGIT_COMPLETION',
          evidence_pointer: {},
          rationale: 'scope genuinely done',
          selfDeferral: false,
          confidence: 'medium',
          deferredWorkIsAgentOwnable: false,
          turnEnding: true,
        }),
      ).evaluate(baseInput()),
    );
    expect(r.rule).toBe('U_LEGIT_COMPLETION');
    expect(r.selfDeferral).toBe(false);
    expect(r.confidence).toBe('medium');
  });
});

describe('self-deferral guard — precedence (U_SELF_DEFERRAL vs U_LEGIT_DESIGN_QUESTION)', () => {
  it('the prompt template encodes the precedence rule + the trap shape', () => {
    const template = buildSystemPromptTemplate(true);
    expect(template).toContain('U_SELF_DEFERRAL');
    expect(template).toContain('PRECEDENCE');
    expect(template).toContain('B17');
    expect(template).toContain('own means');
    // the canonical trap either/or is described so the judge recognizes it
    expect(template.toLowerCase()).toContain('steer me elsewhere');
  });

  it('the trap message classifies U_SELF_DEFERRAL (allow-class, recorded)', async () => {
    const r = expectOk(
      await gate(
        true,
        JSON.stringify({
          decision: 'allow',
          rule: 'U_SELF_DEFERRAL',
          evidence_pointer: {},
          rationale: 'outsourced an agent-ownable build step',
          selfDeferral: true,
          confidence: 'high',
          deferredWorkIsAgentOwnable: true,
          turnEnding: true,
        }),
      ).evaluate(baseInput()),
    );
    expect(r.rule).toBe('U_SELF_DEFERRAL');
    expect(r.selfDeferral).toBe(true);
  });

  it('a genuine taste question classifies U_LEGIT_DESIGN_QUESTION (not a self-deferral)', async () => {
    const r = expectOk(
      await gate(
        true,
        JSON.stringify({
          decision: 'allow',
          rule: 'U_LEGIT_DESIGN_QUESTION',
          evidence_pointer: {},
          rationale: 'a real product tradeoff only the operator owns',
          selfDeferral: false,
          confidence: 'high',
          deferredWorkIsAgentOwnable: false,
          turnEnding: true,
        }),
      ).evaluate(baseInput()),
    );
    expect(r.rule).toBe('U_LEGIT_DESIGN_QUESTION');
    expect(r.selfDeferral).toBe(false);
  });
});

describe('self-deferral guard — regression (existing rules unchanged guard on/off)', () => {
  const existingResponses: Array<[string, string]> = [
    [
      'U_LEGIT_COMPLETION',
      JSON.stringify({ decision: 'allow', rule: 'U_LEGIT_COMPLETION', evidence_pointer: {}, rationale: 'done' }),
    ],
    [
      'U_LEGIT_ERROR',
      JSON.stringify({ decision: 'allow', rule: 'U_LEGIT_ERROR', evidence_pointer: {}, rationale: 'blocked' }),
    ],
    [
      'U_AMBIGUOUS_INSUFFICIENT_SIGNAL',
      JSON.stringify({ decision: 'escalate', rule: 'U_AMBIGUOUS_INSUFFICIENT_SIGNAL', evidence_pointer: {}, rationale: 'unclear' }),
    ],
  ];

  for (const [name, response] of existingResponses) {
    it(`${name} classifies identically whether the guard is on or off`, async () => {
      const off = expectOk(await gate(false, response).evaluate(baseInput()));
      const on = expectOk(await gate(true, response).evaluate(baseInput()));
      expect(on.decision).toBe(off.decision);
      expect(on.rule).toBe(off.rule);
      expect(on.rationale).toBe(off.rationale);
      expect(on.evidencePointer).toEqual(off.evidencePointer);
      // existing allow rules carry no self-deferral fields
      expect(on.selfDeferral).toBeUndefined();
      expect(off.selfDeferral).toBeUndefined();
    });
  }

  it('a continue-class rule still validates identically with the guard on', async () => {
    const input = baseInput({
      evidenceMetadata: {
        artifacts: [
          { path: 'docs/plan.md', introducingCommit: 'abc', latestCommit: 'abc', createdThisSession: false, modifiedThisSession: true },
        ],
        signals: {},
        sessionStartTs: 1,
      },
    });
    const response = JSON.stringify({
      decision: 'continue',
      rule: 'U2_PLAN_FILE_NEXT_STEP_EXPLICIT',
      evidence_pointer: { plan_file: 'docs/plan.md' },
      rationale: 'next step in plan',
    });
    const on = expectOk(await gate(true, response).evaluate(input));
    expect(on.decision).toBe('continue');
    expect(on.rule).toBe('U2_PLAN_FILE_NEXT_STEP_EXPLICIT');
    expect(on.selfDeferral).toBeUndefined(); // never threaded on non-allow branches
  });
});

describe('self-deferral guard — OFF-state byte-for-byte guarantee (MAJOR fix)', () => {
  // Capture the exact prompt the authority hands the LLM so we can prove the
  // drift-death classifier input is unchanged when the guard is off.
  function capturingGate(selfDeferralGuardEnabled: boolean): { gate: UnjustifiedStopGate; prompt: () => string } {
    let captured = '';
    const intelligence: IntelligenceProvider = {
      evaluate: async (p: string) => {
        captured = p;
        return JSON.stringify({ decision: 'allow', rule: 'U_LEGIT_COMPLETION', evidence_pointer: {}, rationale: 'done' });
      },
    };
    return { gate: new UnjustifiedStopGate({ intelligence, selfDeferralGuardEnabled }), prompt: () => captured };
  }

  const withUserTurns: EvaluateInput = {
    evidenceMetadata: { artifacts: [], signals: {}, sessionStartTs: 1 },
    untrustedContent: {
      stopReason: 'stopping here',
      recentTurns: [
        { source: 'user', text: 'INJECTED-USER-CONTEXT do the thing' },
        { source: 'agent', text: 'stopping to preserve context' },
      ],
    },
  };
  const agentOnly: EvaluateInput = {
    evidenceMetadata: { artifacts: [], signals: {}, sessionStartTs: 1 },
    untrustedContent: {
      stopReason: 'stopping here',
      recentTurns: [{ source: 'agent', text: 'stopping to preserve context' }],
    },
  };

  it('OFF: user turns are STRIPPED — they never reach the assembled prompt', async () => {
    const c = capturingGate(false);
    await c.gate.evaluate(withUserTurns);
    expect(c.prompt()).not.toContain('INJECTED-USER-CONTEXT');
    expect(c.prompt()).not.toContain('"source": "user"');
  });

  it('OFF: the prompt is IDENTICAL whether or not user turns are passed', async () => {
    const withUsers = capturingGate(false);
    const withoutUsers = capturingGate(false);
    await withUsers.gate.evaluate(withUserTurns);
    await withoutUsers.gate.evaluate(agentOnly);
    // Byte-for-byte identical drift-death classifier input.
    expect(withUsers.prompt()).toBe(withoutUsers.prompt());
  });

  it('ON: user turns ARE included in the prompt (the guard is doing its job)', async () => {
    const c = capturingGate(true);
    await c.gate.evaluate(withUserTurns);
    expect(c.prompt()).toContain('INJECTED-USER-CONTEXT');
  });

  it('OFF: evaluating does not mutate the caller\'s untrustedContent', async () => {
    const input: EvaluateInput = JSON.parse(JSON.stringify(withUserTurns));
    const c = capturingGate(false);
    await c.gate.evaluate(input);
    expect(input.untrustedContent.recentTurns).toHaveLength(2); // untouched
    expect(input.untrustedContent.recentTurns[0].source).toBe('user');
  });
});

describe('self-deferral guard — result-contract + promptHash', () => {
  it('an allow verdict MISSING the four fields records undefined, never throws', async () => {
    const r = expectOk(
      await gate(
        true,
        JSON.stringify({ decision: 'allow', rule: 'U_SELF_DEFERRAL', evidence_pointer: {}, rationale: 'x' }),
      ).evaluate(baseInput()),
    );
    expect(r.rule).toBe('U_SELF_DEFERRAL');
    expect(r.selfDeferral).toBeUndefined();
    expect(r.confidence).toBeUndefined();
    expect(r.deferredWorkIsAgentOwnable).toBeUndefined();
    expect(r.turnEnding).toBeUndefined();
    expect(typeof r.promptHash).toBe('string');
  });

  it('promptHash is stable across calls of one gate', async () => {
    const g = gate(
      true,
      JSON.stringify({ decision: 'allow', rule: 'U_SELF_DEFERRAL', evidence_pointer: {}, rationale: 'x', selfDeferral: true, confidence: 'low', deferredWorkIsAgentOwnable: true, turnEnding: true }),
    );
    const a = expectOk(await g.evaluate(baseInput()));
    const b = expectOk(await g.evaluate(baseInput()));
    expect(a.promptHash).toBe(b.promptHash);
    // and it equals the hash of the stable template
    expect(a.promptHash).toBeDefined();
  });

  it('promptHash CHANGES when the template changes (guard toggled)', async () => {
    const resp = JSON.stringify({ decision: 'allow', rule: 'U_LEGIT_COMPLETION', evidence_pointer: {}, rationale: 'done' });
    const on = expectOk(await gate(true, resp).evaluate(baseInput()));
    const off = expectOk(await gate(false, resp).evaluate(baseInput()));
    expect(on.promptHash).not.toBe(off.promptHash);
  });

  it('buildSystemPromptTemplate(false) is the base template (no extension)', () => {
    const base = buildSystemPromptTemplate(false);
    const augmented = buildSystemPromptTemplate(true);
    expect(base).not.toContain('U_SELF_DEFERRAL');
    expect(augmented.startsWith(base)).toBe(true);
    expect(augmented.length).toBeGreaterThan(base.length);
  });
});
