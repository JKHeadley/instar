/**
 * Gating the `general` envelope on the resolved framework.
 *
 * WHY: `ClaimClauseArbiter.arbitrate` admits `general` only when the resolved framework is
 * `claude-code`, but the prompt asked for it on EVERY call. An install whose internal
 * components route off Claude therefore generated the large envelope and discarded 100% of
 * it — and the cost of generating it pushed the call past its own `timeoutMs: 60_000`,
 * taking the legacy half (which IS consumed) down with it.
 *
 * MEASURED before writing this (2026-07-29, gpt-5.4-mini via codex, interleaved A/B so door
 * drift could not be attributed to a variant, n=3 per arm, ranges non-overlapping):
 *   full prompt      median 129,204ms   avg 8,338 output tokens   exceeded the 60s wall 3/3
 *   legacy-only      median  28,153ms   avg 1,386 output tokens   inside the 60s wall 3/3
 * The legacy-only response was separately confirmed to be valid JSON matching the legacy
 * schema, so this is a cost fix and not a capability trade.
 *
 * DISCRIMINATION, MEASURED NOT ASSUMED: this file was run against the UNFIXED source with
 * only the test staged. Result 6 failed / 4 passed. The 6 failures are the tests that
 * actually demonstrate the fix. The 4 passes are marked CONTROL and pass on BOTH revisions
 * by design — they pin back-compat and guard future drift, and are deliberately NOT counted
 * as evidence for the change. (Two of them only revealed themselves as non-discriminating
 * when the unfixed run was done, which is exactly why that run is not optional.)
 */
import { describe, it, expect } from 'vitest';
import {
  buildClaimArbiterPrompt,
  ClaimClauseArbiter,
  CLAIM_ARBITER_COMPONENT,
  CLAIM_ARBITER_PROMPT_ID,
  CLAIM_ARBITER_PROMPT_ID_LEGACY_ONLY,
} from '../../src/monitoring/ClaimClauseArbiter.js';
import { buildCompletionClaimFrameworkResolver } from '../../src/monitoring/CompletionClaimVerifier.js';
import type { TurnEvidence } from '../../src/monitoring/TurnEvidence.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const EVIDENCE: TurnEvidence = { toolCalls: [], unavailable: false, truncated: false };
const CLAUSES = ['Merged the fix.', 'I will report back once CI is green.'];
const MESSAGE = CLAUSES.join(' ');

/** Captures the prompt and the provenance the arbiter actually sent. */
function recordingProvider(reply: string) {
  const seen: { prompt?: string; promptId?: unknown } = {};
  const provider = {
    async evaluate(prompt: string, options?: Record<string, unknown>) {
      seen.prompt = prompt;
      seen.promptId = (options?.provenance as { promptId?: unknown } | undefined)?.promptId;
      const onModel = options?.onModel as ((i: { model: string; framework?: string }) => void) | undefined;
      onModel?.({ model: 'gpt-5.4-mini', framework: 'codex-cli' });
      return reply;
    },
  } as unknown as IntelligenceProvider;
  return { provider, seen };
}

const LEGACY_REPLY = JSON.stringify({
  legacy: { clauses: [
    { clauseId: 0, label: 'completed-or-in-progress-assertion', actionKind: 'merged', completionScope: 'this-turn', corroborated: false, rationale: 'x' },
    { clauseId: 1, label: 'future-commitment', actionKind: 'other', completionScope: 'none', corroborated: false, rationale: 'y' },
  ] },
});

