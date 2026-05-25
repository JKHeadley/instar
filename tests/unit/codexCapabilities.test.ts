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
import { codexSupportsHookTrustBypass, __resetCodexCapabilityCache } from '../../src/core/codexCapabilities.js';
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
