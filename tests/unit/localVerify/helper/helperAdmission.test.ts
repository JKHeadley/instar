// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: what a helper accepts (docs/specs/local-verify-borrowed-unit-slices.md, C) — both sides of
 * every transport check (route, signature, pinned requester, expiry, single use across restarts),
 * the request/answer protocol, and the settings parsers (dark unless enabled; malformed = disabled).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';
import { routeRefusal, signedRequestRefusal } from '../../../../src/localVerify/helper/admission.js';
import { HelperSeenAttempts } from '../../../../src/localVerify/helper/seenAttempts.js';
import {
  HELPER_LIMITS, parseHelperAnswer, parseHelperRequest, signHelperAnswer, signHelperRequest, verifyHelperAnswer,
  type HelperSliceAnswer, type HelperSliceRequest,
} from '../../../../src/localVerify/helper/helperProtocol.js';
import { parseBorrowedConfig, parseHelperConfig, sandboxWorkerCeiling } from '../../../../src/localVerify/helper/helperConfig.js';
import { id32, machineKeys, pins, sha } from '../../../helpers/borrowedHelperFixture.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'helperAdmission.test.ts' }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvadm-'))); dirs.push(d); return d; };

const NOW = Date.parse('2026-11-18T20:00:00.000Z');
const studio = machineKeys('m_studio');
const req = (over: Partial<HelperSliceRequest> = {}): HelperSliceRequest => ({
  kind: 'slice', attemptId: id32(), runAttemptId: id32(), requesterMachineId: 'm_studio', helperMachineId: 'm_laptop', headSha: sha('a'),
  files: ['tests/unit/a.test.ts'], deadlineAt: NOW + 60_000, budgetMs: 10_000, expiresAt: NOW + 55_000, ...over,
});
const ctx = (seen: { has(id: string): boolean } = { has: () => false }) => ({ selfMachineId: 'm_laptop', pinnedRequesters: ['m_studio'], keyLookup: pins(studio), now: NOW, seen });

describe('route', () => {
  it('refuses the Cloudflare tunnel (cf-connecting-ip) and loopback; serves the LAN / tailnet address', () => {
    expect(routeRefusal({ cfConnectingIp: '203.0.113.9', localAddress: '100.64.0.5' })).toBe('tunnel');
    expect(routeRefusal({ localAddress: '127.0.0.1' })).toBe('tunnel');
    expect(routeRefusal({ localAddress: '::ffff:127.0.0.1' })).toBe('tunnel');
    expect(routeRefusal({ localAddress: '100.64.0.5' })).toBeNull();
    expect(routeRefusal({ localAddress: '192.168.1.20' })).toBeNull();
    expect(routeRefusal({ localAddress: '127.0.0.1' }, { allowLoopback: true })).toBeNull();
    expect(routeRefusal({ cfConnectingIp: 'x', localAddress: '127.0.0.1' }, { allowLoopback: true })).toBe('tunnel');
  });
});

describe('signed requests', () => {
  it('accepts a fresh request signed by a pinned requester', () => {
    expect(signedRequestRefusal(signHelperRequest(studio.signer, req()), ctx())).toBeNull();
  });

  it('refuses unsigned, unpinned, wrong-machine, unknown-key and tampered requests', () => {
    expect(signedRequestRefusal({ ...req() } as never, ctx())).toBe('unsigned');
    const other = machineKeys('m_other');
    expect(signedRequestRefusal(signHelperRequest(other.signer, req({ requesterMachineId: 'm_other' })), ctx())).toBe('requester-not-pinned');
    // Signed by another machine while claiming to be the Studio.
    expect(signedRequestRefusal(signHelperRequest(other.signer, req()), ctx())).toBe('requester-not-pinned');
    const rotated = machineKeys('m_studio');
    expect(signedRequestRefusal(signHelperRequest(rotated.signer, req()), ctx())).toBe('signature-unknown-key');
    const s = signHelperRequest(studio.signer, req());
    expect(signedRequestRefusal({ ...s, files: ['tests/unit/b.test.ts'] }, ctx())).toBe('signature-bad');
  });

  it('audience: a request signed for another helper is refused (wrong-helper)', () => {
    expect(signedRequestRefusal(signHelperRequest(studio.signer, req({ helperMachineId: 'm_pc' })), ctx())).toBe('wrong-helper');
    expect(parseHelperRequest({ ...signHelperRequest(studio.signer, req()), helperMachineId: undefined }, 'slice')).toBeNull();
  });

  it('expiry: refused after expiresAt + 30 s, and when signed to live more than 60 s (+30 s)', () => {
    const ok = signHelperRequest(studio.signer, req({ expiresAt: NOW - 29_000 }));
    expect(signedRequestRefusal(ok, ctx())).toBeNull();
    expect(signedRequestRefusal(signHelperRequest(studio.signer, req({ expiresAt: NOW - 31_000 })), ctx())).toBe('expired');
    expect(signedRequestRefusal(signHelperRequest(studio.signer, req({ expiresAt: NOW + 89_000 })), ctx())).toBeNull();
    expect(signedRequestRefusal(signHelperRequest(studio.signer, req({ expiresAt: NOW + 91_000 })), ctx())).toBe('expired');
  });

  it('replay: a seen attemptId is refused, and the seen set survives a restart for 10 min', () => {
    const dir = tmp();
    let t = NOW;
    const seen = new HelperSeenAttempts(dir, () => t);
    const s = signHelperRequest(studio.signer, req());
    expect(signedRequestRefusal(s, ctx(seen))).toBeNull();
    seen.add(s.attemptId);
    expect(signedRequestRefusal(s, ctx(seen))).toBe('replayed');
    const restarted = new HelperSeenAttempts(dir, () => t);
    expect(restarted.has(s.attemptId)).toBe(true);
    t += HELPER_LIMITS.seenAttemptMs + 1;
    expect(new HelperSeenAttempts(dir, () => t).has(s.attemptId)).toBe(false);
  });
});