describe('claim arbiter — general envelope is gated on the resolved framework', () => {
  it('omits the general ask AND its schema when the framework is not claude-code', () => {
    const prompt = buildClaimArbiterPrompt(CLAUSES, EVIDENCE, MESSAGE, { includeGeneral: false });
    expect(prompt).not.toContain('"general"');
    expect(prompt).not.toContain('extract up to 4 endorsed factual claims');
    expect(prompt).not.toContain('General candidates');
    // the half that IS consumed must survive untouched
    expect(prompt).toContain('"legacy"');
    expect(prompt).toContain('future-commitment|completed-or-in-progress-assertion|neither');
  });

  it('shrinks the prompt substantially — this is the whole point of the change', () => {
    const full = buildClaimArbiterPrompt(CLAUSES, EVIDENCE, MESSAGE, { includeGeneral: true });
    const lean = buildClaimArbiterPrompt(CLAUSES, EVIDENCE, MESSAGE, { includeGeneral: false });
    expect(lean.length).toBeLessThan(full.length / 2);
  });

  // CONTROL (passes on both revisions): on the unfixed source both variants are the same
  // string, so this holds trivially there. It demonstrates nothing about the fix — it is a
  // forward regression guard against the two prompts drifting apart later.
  it('CONTROL — keeps the legacy half BYTE-IDENTICAL across variants', () => {
    const full = buildClaimArbiterPrompt(CLAUSES, EVIDENCE, MESSAGE, { includeGeneral: true }).split('\n');
    const lean = buildClaimArbiterPrompt(CLAUSES, EVIDENCE, MESSAGE, { includeGeneral: false }).split('\n');
    // every lean line except its final schema line must appear verbatim, in order, in full
    const leanShared = lean.slice(0, -1);
    expect(full.slice(0, leanShared.length)).toEqual(leanShared);
  });

  it('CONTROL — defaults to including general, so a Claude-default install is unchanged', () => {
    const explicit = buildClaimArbiterPrompt(CLAUSES, EVIDENCE, MESSAGE, { includeGeneral: true });
    expect(buildClaimArbiterPrompt(CLAUSES, EVIDENCE, MESSAGE)).toBe(explicit);
    expect(buildClaimArbiterPrompt(CLAUSES, EVIDENCE, MESSAGE, {})).toBe(explicit);
    expect(explicit).toContain('"general"');
  });

  it('sends the lean prompt when the resolver reports a non-Claude framework', async () => {
    const { provider, seen } = recordingProvider(LEGACY_REPLY);
    const arb = new ClaimClauseArbiter({ intelligence: provider, resolveFramework: () => 'codex-cli' });
    const out = await arb.arbitrate(MESSAGE, EVIDENCE);
    expect(seen.prompt).not.toContain('extract up to 4 endorsed factual claims');
    expect(seen.promptId).toBe(CLAIM_ARBITER_PROMPT_ID_LEGACY_ONLY);
    // the consumed half still works end to end
    expect(out.authoritative).toBe(true);
    expect(out.clauses).toHaveLength(2);
  });

  it('CONTROL — still sends the full prompt when the resolver reports claude-code', async () => {
    const { provider, seen } = recordingProvider(LEGACY_REPLY);
    const arb = new ClaimClauseArbiter({ intelligence: provider, resolveFramework: () => 'claude-code' });
    await arb.arbitrate(MESSAGE, EVIDENCE);
    expect(seen.prompt).toContain('extract up to 4 endorsed factual claims');
    expect(seen.promptId).toBe(CLAIM_ARBITER_PROMPT_ID);
  });

  // CONTROL (passes on both revisions): the unfixed source always includes `general`, so
  // this is trivially true there. That is the point — it pins the back-compat requirement
  // that no resolver failure may ever silently disable the extractor.
  it('CONTROL — fails toward the OLD behavior on every resolver failure mode', async () => {
    const cases: Array<[string, (() => string | undefined) | undefined]> = [
      ['absent resolver', undefined],
      ['undefined framework', () => undefined],
      ['empty string', () => ''],
      ['throwing resolver', () => { throw new Error('router exploded'); }],
    ];
    for (const [label, resolveFramework] of cases) {
      const { provider, seen } = recordingProvider(LEGACY_REPLY);
      const arb = new ClaimClauseArbiter({ intelligence: provider, resolveFramework });
      await arb.arbitrate(MESSAGE, EVIDENCE);
      expect(seen.prompt, label).toContain('extract up to 4 endorsed factual claims');
      expect(seen.promptId, label).toBe(CLAIM_ARBITER_PROMPT_ID);
    }
  });
});

