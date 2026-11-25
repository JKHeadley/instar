import { expect, it } from 'vitest';
import { HostedRelayRendezvous } from '../../src/hostedRelay/rendezvous.js';

const hostname = 'agent.relay.example';
const assignment = '1'.repeat(64);

function fixture() {
  let now = 0;
  let current: string | undefined = assignment;
  const store = new HostedRelayRendezvous(name => name === hostname ? current : undefined, () => now);
  return { store, time: (value: number) => { now = value; }, assign: (value: string | undefined) => { current = value; } };
}

it('returns only the name once for the exact live assignment', () => {
  const { store } = fixture();
  expect(store.issue(hostname, '2'.repeat(64))).toBeUndefined();
  expect(store.issue('different.relay.example', assignment)).toBeUndefined();
  const issued = store.issue('Agent.Relay.Example', assignment)!;
  expect(issued).toEqual({ code: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/), expiresInSeconds: 600 });
  expect(store.redeem('192.0.2.4', issued.code)).toEqual({ hostname });
  expect(store.redeem('192.0.2.5', issued.code)).toBeUndefined();
});

it('refuses a code at ten minutes and burns a code for a replaced assignment', () => {
  const { store, time, assign } = fixture();
  const expired = store.issue(hostname, assignment)!;
  time(600_000);
  expect(store.redeem('192.0.2.4', expired.code)).toBeUndefined();
  const invalid = store.issue(hostname, assignment)!;
  assign('2'.repeat(64));
  expect(store.redeem('192.0.2.4', invalid.code)).toBeUndefined();
  assign(assignment);
  expect(store.redeem('192.0.2.4', invalid.code)).toBeUndefined();
});

it('counts invalid attempts, shares a bucket across IPv4 and mapped IPv6 and recovers after the window', () => {
  const { store, time } = fixture();
  const { code } = store.issue(hostname, assignment)!;
  for (let i = 0; i < 10; i++) expect(store.redeem('192.0.2.4', 'bogus')).toBeUndefined();
  expect(store.redeem('::ffff:192.0.2.4', code)).toBeUndefined();
  expect(store.redeem('::ffff:c000:204', code)).toBeUndefined();
  expect(store.redeem('untrusted-header', code)).toBeUndefined();
  time(60_000);
  expect(store.redeem('::ffff:c000:204', code)).toEqual({ hostname });
});

it('limits pending codes and frees expired capacity', () => {
  const { store, time } = fixture();
  for (let i = 0; i < 1024; i++) expect(store.issue(hostname, assignment)).toBeDefined();
  expect(store.issue(hostname, assignment)).toBeUndefined();
  time(600_000);
  expect(store.issue(hostname, assignment)).toBeDefined();
});

it('bounds the peer inventory without evicting a live throttle', () => {
  const { store, time } = fixture();
  const { code } = store.issue(hostname, assignment)!;
  for (let n = 0; n < 4096; n++) store.redeem('2001:db8::' + (n + 1).toString(16), 'wrong');
  expect(store.redeem('198.51.100.5', code)).toBeUndefined();
  expect(store.redeem('2001:0db8:0:0:0:0:0:1', code)).toEqual({ hostname });
  const next = store.issue(hostname, assignment)!;
  time(60_000);
  expect(store.redeem('198.51.100.5', next.code)).toEqual({ hostname });
});
