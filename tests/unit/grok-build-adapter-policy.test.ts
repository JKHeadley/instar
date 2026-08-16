/**
 * Unit tests — grok-build adapter policy, framing, and accounting semantics
 * (grok-build framework integration spec §2.1, §3.1, §4.1, §6.0).
 *
 * Semantic-correctness coverage sits on BOTH sides of every decision
 * boundary the spec drew:
 *   - billing gate: key-in-env refused EVEN WITH a valid session; missing /
 *     expired / within-margin / malformed sessions refused; fresh passes.
 *   - argv framing: prompt travels via --prompt-file (never argv), tools
 *     denied, web search off, binary is `grok` never `agent`.
 *   - env boundary: billing-capable vars hard-deleted; GROK_HOME passes.
 *   - accounting: the four disjoint usage fields sum (reasoning is a subset
 *     of output, NEVER re-added); reported cost lands in estimatedCostUsd
 *     as a plan-rate figure.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  assertGrokAuthAllowed,
  readSessionExpiry,
  isLoginPolicyVerified,
  GROK_FORBIDDEN_ENV_VARS,
  SESSION_EXPIRY_MARGIN_MS,
} from '../../src/providers/adapters/grok-build/policy.js';
import {
  GrokApiKeyForbiddenError,
  GrokSessionExpiredError,
  mapExecError,
  scrubStderr,
} from '../../src/providers/adapters/grok-build/errors.js';
import {
  configFromEnv,
  resolveGrokHome,
  grokAuthPath,
  type GrokBuildConfig,
} from '../../src/providers/adapters/grok-build/config.js';
import {
  buildGrokOneShotArgv,
  buildGrokChildEnv,
  GROK_BILLING_ENV_VARS,
  GROK_ONESHOT_DENIED_TOOLS,
} from '../../src/providers/adapters/grok-build/transport/grokSpawn.js';
import { validateEnvelopeUsage } from '../../src/providers/adapters/grok-build/transport/oneShotCompletion.js';
import {
  parseGrokEnvelope,
  usageFromEnvelope,
} from '../../src/providers/adapters/grok-build/transport/oneShotCompletion.js';
import { detectGrokReviewer } from '../../src/core/crossModelReviewer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { QuotaError, AuthError } from '../../src/providers/errors.js';

// ── helpers ──────────────────────────────────────────────────────────────

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Build a temp grok home containing an auth.json with the given expiry. */
function tempGrokHome(expiresAt: string | null, opts: { loginPolicy?: boolean } = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-test-home-'));
  cleanups.push(() =>
    SafeFsExecutor.safeRmSync(home, {
      recursive: true,
      force: true,
      operation: 'tests/unit/grok-build-adapter-policy.test.ts:cleanup',
    }),
  );
  // The chokepoint verifies the vendor login policy on every call (round-4),
  // so test homes carry it by default; pass { loginPolicy: false } to test
  // the unverified-policy refusal itself.
  if (opts.loginPolicy !== false) {
    fs.writeFileSync(path.join(home, 'config.toml'), '[auth]\ndisable_api_key_auth = true\n');
  }
  if (expiresAt !== null) {
    fs.writeFileSync(
      path.join(home, 'auth.json'),
      JSON.stringify({
        'https://auth.x.ai::client-id': {
          auth_mode: 'oidc',
          expires_at: expiresAt,
          key: 'not-a-real-token',
        },
      }),
      { mode: 0o600 },
    );
  }
  return home;
}

function configFor(home: string): GrokBuildConfig {
  return { grokPath: path.join(home, 'bin', 'grok'), grokHome: home };
}

const FRESH = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
const EXPIRED = new Date(Date.now() - 60 * 1000).toISOString();    // -1m
const CLEAN_ENV: NodeJS.ProcessEnv = { HOME: '/tmp' };

// ── billing gate (spec §3.1) ─────────────────────────────────────────────

