/**
 * Pairing protocol for multi-machine coordination.
 *
 * Handles the secure pairing flow:
 * 1. Pairing code generation (WORD-WORD-NNNN)
 * 2. Key exchange (ephemeral X25519 ECDH, code-bound via HKDF)
 * 3. Short Authentication String (SAS) derivation
 * 4. Encrypted secret transfer (XChaCha20-Poly1305)
 *
 * Security properties:
 * - Online brute-force: 3-attempt rate limit + 2-minute expiry
 * - MITM: SAS verification (24-bit, 6 symbols)
 * - Forward secrecy: ephemeral keys per pairing session
 * - Offline brute-force: rate limiting + SAS prevents practical exploitation
 *   (SPAKE2 can be substituted via PairingKeyExchange interface for paranoid mode)
 *
 * Phase 2 of the multi-machine spec.
 */
import crypto from 'node:crypto';
// ── Pairing Code ─────────────────────────────────────────────────────
/**
 * 256 common, easy-to-pronounce English nouns.
 * Chosen for: no homophones, no ambiguity, no offensive words,
 * easy to say aloud, easy to type.
 */
const WORDLIST = [
    'APPLE', 'ARROW', 'BADGE', 'BAKER', 'BEACH', 'BELL', 'BIRD', 'BLADE',
    'BLOOM', 'BOARD', 'BONE', 'BOOK', 'BRAIN', 'BREAD', 'BRICK', 'BRIDGE',
    'BROOK', 'BRUSH', 'CABIN', 'CAKE', 'CAMP', 'CANDLE', 'CAPE', 'CARD',
    'CASTLE', 'CEDAR', 'CHAIN', 'CHALK', 'CHEST', 'CHIEF', 'CHILD', 'CLAW',
    'CLIFF', 'CLOCK', 'CLOUD', 'COBRA', 'CORAL', 'CRANE', 'CREEK', 'CROWN',
    'DANCE', 'DAWN', 'DEER', 'DELTA', 'DEPTH', 'DIVER', 'DOCK', 'DOVE',
    'DRAFT', 'DREAM', 'DRIFT', 'DRUM', 'EAGLE', 'EARTH', 'ELDER', 'ELM',
    'EMBER', 'FABLE', 'FALCON', 'FARM', 'FEAST', 'FIELD', 'FINCH', 'FLAME',
    'FLASK', 'FLINT', 'FLOOD', 'FLUTE', 'FORGE', 'FROST', 'FRUIT', 'GATE',
    'GHOST', 'GLASS', 'GLOBE', 'GOAT', 'GRAIN', 'GRAPE', 'GRASS', 'GROVE',
    'GUARD', 'GUILD', 'GULL', 'HAVEN', 'HAWK', 'HEART', 'HEDGE', 'HERON',
    'HILL', 'HIVE', 'HOLLY', 'HORN', 'HORSE', 'HOUSE', 'IVORY', 'JADE',
    'JEWEL', 'JUDGE', 'KAYAK', 'KELP', 'KING', 'KITE', 'KNOT', 'LAKE',
    'LANCE', 'LARK', 'LATCH', 'LEAF', 'LEVER', 'LIGHT', 'LILY', 'LION',
    'LOFT', 'LOTUS', 'LUNAR', 'MAPLE', 'MARSH', 'MASON', 'MAST', 'MEDAL',
    'MESA', 'MILL', 'MINT', 'MOAT', 'MOLE', 'MOON', 'MOSS', 'MOTH',
    'MOUND', 'NAIL', 'NEST', 'NOBLE', 'NORTH', 'NURSE', 'OAK', 'OCEAN',
    'OLIVE', 'ORBIT', 'OTTER', 'OWL', 'PALM', 'PATCH', 'PATH', 'PEARL',
    'PEAK', 'PETAL', 'PILOT', 'PINE', 'PLAIN', 'PLANT', 'PLUM', 'POND',
    'PORCH', 'PRESS', 'PRISM', 'PULSE', 'QUAIL', 'QUARTZ', 'QUEEN', 'QUEST',
    'RAVEN', 'REALM', 'REED', 'REEF', 'RIDGE', 'RING', 'RIVER', 'ROBIN',
    'ROCK', 'ROPE', 'ROSE', 'RUBY', 'SAGE', 'SAND', 'SCOUT', 'SEAL',
    'SHADE', 'SHELL', 'SHIELD', 'SHORE', 'SILK', 'SKULL', 'SLATE', 'SLOPE',
    'SNAKE', 'SOLAR', 'SPARK', 'SPEAR', 'SPINE', 'SPOKE', 'SPRAY', 'SPRING',
    'STAFF', 'STAMP', 'STAR', 'STEEL', 'STEM', 'STONE', 'STORM', 'STOVE',
    'SURGE', 'SWAN', 'SWORD', 'TABLE', 'THORN', 'TIDE', 'TIGER', 'TORCH',
    'TOWER', 'TRAIL', 'TREE', 'TRIBE', 'TROUT', 'TRUNK', 'TULIP', 'VALE',
    'VAULT', 'VEIL', 'VINE', 'VIOLA', 'VIPER', 'VOICE', 'WAGON', 'WALNUT',
    'WATCH', 'WATER', 'WAVE', 'WHEAT', 'WHEEL', 'WIND', 'WING', 'WOLF',
    'WOOD', 'WREN', 'YACHT', 'YARN', 'YOKE', 'ZEBRA', 'ZENITH', 'ZINC',
    'BLAZE', 'CANYON', 'CREST', 'DUSK', 'FLARE', 'GLEN', 'HARBOR', 'IRIS',
    'JADE', 'LANTERN', 'MEADOW', 'OPAL', 'PIXEL', 'QUILL', 'SABER', 'TALON',
];
/**
 * Generate a pairing code: WORD-WORD-NNNN
 * ~29.3 bits of entropy (256 * 256 * 10000 = 655,360,000 combinations).
 */
