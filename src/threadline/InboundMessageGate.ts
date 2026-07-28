/**
 * InboundMessageGate — Pre-filter for relay inbound messages.
 *
 * Gates on sender identity, trust level, rate limits, payload size, and replay.
 * Does NOT determine delivery mode — that's AutonomyGate's job.
 *
 * Part of PROP-relay-auto-connect.
 */

import { CREDENTIAL_SHARE_OP, type AgentTrustManager, type AgentTrustLevel } from './AgentTrustManager.js';
import type { ThreadlineRouter } from './ThreadlineRouter.js';
import type { ReceivedMessage } from './client/ThreadlineClient.js';
import { PAIR_VERIFY_OP, processPairVerifyReceipt } from './PairVerifyReceipt.js';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Verified-pairing config snapshot (spec §3.10). Read live at the chokepoint so a
 * config edit takes effect without a gate rebuild. When `enabled` is false the gate
 * is a complete pass-through — byte-identical legacy behavior.
 */
export interface VerifiedPairingGateConfig {
  /** Master flag (§3.10). Resolved (dev-gate applied) by the caller. */
  enabled: boolean;
  /** Governs inbound observability ONLY (FD10) — never the outbound refusal. */
  dryRun: boolean;
  /** Arms inbound credential-ingestion enforcement (read live). */
  credentialShareEnforced: boolean;
}

export interface InboundGateConfig {
  /** Max payload size in bytes (default: 64KB) */
  maxPayloadBytes?: number;
  /** Per-trust-level rate limits */
  rateLimits?: Partial<Record<AgentTrustLevel, { probesPerHour: number; messagesPerHour: number; messagesPerDay: number }>>;
  /**
   * THIS agent's own fingerprint — bound into pair-verify receipt verification +
   * the self-pair guard (FD12). Optional: when absent, the recipient-fp check on a
   * receipt is skipped (the sender-fp + signature checks still hold).
   */
  ownFingerprint?: string;
  /**
   * Live reader for the verified-pairing config (spec §3.10). A function so the gate
   * reads the CURRENT flag state on every message (credentialShareEnforced is read
   * live). When absent/returns enabled:false, verified-pairing is a pass-through.
   */
  getVerifiedPairingConfig?: () => VerifiedPairingGateConfig;
}

export interface GateDecision {
  action: 'pass' | 'block';
  reason?: string;
  fingerprint?: string;
  message?: ReceivedMessage;
  trustLevel?: AgentTrustLevel;
  /**
   * Set for a consumed control-plane message (e.g. a `pair-verify` receipt): the
   * gate handled it inline and it must NOT be routed onward to ThreadlineRouter.
   */
  controlPlane?: boolean;
}

/** Operations that are probes (don't spawn sessions) */
const PROBE_OPS = new Set(['ping', 'health']);

/** Default rate limits per trust level */
const DEFAULT_RATE_LIMITS: Record<AgentTrustLevel, { probesPerHour: number; messagesPerHour: number; messagesPerDay: number }> = {
  untrusted: { probesPerHour: 5, messagesPerHour: 0, messagesPerDay: 0 },
  verified: { probesPerHour: 20, messagesPerHour: 10, messagesPerDay: 50 },
  trusted: { probesPerHour: 100, messagesPerHour: 50, messagesPerDay: 200 },
  autonomous: { probesPerHour: 500, messagesPerHour: 500, messagesPerDay: 10_000 },
};

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64KB

/** Seen messageId TTL for replay protection (10 minutes) */
const SEEN_MESSAGE_TTL_MS = 10 * 60 * 1000;

// ── Rate Limiter (per-sender sliding window) ─────────────────────────

interface RateWindow {
  timestamps: number[];
}

class PerSenderRateLimiter {
  private readonly probeWindows = new Map<string, RateWindow>();
  private readonly messageHourWindows = new Map<string, RateWindow>();
  private readonly messageDayWindows = new Map<string, RateWindow>();

  isProbeRateLimited(fingerprint: string, limit: number): boolean {
    return this.isLimited(this.probeWindows, fingerprint, limit, 60 * 60 * 1000);
  }

  isMessageHourLimited(fingerprint: string, limit: number): boolean {
    if (limit <= 0) return true; // 0 = blocked
    return this.isLimited(this.messageHourWindows, fingerprint, limit, 60 * 60 * 1000);
  }

  isMessageDayLimited(fingerprint: string, limit: number): boolean {
    if (limit <= 0) return true;
    return this.isLimited(this.messageDayWindows, fingerprint, limit, 24 * 60 * 60 * 1000);
  }

