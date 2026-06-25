/**
 * Unit tests for the gate-prompts-judge-by-meaning reason-gate surfaces that
 * are DETERMINISTIC (and therefore unit-testable without a live model):
 *   - the §Design 1 structured-intermediate: verdict DERIVED from the model's
 *     own structured fields, and a contradictory structured verdict re-prompts
 *     then fails closed;
 *   - the §Design 1a agentState signal rendered into the prompt (own boundary,
 *     time-box scope) and absent → meaning-only;
 *   - the structuredContradiction pure function (both sides).
 *
 * The B15 SEMANTIC judgment itself (does THIS prose express the intent?) is the
 * remote model's call — observed in production telemetry, not unit-mocked. These
 * tests pin the deterministic scaffold around it, mirroring the established
 * tone-gate test pattern (canned model output → assert the gate's handling).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MessagingToneGate,
  structuredContradiction,
  type StructuredVerdict,
} from '../../src/core/MessagingToneGate.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

function captureProvider(response: object | (() => object)) {
  let lastPrompt = '';
  const provider: IntelligenceProvider = {
    evaluate: vi.fn(async (prompt: string, _o?: IntelligenceOptions) => {
      lastPrompt = prompt;
      return JSON.stringify(typeof response === 'function' ? (response as () => object)() : response);
    }),
  };
  return { provider, getPrompt: () => lastPrompt };
}

const sv = (over: Partial<StructuredVerdict> = {}): StructuredVerdict => ({
  proposed_stop: false,
  deferred_items: [],
  stop_reason_kind: 'none',
  agent_state_reason_present: false,
  external_blocker_present: false,
  ...over,
});

describe('MessagingToneGate — structured-intermediate reason-gate (§Design 1)', () => {
  it('DERIVES a B15 block from the model\'s own structured fields even if it set pass:true', async () => {
    const { provider } = captureProvider({
      pass: true, // model under-resolved the verdict…
      rule: '',
      issue: '',
      suggestion: '',
      structured: sv({ proposed_stop: true, agent_state_reason_present: true, stop_reason_kind: 'agent-state', deferred_items: ['the migration'] }),
    });
    const gate = new MessagingToneGate(provider);
    const r = await gate.review('Parking the migration to pick up fresh tomorrow.', { channel: 'telegram' });
    expect(r.pass).toBe(false); // …the structured fields are the ground truth → BLOCK
    expect(r.rule).toBe('B15_CONTEXT_DEATH_STOP');
  });

  it('PASSES when a stop is proposed for a non-agent-state reason (structured says external)', async () => {
    const { provider } = captureProvider({
      pass: true,
      rule: '',
      issue: '',
      suggestion: '',
      structured: sv({ proposed_stop: true, agent_state_reason_present: false, external_blocker_present: true, stop_reason_kind: 'external-blocker', deferred_items: ['the deploy'] }),
    });
    const gate = new MessagingToneGate(provider);
    const r = await gate.review('Rate-limited until the reset; resuming the deploy then.', { channel: 'telegram' });
    expect(r.pass).toBe(true);
  });

  it('re-prompts once then FAILS CLOSED on a contradictory structured verdict', async () => {
    const { provider } = captureProvider({
      pass: true,
      rule: '',
      issue: '',
      suggestion: '',
      structured: sv({ proposed_stop: false, deferred_items: ['the hard part'] }), // contradiction
    });
    const gate = new MessagingToneGate(provider);
    const r = await gate.review('continuing, mostly', { channel: 'telegram' });
    expect(r.pass).toBe(false);
    expect(r.failedClosed).toBe(true);
    expect((provider.evaluate as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2); // one re-prompt
  });

  it('a normal verdict with NO structured block passes through unchanged (back-compat)', async () => {
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    const r = await gate.review('Here is your answer.', { channel: 'telegram' });
    expect(r.pass).toBe(true);
    expect(r.failedClosed).toBeFalsy();
  });
});

describe('MessagingToneGate — agentState signal (§Design 1a)', () => {
  it('renders the agentState block (own boundary, time-box scope) when provided', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('near my limit, wrapping up', {
      channel: 'telegram',
      agentState: { sessionElapsedMs: 60_000, sessionRemainingMs: 3_600_000, isTimeBoxed: true },
    });
    const p = getPrompt();
    expect(p).toContain('AGENT STATE');
    expect(p).toMatch(/TIME-BOX claims ONLY/i);
    expect(p).toContain('"sessionRemainingMs":3600000');
  });

  it('renders the absent-signal note (meaning-only) when no agentState is provided', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('any', { channel: 'telegram' });
    expect(getPrompt()).toMatch(/no deterministic agent-state signal available/i);
  });
});

describe('structuredContradiction (pure)', () => {
  it('flags proposed_stop:false with deferred items', () => {
    expect(structuredContradiction(sv({ proposed_stop: false, deferred_items: ['x'] }))).toBe(true);
  });
  it('flags agent-state reason with a completion/none stop kind', () => {
    expect(structuredContradiction(sv({ agent_state_reason_present: true, stop_reason_kind: 'completion' }))).toBe(true);
    expect(structuredContradiction(sv({ agent_state_reason_present: true, stop_reason_kind: 'none' }))).toBe(true);
  });
  it('flags proposed_stop with stop_reason_kind none', () => {
    expect(structuredContradiction(sv({ proposed_stop: true, stop_reason_kind: 'none' }))).toBe(true);
  });
  it('accepts a coherent agent-state stop', () => {
    expect(structuredContradiction(sv({ proposed_stop: true, agent_state_reason_present: true, stop_reason_kind: 'agent-state', deferred_items: ['x'] }))).toBe(false);
  });
  it('accepts a coherent no-stop status disclosure', () => {
    expect(structuredContradiction(sv({ proposed_stop: false }))).toBe(false);
  });
});