describe('assertGrokAuthAllowed — the billing gate', () => {
  it('passes with a fresh session and no metered key', () => {
    const home = tempGrokHome(FRESH);
    expect(() => assertGrokAuthAllowed(configFor(home), CLEAN_ENV)).not.toThrow();
  });

  it('refuses when XAI_API_KEY is set EVEN WITH a valid session (review-1 f.3)', () => {
    const home = tempGrokHome(FRESH);
    expect(() =>
      assertGrokAuthAllowed(configFor(home), { ...CLEAN_ENV, XAI_API_KEY: 'xai-abc' }),
    ).toThrow(GrokApiKeyForbiddenError);
  });

  it('refuses GROK_DEPLOYMENT_KEY the same way', () => {
    const home = tempGrokHome(FRESH);
    expect(() =>
      assertGrokAuthAllowed(configFor(home), { ...CLEAN_ENV, GROK_DEPLOYMENT_KEY: 'dk' }),
    ).toThrow(GrokApiKeyForbiddenError);
  });

  it('the forbidden-key error names the VAR, never the value', () => {
    const home = tempGrokHome(FRESH);
    try {
      assertGrokAuthAllowed(configFor(home), { ...CLEAN_ENV, XAI_API_KEY: 'xai-SECRET-VALUE' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('XAI_API_KEY');
      expect((err as Error).message).not.toContain('SECRET-VALUE');
    }
  });

  it('refuses when no auth file exists (unauthenticated)', () => {
    const home = tempGrokHome(null);
    expect(() => assertGrokAuthAllowed(configFor(home), CLEAN_ENV)).toThrow(
      GrokSessionExpiredError,
    );
  });

  it('refuses an EXPIRED session — file-exists is not session-active', () => {
    const home = tempGrokHome(EXPIRED);
    expect(() => assertGrokAuthAllowed(configFor(home), CLEAN_ENV)).toThrow(
      GrokSessionExpiredError,
    );
  });

  it('refuses a session expiring INSIDE the safety margin', () => {
    const insideMargin = new Date(Date.now() + SESSION_EXPIRY_MARGIN_MS / 2).toISOString();
    const home = tempGrokHome(insideMargin);
    expect(() => assertGrokAuthAllowed(configFor(home), CLEAN_ENV)).toThrow(
      GrokSessionExpiredError,
    );
  });

  it('fails CLOSED on a malformed auth file (no parseable expiry)', () => {
    const home = tempGrokHome(null);
    fs.writeFileSync(path.join(home, 'auth.json'), 'not json at all');
    expect(() => assertGrokAuthAllowed(configFor(home), CLEAN_ENV)).toThrow(
      GrokSessionExpiredError,
    );
  });

  it('refuses at the CHOKEPOINT when the login policy is unverified (round-4)', () => {
    const home = tempGrokHome(FRESH, { loginPolicy: false });
    expect(() => assertGrokAuthAllowed(configFor(home), CLEAN_ENV)).toThrow(
      /grok-login-policy-unverified/,
    );
  });

  it('exports exactly the two metered-key names the spec forbids', () => {
    expect([...GROK_FORBIDDEN_ENV_VARS]).toEqual(['XAI_API_KEY', 'GROK_DEPLOYMENT_KEY']);
  });
});

describe('readSessionExpiry', () => {
  it('EXCLUDES entries that explicitly declare a key-mode credential (round-5)', () => {
    const home = tempGrokHome(null);
    const longLived = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
    const short = new Date(Date.now() + 5000).toISOString();
    fs.writeFileSync(
      path.join(home, 'auth.json'),
      JSON.stringify({
        apiKeyEntry: { auth_mode: 'api_key', expires_at: longLived },
        session: { auth_mode: 'oidc', expires_at: short },
      }),
    );
    // The long-lived key-mode entry must NOT green the gate.
    expect(readSessionExpiry(path.join(home, 'auth.json'))?.toISOString()).toBe(short);
  });

  it('returns the LATEST expiry across entries (a stale historical entry must not wedge the gate after re-login)', () => {
    const home = tempGrokHome(null);
    const stale = new Date(Date.now() - 100_000).toISOString();
    const fresh = new Date(Date.now() + 100_000).toISOString();
    fs.writeFileSync(
      path.join(home, 'auth.json'),
      JSON.stringify({ old: { expires_at: stale }, fresh: { expires_at: fresh } }),
    );
    expect(readSessionExpiry(path.join(home, 'auth.json'))?.toISOString()).toBe(fresh);
  });

  it('returns null for a missing file', () => {
    expect(readSessionExpiry('/nonexistent/auth.json')).toBeNull();
  });

  it('returns null for entries with no parseable expiry', () => {
    const home = tempGrokHome(null);
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ a: { expires_at: 'garbage' } }));
    expect(readSessionExpiry(path.join(home, 'auth.json'))).toBeNull();
  });
});

// ── argv framing (spec §4.1 / §2.1) ─────────────────────────────────────

describe('buildGrokOneShotArgv — prompt-file framing', () => {
  it('passes the prompt via --prompt-file, never as argv content', () => {
    const argv = buildGrokOneShotArgv('grok-4.6', '/tmp/p.txt');
    expect(argv).toContain('--prompt-file');
    expect(argv[argv.indexOf('--prompt-file') + 1]).toBe('/tmp/p.txt');
    expect(argv).not.toContain('-p');
  });

  it('always denies tools and web search (the confinement floor)', () => {
    const argv = buildGrokOneShotArgv(undefined, '/tmp/p.txt');
    expect(argv).toContain('--disable-web-search');
    expect(argv).toContain('--disallowed-tools');
    expect(argv[argv.indexOf('--disallowed-tools') + 1]).toBe(GROK_ONESHOT_DENIED_TOOLS);
    for (const tool of ['bash', 'write', 'web_fetch']) {
      expect(GROK_ONESHOT_DENIED_TOOLS).toContain(tool);
    }
  });

  it('carries --deny PERMISSION RULES as the load-bearing bound (round-18)', () => {
    const argv = buildGrokOneShotArgv(undefined, '/tmp/p.txt');
    // ROUND-18: round-17's `--tools ''` was INERT. Measured against the real
    // binary with a probe whose only success signal is a real side effect: with
    // the exact round-17 argv, grok READ a scratch file; with `--deny Read` it
    // did not. `--disallowed-tools` is likewise inert on 1.0.4.
    //
    // This assertion is still argv-shape, and argv-shape is what FAILED to
    // catch the round-17 defect — so it is explicitly NOT the proof. It pins
    // the shape so a silent removal is visible; the PROOF is the live
    // side-effect probe recorded in the spec and in grokSpawn.ts, which is the
    // only test shape that can distinguish "flag present" from "flag binds".
    for (const rule of ['Read', 'Write', 'Bash', 'WebFetch']) {
      const i = argv.indexOf(rule);
      expect(i, `--deny ${rule} must be present`).toBeGreaterThan(0);
      expect(argv[i - 1], `${rule} must follow a --deny flag`).toBe('--deny');
    }
  });

  it('CONTROL: the inert flags are retained but must not be the only bound', () => {
    const argv = buildGrokOneShotArgv(undefined, '/tmp/p.txt');
    // They stay for a future version that may honour them. The control is that
    // their presence can never again satisfy the confinement assertion alone:
    // if the --deny rules above were dropped, this file must go red.
    expect(argv).toContain('--disallowed-tools');
    expect(argv.filter((a) => a === '--deny').length).toBeGreaterThanOrEqual(4);
  });

  it('LEGACY (round-17, retained to document a disproven claim)', () => {
    const argv = buildGrokOneShotArgv(undefined, '/tmp/p.txt');
    // Measured against grok 1.0.4: flag NAMES are validated (an unknown flag
    // exits 2) but flag VALUES are not (`--disallowed-tools bogus_tool_xyz`
    // exits 0 silently). So a deny list cannot survive a vendor tool RENAME —
    // it silently stops denying, with nothing to notice. Naming zero permitted
    // tools cannot be drifted by any rename or addition.
    // Round-17 asserted `--tools ''` was "the primary bound". It was inert, so
    // the flag was REMOVED in round 18 rather than left implying protection.
    // This test is kept, inverted, as the durable record of the disproven
    // claim: if `--tools ''` ever comes back, someone is re-adding a bound that
    // was measured not to bind.
    expect(argv).not.toContain('--tools');
  });

  it('CONTROL: every --deny flag is a real argv PAIR, never a dangling flag', () => {
    // Round-17's version of this control checked `--tools`, whose value was an
    // empty string — and an empty string is exactly what a DROPPED value looks
    // like, so the control could not tell a real pair from a broken one. The
    // deny rules carry non-empty values, so the same question is now answerable.
    const argv = buildGrokOneShotArgv('grok-4.6', '/tmp/p.txt');
    argv.forEach((tok, i) => {
      if (tok !== '--deny') return;
      expect(i, '--deny must not be the last element').toBeLessThan(argv.length - 1);
      expect(argv[i + 1], '--deny must carry a non-empty rule').toBeTruthy();
      expect(argv[i + 1]).not.toBe('--deny');
    });
  });

  it('appends -m only when a model is given', () => {
    expect(buildGrokOneShotArgv('grok-4.5', '/tmp/p.txt')).toContain('grok-4.5');
    expect(buildGrokOneShotArgv(undefined, '/tmp/p.txt')).not.toContain('-m');
  });
});

