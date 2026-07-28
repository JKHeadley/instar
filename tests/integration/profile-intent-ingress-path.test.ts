/**
 * Integration: the inbound topic-profile-intent path end-to-end —
 * classifier → patch → write-surface validation.
 *
 * `handleTopicProfileIngress` (server.ts) runs exactly this chain when
 * parseProfileTrigger returns null:
 *   classifyProfileIntent → (willAct gate) → toProfilePatch → applyWrite.
 * `applyWrite` re-validates the patch via `validateProfileFields` against the
 * closed enums before any respawn. This test composes those real units (no
 * server spawn) to prove the DECISION flows into an ACCEPTED patch: a genuine
 * command yields a valid framework/model/thinking patch; discussion / fail-open
 * yields no patch (the message passes through to the agent); and the dry-run
 * gate withholds action while still classifying. It is the regression guard for
 * the exact 2026-07-03 keyword-intent hijack class (offender #1).
 */
import { describe, it, expect } from 'vitest';
import {
  classifyProfileIntent,
  toProfilePatch,
} from '../../src/core/ProfileIntentClassifier.js';
import { validateProfileFields } from '../../src/core/topicProfileValidation.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

function stub(raw: string): IntelligenceProvider {
  return { evaluate: async () => raw };
}
function verdict(o: object): string { return JSON.stringify(o); }

/** Mirror of the wiring's decision: act only on a change AND not in dry-run. */
async function profileDecision(text: string, intelligence: IntelligenceProvider, dryRun: boolean) {
  const result = await classifyProfileIntent({ text, intelligence, minConfidence: 0.85 });
  const willAct = result.isChange && !dryRun;
  if (!willAct) return { handled: false as const, result };
  const patch = toProfilePatch(result);
  if (!patch) return { handled: false as const, result };
  // The write surface's validation arm — the profile's currently-resolved
  // framework is claude-code here (the topic's effective framework).
  const validated = validateProfileFields(patch, 'claude-code');
  return { handled: true as const, result, patch, validated };
}

describe('inbound profile-intent path — decision → validated patch', () => {
  it('a real framework command actuates: classifier → framework patch → accepted by the write surface', async () => {
    const provider = stub(verdict({ isChange: true, intent: 'framework', value: 'codex-cli', confidence: 0.96 }));
    const out = await profileDecision('use codex here', provider, /* dryRun */ false);
    expect(out.handled).toBe(true);
    expect(out.patch).toEqual({ framework: 'codex-cli' });
    expect(out.validated!.ok).toBe(true);
  });

  it('a thinking command actuates a valid thinkingMode patch', async () => {
    const provider = stub(verdict({ isChange: true, intent: 'thinking', value: 'high', confidence: 0.93 }));
    const out = await profileDecision('set high thinking on this topic', provider, false);
    expect(out.handled).toBe(true);
    expect(out.patch).toEqual({ thinkingMode: 'high' });
    expect(out.validated!.ok).toBe(true);
  });

  it('THE HIJACK REGRESSION: "should we use codex here?" is discussion → NOT handled (message passes through)', async () => {
    const provider = stub(verdict({ isChange: false, confidence: 0.92 }));
    const out = await profileDecision('should we use codex here?', provider, false);
    expect(out.handled).toBe(false); // the question now reaches the agent, never actuates a respawn
    expect(out.result.isChange).toBe(false);
  });

  it('commentary is discussion → NOT handled', async () => {
    const provider = stub(verdict({ isChange: false, confidence: 0.9 }));
    const out = await profileDecision('codex here keeps failing', provider, false);
    expect(out.handled).toBe(false);
  });

  it('FAIL-OPEN: provider down → NOT handled (never actuate under uncertainty)', async () => {
    const provider: IntelligenceProvider = { evaluate: async () => { throw new Error('down'); } };
    const out = await profileDecision('use codex here', provider, false);
    expect(out.handled).toBe(false);
    expect(out.result.source).toBe('fail-open');
  });

  it('DRY-RUN: a real command is classified as a change but NOT acted on (soak)', async () => {
    const provider = stub(verdict({ isChange: true, intent: 'framework', value: 'codex-cli', confidence: 0.96 }));
    const out = await profileDecision('use codex here', provider, /* dryRun */ true);
    expect(out.result.isChange).toBe(true); // would-actuate recorded
    expect(out.handled).toBe(false);         // but the message passes through
  });

  it('GUARDRAIL: out-of-enum framework → NOT handled even though the model claimed a change', async () => {
    const provider = stub(verdict({ isChange: true, intent: 'framework', value: 'rustlang-cli', confidence: 0.99 }));
    const out = await profileDecision('use rustlang here', provider, false);
    expect(out.handled).toBe(false); // no known framework → no actuation
    expect(out.result.isChange).toBe(false);
  });
});