  private isLimited(windows: Map<string, RateWindow>, key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    let window = windows.get(key);
    if (!window) {
      window = { timestamps: [] };
      windows.set(key, window);
    }

    // Prune expired timestamps
    window.timestamps = window.timestamps.filter(t => now - t < windowMs);

    if (window.timestamps.length >= limit) {
      return true;
    }

    window.timestamps.push(now);
    return false;
  }

  /**
   * Evict stale entries to prevent unbounded memory growth.
   */
  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    for (const windows of [this.probeWindows, this.messageHourWindows, this.messageDayWindows]) {
      for (const [key, window] of windows) {
        window.timestamps = window.timestamps.filter(t => now - t < maxAgeMs);
        if (window.timestamps.length === 0) {
          windows.delete(key);
        }
      }
    }
  }
}

// ── Implementation ───────────────────────────────────────────────────

export class InboundMessageGate {
  private readonly trustManager: AgentTrustManager;
  private router: ThreadlineRouter | null;
  private readonly config: InboundGateConfig;
  private readonly rateLimiter = new PerSenderRateLimiter();
  private readonly maxPayloadBytes: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Seen messageId cache for replay protection */
  private readonly seenMessageIds = new Map<string, number>();

  // Metrics
  private metrics = {
    passed: 0,
    blocked: 0,
    blockedByTrust: 0,
    blockedByRate: 0,
    blockedBySize: 0,
    blockedByReplay: 0,
    probesHandled: 0,
    pairVerifyProcessed: 0,
    pairVerifyDropped: 0,
    credentialBlocked: 0,
    credentialDryRunWouldBlock: 0,
  };