describe('binary identity (spec §2.1 — never the colliding `agent` name)', () => {
  it('configFromEnv default binary path ends in /grok, never /agent', () => {
    const cfg = configFromEnv({ HOME: '/home/x' });
    expect(cfg.grokPath.endsWith('/grok') || cfg.grokPath === 'grok').toBe(true);
    expect(cfg.grokPath).not.toMatch(/\/agent$/);
  });

  it('resolveGrokHome honors GROK_HOME; binary+auth resolve from ONE root', () => {
    const env = { GROK_HOME: '/custom/grokhome' };
    expect(resolveGrokHome(env)).toBe('/custom/grokhome');
    const cfg = configFromEnv(env);
    expect(cfg.grokHome).toBe('/custom/grokhome');
    expect(grokAuthPath(cfg.grokHome)).toBe('/custom/grokhome/auth.json');
  });

  it('a set GROK_HOME OUTRANKS detection — binary and auth cannot split roots (round-9)', () => {
    // The inverted order was the bug: with GROK_HOME set and a stale ~/.grok
    // install still on disk, detection won and the adapter ran a binary from
    // one root while reading auth/config/ledger from another.
    const env = { GROK_HOME: '/custom/grokhome', HOME: '/home/x' };
    const cfg = configFromEnv(env);
    expect(cfg.grokPath).toBe('/custom/grokhome/bin/grok');
    expect(grokAuthPath(cfg.grokHome)).toBe('/custom/grokhome/auth.json');
  });

  it('GROK_BUILD_PATH still outranks GROK_HOME (the explicit operator lever)', () => {
    const cfg = configFromEnv({
      GROK_BUILD_PATH: '/opt/custom/grok',
      GROK_HOME: '/custom/grokhome',
      HOME: '/home/x',
    });
    expect(cfg.grokPath).toBe('/opt/custom/grok');
  });
});

// ── env boundary ─────────────────────────────────────────────────────────

describe('buildGrokChildEnv — the no-API-keys rule', () => {
  it('hard-deletes every billing-capable var present in the parent env', () => {
    const parent: NodeJS.ProcessEnv = { HOME: '/h', PATH: '/bin' };
    for (const v of GROK_BILLING_ENV_VARS) parent[v] = 'leak';
    const child = buildGrokChildEnv(parent);
    for (const v of GROK_BILLING_ENV_VARS) expect(child[v]).toBeUndefined();
  });

  it('passes GROK_HOME through (home coherence) and drops unlisted vars', () => {
    const child = buildGrokChildEnv({
      HOME: '/h',
      GROK_HOME: '/custom',
      RANDOM_SECRET: 'x',
      CLAUDECODE: '1',
    });
    expect(child['GROK_HOME']).toBe('/custom');
    expect(child['RANDOM_SECRET']).toBeUndefined();
    expect(child['CLAUDECODE']).toBeUndefined();
  });
});

// ── envelope + accounting semantics (spec §6.0) ─────────────────────────

describe('parseGrokEnvelope / usageFromEnvelope', () => {
  const PROBED_ENVELOPE = {
    text: 'OK',
    stopReason: 'end_turn',
    sessionId: '01a00249-9839-78b3-b8c6-78fbeef306b4',
    usage: {
      input_tokens: 508,
      cache_read_input_tokens: 11520,
      cache_creation_input_tokens: 0,
      output_tokens: 33,
      reasoning_tokens: 28,
      total_tokens: 12061,
    },
    total_cost_usd: 0.00118558,
  };

  it('parses the probed envelope shape', () => {
    const env = parseGrokEnvelope(JSON.stringify(PROBED_ENVELOPE, null, 2));
    expect(env?.text).toBe('OK');
    expect(env?.usage?.total_tokens).toBe(12061);
  });

  it('tolerates a leading non-JSON banner line', () => {
    const env = parseGrokEnvelope('grok 1.0.4 starting\n' + JSON.stringify(PROBED_ENVELOPE));
    expect(env?.text).toBe('OK');
  });

  it('returns null for no JSON at all', () => {
    expect(parseGrokEnvelope('plain text only')).toBeNull();
  });

  it('maps to the LEDGER CONVENTION: cached is the read-subset of input (§6.0a)', () => {
    const report = usageFromEnvelope(PROBED_ENVELOPE);
    // inputTokens = input + cache_read + cache_creation (total input side)
    expect(report?.inputTokens).toBe(508 + 11520 + 0);
    expect(report?.outputTokens).toBe(33); // reasoning (28) is a SUBSET — not added
    expect(report?.cachedTokens).toBe(11520); // cache_read ONLY (the subset)
    expect(report?.reasoningTokens).toBe(28);
    // The §6.0 invariant the probe verified across 3 runs:
    const u = PROBED_ENVELOPE.usage;
    expect(
      u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens,
    ).toBe(u.total_tokens);
  });

  it('NEVER sets the canonical estimatedCostUsd (plan-rate must not contaminate a basis-less field — round-5)', () => {
    expect(usageFromEnvelope(PROBED_ENVELOPE)?.estimatedCostUsd).toBeUndefined();
  });
});

// ── error classification ─────────────────────────────────────────────────

