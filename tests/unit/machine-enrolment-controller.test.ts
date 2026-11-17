/**
 * Enrolment: the owner's one tap (machine-self-maintenance Part C, CMT-1200 second slice).
 * Both sides: one offer per machine and set of facts, again on a readiness change; a tap
 * from anyone but the owner, with a stale or foreign nonce, while the ingress guard cannot
 * prove taps, or with a refusal now active changes nothing; Approve writes the record
 * (proving when unattended-ready and the rule installed, else attended); "Not this machine"
 * writes the marker; the rule installs only with passwordless sudo and only when it reads
 * back byte for byte and is listed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { EnrolmentController, ENROL_OFFER_TTL_MS, SUDOERS_RULE_PATH, cardText } from '../../src/monitoring/machineMaintenance/EnrolmentController.js';
import type { EnrolmentStatus } from '../../src/monitoring/machineMaintenance/enrolmentReadiness.js';

const RULE = 'me ALL=(root) NOPASSWD: /sbin/shutdown -r now, /sbin/reboot -q\n';

function status(over: Partial<EnrolmentStatus> = {}, mode: 'unattended' | 'attended' = 'unattended'): EnrolmentStatus {
  return { enrolled: false, record: null, refusal: null, offerable: true, readiness: { platform: 'darwin', mode, checks: [], ownerStep: mode === 'attended' ? 'On this Mac: System Settings, Users & Groups, Automatically log in as, choose your name.' : null, readAt: 0 }, ...over };
}

describe('EnrolmentController', () => {
  let dir: string;
  let clock: number;
  let st: EnrolmentStatus;
  let armed: boolean;
  let sent: Array<{ text: string; buttons: Array<{ text: string; data: string }> }>;
  let sudo: { nopasswd: boolean; installed: string | null; listed: boolean; ran: string[][] };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-enrol-'));
    clock = 1_000_000; st = status(); armed = true; sent = [];
    sudo = { nopasswd: true, installed: null, listed: true, ran: [] };
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-enrolment-controller.test.ts' }));

  function make(): EnrolmentController {
    return new EnrolmentController({
      hostDir: dir, agent: 'echo', user: 'me', platform: 'darwin',
      machineId: () => 'm_studio', machineLabel: () => 'Mac Studio',
      status: async () => st, ingressArmed: () => armed,
      sendOffer: async (text, buttons) => { sent.push({ text, buttons }); return 42; },
      openApps: async () => ['Google Chrome', 'Simulator'],
      coResident: () => ['echo', 'sagemind'],
      now: () => clock,
      run: async (command, args) => {
        sudo.ran.push([command, ...args]);
        if (args[0] === '-n' && args[1] === 'true') return { code: sudo.nopasswd ? 0 : 1, stdout: '' };
        if (args[0] === '-n' && args[1] === 'sh') { sudo.installed = args[5]; return { code: 0, stdout: '' }; }
        if (args[0] === '-n' && args[1] === 'cat') return { code: 0, stdout: sudo.installed ?? '' };
        if (args[0] === '-n' && args[1] === '-l') return { code: 0, stdout: sudo.listed ? '(root) NOPASSWD: /sbin/shutdown -r now, /sbin/reboot -q' : '' };
        return { code: 0, stdout: '' };
      },
    });
  }
  const nonceOf = (i = 0) => /mc:enrol:([0-9a-f]{24})/.exec(sent[i].buttons[0].data)![1];
  const record = () => JSON.parse(fs.readFileSync(path.join(dir, 'enrolment.json'), 'utf-8'));

  it('offers once with the card text and two buttons; not again for the same facts; again on a readiness change', async () => {
    const c = make();
    expect(await c.offer()).toBe('offered');
    expect(sent[0].text).toMatch(/restart this machine about once a week/);
    expect(sent[0].text).toMatch(/Google Chrome, Simulator/);
    expect(sent[0].text).toMatch(/echo, sagemind/);
    expect(sent[0].buttons.map((b) => b.data.split(':').slice(0, 2).join(':'))).toEqual(['mc:enrol', 'mc:dnm']);
    expect(await c.offer()).toBe('already-offered');
    clock += 2 * ENROL_OFFER_TTL_MS;
    expect(await c.offer()).toBe('already-offered');
    st = status({}, 'attended');
    expect(await c.offer()).toBe('offered');
    expect(sent[1].text).toMatch(/Automatically log in as/);
  });

  it('not offerable (refused or enrolled) sends nothing', async () => {
    st = status({ offerable: false, refusal: 'not-owned' });
    expect(await make().offer()).toBe('not-offerable');
    expect(sent).toHaveLength(0);
  });

  it('Approve from the owner installs the exact rule and enrols as proving', async () => {
    const c = make();
    await c.offer();
    expect(await c.onTap({ data: `mc:enrol:${nonceOf()}`, fromIsOwner: true, fromUserId: 7 })).toMatch(/Enrolled\. The first restart is a proving one/);
    expect(sudo.installed).toBe(RULE);
    expect(sudo.ran.some((r) => r.includes(SUDOERS_RULE_PATH))).toBe(true);
    expect(record()).toMatchObject({ machineId: 'm_studio', mode: 'proving', principal: 'telegram:7', ruleInstalled: true, maintainerAgent: 'echo' });
    // The nonce is single-use.
    expect(await c.onTap({ data: `mc:enrol:${nonceOf()}`, fromIsOwner: true, fromUserId: 7 })).toMatch(/expired/);
  });

  it('refuses: not the owner, unknown nonce, expired offer, guard cannot prove taps, a refusal now active', async () => {
    const c = make();
    await c.offer();
    const data = `mc:enrol:${nonceOf()}`;
    expect(await c.onTap({ data, fromIsOwner: false, fromUserId: 9 })).toMatch(/Only the owner/);
    expect(await c.onTap({ data: 'mc:enrol:' + '0'.repeat(24), fromIsOwner: true, fromUserId: 7 })).toMatch(/expired/);
    armed = false;
    expect(await c.onTap({ data, fromIsOwner: true, fromUserId: 7 })).toMatch(/can't accept this tap safely yet/);
    armed = true;
    st = status({ refusal: 'other-user-active', offerable: false });
    expect(await c.onTap({ data, fromIsOwner: true, fromUserId: 7 })).toMatch(/Someone else is using/);
    expect(fs.existsSync(path.join(dir, 'enrolment.json'))).toBe(false);
    clock += ENROL_OFFER_TTL_MS;
    st = status();
    expect(await c.onTap({ data, fromIsOwner: true, fromUserId: 7 })).toMatch(/expired/);
    expect(fs.existsSync(path.join(dir, 'enrolment.json'))).toBe(false);
  });

  it('without passwordless sudo nothing privileged runs, and the machine is enrolled attended with a plain reason', async () => {
    sudo.nopasswd = false;
    const c = make();
    await c.offer();
    expect(await c.onTap({ data: `mc:enrol:${nonceOf()}`, fromIsOwner: true, fromUserId: 7 })).toMatch(/administrator step/);
    expect(sudo.installed).toBeNull();
    expect(record()).toMatchObject({ mode: 'attended', ruleInstalled: false });
  });

  it('a rule that does not read back or is not listed counts as not installed', async () => {
    sudo.listed = false;
    const c = make();
    await c.offer();
    await c.onTap({ data: `mc:enrol:${nonceOf()}`, fromIsOwner: true, fromUserId: 7 });
    expect(record()).toMatchObject({ mode: 'attended', ruleInstalled: false });
  });

  it('"Not this machine" writes the do-not-maintain marker and enrols nothing', async () => {
    const c = make();
    await c.offer();
    const n = /mc:dnm:([0-9a-f]{24})/.exec(sent[0].buttons[1].data)![1];
    expect(await c.onTap({ data: `mc:dnm:${n}`, fromIsOwner: true, fromUserId: 7 })).toMatch(/won't restart this machine/);
    expect(fs.existsSync(path.join(dir, 'do-not-maintain.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'enrolment.json'))).toBe(false);
  });

  it('card text names no apps when unread', () => {
    expect(cardText('Mac Studio', null, ['echo'])).not.toMatch(/Open on it now/);
  });
});
