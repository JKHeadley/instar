import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { matchesCodexCanaryObservation, resolveCodexNativeCanaryBinary, runCodexNativeModelCanary } from '../../src/messaging/telegram-origin/OriginCodexModelCanary.js';
import type { RuntimeOriginObservation } from '../../src/messaging/telegram-origin/RuntimeOriginObserver.js';
const temporary: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of temporary.splice(0)) await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'canary-resolver-unit-cleanup' }); });

describe('Codex native-format canary acceptance', () => {
  const expected = { nativeId: 'native-independent', turnId: 'turn-independent', model: 'instar-canary-model-a' };
  const observed: RuntimeOriginObservation = { sessionId: 'canary', sessionIncarnation: 'incarnation', harnessId: 'codex-cli',
    nativeSessionId: expected.nativeId, turnId: expected.turnId, configuredModel: 'different-fallback',
    model: { value: expected.model, status: 'observed', sourceEventRef: '/private/native.jsonl:3', observedAt: '2026-09-01T00:00:00Z' } };
  it('requires the independently expected native identity, turn, model and actual observed status', () => {
    expect(matchesCodexCanaryObservation(observed, expected)).toBe(true);
    expect(matchesCodexCanaryObservation({ ...observed, nativeSessionId: 'different' }, expected)).toBe(false);
    expect(matchesCodexCanaryObservation({ ...observed, turnId: 'previous-turn' }, expected)).toBe(false);
    for (const model of [{ ...observed.model, status: 'configured' as const }, { ...observed.model, value: 'different-fallback' },
      { ...observed.model, sourceEventRef: null }]) expect(matchesCodexCanaryObservation({ ...observed, model }, expected)).toBe(false);
    expect(matchesCodexCanaryObservation(undefined, expected)).toBe(false);
  });
  it('does not launch after cancellation and labels the limited proof scope', async () => {
    const controller = new AbortController(); controller.abort();
    const result = await runCodexNativeModelCanary({ cliPath: '/does-not-exist', scratchParent: '/does-not-exist', signal: controller.signal });
    expect(result).toMatchObject({ state: 'unavailable', scope: 'native-cli-format-with-loopback-provider', providerExecutionVerified: false,
      cleanupVerified: true, twoTurnChecks: [], cliDigest: null });
  });
  it('rejects unbounded budgets before any subprocess or scratch creation', async () => {
    const result = await runCodexNativeModelCanary({ cliPath: '/does-not-exist', scratchParent: '/does-not-exist',
      signal: new AbortController().signal, timeoutMs: 30001 });
    expect(result.state).toBe('unavailable'); expect(result.twoTurnChecks).toEqual([]);
  });
  it.skipIf(process.platform !== 'darwin')('resolves bare codex read-only and refuses to skip a shadowing executable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'canary-resolver-')); temporary.push(root);
    const first = path.join(root, 'first'), second = path.join(root, 'second'); await mkdir(first); await mkdir(second);
    // Header-only files exercise discovery, never masquerade as a live CLI.
    await writeFile(path.join(second, 'codex'), Buffer.from('cffaedfe', 'hex'), { mode: 0o700 });
    vi.stubEnv('PATH', `relative:${second}`);
    expect(await resolveCodexNativeCanaryBinary('codex')).toBe(await import('node:fs/promises').then(fs => fs.realpath(path.join(second, 'codex'))));
    await writeFile(path.join(first, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    vi.stubEnv('PATH', `${first}:${second}`);
    expect(await resolveCodexNativeCanaryBinary('codex')).toBeNull();
    expect(await resolveCodexNativeCanaryBinary('./codex')).toBeNull();
  });
});
