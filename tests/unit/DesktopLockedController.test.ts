import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopLockedController, RELOCK_WATCH_MS, type DesktopLockedSettings, type DesktopRelockMarker } from '../../src/core/DesktopLockedController.js';
import { PROVEN_MACOS_VERSIONS } from '../../src/core/DesktopProvenVersions.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REQ = '11111111-2222-3333-4444-555555555555';
const PROVEN = [{ osMajor: 26, p12: 'evidence', p15: 'evidence', refuse: ['click'] }];

/** The helper's state-op contract, kept in memory. The real verb is exercised
 * against the built helper in desktop-helper-state-op.test.ts. */
function fakeHost(root: string) {
  const store = { markers: {} as Record<string, DesktopRelockMarker>, disabled: false, dirty: false };
  const killed: Array<{ pid: number; alive: boolean }> = [];
  const aliveAfterKill = new Set<number>();
  const guards: string[] = [];
  const modes: unknown[] = [];
  const persist = () => fs.writeFileSync(path.join(root, 'locked-state.json'), '{}');
  return {
    store, killed, aliveAfterKill, guards, modes, persist,
    setLockedMode: (mode: unknown) => { modes.push(mode); },
    startRelockGuard: async (key: string) => {
      guards.push(key);
      fs.writeFileSync(path.join(root, `hb-${key}`), '');
    },
    lockedOp: async (op: Record<string, any>) => {
      persist();
      const key = op.key as string;
      switch (op.op) {
        case 'read': return { state: { markers: store.markers, disabled: store.disabled, dirty: store.dirty ? {} : undefined }, attempts: { count: 0 } };
        case 'clear-dirty': return { ok: true };
        case 'marker-create':
          if (store.markers[key]) return { marker: store.markers[key], created: false };
          store.markers[key] = { ...op.marker, state: 'owed' };
          return { marker: store.markers[key], created: true };
        case 'relock-now': if (store.markers[key]) store.markers[key].relockNow = true; return { found: true };
        case 'leave-unlocked':
          if (store.markers[key]?.state !== 'owed') return { ok: false };
          store.markers[key].state = 'left-unlocked';
          return { ok: true };
        case 'close': store.markers[key].state = op.to; store.markers[key].producerGone = op.producerGone; return { ok: true };
        case 'set-producer-gone': store.markers[key].producerGone = true; return { ok: true };
        case 'mark-reported': store.markers[key].reported = true; return { ok: true };
        case 'set-guard': store.markers[key].guardReplacements = op.replacements; return { found: true };
        case 'set-disabled': store.disabled = op.disabled; return { ok: true };
        case 'refund': return { ok: true };
        case 'kill-recorded': { const alive = aliveAfterKill.has(op.pid); killed.push({ pid: op.pid, alive }); return { gone: !alive }; }
        default: throw new Error(`unexpected op ${op.op}`);
      }
    },
  };
}