  constructor(
    trustManager: AgentTrustManager,
    router: ThreadlineRouter | null,
    config: InboundGateConfig = {},
  ) {
    this.trustManager = trustManager;
    this.router = router;
    this.config = config;
    this.maxPayloadBytes = config.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;

    // Periodic cleanup of rate limiter state and seen-messageId cache (every 30 minutes)
    this.cleanupTimer = setInterval(() => {
      this.rateLimiter.cleanup();
      this.pruneSeenMessageIds();
    }, 30 * 60 * 1000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /**
   * Late-bind the router after server initialization.
   * The router isn't available at bootstrap time — it's created in server.ts
   * after the Threadline bootstrap completes.
   */
  setRouter(router: ThreadlineRouter): void {
    this.router = router;
  }

  /**
   * Evaluate an inbound relay message.
   * Returns 'pass' to route to ThreadlineRouter/AutonomyGate,
   * or 'block' with reason.
   */
  async evaluate(message: ReceivedMessage): Promise<GateDecision> {
    const fingerprint = message.from;

    // 0a. Replay protection — check seen-messageId cache
    const messageId = this.extractMessageId(message);
    if (messageId && this.seenMessageIds.has(messageId)) {
      this.metrics.blocked++;
      this.metrics.blockedByReplay++;
      this.logBlock('replay_detected', fingerprint);
      return { action: 'block', reason: 'replay_detected', fingerprint };
    }

    // 0b. Payload size check
    const payloadSize = this.estimatePayloadSize(message);
    if (payloadSize > this.maxPayloadBytes) {
      this.metrics.blocked++;
      this.metrics.blockedBySize++;
      this.logBlock('payload_too_large', fingerprint, `bytes=${payloadSize}`);
      return { action: 'block', reason: 'payload_too_large', fingerprint };
    }

    // 1. Determine operation type
    const opType = this.classifyOperation(message);
    const isProbe = PROBE_OPS.has(opType);

    // Resolve the verified-pairing config ONCE (read live so credentialShareEnforced
    // takes effect without a restart, §3.10). enabled:false ⇒ complete pass-through.
    const vp = this.resolveVerifiedPairingConfig();

    // 1a. pair-verify control-plane message (spec §3.4) — processed BEFORE the trust
    // gate (gate-EXEMPT for the trust-level gate, like a probe). Still subject to the
    // replay+size cheap rejections above; the receipt handler itself does strict schema
    // validation, Ed25519 signature verification against the BOUND identity key, and the
    // pairingId/sasFingerprint/pending-state checks. It is NEVER routed onward and NEVER
    // subject to the credential gate. Only handled when verified-pairing is enabled.
    if (vp.enabled && opType === PAIR_VERIFY_OP) {
      const rawPayload = this.extractControlPayload(message);
      const outcome = processPairVerifyReceipt(this.trustManager, fingerprint, rawPayload, this.config.ownFingerprint);
      if (messageId) this.seenMessageIds.set(messageId, Date.now());
      if (outcome.processed) {
        this.metrics.pairVerifyProcessed++;
        console.log(`[inbound-gate] pair-verify ACCEPTED from=${fingerprint.slice(0, 12)} (peerAcked set)`);
      } else {
        this.metrics.pairVerifyDropped++;
        // No state change on a failing receipt (spec §3.4). Drop with a visible reason.
        this.logBlock('pair_verify_dropped', fingerprint, `reason=${outcome.reason}`);
      }
      // Consumed control-plane message: handled inline, do NOT route onward.
      return { action: 'block', reason: 'pair-verify', fingerprint, controlPlane: true };
    }

    // 2. Trust check (keyed by fingerprint)
    const trust = this.trustManager.getTrustLevelByFingerprint(fingerprint);
    const limits = this.getRateLimits(trust);

    // 2a. Inbound credential-ingestion gate (spec §3.5 / FD5). The security boundary
    // is the RESOLVED SENDER trust source (mutual-verified), NOT the message's
    // self-declared kind or content. An explicit kind:'credential-share' is a fast-path
    // courtesy ONLY — it is NOT the security boundary (FD5). When enforcement is armed
    // (credentialShareEnforced), an inbound that would be acted on AS a credential from a
    // non-mutual-verified sender is REFUSED (fail-closed, FD9). dryRun governs THIS side's
    // observability ONLY — it LOGS the verdict it WOULD apply but still passes (FD10);
    // the OUTBOUND refusal (the relay-send funnel) is always live regardless of dryRun.
    // When verified-pairing is enabled, the credential gate is the AUTHORITATIVE
    // decision for the credential op — it short-circuits the generic step-4 op check
    // (which would also reject `credential-share` for a non-mutual-verified peer). This
    // is what makes dryRun's "observe, don't enforce" semantics actually observable
    // (FD10): under dryRun the verdict is logged but the message still passes onward.
    if (vp.enabled && opType === CREDENTIAL_SHARE_OP) {
      let allowed = false;
      try {
        allowed = this.trustManager.isCredentialShareAllowedByFingerprint(fingerprint);
      } catch {
        allowed = false; // FD9 — any uncertainty fails closed.
      }
      if (allowed) {
        // Mutual-verified sender: record + pass (the only inbound credential PASS path).
        this.trustManager.recordMessageReceivedByFingerprint(fingerprint);
        if (messageId) this.seenMessageIds.set(messageId, Date.now());
        this.metrics.passed++;
        console.log(`[inbound-gate] PASS credential from=${fingerprint.slice(0, 12)} trust=${trust} (mutual-verified)`);
        return { action: 'pass', message, trustLevel: trust };
      }
      if (vp.credentialShareEnforced && !vp.dryRun) {
        // Armed + live: REFUSE (fail-closed, §3.5/FD5/FD9).
        this.metrics.blocked++;
        this.metrics.credentialBlocked++;
        this.logBlock('credential_not_mutually_verified', fingerprint, `trust=${trust}`);
        return { action: 'block', reason: 'credential_not_mutually_verified', fingerprint };
      }
      // dryRun (or not-yet-armed): observe only — log the verdict it WOULD apply, then
      // PASS (FD10 — inbound observability never enforces; the outbound gate is live).
      this.metrics.credentialDryRunWouldBlock++;
      this.trustManager.recordMessageReceivedByFingerprint(fingerprint);
      if (messageId) this.seenMessageIds.set(messageId, Date.now());
      this.metrics.passed++;
      console.log(`[inbound-gate] credential WOULD-BLOCK (dryRun/observe) from=${fingerprint.slice(0, 12)} trust=${trust} enforced=${vp.credentialShareEnforced} — passing`);
      return { action: 'pass', message, trustLevel: trust };
    }

    // Observability: every inbound evaluation is logged with the RESOLVED trust
    // level + operation. A silently-blocked inbound (e.g. a trusted peer whose
    // fingerprint representation does not match its trust-profile key → resolves
    // 'untrusted' → insufficient_trust) is exactly how an A2A leg can go dark for
    // days unnoticed. Making the gate's verdict visible is the structural fix for
    // "comms must never die silently".
    console.log(`[inbound-gate] eval from=${fingerprint.slice(0, 12)} trust=${trust} op=${opType}${isProbe ? ' (probe)' : ''}`);

    // 3. Handle probes (don't require 'message' permission)
    if (isProbe) {
      if (this.rateLimiter.isProbeRateLimited(fingerprint, limits.probesPerHour)) {
        this.metrics.blocked++;
        this.metrics.blockedByRate++;
        this.logBlock('probe_rate_limited', fingerprint, `trust=${trust}`);
        return { action: 'block', reason: 'probe_rate_limited', fingerprint };
      }
      this.metrics.probesHandled++;
      // Probes are handled inline — return pass with probe flag
      return { action: 'pass', message, trustLevel: trust, reason: 'probe' };
    }

    // 4. Message permission check
    const allowedOps = this.trustManager.getAllowedOperationsByFingerprint(fingerprint);
    if (!allowedOps.includes(opType)) {
      this.metrics.blocked++;
      this.metrics.blockedByTrust++;
      this.logBlock('insufficient_trust', fingerprint, `trust=${trust} op=${opType} allowed=[${allowedOps.join(',')}]`);
      return { action: 'block', reason: 'insufficient_trust', fingerprint };
    }

    // 5. Rate limit check (per-sender, trust-level-aware)
    if (this.rateLimiter.isMessageHourLimited(fingerprint, limits.messagesPerHour)) {
      this.metrics.blocked++;
      this.metrics.blockedByRate++;
      this.logBlock('rate_limited_hourly', fingerprint, `trust=${trust} limit=${limits.messagesPerHour}`);
      return { action: 'block', reason: 'rate_limited_hourly', fingerprint };
    }
    if (this.rateLimiter.isMessageDayLimited(fingerprint, limits.messagesPerDay)) {
      this.metrics.blocked++;
      this.metrics.blockedByRate++;
      this.logBlock('rate_limited_daily', fingerprint, `trust=${trust} limit=${limits.messagesPerDay}`);
      return { action: 'block', reason: 'rate_limited_daily', fingerprint };
    }

    // 6. Record interaction (debounced)
    this.trustManager.recordMessageReceivedByFingerprint(fingerprint);

    // 7. Record messageId for replay protection
    if (messageId) {
      this.seenMessageIds.set(messageId, Date.now());
    }

    // 8. Pass to ThreadlineRouter -> AutonomyGate handles delivery mode
    this.metrics.passed++;
    console.log(`[inbound-gate] PASS from=${fingerprint.slice(0, 12)} trust=${trust} op=${opType}`);
    return { action: 'pass', message, trustLevel: trust };
  }

  /**
   * Log a block decision to server.log. A blocked inbound is otherwise silent
   * (the decision lives only in the returned GateDecision + in-memory metric
   * counters), which is precisely how an Echo↔peer A2A leg can go dark for days
   * with no trace. The fingerprint is truncated; no payload content is logged.
   */
  private logBlock(reason: string, fingerprint: string, extra?: string): void {
    console.log(`[inbound-gate] BLOCK ${reason} from=${fingerprint.slice(0, 12)}${extra ? ` ${extra}` : ''}`);
  }

  /**
   * Get gate metrics for observability.
   */
  getMetrics() {
    return { ...this.metrics };
  }

  /**
   * Shutdown: cleanup timers.
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ── Private ─────────────────────────────────────────────────────

  private classifyOperation(message: ReceivedMessage): string {
    // Check for explicit operation type in content
    const content = message.content;
    if (typeof content === 'object' && content !== null && 'type' in content) {
      return (content as { type: string }).type;
    }
    // Default: treat as 'message'
    return 'message';
  }

  /**
   * Resolve the verified-pairing config live (spec §3.10). Defaults to a complete
   * pass-through (enabled:false) when no reader is wired, so legacy behavior is
   * byte-identical on a non-pairing agent.
   */
  private resolveVerifiedPairingConfig(): VerifiedPairingGateConfig {
    try {
      const v = this.config.getVerifiedPairingConfig?.();
      if (v) return v;
    } catch {
      // A broken config reader must never break inbound evaluation — pass through.
    }
    return { enabled: false, dryRun: true, credentialShareEnforced: false };
  }

  /**
   * Extract the control-plane payload object (e.g. a pair-verify receipt) from an
   * inbound message. The receipt fields ride alongside `type` on the content object.
   */
  private extractControlPayload(message: ReceivedMessage): unknown {
    const content = message.content;
    if (typeof content === 'object' && content !== null) return content;
    return null;
  }

  private estimatePayloadSize(message: ReceivedMessage): number {
    try {
      return Buffer.byteLength(JSON.stringify(message.content), 'utf-8');
    } catch {
      return 0;
    }
  }

  private getRateLimits(trust: AgentTrustLevel) {
    return {
      ...DEFAULT_RATE_LIMITS[trust],
      ...this.config.rateLimits?.[trust],
    };
  }

  /**
   * Extract messageId from a ReceivedMessage.
   */
  private extractMessageId(message: ReceivedMessage): string | null {
    // ReceivedMessage has a messageId field directly
    if (message.messageId) return message.messageId;
    // Also check content for a messageId field
    if (typeof message.content === 'object' && message.content !== null) {
      const c = message.content as unknown as Record<string, unknown>;
      if (typeof c.messageId === 'string') return c.messageId;
    }
    return null;
  }

  /**
   * Prune expired entries from the seen-messageId cache.
   */
  private pruneSeenMessageIds(): void {
    const now = Date.now();
    for (const [id, timestamp] of this.seenMessageIds) {
      if (now - timestamp > SEEN_MESSAGE_TTL_MS) {
        this.seenMessageIds.delete(id);
      }
    }
  }
}
