import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { generateEncryptionKeyPair } from '../../src/core/MachineIdentity.js';
import {
  SecretProvisioner,
  SecretShareHandler,
  buildSecretShareCommand,
  filterSecretsForSync,
  isLegacyPasskeyPath,
  type SecretShareCommand,
} from '../../src/core/SecretSync.js';

// Spec agent-held-google-passkey §6 Increment 1: prototype Google passkeys
// (`google_passkey_*`, single top-level vault keys) must never travel between
// machines, and an old-build sender that still pushes them must not halt the
// rest of the sync batch on a new-build receiver.

function machineKeys() {
  const kp = generateEncryptionKeyPair();
  const encryptionPublicKey = crypto.createPublicKey(kp.publicKey).export({ type: 'spki', format: 'der' }).toString('base64');
  return { encryptionPublicKey, privateKey: crypto.createPrivateKey(kp.privateKey) };
}

describe('isLegacyPasskeyPath', () => {
  it('matches prototype passkey keys on the first segment only', () => {
    expect(isLegacyPasskeyPath('google_passkey_echo_studio')).toBe(true);
    expect(isLegacyPasskeyPath('google_passkey_amrch')).toBe(true);
    expect(isLegacyPasskeyPath('google_passkey_headley_shared')).toBe(true);
  });
  it('does not match look-alike or nested keys', () => {
    expect(isLegacyPasskeyPath('google_password_echo')).toBe(false);
    expect(isLegacyPasskeyPath('google_backup_codes_dawn')).toBe(false);
    expect(isLegacyPasskeyPath('integrations.google_passkey_x')).toBe(false);
    expect(isLegacyPasskeyPath('telegram.token')).toBe(false);
  });
});

describe('sender side — filterSecretsForSync drops prototype passkeys', () => {
  it('removes google_passkey_* keys and keeps everything else', () => {
    const out = filterSecretsForSync({
      google_passkey_echo_studio: '{"privateKey":"x"}',
      google_passkey_amrch: '{"privateKey":"y"}',
      google_password_echo: 'pw',
      telegram: { token: 't' },
    });
    expect(out).toEqual({ google_password_echo: 'pw', telegram: { token: 't' } });
  });

  it('the provisioner never encrypts a prototype passkey into the payload', async () => {
    const peer = machineKeys();
    let sent: SecretShareCommand | null = null;
    const prov = new SecretProvisioner({
      secretsToSync: () => ({ google_passkey_echo_studio: 'secret-key', other: 'v' }),
      listPeers: () => [{ machineId: 'm_peer', encryptionPublicKey: peer.encryptionPublicKey }],
      send: async (_id, cmd) => { sent = cmd; return { ok: true }; },
    });
    await prov.provisionAll();
    const stored: Record<string, unknown> = {};
    new SecretShareHandler({ ownEncryptionPrivateKey: () => peer.privateKey, store: { set: (k, v) => { stored[k] = v; } } })
      .handle(sent!, 'm_sender');
    expect(stored).toEqual({ other: 'v' });
  });

  it('sends nothing when the only secrets are prototype passkeys', async () => {
    const peer = machineKeys();
    let sends = 0;
    const prov = new SecretProvisioner({
      secretsToSync: () => ({ google_passkey_echo_studio: 'k' }),
      listPeers: () => [{ machineId: 'm_peer', encryptionPublicKey: peer.encryptionPublicKey }],
      send: async () => { sends++; return { ok: true }; },
    });
    expect(await prov.provisionAll()).toEqual([]);
    expect(sends).toBe(0);
  });
});

describe('receiver side — old-build sender pushing prototype passkeys (mixed-version fleet)', () => {
  it('drops and reports the passkey keys but stores the rest of the batch', () => {
    const me = machineKeys();
    // An old-build sender does not filter: build the raw command directly.
    const cmd = buildSecretShareCommand(
      { google_passkey_echo_studio: 'leaked', telegram_token: 'bot-1', google_passkey_amrch: 'leaked2' },
      { machineId: 'm_me', encryptionPublicKey: me.encryptionPublicKey },
    );
    const stored: Record<string, unknown> = {};
    const logs: string[] = [];
    const res = new SecretShareHandler({
      ownEncryptionPrivateKey: () => me.privateKey,
      store: { set: (k, v) => { stored[k] = v; } },
      log: (m) => logs.push(m),
    }).handle(cmd, 'm_old');
    expect(stored).toEqual({ telegram_token: 'bot-1' });
    expect(res.stored).toEqual(['telegram_token']);
    expect(res.dropped.sort()).toEqual(['google_passkey_amrch', 'google_passkey_echo_studio']);
    expect(logs.some((l) => l.includes('dropped 2 prototype passkey key(s)'))).toBe(true);
    // The audit line names keys, never values.
    expect(logs.join('\n')).not.toContain('leaked');
  });

  it('never deletes a prototype passkey the receiver already holds', () => {
    const me = machineKeys();
    const vault: Record<string, unknown> = { google_passkey_echo_studio: 'local-copy' };
    const cmd = buildSecretShareCommand({ google_passkey_echo_studio: 'incoming' }, { machineId: 'm_me', encryptionPublicKey: me.encryptionPublicKey });
    new SecretShareHandler({ ownEncryptionPrivateKey: () => me.privateKey, store: { set: (k, v) => { vault[k] = v; } } }).handle(cmd, 'm_old');
    expect(vault).toEqual({ google_passkey_echo_studio: 'local-copy' });
  });

  it('still rejects the whole batch for the machine-local recovery namespace', () => {
    const me = machineKeys();
    const cmd = buildSecretShareCommand(
      { machineIdentityRecovery: { key: 'x' }, other: 'v' },
      { machineId: 'm_me', encryptionPublicKey: me.encryptionPublicKey },
    );
    expect(() => new SecretShareHandler({ ownEncryptionPrivateKey: () => me.privateKey, store: { set: () => {} } }).handle(cmd, 'm_old'))
      .toThrow(/machine-local secret namespace/);
  });
});
