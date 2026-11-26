/**
 * Joined computers in the team log (docs/specs/member-browser-any-computer.md §3.4, §3.5): validation
 * against fixed format bounds, first bind wins across every kind of device, and the views every machine
 * computes from replicated rows (home, end, limits, standing). Both sides of every rule.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deviceKeyHashOf, sha256Hex } from '../../src/core/AppRecordSignatures.js';
import { foldRows, foldRowInto, emptyState, rowPayload, type MachineRow, type TeamAccessRow } from '../../src/core/TeamAccessLog.js';
import { validateMachineEvent, COMPUTER_MAX_DAYS } from '../../src/core/TeamAccessEvents.js';
import {
  COMPUTER_LIMIT_DEFAULTS, computerExpiresAt, computerHomeAt, computerLimitsFor, computerStandingIn, computersOf, renewDue,
} from '../../src/core/TeamComputers.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-20T20:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function rawKey(): string {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
}

const verify = (row: TeamAccessRow) => {
  const { machineSig, ...rest } = row;
  return machineSig.sig === sha256Hex(rowPayload(rest as never)) ? 'verified' as const : 'failed' as const;
};

let seqs: Record<string, number> = {};
function machineRow(machine: string, atMs: number, events: unknown[]): MachineRow {
  seqs[machine] = (seqs[machine] ?? 0) + 1;
  const rest = { seq: seqs[machine], kind: 'machine' as const, at: iso(atMs), events: events as MachineRow['events'], origin: machine, incarnation: 'v1', prev: null, seen: {} };
  return { ...rest, machineSig: { machineId: machine, signerKeyHash: `${machine}-k`, sig: sha256Hex(rowPayload(rest)) } };
}

/** A person-add, so the person stands in the plain fold (owner-signed request rows are exercised elsewhere). */
function withPerson(rows: TeamAccessRow[], personKey = 'mara') {
  const s = foldRows(rows, verify);
  s.people.set(personKey, { personKey, name: 'Mara', role: 'member', links: {} });
  return s;
}

function bind(key: string, over: Record<string, unknown> = {}) {
  return {
    type: 'computer-bind', keyHash: deviceKeyHashOf(key), deviceId: 'c1', boundTo: 'mara', host: 'echo-studio.example.dev', browserPublicKey: key,
    linkedAt: iso(T0), expiresAt: iso(T0 + 30 * DAY), idleDays: 30, endsBy: iso(T0 + 90 * DAY), scope: 'documents', ...over,
  };
}

describe('computer-* validation (fixed format bounds, never local settings)', () => {
  const key = rawKey();
  it('accepts a well-formed bind and refuses owner, msp, and out-of-bound lifetimes', () => {
    expect(validateMachineEvent(bind(key))).toMatchObject({ type: 'computer-bind', boundTo: 'mara', idleDays: 30 });
    for (const boundTo of ['owner', 'owner-browser', 'msp']) expect(validateMachineEvent(bind(key, { boundTo }))).toBeNull();
    expect(validateMachineEvent(bind(key, { scope: 'everything' }))).toBeNull();
    expect(validateMachineEvent(bind(key, { endsBy: iso(T0 + (COMPUTER_MAX_DAYS + 1) * DAY) }))).toBeNull();
    expect(validateMachineEvent(bind(key, { endsBy: iso(T0 + COMPUTER_MAX_DAYS * DAY), expiresAt: iso(T0 + 30 * DAY) }))).not.toBeNull();
    expect(validateMachineEvent(bind(key, { expiresAt: iso(T0 + 91 * DAY) }))).toBeNull(); // past its own endsBy
    expect(validateMachineEvent(bind(key, { idleDays: 0 }))).toBeNull();
    expect(validateMachineEvent(bind(key, { idleDays: 2.5 }))).toBeNull();
  });
  it('validates renew, adopt and limits rows', () => {
    expect(validateMachineEvent({ type: 'computer-renew', keyHash: 'k', expiresAt: iso(T0) })).toMatchObject({ type: 'computer-renew' });
    expect(validateMachineEvent({ type: 'computer-renew', keyHash: 'k', expiresAt: 'soon' })).toBeNull();
    expect(validateMachineEvent({ type: 'computer-adopt', keyHash: 'k', host: 'h' })).toMatchObject({ type: 'computer-adopt' });
    expect(validateMachineEvent({ type: 'computer-adopt', keyHash: 'k' })).toBeNull();
    expect(validateMachineEvent({ type: 'computer-limits', maxPerPerson: 5 })).toEqual({ type: 'computer-limits', maxPerPerson: 5 });
    expect(validateMachineEvent({ type: 'computer-limits', personKey: 'mara' })).toEqual({ type: 'computer-limits', personKey: 'mara' });
    expect(validateMachineEvent({ type: 'computer-limits', idleDays: 400 })).toBeNull();
    expect(validateMachineEvent({ type: 'computer-limits', idleDays: 40, maxDays: 30 })).toBeNull();
    expect(validateMachineEvent({ type: 'computer-limits', maxPerPerson: 0 })).toBeNull();
  });
});

