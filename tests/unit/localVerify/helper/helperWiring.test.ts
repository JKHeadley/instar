// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Wiring integrity for the borrowed-machine helper (docs/specs/local-verify-borrowed-unit-slices.md,
 * Tests "E2E lifecycle"): production setup can NEVER select the test-only `test-bypass` seam, and
 * the production runtime wires a real signer, GitHub reader, sandbox driver and governor (not no-ops),
 * only when the role is enabled.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';
import { MachineIdentityManager } from '../../../../src/core/MachineIdentity.js';
import { buildHelperRuntime, selectHostFreeBytes, selectOwnerLoadReader, selectSandboxDriver } from '../../../../src/localVerify/helper/helperWiring.js';
import { TestBypassDriver } from '../../../../src/localVerify/helper/testBypassDriver.js';
import { LimaDriver } from '../../../../src/localVerify/helper/limaDriver.js';
import { WslDriver } from '../../../../src/localVerify/helper/wslDriver.js';
import { MacOwnerLoadReader, WindowsOwnerSignalReader } from '../../../../src/localVerify/helper/governor.js';
import { BareCloneTreeSource, GitHubCompareChecker } from '../../../../src/localVerify/helper/hostTree.js';
import { parseHelperConfig } from '../../../../src/localVerify/helper/helperConfig.js';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'helperWiring.test.ts' }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvwire-'))); dirs.push(d); return d; };
const live = (v: unknown) => ({ get: <T>(k: string, fb: T): T => (k === 'monitoring.localVerify.helper' ? v as T : fb) });
const ENABLED = { enabled: true, pinnedRepoUrl: 'https://github.com/JKHeadley/instar', pinnedRequesters: ['m_studio'] };

describe('production can never select the test-bypass seam', () => {
  it('a string sandbox setting (the seam name) is malformed: the role stays disabled', () => {
    expect(parseHelperConfig({ ...ENABLED, sandbox: 'test-bypass' }, { ncpu: 16, totalMemGb: 32 })).toBeNull();
  });

  it('selectSandboxDriver returns only Lima or WSL, never test-bypass, on every platform', () => {
    const platforms: NodeJS.Platform[] = ['darwin', 'linux', 'win32', 'freebsd'];
    for (const p of platforms) for (const wsl of [false, true]) {
      const d = selectSandboxDriver({ platform: p, wsl, stateDir: '/x/.instar' });
      expect(d === null || d instanceof LimaDriver || d instanceof WslDriver).toBe(true);
      expect(d?.kind).not.toBe('test-bypass');
    }
    expect(selectSandboxDriver({ platform: 'darwin', wsl: false, stateDir: '/x/.instar' })).toBeInstanceOf(LimaDriver);
    expect(selectSandboxDriver({ platform: 'linux', wsl: true, stateDir: '/x/.instar' })).toBeInstanceOf(WslDriver);
    expect(selectSandboxDriver({ platform: 'linux', wsl: false, stateDir: '/x/.instar' })).toBeNull();
  });

  it('server.ts and the production wiring never name the seam or the loopback allowance', () => {
    const server = fs.readFileSync(path.join(ROOT, 'src', 'commands', 'server.ts'), 'utf-8');
    expect(server).not.toContain('test-bypass');
    expect(server).not.toContain('testBypassDriver');
    expect(server).not.toContain('allowLoopback');
    expect(server).not.toContain('treeSeams');
    expect(server).toContain('await wiring.wireBorrowedShadow(svc, {');
    expect(server).toMatch(/buildHelperRuntime\(\{ liveConfig, stateDir: config\.stateDir \}\)/);
    const wiring = fs.readFileSync(path.join(ROOT, 'src', 'localVerify', 'helper', 'helperWiring.ts'), 'utf-8');
    expect(wiring).not.toContain('allowLoopback');
  });

  it('the test-bypass driver refuses to exist outside a test runner, and buildHelperRuntime refuses it without one', () => {
    const saved = process.env.VITEST;
    try {
      delete process.env.VITEST;
      expect(() => new TestBypassDriver({ runSlice: async () => ({ exitCode: 0, reportText: null }) })).toThrow('test-only');
      expect(() => buildHelperRuntime({ liveConfig: live(ENABLED), stateDir: '/x', sandbox: 'test-bypass' })).toThrow('test-only');
    } finally { process.env.VITEST = saved; }
    expect(() => buildHelperRuntime({ liveConfig: live(ENABLED), stateDir: '/x', sandbox: 'test-bypass' })).toThrow('test-only');
  });
});

describe('production runtime wiring', () => {
  it('is dark: get() is null while the setting is absent, malformed or disabled', () => {
    for (const v of [null, {}, { ...ENABLED, enabled: false }, { ...ENABLED, pinnedRequesters: 'm' }]) {
      expect(buildHelperRuntime({ liveConfig: live(v), stateDir: tmp() }).get()).toBeNull();
    }
  });

  it('when enabled, wires a real signer, the GitHub compare reader, the platform sandbox driver, the governor reader and the bare-clone tree source', async () => {
    const stateDir = tmp();
    await new MachineIdentityManager(stateDir).generateIdentity({ name: 'helper wiring' });
    const rt = buildHelperRuntime({ liveConfig: live(ENABLED), stateDir });
    const svc = rt.get();
    try {
      expect(svc).not.toBeNull();
      const d = (svc as unknown as { d: Record<string, unknown> }).d;
      expect(d.github).toBeInstanceOf(GitHubCompareChecker);
      expect(d.trees).toBeInstanceOf(BareCloneTreeSource);
      expect((d.signer as { machineId(): string } | null)?.machineId()).toMatch(/^m_/);
      expect(typeof (d.keyLookup as () => unknown)()).toBe('function');
      if (process.platform === 'darwin') {
        expect(d.driver).toBeInstanceOf(LimaDriver);
        expect(d.ownerLoad).toBeInstanceOf(MacOwnerLoadReader);
      }
      expect(d.allowLoopback).toBeUndefined();
      expect(rt.get()).toBe(svc); // one service while enabled
    } finally { rt.shutdown(); }
    expect(selectOwnerLoadReader('linux', true, null)).toBeInstanceOf(WindowsOwnerSignalReader);
    expect(selectOwnerLoadReader('darwin', false, null)).toBeInstanceOf(MacOwnerLoadReader);
  });
});

describe('Windows host-disk margin source', () => {
  it('inside Echo\'s WSL distro the margin reads the helper drive from the owner signal, never statfs of Echo\'s own disk; a signal without it refuses', async () => {
    const dir = tmp();
    const sig = path.join(dir, 'helper-owner-signal.json');
    const write = (o: Record<string, unknown>) => fs.writeFileSync(sig, JSON.stringify({ v: 1, writer: 'instar-owner-signal', writtenAtMs: Date.now(), ncpu: 8, cpuPercent: 5, availableMemMb: 9000, totalMemMb: 16000, onBattery: false, ...o }), { mode: 0o644 });
    write({ helperDriveFreeBytes: 42 * 1024 ** 3 });
    fs.chmodSync(sig, 0o644);
    expect(await selectHostFreeBytes('linux', true, sig)()).toBe(42 * 1024 ** 3);
    write({});
    expect(await selectHostFreeBytes('linux', true, sig)()).toBeNull();
    expect(await selectHostFreeBytes('linux', true, path.join(dir, 'missing.json'))()).toBeNull();
    expect(typeof await selectHostFreeBytes('darwin', false, sig)()).toBe('number');
  });
});
