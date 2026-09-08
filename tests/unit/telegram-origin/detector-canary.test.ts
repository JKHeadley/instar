import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OriginDetectorCanary } from '../../../src/messaging/telegram-origin/OriginDetectorCanary.js';
import { OriginNativeCanaryLane } from '../../../src/messaging/telegram-origin/OriginNativeCanaryLane.js';
import { OriginConfigReader } from '../../../src/messaging/telegram-origin/OriginConfigReader.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { MasterKeyManager, SecretStore } from '../../../src/core/SecretStore.js';
import { compileOriginConfigWorker, compileOriginDetectorCanaryWorker } from '../../helpers/telegramOriginStore.js';
let workerUrl: URL, configWorkerUrl: URL;
beforeAll(async () => { workerUrl = await compileOriginDetectorCanaryWorker(); configWorkerUrl = await compileOriginConfigWorker(); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close(); });
async function worker(code: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'origin-canary-unit-'));
  cleanups.push(async () => { await SafeFsExecutor.safeRm(directory, { recursive: true, force: true, operation: 'origin-canary-test-cleanup' }); });
  const file = path.join(directory, 'worker.mjs'); await writeFile(file, code); return pathToFileURL(file);
}
describe('owned detector known-state canary', () => {
  it('runs at startup and only after the completion-relative floor, then stops recurrence on close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const canary = new OriginDetectorCanary({ workerUrl, configWorkerUrl, intervalMs: 60_000 }); cleanups.push(() => canary.close());
    const run = vi.spyOn(canary, 'run');
    const settle = async () => { const deadline = performance.now() + 5000;
      while (canary.getHealth().state === 'running' && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve));
      expect(canary.getHealth().state).toBe('pass'); };
    canary.start();
    await vi.advanceTimersByTimeAsync(59_999); expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await settle(); expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(59_999); expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); await settle(); expect(run).toHaveBeenCalledTimes(2);
    await canary.close(); await vi.advanceTimersByTimeAsync(120_000); expect(run).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])('never reads or writes OS keychain during actual candidate/vault resolution (forceFile=%s)', async forceFile => {
    const file = await worker(''), stateDir = path.dirname(file.pathname);
    const read = vi.spyOn(MasterKeyManager.prototype as any, 'readOsKeychain').mockImplementation(() => { throw new Error('OS keychain forbidden'); });
    const write = vi.spyOn(MasterKeyManager.prototype as any, 'writeOsKeychain').mockImplementation(() => { throw new Error('OS keychain forbidden'); });
    try {
      const manager = new MasterKeyManager(stateDir, forceFile);
      expect(manager.getCandidateKeys()).toHaveLength(1);
      const vault = new SecretStore({ stateDir, forceFileKey: forceFile }); vault.write({ fixture: 'encrypted' });
      expect(new SecretStore({ stateDir, forceFileKey: forceFile }).read()).toEqual({ fixture: 'encrypted' });
      expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    } finally { read.mockRestore(); write.mockRestore(); }
  });
  it('uses real encrypted fixtures and checks positive and negative source authority without native claims', async () => {
    let now = Date.now();
    const canary = new OriginDetectorCanary({ workerUrl, configWorkerUrl, intervalMs: 60_000, now: () => now }); cleanups.push(() => canary.close());
    await canary.run();
    expect(canary.getHealth()).toMatchObject({ state: 'pass', attempts: 1 });
    expect(canary.getHealth().checks).toHaveLength(6);
    const finished = canary.getHealth().finishedAt;
    now += 60_000;
    expect(canary.getHealth()).toMatchObject({ state: 'stale', finishedAt: finished });
    expect(JSON.stringify(canary.getHealth())).not.toMatch(/canary-only|\/tmp\//);
  });
  it('requires the complete ordered behavioral checks, retrying once without accepting an arbitrary success flag', async () => {
    const bad = await worker("import {parentPort} from 'node:worker_threads';parentPort.postMessage({passed:true,checks:[]});");
    const canary = new OriginDetectorCanary({ workerUrl: bad, configWorkerUrl }); cleanups.push(() => canary.close());
    await canary.run(); expect(canary.getHealth()).toMatchObject({ state: 'fail', attempts: 2, checks: [] });
  });
  it('owns one timed-out worker at a time and closes its bounded retry before returning', async () => {
    const stalled = await worker('setInterval(()=>{},1000);');
    const canary = new OriginDetectorCanary({ workerUrl: stalled, timeoutMs: 50 }); cleanups.push(() => canary.close());
    const first = canary.run(); expect(canary.run()).toBe(first);
    await first; expect(canary.getHealth()).toMatchObject({ state: 'fail', attempts: 2 });
    await canary.close(); expect(canary.getHealth().state).toBe('closed');
  });
  it('reports actual source failure and restoration without exposing the config', async () => {
    const file = await worker(''); const directory = path.dirname(file.pathname), config = path.join(directory, 'config.json');
    const reader = new OriginConfigReader(directory, configWorkerUrl); cleanups.push(async () => reader.close());
    await writeFile(config, JSON.stringify({ private: 'never-return-this' })); await reader.read();
    expect(reader.getHealth().state).toBe('healthy');
    await writeFile(config, '{broken'); await expect(reader.read()).rejects.toThrow();
    expect(reader.getHealth().state).toBe('unavailable');
    await writeFile(config, '{}'); await new Promise(resolve => setTimeout(resolve, 30)); await reader.read();
    expect(reader.getHealth().state).toBe('healthy'); expect(JSON.stringify(reader.getHealth())).not.toContain('never-return-this');
  });
});
describe('native canary diagnostic lane', () => {
  const proof = { state: 'passed' as const, cleanupVerified: true, harness: 'codex-cli' as const,
    scope: 'native-cli-format-with-loopback-provider' as const, providerExecutionVerified: false as const };
  it('requires explicit native proof scope and never calls an incomplete callback a passing model check', async () => {
    const lane = new OriginNativeCanaryLane(60_000, async () => ({ state: 'passed', cleanupVerified: true }));
    await lane.run(); expect(lane.getHealth()).toMatchObject({ state: 'failed', reason: 'native-canary-invalid-proof-scope' }); await lane.close();
  });
  it('runs a scoped native diagnostic at startup and recurrence without granting provider verification', async () => {
    vi.useFakeTimers(); const adapter = vi.fn(async () => proof), lane = new OriginNativeCanaryLane(60_000, adapter);
    lane.start(); await lane.run(); expect(adapter).toHaveBeenCalledOnce();
    expect(lane.getHealth()).toMatchObject({ state: 'passed', harness: 'codex-cli', providerExecutionVerified: false });
    await vi.advanceTimersByTimeAsync(59_999); expect(adapter).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(adapter).toHaveBeenCalledTimes(2);
    await lane.close(); await vi.advanceTimersByTimeAsync(120_000); expect(adapter).toHaveBeenCalledTimes(2);
  });
  it('stays unavailable without a real enrolled adapter', async () => {
    const lane = new OriginNativeCanaryLane(60_000); lane.start(); await lane.run();
    expect(lane.getHealth()).toMatchObject({ state: 'unavailable', reason: 'native-model-canary-not-enrolled' }); await lane.close();
  });
  it('rejects a passing result with unverified cleanup', async () => {
    const adapter = vi.fn(async () => ({ ...proof, cleanupVerified: false })), lane = new OriginNativeCanaryLane(60_000, adapter);
    await lane.run(); expect(lane.getHealth()).toMatchObject({ state: 'failed', reason: 'native-canary-cleanup-unverified' });
    await lane.run(); expect(adapter).toHaveBeenCalledOnce(); await lane.close();
  });
  it('aborts at its deadline and keeps its slot until adapter cleanup settles', async () => {
    vi.useFakeTimers(); let release!: () => void; let signal: AbortSignal | undefined;
    const adapter = vi.fn(async input => { signal = input.signal; await new Promise<void>(resolve => { release = resolve; }); return { state: 'passed' as const, cleanupVerified: true }; });
    const lane = new OriginNativeCanaryLane(60_000, adapter), run = lane.run();
    await vi.advanceTimersByTimeAsync(30_000); expect(signal?.aborted).toBe(true); expect(lane.run()).toBe(run);
    expect(adapter).toHaveBeenCalledOnce(); release(); await run;
    expect(lane.getHealth().state).toBe('failed'); await lane.close();
  });
});