describe('the fold: first bind wins across phones, linked and joined computers', () => {
  it('binds a joined computer, and refuses a key whose hash the row misnames', () => {
    seqs = {};
    const key = rawKey();
    const s = foldRows([machineRow('studio', T0, [bind(key)]), machineRow('studio', T0 + 1, [bind(rawKey(), { keyHash: deviceKeyHashOf(key) })])], verify);
    expect(s.computerLinks.get(deviceKeyHashOf(key))).toMatchObject({ signer: 'studio', browserPublicKey: key });
    const wrong = rawKey();
    const s2 = foldRows([machineRow('studio', T0, [bind(wrong, { keyHash: 'not-its-hash' })])], verify);
    expect(s2.computerLinks.size).toBe(0);
  });
  it('never re-binds a key already bound to a phone or a phone-linked computer, in either delivery order', () => {
    seqs = {};
    const key = rawKey();
    const kh = deviceKeyHashOf(key);
    const phone = machineRow('laptop', T0, [{ type: 'phone-bind', keyHash: kh, deviceId: 'p1', boundTo: 'joe' }]);
    const joined = machineRow('studio', T0 + 5, [bind(key)]);
    for (const order of [[phone, joined], [joined, phone]]) {
      const s = emptyState();
      for (const r of order) foldRowInto(s, r, verify);
      // Whichever arrives first holds the key; the other never takes it over.
      expect(s.bindings.get(kh)).toBe(order[0] === phone ? 'joe' : 'mara');
    }
    // A second joined computer claiming the same key for someone else loses to the first.
    const other = machineRow('laptop', T0 + 9, [bind(key, { boundTo: 'sam', deviceId: 'c2' })]);
    const s = foldRows([joined, other], verify);
    expect(s.computerLinks.get(kh)?.boundTo).toBe('mara');
  });
  it('browser-unbind ends a joined computer only with its own deviceId', () => {
    seqs = {};
    const key = rawKey();
    const kh = deviceKeyHashOf(key);
    const wrongDevice = foldRows([machineRow('studio', T0, [bind(key)]), machineRow('studio', T0 + 1, [{ type: 'browser-unbind', keyHash: kh, deviceId: 'other' }])], verify);
    expect(wrongDevice.computerLinks.get(kh)?.unbound).toBeUndefined();
    const s = foldRows([machineRow('studio', T0, [bind(key)]), machineRow('studio', T0 + 1, [{ type: 'browser-unbind', keyHash: kh, deviceId: 'c1' }])], verify);
    expect(s.computerLinks.get(kh)?.unbound).toBe(true);
    expect(s.bindings.has(kh)).toBe(false);
  });
});

