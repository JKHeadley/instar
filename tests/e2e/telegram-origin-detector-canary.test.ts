import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { OriginConfigReader } from '../../src/messaging/telegram-origin/OriginConfigReader.js';
import * as nativeCanary from '../../src/messaging/telegram-origin/OriginCodexModelCanary.js';
import { detectorFixture, detectorWorkers } from '../helpers/originDetectorBoot.js';
let workers: Awaited<ReturnType<typeof detectorWorkers>>;
beforeAll(async () => { workers = await detectorWorkers(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
it('wires the default configured native resolver and isolated adapter into fresh diagnostic health', async () => {
  const fixture = await detectorFixture(workers); cleanup.push(fixture.cleanup);
  (fixture.config as any).sessions = { frameworkBinaryPaths: { 'codex-cli': '/task-fixture/codex' } };
  const resolve = vi.spyOn(nativeCanary, 'resolveCodexNativeCanaryBinary').mockResolvedValue('/task-fixture/native-codex');
  const invoke = vi.spyOn(nativeCanary, 'runCodexNativeModelCanary').mockResolvedValue({ state: 'passed', cleanupVerified: true,
    scope: 'native-cli-format-with-loopback-provider', harness: 'codex-cli', providerExecutionVerified: false,
    cliVersion: '0.153.4', cliDigest: 'a'.repeat(64), parserDigest: 'b'.repeat(64), isolationControls: [], twoTurnChecks: [], reason: 'fixture-proof', sampledAt: Date.now() });
  const boot = await bootTelegramOrigin(fixture.options); cleanup.push(boot.close);
  expect(invoke).not.toHaveBeenCalled();
  expect((boot.runtime.options.readDetectorHealth!() as any).canaries.nativeModels.reason).toBe('native-canary-startup-cooldown');
  await vi.waitFor(() => expect((boot.runtime.options.readDetectorHealth!() as any).canaries.nativeModels).toMatchObject({
    state: 'passed', harness: 'codex-cli', scope: 'native-cli-format-with-loopback-provider', providerExecutionVerified: false, cliVersion: '0.153.4' }), { timeout: 75_000 });
  expect(resolve).toHaveBeenCalledWith('/task-fixture/codex');
  expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ cliPath: '/task-fixture/native-codex', timeoutMs: 30_000, signal: expect.any(AbortSignal) }));
  expect(boot.runtime.observer.getHealth().state).toBe('idle');
}, 90_000);
it('starts real owned canaries in production Boot and recovers actual vault-source health independently of canary success', async () => {
  const fixture = await detectorFixture(workers); cleanup.push(fixture.cleanup);
  const boot = await fixture.boot(); cleanup.push(boot.close);
  const health = () => boot.runtime.options.readDetectorHealth!() as any;
  expect(health().canaries.ownedContracts.state).toBe('pending');
  await vi.waitFor(() => expect(health().canaries.ownedContracts).toMatchObject({ state: 'pass', scope: 'owned-file-backed-secretstore-fixture', osKeychainVerified: false }), { timeout: 75_000 });
  await vi.waitFor(() => expect(health().sources).toMatchObject({ config: { state: 'healthy' }, noticePolicy: { state: 'healthy' } }), { timeout: 8000 });
  expect(health().canaries.nativeModels.state).toBe('unavailable');
  const original = await readFile(fixture.configPath, 'utf8');
  await writeFile(fixture.configPath, '{broken');
  await vi.waitFor(() => expect(health().sources.config.state).toBe('unavailable'), { timeout: 8000 });
  expect(boot.runtime.options.getAlertPolicy('operator-attention-hub')).toBeNull();
  expect(health().canaries.ownedContracts.state).toBe('pass');
  await writeFile(fixture.configPath, original);
  await vi.waitFor(() => expect(health().sources.config.state).toBe('healthy'), { timeout: 8000 });
  await boot.close(); expect(health().sources.config.state).toBe('closed'); expect(health().canaries.ownedContracts.state).toBe('closed');
}, 90_000);
it('closes actual runtime workers, source watchers and owner socket when profile enrollment fails before successful boot', async () => {
  const fixture = await detectorFixture(workers); cleanup.push(fixture.cleanup);
  await writeFile(path.join(fixture.stateDir, 'state/playwright-profiles.json'), '{malformed');
  const native = vi.fn(async () => ({ state: 'passed' as const, cleanupVerified: true }));
  const closeRuntime = vi.spyOn(TelegramOriginRuntime.prototype, 'close');
  const closeReader = vi.spyOn(OriginConfigReader.prototype, 'close');
  await expect(bootTelegramOrigin({ ...fixture.options, attachSessionLifecycle: () => undefined, nativeModelCanary: native })).rejects.toThrow();
  expect(native).not.toHaveBeenCalled(); expect(closeRuntime).toHaveBeenCalledOnce(); expect(closeReader).toHaveBeenCalled();
  const runtime = closeRuntime.mock.contexts[0];
  await expect(runtime.store.getMetrics()).rejects.toThrow(); await expect(runtime.spool.getMetrics()).rejects.toThrow();
  expect(runtime.observer.getHealth().state).toBe('closed');
  await expect(access(path.join(fixture.stateDir, 'origin-notice.sock'))).rejects.toThrow();
});
