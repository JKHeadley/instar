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
 * - Persistent relay tokens
 * - The identity key is the agent's ONE identity, read through the client
 *   IdentityManager. This class never writes an identity file (spec:
 *   docs/specs/threadline-identity-single-writer.md).
 * - Replay protection via nonce tracking
 *
 * Part of Threadline Protocol Phase 3.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateEphemeralKeyPair,
  computeChallengeResponse,
  verify,
  ecdh,
  deriveRelayToken,
  type KeyPair,
} from './ThreadlineCrypto.js';
import { IdentityManager } from './client/IdentityManager.js';
import { writeFileAtomicOwnerOnly } from '../identity/IdentityKeyFile.js';

// ── Types ────────────────────────────────────────────────────────────

export interface HandshakeState {
  agentName: string;
  ourIdentityKey: KeyPair;
  ourEphemeralKey: KeyPair;
  theirIdentityPub?: Buffer;
  theirEphemeralPub?: Buffer;
  ourChallenge: string;      // nonce we sent
  theirChallenge?: string;   // nonce they sent
  state: 'hello-sent' | 'hello-received' | 'confirmed' | 'failed';
  startedAt: string;
  relayToken?: Buffer;       // derived after successful handshake
}

export interface HelloPayload {
  agent: string;
  identityPub: string;     // hex-encoded 32 bytes
  ephemeralPub: string;     // hex-encoded 32 bytes
  nonce: string;            // random challenge nonce
  challengeResponse?: string; // hex-encoded Ed25519 signature (present in response hello)
}

export interface ConfirmPayload {
  agent: string;
  challengeResponse: string; // hex-encoded Ed25519 signature
}

interface RateLimitEntry {
  attempts: number[];       // timestamps of recent attempts
  failures: number;         // failure count in current hour window
  blockedUntil?: number;    // epoch ms when block expires
}

interface StoredRelayTokens {
  [agentName: string]: {
    token: string;          // hex
    establishedAt: string;  // ISO timestamp
    theirIdentityPub: string; // hex
  };
}

// ── Constants ────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000;       // 1 minute
const RATE_LIMIT_MAX_ATTEMPTS = 5;          // per minute per agent
const FAILURE_BLOCK_THRESHOLD = 10;         // failures in 1 hour
const FAILURE_WINDOW_MS = 3600_000;         // 1 hour
const FAILURE_BLOCK_DURATION_MS = 3600_000; // block for 1 hour
const HANDSHAKE_TIMEOUT_MS = 30_000;        // 30 seconds

const RELAY_TOKEN_INFO = 'threadline-relay-token-v1';

/**
 * Build a deterministic salt from two identity public keys.
 * Both sides will produce the same salt regardless of who is A vs B,
 * by sorting the keys lexicographically.
 */
function buildDeterministicSalt(pubA: Buffer, pubB: Buffer): Buffer {
  const hexA = pubA.toString('hex');
  const hexB = pubB.toString('hex');
  return hexA < hexB
    ? Buffer.concat([pubA, pubB])
    : Buffer.concat([pubB, pubA]);
}

// ── HandshakeManager ─────────────────────────────────────────────────

/**
 * One refusal text for the pairing refusals this spec adds (key change, unusable name),
 * so the refusal does not say why. It does not hide which names are paired: a caller can
 * still tell from whether a hello succeeds.
 */
const HANDSHAKE_REFUSED = 'Handshake refused';

/**
 * A peer name may not be shaped like a fingerprint (hex, 16+ characters), equal this
 * agent's own name, or be an object-prototype key: the first two could pass for a
 * different principal where names are shown or compared, the last is not data in the
 * pairing store. docs/specs/threadline-http-peer-trust.md §1.
 */
export function isUsablePeerName(name: string, localAgent: string): boolean {
  if (typeof name !== 'string' || !name.trim()) return false;
  // One spelling per name: no surrounding whitespace, Unicode NFC, so look-alike
  // spellings cannot become separate pins.
  if (name !== name.trim() || name !== name.normalize('NFC')) return false;
  if (/^[0-9a-f]{16,}$/i.test(name.trim())) return false;
  if (name.trim().toLowerCase() === localAgent.trim().toLowerCase()) return false;
  // Pairings are kept in a plain object keyed by name; these keys are not data there.
  if (['__proto__', 'constructor', 'prototype'].includes(name.trim())) return false;
  return true;
}

