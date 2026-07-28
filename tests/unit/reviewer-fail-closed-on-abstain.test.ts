/**
 * reviewer-fail-closed-on-abstain (CMT-1794) — core behavior.
 *
 * The audit found that when a coherence reviewer's LLM call errors/times out/
 * returns unparseable output, the base CoherenceReviewer resolved with a
 * permissive `pass:true` and CoherenceGate counted it as a GENUINE PASS (it only
 * abstain-counted a promise REJECTION, and review() catches internally). So the
 * highest-stakes outbound checks silently passed on an LLM blip.
 *
 * These tests prove the fix: an errored/unparseable reviewer is an ABSTAIN
 * (not a pass) — on an EXTERNAL channel that fails the turn CLOSED (held); on an
 * INTERNAL channel it stays fail-open-with-report (the existing ALL_ABSTAIN
 * channel policy, Decision D). An abstain is never reported as a clean PASS.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CoherenceGate } from '../../src/core/CoherenceGate.js';
import type { ResponseReviewConfig, IntelligenceProvider } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;

/**
 * Mock provider: the FIRST call (the triage 'gate' reviewer) returns
 * needsReview:true so the full dimension panel runs; every SUBSEQUENT call (the
 * dimension reviewers) THROWS a generic provider error — i.e. every dimension
 * reviewer abstains. (A generic error, NOT a capacity shed, so this exercises
 * the new abstain path, not the pre-existing capacity-shed fail-closed.)
 */
function makeAllAbstainIntelligence(): IntelligenceProvider {
  let idx = 0;
  return {
    evaluate: vi.fn().mockImplementation(async () => {
      const i = idx++;
      if (i === 0) return JSON.stringify({ needsReview: true, reason: 'has claims' });
      throw new Error('transport flake'); // generic provider error → reviewer abstains
    }),
  } as unknown as IntelligenceProvider;
}

function config(): ResponseReviewConfig {
  return {
    enabled: true,
    reviewers: {
      'claim-provenance': { enabled: true, mode: 'block' }, // a floor reviewer
      'value-alignment': { enabled: true, mode: 'block' }, // a floor reviewer
      'url-validity': { enabled: true, mode: 'block' }, // a floor reviewer
      'conversational-tone': { enabled: true, mode: 'block' },
    },
  } as ResponseReviewConfig;
}

// A benign message with NO credentials (passes PEL) and >50 chars (so the gate
// runs the full review rather than the short-message skip).
const MSG = 'Here is a normal, friendly status update about the project that is comfortably over fifty characters long.';

describe('reviewer-fail-closed-on-abstain — core', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfc-abstain-'));
    fs.writeFileSync(path.join(tmpDir, 'AGENT.md'), '# Test Agent\n## Intent\n- Be helpful\n- Be accurate');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/reviewer-fail-closed-on-abstain.test.ts' });
  });

  function gate(): CoherenceGate {
    return new CoherenceGate({ config: config(), stateDir: tmpDir, intelligence: makeAllAbstainIntelligence() });
  }

  it('EXTERNAL channel: all reviewers abstain (errored) → fail CLOSED (pass:false), NOT a silent pass', async () => {
    const r = await gate().evaluate({
      message: MSG,
      sessionId: 'ext-1',
      stopHookActive: false,
      context: { channel: 'telegram', isExternalFacing: true },
    });
    expect(r.pass).toBe(false); // held — the bug was this returning pass:true
  });

  it('INTERNAL channel: all reviewers abstain → fail OPEN with report (pass:true) — Decision D', async () => {
    const r = await gate().evaluate({
      message: MSG,
      sessionId: 'int-1',
      stopHookActive: false,
      context: { channel: 'direct', isExternalFacing: false },
    });
    expect(r.pass).toBe(true); // internal availability preserved; abstain reported, not blocked
  });

  it('an abstain is never reported as a clean PASS verdict on an external channel', async () => {
    const r = await gate().evaluate({
      message: MSG,
      sessionId: 'ext-2',
      stopHookActive: false,
      context: { channel: 'telegram', isExternalFacing: true },
    });
    // The outcome must reflect the held/abstain disposition, never a clean pass.
    expect(r.pass).toBe(false);
    expect(r._outcome === 'pass').toBe(false);
  });

  // NOTE (build): the single-critical-abstain-while-others-pass case (the
  // highCritTimeout path the kill-switch §4 governs) + the kill-switch OFF revert
  // need a PROMPT-AWARE mock (throw only for a named FLOOR reviewer's prompt) so
  // the test isn't fragile to reviewer fire-order. Added with the integration
  // tier. The kill-switch code path (getFailClosedOnCriticalAbstain + the gated
  // highCritTimeout) is implemented + typecheck-clean; the all-abstain external
  // block above already exercises the abstain→fail-closed core.
});
