/**
 * Integration test for the Anthropic clean-door reviewer through the driver's
 * code paths (REVIEWER-DOOR-REWIRING §Testing — the `cross-model-review.mjs
 * --family claude-code` and `--detect-only` paths). Exercises the full seam the
 * script wraps: trusted-allowlist gate → config gate (active set) → the claude
 * entry's hardened review → the `clean-door-anthropic-review` flag shape, and
 * confirms `--detect-only` carries the family ONLY when enabled. Hermetic — a
 * stub provider replaces the real spawn; the config is injected (the script reads
 * the same shape from `.instar/config.json`).
 */

import { describe, it, expect } from 'vitest';
import {
  resolveActiveReviewerFrameworks,
  detectAllCrossModelReviewers,
  isTrustedReviewerFramework,
  runCrossModelReview,
  assembleReviewerPrompt,
  aggregateRoundOutcomes,
  type ReviewerConfig,
  type ReviewerResult,
} from '../../src/core/crossModelReviewer.js';

const DEV: ReviewerConfig = { developmentAgent: true };

function stub(reply: string) {
  return { evaluate: async () => reply };
}

/** Mirror the script's `--family` path: allowlist gate → active-set lookup → review. */
async function runFamily(family: string, config: ReviewerConfig, provider: { evaluate(): Promise<string> }): Promise<ReviewerResult | { refused: string }> {
  if (!isTrustedReviewerFramework(family)) return { refused: 'untrusted-framework' };
  const entry = resolveActiveReviewerFrameworks(config).find((f) => f.id === family);
  if (!entry) return { refused: 'no-supported-framework' };
  return entry.review({
    promptText: 'review this spec',
    timeoutMs: 120_000,
    providerOverride: provider,
    reviewerConfig: config,
    hardeningSupportedOverride: true,
  });
}

describe('driver --family claude-code path (enabled)', () => {
  it('accepted by the trusted allowlist and emits the clean-door flag, NEVER cross-model', async () => {
    const r = (await runFamily('claude-code', DEV, stub('Verdict: MINOR ISSUES\nlgtm-ish'))) as ReviewerResult;
    expect(r.status).toBe('ok');
    expect(r.framework).toBe('claude-code');
    expect(r.crossFamily).toBe(false);
    expect(r.flag).toBe('clean-door-anthropic-review: claude-code:claude-fable-5');
    expect(r.flag).not.toContain('cross-model-review:');
  });

  it('on the FLEET (no config) --family claude-code is refused — trusted-egress ≠ enabled', async () => {
    const r = await runFamily('claude-code', {}, stub('x'));
    expect(r).toEqual({ refused: 'no-supported-framework' });
  });

  it('a copy-paste of the flag into frontmatter cannot forge the cross-model field', async () => {
    const r = (await runFamily('claude-code', DEV, stub('Verdict: CLEAN'))) as ReviewerResult;
    // even folded through the spec-level aggregate, a claude-only round is never a clean cross-model flag
    const agg = aggregateRoundOutcomes([r]);
    expect(agg.flag).not.toContain('cross-model-review: claude');
    expect(agg.status).not.toBe('available');
  });
});

describe('driver --detect-only path — family present only when enabled', () => {
  const inputs = {
    codexPathDetected: null,
    geminiPathDetected: null,
    claudePathDetected: '/bin/claude',
    claudeConfigHomePresent: true,
    enabledFrameworks: ['claude-code'],
  };

  it('DEV agent: detect-only carries claude-code', () => {
    const all = detectAllCrossModelReviewers(inputs, DEV);
    expect(all.some((d) => d.framework === 'claude-code')).toBe(true);
  });

  it('FLEET (no config): detect-only does NOT carry claude-code', () => {
    const all = detectAllCrossModelReviewers(inputs, {});
    expect(all.some((d) => d.framework === 'claude-code')).toBe(false);
  });
});

describe('runCrossModelReview honors the config gate', () => {
  it('with only claude available + DEV enabled, the run produces the clean-door disclosure (crossFamily:false)', async () => {
    const assembled = assembleReviewerPrompt({
      reviewerTemplate: 'Review {SPEC_PATH}.',
      specMarkdown: '# spec',
      specPath: 'docs/specs/x.md',
    });
    const r = await runCrossModelReview({
      assembled,
      config: DEV,
      detectInputs: {
        codexPathDetected: null,
        geminiPathDetected: null,
        claudePathDetected: '/bin/claude',
        claudeConfigHomePresent: true,
      },
      // runCrossModelReview does not thread hardeningSupportedOverride, so this
      // exercises the real preflight; on a host without claude it degrades
      // (hardening-unsupported / provider-unavailable) — still crossFamily:false,
      // still the clean-door flag, never a cross-model flag.
      providerOverride: stub('Verdict: CLEAN'),
    });
    expect(r.crossFamily).toBe(false);
    expect(r.flag).toContain('clean-door-anthropic-review:');
    expect(r.flag).not.toContain('cross-model-review:');
  });

  it('on the FLEET (no config) with only claude installed, the run is unavailable (claude not active)', async () => {
    const assembled = assembleReviewerPrompt({
      reviewerTemplate: 'Review {SPEC_PATH}.',
      specMarkdown: '# spec',
      specPath: 'docs/specs/x.md',
    });
    const r = await runCrossModelReview({
      assembled,
      config: {},
      detectInputs: { codexPathDetected: null, geminiPathDetected: null, claudePathDetected: '/bin/claude', claudeConfigHomePresent: true },
    });
    expect(r.status).toBe('unavailable');
  });
});
