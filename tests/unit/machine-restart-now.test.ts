/**
 * Restart now (machine-self-maintenance Part E operator trigger, CMT-1199 third slice).
 * Both sides of every decision: only the owner's tap on a live card starts it; S1/S2, the
 * off switch, an unenrolled machine and unread holds refuse even the owner; S3, S4 and a
 * recent boot pass only when the card named them; the countdown reserves an operator
 * episode and tells the sessions; Cancel stops it before T-0 and not after; rung 1 runs the
 * real actuator through claimRung, rung 2 follows if the machine is still up, then the
 * owner hears it read unknown; a countdown from an earlier boot is never dispatched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { HostMaintenanceStore, episodesOf, type EpisodeRow } from '../../src/monitoring/machineMaintenance/HostMaintenanceStore.js';
import { RestartActuator } from '../../src/monitoring/machineMaintenance/RestartActuator.js';
import { RestartNowController, SHORT_DRAIN_MS, RUNG2_AFTER_MS } from '../../src/monitoring/machineMaintenance/RestartNowController.js';
import type { HoldReading } from '../../src/monitoring/machineMaintenance/readings.js';

const H = 60 * 60_000;
const hold = (id: HoldReading['id'], active: boolean, evidence: string | null = null): HoldReading => ({ id, active, label: { S1: 'OS update installing', S2: 'Disk or firmware operation', S3: 'A person using the machine now', S4: 'On battery under 50%' }[id], evidence, provenLive: false });

describe('RestartNowController', () => {
  let dir: string;
  let clock: number;
  let bootAt: number;
  let holds: HoldReading[] | null;
  let enrolled: boolean | null;
  let enabled: boolean;
  let armed: boolean;
  let sent: Array<{ text: string; buttons: Array<{ text: string; data: string }> }>;
  let notices: string[];
  let spawned: string[][];
  let timers: Array<{ ms: number }>;
  let store: HostMaintenanceStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-restart-now-'));
    clock = 1_800_000_000_000; bootAt = clock - 3 * 24 * H;
    holds = [hold('S1', false), hold('S2', false), hold('S3', false), hold('S4', false)];
    enrolled = true; enabled = true; armed = true;
    sent = []; notices = []; spawned = []; timers = [];
    store = new HostMaintenanceStore({ dir, now: () => clock });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-restart-now.test.ts' }));

  function make(): RestartNowController {
    let cachedHolds: HoldReading[] | null = null;
    const actuator = new RestartActuator({
      store, platform: 'darwin', agent: 'echo',
      readBootAt: async () => bootAt,
      freshCheck: () => {
        if (!enabled) return 'machine care switched off';
        if (cachedHolds === null) return 'safety holds unread';
        const hard = cachedHolds.find((h) => (h.id === 'S1' || h.id === 'S2') && h.active);
        return hard ? `${hard.label.toLowerCase()} (${hard.id})` : null;
      },
      isThrowaway: () => false,
      spawn: async (command, args) => { spawned.push([command, ...args]); return { spawned: true, exitCode: 0, signal: null, timedOut: false }; },
    });
    return new RestartNowController({
      hostDir: dir, agent: 'echo', machineLabel: () => 'Mac Studio', store,
      dispatch: async (input) => { cachedHolds = holds; return actuator.dispatch(input); },
      enrolled: async () => enrolled,
      enabled: () => enabled,
      ingressArmed: () => armed,
      readHolds: async () => holds,
      readBootAt: async () => bootAt,
      sendOwner: async (text, buttons) => { sent.push({ text, buttons }); return 7; },
      noticeSessions: async (text) => { notices.push(text); return 3; },
      now: () => clock,
      setTimer: (_fn, ms) => { timers.push({ ms }); return () => {}; },
    });
  }
  const nonceOf = (i = 0) => /mc:rn:([0-9a-f]{24})/.exec(sent[i].buttons[0].data)![1];
  const tap = (c: RestartNowController, data: string, owner = true) => c.onTap({ data, fromIsOwner: owner, fromUserId: 7 });
  const latest = (): EpisodeRow | undefined => [...episodesOf(store.readLedger() ?? []).values()][0]?.latest;

  it('refuses to offer: not enrolled, switched off, an update or disk operation running, holds unread', async () => {
    enrolled = false;
    expect(await make().offer()).toMatchObject({ result: 'refused', reason: expect.stringMatching(/isn't enrolled/) });
    enrolled = true; enabled = false;
    expect(await make().offer()).toMatchObject({ result: 'refused', reason: expect.stringMatching(/switched off/) });
    enabled = true; holds![0] = hold('S1', true, 'softwareupdated');
    expect(await make().offer()).toMatchObject({ result: 'refused', reason: expect.stringMatching(/OS update installing \(softwareupdated\)/) });
    holds = null;
    expect(await make().offer()).toMatchObject({ result: 'refused', reason: expect.stringMatching(/couldn't read/) });
    expect(sent).toHaveLength(0);
  });

  it('a plain card offers Restart now and Not now; a card with a person present or a recent boot names them first', async () => {
    expect(await make().offer()).toMatchObject({ result: 'offered', named: [], recentBoot: false });
    expect(sent[0].buttons.map((b) => b.text)).toEqual(['Restart now', 'Not now']);
    holds![2] = hold('S3', true, 'console input');
    bootAt = clock - 2 * H;
    expect(await make().offer()).toMatchObject({ result: 'offered', named: ['S3'], recentBoot: true });
    expect(sent[1].text).toMatch(/Someone is using it right now \(console input\)/);
    expect(sent[1].text).toMatch(/last started 2 hour/);
    expect(sent[1].buttons[0].text).toBe('Restart anyway');
  });

  it('refuses a tap from anyone but the owner, an unknown or expired card, and an unarmed ingress guard', async () => {
    const c = make();
    await c.offer();
    const data = `mc:rn:${nonceOf()}`;
    expect(await tap(c, data, false)).toMatch(/Only the owner/);
    expect(await tap(c, 'mc:rn:' + '0'.repeat(24))).toMatch(/expired/);
    armed = false;
    expect(await tap(c, data)).toMatch(/can't accept this tap safely/);
    armed = true;
    clock += 16 * 60_000;
    expect(await tap(c, data)).toMatch(/expired/);
    expect(store.readLedger()).toEqual([]);
  });

  it('the owner\'s tap reserves an operator episode, tells the sessions, offers Cancel, and at T-0 runs rung 1 through the actuator', async () => {
    const c = make();
    await c.offer();
    expect(await tap(c, `mc:rn:${nonceOf()}`)).toMatch(/Restarting at/);
    expect(latest()).toMatchObject({ kind: 'operator', state: 'reserved', by: 'telegram:7' });
    expect(notices[0]).toMatch(/restarts at .* in 5 minutes.*Save your place/);
    expect(sent[1].text).toMatch(/3 running sessions have been told/);
    expect(sent[1].buttons[0]).toMatchObject({ text: 'Cancel' });
    expect(timers.at(-1)!.ms).toBe(SHORT_DRAIN_MS);
    expect(spawned).toEqual([]);
    // The card is single-use.
    expect(await tap(c, `mc:rn:${nonceOf()}`)).toMatch(/expired/);

    clock += SHORT_DRAIN_MS;
    await c.step();
    expect(spawned).toEqual([['sudo', '-n', '/sbin/shutdown', '-r', 'now']]);
    expect(latest()).toMatchObject({ state: 'dispatched', rung: 1, dispatch: 'accepted' });
    expect(c.readActive()).toMatchObject({ phase: 'rung1-sent' });
    expect(timers.at(-1)!.ms).toBe(RUNG2_AFTER_MS);

    // Still up 8 minutes later: rung 2, then unknown and the owner is told.
    clock += RUNG2_AFTER_MS;
    await c.step();
    expect(spawned[1]).toEqual(['sudo', '-n', '/sbin/reboot', '-q']);
    clock += RUNG2_AFTER_MS;
    await c.step();
    expect(latest()).toMatchObject({ state: 'outcome-unknown' });
    expect(sent.at(-1)!.text).toMatch(/was told to restart and hasn't/);
    expect(c.readActive()).toBeNull();
  });

  it('Cancel before T-0 aborts the episode and nothing is sent; Cancel after rung 1 is refused', async () => {
    const c = make();
    await c.offer();
    const n = nonceOf();
    await tap(c, `mc:rn:${n}`);
    expect(await tap(c, `mc:rnc:${n}`)).toMatch(/Cancelled\. Nothing restarted/);
    expect(latest()).toMatchObject({ state: 'aborted', reason: 'owner-cancelled' });
    expect(notices.at(-1)).toMatch(/cancelled/);
    await c.step();
    expect(spawned).toEqual([]);

    clock += 7 * H;
    await c.offer();
    const n2 = nonceOf(sent.length - 1);
    await tap(c, `mc:rn:${n2}`);
    clock += SHORT_DRAIN_MS;
    await c.step();
    expect(await tap(c, `mc:rnc:${n2}`)).toMatch(/Too late to cancel/);
  });

  it('a person or battery hold that appeared after the card gets a fresh card, not a restart', async () => {
    const c = make();
    await c.offer();
    holds![3] = hold('S4', true, '30%');
    expect(await tap(c, `mc:rn:${nonceOf()}`)).toMatch(/Something changed since the card: on battery under 50%/);
    expect(store.readLedger()).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.at(-1)!.text).toMatch(/It is on battery \(30%\)/);
  });

  it('a recent boot passes only on a card that named it', async () => {
    bootAt = clock - 2 * H;
    const c = make();
    await c.offer();
    expect(await tap(c, `mc:rn:${nonceOf()}`)).toMatch(/Restarting at/);
    expect(latest()).toMatchObject({ kind: 'operator', state: 'reserved' });
  });

  it('an OS update that starts during the countdown refuses rung 1 inside the lock; the owner is told and nothing runs', async () => {
    const c = make();
    await c.offer();
    await tap(c, `mc:rn:${nonceOf()}`);
    holds![0] = hold('S1', true, 'softwareupdated');
    clock += SHORT_DRAIN_MS;
    await c.step();
    expect(spawned).toEqual([]);
    expect(latest()).toMatchObject({ state: 'aborted', rung: 1, reason: 'os update installing (S1)' });
    expect(sent.at(-1)!.text).toMatch(/I didn't restart Mac Studio: os update installing \(S1\)\. Nothing restarted/);
    expect(c.readActive()).toBeNull();
  });

  it('"Not now" uses the card; a countdown from an earlier boot is cleared on resume and never dispatched', async () => {
    const c = make();
    await c.offer();
    expect(await tap(c, `mc:rnx:${nonceOf()}`)).toMatch(/not restarting/);
    expect(await tap(c, `mc:rn:${nonceOf()}`)).toMatch(/expired/);

    await c.offer();
    await tap(c, `mc:rn:${nonceOf(1)}`);
    bootAt = clock + 60 * 60_000;
    clock += 2 * H;
    await make().resume();
    expect(c.readActive()).toBeNull();
    expect(spawned).toEqual([]);
  });
});
