/**
 * codexCapabilities — probe that `--dangerously-bypass-hook-trust` is supported.
 *
 * Uses tiny fake `codex` shell scripts so the probe runs against a real binary
 * whose `--help` output we control (with/without the flag), plus the fail-closed
 * and memoization paths.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexSupportsHookTrustBypass, codexSupportsGpt61Sol, codexSupportsNewerModels, codexModelForCli, codexModelForCliAsync, codexCliVersion, codexCliVersionCached, refreshCodexCliVersion, versionProbeTimeoutMs, CODEX_OLDER_CLI_FALLBACKS, __resetCodexCapabilityCache } from '../../src/core/codexCapabilities.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const made: string[] = [];

function fakeCodex(helpText: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-'));
  made.push(dir);
  const bin = path.join(dir, 'codex');
  // Use a shell builtin so the responding fixture never waits on a second process.
  const quoted = "'" + helpText.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' ${quoted}\n`, { mode: 0o755 });
  return bin;
}

beforeEach(() => {
  __resetCodexCapabilityCache();
  // Responding fixtures get scheduling headroom on a shared verifier.
  vi.stubEnv('INSTAR_CODEX_VERSION_PROBE_SCALE', '5');
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => { for (const d of made) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/codexCapabilities.test.ts:cleanup' }); });

describe('codexSupportsHookTrustBypass', () => {
  it('returns true when --help advertises the flag (codex >=0.133)', () => {
    const bin = fakeCodex('Usage: codex\n  --dangerously-bypass-hook-trust  Run enabled hooks without trust\n  -m, --model <M>');
    expect(codexSupportsHookTrustBypass(bin)).toBe(true);
  });

  it('returns false when --help does NOT advertise the flag (codex <0.133)', () => {
    const bin = fakeCodex('Usage: codex\n  --dangerously-bypass-approvals-and-sandbox\n  -m, --model <M>');
    expect(codexSupportsHookTrustBypass(bin)).toBe(false);
  });

  it('fails closed (false) when the binary path does not exist', () => {
    expect(codexSupportsHookTrustBypass('/nonexistent/path/to/codex')).toBe(false);
  });

  it('fails closed (false) for an empty binary path', () => {
    expect(codexSupportsHookTrustBypass('')).toBe(false);
  });

  it('memoizes per binary path (probe result is stable across calls)', () => {
    const bin = fakeCodex('  --dangerously-bypass-hook-trust');
    expect(codexSupportsHookTrustBypass(bin)).toBe(true);
    // Delete the binary; a cached "true" must persist (no re-probe).
    SafeFsExecutor.safeRmSync(bin, { force: true, operation: 'tests/unit/codexCapabilities.test.ts:memoization-probe' });
    expect(codexSupportsHookTrustBypass(bin)).toBe(true);
  });
});

describe('codexSupportsGpt61Sol', () => {
  it('accepts 0.166 and rejects 0.156, unknown output and missing binaries', () => {
    expect(codexSupportsGpt61Sol(fakeCodex('codex-cli 0.166.0'))).toBe(true);
    expect(codexSupportsGpt61Sol(fakeCodex('codex-cli 0.156.1'))).toBe(false);
    expect(codexSupportsGpt61Sol(fakeCodex('unknown'))).toBe(false);
    expect(codexSupportsGpt61Sol('/nonexistent/codex')).toBe(false);
  });
});

describe('older-CLI fallback for the GPT-6.x ids (live boundary 2026-11-17: 0.165.0 refuses, 0.166.0 answers)', () => {
  it('reads the CLI version, and null when it cannot', () => {
    expect(codexCliVersion(fakeCodex('codex-cli 0.169.0'))).toEqual({ major: 0, minor: 169, patch: 0 });
    expect(codexCliVersion(fakeCodex('garbage'))).toBeNull();
    expect(codexCliVersion('/nonexistent/codex')).toBeNull();
    expect(codexCliVersion('')).toBeNull();
  });

  it('gates at 0.166.0 exactly', () => {
    expect(codexSupportsNewerModels(fakeCodex('codex-cli 0.165.0'))).toBe(false);
    expect(codexSupportsNewerModels(fakeCodex('codex-cli 0.166.0'))).toBe(true);
    expect(codexSupportsNewerModels(fakeCodex('codex-cli 0.169.0'))).toBe(true);
    expect(codexSupportsNewerModels(fakeCodex('codex-cli 1.0.0'))).toBe(true);
  });

  it('maps each newer id to the same-size previous model', () => {
    expect(CODEX_OLDER_CLI_FALLBACKS).toEqual({
      'gpt-6.1-sol': 'gpt-6-sol',
      'gpt-6.2-sol': 'gpt-6-sol',
      'gpt-6.2-astra': 'gpt-6-astra',
    });
  });

  it.each([
    ['gpt-6.2-sol', 'gpt-6-sol'],
    ['gpt-6.2-astra', 'gpt-6-astra'],
    ['gpt-6.1-sol', 'gpt-6-sol'],
  ])('%s: kept on 0.166.0+, falls back to %s on 0.165.0', async (model, older) => {
    const current = fakeCodex('codex-cli 0.166.0');
    const old = fakeCodex('codex-cli 0.165.0');
    for (const policy of ['fallback', 'keep'] as const) {
      expect(await codexModelForCliAsync(model, current, policy)).toBe(model);
      expect(await codexModelForCliAsync(model, old, policy)).toBe(older);
      // Once probed, the synchronous form answers the same from the cache.
      expect(codexModelForCli(model, current, policy)).toBe(model);
      expect(codexModelForCli(model, old, policy)).toBe(older);
    }
  });

  it('an unreadable version falls back for session launches and keeps the id for one-shot calls', async () => {
    const unknown = fakeCodex('not a version');
    expect(await codexModelForCliAsync('gpt-6.2-sol', unknown, 'fallback')).toBe('gpt-6-sol');
    expect(await codexModelForCliAsync('gpt-6.2-sol', unknown, 'keep')).toBe('gpt-6.2-sol');
    expect(await codexModelForCliAsync('gpt-6.2-astra', '/nonexistent/codex', 'fallback')).toBe('gpt-6-astra');
  });

  it('the synchronous form never spawns: a cache miss is treated as unknown and warms the cache in the background', async () => {
    const old = fakeCodex('codex-cli 0.165.0');
    expect(codexCliVersionCached(old)).toBeUndefined();
    expect(codexModelForCli('gpt-6.2-sol', old, 'keep')).toBe('gpt-6.2-sol');
    expect(codexModelForCli('gpt-6.2-sol', old, 'fallback')).toBe('gpt-6-sol');
    await refreshCodexCliVersion(old); // joins the background probe the miss started
    expect(codexCliVersionCached(old)).toEqual({ major: 0, minor: 165, patch: 0 });
    expect(codexModelForCli('gpt-6.2-sol', old, 'keep')).toBe('gpt-6-sol');
  });

  it('a wedged codex does not block the event loop and is cached as unreadable', async () => {
    vi.stubEnv('INSTAR_CODEX_VERSION_PROBE_SCALE', '1');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-'));
    made.push(dir);
    const bin = path.join(dir, 'codex');
    fs.writeFileSync(bin, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 50);
    const started = Date.now();
    const model = await codexModelForCliAsync('gpt-6.2-sol', bin, 'keep');
    clearInterval(timer);
    expect(model).toBe('gpt-6.2-sol');
    expect(Date.now() - started).toBeLessThan(4000);
    expect(ticks).toBeGreaterThan(10); // the loop kept running during the probe
    expect(codexCliVersionCached(bin)).toBeNull();
  }, 10_000);

  it('a codex that reads stdin and ignores SIGTERM still settles within the probe deadline', async () => {
    vi.stubEnv('INSTAR_CODEX_VERSION_PROBE_SCALE', '1');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-'));
    made.push(dir);
    const bin = path.join(dir, 'codex');
    fs.writeFileSync(bin, "#!/bin/sh\ntrap '' TERM\ncat > /dev/null\nsleep 30\n", { mode: 0o755 });
    const started = Date.now();
    expect(await codexModelForCliAsync('gpt-6.2-astra', bin, 'fallback')).toBe('gpt-6-astra');
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10_000);

  it('a spawn that throws synchronously settles to unknown, never rejects, and does not poison later probes', async () => {
    const bad = 'codex\u0000bad'; // a NUL byte makes spawn throw ERR_INVALID_ARG_VALUE synchronously
    await expect(refreshCodexCliVersion(bad)).resolves.toBeNull();
    await expect(codexModelForCliAsync('gpt-6.2-sol', bad, 'fallback')).resolves.toBe('gpt-6-sol');
    // A later probe of a good binary is unaffected, and the bad path re-probes after its entry expires.
    const good = fakeCodex('codex-cli 0.169.0');
    await expect(refreshCodexCliVersion(good)).resolves.toEqual({ major: 0, minor: 169, patch: 0 });
  });

  it('an unreadable result expires after 60 s while a readable one lasts 10 minutes', async () => {
    const good = fakeCodex('codex-cli 0.169.0');
    const bad = fakeCodex('garbage');
    await refreshCodexCliVersion(good);
    await refreshCodexCliVersion(bad);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 61_000;
      expect(codexCliVersionCached(bad)).toBeUndefined();
      expect(codexCliVersionCached(good)).toEqual({ major: 0, minor: 169, patch: 0 });
      // The sync form serves the stale answer and refreshes in the background.
      expect(codexCliVersion(bad)).toBeNull();
    } finally { Date.now = realNow; }
  });

  it('never touches an id without a fallback, even on an old CLI', () => {
    const old = fakeCodex('codex-cli 0.150.0');
    for (const id of ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'llama3.2:latest']) {
      expect(codexModelForCli(id, old, 'fallback')).toBe(id);
    }
  });

  it('honors an injected support probe', () => {
    expect(codexModelForCli('gpt-6.2-sol', 'x', 'fallback', () => true)).toBe('gpt-6.2-sol');
    expect(codexModelForCli('gpt-6.2-sol', 'x', 'fallback', () => false)).toBe('gpt-6-sol');
    expect(codexModelForCli('gpt-6.2-sol', 'x', 'keep', () => null)).toBe('gpt-6.2-sol');
  });

  it('keeps the old gpt-6.1 export as the same gate', () => {
    expect(codexSupportsGpt61Sol).toBe(codexSupportsNewerModels);
  });
});

describe('versionProbeTimeoutMs (INSTAR_CODEX_VERSION_PROBE_SCALE)', () => {
  const KEY = 'INSTAR_CODEX_VERSION_PROBE_SCALE';
  const withScale = (value: string | undefined): number => {
    const prev = process.env[KEY];
    try {
      if (value === undefined) delete process.env[KEY]; else process.env[KEY] = value;
      return versionProbeTimeoutMs();
    } finally {
      if (prev === undefined) delete process.env[KEY]; else process.env[KEY] = prev;
    }
  };

  it('is 2 s when the variable is unset (the production case)', () => {
    expect(withScale(undefined)).toBe(2000);
  });

  it('scales by a whole number from 1 to 20, caps above 20, and treats anything invalid as 1', () => {
    expect(withScale('1')).toBe(2000);
    expect(withScale('10')).toBe(20_000);
    expect(withScale('20')).toBe(40_000);
    expect(withScale('21')).toBe(40_000);
    expect(withScale('999')).toBe(40_000);
    for (const bad of ['0', '-3', '2.5', 'abc', '', ' ', '1e3', 'Infinity']) expect(withScale(bad)).toBe(2000);
  });
});
