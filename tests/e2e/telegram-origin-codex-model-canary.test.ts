import { access } from 'node:fs/promises';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { resolveCodexNativeCanaryBinary, runCodexNativeModelCanary } from '../../src/messaging/telegram-origin/OriginCodexModelCanary.js';

// No credentials or native transcript fixture. On unsupported hosts the public
// resolver must stay unavailable; a missing installed CLI is an explicit skip.
const installed = process.platform === 'darwin' ? await resolveCodexNativeCanaryBinary('/usr/local/bin/codex') : null;
const unavailable = installed ? '' : ' [unavailable: supported macOS installed native Codex not found; no live proof]';
describe('Actual credential-free Codex native format lifecycle', () => {
  it.skipIf(!installed)(`parses two actual native turns under the kernel sandbox and closes every owned resource${unavailable}`, async () => {
    const result = await runCodexNativeModelCanary({ cliPath: installed!, scratchParent: os.tmpdir(), signal: new AbortController().signal });
    expect(result).toMatchObject({ scope: 'native-cli-format-with-loopback-provider', providerExecutionVerified: false,
      state: 'passed', cleanupVerified: true });
    expect(result.twoTurnChecks.map(check => check.expectedModel)).toEqual(['instar-canary-model-a', 'instar-canary-model-b']);
    expect(result.twoTurnChecks.every(check => check.observedMatch)).toBe(true);
    expect(result.isolationControls).toHaveLength(6); expect(result.isolationControls.every(control => control.passed)).toBe(true);
    expect(new Set(result.twoTurnChecks.map(check => check.turnId)).size).toBe(2);
    expect(result.cliDigest).toMatch(/^[a-f0-9]{64}$/); expect(result.parserDigest).toMatch(/^[a-f0-9]{64}$/);
  }, 40_000);
  it('never resolves an absent provider or invokes an installation fallback', async () => {
    expect(await resolveCodexNativeCanaryBinary('/definitely-absent-codex-canary')).toBeNull();
    await expect(access('/definitely-absent-codex-canary')).rejects.toThrow();
  });
});
