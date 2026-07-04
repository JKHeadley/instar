/**
 * Unit tests for the Piece 3 cross-model convergence hardening
 * (docs/specs/AUTONOMY-PRINCIPLES-ENFORCEMENT-SPEC.md — Piece 3) additions to
 * crossModelReviewer:
 *
 *   - detectGeminiReviewer: not-installed / not-authed (missing file,
 *     malformed JSON, empty tokens) / available — and that available returns
 *     a CONCRETE model (the canary contract).
 *   - detectAllCrossModelReviewers: both / one / none → 2 / 1 / 0 entries.
 *   - isConcreteReviewerModel (the fail-loud model canary): rejects tier
 *     words + undefined/empty, accepts concrete ids.
 *   - hashSpecReviewableBody (delta-gating): frontmatter-insensitive,
 *     body-sensitive, CRLF-insensitive.
 *   - Durable activation history: write+read roundtrip, lookback window
 *     semantics, corrupt-line skipping, the 2000-line cap.
 *   - TRUSTED_REVIEWER_FRAMEWORKS allowlist: codex/gemini trusted, pi-cli +
 *     arbitrary ids not.
 *   - geminiReviewer.review: ok path (stub provider), degraded path via a
 *     throwing providerOverride (classifyReviewFailure mapping), and the
 *     canary-degraded path via an injected detection carrying a tier-word
 *     model.
 *
 * NO real spawns — detection uses injected inputs, invocation uses a stubbed
 * provider override + an injected detectionOverride (so the registry entry
 * never re-probes the host).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  detectGeminiReviewer,
  detectAllCrossModelReviewers,
  isConcreteReviewerModel,
  hashSpecReviewableBody,
  recordFrameworkActivationObservation,
  wasNonClaudeFrameworkActiveWithin,
  TRUSTED_REVIEWER_FRAMEWORKS,
  isTrustedReviewerFramework,
  SUPPORTED_REVIEWER_FRAMEWORKS,
} from '../../src/core/crossModelReviewer.js';

// ── helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossmodel-piece3-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/crossModelReviewer-piece3.test.ts tmpdir cleanup',
  });
});

function writeGeminiCreds(json: unknown): string {
  const p = path.join(tmpDir, 'oauth_creds.json');
  fs.writeFileSync(p, typeof json === 'string' ? json : JSON.stringify(json), 'utf-8');
  return p;
}

function writeCodexAuth(): string {
  const p = path.join(tmpDir, 'auth.json');
  fs.writeFileSync(p, JSON.stringify({ tokens: { access_token: 'oauth-token' } }), 'utf-8');
  return p;
}

const geminiEntry = SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === 'gemini-cli')!;

function stubProvider(reply: string) {
  return { evaluate: async () => reply };
}
function throwingProvider(err: Error) {
  return {
    evaluate: async () => {
      throw err;
    },
  };
}

// ── detectGeminiReviewer ─────────────────────────────────────────────────

describe('detectGeminiReviewer', () => {
  it('returns gemini-not-installed when the binary is missing', () => {
    const r = detectGeminiReviewer({ geminiPathDetected: null, env: {} });
    expect(r).toEqual({ available: false, reason: 'gemini-not-installed' });
  });

  it('returns gemini-not-authed when oauth_creds.json is missing', () => {
    const r = detectGeminiReviewer({
      geminiPathDetected: '/usr/bin/gemini',
      geminiOauthCredsPath: path.join(tmpDir, 'does-not-exist.json'),
      env: {},
    });
    expect(r).toEqual({ available: false, reason: 'gemini-not-authed' });
  });

  it('returns gemini-not-authed when oauth_creds.json is malformed JSON', () => {
    const credsPath = writeGeminiCreds('{ this is not json');
    const r = detectGeminiReviewer({
      geminiPathDetected: '/usr/bin/gemini',
      geminiOauthCredsPath: credsPath,
      env: {},
    });
    expect(r).toEqual({ available: false, reason: 'gemini-not-authed' });
  });

  it('returns gemini-not-authed when both tokens are empty/absent', () => {
    const credsPath = writeGeminiCreds({ access_token: '', refresh_token: '' });
    const r = detectGeminiReviewer({
      geminiPathDetected: '/usr/bin/gemini',
      geminiOauthCredsPath: credsPath,
      env: {},
    });
    expect(r).toEqual({ available: false, reason: 'gemini-not-authed' });

    const credsPath2 = writeGeminiCreds({ scope: 'openid' });
    const r2 = detectGeminiReviewer({
      geminiPathDetected: '/usr/bin/gemini',
      geminiOauthCredsPath: credsPath2,
      env: {},
    });
    expect(r2).toEqual({ available: false, reason: 'gemini-not-authed' });
  });

  it('returns available with a CONCRETE model when binary + access_token are present', () => {
    const credsPath = writeGeminiCreds({ access_token: 'ya29.gemini-access-token' });
    const r = detectGeminiReviewer({
      geminiPathDetected: '/usr/bin/gemini',
      geminiOauthCredsPath: credsPath,
      env: {},
    });
    expect(r.available).toBe(true);
    expect(r.framework).toBe('gemini-cli');
    // capable tier → gemini-3.1-pro-preview per gemini-cli/models.ts.
    expect(r.model).toBe('gemini-3.1-pro-preview');
    // The canary contract: detection NEVER emits a bare tier word.
    expect(isConcreteReviewerModel(r.model)).toBe(true);
  });

  it('accepts a refresh_token-only credential (the CLI refreshes from it)', () => {
    const credsPath = writeGeminiCreds({ refresh_token: '1//gemini-refresh-token' });
    const r = detectGeminiReviewer({
      geminiPathDetected: '/usr/bin/gemini',
      geminiOauthCredsPath: credsPath,
      env: {},
    });
    expect(r.available).toBe(true);
    expect(r.framework).toBe('gemini-cli');
  });

  it('never throws on any input', () => {
    expect(() => detectGeminiReviewer({ geminiPathDetected: undefined as unknown as null, env: {} })).not.toThrow();
    expect(() => detectGeminiReviewer({ geminiPathDetected: null })).not.toThrow();
  });
});

// ── detectAllCrossModelReviewers ─────────────────────────────────────────

describe('detectAllCrossModelReviewers (family-diverse collection)', () => {
  it('returns BOTH frameworks when codex and gemini are both available', () => {
    const authPath = writeCodexAuth();
    const credsPath = writeGeminiCreds({ access_token: 'ya29.token' });
    const all = detectAllCrossModelReviewers({
      codexPathDetected: '/usr/bin/codex',
      authJsonPath: authPath,
      geminiPathDetected: '/usr/bin/gemini',
      geminiOauthCredsPath: credsPath,
      env: {},
    });
    expect(all).toHaveLength(2);
    expect(all.map((d) => d.framework)).toEqual(['codex-cli', 'gemini-cli']);
    expect(all.every((d) => d.available)).toBe(true);
  });

  it('returns ONE entry when only one framework is available', () => {
    const credsPath = writeGeminiCreds({ access_token: 'ya29.token' });
    const all = detectAllCrossModelReviewers({
      codexPathDetected: null,
      geminiPathDetected: '/usr/bin/gemini',
      geminiOauthCredsPath: credsPath,
      env: {},
    });
    expect(all).toHaveLength(1);
    expect(all[0].framework).toBe('gemini-cli');
  });

  it('returns an EMPTY array when none is available (never throws)', () => {
    const all = detectAllCrossModelReviewers({
      codexPathDetected: null,
      geminiPathDetected: null,
      env: {},
    });
    expect(all).toEqual([]);
  });
});

// ── isConcreteReviewerModel (the fail-loud canary) ───────────────────────

describe('isConcreteReviewerModel (fail-loud model canary)', () => {
  it('rejects undefined and empty/blank strings', () => {
    expect(isConcreteReviewerModel(undefined)).toBe(false);
    expect(isConcreteReviewerModel('')).toBe(false);
    expect(isConcreteReviewerModel('   ')).toBe(false);
  });

  it('rejects bare tier words, case-insensitively', () => {
    for (const tier of ['fast', 'balanced', 'capable', 'haiku', 'sonnet', 'opus']) {
      expect(isConcreteReviewerModel(tier)).toBe(false);
      expect(isConcreteReviewerModel(tier.toUpperCase())).toBe(false);
    }
    expect(isConcreteReviewerModel('Capable')).toBe(false);
  });

  it('accepts concrete model ids', () => {
    expect(isConcreteReviewerModel('gpt-5.5')).toBe(true);
    expect(isConcreteReviewerModel('gemini-2.5-pro')).toBe(true);
  });
});

// ── hashSpecReviewableBody (delta-gating) ────────────────────────────────

describe('hashSpecReviewableBody (delta-gating hash)', () => {
  const body = '# Spec\n\n## Problem statement\nThe body under review.\n';

  it('is STABLE when only the frontmatter changes (tag-writes do not retrigger externals)', () => {
    const before = `---\ntitle: "X"\n---\n${body}`;
    const after = `---\ntitle: "X"\nreview-convergence: "2026-06-10T00:00:00Z"\napproved: true\n---\n${body}`;
    expect(hashSpecReviewableBody(before)).toBe(hashSpecReviewableBody(after));
  });

  it('CHANGES when the reviewable body changes', () => {
    const a = `---\ntitle: "X"\n---\n${body}`;
    const b = `---\ntitle: "X"\n---\n${body}\n## New section\nNew design content.\n`;
    expect(hashSpecReviewableBody(a)).not.toBe(hashSpecReviewableBody(b));
  });

  it('is CRLF-insensitive (\\r\\n and \\n bodies hash identically)', () => {
    const lf = `---\ntitle: "X"\n---\n${body}`;
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(hashSpecReviewableBody(lf)).toBe(hashSpecReviewableBody(crlf));
  });

  it('hashes a spec with no frontmatter as-is (no accidental stripping)', () => {
    expect(hashSpecReviewableBody(body)).toBe(hashSpecReviewableBody(body));
    // A body that merely CONTAINS a later `---` rule is not frontmatter-stripped
    // differently from itself.
    const withRule = `${body}\n---\n\nMore text.\n`;
    expect(hashSpecReviewableBody(withRule)).not.toBe(hashSpecReviewableBody(body));
  });
});

// ── Durable activation history ───────────────────────────────────────────

describe('framework activation history (durable standing-framework baseline)', () => {
  const historyFile = () => path.join(tmpDir, 'state', 'framework-activation-history.jsonl');

  it('write+read roundtrip: a recorded non-Claude activation is found within the lookback', () => {
    recordFrameworkActivationObservation(tmpDir, {
      frameworks: { 'codex-cli': false, 'gemini-cli': true },
    });
    expect(fs.existsSync(historyFile())).toBe(true);
    expect(wasNonClaudeFrameworkActiveWithin(tmpDir, 7)).toBe(true);
  });

  it('returns false when all recorded observations show no active framework', () => {
    recordFrameworkActivationObservation(tmpDir, {
      frameworks: { 'codex-cli': false, 'gemini-cli': false },
    });
    expect(wasNonClaudeFrameworkActiveWithin(tmpDir, 7)).toBe(false);
  });

  it('lookback window: an activation INSIDE the window counts, one OUTSIDE does not', () => {
    const now = new Date('2026-06-10T12:00:00Z');
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

    recordFrameworkActivationObservation(tmpDir, {
      ts: tenDaysAgo,
      frameworks: { 'gemini-cli': true },
    });
    // 7-day lookback misses the 10-day-old activation.
    expect(wasNonClaudeFrameworkActiveWithin(tmpDir, 7, now)).toBe(false);
    // A wider lookback finds it.
    expect(wasNonClaudeFrameworkActiveWithin(tmpDir, 14, now)).toBe(true);

    // A deactivation INSIDE the window does not erase the earlier in-window
    // activation: record active 2 days ago, then inactive now.
    recordFrameworkActivationObservation(tmpDir, {
      ts: twoDaysAgo,
      frameworks: { 'gemini-cli': true },
    });
    recordFrameworkActivationObservation(tmpDir, {
      ts: now.toISOString(),
      frameworks: { 'gemini-cli': false },
    });
    expect(wasNonClaudeFrameworkActiveWithin(tmpDir, 7, now)).toBe(true);
  });

  it('returns false (never throws) when no history file exists', () => {
    expect(wasNonClaudeFrameworkActiveWithin(tmpDir, 7)).toBe(false);
  });

  it('skips corrupt lines without throwing', () => {
    recordFrameworkActivationObservation(tmpDir, { frameworks: { 'codex-cli': true } });
    fs.appendFileSync(historyFile(), 'this is { not json\n', 'utf-8');
    recordFrameworkActivationObservation(tmpDir, { frameworks: { 'gemini-cli': false } });
    expect(() => wasNonClaudeFrameworkActiveWithin(tmpDir, 7)).not.toThrow();
    expect(wasNonClaudeFrameworkActiveWithin(tmpDir, 7)).toBe(true);
  });

  it('caps the file at the most recent 2000 lines on write', () => {
    // Seed well past the cap, then verify the file holds exactly 2000 lines
    // and that the OLDEST lines were dropped (most-recent retained).
    for (let i = 0; i < 2005; i++) {
      recordFrameworkActivationObservation(tmpDir, {
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60, i)).toISOString(),
        frameworks: { seq: false, [`marker-${i}`]: false },
      });
    }
    const lines = fs
      .readFileSync(historyFile(), 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2000);
    expect(lines[0]).toContain('marker-5'); // 0..4 dropped
    expect(lines[lines.length - 1]).toContain('marker-2004');
  });
});

// ── Trusted-provider allowlist ───────────────────────────────────────────

describe('TRUSTED_REVIEWER_FRAMEWORKS (no spec egress to untrusted endpoints)', () => {
  it('trusts exactly the first-party OAuth CLI adapters', () => {
    expect(TRUSTED_REVIEWER_FRAMEWORKS).toEqual(['codex-cli', 'gemini-cli']);
    expect(isTrustedReviewerFramework('codex-cli')).toBe(true);
    expect(isTrustedReviewerFramework('gemini-cli')).toBe(true);
  });

  it('excludes pi-cli (multi-provider — may be a custom endpoint) and arbitrary ids', () => {
    expect(isTrustedReviewerFramework('pi-cli')).toBe(false);
    expect(isTrustedReviewerFramework('evil-proxy')).toBe(false);
    expect(isTrustedReviewerFramework('')).toBe(false);
  });

  it('every registry entry is on the allowlist (registry carries first-party adapters only)', () => {
    for (const entry of SUPPORTED_REVIEWER_FRAMEWORKS) {
      expect(isTrustedReviewerFramework(entry.id)).toBe(true);
    }
  });
});

// ── geminiReviewer registry entry ────────────────────────────────────────

describe('geminiReviewer registry entry', () => {
  it('is the second registry entry (codex stays the preference leader)', () => {
    expect(SUPPORTED_REVIEWER_FRAMEWORKS.map((f) => f.id)).toEqual(['codex-cli', 'gemini-cli']);
  });

  it('ok: stub provider returns a structured review → status ok, gemini flag', async () => {
    const r = await geminiEntry.review({
      promptText: 'PROMPT',
      timeoutMs: 1000,
      detectionOverride: { available: true, framework: 'gemini-cli', model: 'gemini-2.5-pro' },
      providerOverride: stubProvider('Verdict: MINOR ISSUES\n- §2 tighten the auth probe.'),
    });
    expect(r.status).toBe('ok');
    expect(r.framework).toBe('gemini-cli');
    expect(r.model).toBe('gemini-2.5-pro');
    expect(r.verdict).toBe('MINOR ISSUES');
    expect(r.findings).toHaveLength(1);
    expect(r.findings![0].reviewer).toBe('cross-model:gemini-cli:gemini-2.5-pro');
    expect(r.flag).toBe('cross-model-review: gemini-cli:gemini-2.5-pro');
  });

  it('degraded: provider throws → classifyReviewFailure mapping, gemini degraded flag', async () => {
    const r = await geminiEntry.review({
      promptText: 'PROMPT',
      timeoutMs: 1000,
      detectionOverride: { available: true, framework: 'gemini-cli', model: 'gemini-2.5-pro' },
      providerOverride: throwingProvider(new Error('Command timed out after 120000ms')),
    });
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('timeout');
    expect(r.flag).toBe('cross-model-review: gemini-cli:gemini-2.5-pro (degraded: timeout)');
  });

  it('degraded: rate-limit error classifies as rate-limited', async () => {
    const r = await geminiEntry.review({
      promptText: 'PROMPT',
      timeoutMs: 1000,
      detectionOverride: { available: true, framework: 'gemini-cli', model: 'gemini-2.5-pro' },
      providerOverride: throwingProvider(new Error('429 Too Many Requests')),
    });
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('rate-limited');
  });

  it('CANARY: a tier-word model degrades loudly BEFORE the provider is ever invoked', async () => {
    let providerInvoked = false;
    const spyProvider = {
      evaluate: async () => {
        providerInvoked = true;
        return 'Verdict: CLEAN';
      },
    };
    const r = await geminiEntry.review({
      promptText: 'PROMPT',
      timeoutMs: 1000,
      // A detection whose model resolution fell through to the bare tier word.
      detectionOverride: { available: true, framework: 'gemini-cli', model: 'capable' },
      providerOverride: spyProvider,
    });
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('model-resolution-canary');
    expect(r.flag).toBe('cross-model-review: gemini-cli:capable (degraded: model-resolution-canary)');
    // NEVER silently review with a tier-word model.
    expect(providerInvoked).toBe(false);
  });

  it('CANARY: the codex entry enforces the same check', async () => {
    const codexEntry = SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === 'codex-cli')!;
    let providerInvoked = false;
    const spyProvider = {
      evaluate: async () => {
        providerInvoked = true;
        return 'Verdict: CLEAN';
      },
    };
    const r = await codexEntry.review({
      promptText: 'PROMPT',
      timeoutMs: 1000,
      detectionOverride: { available: true, framework: 'codex-cli', model: 'capable' },
      providerOverride: spyProvider,
    });
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('model-resolution-canary');
    expect(providerInvoked).toBe(false);
  });
});
