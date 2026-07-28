import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { generateEncryptionKeyPair } from '../../src/core/MachineIdentity.js';
import { SecretProvisioner, SecretShareHandler, buildSecretShareCommand, secretKeyPaths, type SecretSharePeer, type SecretShareCommand } from '../../src/core/SecretSync.js';

/** A machine's X25519 identity for the test: base64 public key + private KeyObject. */
function machineKeys() {
  const kp = generateEncryptionKeyPair();
  const encryptionPublicKey = crypto.createPublicKey(kp.publicKey).export({ type: 'spki', format: 'der' }).toString('base64');
  const privateKey = crypto.createPrivateKey(kp.privateKey);
  return { encryptionPublicKey, privateKey };
}

describe('SecretSync — provisioner + handler round-trip', () => {
  it('encrypts to the recipient, ships, decrypts, and stores every secret', async () => {
    const recipient = machineKeys();
    const secrets = { 'messaging.0.config.token': 'bot-abc-123', 'integrations.openai': 'sk-xyz' };

    // Provisioner: secrets → encrypt to recipient → "send" captures the command.
    let sentTo: string | null = null;
    let sentCmd: SecretShareCommand | null = null;
    const provisioner = new SecretProvisioner({
      secretsToSync: () => secrets,
      listPeers: (): SecretSharePeer[] => [{ machineId: 'm_peer', encryptionPublicKey: recipient.encryptionPublicKey }],
      send: async (machineId, command) => { sentTo = machineId; sentCmd = command; return { ok: true }; },
    });
    const results = await provisioner.provisionAll();
    expect(results).toEqual([{ machineId: 'm_peer', ok: true, reason: undefined }]);
    expect(sentTo).toBe('m_peer');
    expect(sentCmd!.type).toBe('secret-share');

    // Handler (on the recipient): decrypt with its private key → store.
    const stored: Record<string, unknown> = {};
    const handler = new SecretShareHandler({
      ownEncryptionPrivateKey: () => recipient.privateKey,
      store: { set: (k, v) => { stored[k] = v; } },
    });
    const res = handler.handle(sentCmd!, 'm_sender');
    expect(res.stored.sort()).toEqual(['integrations.openai', 'messaging.0.config.token']);
    expect(stored).toEqual(secrets); // values decrypted intact
  });

  // CONFIDENTIALITY: a payload sealed to machine A must NOT be decryptable by machine B.
  it('rejects a payload sealed to a DIFFERENT machine (wrong key fails to decrypt)', () => {
    const intended = machineKeys();
    const attacker = machineKeys();
    const cmd = buildSecretShareCommand({ 'k': 'v' }, { machineId: 'm_a', encryptionPublicKey: intended.encryptionPublicKey });
    const handler = new SecretShareHandler({
      ownEncryptionPrivateKey: () => attacker.privateKey, // wrong key
      store: { set: () => {} },
    });
    expect(() => handler.handle(cmd, 'm_sender')).toThrow(); // GCM auth fails
  });

  it('provisions to every online peer, each sealed to its own key', async () => {
    const a = machineKeys();
    const b = machineKeys();
    const secrets = { 'tok': 'shared-secret' };
    const captured: { machineId: string; cmd: SecretShareCommand }[] = [];
    const provisioner = new SecretProvisioner({
      secretsToSync: () => secrets,
      listPeers: () => [
        { machineId: 'm_a', encryptionPublicKey: a.encryptionPublicKey },
        { machineId: 'm_b', encryptionPublicKey: b.encryptionPublicKey },
      ],
      send: async (machineId, command) => { captured.push({ machineId, cmd: command }); return { ok: true }; },
    });
    await provisioner.provisionAll();
    expect(captured.map((c) => c.machineId).sort()).toEqual(['m_a', 'm_b']);
    // Each peer decrypts ITS OWN payload (and only its own).
    const ha = new SecretShareHandler({ ownEncryptionPrivateKey: () => a.privateKey, store: { set: () => {} } });
    const hb = new SecretShareHandler({ ownEncryptionPrivateKey: () => b.privateKey, store: { set: () => {} } });
    const toA = captured.find((c) => c.machineId === 'm_a')!.cmd;
    const toB = captured.find((c) => c.machineId === 'm_b')!.cmd;
    expect(ha.handle(toA, 's').stored).toEqual(['tok']);
    expect(hb.handle(toB, 's').stored).toEqual(['tok']);
    expect(() => ha.handle(toB, 's')).toThrow(); // A can't open B's payload
  });

  it('no-ops cleanly with no secrets or no peers', async () => {
    const p1 = new SecretProvisioner({ secretsToSync: () => ({}), listPeers: () => [{ machineId: 'x', encryptionPublicKey: machineKeys().encryptionPublicKey }], send: async () => ({ ok: true }) });
    expect(await p1.provisionAll()).toEqual([]);
    const p2 = new SecretProvisioner({ secretsToSync: () => ({ k: 'v' }), listPeers: () => [], send: async () => ({ ok: true }) });
    expect(await p2.provisionAll()).toEqual([]);
  });

  it('one peer failing does not abort the fan-out to the others (best-effort)', async () => {
    const ok = machineKeys();
    const provisioner = new SecretProvisioner({
      secretsToSync: () => ({ tok: 'v' }),
      listPeers: () => [
        { machineId: 'm_bad', encryptionPublicKey: ok.encryptionPublicKey },
        { machineId: 'm_good', encryptionPublicKey: ok.encryptionPublicKey },
      ],
      send: async (machineId) => {
        if (machineId === 'm_bad') throw new Error('network down');
        return { ok: true };
      },
    });
    const results = await provisioner.provisionAll();
    expect(results.find((r) => r.machineId === 'm_bad')).toMatchObject({ ok: false, reason: 'network down' });
    expect(results.find((r) => r.machineId === 'm_good')).toMatchObject({ ok: true });
  });
});

describe('SecretSync — secretKeyPaths (names-only, for /secrets/sync-status)', () => {
  it('flattens a nested secrets map to leaf dot-paths, never exposing values', () => {
    const paths = secretKeyPaths({
      telegram: { token: 'SUPER-SECRET' },
      github: 'ghp_xxx',
      nested: { a: { b: 'v' } },
    });
    expect(paths.sort()).toEqual(['github', 'nested.a.b', 'telegram.token']);
    // The function returns NAMES only — no value ever appears in its output.
    expect(JSON.stringify(paths)).not.toContain('SUPER-SECRET');
    expect(JSON.stringify(paths)).not.toContain('ghp_xxx');
  });

  it('returns [] for an empty secrets map', () => {
    expect(secretKeyPaths({})).toEqual([]);
  });

  it('treats an array value as a leaf (not a sub-tree to flatten)', () => {
    expect(secretKeyPaths({ scopes: ['a', 'b'] })).toEqual(['scopes']);
  });
});
