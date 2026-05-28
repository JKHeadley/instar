/**
 * HttpLiveTailTransport — the encrypted server-to-server wire that streams the
 * live conversation tail from the lease HOLDER to the standby (spec §8 G3b/c).
 *
 * This is the SENDER side. The holder calls broadcast() with a per-topic,
 * monotonic-sequence flush of recent conversation content; the transport:
 *   1. REDACTS the content (liveTailRedaction) BEFORE anything leaves the
 *      machine — credential categories are scrubbed at the boundary, not trusted
 *      to TLS or the receiver (spec §8 G3c: "redact/exclude secrets ... never
 *      sent in the clear over the tail").
 *   2. ENCRYPTS the redacted content for the peer using the v3 machine-to-machine
 *      scheme (encryptForSync: ephemeral X25519 key agreement + AES-256-GCM,
 *      forward-secret per flush — a fresh ephemeral key per call).
 *   3. POSTs it to the peer's /api/live-tail over the existing AUTHENTICATED
 *      machine channel (signRequest + machineAuthMiddleware on the receiver),
 *      giving mutual authentication: the receiver verifies the sender's machine
 *      identity, and only the intended receiver (holding the X25519 private key)
 *      can decrypt.
 *
 * Single-machine safe: no peers → broadcast is a reachable no-op (identical to
 * a git-only / disabled mesh, so a solo agent is unaffected).
 *
 * Only the designated next-in-line standby peer(s) receive a tail subscription
 * (the cost ceiling that keeps "more machines = more reliable, not more chatter"
 * — spec §8 G3b); peer selection is the caller's via the injected peers().
 *
 * The HTTP layer, the encryptor, and the clock are all injected so the
 * redact→encrypt→post logic is unit-testable without a network or real keys.
 */

import { signRequest } from '../server/machineAuth.js';
import { redactForLiveTail } from './liveTailRedaction.js';
import type { EncryptedSecretPayload } from './SecretStore.js';

export interface LiveTailPeer {
  machineId: string;
  /** Base URL of the peer (its lastKnownUrl / tunnel URL). */
  url: string;
  /** Peer's X25519 encryption public key (base64) — from the mesh registry. */
  encryptionPublicKey: string;
}

/** What actually travels on the wire — the content is encrypted, never plaintext. */
export interface LiveTailFlushWire {
  topic: string;
  seq: number;
  enc: EncryptedSecretPayload;
  /** The redaction category-set version the sender applied (spec §8 G3c). */
  redactionVersion: number;
}

export interface HttpLiveTailTransportDeps {
  selfMachineId: string;
  signingKeyPem: string;
  /** Resolve the next-in-line standby peer(s) to push the live tail to (excludes self). */
  peers: () => LiveTailPeer[];
  /** Monotonic per-request sequence for machine-auth replay protection. */
  nextSequence: () => number;
  /**
   * Encrypt already-redacted content for a recipient's X25519 public key (base64).
   * Wired to SecretStore.encryptForSync in production; injected for tests.
   */
  encryptFor: (content: string, recipientEncPubB64: string) => EncryptedSecretPayload;
  /** Injected fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** How recent a successful broadcast counts as "reachable". Default = 60s. */
  reachabilityWindowMs?: number;
  now?: () => number;
  logger?: (msg: string) => void;
}

export interface LiveTailFlushInput {
  topic: string;
  /** Per-topic monotonic sequence (the standby applies only lastAppliedSeq+1). */
  seq: number;
  /** Raw (un-redacted) tail content for this flush. */
  content: string;
}

export class HttpLiveTailTransport {
  private readonly d: HttpLiveTailTransportDeps;
  private lastBroadcastOkAt = 0;
  private readonly windowMs: number;

  constructor(deps: HttpLiveTailTransportDeps) {
    this.d = deps;
    this.windowMs = deps.reachabilityWindowMs ?? 60_000;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private log(m: string): void {
    this.d.logger?.(`[live-tail-wire] ${m}`);
  }

  /**
   * Redact → encrypt → POST a flush to every standby peer over the authenticated
   * channel. Resolves true if at least one peer accepted (a live medium exists);
   * false if no peer was reachable. No peers → a reachable no-op (true).
   */
  async broadcast(flush: LiveTailFlushInput): Promise<boolean> {
    const peers = this.d.peers();
    if (peers.length === 0) {
      this.lastBroadcastOkAt = this.now();
      return true;
    }
    // Redact ONCE before anything leaves the machine — same content for all peers.
    const redacted = redactForLiveTail(flush.content);
    if (redacted.redactedCount > 0) {
      this.log(`redacted ${redacted.redactedCount} secret(s) [${redacted.categories.join(',')}] before send`);
    }
    const fetchImpl = this.d.fetchImpl ?? fetch;
    let anyOk = false;
    await Promise.all(
      peers.map(async (peer) => {
        try {
          // Per-flush forward-secret encryption (fresh ephemeral key per call).
          const enc = this.d.encryptFor(redacted.text, peer.encryptionPublicKey);
          const body: { flush: LiveTailFlushWire } = {
            flush: { topic: flush.topic, seq: flush.seq, enc, redactionVersion: redacted.version },
          };
          const headers = signRequest(this.d.selfMachineId, this.d.signingKeyPem, body, this.d.nextSequence());
          const res = await fetchImpl(`${peer.url.replace(/\/$/, '')}/api/live-tail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
          });
          if (res && (res as Response).ok) anyOk = true;
          else this.log(`peer ${peer.machineId} rejected flush seq=${flush.seq} (status ${(res as Response)?.status})`);
        } catch (err) {
          this.log(`broadcast to ${peer.machineId} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    if (anyOk) this.lastBroadcastOkAt = this.now();
    return anyOk;
  }

  /** Whether a recent broadcast reached at least one peer (the renewal-medium check). */
  isReachable(): boolean {
    return this.now() - this.lastBroadcastOkAt <= this.windowMs;
  }
}
