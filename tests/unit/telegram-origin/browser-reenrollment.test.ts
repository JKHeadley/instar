import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PlaywrightProfileRegistry } from '../../../src/core/PlaywrightProfileRegistry.js';
import { enrollOriginBrowser, enrollReviewedOriginBrowser, type EnrollmentCanaryDriver } from '../../../src/messaging/telegram-origin/OriginBrowserEnrollment.js';
import { REVIEWED_WEB_K_BUILDS, matchReviewedWebKBuild, nextSupportedBuilds } from '../../../src/messaging/telegram-origin/ReviewedWebKBuilds.js';
import { advanceBrowserRecovery, type BrowserRecoveryAction, type BrowserRecoveryState } from '../../../src/messaging/telegram-origin/OriginBrowserRecovery.js';
import { TelegramBrowserBroker } from '../../../src/messaging/telegram-origin/TelegramBrowserBroker.js';
import { validWebKBuildEnrollment } from '../../../src/messaging/telegram-origin/TelegramWebKDriver.js';
import type { BrowserCanary, TelegramBrowserDriver } from '../../../src/messaging/telegram-origin/BrowserTypes.js';
import { temporaryState } from '../../helpers/telegramOriginStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const b684 = REVIEWED_WEB_K_BUILDS.find(build => build.buildId === 'web-k-2.2-684')!;
const b679 = REVIEWED_WEB_K_BUILDS.find(build => build.buildId === 'web-k-2.2-679')!;
const b676 = REVIEWED_WEB_K_BUILDS.find(build => build.buildId === 'web-k-2.2-676')!;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-browser-reenrollment:cleanup' }); });

async function enrolledAt676() {
  const projectDir = temporaryState(); roots.push(projectDir);
  await mkdir(path.join(projectDir, '.claude'), { recursive: true });
  await writeFile(path.join(projectDir, '.claude/settings.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp'] } } }));
  const registry = new PlaywrightProfileRegistry({ projectDir, stateDir: projectDir, listVaultNames: () => [] });
  registry.createProfile({ id: 'telegram' });
  registry.assignAccount('telegram', { service: 'telegram', identity: 'operator', owner: 'operator', vaultRefs: [] });
  registry.materializeProfileDirectory('telegram');
  await enrollOriginBrowser({ registry, profileId: 'telegram', inspectProcesses: async () => [],
    enrollment: { accountId: '7812716706', accountNumber: 1, executablePath: '/fixture/chrome',
      supportedBuilds: [{ buildId: b676.buildId, criticalAssets: [...b676.criticalAssets], assetDigests: { ...b676.assetDigests } }] } });
  return registry;
}
function fakeDriver(observed: { accountNumber?: number; accountId?: string; criticalAssets: string[]; assetDigests: Record<string, string> }, peerOk = true) {
  const driver: EnrollmentCanaryDriver & { closed: number } = { closed: 0,
    inspectEnrollment: vi.fn(async () => ({ accountNumber: observed.accountNumber ?? 1, accountId: observed.accountId ?? '7812716706',
      criticalAssets: observed.criticalAssets, assetDigests: observed.assetDigests })),
    resolvePeer: vi.fn(async () => { if (!peerOk) throw new Error('browser-peer-mismatch'); return { _: 'inputPeerSelf' }; }),
    close: vi.fn(async () => { driver.closed++; }) };
  return driver;
}

