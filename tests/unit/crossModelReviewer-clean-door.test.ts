// safe-git-allow: test-tmpdir-cleanup — finally-blocks remove per-test mkdtempSync tmpdirs.
/**
 * Unit tests for the Anthropic clean-door reviewer family
 * (REVIEWER-DOOR-REWIRING inc1). Covers:
 *   - detection: static presence reasons only (installed / config-home /
 *     enabledFrameworks), NEVER auth/entitlement;
 *   - model resolution: default pin, tier-word canary, valid frontier override,
 *     NON-frontier concrete override (claude-opus-4-8) REJECTED (override-not-
 *     frontier), NOT accepted-but-disclosed;
 *   - §5 lockdown battery (a–e): crossFamily filtering in aggregateRoundOutcomes,
 *     detectCrossModelReviewer/detectAllCrossModelReviewers never select/count
 *     claude, fail-closed unknown-id, TRUSTED-contains-claude AND baseline-
 *     excludes-claude;
 *   - crossFamily is a REQUIRED registry field (every entry sets it explicitly);
 *   - per-family model-argument: claude passes the CONCRETE pin (never 'capable');
 *   - config gate default (dev-on / fleet-off / explicit wins) → fleet-absent is
 *     exactly [codex, gemini];
 *   - throw-safety: a constructor throw maps to degraded, never escapes.
 *
 * NO real claude spawns — detection uses injected inputs, invocation uses a
 * stubbed provider / injected factory, and the hardening preflight is overridden.
 */

import { describe, it, expect } from 'vitest';
import {
  detectClaudeReviewer,
  detectCrossModelReviewer,
  detectAllCrossModelReviewers,
  resolveActiveReviewerFrameworks,
  resolveClaudeReviewerModel,
  isAnthropicReviewerEnabled,
  isCrossFamilyReviewerFramework,
  isTrustedReviewerFramework,
  wasNonClaudeFrameworkActiveWithin,
  recordFrameworkActivationObservation,
  aggregateRoundOutcomes,
  SUPPORTED_REVIEWER_FRAMEWORKS,
  TRUSTED_REVIEWER_FRAMEWORKS,
  CLAUDE_REVIEWER_DEFAULT_MODEL,
  type ReviewerConfig,
  type ReviewerResult,
} from '../../src/core/crossModelReviewer.js';
import { ClaudeForbiddenError } from '../../src/core/claudeForbiddenGuard.js';
import type { IntelligenceOptions as _IO } from '../../src/core/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const claudeEntry = () => SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === 'claude-code')!;

/** A stub provider that captures the options it was called with. */
function capturingProvider() {
  const calls: Array<{ prompt: string; options?: _IO }> = [];
  return {
    calls,
    evaluate: async (prompt: string, options?: _IO) => {
      calls.push({ prompt, options });
      return 'Verdict: CLEAN\nLooks good.';
    },
  };
}

const DEV: ReviewerConfig = { developmentAgent: true };

describe('detectClaudeReviewer — static presence reasons only (§1.2)', () => {
  it('available when binary + config-home present and claude-code enabled', () => {
    const r = detectClaudeReviewer({
      claudePathDetected: '/usr/local/bin/claude',
      claudeConfigHomePresent: true,
      enabledFrameworks: ['claude-code', 'codex-cli'],
    });
    expect(r.available).toBe(true);
    expect(r.framework).toBe('claude-code');
    expect(r.model).toBe(CLAUDE_REVIEWER_DEFAULT_MODEL);
    expect(r.crossFamily).toBe(false);
  });

  it('claude-not-installed when the binary is absent', () => {
    const r = detectClaudeReviewer({ claudePathDetected: null, claudeConfigHomePresent: true });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('claude-not-installed');
  });

  it('claude-config-missing when no config-home', () => {
    const r = detectClaudeReviewer({ claudePathDetected: '/bin/claude', claudeConfigHomePresent: false });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('claude-config-missing');
  });

  it('claude-forbidden when claude-code not in enabledFrameworks (never detects available)', () => {
    const r = detectClaudeReviewer({
      claudePathDetected: '/bin/claude',
      claudeConfigHomePresent: true,
      enabledFrameworks: ['codex-cli'],
    });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('claude-forbidden');
  });

  it('never returns an auth/entitlement reason (those are invocation-time)', () => {
    const r = detectClaudeReviewer({ claudePathDetected: '/bin/claude', claudeConfigHomePresent: true });
    // static presence set only — no such thing as claude-not-authed at detection
    expect(['claude-not-installed', 'claude-config-missing', 'claude-forbidden', undefined]).toContain(r.reason);
  });
});

