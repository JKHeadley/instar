/**
 * SEC-170 part 3 of 3 (docs/specs/pool-wide-pin-budget.md §4, §5): the owner's "gone for good" confirmations,
 * the agent-wide silent-machines list behind the one Needs-you item, the agent-wide alert backstop, and the
 * per-purpose switch on the phone's owner-approval routes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoneForGoodStore, silentMachines, isNewSince, poolFailureAlert, PoolFailureAlerter, parseReportedConfirmations, POOL_ALERT_COOLDOWN_MS } from '../../src/core/PinGoneForGood.js';
import { PinOwnerSurface } from '../../src/core/PinOwnerSurface.js';
import { readGoneForGood } from '../../src/core/PinShare.js';
import { GONE_FOR_GOOD_SILENCE_MS } from '../../src/core/PinShareTable.js';
import { buildAction, actionLine } from '../../src/server/mobilePermissionsRoutes.js';
import { DEVICE_ALLOWLIST } from '../../src/server/mobilePairingRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { stateSigningText } from '../../src/core/pinBudgetPoller.js';

const id = (c: string) => `m_${c.repeat(32)}`;
const A = id('a'); const B = id('b'); const C = id('c'); const D = id('d');
const DAY = 24 * 60 * 60 * 1000;

let dir = '';
let clock = 0;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec170p3-')); clock = 100 * DAY; });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/sec170-pin-owner-surface.test.ts' }); });

describe('GoneForGoodStore', () => {
  it('saves a confirmation that part 2\'s reader sees, and it stands until the machine is heard from after it', () => {
    const store = new GoneForGoodStore(dir, () => clock);
    store.confirm(B, A);
    expect([...readGoneForGood(dir)]).toEqual([B]);
    expect(store.standing(new Map([[B, clock - 8 * DAY]])).has(B)).toBe(true);
    // Heard from after the owner confirmed it: the confirmation lapses for good.
    expect(store.standing(new Map([[B, clock + 1]])).has(B)).toBe(false);
  });

  it('a confirmation given before the machine had been silent for 7 days never stands (no pre-seeding, no re-arming)', () => {
    const store = new GoneForGoodStore(dir, () => clock);
    store.confirm(B, A);
    expect(store.standing(new Map([[B, clock - DAY]])).has(B)).toBe(false);
    expect(store.standing(new Map([[B, clock - 7 * DAY]])).has(B)).toBe(true);
  });

  it('adopts a member\'s reported confirmations: newer wins, never one for itself, never one dated in the future', () => {
    const store = new GoneForGoodStore(dir, () => clock);
    expect(store.adopt([{ machineId: B, confirmedAt: clock - 10, approvedOn: C }], A)).toBe(1);
    expect(store.adopt([{ machineId: B, confirmedAt: clock - 20, approvedOn: C }], A)).toBe(0);
    expect(store.adopt([{ machineId: A, confirmedAt: clock - 5, approvedOn: C }], A)).toBe(0);
    expect(store.adopt([{ machineId: D, confirmedAt: clock + 10 * 60_000, approvedOn: C }], A)).toBe(0);
    expect(store.read()[B]).toMatchObject({ source: 'relayed', approvedOn: C, confirmedAt: clock - 10 });
    expect(store.reportable()).toEqual([{ machineId: B, confirmedAt: clock - 10, approvedOn: C }]);
  });

  it('an unreadable file reads as no confirmations (the raise keeps waiting), and a report\'s field is sanitized', () => {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'pin-gone-for-good.json'), '{not json');
    expect(new GoneForGoodStore(dir).read()).toEqual({});
    expect(parseReportedConfirmations([{ machineId: 'evil', confirmedAt: 1 }, { machineId: B, confirmedAt: 'x' }, { machineId: C, confirmedAt: 5 }, 'junk'])).toEqual([{ machineId: C, confirmedAt: 5, approvedOn: '' }]);
    expect(parseReportedConfirmations('nope')).toEqual([]);
  });
});

describe('silent machines', () => {
  const members = [
    { machineId: A, lastSeen: 0, pairedAt: 0 },
    { machineId: B, lastSeen: 0, pairedAt: 0 },
    { machineId: C, lastSeen: 0, pairedAt: 0 },
  ];
  it('lists every member silent for 7 days or more in one list (never this machine), oldest first', () => {
    const contacts = new Map([[A, clock], [B, clock - 9 * DAY], [C, clock - 8 * DAY]]);
    const r = silentMachines({ self: A, members, contacts, confirmed: new Set(), heldBack: false, now: clock });
    expect(r.rows.map((x) => x.machineId)).toEqual([B, C]);
    // A registry sign of life newer than the contact record keeps a machine off the list.
    const r2 = silentMachines({ self: A, members: members.map((m) => (m.machineId === C ? { ...m, lastSeen: clock - DAY } : m)), contacts, confirmed: new Set(), heldBack: false, now: clock });
    expect(r2.rows.map((x) => x.machineId)).toEqual([B]);
    expect(silentMachines({ self: A, members, contacts: new Map([[B, clock - GONE_FOR_GOOD_SILENCE_MS + 1]]), confirmed: new Set(), heldBack: false, now: clock }).rows.map((x) => x.machineId)).toEqual([C]);
  });

  it('something new is another machine going silent or a new hold; a machine coming back is not', () => {
    expect(isNewSince(null, { silentIds: [B], heldBack: false })).toBe(true);
    expect(isNewSince({ silentIds: [B, C], heldBack: false }, { silentIds: [B], heldBack: false })).toBe(false);
    expect(isNewSince({ silentIds: [B], heldBack: false }, { silentIds: [B, C], heldBack: false })).toBe(true);
    expect(isNewSince({ silentIds: [B], heldBack: false }, { silentIds: [B], heldBack: true })).toBe(true);
    expect(isNewSince({ silentIds: [B], heldBack: true }, { silentIds: [B], heldBack: true })).toBe(false);
  });
});

function surfaceFor(opts: { contacts: Map<string, number>; raiseWaiting?: boolean; enabled?: boolean; evidenceComplete?: boolean }) {
  const store = new GoneForGoodStore(dir, () => clock);
  const retired = new Set<string>();
  let invalidated = 0;
  let waiting = opts.raiseWaiting ?? false;
  const surface = new PinOwnerSurface({
    stateDir: dir, store, enabled: () => opts.enabled ?? true, self: () => A,
    members: () => [A, B, C].filter((m) => !retired.has(m)).map((m) => ({ machineId: m, name: m === B ? 'Old Laptop' : m === C ? 'Mini' : 'Studio', lastSeen: 0, pairedAt: 0 })),
    isRetired: (m) => retired.has(m),
    contacts: () => opts.contacts, evidenceComplete: () => opts.evidenceComplete ?? true, raiseWaiting: () => waiting,
    retire: (m) => { retired.add(m); }, invalidate: () => { invalidated += 1; }, now: () => clock,
  });
  return { surface, store, retired, invalidated: () => invalidated, setWaiting: (w: boolean) => { waiting = w; } };
}

describe('PinOwnerSurface', () => {
  it('a choice is refused before any Face ID unless the computer is listed and the list is the one the owner saw', () => {
    const { surface } = surfaceFor({ contacts: new Map([[A, clock], [B, clock - 9 * DAY], [C, clock]]) });
    const fp = surface.silent().fingerprint;
    expect(surface.precheck(C, 'gone-for-good', fp)?.body.error).toBe('not-silent');
    expect(surface.precheck(A, 'retire', fp)?.body.error).toBe('self');
    expect(surface.precheck(B, 'retire', 'ffffffffffffffff')?.body.error).toBe('list-changed');
    expect(surface.precheck(B, 'gone-for-good', fp)).toBeNull();
  });

  it('gone for good saves the owner\'s confirmation, once, and re-reads the share', () => {
    const h = surfaceFor({ contacts: new Map([[A, clock], [B, clock - 9 * DAY], [C, clock]]) });
    const fp = h.surface.silent().fingerprint;
    expect(h.surface.apply(B, 'gone-for-good', fp)).toEqual({ status: 200, body: { ok: true, applied: 'gone-for-good' } });
    expect(h.store.read()[B]).toMatchObject({ source: 'owner-phone', approvedOn: A });
    expect(h.invalidated()).toBe(1);
    const fp2 = h.surface.silent().fingerprint;
    expect(h.surface.silent().rows.find((r) => r.machineId === B)?.confirmedGone).toBe(true);
    expect(h.surface.apply(B, 'gone-for-good', fp2)).toEqual({ status: 200, body: { ok: true, already: true } });
    expect(h.invalidated()).toBe(1);
  });

  it('retire removes the pairing through the registry, and a second tap changes nothing', () => {
    const h = surfaceFor({ contacts: new Map([[A, clock], [B, clock - 9 * DAY], [C, clock]]) });
    const fp = h.surface.silent().fingerprint;
    expect(h.surface.apply(B, 'retire', fp).body).toMatchObject({ ok: true, applied: 'retire' });
    expect([...h.retired]).toEqual([B]);
    expect(h.surface.apply(B, 'retire', 'any0000000000000').body).toEqual({ ok: true, already: true });
    expect(h.surface.silent().rows).toEqual([]);
  });

  it('a save that fails reports it and changes nothing', () => {
    const h = surfaceFor({ contacts: new Map([[A, clock], [B, clock - 9 * DAY], [C, clock]]) });
    h.store.confirm = () => { throw new Error('disk full'); };
    const r = h.surface.apply(B, 'gone-for-good', h.surface.silent().fingerprint);
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('apply-failed');
    expect(h.invalidated()).toBe(0);
  });

  it('says when some computer\'s records could not be read, and then refuses to retire (it cannot be undone)', () => {
    const h = surfaceFor({ contacts: new Map([[A, clock], [B, clock - 9 * DAY], [C, clock]]), evidenceComplete: false });
    const v = h.surface.silent();
    expect(v.evidenceComplete).toBe(false);
    expect(h.surface.precheck(B, 'retire', v.fingerprint)?.body.error).toBe('evidence-incomplete');
    expect(h.surface.apply(B, 'retire', v.fingerprint).status).toBe(409);
    expect([...h.retired]).toEqual([]);
    expect(h.surface.precheck(B, 'gone-for-good', v.fingerprint)).toBeNull();
  });

  it('a dismissed item stays quiet until another machine goes silent or a raise is held back; a stale dismiss is refused', () => {
    const contacts = new Map([[A, clock], [B, clock - 9 * DAY], [C, clock]]);
    const h = surfaceFor({ contacts });
    const v = h.surface.silent();
    expect(v.show).toBe(true);
    expect(h.surface.dismiss('stale').ok).toBe(false);
    expect(h.surface.dismiss(v.fingerprint).ok).toBe(true);
    expect(h.surface.silent()).toMatchObject({ show: false, dismissed: true });
    contacts.set(C, clock - 8 * DAY);
    expect(h.surface.silent()).toMatchObject({ show: true, dismissed: false });
    expect(h.surface.silent().rows.map((r) => r.name)).toEqual(['Old Laptop', 'Mini']);
  });

  it('a machine that came back and later goes silent again raises the dismissed item again', () => {
    const contacts = new Map([[A, clock], [B, clock - 9 * DAY], [C, clock - 8 * DAY]]);
    const h = surfaceFor({ contacts });
    h.surface.dismiss(h.surface.silent().fingerprint);
    contacts.set(C, clock);
    expect(h.surface.silent().show).toBe(false);
    clock += 8 * DAY; contacts.set(A, clock); contacts.set(B, clock - 17 * DAY);
    expect(h.surface.silent()).toMatchObject({ show: true });
  });

  it('a hold that starts after the dismissal raises it again', () => {
    const h = surfaceFor({ contacts: new Map([[A, clock], [B, clock - 9 * DAY], [C, clock]]) });
    h.surface.dismiss(h.surface.silent().fingerprint);
    expect(h.surface.silent().show).toBe(false);
    h.setWaiting(true);
    expect(h.surface.silent()).toMatchObject({ show: true, heldBack: true });
  });

  it('switched off: nothing listed and every choice refused', () => {
    const h = surfaceFor({ contacts: new Map([[B, clock - 9 * DAY]]), enabled: false });
    expect(h.surface.silent()).toMatchObject({ enabled: false, show: false, rows: [] });
    expect(h.surface.precheck(B, 'retire', 'x')?.status).toBe(503);
    expect(h.surface.apply(B, 'gone-for-good', 'x').status).toBe(503);
  });
});

describe('agent-wide alert backstop', () => {
  it('20 failures across machines within the hour, raised by the lowest id only', () => {
    expect(poolFailureAlert(A, new Map([[A, 5], [B, 7], [C, 8]]))).toMatchObject({ raise: true, total: 20, voice: A });
    expect(poolFailureAlert(B, new Map([[A, 5], [B, 7], [C, 8]]))).toMatchObject({ raise: false, total: 20, voice: A });
    expect(poolFailureAlert(A, new Map([[A, 5], [B, 7], [C, 7]])).raise).toBe(false);
  });

  it('reports at most once per 30 minutes, and never while switched off', () => {
    const raised: number[] = [];
    let now = 0; let on = true;
    const alerter = new PoolFailureAlerter({ self: () => A, enabled: () => on, ownCount: () => 4, peerCounts: () => new Map([[B, 16]]), report: (t) => raised.push(t), now: () => now });
    expect(alerter.check().raised).toBe(true);
    now += POOL_ALERT_COOLDOWN_MS - 1;
    expect(alerter.check().raised).toBe(false);
    now += 1;
    expect(alerter.check().raised).toBe(true);
    on = false; now += POOL_ALERT_COOLDOWN_MS;
    expect(alerter.check().raised).toBe(false);
    expect(raised).toEqual([20, 20]);
  });
});

describe('the signed report covers the part 3 fields', () => {
  it('tampering with the confirmations or the hourly count changes the signed text', () => {
    const report = { machineId: A, table: null, applied: 10, retired: false, needsShare: false, heldTransfer: null, goneForGood: [{ machineId: C, confirmedAt: 5, approvedOn: A }], failuresLastHour: 3 };
    const base = stateSigningText('n', report, {});
    expect(stateSigningText('n', { ...report, failuresLastHour: 30 }, {})).not.toBe(base);
    expect(stateSigningText('n', { ...report, goneForGood: [] }, {})).not.toBe(base);
  });
});

describe('the phone action', () => {
  it('names the computer, the choice and the list version on the signed line, and refuses anything else', () => {
    const ok = buildAction('silent-machine', B, { choice: 'retire', fingerprint: '0123456789abcdef' });
    expect(ok.ok && actionLine(ok.action)).toBe(`silent-machine ${B} retire 0123456789abcdef`);
    expect(buildAction('silent-machine', 'not-an-id', { choice: 'retire', fingerprint: '0123456789abcdef' })).toEqual({ ok: false, error: 'bad-target' });
    expect(buildAction('silent-machine', B, { choice: 'delete', fingerprint: '0123456789abcdef' })).toEqual({ ok: false, error: 'bad-choice' });
    expect(buildAction('silent-machine', B, { choice: 'gone-for-good', fingerprint: 'nope' })).toEqual({ ok: false, error: 'bad-fingerprint' });
  });

  it('is reachable only as an owner-phone signed request', () => {
    const rule = DEVICE_ALLOWLIST.find((r) => r.method === 'POST' && r.re.test('/mobile/pin-budget/silent-machine'));
    expect(rule).toMatchObject({ ownerOnly: true });
  });
});