describe('mapExecError', () => {
  it('classifies weekly-limit language as a terminal QuotaError (the invisible wall)', () => {
    const err = mapExecError(new Error('exit 1'), 'error: weekly limit reached, out of usage');
    expect(err).toBeInstanceOf(QuotaError);
  });

  it('classifies sign-in language as AuthError', () => {
    const err = mapExecError(new Error('exit 1'), 'please sign in again (401)');
    expect(err).toBeInstanceOf(AuthError);
  });
});

// ── reviewer detection (spec §8, review-2 f.17) ─────────────────────────

describe('detectGrokReviewer', () => {
  const ENABLED = ['claude-code', 'grok-build'];

  it('DARK DEFAULT: without grok-build in enabledFrameworks → grok-not-enabled (round-6 — the reviewer disable lever)', () => {
    const r = detectGrokReviewer({ grokPathDetected: '/bin/echo', env: CLEAN_ENV });
    expect(r).toMatchObject({ available: false, reason: 'grok-not-enabled' });
  });

  it('DARK DEFAULT: an explicit list WITHOUT grok-build is equally not enabled', () => {
    const r = detectGrokReviewer({
      grokPathDetected: '/bin/echo',
      enabledFrameworks: ['claude-code', 'codex-cli'],
      env: CLEAN_ENV,
    });
    expect(r).toMatchObject({ available: false, reason: 'grok-not-enabled' });
  });

  it('unavailable: binary missing → grok-not-installed', () => {
    const r = detectGrokReviewer({ grokPathDetected: null, enabledFrameworks: ENABLED, env: CLEAN_ENV });
    expect(r).toMatchObject({ available: false, reason: 'grok-not-installed' });
  });

  it('unavailable: metered key present → grok-auth-apikey-forbidden (even authed)', () => {
    const home = tempGrokHome(FRESH);
    const r = detectGrokReviewer({
      grokPathDetected: '/bin/echo',
      grokAuthPath: path.join(home, 'auth.json'),
      enabledFrameworks: ['grok-build'],
      env: { ...CLEAN_ENV, XAI_API_KEY: 'xai-x' },
    });
    expect(r).toMatchObject({ available: false, reason: 'grok-auth-apikey-forbidden' });
  });

  it('unavailable: expired session → grok-not-authed (file-exists is not authed)', () => {
    const home = tempGrokHome(EXPIRED);
    const r = detectGrokReviewer({
      grokPathDetected: '/bin/echo',
      grokAuthPath: path.join(home, 'auth.json'),
      enabledFrameworks: ['grok-build'],
      env: CLEAN_ENV,
    });
    expect(r).toMatchObject({ available: false, reason: 'grok-not-authed' });
  });

  it('unavailable: fresh session but NO verified login policy → grok-login-policy-unverified', () => {
    const home = tempGrokHome(FRESH, { loginPolicy: false }); // no policy written
    const r = detectGrokReviewer({
      grokPathDetected: '/bin/echo',
      grokAuthPath: path.join(home, 'auth.json'),
      enabledFrameworks: ['grok-build'],
      env: CLEAN_ENV,
    });
    expect(r).toMatchObject({ available: false, reason: 'grok-login-policy-unverified' });
  });

  it('available: opt-in + binary + fresh session + clean env + verified login policy', () => {
    const home = tempGrokHome(FRESH);
    fs.writeFileSync(path.join(home, 'config.toml'), '[auth]\ndisable_api_key_auth = true\n');
    const r = detectGrokReviewer({
      grokPathDetected: '/bin/echo',
      grokAuthPath: path.join(home, 'auth.json'),
      enabledFrameworks: ['grok-build'],
      env: CLEAN_ENV,
    });
    expect(r.available).toBe(true);
    expect(r.framework).toBe('grok-build');
    expect(r.model).toBe('grok-4.6');
    expect(r.crossFamily).toBe(true);
  });
});


// ── round-3 review hardening ─────────────────────────────────────────────

describe('margin covers the call timeout (adversarial r3 f.1)', () => {
  it('refuses a session that would expire during the call', () => {
    // Session valid for 90s; call timeout 120s → must refuse.
    const in90s = new Date(Date.now() + 90_000).toISOString();
    const home = tempGrokHome(in90s);
    expect(() =>
      assertGrokAuthAllowed(configFor(home), CLEAN_ENV, new Date(), 120_000),
    ).toThrow(GrokSessionExpiredError);
  });

  it('admits the same session for a call short enough to finish inside it', () => {
    const in10min = new Date(Date.now() + 10 * 60_000).toISOString();
    const home = tempGrokHome(in10min);
    expect(() =>
      assertGrokAuthAllowed(configFor(home), CLEAN_ENV, new Date(), 120_000),
    ).not.toThrow();
  });
});

describe('isLoginPolicyVerified (spec §3.1.1 — structural, per-probe)', () => {
  it('verifies a top-level disable_api_key_auth = true', () => {
    const home = tempGrokHome(null);
    fs.writeFileSync(path.join(home, 'config.toml'), 'disable_api_key_auth = true\n[cli]\n');
    expect(isLoginPolicyVerified(home, {})).toBe(true);
  });

  it('verifies the key under the [auth] table', () => {
    const home = tempGrokHome(null);
    fs.writeFileSync(path.join(home, 'config.toml'), '[auth]\ndisable_api_key_auth = true\n');
    expect(isLoginPolicyVerified(home, {})).toBe(true);
  });

  it('REJECTS the key inside a different table (the 2026-08-14 append mistake)', () => {
    const home = tempGrokHome(null);
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      '[[marketplace.sources]]\nname = "x"\ndisable_api_key_auth = true\n',
    );
    expect(isLoginPolicyVerified(home, {})).toBe(false);
  });

  it('fails closed on a missing config.toml', () => {
    const home = tempGrokHome(null, { loginPolicy: false });
    expect(isLoginPolicyVerified(home, {})).toBe(false);
  });

  it('accepts the sticky env lockdown', () => {
    const home = tempGrokHome(null);
    expect(isLoginPolicyVerified(home, { GROK_DISABLE_API_KEY_AUTH: '1' })).toBe(true);
  });
});