export function generatePairingCode() {
    const word1 = WORDLIST[crypto.randomInt(WORDLIST.length)];
    const word2 = WORDLIST[crypto.randomInt(WORDLIST.length)];
    const digits = crypto.randomInt(10000).toString().padStart(4, '0');
    return `${word1}-${word2}-${digits}`;
}
/**
 * Constant-time comparison of pairing codes.
 * Prevents timing side-channel attacks.
 */
export function comparePairingCodes(a, b) {
    const bufA = Buffer.from(a.toUpperCase());
    const bufB = Buffer.from(b.toUpperCase());
    if (bufA.length !== bufB.length)
        return false;
    return crypto.timingSafeEqual(bufA, bufB);
}
// ── SAS (Short Authentication String) ────────────────────────────────
/**
 * 16 symbols for SAS display. Each represents 4 bits.
 * Chosen for visual distinctness and terminal compatibility.
 */
const SAS_SYMBOLS = [
    { word: 'wolf', emoji: '🐺' },
    { word: 'wave', emoji: '🌊' },
    { word: 'fire', emoji: '🔥' },
    { word: 'music', emoji: '🎵' },
    { word: 'moon', emoji: '🌙' },
    { word: 'butterfly', emoji: '🦋' },
    { word: 'star', emoji: '⭐' },
    { word: 'tree', emoji: '🌲' },
    { word: 'diamond', emoji: '💎' },
    { word: 'sun', emoji: '☀️' },
    { word: 'heart', emoji: '❤️' },
    { word: 'bird', emoji: '🐦' },
    { word: 'fish', emoji: '🐟' },
    { word: 'leaf', emoji: '🍃' },
    { word: 'key', emoji: '🔑' },
    { word: 'bell', emoji: '🔔' },
];
/**
 * Derive a Short Authentication String from a shared key and both public keys.
 *
 * SAS = first 24 bits of SHA-256(sharedKey || sort(pubKeyA, pubKeyB))
 * Mapped to 6 symbols from a set of 16 (4 bits each).
 *
 * @param sharedKey - The ECDH shared secret or SPAKE2 session key
 * @param publicKeyA - Public key of machine A (base64 or PEM)
 * @param publicKeyB - Public key of machine B (base64 or PEM)
 */
export function deriveSAS(sharedKey, publicKeyA, publicKeyB) {
    // Sort public keys for deterministic ordering (both machines get same SAS)
    const sorted = [publicKeyA, publicKeyB].sort();
    const input = Buffer.concat([
        sharedKey,
        Buffer.from(sorted[0]),
        Buffer.from(sorted[1]),
    ]);
    const hash = crypto.createHash('sha256').update(input).digest();
    // Extract 24 bits (6 nibbles) → 6 symbols
    const symbols = [];
    for (let i = 0; i < 3; i++) {
        const byte = hash[i];
        symbols.push(SAS_SYMBOLS[(byte >> 4) & 0x0F]);
        symbols.push(SAS_SYMBOLS[byte & 0x0F]);
    }
    const display = symbols.map(s => `${s.word} ${s.emoji}`).join(' - ');
    return { symbols, display };
}
/**
 * Generate an ephemeral X25519 key pair for a single pairing session.
 */