describe('home, end and renew (§3.5)', () => {
  it('the home is the bind signer, then the newest adopter for the same host; an adopt for another host never counts', () => {
    seqs = {};
    const key = rawKey(); const kh = deviceKeyHashOf(key);
    const s = withPerson([
      machineRow('studio-old', T0, [bind(key)]),
      machineRow('laptop', T0 + DAY, [{ type: 'computer-adopt', keyHash: kh, host: 'elsewhere.example.dev' }]),
      machineRow('studio-new', T0 + 2 * DAY, [{ type: 'computer-adopt', keyHash: kh, host: 'echo-studio.example.dev' }]),
    ]);
    expect(computerHomeAt(s, kh, T0 + DAY)).toBe('studio-old');
    expect(computerHomeAt(s, kh)).toBe('studio-new');
  });
  it('a renew counts only from the home at its signed time, before the end it extends, never past endsBy', () => {
    seqs = {};
    const key = rawKey(); const kh = deviceKeyHashOf(key);
    const rows = [
      machineRow('studio', T0, [bind(key)]),
      machineRow('laptop', T0 + 10 * DAY, [{ type: 'computer-renew', keyHash: kh, expiresAt: iso(T0 + 40 * DAY) }]), // not the home
      machineRow('studio', T0 + 12 * DAY, [{ type: 'computer-renew', keyHash: kh, expiresAt: iso(T0 + 42 * DAY) }]),
      machineRow('studio', T0 + 50 * DAY, [{ type: 'computer-renew', keyHash: kh, expiresAt: iso(T0 + 80 * DAY) }]), // after the end it extends
      machineRow('studio', T0 + 20 * DAY, [{ type: 'computer-renew', keyHash: kh, expiresAt: iso(T0 + 120 * DAY) }]), // past endsBy
    ];
    const s = withPerson(rows);
    expect(computerExpiresAt(s, kh)).toBe(T0 + 42 * DAY);
    // A renew that arrives late changes no verdict as of an earlier moment.
    expect(computerExpiresAt(s, kh, T0 + 11 * DAY)).toBe(T0 + 30 * DAY);
  });
  it('an adopter with a new machine id renews after a rebuild, and a revoked old id past its cut does not', () => {
    seqs = {};
    const key = rawKey(); const kh = deviceKeyHashOf(key);
    const rows = [
      machineRow('studio-old', T0, [bind(key)]),
      machineRow('studio-new', T0 + 5 * DAY, [{ type: 'computer-adopt', keyHash: kh, host: 'echo-studio.example.dev' }]),
      machineRow('studio-new', T0 + 25 * DAY, [{ type: 'computer-renew', keyHash: kh, expiresAt: iso(T0 + 55 * DAY) }]),
    ];
    const s = withPerson(rows);
    expect(computerExpiresAt(s, kh)).toBe(T0 + 55 * DAY);
    // The old identity writes a later adopt, but the owner cut its stream: ignored.
    const late = machineRow('studio-old', T0 + 30 * DAY, [{ type: 'computer-adopt', keyHash: kh, host: 'echo-studio.example.dev' }]);
    const s2 = withPerson([...rows, late]);
    s2.goneCuts.push({ machine: 'studio-old', incarnation: 'v1', throughSeq: 1 });
    expect(computerHomeAt(s2, kh)).toBe('studio-new');
  });
  it('renewDue fires once a quarter of the idle window has passed, for idleDays 1 and 30, and never past endsBy', () => {
    seqs = {};
    for (const idleDays of [1, 30]) {
      const key = rawKey(); const kh = deviceKeyHashOf(key);
      const s = withPerson([machineRow('studio', T0, [bind(key, { idleDays, expiresAt: iso(T0 + idleDays * DAY), endsBy: iso(T0 + 90 * DAY) })])]);
      expect(renewDue(s, kh, T0 + 0.1 * idleDays * DAY)?.due).toBe(false);
      expect(renewDue(s, kh, T0 + 0.3 * idleDays * DAY)?.due).toBe(true);
    }
    const key = rawKey(); const kh = deviceKeyHashOf(key);
    const atCap = withPerson([machineRow('studio', T0, [bind(key, { expiresAt: iso(T0 + 90 * DAY) })])]);
    expect(renewDue(atCap, kh, T0 + 80 * DAY)?.due).toBe(false); // nothing would move forward
  });
});