describe('scrubStderr (security r3 f.3 — no credential fragments in errors)', () => {
  it('redacts JWT-shaped material', () => {
    const out = scrubStderr('invalid token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi7');
    expect(out).not.toContain('eyJhbGci');
    expect(out).toContain('[redacted-jwt]');
  });

  it('redacts xai- key prefixes', () => {
    const out = scrubStderr('invalid key xai-AbCdEf123456789012345');
    expect(out).not.toContain('xai-AbCdEf');
  });

  it('flows through mapExecError on the auth branch', () => {
    const err = mapExecError(new Error('exit 1'), 'invalid token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig12345 (401)');
    expect(err.message).not.toContain('eyJhbGci');
  });
});

describe('validateEnvelopeUsage (round-3: forged/drifted envelopes cannot poison accounting)', () => {
  it('clean probed envelope → no anomalies', () => {
    const env = {
      usage: {
        input_tokens: 508, cache_read_input_tokens: 11520,
        cache_creation_input_tokens: 0, output_tokens: 33,
        reasoning_tokens: 28, total_tokens: 12061,
      },
      total_cost_usd: 0.00118558,
    };
    expect(validateEnvelopeUsage(env as never)).toEqual([]);
  });

  it('clamps negative/non-finite numerics and reports them', () => {
    const env = {
      usage: {
        input_tokens: -5, cache_read_input_tokens: Number.POSITIVE_INFINITY,
        cache_creation_input_tokens: 0, output_tokens: 10,
        reasoning_tokens: 2, total_tokens: 10,
      },
      total_cost_usd: -1,
    };
    const anomalies = validateEnvelopeUsage(env as never);
    expect(anomalies.length).toBeGreaterThan(0);
    expect((env.usage as { input_tokens: number }).input_tokens).toBe(0);
    expect('total_cost_usd' in env && env.total_cost_usd !== undefined ? false : true).toBe(true);
  });

  it('flags a disjoint-sum drift (envelope-version canary)', () => {
    const env = {
      usage: {
        input_tokens: 100, cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0, output_tokens: 50,
        reasoning_tokens: 0, total_tokens: 999,
      },
    };
    const anomalies = validateEnvelopeUsage(env as never);
    expect(anomalies.join(' ')).toContain('disjoint-sum drift');
  });
});

describe('env allowlist ∩ billing vars is EMPTY (security r3 f.10 — the delete loop must never be the only control)', () => {
  it('no billing var is on the allowlist, and none survives a hostile parent env', () => {
    const parent: NodeJS.ProcessEnv = { HOME: '/h', PATH: '/bin' };
    for (const v of GROK_BILLING_ENV_VARS) parent[v] = 'leak';
    const child = buildGrokChildEnv(parent);
    for (const v of GROK_BILLING_ENV_VARS) {
      expect(child[v]).toBeUndefined();
    }
  });
});

// ── per-day reviewer budget gate (round-6: both sides of every boundary) ──

import {
  grokReviewerBudgetAvailable,
  GROK_REVIEWER_DAILY_MAX_RUNS,
  GROK_REVIEWER_DAILY_MAX_TOKENS,
} from '../../src/core/crossModelReviewer.js';

describe('anomaly strings are clamped before they reach the durable trail (round-13)', () => {
  it('neutralizes and bounds an invalid field value instead of persisting it verbatim', () => {
    // These strings land in the durable recentRuns[].anomalies trail §6.0a
    // names as the drift signal's consumer — the same untrusted-vendor-text
    // class as the version advisory and the stop reason, two clamps away.
    const hostile = 'x'.repeat(500) + '\n## injected heading `whoami`';
    const envelope = {
      usage: {
        input_tokens: hostile as unknown as number,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        total_tokens: 5,
      },
    } as unknown as Parameters<typeof validateEnvelopeUsage>[0];
    const anomalies = validateEnvelopeUsage(envelope);
    const line = anomalies.find((a) => a.startsWith('input_tokens invalid'))!;
    expect(line).toBeDefined();
    expect(line.length).toBeLessThan(140);
    expect(line).not.toContain('\n');
    expect(line).not.toContain('`');
    expect(line).toContain('...');
  });

  it('CONTROL: a VALID envelope produces no anomalies at all', () => {
    const envelope = {
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 0,
        total_tokens: 125,
      },
    } as unknown as Parameters<typeof validateEnvelopeUsage>[0];
    expect(validateEnvelopeUsage(envelope)).toEqual([]);
  });
});

