// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
//
// REVIEWER-DOOR-REWIRING inc2 — the per-family reviewer timeout knob
// (`specConverge.reviewers.timeoutMs`, §3.2 / §7 / D6).
//
// Two layers:
//   1. `resolveReviewerTimeoutMs` — the resolution logic (single number applies
//      to all families; a `{ default, byFramework }` map overrides per family;
//      absent ⇒ 120s for EVERY family, byte-identical; clamp [30s, 900s]).
//   2. Wiring — each family's invocation actually RECEIVES its resolved timeout
//      (the driver resolves per `framework.id`; the family passes it to
//      `provider.evaluate`), and an explicit caller value still wins.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveReviewerTimeoutMs,
  runCrossModelReview,
  REVIEW_TIMEOUT_MS,
  REVIEWER_TIMEOUT_MIN_MS,
  REVIEWER_TIMEOUT_MAX_MS,
  SUPPORTED_REVIEWER_FRAMEWORKS,
  type ReviewerConfig,
} from '../../src/core/crossModelReviewer.js';
import type { IntelligenceOptions as _IO } from '../../src/core/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The three reviewer families the knob must reach (§3.2 — codex, gemini, claude).
const FAMILIES = ['codex-cli', 'gemini-cli', 'claude-code'] as const;

const claudeEntry = () => SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === 'claude-code')!;

/** A stub provider that captures the options (incl. `timeoutMs`) it was called with. */
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

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-timeout-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCodexAuth(): string {
  const p = path.join(tmpDir, 'auth.json');
  fs.writeFileSync(p, JSON.stringify({ tokens: { access_token: 'oauth-access-token-value' } }), 'utf-8');
  return p;
}
function writeGeminiCreds(): string {
  const p = path.join(tmpDir, 'gemini-creds.json');
  fs.writeFileSync(p, JSON.stringify({ access_token: 'gemini-oauth-token' }), 'utf-8');
  return p;
}

// Build a ReviewerConfig carrying a given `timeoutMs` knob. Typed `unknown` so
// the intentionally-malformed inputs (NaN, strings, null) can be exercised.
const cfg = (timeoutMs: unknown): ReviewerConfig => ({
  specConverge: { reviewers: { timeoutMs: timeoutMs as never } },
});

// ── Layer 1: resolveReviewerTimeoutMs ───────────────────────────────────────

describe('resolveReviewerTimeoutMs — absent knob is byte-identical 120s for EVERY family', () => {
  it('absent config ⇒ exactly 120s (REVIEW_TIMEOUT_MS) for every family', () => {
    for (const fam of FAMILIES) {
      expect(resolveReviewerTimeoutMs(undefined, fam)).toBe(120_000);
      expect(resolveReviewerTimeoutMs(undefined, fam)).toBe(REVIEW_TIMEOUT_MS);
      expect(resolveReviewerTimeoutMs({}, fam)).toBe(REVIEW_TIMEOUT_MS);
      // config present but no reviewers/timeoutMs block ⇒ still 120s.
      expect(resolveReviewerTimeoutMs({ specConverge: { reviewers: {} } }, fam)).toBe(REVIEW_TIMEOUT_MS);
    }
  });

  it('a non-number / non-finite knob degrades to the 120s default (never NaN/throw)', () => {
    for (const bad of [NaN, Infinity, -Infinity, 'oops' as unknown as number, null as unknown as number]) {
      expect(resolveReviewerTimeoutMs(cfg(bad), 'gemini-cli')).toBe(REVIEW_TIMEOUT_MS);
    }
    // a map whose byFramework/default are non-finite ⇒ 120s.
    expect(resolveReviewerTimeoutMs(cfg({ default: NaN, byFramework: { 'gemini-cli': Infinity } }), 'gemini-cli')).toBe(
      REVIEW_TIMEOUT_MS,
    );
  });
});

describe('resolveReviewerTimeoutMs — single-number form applies to ALL families', () => {
  it('one number is used for codex, gemini, AND claude alike', () => {
    for (const fam of FAMILIES) {
      expect(resolveReviewerTimeoutMs(cfg(300_000), fam)).toBe(300_000);
    }
  });
});

describe('resolveReviewerTimeoutMs — byFramework map overrides PER family', () => {
  it('a named family gets its byFramework value; an unnamed family falls back to default', () => {
    const config = cfg({ default: 200_000, byFramework: { 'gemini-cli': 600_000 } });
    expect(resolveReviewerTimeoutMs(config, 'gemini-cli')).toBe(600_000); // named override
    expect(resolveReviewerTimeoutMs(config, 'codex-cli')).toBe(200_000); // falls back to default
    expect(resolveReviewerTimeoutMs(config, 'claude-code')).toBe(200_000); // falls back to default
  });

  it('an unnamed family with NO default falls back to the 120s default', () => {
    const config = cfg({ byFramework: { 'gemini-cli': 500_000 } });
    expect(resolveReviewerTimeoutMs(config, 'gemini-cli')).toBe(500_000);
    expect(resolveReviewerTimeoutMs(config, 'codex-cli')).toBe(REVIEW_TIMEOUT_MS);
  });

  it('the map is genuinely per-family (not uniform): each family resolves independently', () => {
    const config = cfg({
      byFramework: { 'codex-cli': 90_000, 'gemini-cli': 600_000, 'claude-code': 300_000 },
    });
    expect(resolveReviewerTimeoutMs(config, 'codex-cli')).toBe(90_000);
    expect(resolveReviewerTimeoutMs(config, 'gemini-cli')).toBe(600_000);
    expect(resolveReviewerTimeoutMs(config, 'claude-code')).toBe(300_000);
  });
});

