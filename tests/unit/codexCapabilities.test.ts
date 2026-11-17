/**
 * codexCapabilities — probe that `--dangerously-bypass-hook-trust` is supported.
 *
 * Uses tiny fake `codex` shell scripts so the probe runs against a real binary
 * whose `--help` output we control (with/without the flag), plus the fail-closed
 * and memoization paths.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexSupportsHookTrustBypass, codexSupportsGpt61Sol, codexSupportsNewerModels, codexModelForCli, codexCliVersion, CODEX_OLDER_CLI_FALLBACKS, __resetCodexCapabilityCache } from '../../src/core/codexCapabilities.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const made: string[] = [];

function fakeCodex(helpText: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-'));
  made.push(dir);
  const bin = path.join(dir, 'codex');
  // Emit helpText for any args; exit 0.
  fs.writeFileSync(bin, `#!/bin/bash\ncat <<'HELP'\n${helpText}\nHELP\n`, { mode: 0o755 });
  return bin;
}

beforeEach(() => __resetCodexCapabilityCache());
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
  ])('%s: kept on 0.166.0+, falls back to %s on 0.165.0', (model, older) => {
    const current = fakeCodex('codex-cli 0.166.0');
    const old = fakeCodex('codex-cli 0.165.0');
    for (const policy of ['fallback', 'keep'] as const) {
      expect(codexModelForCli(model, current, policy)).toBe(model);
      expect(codexModelForCli(model, old, policy)).toBe(older);
    }
  });

  it('an unreadable version falls back for session launches and keeps the id for one-shot calls', () => {
    const unknown = fakeCodex('not a version');
    expect(codexModelForCli('gpt-6.2-sol', unknown, 'fallback')).toBe('gpt-6-sol');
    expect(codexModelForCli('gpt-6.2-sol', unknown, 'keep')).toBe('gpt-6.2-sol');
    expect(codexModelForCli('gpt-6.2-astra', '/nonexistent/codex', 'fallback')).toBe('gpt-6-astra');
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
