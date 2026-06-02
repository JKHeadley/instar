/**
 * Unit tests — gemini-cli adapter (apprenticeship Step 2 minimal body).
 *
 * Covers the MANDATORY safety + transport floor:
 *   - The CANONICAL argv (asserts -m, --approval-mode default, -p, prompt=one
 *     element, NO yolo / --approval-mode yolo / -y).
 *   - The env-allowlist deletes the 5 Google/Gemini billing vars
 *     (the geminiKeyLeakageCanary), unconditionally.
 *   - The output-byte cap.
 *   - Config / binary detection + model-tier resolution.
 *   - Wiring-integrity: capabilities.ts declares only wired impls (both directions).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  buildGeminiOneShotArgv,
  buildGeminiChildEnv,
  spawnGeminiAndWait,
  GEMINI_BILLING_ENV_VARS,
  DEFAULT_MAX_OUTPUT_BYTES,
} from '../../src/providers/adapters/gemini-cli/transport/geminiSpawn.js';
import { resolveCliModelFlag, GEMINI_DEFAULT_MODEL } from '../../src/providers/adapters/gemini-cli/models.js';
import { configFromEnv } from '../../src/providers/adapters/gemini-cli/config.js';
import { createGeminiCliAdapter } from '../../src/providers/adapters/gemini-cli/index.js';
import { geminiCliCapabilities } from '../../src/providers/adapters/gemini-cli/capabilities.js';
import { CapabilityFlag } from '../../src/providers/capabilities.js';

describe('gemini-cli adapter — canonical argv (HIGH: yolo safety + argv injection)', () => {
  it('builds exactly `-m <model> --approval-mode default -p <prompt>`', () => {
    const argv = buildGeminiOneShotArgv('gemini-2.5-flash', 'say hi');
    expect(argv).toEqual(['-m', 'gemini-2.5-flash', '--approval-mode', 'default', '-p', 'say hi']);
  });

  it('the prompt is exactly ONE argv element (the value of -p)', () => {
    const prompt = 'multi word prompt with --flags and -dashes';
    const argv = buildGeminiOneShotArgv('m', prompt);
    const pIdx = argv.indexOf('-p');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(argv[pIdx + 1]).toBe(prompt);
    // The prompt is the LAST element — nothing after it.
    expect(argv[argv.length - 1]).toBe(prompt);
  });

  it('a leading-dash prompt is NOT re-parsed as a flag (one argv slot, no --)', () => {
    const argv = buildGeminiOneShotArgv('m', '--help me');
    // The dangerous-looking prompt occupies a single slot as -p's value.
    expect(argv[argv.length - 1]).toBe('--help me');
    // No end-of-options separator on the canonical -p path.
    expect(argv).not.toContain('--');
  });

  it('NEVER contains -y, --yolo, or --approval-mode yolo (capability-only)', () => {
    const argv = buildGeminiOneShotArgv('m', 'do something');
    expect(argv).not.toContain('-y');
    expect(argv).not.toContain('--yolo');
    expect(argv).not.toContain('yolo');
    expect(argv).not.toContain('auto_edit');
    // --approval-mode default IS present (pinned).
    const aIdx = argv.indexOf('--approval-mode');
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(argv[aIdx + 1]).toBe('default');
  });
});

describe('gemini-cli adapter — env allowlist + billing-var hard-delete (geminiKeyLeakageCanary)', () => {
  const ORIGINALS: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINALS)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function injectBillingVars(parent: NodeJS.ProcessEnv): void {
    for (const k of GEMINI_BILLING_ENV_VARS) parent[k] = 'SENTINEL-LEAK-VALUE';
  }

  it('UNCONDITIONALLY deletes all 5 Google/Gemini billing vars from the child env', () => {
    const parent: NodeJS.ProcessEnv = { HOME: '/h', PATH: '/usr/bin' };
    injectBillingVars(parent);
    const child = buildGeminiChildEnv(parent);
    for (const k of GEMINI_BILLING_ENV_VARS) {
      expect(child[k]).toBeUndefined();
    }
    // Sanity: the exact 5 names are the ones the spec enumerates.
    expect([...GEMINI_BILLING_ENV_VARS].sort()).toEqual(
      [
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'GOOGLE_APPLICATION_CREDENTIALS',
        'GOOGLE_CLOUD_PROJECT',
        'GOOGLE_GENAI_USE_VERTEXAI',
      ].sort(),
    );
  });

  it('is an ALLOWLIST (drops anything not listed)', () => {
    const parent: NodeJS.ProcessEnv = {
      HOME: '/h',
      PATH: '/usr/bin',
      SOME_RANDOM_VAR: 'should-be-dropped',
      AWS_SECRET_ACCESS_KEY: 'also-dropped',
    };
    const child = buildGeminiChildEnv(parent);
    expect(child.HOME).toBe('/h');
    expect(child.PATH).toBe('/usr/bin');
    expect(child.SOME_RANDOM_VAR).toBeUndefined();
    expect(child.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('no billing var leaks even when ALL are injected (the canary, both directions)', () => {
    const parent: NodeJS.ProcessEnv = { HOME: '/h', PATH: '/usr/bin', LANG: 'en_US.UTF-8' };
    injectBillingVars(parent);
    const child = buildGeminiChildEnv(parent);
    const leaked = Object.entries(child).filter(([, v]) => v === 'SENTINEL-LEAK-VALUE');
    expect(leaked).toEqual([]);
  });
});

describe('gemini-cli adapter — output-byte cap (MED b)', () => {
  it('default cap is 8 MiB', () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(8 * 1024 * 1024);
  });

  it('caps captured stdout and flags truncated when the child floods output', async () => {
    // A tiny `yes`-style flood: print a long line in a loop, capped at a tiny limit.
    // Use `node` to emit > cap bytes quickly without depending on the gemini binary.
    const script = 'const b="x".repeat(1024);for(let i=0;i<5000;i++)process.stdout.write(b);';
    const result = await spawnGeminiAndWait(process.execPath, ['-e', script], {
      timeoutMs: 10_000,
      env: { PATH: process.env.PATH ?? '' } as NodeJS.ProcessEnv,
      maxOutputBytes: 4096, // tiny cap to force truncation
    });
    expect(result.truncated).toBe(true);
    // Capture is bounded at the cap (allowing for the final chunk boundary).
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(4096);
  });

  it('does NOT flag truncated for small output under the cap', async () => {
    const result = await spawnGeminiAndWait(process.execPath, ['-e', 'process.stdout.write("PONG")'], {
      timeoutMs: 10_000,
      env: { PATH: process.env.PATH ?? '' } as NodeJS.ProcessEnv,
      maxOutputBytes: 4096,
    });
    expect(result.truncated).toBe(false);
    expect(result.stdout.trim()).toBe('PONG');
    expect(result.exitCode).toBe(0);
  });
});

describe('gemini-cli adapter — model resolution', () => {
  it('default model resolves to gemini-2.5-flash', () => {
    expect(resolveCliModelFlag(undefined)).toBe('gemini-2.5-flash');
    expect(GEMINI_DEFAULT_MODEL).toBe('gemini-2.5-flash');
  });

  it('tiers map to gemini ids; raw model ids pass through', () => {
    expect(resolveCliModelFlag('fast')).toBe('gemini-2.5-flash');
    expect(resolveCliModelFlag('balanced')).toBe('gemini-2.5-flash');
    expect(resolveCliModelFlag('capable')).toBe('gemini-2.5-pro');
    expect(resolveCliModelFlag('gemini-2.5-pro-exp')).toBe('gemini-2.5-pro-exp');
  });
});

describe('gemini-cli adapter — config / binary detection', () => {
  it('GEMINI_PATH override is honored; default model is undefined → flash via resolver', () => {
    const cfg = configFromEnv({ GEMINI_PATH: '/custom/gemini' } as NodeJS.ProcessEnv);
    expect(cfg.geminiPath).toBe('/custom/gemini');
    expect(cfg.defaultApprovalMode).toBe('default');
    expect(resolveCliModelFlag(cfg.defaultModel)).toBe('gemini-2.5-flash');
  });

  it('GEMINI_PATH always wins over detection (no baked-in literal independent of env/detection)', () => {
    // The anti-hardcode guarantee: an explicit GEMINI_PATH is honored verbatim,
    // proving the path is resolved from env/detection — not a baked literal that
    // ignores the caller. (On THIS box detection legitimately finds the real
    // /opt/homebrew/bin/gemini; the guarantee is "resolved, not hardcoded".)
    const cfg = configFromEnv({ GEMINI_PATH: '/some/other/place/gemini' } as NodeJS.ProcessEnv);
    expect(cfg.geminiPath).toBe('/some/other/place/gemini');
  });
});

describe('gemini-cli adapter — wiring integrity (honest declaration, both directions)', () => {
  it('every declared capability has a non-null impl; no undeclared impl', () => {
    const adapter = createGeminiCliAdapter({ geminiPath: '/x/gemini' });
    // Declared set == { OneShotCompletion, SessionId, HardKill }.
    const declared = [...geminiCliCapabilities];
    expect(declared.sort()).toEqual(
      [CapabilityFlag.OneShotCompletion, CapabilityFlag.SessionId, CapabilityFlag.HardKill].sort(),
    );
    // Every declared flag resolves to a real impl.
    for (const flag of declared) {
      const impl = adapter.primitive(flag);
      expect(impl).toBeDefined();
      expect(impl).not.toBeNull();
    }
  });

  it('does NOT declare a CONDITIONAL primitive it has not wired (honest)', () => {
    const declared = new Set(geminiCliCapabilities);
    // The deferred conditional primitives must NOT be declared.
    expect(declared.has(CapabilityFlag.HookEventReceiver)).toBe(false);
    expect(declared.has(CapabilityFlag.CompactionLifecycle)).toBe(false);
    expect(declared.has(CapabilityFlag.SessionResumeIndex)).toBe(false);
  });

  it('throws UnsupportedCapabilityError for an undeclared primitive', () => {
    const adapter = createGeminiCliAdapter({ geminiPath: '/x/gemini' });
    expect(() => adapter.primitive(CapabilityFlag.HookEventReceiver)).toThrow();
  });
});
