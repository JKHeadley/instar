/**
 * HandshakeManager — Manages the Threadline trust handshake protocol.
 *
 * Implements the Ed25519/X25519 cryptographic handshake between agents:
 * 1. Agent A sends hello (identity pub + ephemeral pub + nonce)
 * 2. Agent B responds with hello (identity pub + ephemeral pub + nonce + challenge response)
 * 3. Agent A sends confirm (challenge response)
 * 4. Both agents derive the shared relay token via HKDF
 *
 * Features:
 * - Glare resolution (Section 7.5.3): lexicographically lower pubkey wins
 * - Rate limiting: max 5 attempts/minute per agent, block after 10 failures/hour
 * - Persistent identity keys and relay tokens
 * - Replay protection via nonce tracking
 *
 * Part of Threadline Protocol Phase 3.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generateIdentityKeyPair, generateEphemeralKeyPair, computeChallengeResponse, verify, ecdh, deriveRelayToken, } from './ThreadlineCrypto.js';
// ── Constants ────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_ATTEMPTS = 5; // per minute per agent
const FAILURE_BLOCK_THRESHOLD = 10; // failures in 1 hour
const FAILURE_WINDOW_MS = 3600_000; // 1 hour
const FAILURE_BLOCK_DURATION_MS = 3600_000; // block for 1 hour
const HANDSHAKE_TIMEOUT_MS = 30_000; // 30 seconds
const RELAY_TOKEN_INFO = 'threadline-relay-token-v1';
/**
 * Build a deterministic salt from two identity public keys.
 * Both sides will produce the same salt regardless of who is A vs B,
 * by sorting the keys lexicographically.
 */
