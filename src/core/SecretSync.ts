/**
 * SecretSync — cross-machine secret distribution (Multi-Machine Session Pool, Phase 4 /
 * `docs/specs/cross-machine-secret-sync-spec.md`, approved).
 *
 * A secret the user gives the agent on one machine should be usable by the same agent on
 * its other machines — without re-entry per machine, and without ever leaving the
 * encrypted vault in plaintext. The transport (mesh) is already TLS + Ed25519-signed +
 * recipient-bound + registered-peer-gated; the remaining requirement is APPLICATION-LAYER
 * confidentiality: each secret is encrypted to the recipient machine's X25519 key, so an
 * intermediary never reads it. That crypto already exists as `encryptForSync` /
 * `decryptFromSync` (forward-secret, ephemeral-key per payload) in SecretStore; this module
 * is the wiring over it.
 *
 * Two flows (judgment call per the spec's open questions, approved by Justin 2026-06-04):
 *   - PUSH-on-provision (primary): when a new secret arrives on machine A, A encrypts the
 *     secret set to each online registered peer's key and sends a `secret-share` command.
 *   - PULL-on-miss (fallback): a machine missing a `{secret:true}` value requests it.
 * v1 syncs ALL secret-marked fields; a rotation overwrites; a dedicated revoke verb is a
 * deliberate follow-up.
 *
 * Pure-ish + dependency-injected: the crypto, the peer list, the send transport, and the
 * store are all injected, so the logic is unit-tested with real keypairs (round-trip) and
 * no live mesh.
 */
import crypto from 'node:crypto';
import { encryptForSync, decryptFromSync, type Secrets, type EncryptedSecretPayload } from './SecretStore.js';

/** The `secret-share` mesh command payload (mirrors the MeshCommand variant). */
export interface SecretShareCommand {
  type: 'secret-share';
  /** JSON-serialized EncryptedSecretPayload (encrypted to the RECIPIENT's key). */
  encrypted: string;
}

export interface SecretSharePeer {
  machineId: string;
  /** Recipient machine's long-term X25519 public key (base64), from its MachineIdentity. */
  encryptionPublicKey: string;
}

/** Build the `secret-share` command for one recipient (encrypts the secret set to them). */
export function buildSecretShareCommand(secrets: Secrets, recipient: SecretSharePeer): SecretShareCommand {
  const payload = encryptForSync(secrets, recipient.encryptionPublicKey);
  return { type: 'secret-share', encrypted: JSON.stringify(payload) };
}

/**
 * Flatten a (possibly nested) secrets map to its leaf dot-notation key-paths — NAMES ONLY,
 * never values. Used by the read-only `/secrets/sync-status` route so a caller can see WHICH
 * secrets a machine holds without the route ever touching a secret value. Mirrors the
 * dot-notation `set`/`get` the vault uses (e.g. `{ telegram: { token: 'x' } }` → `telegram.token`).
 */