describe('DesktopLockedController', () => {
  let root: string;
  let settings: DesktopLockedSettings;
  let security: Array<{ key: string }>;
  let now: number;
  let host: ReturnType<typeof fakeHost>;
  let raised = true;
  const build = (proven = PROVEN) => new DesktopLockedController({
    host, agentId: 'echo', root, settings: () => settings, saveSettings: next => { settings = next; },
    readPolicy: async () => 'on', tunnelFirstTierActive: () => true,
    raiseSecurity: item => { security.push(item); return raised; }, now: () => now, provenVersions: proven,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-locked-'));
    settings = { enabled: true, browserBox: false, chime: true };
    raised = true;
    security = [];
    now = Date.now();
    host = fakeHost(root);
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'test cleanup' }); });

  it('ships with no proven macOS, so the enable refuses everywhere', () => {
    expect(PROVEN_MACOS_VERSIONS).toEqual([]);
    const controller = new DesktopLockedController({ ...{ host, agentId: 'echo', root,
      settings: () => settings, saveSettings: () => {}, readPolicy: async () => 'on' as const,
      tunnelFirstTierActive: () => true, raiseSecurity: () => {} } });
    for (const major of [13, 14, 15, 26, 27, undefined]) {
      expect(controller.enableRefusal(major)).toBe('unsupported-macos');
      expect(controller.active(major)).toBe(false);
    }
  });

  it('refuses a table row that has no recorded proof', () => {
    const controller = build([{ osMajor: 26, p12: '', p15: 'x', refuse: [] }]);
    expect(controller.enableRefusal(26)).toBe('unsupported-macos');
  });

  it('turns helper mode on only for an enabled, proven macOS', () => {
    const controller = build();
    controller.applyMode(26);
    expect(host.modes.at(-1)).toEqual({ root, refuse: ['click'], chime: true });
    controller.applyMode(27);
    expect(host.modes.at(-1)).toBeNull();
    settings.enabled = false;
    controller.applyMode(26);
    expect(host.modes.at(-1)).toBeNull();
  });

  it('touches nothing with no store on the Mac', async () => {
    const lockedOp = vi.spyOn(host, 'lockedOp');
    await expect(build().admissionRefusal()).resolves.toBeNull();
    expect(lockedOp).not.toHaveBeenCalled();
  });

  it('admits only once a marker, a guard and its heartbeat all exist', async () => {
    const controller = build();
    controller.noteGrant(REQ);
    await expect(controller.prepareSecret(REQ, now + 60_000)).resolves.toEqual({ key: `${REQ}.0` });
    expect(host.guards).toEqual([`${REQ}.0`]);
    expect(fs.existsSync(path.join(root, `lease-${REQ}.0`))).toBe(true);
  });

  it('refuses typing when no guard heartbeat appears', async () => {
    host.startRelockGuard = async () => {};
    const stepped = new DesktopLockedController({ host, agentId: 'echo', root, settings: () => settings,
      saveSettings: () => {}, readPolicy: async () => 'on', tunnelFirstTierActive: () => true,
      raiseSecurity: () => {}, now: (() => { let t = 0; return () => (t += 5_000); })(), provenVersions: PROVEN });
    stepped.noteGrant(REQ);
    await expect(stepped.prepareSecret(REQ, 60_000)).resolves.toEqual({ refused: 'guard-not-alive' });
  });

  it('starts a new generation after a terminal marker, and refuses after a failed relock', async () => {
    const controller = build();
    controller.noteGrant(REQ);
    await controller.prepareSecret(REQ, now + 60_000);
    host.store.markers[`${REQ}.0`].state = 'relocked';
    await expect(controller.prepareSecret(REQ, now + 60_000)).resolves.toEqual({ key: `${REQ}.1` });
    host.store.markers[`${REQ}.1`].state = 'relock-failed';
    await expect(controller.prepareSecret(REQ, now + 60_000)).resolves.toEqual({ refused: 'relock-failed' });
  });

  it('blocks a new request while a duty runs, but never the same request', async () => {
    const controller = build();
    controller.noteGrant(REQ);
    await controller.prepareSecret(REQ, now + 60_000);
    await expect(controller.admissionRefusal()).resolves.toBe('relock-pending');
    await expect(controller.admissionRefusal(REQ)).resolves.toBeNull();
    for (const state of ['executing', 'watching']) {
      host.store.markers[`${REQ}.0`].state = state;
      host.store.markers[`${REQ}.0`].watchStart = now;
      await expect(controller.admissionRefusal()).resolves.toBe('relock-pending');
    }
  });

  it('holds admission for a watch started after the grant deadline, with a healthy guard', async () => {
    const controller = build();
    controller.noteGrant(REQ);
    await controller.prepareSecret(REQ, now - 1_000);
    host.store.markers[`${REQ}.0`] = { ...host.store.markers[`${REQ}.0`], state: 'watching', watchStart: now };
    await expect(controller.admissionRefusal()).resolves.toBe('relock-pending');
  });

  it('reopens only after both the guard and the typist are confirmed gone', async () => {
    const controller = build();
    controller.noteGrant(REQ);
    await controller.prepareSecret(REQ, now - 1_000);
    const marker = host.store.markers[`${REQ}.0`];
    Object.assign(marker, { guardPid: 10, guardStart: 'g', typistPid: 20, typistStart: 't' });
    SafeFsExecutor.safeRmSync(path.join(root, `hb-${REQ}.0`), { force: true, operation: 'test cleanup' });
    host.aliveAfterKill.add(20);
    await expect(controller.admissionRefusal()).resolves.toBe('relock-pending-unconfirmed');
    expect(marker.state).toBe('owed');
    host.aliveAfterKill.delete(20);
    await expect(controller.admissionRefusal()).resolves.toBeNull();
    expect(marker.state).toBe('relock-failed');
    expect(marker.producerGone).toBe(true);
  });

  it('keeps admission shut after a failed relock while the typist may be alive', async () => {
    const controller = build();
    host.persist();
    host.store.markers[`${REQ}.0`] = { state: 'relock-failed', producerGone: false, typistPid: 20, typistStart: 't', requestId: REQ };
    host.aliveAfterKill.add(20);
    await expect(controller.admissionRefusal()).resolves.toBe('relock-failed-producer-alive');
    host.aliveAfterKill.delete(20);
    await expect(controller.admissionRefusal()).resolves.toBeNull();
  });

  it('uses the watch end, not the grant deadline, for a watching marker', () => {
    expect(RELOCK_WATCH_MS).toBe(120_000);
  });

  it('asks for a relock at Stop and renews through a transport drop', async () => {
    const controller = build();
    controller.noteGrant(REQ);
    await controller.prepareSecret(REQ, now + 60_000);
    controller.noteGrant(REQ);
    await controller.endRequest(REQ, 'transport-lost');
    expect(host.store.markers[`${REQ}.0`].relockNow).toBeUndefined();
    await controller.endRequest(REQ, 'stop');
    expect(host.store.markers[`${REQ}.0`].relockNow).toBe(true);
    controller.stop();
  });

  it('acknowledges Leave unlocked only if it beat the guard', async () => {
    const controller = build();
    controller.noteGrant(REQ);
    await controller.prepareSecret(REQ, now + 60_000);
    host.store.markers[`${REQ}.0`].state = 'executing';
    await expect(controller.leaveUnlocked(REQ)).resolves.toBe(false);
    host.store.markers[`${REQ}.0`].state = 'owed';
    await expect(controller.leaveUnlocked(REQ)).resolves.toBe(true);
  });

  it('names why a password cannot be typed', () => {
    const controller = build();
    const ready = { osMajor: 26, inputGrant: 'own', helperSource: 'retained' };
    expect(controller.passwordRefusal(ready, 'app', 'locked-in-session')).toBeNull();
    expect(controller.passwordRefusal({ ...ready, osMajor: 15 }, 'app', 'locked-in-session')).toBe('unsupported-macos');
    expect(controller.passwordRefusal({ ...ready, helperSource: 'packaged' }, 'app', 'locked-in-session')).toBe('retained-helper-required');
    expect(controller.passwordRefusal({ ...ready, inputGrant: 'inherited' }, 'app', 'locked-in-session')).toBe('own-input-grant-required');
    expect(controller.passwordRefusal(ready, 'browser', 'locked-in-session')).toBe('browser-box-off');
    expect(controller.passwordRefusal(ready, 'app', 'unknown')).toBe('not-locked');
    settings.browserBox = true;
    expect(controller.passwordRefusal(ready, 'browser', 'locked-in-session')).toBeNull();
  });

  it('tells the owner once when a watch ends without a relock, with no request alive', async () => {
    const controller = build();
    host.persist();
    host.store.markers[`${REQ}.0`] = { state: 'relock-failed', agentId: 'echo', requestId: REQ, producerGone: true };
    await controller.sweep();
    await controller.sweep();
    expect(security).toHaveLength(1);
    expect(security[0].key).toBe(`desktop-relock-failed:${REQ}.0`);
  });

  it('keeps trying until the owner has really been told', async () => {
    const controller = build();
    host.persist();
    host.store.markers[`${REQ}.0`] = { state: 'relock-failed', agentId: 'echo', requestId: REQ, producerGone: true };
    raised = false;
    await controller.sweep();
    expect(host.store.markers[`${REQ}.0`].reported).toBeUndefined();
    raised = true;
    await controller.sweep();
    expect(host.store.markers[`${REQ}.0`].reported).toBe(true);
    controller.stop();
  });

  it('tells the owner when a guard lost its store, and when the store cannot be read', async () => {
    const controller = build();
    host.persist();
    fs.writeFileSync(path.join(root, `failed-${REQ}.0`), '');
    await controller.sweep();
    expect(security.map(item => item.key)).toContain(`desktop-relock-failed-${REQ}.0`);
    expect(fs.existsSync(path.join(root, `failed-${REQ}.0`))).toBe(false);
    const read = host.lockedOp;
    host.lockedOp = async op => { if (op.op === 'read') throw new Error('mac-desktop-host-unavailable'); return read(op); };
    await controller.sweep();
    expect(security.map(item => item.key)).toContain('desktop-locked-store-unreadable');
    controller.stop();
  });

  it('refuses a password when the session cannot be recorded', async () => {
    const controller = build();
    controller.noteGrant(REQ);
    const original = host.lockedOp;
    host.lockedOp = async op => (op.op === 'marker-create' ? { error: 'session-unreadable' } : original(op));
    await expect(controller.prepareSecret(REQ, now + 60_000)).resolves.toEqual({ refused: 'session-unreadable' });
    controller.stop();
  });

  it('refuses a password for a request that Stop already ended', async () => {
    const controller = build();
    await expect(controller.prepareSecret(REQ, now + 60_000)).resolves.toEqual({ refused: 'grant-ended' });
    expect(host.store.markers).toEqual({});
  });

  it('replaces a dead guard mid-watch with Node alive, then gives up at the bound', async () => {
    const controller = build();
    host.persist();
    host.store.markers[`${REQ}.0`] = { state: 'watching', agentId: 'echo', requestId: REQ, watchStart: now, guardReplacements: 0 };
    await controller.sweep();
    expect(host.guards).toEqual([`${REQ}.0`]);
    SafeFsExecutor.safeRmSync(path.join(root, `hb-${REQ}.0`), { force: true, operation: 'test cleanup' });
    host.store.markers[`${REQ}.0`].guardReplacements = 3;
    await controller.sweep();
    expect(host.store.markers[`${REQ}.0`].state).toBe('relock-failed');
    expect(host.store.markers[`${REQ}.0`].producerGone).toBe(true);
  });

  it('relocks at boot for a marker whose request is gone, and leaves other agents alone', async () => {
    const controller = build();
    host.persist();
    host.store.markers.a = { state: 'owed', agentId: 'echo', requestId: 'gone', guardPid: 0 };
    host.store.markers.b = { state: 'owed', agentId: 'luna', requestId: 'hers' };
    await controller.sweep(true);
    expect(host.store.markers.a.relockNow).toBe(true);
    expect(host.store.markers.b.relockNow).toBeUndefined();
  });

  it('disable turns it off, and only the enable clears the Mac-wide marker', async () => {
    const controller = build();
    await controller.disable();
    expect(host.store.disabled).toBe(true);
    expect(settings.enabled).toBe(false);
    expect(security).toHaveLength(1);
    await controller.applySettings({ chime: false });
    expect(host.store.disabled).toBe(true);
    await controller.applySettings({ enabled: true });
    expect(host.store.disabled).toBe(false);
  });
});