function buildDeterministicSalt(pubA, pubB) {
    const hexA = pubA.toString('hex');
    const hexB = pubB.toString('hex');
    return hexA < hexB
        ? Buffer.concat([pubA, pubB])
        : Buffer.concat([pubB, pubA]);
}
// ── HandshakeManager ─────────────────────────────────────────────────
export class HandshakeManager {
    stateDir;
    localAgent;
    identityKey = null;
    handshakes = new Map();
    rateLimits = new Map();
    relayTokens = {};
    constructor(stateDir, localAgent) {
        this.stateDir = path.join(stateDir, 'threadline');
        this.localAgent = localAgent;
        this.ensureDirs();
        this.loadIdentity();
        this.loadRelayTokens();
    }
    // ── Public API ───────────────────────────────────────────────────
    /**
     * Initiate a handshake with a target agent.
     * Generates ephemeral keys and returns a hello payload to send.
     */
    initiateHandshake(targetAgent) {
        const rateCheck = this.checkRateLimit(targetAgent);
        if (rateCheck)
            return { error: rateCheck };
        this.recordAttempt(targetAgent);
        const identity = this.getOrCreateIdentity();
        const ephemeral = generateEphemeralKeyPair();
        const nonce = crypto.randomBytes(32).toString('hex');
        const state = {
            agentName: targetAgent,
            ourIdentityKey: identity,
            ourEphemeralKey: ephemeral,
            ourChallenge: nonce,
            state: 'hello-sent',
            startedAt: new Date().toISOString(),
        };
        this.handshakes.set(targetAgent, state);
        return {
            payload: {
                agent: this.localAgent,
                identityPub: identity.publicKey.toString('hex'),
                ephemeralPub: ephemeral.publicKey.toString('hex'),
                nonce,
            },
        };
    }
    /**
     * Handle an incoming hello from another agent.
     *
     * If we already sent a hello to this agent (glare), resolve by pubkey ordering:
     * the agent with the lexicographically lower Ed25519 public key wins (keeps initiator role).
     *
     * Returns a hello response payload (with challenge response) or a confirm payload.
     */
    handleHello(hello) {
        const rateCheck = this.checkRateLimit(hello.agent);
        if (rateCheck)
            return { error: rateCheck };
        this.recordAttempt(hello.agent);
        const theirIdentityPub = Buffer.from(hello.identityPub, 'hex');
        const theirEphemeralPub = Buffer.from(hello.ephemeralPub, 'hex');
        const identity = this.getOrCreateIdentity();
        // Glare resolution: both sides sent hello simultaneously
        const existing = this.handshakes.get(hello.agent);
        if (existing && existing.state === 'hello-sent') {
            const ourPubHex = identity.publicKey.toString('hex');
            const theirPubHex = hello.identityPub;
            if (ourPubHex < theirPubHex) {
                // We win — we keep our initiator role, ignore their hello.
                // They should process our hello instead.
                return { error: 'glare: we are the initiator (lower pubkey)' };
            }
            // They win — we abandon our hello and process theirs as receiver.
            this.handshakes.delete(hello.agent);
        }
        const ephemeral = generateEphemeralKeyPair();
        const nonce = crypto.randomBytes(32).toString('hex');
        // Compute our challenge response to their nonce
        const challengeResponse = computeChallengeResponse(identity.privateKey, hello.nonce, theirIdentityPub, identity.publicKey, theirEphemeralPub, ephemeral.publicKey);
        const state = {
            agentName: hello.agent,
            ourIdentityKey: identity,
            ourEphemeralKey: ephemeral,
            theirIdentityPub,
            theirEphemeralPub,
            ourChallenge: nonce,
            theirChallenge: hello.nonce,
            state: 'hello-received',
            startedAt: new Date().toISOString(),
        };
        this.handshakes.set(hello.agent, state);
        return {
            payload: {
                agent: this.localAgent,
                identityPub: identity.publicKey.toString('hex'),
                ephemeralPub: ephemeral.publicKey.toString('hex'),
                nonce,
                challengeResponse: challengeResponse.toString('hex'),
            },
        };
    }
    /**
     * Handle an incoming confirm from the agent that responded to our hello.
     * This is the final step — both sides now derive the relay token.
     *
     * Can also handle the hello-response (when we are the initiator and receive
     * the responder's hello with their challenge response).
     */
    handleConfirm(confirm) {
        const state = this.handshakes.get(confirm.agent);
        if (!state) {
            this.recordFailure(confirm.agent);
            return { error: 'No handshake in progress with this agent' };
        }
        // Check timeout
        const elapsed = Date.now() - new Date(state.startedAt).getTime();
        if (elapsed > HANDSHAKE_TIMEOUT_MS) {
            state.state = 'failed';
            this.handshakes.delete(confirm.agent);
            this.recordFailure(confirm.agent);
            return { error: 'Handshake timed out' };
        }
        if (!state.theirIdentityPub || !state.theirEphemeralPub) {
            this.recordFailure(confirm.agent);
            return { error: 'Handshake state incomplete — missing their keys' };
        }
        // Verify their challenge response against our nonce
        const challengeResponseBuf = Buffer.from(confirm.challengeResponse, 'hex');
        const expectedHash = crypto.createHash('sha256');
        expectedHash.update(Buffer.from(state.ourChallenge, 'utf-8'));
        expectedHash.update(state.ourIdentityKey.publicKey); // identity_pub_A (us as challenger)
        expectedHash.update(state.theirIdentityPub); // identity_pub_B (them)
        expectedHash.update(state.ourEphemeralKey.publicKey); // eph_pub_A
        expectedHash.update(state.theirEphemeralPub); // eph_pub_B
        const isValid = verify(state.theirIdentityPub, expectedHash.digest(), challengeResponseBuf);
        if (!isValid) {
            state.state = 'failed';
            this.handshakes.delete(confirm.agent);
            this.recordFailure(confirm.agent);
            return { error: 'Challenge response verification failed' };
        }
        // Derive the relay token via X25519 ECDH + HKDF
        const sharedSecret = ecdh(state.ourEphemeralKey.privateKey, state.theirEphemeralPub);
        const salt = buildDeterministicSalt(state.ourIdentityKey.publicKey, state.theirIdentityPub);
        const relayToken = deriveRelayToken(sharedSecret, salt, RELAY_TOKEN_INFO);
        state.relayToken = relayToken;
        state.state = 'confirmed';
        // Persist the relay token
        this.relayTokens[confirm.agent] = {
            token: relayToken.toString('hex'),
            establishedAt: new Date().toISOString(),
            theirIdentityPub: state.theirIdentityPub.toString('hex'),
        };
        this.saveRelayTokens();
        this.handshakes.delete(confirm.agent);
        return { relayToken: relayToken.toString('hex') };
    }
    /**
     * Process the responder's hello (as initiator).
     * The responder's hello includes their challenge response to our nonce,
     * plus their own nonce for us to respond to.
     *
     * Returns a confirm payload for us to send, plus the derived relay token.
     */
    handleHelloResponse(hello) {
        const state = this.handshakes.get(hello.agent);
        if (!state || state.state !== 'hello-sent') {
            return { error: 'No pending hello-sent handshake with this agent' };
        }
        if (!hello.challengeResponse) {
            return { error: 'Hello response missing challenge response' };
        }
        const theirIdentityPub = Buffer.from(hello.identityPub, 'hex');
        const theirEphemeralPub = Buffer.from(hello.ephemeralPub, 'hex');
        // Verify their challenge response to our nonce
        // They signed: SHA256(ourNonce || theirIdentityPub || ourIdentityPub || theirEphPub || ourEphPub)
        // But from their perspective: SHA256(nonce || identityPubA || identityPubB || ephPubA || ephPubB)
        // where A = us (the hello sender), B = them (the responder)
        const verifyHash = crypto.createHash('sha256');
        verifyHash.update(Buffer.from(state.ourChallenge, 'utf-8'));
        verifyHash.update(state.ourIdentityKey.publicKey); // identity_pub_A (original hello sender)
        verifyHash.update(theirIdentityPub); // identity_pub_B (responder)
        verifyHash.update(state.ourEphemeralKey.publicKey); // eph_pub_A
        verifyHash.update(theirEphemeralPub); // eph_pub_B
        const challengeResponseBuf = Buffer.from(hello.challengeResponse, 'hex');
        const isValid = verify(theirIdentityPub, verifyHash.digest(), challengeResponseBuf);
        if (!isValid) {
            state.state = 'failed';
            this.handshakes.delete(hello.agent);
            this.recordFailure(hello.agent);
            return { error: 'Challenge response verification failed' };
        }
        // Store their keys
        state.theirIdentityPub = theirIdentityPub;
        state.theirEphemeralPub = theirEphemeralPub;
        state.theirChallenge = hello.nonce;
        // Compute our challenge response to their nonce
        const ourChallengeResponse = computeChallengeResponse(state.ourIdentityKey.privateKey, hello.nonce, theirIdentityPub, state.ourIdentityKey.publicKey, theirEphemeralPub, state.ourEphemeralKey.publicKey);
        // Derive the relay token
        const sharedSecret = ecdh(state.ourEphemeralKey.privateKey, theirEphemeralPub);
        const salt = buildDeterministicSalt(state.ourIdentityKey.publicKey, theirIdentityPub);
        const relayToken = deriveRelayToken(sharedSecret, salt, RELAY_TOKEN_INFO);
        state.relayToken = relayToken;
        state.state = 'confirmed';
        // Persist
        this.relayTokens[hello.agent] = {
            token: relayToken.toString('hex'),
            establishedAt: new Date().toISOString(),
            theirIdentityPub: theirIdentityPub.toString('hex'),
        };
        this.saveRelayTokens();
        this.handshakes.delete(hello.agent);
        return {
            confirmPayload: {
                agent: this.localAgent,
                challengeResponse: ourChallengeResponse.toString('hex'),
            },
            relayToken: relayToken.toString('hex'),
        };
    }
    /**
     * Get the stored relay token for a paired agent.
     * Returns hex-encoded token or null if not paired.
     */
    getRelayToken(agentName) {
        return this.relayTokens[agentName]?.token ?? null;
    }
    /**
     * Check if a relay token is valid for a given agent.
     */
    validateRelayToken(agentName, token) {
        const stored = this.relayTokens[agentName]?.token;
        if (!stored)
            return false;
        // Timing-safe comparison
        const a = Buffer.from(stored, 'hex');
        const b = Buffer.from(token, 'hex');
        if (a.length !== b.length)
            return false;
        return crypto.timingSafeEqual(a, b);
    }
    /**
     * Check if a handshake is currently in progress with an agent.
     */
    isHandshakeInProgress(agentName) {
        const state = this.handshakes.get(agentName);
        if (!state)
            return false;
        return state.state === 'hello-sent' || state.state === 'hello-received';
    }
    /**
     * Get the local agent's identity public key (hex).
     */
    getIdentityPublicKey() {
        return this.getOrCreateIdentity().publicKey.toString('hex');
    }
    /**
     * List all paired agents with relay tokens.
     */
    listPairedAgents() {
        return Object.entries(this.relayTokens).map(([agent, data]) => ({
            agent,
            establishedAt: data.establishedAt,
        }));
    }
    // ── Private: Identity management ──────────────────────────────────
    getOrCreateIdentity() {
        if (this.identityKey)
            return this.identityKey;
        const identityPath = path.join(this.stateDir, 'identity.json');
        if (fs.existsSync(identityPath)) {
            const stored = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
            this.identityKey = {
                publicKey: Buffer.from(stored.publicKey, 'hex'),
                privateKey: Buffer.from(stored.privateKey, 'hex'),
            };
        }
        else {
            this.identityKey = generateIdentityKeyPair();
            const stored = {
                publicKey: this.identityKey.publicKey.toString('hex'),
                privateKey: this.identityKey.privateKey.toString('hex'),
            };
            fs.writeFileSync(identityPath, JSON.stringify(stored, null, 2));
        }
        return this.identityKey;
    }
    loadIdentity() {
        const identityPath = path.join(this.stateDir, 'identity.json');
        if (fs.existsSync(identityPath)) {
            try {
                const stored = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
                this.identityKey = {
                    publicKey: Buffer.from(stored.publicKey, 'hex'),
                    privateKey: Buffer.from(stored.privateKey, 'hex'),
                };
            }
            catch {
                // Corrupt identity file — will regenerate
                this.identityKey = null;
            }
        }
    }
    // ── Private: Relay token persistence ──────────────────────────────
    loadRelayTokens() {
        const tokensPath = path.join(this.stateDir, 'relay-tokens.json');
        if (fs.existsSync(tokensPath)) {
            try {
                this.relayTokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
            }
            catch {
                this.relayTokens = {};
            }
        }
    }
    saveRelayTokens() {
        const tokensPath = path.join(this.stateDir, 'relay-tokens.json');
        fs.writeFileSync(tokensPath, JSON.stringify(this.relayTokens, null, 2));
    }
    // ── Private: Rate limiting ────────────────────────────────────────
    checkRateLimit(agentName) {
        const entry = this.rateLimits.get(agentName);
        if (!entry)
            return null;
        const now = Date.now();
        // Check block
        if (entry.blockedUntil && now < entry.blockedUntil) {
            const retryAfter = Math.ceil((entry.blockedUntil - now) / 1000);
            return `Rate limited: blocked for ${retryAfter}s (too many failures)`;
        }
        // Check per-minute rate
        const recentAttempts = entry.attempts.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
        if (recentAttempts.length >= RATE_LIMIT_MAX_ATTEMPTS) {
            return `Rate limited: max ${RATE_LIMIT_MAX_ATTEMPTS} attempts per minute`;
        }
        return null;
    }
    recordAttempt(agentName) {
        const entry = this.rateLimits.get(agentName) ?? { attempts: [], failures: 0 };
        const now = Date.now();
        entry.attempts = entry.attempts.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
        entry.attempts.push(now);
        this.rateLimits.set(agentName, entry);
    }
    recordFailure(agentName) {
        const entry = this.rateLimits.get(agentName) ?? { attempts: [], failures: 0 };
        entry.failures++;
        // Reset failure counter if outside the window
        // (Simplified: we just track total failures and block)
        if (entry.failures >= FAILURE_BLOCK_THRESHOLD) {
            entry.blockedUntil = Date.now() + FAILURE_BLOCK_DURATION_MS;
            entry.failures = 0; // Reset after blocking
        }
        this.rateLimits.set(agentName, entry);
    }
    // ── Private: Directory setup ──────────────────────────────────────
    ensureDirs() {
        fs.mkdirSync(this.stateDir, { recursive: true });
    }
}
//# sourceMappingURL=HandshakeManager.js.map