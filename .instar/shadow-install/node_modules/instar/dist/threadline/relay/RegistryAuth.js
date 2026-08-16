/**
 * RegistryAuth — JWT-based authentication for registry REST endpoints.
 *
 * Issues short-lived JWT tokens during WebSocket auth, verified on REST calls.
 * Tokens are signed with the relay's Ed25519 key (not the agent's key).
 *
 * Part of Threadline Relay Phase 1.1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sign, verify, generateIdentityKeyPair } from '../ThreadlineCrypto.js';
// ── Base64url Helpers ────────────────────────────────────────────────
function base64url(buf) {
    return buf.toString('base64url');
}
function base64urlEncode(str) {
    return Buffer.from(str).toString('base64url');
}
function base64urlDecode(str) {
    return Buffer.from(str, 'base64url').toString();
}
// ── RegistryAuth ─────────────────────────────────────────────────────
export class RegistryAuth {
    relayPrivateKey;
    relayPublicKey;
    relayId;
    tokenLifetimeMs;
    constructor(config) {
        this.relayId = config.relayId;
        this.tokenLifetimeMs = config.tokenLifetimeMs ?? 60 * 60 * 1000;
        // Generate or load relay key pair
        if (config.keyDir) {
            const keyPath = path.join(config.keyDir, 'relay-signing-key.json');
            if (fs.existsSync(keyPath)) {
                const stored = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
                this.relayPublicKey = Buffer.from(stored.publicKey, 'base64');
                this.relayPrivateKey = Buffer.from(stored.privateKey, 'base64');
            }
            else {
                const kp = generateIdentityKeyPair();
                this.relayPublicKey = kp.publicKey;
                this.relayPrivateKey = kp.privateKey;
                fs.mkdirSync(config.keyDir, { recursive: true });
                fs.writeFileSync(keyPath, JSON.stringify({
                    publicKey: kp.publicKey.toString('base64'),
                    privateKey: kp.privateKey.toString('base64'),
                }), { mode: 0o600 });
            }
        }
        else {
            const kp = generateIdentityKeyPair();
            this.relayPublicKey = kp.publicKey;
            this.relayPrivateKey = kp.privateKey;
        }
    }
    /**
     * Issue a JWT for an authenticated agent.
     */
    issueToken(agentPublicKey) {
        const now = Math.floor(Date.now() / 1000);
        const exp = now + Math.floor(this.tokenLifetimeMs / 1000);
        const header = base64urlEncode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
        const payload = base64urlEncode(JSON.stringify({
            sub: agentPublicKey,
            iat: now,
            exp,
            iss: this.relayId,
        }));
        const signingInput = `${header}.${payload}`;
        const signature = sign(this.relayPrivateKey, Buffer.from(signingInput));
        const token = `${signingInput}.${base64url(signature)}`;
        return {
            token,
            expiresAt: new Date(exp * 1000).toISOString(),
        };
    }
    /**
     * Verify a JWT and return the payload.
     * Returns null if invalid or expired.
     */
    verifyToken(token) {
        try {
            const parts = token.split('.');
            if (parts.length !== 3)
                return null;
            const [headerB64, payloadB64, signatureB64] = parts;
            // Verify signature
            const signingInput = `${headerB64}.${payloadB64}`;
            const signature = Buffer.from(signatureB64, 'base64url');
            const valid = verify(this.relayPublicKey, Buffer.from(signingInput), signature);
            if (!valid)
                return null;
            // Decode payload
            const payload = JSON.parse(base64urlDecode(payloadB64));
            // Check expiry
            const now = Math.floor(Date.now() / 1000);
            if (payload.exp < now)
                return null;
            // Check issuer
            if (payload.iss !== this.relayId)
                return null;
            return payload;
        }
        catch {
            return null;
        }
    }
    /**
     * Extract bearer token from Authorization header.
     */
    extractToken(authHeader) {
        if (!authHeader)
            return null;
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        return match?.[1] ?? null;
    }
}
//# sourceMappingURL=RegistryAuth.js.map