describe('resolveReviewerTimeoutMs — clamp to [30s, 900s]', () => {
  it('exports the clamp bounds as 30s / 900s', () => {
    expect(REVIEWER_TIMEOUT_MIN_MS).toBe(30_000);
    expect(REVIEWER_TIMEOUT_MAX_MS).toBe(900_000);
  });

  it('a below-floor value clamps UP to 30s (10s → 30s)', () => {
    expect(resolveReviewerTimeoutMs(cfg(10_000), 'gemini-cli')).toBe(30_000);
    expect(resolveReviewerTimeoutMs(cfg(0), 'codex-cli')).toBe(30_000);
  });

  it('an above-ceiling value clamps DOWN to 900s (2000s → 900s)', () => {
    expect(resolveReviewerTimeoutMs(cfg(2_000_000), 'gemini-cli')).toBe(900_000);
  });

  it('an in-range value passes through unchanged (600s)', () => {
    expect(resolveReviewerTimeoutMs(cfg(600_000), 'gemini-cli')).toBe(600_000);
  });

  it('clamps within the byFramework map and default too', () => {
    const config = cfg({ default: 3_000_000, byFramework: { 'codex-cli': 5_000 } });
    expect(resolveReviewerTimeoutMs(config, 'codex-cli')).toBe(30_000); // byFramework floor
    expect(resolveReviewerTimeoutMs(config, 'gemini-cli')).toBe(900_000); // default ceiling
  });
});

// ── Layer 2: wiring — each family's invocation RECEIVES its resolved timeout ──

describe('wiring — the knob reaches the family call site through the driver (per-family)', () => {
  const assembled = { promptText: 'PROMPT', truncated: false, bytes: 6 };

  it('codex: the driver resolves codex-cli and passes ITS byFramework timeout to evaluate', async () => {
    const provider = capturingProvider();
    const config = cfg({ default: 200_000, byFramework: { 'codex-cli': 90_000, 'gemini-cli': 600_000 } });
    const r = await runCrossModelReview({
      assembled,
      config,
      detectInputs: { codexPathDetected: '/usr/bin/codex', authJsonPath: writeCodexAuth(), env: {} },
      providerOverride: provider,
    });
    expect(r.status).toBe('ok');
    expect(r.framework).toBe('codex-cli');
    expect(provider.calls[0].options?.timeoutMs).toBe(90_000); // codex's own value, NOT gemini's 600s
  });

  it('gemini: the driver resolves gemini-cli and passes ITS byFramework timeout to evaluate', async () => {
    const provider = capturingProvider();
    const config = cfg({ default: 200_000, byFramework: { 'codex-cli': 90_000, 'gemini-cli': 600_000 } });
    const r = await runCrossModelReview({
      assembled,
      config,
      // codex unavailable → gemini is the first available family.
      detectInputs: {
        codexPathDetected: null,
        geminiPathDetected: '/usr/bin/gemini',
        geminiOauthCredsPath: writeGeminiCreds(),
        env: {},
      },
      providerOverride: provider,
    });
    expect(r.status).toBe('ok');
    expect(r.framework).toBe('gemini-cli');
    expect(provider.calls[0].options?.timeoutMs).toBe(600_000); // gemini's own value, NOT codex's 90s
  });

  it('absent config through the driver ⇒ 120s reaches evaluate (byte-identical)', async () => {
    const provider = capturingProvider();
    const r = await runCrossModelReview({
      assembled,
      // no `config` at all
      detectInputs: { codexPathDetected: '/usr/bin/codex', authJsonPath: writeCodexAuth(), env: {} },
      providerOverride: provider,
    });
    expect(r.status).toBe('ok');
    expect(provider.calls[0].options?.timeoutMs).toBe(REVIEW_TIMEOUT_MS);
  });

  it('an explicit caller timeout (e.g. --timeout-ms) WINS over the config knob', async () => {
    const provider = capturingProvider();
    const config = cfg({ byFramework: { 'codex-cli': 90_000 } });
    await runCrossModelReview({
      assembled,
      config,
      timeoutMs: 45_000, // explicit override
      detectInputs: { codexPathDetected: '/usr/bin/codex', authJsonPath: writeCodexAuth(), env: {} },
      providerOverride: provider,
    });
    expect(provider.calls[0].options?.timeoutMs).toBe(45_000); // explicit wins; NOT the 90s knob
  });

  it('claude: the family passes its resolved per-family timeout to evaluate', async () => {
    const provider = capturingProvider();
    const config = cfg({ byFramework: { 'claude-code': 300_000 } });
    const resolved = resolveReviewerTimeoutMs(config, 'claude-code');
    expect(resolved).toBe(300_000);
    const r = await claudeEntry().review({
      promptText: 'review this spec',
      timeoutMs: resolved,
      providerOverride: provider,
      hardeningSupportedOverride: true,
    });
    expect(r.status).toBe('ok');
    expect(provider.calls[0].options?.timeoutMs).toBe(300_000); // claude's own value reached evaluate
  });
});
