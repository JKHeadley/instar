import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { generateEncryptionKeyPair } from '../../src/core/MachineIdentity.js';
import {
  SecretProvisioner,
  SecretShareHandler,
  buildSecretShareCommand,
  filterSecretsForSync,
  isMachineLocalDropKey,
  type SecretShareCommand,
} from '../../src/core/SecretSync.js';

// Secret Drop values are a one-time hand-off to the machine that asked for them: they are
// never sent to peers, and a peer's push never writes them. An older sender that still
// includes them must not halt the rest of the batch.

function machineKeys() {
  const kp = generateEncryptionKeyPair();
  const encryptionPublicKey = crypto.createPublicKey(kp.publicKey).export({ type: 'spki', format: 'der' }).toString('base64');
  return { encryptionPublicKey, privateKey: crypto.createPrivateKey(kp.privateKey) };
}
const TOK = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const drop = { label: 'k', receivedAt: '2026-11-16T00:00:00.000Z', fields: ['secret'], values: { secret: 'one-time-code' } };

function receive(payload: Record<string, unknown>, vault: Record<string, unknown>) {
  const me = machineKeys();
  const cmd = buildSecretShareCommand(payload as never, { machineId: 'm_me', encryptionPublicKey: me.encryptionPublicKey });
  const writes: string[] = [];
  const h = new SecretShareHandler({ ownEncryptionPrivateKey: () => me.privateKey, store: { set: (k, v) => { writes.push(k); vault[k] = v; } } });
  const res = h.handle(cmd, 'm_old');
  return { res, writes, h };
}

describe('Secret Drop values are machine-local', () => {
  it('matches the root drop namespace only', () => {
    expect(isMachineLocalDropKey('secretDrops')).toBe(true);
    expect(isMachineLocalDropKey(`secretDrops.${TOK}`)).toBe(true);
    expect(isMachineLocalDropKey('secretDropsX')).toBe(false);
    expect(isMachineLocalDropKey('account')).toBe(false);
  });

  it('the sender never includes drops; other secrets still go', async () => {
    expect(filterSecretsForSync({ secretDrops: { [TOK]: drop }, other: 'v' })).toEqual({ other: 'v' });
    const peer = machineKeys();
    let sent: SecretShareCommand | null = null;
    await new SecretProvisioner({
      secretsToSync: () => ({ secretDrops: { [TOK]: drop }, other: 'v' }),
      listPeers: () => [{ machineId: 'm_peer', encryptionPublicKey: peer.encryptionPublicKey }],
      send: async (_id, cmd) => { sent = cmd; return { ok: true }; },
    }).provisionAll();
    const stored: Record<string, unknown> = {};
    new SecretShareHandler({ ownEncryptionPrivateKey: () => peer.privateKey, store: { set: (k, v) => { stored[k] = v; } } }).handle(sent!, 'm_sender');
    expect(stored).toEqual({ other: 'v' });
  });

  it('an older sender\'s drops are stripped and counted; the rest of the batch is stored and local drops are untouched', () => {
    const local = { [TOK]: drop };
    const vault: Record<string, unknown> = { secretDrops: local };
    const { res, writes, h } = receive({ secretDrops: { remotetoken0000000000000000000001: drop }, other: 'v' }, vault);
    expect(res.stored).toEqual(['other']);
    expect(writes).toEqual(['other']);
    expect(vault.secretDrops).toBe(local);
    expect(h.lastDroppedLocalDrops).toBe(1);
  });

  it('every drop form is stripped: dotted top-level key, empty container, scalar', () => {
    for (const payload of [{ [`secretDrops.${TOK}`]: drop }, { secretDrops: {} }, { secretDrops: 'x' }]) {
      const vault: Record<string, unknown> = { secretDrops: { [TOK]: drop } };
      const { writes } = receive(payload, vault);
      expect(writes).toEqual([]); // a payload of only drops writes nothing
      expect((vault.secretDrops as Record<string, unknown>)[TOK]).toEqual(drop);
    }
  });

  it('odd drop key shapes are stripped too: trailing dot, double dot, array value', () => {
    for (const payload of [{ 'secretDrops.': drop }, { 'secretDrops..x': drop }, { secretDrops: [drop] }]) {
      const vault: Record<string, unknown> = { secretDrops: { [TOK]: drop } };
      const { writes } = receive(payload, vault);
      expect(writes).toEqual([]);
      expect((vault.secretDrops as Record<string, unknown>)[TOK]).toEqual(drop);
    }
  });

  it('the sender filter is root-only: a key named secretDrops elsewhere is still sent', () => {
    expect(filterSecretsForSync({ account: { secretDrops: 'v' } })).toEqual({ account: { secretDrops: 'v' } });
  });

  it('a refused namespace still refuses the whole batch, even hidden inside drops', () => {
    expect(() => receive({ secretDrops: { [TOK]: drop }, machineIdentityRecovery: { k: 'x' } }, {})).toThrow(/machine-local/);
    expect(() => receive({ secretDrops: { machineIdentityRecovery: { k: 'x' } } }, {})).toThrow(/machine-local/);
  });

  it('a key named secretDrops under another namespace is ordinary data, not a drop', () => {
    const vault: Record<string, unknown> = {};
    const { writes } = receive({ account: { secretDrops: 'not-a-drop' } }, vault);
    expect(writes).toEqual(['account']);
  });
});