export function generateEphemeralKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }),
        privateKey,
    };
}
/**
 * Perform X25519 ECDH key agreement, then derive a session key using HKDF
 * bound to the pairing code. This ensures the session key is tied to both
 * the ECDH exchange AND the pairing code.
 *
 * @param myPrivateKey - This machine's ephemeral private key
 * @param theirPublicKeyDer - The other machine's ephemeral public key (DER format)
 * @param pairingCode - The shared pairing code (used as HKDF salt)
 * @param info - HKDF info string (identifies the purpose)
 */
export function deriveSessionKey(myPrivateKey, theirPublicKeyDer, pairingCode, info = 'instar-pairing-v1') {
    const theirPublicKey = crypto.createPublicKey({
        key: theirPublicKeyDer,
        type: 'spki',
        format: 'der',
    });
    // X25519 ECDH → raw shared secret
    const rawShared = crypto.diffieHellman({
        publicKey: theirPublicKey,
        privateKey: myPrivateKey,
    });
    // HKDF: derive a proper session key from the ECDH output + pairing code
    // The pairing code as salt binds this session to the code
    const sessionKey = crypto.hkdfSync('sha256', rawShared, Buffer.from(pairingCode.toUpperCase()), Buffer.from(info), 32);
    return Buffer.from(sessionKey);
}
// ── Authenticated Encryption ─────────────────────────────────────────
const XCHACHA20_NONCE_SIZE = 24;
const XCHACHA20_TAG_SIZE = 16;
/**
 * Encrypt data with XChaCha20-Poly1305 (or chacha20-poly1305 with 12-byte nonce).
 * Node.js doesn't natively support XChaCha20, so we use chacha20-poly1305.
 *
 * @param plaintext - Data to encrypt
 * @param key - 32-byte encryption key
 * @param aad - Additional authenticated data (optional)
 * @returns { nonce, ciphertext, tag } all as Buffers
 */
export function encrypt(plaintext, key, aad) {
    const nonce = crypto.randomBytes(12); // chacha20-poly1305 uses 12-byte nonce
    const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, {
        authTagLength: XCHACHA20_TAG_SIZE,
    });
    if (aad)
        cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { nonce, ciphertext, tag };
}
/**
 * Decrypt data with ChaCha20-Poly1305.
 *
 * @param ciphertext - Encrypted data
 * @param key - 32-byte decryption key
 * @param nonce - 12-byte nonce
 * @param tag - 16-byte authentication tag
 * @param aad - Additional authenticated data (must match encryption)
 * @returns Decrypted plaintext
 * @throws If authentication fails (tampered data or wrong key)
 */
export function decrypt(ciphertext, key, nonce, tag, aad) {
    const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce, {
        authTagLength: XCHACHA20_TAG_SIZE,
    });
    decipher.setAuthTag(tag);
    if (aad)
        decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
/**
 * Create a new pairing session.
 */
export function createPairingSession(options) {
    return {
        code: options?.code ?? generatePairingCode(),
        createdAt: Date.now(),
        failedAttempts: 0,
        maxAttempts: options?.maxAttempts ?? 3,
        expiryMs: options?.expiryMs ?? 2 * 60 * 1000, // 2 minutes
        ephemeralKeys: generateEphemeralKeyPair(),
        consumed: false,
    };
}
/**
 * Check if a pairing session is still valid.
 */
export function isPairingSessionValid(session) {
    if (session.consumed)
        return false;
    if (session.failedAttempts >= session.maxAttempts)
        return false;
    if (Date.now() - session.createdAt > session.expiryMs)
        return false;
    return true;
}
/**
 * Validate a pairing code against a session.
 * Returns true if the code matches and the session is valid.
 * Increments failedAttempts on mismatch.
 */
export function validatePairingCode(session, code) {
    if (session.consumed) {
        return { valid: false, reason: 'Code already used' };
    }
    if (session.failedAttempts >= session.maxAttempts) {
        return { valid: false, reason: 'Too many attempts' };
    }
    if (Date.now() - session.createdAt > session.expiryMs) {
        return { valid: false, reason: 'Code expired' };
    }
    if (!comparePairingCodes(session.code, code)) {
        session.failedAttempts++;
        const remaining = session.maxAttempts - session.failedAttempts;
        return {
            valid: false,
            reason: remaining > 0
                ? `Wrong code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
                : 'Too many attempts. Generate a new code.',
        };
    }
    return { valid: true };
}
//# sourceMappingURL=PairingProtocol.js.map