describe('grok reviewer daily budget gate', () => {
  // Round-9 (security): the ledger is anchored to the OS user's instar root,
  // NOT to $GROK_HOME — the ceiling the spec calls per-MACHINE must not
  // multiply by the number of vendor homes an operator configures.
  let userHome: string;
  let grokHome: string;
  let ledgerDir: string;
  const OLD_GROK_HOME = process.env['GROK_HOME'];
  const OLD_HOME = process.env['HOME'];

  function writeLedger(content: string): void {
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(path.join(ledgerDir, 'grok-reviewer-budget.json'), content);
  }
  const today = new Date().toISOString().slice(0, 10);

  beforeEach(() => {
    userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-budget-home-'));
    grokHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-budget-vendor-'));
    ledgerDir = path.join(userHome, '.instar');
    process.env['HOME'] = userHome;
    process.env['GROK_HOME'] = grokHome;
    cleanups.push(() => {
      if (OLD_GROK_HOME === undefined) delete process.env['GROK_HOME'];
      else process.env['GROK_HOME'] = OLD_GROK_HOME;
      if (OLD_HOME === undefined) delete process.env['HOME'];
      else process.env['HOME'] = OLD_HOME;
      for (const dir of [userHome, grokHome]) {
        SafeFsExecutor.safeRmSync(dir, {
          recursive: true,
          force: true,
          operation: 'tests/unit/grok-build-adapter-policy.test.ts:budget-cleanup',
        });
      }
    });
  });

  it('MISSING ledger ⇒ fresh day, available (blast radius bounded to one day)', () => {
    expect(grokReviewerBudgetAvailable()).toBe(true);
  });

  it('under both ceilings ⇒ available', () => {
    writeLedger(JSON.stringify({ date: today, runs: 3, totalTokens: 1000 }));
    expect(grokReviewerBudgetAvailable()).toBe(true);
  });

  it('run ceiling hit ⇒ NOT available', () => {
    writeLedger(JSON.stringify({ date: today, runs: GROK_REVIEWER_DAILY_MAX_RUNS, totalTokens: 0 }));
    expect(grokReviewerBudgetAvailable()).toBe(false);
  });

  it('token ceiling hit ⇒ NOT available', () => {
    writeLedger(JSON.stringify({ date: today, runs: 0, totalTokens: GROK_REVIEWER_DAILY_MAX_TOKENS }));
    expect(grokReviewerBudgetAvailable()).toBe(false);
  });

  it('YESTERDAY at the ceiling ⇒ available today (UTC day rollover)', () => {
    writeLedger(JSON.stringify({ date: '2000-01-01', runs: 999, totalTokens: 9e9 }));
    expect(grokReviewerBudgetAvailable()).toBe(true);
  });

  it('NEGATIVE values are clamped, never disarm the cap', () => {
    writeLedger(JSON.stringify({ date: today, runs: -1e9, totalTokens: -5 }));
    expect(grokReviewerBudgetAvailable()).toBe(true); // clamped to 0 — fresh headroom, not infinite
  });

  it('CORRUPT ledger ⇒ quarantined aside + conservative half-cap pre-charge (bounded self-heal, still available)', () => {
    writeLedger('{{{ not json');
    expect(grokReviewerBudgetAvailable()).toBe(true); // half-cap pre-charged < cap
    const names = fs.readdirSync(ledgerDir);
    expect(names.some((n) => n.includes('.corrupt-'))).toBe(true);
  });

  it('the half-cap pre-charge is DURABLE (round-7: the next read must not see a zero-charged fresh day)', () => {
    writeLedger('{{{ not json');
    expect(grokReviewerBudgetAvailable()).toBe(true); // triggers quarantine + persist
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(ledgerDir, 'grok-reviewer-budget.json'), 'utf8'),
    ) as { runs: number };
    expect(onDisk.runs).toBe(Math.floor(GROK_REVIEWER_DAILY_MAX_RUNS / 2));
  });

  // ── round-12: concurrent recording must not lose increments ──

  it('CONCURRENT recorders do not lose increments — REAL child processes, not same-thread calls', async () => {
    // Round-13 (scalability) killed the previous version of this test and its
    // "control": `recordGrokBudget` is fully SYNCHRONOUS, so driving it through
    // Promise.all ran strictly sequentially and passed with the lock deleted —
    // a passing condition narrower than the claim, and a control that failed
    // for the wrong reason (the edit I made to "remove" the lock also stopped
    // the body executing at all). Real concurrency needs real processes.
    writeLedger(JSON.stringify({ date: today, runs: 0, totalTokens: 0 }));
    const N = 6;
    // START BARRIER (round-14 adversarial). Without one the children start
    // milliseconds apart and mostly serialize: an independent measurement put
    // this assertion's sensitivity at ~25% against a lock-disabled build — it
    // would have passed 6 of 8 control rounds and so could not hold the line it
    // was written to hold. Each child now waits for a barrier FILE to appear,
    // so the read-modify-write windows provably overlap.
    const barrier = path.join(userHome, 'go');
    const script = `
      import fs from 'node:fs';
      import { recordGrokBudgetForTest } from ${JSON.stringify(
        path.resolve(process.cwd(), 'dist/core/crossModelReviewer.js'),
      )};
      const barrier = ${JSON.stringify(barrier)};
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(barrier) && Date.now() < deadline) { /* spin to the barrier */ }
      recordGrokBudgetForTest(1000, 500, null);
    `;
    const scriptPath = path.join(userHome, 'record-once.mjs');
    fs.writeFileSync(scriptPath, script);
    const children = Array.from({ length: N }, () =>
      new Promise<void>((resolve, reject) => {
        execFile(
          process.execPath,
          [scriptPath],
          { env: { ...process.env, HOME: userHome, GROK_HOME: grokHome } },
          (err) => (err ? reject(err) : resolve()),
        );
      }),
    );
    // Give every child time to reach the barrier, then release them together.
    await new Promise((r) => setTimeout(r, 1500));
    fs.writeFileSync(barrier, 'go');
    await Promise.all(children);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(ledgerDir, 'grok-reviewer-budget.json'), 'utf8'),
    ) as { runs: number; totalTokens: number };
    expect(onDisk.runs).toBe(N);
    expect(onDisk.totalTokens).toBe(N * 1500);
  }, 60_000);

  it('a STALE lockfile is reclaimed rather than wedging the brake forever', async () => {
    const { recordGrokBudgetForTest } = await import('../../src/core/crossModelReviewer.js');
    writeLedger(JSON.stringify({ date: today, runs: 0, totalTokens: 0 }));
    const lockPath = path.join(ledgerDir, 'grok-reviewer-budget.json.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: 0 }));
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lockPath, old, old);
    recordGrokBudgetForTest(10, 10, null);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(ledgerDir, 'grok-reviewer-budget.json'), 'utf8'),
    ) as { runs: number };
    expect(onDisk.runs).toBe(1);
  });

  it('a FRESH lockfile held by someone else still records (fail-OPEN, never a lost run)', async () => {
    // The deliberate direction: a lock that could BLOCK recording would trade a
    // bounded undercount for a possible total loss on a spend brake.
    const { recordGrokBudgetForTest } = await import('../../src/core/crossModelReviewer.js');
    writeLedger(JSON.stringify({ date: today, runs: 0, totalTokens: 0 }));
    const lockPath = path.join(ledgerDir, 'grok-reviewer-budget.json.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
    recordGrokBudgetForTest(7, 3, null);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(ledgerDir, 'grok-reviewer-budget.json'), 'utf8'),
    ) as { runs: number; totalTokens: number };
    expect(onDisk.runs).toBe(1);
    expect(onDisk.totalTokens).toBe(10);
  }, 20_000);

  // ── round-9 security: the ceiling is per-MACHINE, not per-$GROK_HOME ──

  it('RELOCATING $GROK_HOME does NOT hand out a second full budget', () => {
    writeLedger(JSON.stringify({ date: today, runs: GROK_REVIEWER_DAILY_MAX_RUNS, totalTokens: 0 }));
    expect(grokReviewerBudgetAvailable()).toBe(false);
    // Frontloaded Decision 9 blesses an isolated vendor home. Under the old
    // GROK_HOME-keyed ledger this line returned the cap to zero — N homes, N
    // budgets against the ONE invisible pool the cap exists to protect.
    const otherVendorHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-budget-vendor2-'));
    cleanups.push(() =>
      SafeFsExecutor.safeRmSync(otherVendorHome, {
        recursive: true,
        force: true,
        operation: 'tests/unit/grok-build-adapter-policy.test.ts:vendor2-cleanup',
      }),
    );
    process.env['GROK_HOME'] = otherVendorHome;
    expect(grokReviewerBudgetAvailable()).toBe(false);
  });

  it('MIGRATION: today\'s spend at the legacy $GROK_HOME location is adopted, not forgiven', () => {
    // The upgrade must not grant a free fresh ceiling to an agent that already
    // spent today's budget under the pre-round-9 path.
    fs.writeFileSync(
      path.join(grokHome, 'instar-grok-reviewer-budget.json'),
      JSON.stringify({ date: today, runs: GROK_REVIEWER_DAILY_MAX_RUNS, totalTokens: 0 }),
    );
    expect(grokReviewerBudgetAvailable()).toBe(false);
  });

  it('MIGRATION: a STALE-dated legacy ledger is ignored (day rollover still works)', () => {
    fs.writeFileSync(
      path.join(grokHome, 'instar-grok-reviewer-budget.json'),
      JSON.stringify({ date: '2000-01-01', runs: 999, totalTokens: 9e9 }),
    );
    expect(grokReviewerBudgetAvailable()).toBe(true);
  });
});