describe('framework resolver wiring', () => {
  /**
   * The call's `attribution.component` MUST be an inlined literal — `lint-llm-attribution`
   * reads the callsite statically and cannot resolve a constant, so hoisting it made the
   * funnel look unattributed and failed the build. The constant still drives the resolver,
   * so the two must stay equal; this pins that without letting the callsite hoist again.
   */
  it('the resolver constant equals the literal the callsite attributes with', () => {
    expect(CLAIM_ARBITER_COMPONENT).toBe('completion-claim-verify');
  });

  it('asks the router about the SAME component the call attributes to', () => {
    const asked: string[] = [];
    const router = { for: (c: string) => { asked.push(c); return { framework: 'codex-cli' }; } };
    const resolve = buildCompletionClaimFrameworkResolver(router as unknown as IntelligenceProvider);
    expect(resolve?.()).toBe('codex-cli');
    expect(asked).toEqual([CLAIM_ARBITER_COMPONENT]);
  });

  it('returns undefined for a plain provider with no routing surface', () => {
    const plain = { evaluate: async () => '' } as unknown as IntelligenceProvider;
    expect(buildCompletionClaimFrameworkResolver(plain)).toBeUndefined();
    expect(buildCompletionClaimFrameworkResolver(null)).toBeUndefined();
    expect(buildCompletionClaimFrameworkResolver(undefined)).toBeUndefined();
  });

  /**
   * WIRING INTEGRITY — the defect this file originally MISSED.
   *
   * AgentServer does not hand the verifier the router. It hands it an anonymous
   * `{ evaluate }` wrapper so the call rides the metered LLM queue, and that wrapper has no
   * routing surface. Duck-typing the injected provider therefore resolves to `undefined` in
   * production, `includeGeneral` stays true, and the whole change is inert — while every
   * other test in this file still passes, because they inject a router directly.
   *
   * That is the exact shape of "the unit tests prove the logic, and the feature is not
   * actually wired". Caught by tracing the real construction site, not by the suite.
   */
  it('WIRING — the production metering wrapper exposes no routing surface', () => {
    // shaped like AgentServer's `claimIntelligence`
    const meteringWrapper = { evaluate: async () => '' } as unknown as IntelligenceProvider;
    expect(buildCompletionClaimFrameworkResolver(meteringWrapper)).toBeUndefined();
  });

  it('WIRING — an explicitly supplied resolver survives the wrapper and reaches the arbiter', async () => {
    const { provider, seen } = recordingProvider(LEGACY_REPLY);
    // the arbiter must honour an explicit resolver even though `provider` cannot route
    const arb = new ClaimClauseArbiter({
      intelligence: provider,
      resolveFramework: buildCompletionClaimFrameworkResolver(
        { for: () => ({ framework: 'codex-cli' }) } as unknown as IntelligenceProvider,
      ),
    });
    await arb.arbitrate(MESSAGE, EVIDENCE);
    expect(seen.prompt).not.toContain('extract up to 4 endorsed factual claims');
    expect(seen.promptId).toBe(CLAIM_ARBITER_PROMPT_ID_LEGACY_ONLY);
  });

  it('swallows a throwing or malformed router rather than guessing', () => {
    const thrower = { for: () => { throw new Error('boom'); } };
    expect(buildCompletionClaimFrameworkResolver(thrower as unknown as IntelligenceProvider)?.()).toBeUndefined();

    const malformed = { for: () => ({ framework: 42 }) };
    expect(buildCompletionClaimFrameworkResolver(malformed as unknown as IntelligenceProvider)?.()).toBeUndefined();

    const nullish = { for: () => null };
    expect(buildCompletionClaimFrameworkResolver(nullish as unknown as IntelligenceProvider)?.()).toBeUndefined();
  });
});