export function secretKeyPaths(secrets: Secrets, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(secrets)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...secretKeyPaths(value as Secrets, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

/**
 * The route-facing handle for secret-sync, plumbed through RouteContext. Exposes the
 * push-on-provision lever and read-only status WITHOUT ever exposing a secret value.
 */
export interface SecretSyncHandle {
  /** Whether secret-sync is enabled on this machine (receive path active). */
  enabled: boolean;
  /**
   * Whether OUTBOUND push is enabled. Defaults off: `enabled` alone is RECEIVE-ONLY so a
   * machine with a stale/divergent store can't clobber peers. Set on the authoritative machine.
   */
  pushEnabled: boolean;
  /** Push the current secret set to every online peer (no-op when pushEnabled is false). */
  provisionAll: () => Promise<{ machineId: string; ok: boolean; reason?: string }[]>;
  /** Leaf key-paths of secrets present in this machine's vault — NAMES only, never values. */
  localKeyPaths: () => string[];
  /** Vault readability — distinguishes a genuinely empty vault from a
   *  decrypt-failure (the 2026-06-05 masking: a key-bifurcated vault reported
   *  localKeyPaths: [] as if empty). 'decrypt-failed' carries the precise error. */
  vaultStatus?: () => { status: 'ok' | 'empty' | 'decrypt-failed'; error?: string };
  /** Online registered peers this machine would sync to (machineId + nickname). */
  syncTargets: () => { machineId: string; nickname?: string | null }[];
}

/**
 * Provisioner (sender side). Encrypts the secret set PER-RECIPIENT and pushes it to each
 * online registered peer over the injected mesh transport. Returns a per-peer result; never
 * throws on a single peer's failure (best-effort fan-out).
 */
export class SecretProvisioner {
  constructor(
    private readonly deps: {
      /** The set of secrets to sync (the user-entrusted `{secret:true}` fields). */
      secretsToSync: () => Secrets;
      /** Online, registered peers (excluding self) with their encryption public keys. */
      listPeers: () => SecretSharePeer[];
      /** Send a signed `secret-share` command to a peer over the mesh. */
      send: (machineId: string, command: SecretShareCommand) => Promise<{ ok: boolean; reason?: string }>;
      log?: (msg: string) => void;
    },
  ) {}

  /** Push the current secret set to every online peer. */
  async provisionAll(): Promise<{ machineId: string; ok: boolean; reason?: string }[]> {
    const secrets = this.deps.secretsToSync();
    const peers = this.deps.listPeers();
    if (Object.keys(secrets).length === 0 || peers.length === 0) return [];
    const out: { machineId: string; ok: boolean; reason?: string }[] = [];
    for (const peer of peers) {
      try {
        const cmd = buildSecretShareCommand(secrets, peer);
        const r = await this.deps.send(peer.machineId, cmd);
        out.push({ machineId: peer.machineId, ok: r.ok, reason: r.reason });
        if (r.ok) this.deps.log?.(`[secret-sync] pushed ${Object.keys(secrets).length} secret(s) to ${peer.machineId}`);
      } catch (err) {
        out.push({ machineId: peer.machineId, ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }
}

/**
 * Handler (receiver side). Decrypts an inbound `secret-share` with THIS machine's private
 * key and writes each secret into the local vault. The sender's authenticity + the
 * registered-peer gate are already enforced by the mesh acceptance layer BEFORE this runs;
 * confidentiality is enforced here (decryption fails for a payload not sealed to our key).
 */
export class SecretShareHandler {
  constructor(
    private readonly deps: {
      /** This machine's X25519 private key (KeyObject) for decryption. */
      ownEncryptionPrivateKey: () => crypto.KeyObject;
      /** Persist a secret into the local encrypted vault. */
      store: { set: (keyPath: string, value: unknown) => void };
      log?: (msg: string) => void;
    },
  ) {}

  /** Decrypt + store. Returns the keyPaths stored. Throws only on a malformed/foreign payload. */
  handle(command: SecretShareCommand, sender: string): { stored: string[] } {
    // The legacy permissive path must be structurally unreachable for credential-class data
    // (WS5.2 R3a / §6.5): a credential rides the distinct `account-credential-share` verb +
    // `decryptAccountCredential`, never this one. Reject anything that is not a secret-share.
    if (!command || command.type !== 'secret-share') {
      throw new Error(`SecretShareHandler refuses non-secret-share command (got "${command?.type}") — credential-class data must use account-credential-share`);
    }
    const payload = JSON.parse(command.encrypted) as EncryptedSecretPayload;
    const secrets = decryptFromSync(payload, this.deps.ownEncryptionPrivateKey());
    const stored: string[] = [];
    for (const [keyPath, value] of Object.entries(secrets)) {
      this.deps.store.set(keyPath, value);
      stored.push(keyPath);
    }
    this.deps.log?.(`[secret-sync] stored ${stored.length} secret(s) from ${sender}`);
    return { stored };
  }
}