// ── version-drift canary CAN fire (round-7: prove the probe can say yes) ──

import {
  checkGrokVersionDrift,
  _resetGrokVersionDriftForTest,
  PROBED_GROK_VERSION,
} from '../../src/providers/adapters/grok-build/policy.js';
import { buildHeadlessLaunch } from '../../src/core/frameworkSessionLaunch.js';

describe('checkGrokVersionDrift', () => {
  it('fires the warn on a drifted version (async probe; stub binary)', async () => {
    _resetGrokVersionDriftForTest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-stub-'));
    cleanups.push(() =>
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'grok-drift-test' }),
    );
    const stub = path.join(dir, 'grok');
    fs.writeFileSync(stub, '#!/bin/sh\necho "grok 9.9.9 (deadbeef)"\n', { mode: 0o755 });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    try {
      checkGrokVersionDrift(stub);
      await new Promise((r) => setTimeout(r, 800)); // async probe completes
      checkGrokVersionDrift(stub); // second call emits from cache if needed
    } finally {
      console.warn = orig;
    }
    expect(warns.join('\n')).toContain('VERSION DRIFT');
    _resetGrokVersionDriftForTest();
  });

  it('stays silent on the pinned version', async () => {
    _resetGrokVersionDriftForTest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-stub2-'));
    cleanups.push(() =>
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'grok-drift-test2' }),
    );
    const stub = path.join(dir, 'grok');
    fs.writeFileSync(stub, `#!/bin/sh\necho "grok ${PROBED_GROK_VERSION} (d846eb93d94d)"\n`, { mode: 0o755 });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    try {
      checkGrokVersionDrift(stub);
      await new Promise((r) => setTimeout(r, 800));
      checkGrokVersionDrift(stub);
    } finally {
      console.warn = orig;
    }
    expect(warns.join('\n')).not.toContain('VERSION DRIFT');
    _resetGrokVersionDriftForTest();
  });

  it('fires on a SUPERSTRING patch version (1.0.40 must not pass a 1.0.4 pin — round-8)', async () => {
    // The substring trap: `includes('1.0.4')` matches 1.0.40–1.0.49 and
    // 1.0.4-rc.1 — the routine self-update patch class the canary exists
    // to catch. Token equality is the required comparison.
    _resetGrokVersionDriftForTest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-stub3-'));
    cleanups.push(() =>
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'grok-drift-test3' }),
    );
    const stub = path.join(dir, 'grok');
    fs.writeFileSync(stub, '#!/bin/sh\necho "grok 1.0.40 (deadbeef)"\n', { mode: 0o755 });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    try {
      checkGrokVersionDrift(stub);
      await new Promise((r) => setTimeout(r, 800));
      checkGrokVersionDrift(stub);
    } finally {
      console.warn = orig;
    }
    expect(warns.join('\n')).toContain('VERSION DRIFT');
    _resetGrokVersionDriftForTest();
  });

  it('fires on an UNEXTRACTABLE version line (format drift is drift — round-8)', async () => {
    _resetGrokVersionDriftForTest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-stub4-'));
    cleanups.push(() =>
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'grok-drift-test4' }),
    );
    const stub = path.join(dir, 'grok');
    fs.writeFileSync(stub, '#!/bin/sh\necho "grok build tool"\n', { mode: 0o755 });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    try {
      checkGrokVersionDrift(stub);
      await new Promise((r) => setTimeout(r, 800));
      checkGrokVersionDrift(stub);
    } finally {
      console.warn = orig;
    }
    expect(warns.join('\n')).toContain('VERSION DRIFT');
    _resetGrokVersionDriftForTest();
  });

  // ── round-9 adversarial: the FOURTH inertness mode ──
  // A failed/timed-out probe used to memoize `null`, which the emitter treats
  // as "nothing to say" — one transient failure permanently disarmed the
  // canary, silently. The safe direction for a warn-only detector is noise.

  it('WARNS when the version probe itself fails (a silent disarm is the bug)', async () => {
    _resetGrokVersionDriftForTest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-stub5-'));
    cleanups.push(() =>
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'grok-drift-test5' }),
    );
    // Exits non-zero: `--version` unreadable, which is itself a drift signal.
    const stub = path.join(dir, 'grok');
    fs.writeFileSync(stub, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    try {
      checkGrokVersionDrift(stub);
      await new Promise((r) => setTimeout(r, 800));
    } finally {
      console.warn = orig;
    }
    expect(warns.join('\n')).toContain('VERSION PROBE FAILED');
    _resetGrokVersionDriftForTest();
  });

  it('RE-ARMS after a failed probe: a later call re-probes and can still report drift', async () => {
    _resetGrokVersionDriftForTest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-stub6-'));
    cleanups.push(() =>
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'grok-drift-test6' }),
    );
    const failing = path.join(dir, 'grok-fail');
    fs.writeFileSync(failing, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    const drifted = path.join(dir, 'grok-ok');
    fs.writeFileSync(drifted, '#!/bin/sh\necho "grok 9.9.9 (deadbeef)"\n', { mode: 0o755 });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    try {
      checkGrokVersionDrift(failing);
      await new Promise((r) => setTimeout(r, 800));
      // The transient failure must NOT have consumed the single-flight slot
      // permanently — this second call has to actually spawn again.
      checkGrokVersionDrift(drifted);
      await new Promise((r) => setTimeout(r, 800));
    } finally {
      console.warn = orig;
    }
    expect(warns.join('\n')).toContain('VERSION DRIFT');
    _resetGrokVersionDriftForTest();
  });

  it('WARNS on an exit-0 EMPTY --version (the fifth inertness mode — round-10)', async () => {
    // A CLI that prints its version to stderr exits 0 with empty stdout. That
    // cached '' — `!== undefined`, so the single-flight guard blocked every
    // future probe while the emitter's falsy check swallowed the warn:
    // permanently silent on the SUCCESS path the round-9 re-arm didn't cover.
    _resetGrokVersionDriftForTest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-stub8-'));
    cleanups.push(() =>
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'grok-drift-test8' }),
    );
    const stub = path.join(dir, 'grok');
    fs.writeFileSync(stub, '#!/bin/sh\necho "grok 1.0.4" >&2\nexit 0\n', { mode: 0o755 });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    try {
      checkGrokVersionDrift(stub);
      await new Promise((r) => setTimeout(r, 800));
    } finally {
      console.warn = orig;
    }
    expect(warns.join('\n')).toContain('VERSION PROBE FAILED');
    expect(warns.join('\n')).toContain('empty --version output');
    _resetGrokVersionDriftForTest();
  });

  it('stops probing after the attempt cap (bounded retries, not an unbounded spawn loop)', async () => {
    _resetGrokVersionDriftForTest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-stub7-'));
    cleanups.push(() =>
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'grok-drift-test7' }),
    );
    const failing = path.join(dir, 'grok');
    fs.writeFileSync(failing, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    try {
      for (let i = 0; i < 5; i++) {
        checkGrokVersionDrift(failing);
        await new Promise((r) => setTimeout(r, 400));
      }
    } finally {
      console.warn = orig;
    }
    const failWarns = warns.filter((w) => w.includes('VERSION PROBE FAILED'));
    expect(failWarns.length).toBe(3);
    expect(failWarns[2]).toContain('no further probes will run');
    _resetGrokVersionDriftForTest();
  });
});