describe('standing and limits', () => {
  it('stands while unexpired and the person is on the team; expiry writes nothing and is judged as of a moment', () => {
    seqs = {};
    const key = rawKey(); const kh = deviceKeyHashOf(key);
    const rows = [machineRow('studio', T0, [bind(key)])];
    const s = withPerson(rows);
    expect(computerStandingIn(s, kh, T0 + DAY)).toMatchObject({ personKey: 'mara', scope: 'documents', home: 'studio' });
    expect(computerStandingIn(s, kh, T0 + 31 * DAY)).toBeNull();
    // An old comment written while it stood still stands as of that moment.
    expect(computerStandingIn(s, kh, T0 + 2 * DAY)).not.toBeNull();
    const gone = foldRows(rows, verify); // nobody on the team
    expect(computerStandingIn(gone, kh, T0 + DAY)).toBeNull();
  });
  it('limits: defaults, newest agent-wide row by signed time across machines with different seq counts, a person row wins, an empty one clears', () => {
    seqs = { laptop: 900 };
    const s = withPerson([
      machineRow('laptop', T0, [{ type: 'computer-limits', maxPerPerson: 4 }]),        // seq 901, older
      machineRow('studio', T0 + DAY, [{ type: 'computer-limits', maxPerPerson: 6 }]),  // seq 1, newer
    ]);
    expect(computerLimitsFor(emptyState(), 'mara')).toEqual(COMPUTER_LIMIT_DEFAULTS);
    expect(computerLimitsFor(s, 'mara').maxPerPerson).toBe(6);
    const own = withPerson([
      machineRow('studio', T0, [{ type: 'computer-limits', maxPerPerson: 6 }]),
      machineRow('studio', T0 + DAY, [{ type: 'computer-limits', personKey: 'mara', maxPerPerson: 9 }]),
    ]);
    expect(computerLimitsFor(own, 'mara').maxPerPerson).toBe(9);
    expect(computerLimitsFor(own, 'sam').maxPerPerson).toBe(6);
    const cleared = withPerson([
      machineRow('studio', T0, [{ type: 'computer-limits', personKey: 'mara', maxPerPerson: 9 }]),
      machineRow('studio', T0 + DAY, [{ type: 'computer-limits', personKey: 'mara' }]),
    ]);
    expect(computerLimitsFor(cleared, 'mara').maxPerPerson).toBe(COMPUTER_LIMIT_DEFAULTS.maxPerPerson);
  });
  it('counts both kinds of computer for the allowance, forgotten ones in the hourly count', () => {
    seqs = {};
    const a = rawKey(); const b = rawKey();
    const s = withPerson([
      machineRow('studio', T0, [bind(a)]),
      machineRow('studio', T0 + 1, [bind(b, { deviceId: 'c2' })]),
      machineRow('studio', T0 + 2, [{ type: 'browser-unbind', keyHash: deviceKeyHashOf(b), deviceId: 'c2' }]),
    ]);
    s.browserLinks.set('phone-linked', { type: 'browser-bind', keyHash: 'phone-linked', deviceId: 'b9', boundTo: 'mara', linkedByDeviceId: 'p', linkedByKeyHash: 'pk', linkedAt: iso(T0 - 2 * 3_600_000), expiresAt: iso(T0 + 30 * DAY), scope: 'documents', signed: { host: 'h', timeMs: '1', sig: 's', bodyB64: 'e30' } });
    expect(computersOf(s, 'mara', T0 + 10)).toEqual({ live: 2, lastHour: 2 });
  });
});

describe('deviceStoodAt for a joined computer (old comments keep verifying)', async () => {
  const { deviceStoodAt } = await import('../../src/documents/originCheck.js');
  it('stood under the prefix; witnessed gone by removal, Forget or its end; refused for a mismatched device', () => {
    seqs = {};
    const key = rawKey(); const kh = deviceKeyHashOf(key);
    const at = withPerson([machineRow('studio', T0, [bind(key)])]);
    at.on = true;
    const d = { keyHash: kh, deviceId: 'c1', personKey: 'mara', client: 'browser' as const };
    const never = () => false;
    // Still standing now, nothing witnesses an end: not a revoked device.
    expect(deviceStoodAt(at, at, d, never, () => false)).toBe(false);
    // Its end passed (expiry writes nothing): it stood, and its old rows still count.
    expect(deviceStoodAt(at, at, d, never, () => true)).toBe(true);
    // Forgotten since.
    const now = withPerson([machineRow('studio', T0, [bind(key)]), machineRow('studio', T0 + 1, [{ type: 'browser-unbind', keyHash: kh, deviceId: 'c1' }])]);
    expect(deviceStoodAt(at, now, d, never, () => false)).toBe(true);
    // Another device id claiming that key never stood.
    expect(deviceStoodAt(at, now, { ...d, deviceId: 'other' }, never, () => true)).toBe(false);
  });
});