describe('reviewed Web K build list', () => {
  it('every reviewed build is a valid enrollment and the list stays within the two-build registry bound when enrolled', () => {
    for (const build of REVIEWED_WEB_K_BUILDS) expect(validWebKBuildEnrollment(build)).toBe(true);
    expect(matchReviewedWebKBuild({ criticalAssets: [...b684.criticalAssets], assetDigests: b684.assetDigests })?.buildId)
      .toBe('web-k-2.2-684');
    expect(nextSupportedBuilds(b679, [b676]).map(b => b.buildId)).toEqual(['web-k-2.2-679', 'web-k-2.2-676']);
    expect(nextSupportedBuilds(b679, [b679, b676]).map(b => b.buildId)).toEqual(['web-k-2.2-679', 'web-k-2.2-676']);
    expect(nextSupportedBuilds(b679, []).map(b => b.buildId)).toEqual(['web-k-2.2-679']);
    // Never carries the review-only evidence field into the machine registry.
    expect(Object.keys(nextSupportedBuilds(b679, [b676])[0]).sort()).toEqual(['assetDigests', 'buildId', 'criticalAssets']);
  });
  it('matches only the exact reviewed asset names AND digests', () => {
    expect(matchReviewedWebKBuild({ criticalAssets: [...b679.criticalAssets].reverse(), assetDigests: b679.assetDigests })?.buildId).toBe('web-k-2.2-679');
    expect(matchReviewedWebKBuild({ criticalAssets: b679.criticalAssets, assetDigests: { ...b679.assetDigests, 'app-DVSixCDs.js': '0'.repeat(64) } })).toBeUndefined();
    expect(matchReviewedWebKBuild({ criticalAssets: [...b679.criticalAssets, 'index.worker-x.js'], assetDigests: { ...b679.assetDigests, 'index.worker-x.js': '1'.repeat(64) } })).toBeUndefined();
    // A previously enrolled build that is no longer reviewed is not carried forward.
    expect(nextSupportedBuilds(b679, [{ buildId: 'retired', criticalAssets: ['a.js', 'b.js', 'c.js'], assetDigests: { 'a.js': 'a'.repeat(64), 'b.js': 'b'.repeat(64), 'c.js': 'c'.repeat(64) } }]).map(b => b.buildId)).toEqual(['web-k-2.2-679']);
  });
});

describe('reviewed browser re-enrollment entrypoint', () => {
  it('runs the read-only canary first, then enrolls the reviewed build and keeps 676 as the second build', async () => {
    const registry = await enrolledAt676();
    const before = registry.requireTelegramBrokerProfile('telegram').telegramBroker!.exclusiveEnrollment!.proofDigest;
    const driver = fakeDriver(b679);
    const result = await enrollReviewedOriginBrowser({ registry, profileId: 'telegram', createDriver: () => driver, inspectProcesses: async () => [] });
    expect(result.build.buildId).toBe('web-k-2.2-679');
    expect(driver.resolvePeer).toHaveBeenCalledWith({ kind: 'user', id: '7812716706' });
    expect(driver.closed).toBe(1);
    const live = registry.requireTelegramBrokerProfile('telegram').telegramBroker!;
    expect(live.supportedBuilds.map(b => b.buildId)).toEqual(['web-k-2.2-679', 'web-k-2.2-676']);
    expect(live.exclusiveEnrollment!.proofDigest).not.toBe(before);
    expect(result.canary).toMatchObject({ accountNumber: 1, accountMatchesExpectedOperator: true, selfPeerResolved: true });
  });
  it.each([
    ['unreviewed build', fakeDriver({ criticalAssets: ['apiManagerProxy-X.js', 'app-Y.js', 'index-Z.js'], assetDigests: { 'apiManagerProxy-X.js': 'a'.repeat(64), 'app-Y.js': 'b'.repeat(64), 'index-Z.js': 'c'.repeat(64) } }), 'unreviewed-build'],
    ['wrong account', fakeDriver({ ...b679, accountId: '999' }), 'canary-account-mismatch'],
    ['peer resolution failure', fakeDriver(b679, false), 'canary-peer-resolution-failed'],
  ])('refuses on %s and leaves the existing enrollment untouched', async (_label, driver, reason) => {
    const registry = await enrolledAt676();
    const before = JSON.stringify(registry.requireTelegramBrokerProfile('telegram').telegramBroker);
    await expect(enrollReviewedOriginBrowser({ registry, profileId: 'telegram', createDriver: () => driver, inspectProcesses: async () => [] }))
      .rejects.toMatchObject({ reason });
    expect(JSON.stringify(registry.requireTelegramBrokerProfile('telegram').telegramBroker)).toBe(before);
    expect(driver.closed).toBe(1);
  });
  it('refuses a profile that was never enrolled', async () => {
    const registry = await enrolledAt676();
    registry.createProfile({ id: 'fresh' });
    await expect(enrollReviewedOriginBrowser({ registry, profileId: 'fresh', createDriver: () => fakeDriver(b679), inspectProcesses: async () => [] }))
      .rejects.toMatchObject({ reason: 'profile-not-previously-enrolled' });
  });
});