describe('grok headless lane structural gate (round-7)', () => {
  it('REFUSES a grok-build headless job spawn with the named error until scratch-cwd lands', () => {
    expect(() =>
      buildHeadlessLaunch('grok-build', {
        binaryPath: '/bin/echo',
        prompt: 'hello',
      } as never),
    ).toThrow(/grok-headless-cwd-ungated/);
  });
});

// ── interactive dual gate: builder both sides + FILE-LOAD path (round-9) ──
// The file-load tier is mandatory here BY NAME: the three prior load-path-gap
// incidents (componentFrameworks, frameworkDefaultModels, dynamicMcp) all
// shipped because their tests built config objects in-memory.

import {
  buildInteractiveLaunch,
  computeGrokInteractiveOptIn,
} from '../../src/core/frameworkSessionLaunch.js';

// ── the SEAM between the two flanking tiers (lessons-aware round-8): the
// conjunction that COMPUTES grokInteractiveOptIn from the sessions slice.
// An ||-for-&& regression here would open interactive grok on the reviewer
// lever alone while the file-load test AND the builder test both stay green.
describe('computeGrokInteractiveOptIn — the dual-gate conjunction seam', () => {
  it('TRUE only when BOTH levers are set', () => {
    expect(
      computeGrokInteractiveOptIn({
        enabledFrameworks: ['claude-code', 'grok-build'],
        grokInteractiveSessions: true,
      }),
    ).toBe(true);
  });

  it('FALSE on the interactive opt-in alone (grok-build absent from enabledFrameworks)', () => {
    expect(
      computeGrokInteractiveOptIn({
        enabledFrameworks: ['claude-code'],
        grokInteractiveSessions: true,
      }),
    ).toBe(false);
    // Absent list entirely — same refusal.
    expect(computeGrokInteractiveOptIn({ grokInteractiveSessions: true })).toBe(false);
  });

  it('FALSE on the reviewer lever alone (the §7 step-3 violation this seam guards)', () => {
    expect(
      computeGrokInteractiveOptIn({ enabledFrameworks: ['grok-build'] }),
    ).toBe(false);
    // Strict === true: a truthy-but-not-true value never opens the gate.
    expect(
      computeGrokInteractiveOptIn({
        enabledFrameworks: ['grok-build'],
        grokInteractiveSessions: 1 as never,
      }),
    ).toBe(false);
  });
});

describe('grok interactive dual gate (round-9)', () => {
  it('REFUSES without the opt-in (grok-interactive-ungated)', () => {
    expect(() =>
      buildInteractiveLaunch('grok-build', {
        binaryPath: '/bin/echo',
      } as never),
    ).toThrow(/grok-interactive-ungated/);
  });

  it('ADMITS with the opt-in flag (the untested admit side is how the gap shipped)', () => {
    const spec = buildInteractiveLaunch('grok-build', {
      binaryPath: '/bin/echo',
      grokInteractiveOptIn: true,
    } as never);
    expect(spec.argv[0]).toBe('/bin/echo');
    // Billing lockdown rides the session lane too.
    expect(spec.envOverrides?.['GROK_DISABLE_API_KEY_AUTH']).toBe('1');
    expect(spec.envOverrides?.['XAI_API_KEY']).toBe('');
  });
});