export class HandshakeManager {
  private readonly stateDir: string;
  private readonly localAgent: string;
  private readonly identityManager: IdentityManager;
  private identityKey: KeyPair | null = null;
  private readonly handshakes = new Map<string, HandshakeState>();
  private readonly rateLimits = new Map<string, RateLimitEntry>();
  private relayTokens: StoredRelayTokens = {};
  /** True when relay-tokens.json exists but could not be parsed (fail closed for pinning). */
  private pairingStoreUnreadable = false;

  constructor(stateDir: string, localAgent: string) {
    this.stateDir = path.join(stateDir, 'threadline');
    this.localAgent = localAgent;
    this.identityManager = new IdentityManager(stateDir);
    this.ensureDirs();
    this.loadRelayTokens();
  }

  /** The identity key this agent name is paired with, or null. */
  getPairedIdentityPub(agentName: string): string | null {
    const entry = Object.prototype.hasOwnProperty.call(this.relayTokens, agentName) ? this.relayTokens[agentName] : undefined;
    return entry?.theirIdentityPub ?? null;
  }

  /**
   * Key pinning: an agent name already paired with one identity key may not be
   * re-paired with a different one over this unauthenticated handshake. True when
   * the name is paired and the key differs.
   */
  private keyConflict(agentName: string, identityPubHex: string): boolean {
    // An existing pairing store that could not be read: every name may already be
    // pinned, so no new key is accepted for any name until the store is repaired.
    if (this.pairingStoreUnreadable) return true;
    if (!Object.prototype.hasOwnProperty.call(this.relayTokens, agentName)) return false;
    const pinned = this.getPairedIdentityPub(agentName);
    // A stored entry with no key still holds the name: only the owner frees it.
    if (typeof pinned !== 'string' || !pinned) return true;
    return pinned.toLowerCase() !== identityPubHex.toLowerCase();
  }

  /**
   * A failed confirm counts toward the per-name block only for a name that is not yet
   * paired. For a paired name, the pinned PUBLIC key lets anyone start a hello under
   * it, so counting failed confirms there would let anyone block its re-pairing.
   */
  /** Bound pending state: drop expired handshakes and keep at most one per presented key. */
  private pruneHandshakes(forName: string, identityPubHex: string): void {
    const now = Date.now();
    for (const [name, st] of this.handshakes) {
      const expired = now - new Date(st.startedAt).getTime() > HANDSHAKE_TIMEOUT_MS;
      const sameKeyOtherName = name !== forName && st.state === 'hello-received'
        && !!st.theirIdentityPub && st.theirIdentityPub.toString('hex').toLowerCase() === identityPubHex;
      if (expired || sameKeyOtherName) this.handshakes.delete(name);
    }
  }

  /**
   * Record a handshake failure against a name, but only for a name that is not yet
   * paired (a pinned name's PUBLIC key is known, so counting failures there would let
   * anyone block its re-pairing). Used by the initiator path; the confirm path no
   * longer counts.
   */
  private countFailureUnlessPinned(agentName: string): void {
    if (this.getPairedIdentityPub(agentName)) return;
    this.recordFailure(agentName);
  }

