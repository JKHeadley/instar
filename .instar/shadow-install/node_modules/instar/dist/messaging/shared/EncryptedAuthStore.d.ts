/**
 * EncryptedAuthStore — encrypts Baileys auth state at rest.
 *
 * Wraps Baileys' useMultiFileAuthState with AES-256-GCM encryption.
 * Auth credentials contain session keys that grant full access to
 * the linked WhatsApp account — they MUST be encrypted at rest.
 *
 * The encryption key is derived from a user-provided passphrase
 * using PBKDF2 (100k iterations, SHA-512).
 */
export interface EncryptedAuthStoreOptions {
    /** Directory to store encrypted auth files */
    authDir: string;
    /** Passphrase for key derivation. If not provided, files are stored unencrypted (backward-compatible). */
    passphrase?: string;
}
/**
 * Encrypt data with AES-256-GCM.
 * Format: HEADER(13) + SALT(32) + IV(16) + AUTH_TAG(16) + CIPHERTEXT(variable)
 */
export declare function encryptData(data: Buffer, passphrase: string): Buffer;
/**
 * Decrypt data encrypted with encryptData.
 */
export declare function decryptData(data: Buffer, passphrase: string): Buffer;
/**
 * Check if a file is encrypted (has our header).
 */
export declare function isEncryptedFile(filePath: string): boolean;
/**
 * Read a file, decrypting if encrypted.
 * If no passphrase provided, reads as plain text (backward-compatible).
 */
export declare function readAuthFile(filePath: string, passphrase?: string): string;
/**
 * Write a file, encrypting if passphrase is provided.
 * Uses atomic write (write-to-tmp then rename) to prevent corruption.
 */
export declare function writeAuthFile(filePath: string, content: string, passphrase?: string): void;
/**
 * Create a Baileys-compatible auth state that encrypts credentials at rest.
 * Drop-in replacement for useMultiFileAuthState from Baileys.
 *
 * When passphrase is provided: files are encrypted with AES-256-GCM.
 * When passphrase is absent: files are stored in plain text (backward-compatible).
 */
export declare function useEncryptedAuthState(authDir: string, passphrase?: string): Promise<{
    state: any;
    saveCreds: () => Promise<void>;
}>;
//# sourceMappingURL=EncryptedAuthStore.d.ts.map