/**
 * Encrypted secret storage and forward-secret sync protocol.
 *
 * At-rest encryption:
 *   - Master key stored in OS keychain (macOS Keychain, Linux Secret Service)
 *   - File fallback for headless servers (.instar/machine/secrets-master.key, 0600)
 *   - AES-256-GCM encryption of secret store
 *
 * Wire encryption (for sync between machines):
 *   - Ephemeral X25519 ECDH key exchange
 *   - HKDF-SHA256 key derivation
 *   - AES-256-GCM authenticated encryption
 *   - Forward secrecy: ephemeral keys discarded after each transfer
 *
 * Part of Phase 4 (secret sync via tunnel).
 */
import crypto from 'node:crypto';
export interface SecretStoreConfig {
    /** State directory (.instar) */
    stateDir: string;
    /** Force file-based key storage (skip keychain) */
    forceFileKey?: boolean;
}
/** The decrypted secrets object (flat key-value or nested) */
export type Secrets = Record<string, unknown>;
/** Encrypted payload for wire transfer */
export interface EncryptedSecretPayload {
    /** Ephemeral X25519 public key (base64) */
    ephemeralPublicKey: string;
    /** AES-256-GCM initialization vector (base64) */
    iv: string;
    /** Encrypted ciphertext (base64) */
    ciphertext: string;
    /** AES-GCM authentication tag (base64) */
    tag: string;
}
/**
 * Store/retrieve the master key from the OS keychain.
 * Falls back to file-based storage if keychain is unavailable.
 */
export declare class MasterKeyManager {
    private stateDir;
    private forceFile;
    private keyFilePath;
    constructor(stateDir: string, forceFile?: boolean);
    /** Retrieve or generate the master key. */
    getMasterKey(): Buffer;
    /** Whether the master key is stored in the OS keychain (vs file fallback). */
    get isKeychainBacked(): boolean;
    private readKeychain;
    private writeKeychain;
    private readMacKeychain;
    private writeMacKeychain;
    private readLinuxKeychain;
    private writeLinuxKeychain;
    private getFileKey;
}
export declare class SecretStore {
    private stateDir;
    private keyManager;
    private encryptedPath;
    constructor(config: SecretStoreConfig);
    /** Read and decrypt secrets from the encrypted store. Returns empty object if no secrets exist. */
    read(): Secrets;
    /** Encrypt and write secrets to the store. */
    write(secrets: Secrets): void;
    /** Get a specific secret by dot-notation path (e.g., 'telegram.token'). */
    get(keyPath: string): unknown;
    /** Set a specific secret by dot-notation path. */
    set(keyPath: string, value: unknown): void;
    /** Delete a specific secret by dot-notation path. */
    delete(keyPath: string): void;
    /** Whether the secret store file exists. */
    get exists(): boolean;
    /** Whether the master key is in the OS keychain. */
    get isKeychainBacked(): boolean;
    /** Delete the encrypted store file. */
    destroy(): void;
    private encryptAES;
    private decryptAES;
}
/**
 * Encrypt secrets for wire transfer using forward-secret ECDH.
 *
 * Protocol:
 * 1. Generate ephemeral X25519 key pair
 * 2. ECDH: ephemeral private + recipient's long-term public = shared secret
 * 3. HKDF-SHA256 to derive AES-256 key
 * 4. AES-256-GCM encrypt
 * 5. Return: { ephemeralPublicKey, iv, ciphertext, tag }
 *
 * The ephemeral private key is not retained — forward secrecy.
 */
export declare function encryptForSync(secrets: Secrets, recipientPublicKeyBase64: string): EncryptedSecretPayload;
/**
 * Decrypt secrets received via wire transfer.
 *
 * Protocol:
 * 1. ECDH: own private key + sender's ephemeral public = shared secret
 * 2. HKDF-SHA256 to derive AES-256 key
 * 3. AES-256-GCM decrypt
 */
export declare function decryptFromSync(payload: EncryptedSecretPayload, ownPrivateKey: crypto.KeyObject): Secrets;
//# sourceMappingURL=SecretStore.d.ts.map