  /**
   * Owner action (bearer-gated route): forget this agent name's direct-HTTP pairing,
   * so the name can be paired again (for example after the peer reinstalled, or to
   * free a name someone else took first). Returns whether a pairing was removed.
   */
  removePairing(agentName: string): boolean {
    if (!Object.prototype.hasOwnProperty.call(this.relayTokens, agentName)) return false;
    delete this.relayTokens[agentName];
    this.saveRelayTokens();
    return true;
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Initiate a handshake with a target agent.
   * Generates ephemeral keys and returns a hello payload to send.
   */
  initiateHandshake(targetAgent: string): { payload: HelloPayload } | { error: string } {
    const rateCheck = this.checkRateLimit(targetAgent);
    if (rateCheck) return { error: rateCheck };

    this.recordAttempt(targetAgent);

    const identity = this.getOrCreateIdentity();
    const ephemeral = generateEphemeralKeyPair();
    const nonce = crypto.randomBytes(32).toString('hex');

    const state: HandshakeState = {
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
  handleHello(hello: HelloPayload): { payload: HelloPayload } | { error: string } {
    // Attempts are counted per PRESENTED KEY, not per name (threadline-http-peer-trust §1):
    // the hello is unsigned and public keys are not secret, so a per-name counter would
    // grow without bound under fresh names. The name's own failure block still applies.
    const keyRateId = `key:${String(hello.identityPub).toLowerCase()}`;
    const rateCheck = this.checkRateLimit(hello.agent) ?? this.checkRateLimit(keyRateId);
    if (rateCheck) return { error: rateCheck };

    // A name that looks like a fingerprint, or is this agent's own name, could pass
    // for another principal in thread-ownership and display checks. Refused.
    if (!isUsablePeerName(hello.agent, this.localAgent)) {
      return { error: HANDSHAKE_REFUSED };
    }
    // Refused BEFORE the attempt is counted, and never counted as a failure: counting
    // it would let anyone keep a real peer's name rate-limited out of re-pairing by
    // sending wrong keys under it. The refusal does no key work, so it costs nothing.
    if (this.keyConflict(hello.agent, hello.identityPub)) {
      return { error: HANDSHAKE_REFUSED };
    }

    this.recordAttempt(keyRateId);
    // Bound pending state: drop expired handshakes, and keep at most ONE pending
    // handshake per presented key, so pending state cannot outgrow the granted keys.
    this.pruneHandshakes(hello.agent, String(hello.identityPub).toLowerCase());

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
    const challengeResponse = computeChallengeResponse(
      identity.privateKey,
      hello.nonce,
      theirIdentityPub,
      identity.publicKey,
      theirEphemeralPub,
      ephemeral.publicKey,
    );

    const state: HandshakeState = {
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
  handleConfirm(confirm: ConfirmPayload): { relayToken: string } | { error: string } {
    const state = this.handshakes.get(confirm.agent);
    if (!state) {
      // Not counted as a failure: an unsolicited confirm needs no key, so counting it
      // would let anyone block a name (threadline-http-peer-trust §1).
      return { error: 'No handshake in progress with this agent' };
    }

    // Check timeout
    const elapsed = Date.now() - new Date(state.startedAt).getTime();
    if (elapsed > HANDSHAKE_TIMEOUT_MS) {
      // Expired state is dropped, but not counted: a confirm carries no key, so its
      // arrival proves nothing about who sent it (threadline-http-peer-trust §1).
      state.state = 'failed';
      this.handshakes.delete(confirm.agent);
      return { error: 'Handshake timed out' };
    }

    if (!state.theirIdentityPub || !state.theirEphemeralPub) {
      return { error: 'Handshake state incomplete — missing their keys' };
    }

    // Verify their challenge response against our nonce
    const challengeResponseBuf = Buffer.from(confirm.challengeResponse, 'hex');
    const expectedHash = crypto.createHash('sha256');
    expectedHash.update(Buffer.from(state.ourChallenge, 'utf-8'));
    expectedHash.update(state.ourIdentityKey.publicKey);  // identity_pub_A (us as challenger)
    expectedHash.update(state.theirIdentityPub);          // identity_pub_B (them)
    expectedHash.update(state.ourEphemeralKey.publicKey);  // eph_pub_A
    expectedHash.update(state.theirEphemeralPub);          // eph_pub_B

    const isValid = verify(state.theirIdentityPub, expectedHash.digest(), challengeResponseBuf);
    if (!isValid) {
      // A confirm that fails verification proves nothing about its sender, so it neither
      // ends the granted peer's handshake nor counts against the name: the state stays
      // until the real confirm arrives or it expires (threadline-http-peer-trust §1).
      return { error: 'Challenge response verification failed' };
    }

    // Key pinning, re-checked at the write (a pairing may have landed since hello).
    if (this.keyConflict(confirm.agent, state.theirIdentityPub.toString('hex'))) {
      state.state = 'failed';
      this.handshakes.delete(confirm.agent);
      return { error: HANDSHAKE_REFUSED };
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
  handleHelloResponse(hello: HelloPayload): { confirmPayload: ConfirmPayload; relayToken: string } | { error: string } {
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
    verifyHash.update(state.ourIdentityKey.publicKey);   // identity_pub_A (original hello sender)
    verifyHash.update(theirIdentityPub);                 // identity_pub_B (responder)
    verifyHash.update(state.ourEphemeralKey.publicKey);   // eph_pub_A
    verifyHash.update(theirEphemeralPub);                 // eph_pub_B

    const challengeResponseBuf = Buffer.from(hello.challengeResponse, 'hex');
    const isValid = verify(theirIdentityPub, verifyHash.digest(), challengeResponseBuf);
    if (!isValid) {
      state.state = 'failed';
      this.handshakes.delete(hello.agent);
      this.countFailureUnlessPinned(hello.agent);
      return { error: 'Challenge response verification failed' };
    }

    // Key pinning (initiator side): the responder must hold the key we paired with.
    if (this.keyConflict(hello.agent, hello.identityPub)) {
      state.state = 'failed';
      this.handshakes.delete(hello.agent);
      return { error: HANDSHAKE_REFUSED };
    }

    // Store their keys
    state.theirIdentityPub = theirIdentityPub;
    state.theirEphemeralPub = theirEphemeralPub;
    state.theirChallenge = hello.nonce;

    // Compute our challenge response to their nonce
    const ourChallengeResponse = computeChallengeResponse(
      state.ourIdentityKey.privateKey,
      hello.nonce,
      theirIdentityPub,
      state.ourIdentityKey.publicKey,
      theirEphemeralPub,
      state.ourEphemeralKey.publicKey,
    );

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
  getRelayToken(agentName: string): string | null {
    return this.relayTokens[agentName]?.token ?? null;
  }

  /**
   * Check if a relay token is valid for a given agent.
   */
  validateRelayToken(agentName: string, token: string): boolean {
    const stored = this.relayTokens[agentName]?.token;
    if (!stored) return false;
    // Timing-safe comparison
    const a = Buffer.from(stored, 'hex');
    const b = Buffer.from(token, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Check if a handshake is currently in progress with an agent.
   */
  isHandshakeInProgress(agentName: string): boolean {
    const state = this.handshakes.get(agentName);
    if (!state) return false;
    return state.state === 'hello-sent' || state.state === 'hello-received';
  }

  /**
   * Get the local agent's identity public key (hex).
   */
  getIdentityPublicKey(): string {
    return this.getOrCreateIdentity().publicKey.toString('hex');
  }

  /**
   * List all paired agents with relay tokens.
   */
  listPairedAgents(): Array<{ agent: string; establishedAt: string }> {
    return Object.entries(this.relayTokens).map(([agent, data]) => ({
      agent,
      establishedAt: data.establishedAt,
    }));
  }

  // ── Private: Identity management ──────────────────────────────────

  /**
   * The agent's identity key, from the single identity source. A handshake is
   * a deliberate use of the identity, so it may create one through the
   * IdentityManager when none exists (which also honours the joined-mesh mint
   * refusal and refuses to mint over an unusable file).
   */
  private getOrCreateIdentity(): KeyPair {
    if (this.identityKey) return this.identityKey;
    const identity = this.identityManager.getOrCreate();
    this.identityKey = { publicKey: identity.publicKey, privateKey: identity.privateKey };
    return this.identityKey;
  }

  // ── Private: Relay token persistence ──────────────────────────────

  private loadRelayTokens(): void {
    const tokensPath = path.join(this.stateDir, 'relay-tokens.json');
    if (fs.existsSync(tokensPath)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('relay-tokens.json is not an object');
        this.relayTokens = parsed as StoredRelayTokens;
      } catch {
        // Fail closed for pinning (keyConflict): the file is kept as it is, and no new
        // pairing is written over it, so the pins it holds are not silently erased.
        this.relayTokens = {};
        this.pairingStoreUnreadable = true;
        console.warn('[HandshakeManager] relay-tokens.json is unreadable; new direct pairings are refused until the agent backs the file up, removes or repairs it, and restarts');
      }
    }
  }

  private saveRelayTokens(): void {
    const tokensPath = path.join(this.stateDir, 'relay-tokens.json');
    writeFileAtomicOwnerOnly(tokensPath, JSON.stringify(this.relayTokens, null, 2));
  }

  // ── Private: Rate limiting ────────────────────────────────────────

  private checkRateLimit(agentName: string): string | null {
    const entry = this.rateLimits.get(agentName);
    if (!entry) return null;

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

  private recordAttempt(agentName: string): void {
    const entry = this.rateLimits.get(agentName) ?? { attempts: [], failures: 0 };
    const now = Date.now();
    entry.attempts = entry.attempts.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    entry.attempts.push(now);
    this.rateLimits.set(agentName, entry);
  }

  private recordFailure(agentName: string): void {
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

  private ensureDirs(): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
  }
}