describe('one attention item per failed build', () => {
  const run = (actions: Array<[BrowserRecoveryAction, number]>) => {
    let state: BrowserRecoveryState | null = null; const ids: Array<string | null> = [];
    for (const [action, now] of actions) { state = advanceBrowserRecovery(state, action, now).state; ids.push(state.attentionId); }
    return { state: state!, ids };
  };
  it('raises nothing before the bounded recheck, then one item per distinct build, never twice for the same build', () => {
    const { state, ids } = run([
      [{ kind: 'begin', fence: 'f' }, 0],
      [{ kind: 'failure', fence: 'f', buildId: 'unrecognized:aaa', final: false }, 1],
      [{ kind: 'failure', fence: 'f', buildId: 'unrecognized:aaa', final: true }, 2],
      [{ kind: 'attention-accepted', fence: 'f' }, 3],
      [{ kind: 'failure', fence: 'f', buildId: 'unrecognized:aaa', final: true }, 4],
      [{ kind: 'failure', fence: 'f', buildId: 'unrecognized:bbb', final: true }, 5],
    ]);
    expect(ids[1]).toBeNull();
    expect(ids[2]).toMatch(/^browser-canary:1:[0-9a-f]{16}$/);
    expect(ids[4]).toBe(ids[2]);
    expect(state.attentionAccepted).toBe(false);
    expect(ids[5]).not.toBe(ids[2]);
    expect(state.failedBuilds).toEqual(['unrecognized:aaa', 'unrecognized:bbb']);
  });
  it('a success clears the per-build memory so a later episode signals again', () => {
    const { ids } = run([
      [{ kind: 'begin', fence: 'f' }, 0],
      [{ kind: 'failure', fence: 'f', buildId: 'x', final: true }, 1],
      [{ kind: 'success', fence: 'f' }, 2],
      [{ kind: 'failure', fence: 'f', buildId: 'x', final: true }, 10],
    ]);
    expect(ids[1]).toBeTruthy(); expect(ids[2]).toBeNull(); expect(ids[3]).toBeTruthy(); expect(ids[3]).not.toBe(ids[1]);
  });
});

describe('broker reads use the bounded recovery', () => {
  function broker(supported: boolean) {
    let state: BrowserRecoveryState | null = null;
    const actions: BrowserRecoveryAction[] = [];
    const canary: BrowserCanary = { transport: 'web-k', buildId: supported ? 'web-k-2.2-679' : 'unrecognized:new', accountId: '7812716706', supported };
    const drivers: TelegramBrowserDriver[] = [];
    const factory = vi.fn(async () => {
      const d: TelegramBrowserDriver = { canary: async () => canary, readSnapshot: async () => ({ text: 'page', accountId: '7812716706' }),
        resolvePeer: async () => ({ _: 'inputPeerChannel', channel_id: '123', access_hash: '456' }), invoke: vi.fn(), close: vi.fn(async () => undefined) };
      drivers.push(d); return d;
    });
    const held = vi.fn();
    const b = new TelegramBrowserBroker({ driverFactory: factory, authorizePreparedChild: async () => true, resolveAgentPublicKey: () => null,
      isProfileExclusivelyOwned: () => true, clockSkewMs: () => 0, onHeld: held,
      recovery: async action => { actions.push(action); const r = advanceBrowserRecovery(state, action, Date.now()); state = r.state; return r; } });
    return { b, actions, factory, drivers, held, state: () => state };
  }
  it('an unsupported build on peer resolution records failedBuilds and raises its one attention item', async () => {
    const h = broker(false);
    await expect(h.b.resolvePeer({ kind: 'channel', id: '123' })).rejects.toThrow('browser-peer-canary-unavailable');
    expect(h.actions.map(a => a.kind === 'failure' ? `failure:${a.final}` : a.kind)).toEqual(['begin', 'failure:false', 'failure:true']);
    expect(h.factory).toHaveBeenCalledTimes(2);
    expect(h.drivers.every(d => (d.close as ReturnType<typeof vi.fn>).mock.calls.length >= 1)).toBe(true);
    expect(h.state()!.failedBuilds).toEqual(['unrecognized:new']);
    expect(h.state()!.attentionId).toMatch(/^browser-canary:/);
    expect(h.b.readStatus().held).toBe('unsupported-browser-build');
    expect(h.held).toHaveBeenCalledWith('unsupported-browser-build', 'unrecognized:new');
    // The 15-minute floor then holds without starting another process or raising another item.
    await expect(h.b.resolvePeer({ kind: 'channel', id: '123' })).rejects.toThrow('browser-recovery-cooldown');
    expect(h.factory).toHaveBeenCalledTimes(2);
  });
  it('a supported build reads and records success, which lifts the floor', async () => {
    const h = broker(true);
    await expect(h.b.readSnapshot()).resolves.toMatchObject({ text: 'page' });
    expect(h.actions.map(a => a.kind)).toEqual(['begin', 'success']);
    expect(h.state()!.nextAllowedAt).toBe(0);
  });
});
