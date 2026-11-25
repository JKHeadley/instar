// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Wiring integrity for the borrowed-machine helper (docs/specs/local-verify-borrowed-unit-slices.md,
 * Tests "E2E lifecycle"): production setup can NEVER select the test-only `test-bypass` seam, and
 * the production runtime wires a real signer, GitHub reader, sandbox driver and governor (not no-ops),
 * only when the role is enabled.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';
import { MachineIdentityManager } from '../../../../src/core/MachineIdentity.js';
import { HELPER_HERE_PATH, buildHelperRuntime, credentialDigestsOf, makeHereSender, selectHostFreeBytes, selectOwnerLoadReader, selectSandboxDriver } from '../../../../src/localVerify/helper/helperWiring.js';
import { computeHelperRunnerVersion } from '../../../../src/localVerify/helper/helperRunnerVersion.js';
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
const ENABLED = { enabled: true, pinnedRepoUrl: 'https://github.com/JKHeadley/instar', pinnedRequester: { machineId: 'm_studio', url: 'http://100.64.0.9:4042' } };

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
    // The run machine's side (the observer of main verifies AND the practice record / loopback proxy) is wired by one call,
    // with no test seam: production loads this machine's own signer and pinned keys and uses the real fetch.
    expect(server).toContain('await wiring.wireBorrowedRunMachine(svc, {');
    const call = server.slice(server.indexOf('await wiring.wireBorrowedRunMachine(svc, {'), server.indexOf('const diagnosisTransport'));
    expect(call.length).toBeGreaterThan(100);
    for (const seam of ['signer:', 'keyLookup:', 'fetchImpl', 'randomInt', 'now:']) expect(call).not.toContain(seam);
    expect(call).toContain("featureEvidence.record('local-verify-borrowed-unit-slices'");
    expect(call).toContain('hooks: lvHooks');
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
    for (const v of [null, {}, { ...ENABLED, enabled: false }, { ...ENABLED, pinnedRequester: 'm_studio' }, { ...ENABLED, pinnedRequesters: ['m_studio'] }]) {
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
      // The one reader answers both acceptance questions: merged base, own open head.
      expect(typeof (d.github as GitHubCompareChecker).isOnMain).toBe('function');
      expect(typeof (d.github as GitHubCompareChecker).ownOpenHead).toBe('function');
      expect(d.trees).toBeInstanceOf(BareCloneTreeSource);
      expect((d.signer as { machineId(): string } | null)?.machineId()).toMatch(/^m_/);
      expect(typeof (d.keyLookup as () => unknown)()).toBe('function');
      if (process.platform === 'darwin') {
        expect(d.driver).toBeInstanceOf(LimaDriver);
        expect(d.ownerLoad).toBeInstanceOf(MacOwnerLoadReader);
      }
      expect(d.allowLoopback).toBeUndefined();
      // The runner version is the real hash of the runner and sandbox-driver source, not Instar's release number.
      expect(d.runnerVersion).toBe(computeHelperRunnerVersion());
      expect(d.runnerVersion).toMatch(/^hr1:[0-9a-f]{32}$/);
      expect(d.runnerVersion).not.toBe(d.helperVersion);
      // The sandbox property test gets the token's digest only, and the "I am here" sender is a real one.
      expect((d.credentialDigests as () => string[])().every((x) => /^[0-9a-f]{64}$/.test(x))).toBe(true);
      expect(typeof d.announce).toBe('function');
      expect(rt.get()).toBe(svc); // one service while enabled
    } finally { rt.shutdown(); }
    expect(selectOwnerLoadReader('linux', true, null)).toBeInstanceOf(WindowsOwnerSignalReader);
    expect(selectOwnerLoadReader('darwin', false, null)).toBeInstanceOf(MacOwnerLoadReader);
  });
});

describe('the "I am here" sender and the token digest', () => {
  const target = { machineId: 'm_studio', url: 'http://100.64.0.9:4042' };
  const here = { kind: 'here', helperMachineId: 'm_laptop', runMachineId: 'm_studio', why: 'start', at: 1, expiresAt: 2, runnerVersion: 'hr1:x' } as const;

  it('posts the signed body to the pinned run machine\'s helper-here route with the pool\'s token; 2xx is accepted, anything else is not', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchOk = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await makeHereSender(() => 'pool-token', 'echo', fetchOk)(target, here)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://100.64.0.9:4042${HELPER_HERE_PATH}`);
    expect(HELPER_HERE_PATH).toBe('/local-verify/helper-here');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer pool-token', 'X-Instar-AgentId': 'echo' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual(here);
    for (const status of [404, 401, 500]) {
      const f = (async () => new Response('{}', { status })) as unknown as typeof fetch;
      expect(await makeHereSender(() => 'pool-token', 'echo', f)(target, here), String(status)).toBe(false);
    }
    const thrower = (async () => { throw new Error('unreachable'); }) as unknown as typeof fetch;
    expect(await makeHereSender(() => 'pool-token', 'echo', thrower)(target, here)).toBe(false);
  });

  it('without a token nothing is sent', async () => {
    let called = 0;
    const f = (async () => { called++; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await makeHereSender(() => null, 'echo', f)(target, here)).toBe(false);
    expect(called).toBe(0);
  });

  it('the sandbox property test is given the sha256 of the token and nothing of the token', () => {
    const token = 'ghp_' + 'q7'.repeat(18);
    const d = credentialDigestsOf(() => token)();
    expect(d).toEqual([crypto.createHash('sha256').update(token).digest('hex')]);
    expect(d[0]).not.toContain(token.slice(4, 12));
    expect(credentialDigestsOf(() => null)()).toEqual([]);
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