describe('protocol', () => {
  it('parses exactly one request kind; prepare carries no files; files are bounded test paths', () => {
    const s = signHelperRequest(studio.signer, req());
    expect(parseHelperRequest(s, 'slice')).not.toBeNull();
    expect(parseHelperRequest(s, 'cancel')).toBeNull();
    expect(parseHelperRequest({ ...s, extra: 1 }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, files: ['../etc/passwd.test.ts'] }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, files: ['/abs/x.test.ts'] }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, files: ['tests/unit/a.ts'] }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, files: [] }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, files: [], prepare: true }, 'slice')).not.toBeNull();
    expect(parseHelperRequest({ ...s, prepare: true }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, files: Array.from({ length: 401 }, (_, i) => `tests/unit/f${i}.test.ts`) }, 'slice')).toBeNull();
  });

  it('a signed answer verifies for the helper that signed it, and not when altered or from another machine', () => {
    const laptop = machineKeys('m_laptop');
    const ans: HelperSliceAnswer = { state: 'done', attemptId: id32(), runAttemptId: id32(), headSha: sha('a'), requestedFiles: ['tests/unit/a.test.ts'],
      perFile: [{ file: 'tests/unit/a.test.ts', tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, ms: 5 }],
      slice: { exitCode: 0, unhandledErrors: 0, collected: true, vitestStartMs: 100 }, ownerCoresMax: 1, handBackMs: null, prepMs: 100, progress: 1, helperVersion: '1' };
    const s = signHelperAnswer(laptop.signer, ans);
    const parsed = parseHelperAnswer(JSON.parse(JSON.stringify(s)))!;
    expect(verifyHelperAnswer(parsed, 'm_laptop', pins(laptop), NOW)).toBeNull();
    expect(verifyHelperAnswer(parsed, 'm_pc', pins(laptop), NOW)).toBe('signature-wrong-machine');
    expect(verifyHelperAnswer({ ...parsed, perFile: [{ ...parsed.perFile[0], failed: 1 }] }, 'm_laptop', pins(laptop), NOW)).toBe('signature-bad');
    expect(verifyHelperAnswer({ ...ans }, 'm_laptop', pins(laptop), NOW)).toBe('unsigned');
    expect(parseHelperAnswer({ ...s, perFile: [{ file: 'x' }] })).toBeNull();
  });
});

describe('settings', () => {
  const hw = { ncpu: 16, totalMemGb: 32 };
  it('absent, not enabled or malformed means disabled', () => {
    expect(parseHelperConfig(undefined, hw)).toBeNull();
    expect(parseHelperConfig({ enabled: false, pinnedRepoUrl: 'https://github.com/a/b', pinnedRequesters: ['m'] }, hw)).toBeNull();
    expect(parseHelperConfig({ enabled: true, pinnedRequesters: ['m'] }, hw)).toBeNull();
    expect(parseHelperConfig({ enabled: true, pinnedRepoUrl: 'https://gitlab.com/a/b', pinnedRequesters: ['m'] }, hw)).toBeNull();
    expect(parseHelperConfig({ enabled: true, pinnedRepoUrl: 'https://github.com/a/b', pinnedRequesters: [] }, hw)).toBeNull();
    expect(parseHelperConfig({ enabled: true, pinnedRepoUrl: 'https://github.com/a/b', pinnedRequesters: ['m'], sandbox: 'test-bypass' }, hw)).toBeNull();
    expect(parseHelperConfig({ enabled: true, pinnedRepoUrl: 'https://github.com/a/b', pinnedRequesters: ['m'], sandbox: { cpus: 99 } }, hw)).toBeNull();
  });

  it('starting values: half the cores, min(8 GB, RAM/4), 30 GB, a quarter of the cores reserved, battery stops', () => {
    const c = parseHelperConfig({ enabled: true, pinnedRepoUrl: 'https://github.com/JKHeadley/instar.git', pinnedRequesters: ['m_studio'] }, hw)!;
    expect(c).toMatchObject({ repo: 'JKHeadley/instar', reserveCores: 4, stopOnBattery: true, sandbox: { cpus: 8, memoryGb: 8, diskGb: 30 } });
    expect(parseHelperConfig({ enabled: true, pinnedRepoUrl: 'https://github.com/a/b', pinnedRequesters: ['m'] }, { ncpu: 8, totalMemGb: 16 })!.sandbox).toEqual({ cpus: 4, memoryGb: 4, diskGb: 30 });
    expect(sandboxWorkerCeiling({ cpus: 8, memoryGb: 4, diskGb: 30 }, 1)).toBe(4);
  });

  it('the run-machine block is off unless mode is shadow with a valid helper', () => {
    expect(parseBorrowedConfig(undefined, 'm_studio').mode).toBe('off');
    expect(parseBorrowedConfig({ mode: 'count', helpers: [{ machineId: 'm_l', url: 'http://1.2.3.4:4042' }] }, 'm_studio').mode).toBe('off');
    expect(parseBorrowedConfig({ mode: 'shadow', helpers: [{ machineId: 'm_studio', url: 'http://1.2.3.4:4042' }] }, 'm_studio').mode).toBe('off');
    expect(parseBorrowedConfig({ mode: 'shadow', helpers: [{ machineId: 'm_l', url: 'http://1.2.3.4:4042/' }] }, 'm_studio')).toEqual({ mode: 'shadow', helpers: [{ machineId: 'm_l', url: 'http://1.2.3.4:4042' }] });
  });
});