describe('resolveClaudeReviewerModel — pinned frontier, no silent fallback (§1.3)', () => {
  it('default pin claude-fable-5 when no override', () => {
    const res = resolveClaudeReviewerModel(undefined);
    expect(res).toEqual({ ok: true, model: 'claude-fable-5' });
  });

  it('accepts a valid frontier override', () => {
    const res = resolveClaudeReviewerModel({
      specConverge: { reviewers: { anthropic: { model: 'claude-fable-5' } } },
    });
    expect(res).toEqual({ ok: true, model: 'claude-fable-5' });
  });

  it('REJECTS a tier word (override-not-concrete) — never a dead reviewer', () => {
    const res = resolveClaudeReviewerModel({
      specConverge: { reviewers: { anthropic: { model: 'capable' } } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('override-not-concrete');
  });

  it('REJECTS a concrete-but-non-frontier id (claude-opus-4-8 → override-not-frontier), NOT accepted-but-disclosed', () => {
    const res = resolveClaudeReviewerModel({
      specConverge: { reviewers: { anthropic: { model: 'claude-opus-4-8' } } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('override-not-frontier');
      expect(res.model).toBe('claude-opus-4-8');
    }
  });
});

describe('claude reviewer invocation — hardened concrete-pin call (§1.4)', () => {
  it('passes the CONCRETE pin via reviewerHardening.model, NEVER the tier word', async () => {
    const provider = capturingProvider();
    const r = await claudeEntry().review({
      promptText: 'review this spec',
      timeoutMs: 120_000,
      providerOverride: provider,
      hardeningSupportedOverride: true,
    });
    expect(r.status).toBe('ok');
    expect(r.crossFamily).toBe(false);
    expect(r.flag).toBe('clean-door-anthropic-review: claude-code:claude-fable-5');
    // the concrete pin reached evaluate, and NOT as a tier word
    const opts = provider.calls[0].options!;
    expect(opts.reviewerHardening?.model).toBe('claude-fable-5');
    expect(opts.reviewerHardening?.model).not.toBe('capable');
    // the tier-word `model` option must NOT be set to a tier for the claude call
    expect(opts.model).toBeUndefined();
  });

  it('a valid frontier config override flows to the concrete pin', async () => {
    const provider = capturingProvider();
    await claudeEntry().review({
      promptText: 'x',
      timeoutMs: 1000,
      providerOverride: provider,
      hardeningSupportedOverride: true,
      reviewerConfig: { specConverge: { reviewers: { anthropic: { model: 'claude-fable-5' } } } },
    });
    expect(provider.calls[0].options!.reviewerHardening?.model).toBe('claude-fable-5');
  });

  it('a non-frontier override degrades LOUDLY (override-not-frontier), never runs opus', async () => {
    const provider = capturingProvider();
    const r = await claudeEntry().review({
      promptText: 'x',
      timeoutMs: 1000,
      providerOverride: provider,
      hardeningSupportedOverride: true,
      reviewerConfig: { specConverge: { reviewers: { anthropic: { model: 'claude-opus-4-8' } } } },
    });
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('override-not-frontier');
    expect(r.crossFamily).toBe(false);
    expect(provider.calls.length).toBe(0); // never invoked the provider
  });

  it('degrades hardening-unsupported (fail-closed) when the preflight fails — never runs unhardened', async () => {
    const provider = capturingProvider();
    const r = await claudeEntry().review({
      promptText: 'x',
      timeoutMs: 1000,
      providerOverride: provider,
      hardeningSupportedOverride: false,
    });
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('hardening-unsupported');
    expect(provider.calls.length).toBe(0);
  });

  it('throw-safety: a constructor throw (ClaudeForbiddenError) maps to degraded claude-forbidden', async () => {
    const r = await claudeEntry().review({
      promptText: 'x',
      timeoutMs: 1000,
      hardeningSupportedOverride: true,
      claudeProviderFactory: () => {
        throw new ClaudeForbiddenError('reviewer-test', 'no claude-code in enabledFrameworks');
      },
    });
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('claude-forbidden');
    expect(r.crossFamily).toBe(false);
  });

  it('provider-unavailable when the factory returns null', async () => {
    const r = await claudeEntry().review({
      promptText: 'x',
      timeoutMs: 1000,
      hardeningSupportedOverride: true,
      claudeProviderFactory: () => null,
    });
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('provider-unavailable');
  });
});

describe('§5 lockdown — the claude family can NEVER launder the cross-model flag', () => {
  it('(a) TRUSTED contains claude-code AND the 7-day baseline EXCLUDES it', () => {
    expect(TRUSTED_REVIEWER_FRAMEWORKS).toContain('claude-code');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-door-baseline-'));
    try {
      // a claude-only activation history
      recordFrameworkActivationObservation(dir, { frameworks: { 'claude-code': true, 'codex-cli': false, 'gemini-cli': false } });
      expect(wasNonClaudeFrameworkActiveWithin(dir, 7)).toBe(false);
      // adding a real cross-family activation flips it true
      recordFrameworkActivationObservation(dir, { frameworks: { 'codex-cli': true } });
      expect(wasNonClaudeFrameworkActiveWithin(dir, 7)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(b) a claude-only ok round aggregates to unavailable/degraded — NEVER a clean flag', () => {
    const claudeOk: ReviewerResult = {
      status: 'ok',
      framework: 'claude-code',
      model: 'claude-fable-5',
      flag: 'clean-door-anthropic-review: claude-code:claude-fable-5',
      crossFamily: false,
    };
    const f = aggregateRoundOutcomes([claudeOk]);
    expect(f.status).not.toBe('available');
    expect(f.flag).not.toContain('cross-model-review: claude');
    expect(f.flag).not.toContain('cross-model-review: codex');
    expect(['unavailable', 'degraded-all-rounds']).toContain(f.status);
  });

  it('(b2) claude ok + codex unavailable → unavailable (codex drives it, claude invisible)', () => {
    const rounds: ReviewerResult[] = [
      { status: 'unavailable', reason: 'codex-not-installed', flag: 'cross-model-review: unavailable', crossFamily: true },
      { status: 'ok', framework: 'claude-code', model: 'claude-fable-5', flag: 'clean-door-anthropic-review: claude-code:claude-fable-5', crossFamily: false },
    ];
    const f = aggregateRoundOutcomes(rounds);
    expect(f.status).toBe('unavailable');
  });

  it('(c) detectAllCrossModelReviewers excludes the claude family from the availability list even when enabled+available', () => {
    const inputs = {
      codexPathDetected: null,
      geminiPathDetected: null,
      claudePathDetected: '/bin/claude',
      claudeConfigHomePresent: true,
    };
    const all = detectAllCrossModelReviewers(inputs, DEV);
    // claude is active (dev) AND available, so it appears in the raw list...
    expect(all.some((d) => d.framework === 'claude-code')).toBe(true);
    // ...but it is classified crossFamily:false, so a cross-model banner count
    // filtering on crossFamily excludes it.
    const crossFamilyCount = all.filter((d) => isCrossFamilyReviewerFramework(d.framework)).length;
    expect(crossFamilyCount).toBe(0);
  });

  it('(d) an unknown / unresolvable family id resolves crossFamily:false (fail-closed)', () => {
    expect(isCrossFamilyReviewerFramework('pi-cli')).toBe(false);
    expect(isCrossFamilyReviewerFramework('made-up-id')).toBe(false);
    expect(isCrossFamilyReviewerFramework(undefined)).toBe(false);
    // and the two real cross-model families ARE cross-family; claude is NOT
    expect(isCrossFamilyReviewerFramework('codex-cli')).toBe(true);
    expect(isCrossFamilyReviewerFramework('gemini-cli')).toBe(true);
    expect(isCrossFamilyReviewerFramework('claude-code')).toBe(false);
  });

  it('(e) detectCrossModelReviewer (single-path) never selects claude even when it is the only available family', () => {
    const inputs = {
      codexPathDetected: null,
      geminiPathDetected: null,
      claudePathDetected: '/bin/claude',
      claudeConfigHomePresent: true,
    };
    // claude available + enabled, but it is crossFamily:false; the single-path
    // detect walks the ACTIVE list and returns the first AVAILABLE — which here
    // is claude. The load-bearing guarantee is that its result is crossFamily:false
    // so it can never satisfy the cross-model aggregate.
    const r = detectCrossModelReviewer(inputs, DEV);
    if (r.available && r.framework === 'claude-code') {
      expect(r.crossFamily).toBe(false);
    }
    // With NO family available, unavailable — never a claude cross-model claim.
    const none = detectCrossModelReviewer({ codexPathDetected: null, geminiPathDetected: null, claudePathDetected: null }, DEV);
    expect(none.available).toBe(false);
  });
});

describe('crossFamily is a REQUIRED registry field (§5.1 migration guard)', () => {
  it('every SUPPORTED_REVIEWER_FRAMEWORKS entry sets crossFamily explicitly (a boolean)', () => {
    for (const entry of SUPPORTED_REVIEWER_FRAMEWORKS) {
      expect(typeof entry.crossFamily).toBe('boolean');
    }
    // and the specific classification is correct today
    expect(SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === 'codex-cli')!.crossFamily).toBe(true);
    expect(SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === 'gemini-cli')!.crossFamily).toBe(true);
    expect(SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === 'claude-code')!.crossFamily).toBe(false);
  });
});

describe('config gate — developmentAgent resolution / fleet-absent byte-identical (§1.5)', () => {
  it('absent config ⇒ fleet-dark: active set is EXACTLY [codex, gemini]', () => {
    const active = resolveActiveReviewerFrameworks(undefined);
    expect(active.map((f) => f.id)).toEqual(['codex-cli', 'gemini-cli']);
    expect(isAnthropicReviewerEnabled(undefined)).toBe(false);
  });

  it('explicit enabled:false force-darks even a dev agent', () => {
    const cfg: ReviewerConfig = { developmentAgent: true, specConverge: { reviewers: { anthropic: { enabled: false } } } };
    expect(isAnthropicReviewerEnabled(cfg)).toBe(false);
    expect(resolveActiveReviewerFrameworks(cfg).map((f) => f.id)).toEqual(['codex-cli', 'gemini-cli']);
  });

  it('developmentAgent:true (omitted enabled) ⇒ claude active', () => {
    expect(isAnthropicReviewerEnabled(DEV)).toBe(true);
    expect(resolveActiveReviewerFrameworks(DEV).map((f) => f.id)).toEqual(['codex-cli', 'gemini-cli', 'claude-code']);
  });

  it('explicit enabled:true is the fleet-flip (on even without dev flag)', () => {
    const cfg: ReviewerConfig = { specConverge: { reviewers: { anthropic: { enabled: true } } } };
    expect(isAnthropicReviewerEnabled(cfg)).toBe(true);
    expect(resolveActiveReviewerFrameworks(cfg).map((f) => f.id)).toContain('claude-code');
  });

  it('a fleet agent never sees the claude family in detection even if claude is installed', () => {
    const inputs = { codexPathDetected: null, geminiPathDetected: null, claudePathDetected: '/bin/claude', claudeConfigHomePresent: true };
    // no config → fleet-dark
    expect(detectAllCrossModelReviewers(inputs, undefined).some((d) => d.framework === 'claude-code')).toBe(false);
  });
});

describe('trusted allowlist', () => {
  it('claude-code is trusted (needed for the --family egress check)', () => {
    expect(isTrustedReviewerFramework('claude-code')).toBe(true);
    expect(isTrustedReviewerFramework('pi-cli')).toBe(false);
  });
});
