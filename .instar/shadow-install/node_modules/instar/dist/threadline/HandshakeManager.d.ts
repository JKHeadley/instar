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
import { type KeyPair } from './ThreadlineCrypto.js';
export interface HandshakeState {
    agentName: string;
    ourIdentityKey: KeyPair;
    ourEphemeralKey: KeyPair;
    theirIdentityPub?: Buffer;
    theirEphemeralPub?: Buffer;
    ourChallenge: string;
    theirChallenge?: string;
    state: 'hello-sent' | 'hello-received' | 'confirmed' | 'failed';
    startedAt: string;
    relayToken?: Buffer;
}
export interface HelloPayload {
    agent: string;
    identityPub: string;
    ephemeralPub: string;
    nonce: string;
    challengeResponse?: string;
}
export interface ConfirmPayload {
    agent: string;
    challengeResponse: string;
}
export declare class HandshakeManager {
    private readonly stateDir;
    private readonly localAgent;
    private identityKey;
    private readonly handshakes;
    private readonly rateLimits;
    private relayTokens;
    constructor(stateDir: string, localAgent: string);
    /**
     * Initiate a handshake with a target agent.
     * Generates ephemeral keys and returns a hello payload to send.
     */
    initiateHandshake(targetAgent: string): {
        payload: HelloPayload;
    } | {
        error: string;
    };
    /**
     * Handle an incoming hello from another agent.
     *
     * If we already sent a hello to this agent (glare), resolve by pubkey ordering:
     * the agent with the lexicographically lower Ed25519 public key wins (keeps initiator role).
     *
     * Returns a hello response payload (with challenge response) or a confirm payload.
     */
    handleHello(hello: HelloPayload): {
        payload: HelloPayload;
    } | {
        error: string;
    };
    /**
     * Handle an incoming confirm from the agent that responded to our hello.
     * This is the final step — both sides now derive the relay token.
     *
     * Can also handle the hello-response (when we are the initiator and receive
     * the responder's hello with their challenge response).
     */
    handleConfirm(confirm: ConfirmPayload): {
        relayToken: string;
    } | {
        error: string;
    };
    /**
     * Process the responder's hello (as initiator).
     * The responder's hello includes their challenge response to our nonce,
     * plus their own nonce for us to respond to.
     *
     * Returns a confirm payload for us to send, plus the derived relay token.
     */
    handleHelloResponse(hello: HelloPayload): {
        confirmPayload: ConfirmPayload;
        relayToken: string;
    } | {
        error: string;
    };
    /**
     * Get the stored relay token for a paired agent.
     * Returns hex-encoded token or null if not paired.
     */
    getRelayToken(agentName: string): string | null;
    /**
     * Check if a relay token is valid for a given agent.
     */
    validateRelayToken(agentName: string, token: string): boolean;
    /**
     * Check if a handshake is currently in progress with an agent.
     */
    isHandshakeInProgress(agentName: string): boolean;
    /**
     * Get the local agent's identity public key (hex).
     */
    getIdentityPublicKey(): string;
    /**
     * List all paired agents with relay tokens.
     */
    listPairedAgents(): Array<{
        agent: string;
        establishedAt: string;
    }>;
    private getOrCreateIdentity;
    private loadIdentity;
    private loadRelayTokens;
    private saveRelayTokens;
    private checkRateLimit;
    private recordAttempt;
    private recordFailure;
    private ensureDirs;
}
//# sourceMappingURL=HandshakeManager.d.ts.map