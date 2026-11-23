/**
 * SEC-169: the public way-back list (member-browser-any-computer §3.6) names only addresses where a
 * computer is set up and still counts. Before the fix it listed every pool machine's document address to
 * any anonymous caller, and each machine keeps its own PIN guess budget, so the list multiplied how fast a
 * stranger could guess the dashboard PIN (SEC-150). Both sides of every rule over the real team-log fold.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deviceKeyHashOf, sha256Hex } from '../../src/core/AppRecordSignatures.js';
import { foldRows, rowPayload, type MachineRow, type TeamAccessRow } from '../../src/core/TeamAccessLog.js';
import { computerHomeHosts } from '../../src/core/TeamComputers.js';

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
let seq = 0;
function machineRow(atMs: number, events: unknown[]): MachineRow {
  seq++;
  const rest = { seq, kind: 'machine' as const, at: iso(atMs), events: events as MachineRow['events'], origin: 'm_studio', incarnation: 'v1', prev: null, seen: {} };
  return { ...rest, machineSig: { machineId: 'm_studio', signerKeyHash: 'm_studio-k', sig: sha256Hex(rowPayload(rest)) } };
}
function stateOf(rows: TeamAccessRow[], people = ['mara']) {
  const s = foldRows(rows, verify);
  for (const p of people) s.people.set(p, { personKey: p, name: p, role: 'member', links: {} });
  return s;
}
function bind(key: string, host: string, over: Record<string, unknown> = {}) {
  return {
    type: 'computer-bind', keyHash: deviceKeyHashOf(key), deviceId: `c-${host}`, boundTo: 'mara', host, browserPublicKey: key,
    linkedAt: iso(T0), expiresAt: iso(T0 + 30 * DAY), idleDays: 30, endsBy: iso(T0 + 90 * DAY), scope: 'documents', ...over,
  };
}
function phoneLink(keyHash: string, browserHost: unknown, phoneHost: string, over: Record<string, unknown> = {}) {
  const bodyB64 = Buffer.from(JSON.stringify({ host: browserHost, nonce: 'n1', machineId: 'm_studio' })).toString('base64url');
  return {
    type: 'browser-bind', keyHash, deviceId: `b-${keyHash}`, boundTo: 'mara', linkedByDeviceId: 'p1', linkedByKeyHash: 'pk',
    linkedAt: iso(T0), expiresAt: iso(T0 + 30 * DAY), scope: 'documents',
    signed: { host: phoneHost, timeMs: String(T0), sig: 's', bodyB64 }, ...over,
  };
}

describe('computerHomeHosts (SEC-169)', () => {
  it('no computers: no address at all', () => {
    expect([...computerHomeHosts(stateOf([]), T0 + DAY)]).toEqual([]);
  });

  it('a standing joined computer names its own host, lowercased; another machine with no computer is not named', () => {
    const s = stateOf([machineRow(T0, [bind(rawKey(), 'Echo-Studio.example.dev')])]);
    expect([...computerHomeHosts(s, T0 + DAY)]).toEqual(['echo-studio.example.dev']);
  });

  it('an ended joined computer (past its end, or its person off the team) is no way back', () => {
    const s = stateOf([machineRow(T0, [bind(rawKey(), 'echo-studio.example.dev')])]);
    expect([...computerHomeHosts(s, T0 + 31 * DAY)]).toEqual([]);
    const gone = stateOf([machineRow(T0, [bind(rawKey(), 'echo-studio.example.dev')])], []);
    expect([...computerHomeHosts(gone, T0 + DAY)]).toEqual([]);
  });

  it('a live phone-linked computer names the computer\'s own host from the signed body, not the phone\'s', () => {
    const s = stateOf([machineRow(T0, [phoneLink('kh1', 'echo-laptop.example.dev', 'echo-studio.example.dev')])]);
    expect([...computerHomeHosts(s, T0 + DAY)]).toEqual(['echo-laptop.example.dev']);
  });

  it('a phone-linked computer that expired, was unbound, or has an unreadable body names nothing', () => {
    const expired = stateOf([machineRow(T0, [phoneLink('kh1', 'echo-laptop.example.dev', 'x.example.dev')])]);
    expect([...computerHomeHosts(expired, T0 + 31 * DAY)]).toEqual([]);
    const unbound = stateOf([machineRow(T0, [phoneLink('kh1', 'echo-laptop.example.dev', 'x.example.dev')]), machineRow(T0 + 1000, [{ type: 'browser-unbind', keyHash: 'kh1', deviceId: 'b-kh1' }])]);
    expect([...computerHomeHosts(unbound, T0 + DAY)]).toEqual([]);
    const s = stateOf([]);
    s.browserLinks.set('kh2', { ...(phoneLink('kh2', 'ok.example.dev', 'x') as never), signed: { host: 'x', timeMs: '1', sig: 's', bodyB64: 'not json' } });
    s.browserLinks.set('kh3', phoneLink('kh3', 'bad host/with/path', 'x') as never);
    s.browserLinks.set('kh4', phoneLink('kh4', 42, 'x') as never);
    expect([...computerHomeHosts(s, T0 + DAY)]).toEqual([]);
  });
});
