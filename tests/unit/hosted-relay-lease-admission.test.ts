import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { HostedRelayLeaseAdmission, hostedRelayLeaseMessage, type HostedRelayLease } from '../../src/hostedRelay/leaseAdmission.js';

const keys = [generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519')];
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const original: HostedRelayLease = {
  hostname: 'agent.relay.example', assignment: '1'.repeat(64), holder: 'machine-one', epoch: 1, expiresAt: 60_000,
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lease-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'relay lease fixture cleanup' }));
  let current: HostedRelayLease | undefined = original, keyIndex = 0, now = 1000;
  function connect() {
    const db = new Database(path.join(root, 'relay.sqlite'));
    db.pragma('synchronous = FULL');
    cleanups.push(() => { if (db.open) db.close(); });
    const gate = new HostedRelayLeaseAdmission(db, name => current?.hostname === name
      ? { ...current, publicKeyPem: keys[keyIndex].publicKey.export({ format: 'pem', type: 'spki' }).toString() } : undefined, () => now, () => now);
    return { db, gate };
  }
  function signed(lease: HostedRelayLease, challenge: string, key = keyIndex) {
    return { ...lease, challenge, signature: sign(null, Buffer.from(hostedRelayLeaseMessage(lease, challenge)), keys[key].privateKey).toString('base64') };
  }
  return { ...connect(), connect, signed, time: (t: number) => { now = t; },
    publish: (value: HostedRelayLease | undefined, key = 0) => { current = value; keyIndex = key; } };
}

it('binds holder, assignment, hostname, expiry and current key to a single socket challenge', () => {
  const f = fixture();
  const first = f.gate.challenge(), next = f.gate.challenge();
  const claim = f.signed(original, first.nonce);
  expect(f.gate.admit(claim, { ...first })).toBeUndefined();
  expect(f.gate.admit(claim, next)).toBeUndefined();
  const accepted = f.gate.admit(claim, first)!;
  expect(accepted.connection).toMatchObject(original);
  expect(f.gate.admit(claim, first)).toBeUndefined();
  expect(f.gate.canServe(accepted.connection)).toBe(true);
  expect(f.gate.canServe({ ...accepted.connection, expiresAt: 90_000 })).toBe(false);
  f.publish(original, 1);
  expect(f.gate.canServe(accepted.connection)).toBe(false);
  const fresh = f.gate.challenge();
  expect(f.gate.admit(f.signed(original, fresh.nonce, 0), fresh)).toBeUndefined();
});

it('fences an earlier connection after reconnect and retains the durable high epoch across restart', () => {
  const f = fixture();
  const first = f.gate.challenge();
  const a = f.gate.admit(f.signed(original, first.nonce), first)!;
  const peer = f.connect();
  const second = peer.gate.challenge();
  const b = peer.gate.admit(f.signed(original, second.nonce), second)!;
  expect(b.displacedConnectionId).toBe(a.connection.connectionId);
  expect(f.gate.canServe(a.connection)).toBe(false);
  expect(peer.gate.canServe(b.connection)).toBe(true);

  const takeover = { ...original, epoch: 2, holder: 'machine-two' };
  f.publish(takeover, 1);
  const third = f.gate.challenge();
  const c = f.gate.admit(f.signed(takeover, third.nonce), third)!;
  expect(c.displacedConnectionId).toBe(b.connection.connectionId);
  f.db.close(); peer.db.close();

  const after = f.connect();
  expect(after.gate.canServe(c.connection)).toBe(false);
  for (const obsolete of [original, { ...original, epoch: 2 }, { ...takeover, assignment: '2'.repeat(64) }]) {
    f.publish(obsolete);
    const challenge = after.gate.challenge();
    expect(after.gate.admit(f.signed(obsolete, challenge.nonce), challenge)).toBeUndefined();
  }
  f.publish(takeover, 1);
  const fourth = after.gate.challenge();
  const restored = after.gate.admit(f.signed(takeover, fourth.nonce), fourth)!;
  expect(restored.displacedConnectionId).toBe(c.connection.connectionId);
  expect(after.gate.canServe(restored.connection)).toBe(true);
});

it('rejects missing, stale and overextended evidence', () => {
  const f = fixture();
  for (const requested of [{ ...original, expiresAt: 60_001 }, { ...original, hostname: 'other.relay.example' }, { ...original, epoch: 2 }]) {
    const challenge = f.gate.challenge();
    expect(f.gate.admit(f.signed(requested, challenge.nonce), challenge)).toBeUndefined();
  }
  const expired = f.gate.challenge();
  f.time(31_000);
  expect(f.gate.admit(f.signed(original, expired.nonce), expired)).toBeUndefined();
  const late = f.gate.challenge();
  f.time(60_000);
  expect(f.gate.admit(f.signed(original, late.nonce), late)).toBeUndefined();
});
