/**
 * LlmRateGate — actuator primitive for the burn-detection auto-heal system.
 *
 * Phase 1 shipped the no-op shape. Phase 4 upgrades the gate into a stateful
 * actuator: the burn-throttle runbook installs throttles via `installThrottle`,
 * the LLM callers consult `shouldFire` / `decide`, and a throttle auto-expires
 * after its TTL elapses. Per the umbrella spec §"Signal-vs-Authority
 * Decomposition", the gate enforces decisions made elsewhere — it never
 * decides anything on its own.
 *
 * State: in-memory only. The throttle store is process-local. If the agent
 * restarts, any in-memory throttle is dropped — which is the right default
 * (a restart is itself a reset, and the burn-detector will re-emit any
 * surviving signal within 60s). Persistent throttles for scheduled-job cron
 * entries live in a separate file (`.instar/jobs.json.throttle-overrides`,
 * HMAC-signed) handled by the scheduler — out of scope for this primitive.
 *
 * Authority: the gate accepts throttles only via `installThrottle`, which the
 * runbook calls with a capability token. The token is verified by the gate
 * against the agent's HMAC key (passed at constructor time when the gate
 * needs to enforce, or skipped for tests). When no key is configured, the
 * gate accepts throttles without verification — that's the "trusted local
 * caller" mode used by the runbook before the F-8 capability surface fully
 * lands. The verification path is in place so the runbook can switch to
 * signed tokens without API churn.
 */

import crypto from 'node:crypto';

export interface LlmRateGateDecision {
  /** Whether the gate currently allows the next LLM call for this key. */
  allowed: boolean;
  /** ISO timestamp the decision was made (debug / log). */
  decidedAt: string;
  /** Why — for log + verification trace. */
  reason:
    | 'no-throttle-installed'
    | 'throttle-active'
    | 'throttle-expired'
    | 'runbook-self-exempt';
  /** When the active throttle (if any) expires. Phase 4: ISO timestamp. */
  throttleExpiresAt?: string;
}

export interface InstalledThrottle {
  attributionKey: string;
  /** ISO timestamp when the throttle was installed. */
  installedAt: string;
  /** ISO timestamp when the throttle auto-reverts. */
  expiresAt: string;
  /** Free-text reason the runbook chose this throttle. */
  reason: string;
  /** Issuer identity (the runbook). Audit trail only. */
  issuer: string;
}

export interface InstallThrottleInput {
  attributionKey: string;
  /** Throttle duration in milliseconds (auto-reverts when elapsed). */
  durationMs: number;
  /** Free-text reason for audit. */
  reason: string;
  /** Issuer identity for audit (e.g. 'burn-throttle-runbook'). */
  issuer: string;
  /**
   * Unique identifier for the originating burn signal. Used by the gate as a
   * replay-prevention nonce — once consumed, the same signalId cannot install
   * another throttle. The runbook derives this from the DegradationEvent's
   * monotonic timestamp + attribution key. Reviewer-required (Phase 4
   * second-pass review §1) to close the infinite-replay window on captured
   * capability tokens.
   */
  signalId: string;
  /**
   * Capability token over the canonical install payload. When the gate has
   * an HMAC key configured (production), the token MUST be present and
   * valid. When no key is configured (tests / pre-F-8 wiring), the token
   * is ignored — see the class doc for the "trusted local caller" caveat
   * (the HMAC defends external/cross-process forgery, not in-process mints).
   */
  capabilityToken?: string;
}

export interface LlmRateGateOptions {
  /**
   * Optional HMAC key for capability-token verification. When set, every
   * installThrottle call must include a valid `capabilityToken` over the
   * canonical payload.
   */
  capabilityKey?: Buffer | null;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class LlmRateGate {
  private static singleton: LlmRateGate | null = null;
  private readonly throttles = new Map<string, InstalledThrottle>();
  private readonly capabilityKey: Buffer | null;
  private readonly now: () => number;
  /**
   * Consumed signal IDs — replay-prevention nonces. Per Phase 4 second-pass
   * review §1. Garbage-collected lazily during `installThrottle`: entries
   * older than the maximum throttle TTL (2× the longest seen) can be
   * dropped because their corresponding throttle has long since expired.
   */
  private readonly consumedSignalIds = new Map<string, number>();
  /** Tracks the longest throttle duration seen, used for GC of consumed IDs. */
  private maxThrottleDurationMs = 60 * 60 * 1000;

  constructor(opts?: LlmRateGateOptions) {
    this.capabilityKey = opts?.capabilityKey ?? null;
    this.now = opts?.now ?? (() => Date.now());
  }

  /**
   * Process-wide singleton. Tests should use `new LlmRateGate()` + `reset()`
   * rather than this accessor, so they don't bleed throttles into each other.
   */
  static instance(): LlmRateGate {
    if (!LlmRateGate.singleton) {
      LlmRateGate.singleton = new LlmRateGate();
    }
    return LlmRateGate.singleton;
  }

  /**
   * Read-side: does the gate currently allow a call for this key?
   *
   * @param attributionKey componentName::promptFingerprint. Reserved prefix
   *                       `burn-throttle-runbook::*` is structurally exempt
   *                       (self-reinforcing-loop guard).
   */
  shouldFire(attributionKey: string): boolean {
    return this.decide(attributionKey).allowed;
  }

  decide(attributionKey: string): LlmRateGateDecision {
    const decidedAt = new Date(this.now()).toISOString();
    if (attributionKey.startsWith('burn-throttle-runbook::')) {
      return { allowed: true, decidedAt, reason: 'runbook-self-exempt' };
    }
    const throttle = this.throttles.get(attributionKey);
    if (!throttle) {
      return { allowed: true, decidedAt, reason: 'no-throttle-installed' };
    }
    const expiresMs = Date.parse(throttle.expiresAt);
    if (Number.isNaN(expiresMs) || this.now() >= expiresMs) {
      // Auto-revert on read — keeps the map small and avoids stale reads.
      this.throttles.delete(attributionKey);
      return { allowed: true, decidedAt, reason: 'throttle-expired' };
    }
    return {
      allowed: false,
      decidedAt,
      reason: 'throttle-active',
      throttleExpiresAt: throttle.expiresAt,
    };
  }

  /**
   * Install a throttle for an attribution key. Called by the burn-throttle
   * runbook. Refuses keys with the runbook-self exempt prefix as a defence
   * in depth (the gate also exempts on the read path).
   *
   * Returns the InstalledThrottle if accepted, or throws on:
   *   - Self-attribution attempts.
   *   - Capability-token verification failure (when key is configured).
   *   - Zero/negative duration.
   */
  installThrottle(input: InstallThrottleInput): InstalledThrottle {
    if (input.attributionKey.startsWith('burn-throttle-runbook::')) {
      throw new Error('Refusing to install throttle on runbook-self attribution key (self-reinforcing-loop guard).');
    }
    if (input.durationMs <= 0) {
      throw new Error(`Throttle duration must be positive (got ${input.durationMs}).`);
    }
    if (!input.signalId || input.signalId.length === 0) {
      throw new Error('LlmRateGate.installThrottle: signalId is required (replay-prevention nonce).');
    }

    // Replay-prevention: a signalId may install at most one throttle. The
    // map is GC'd lazily below. Per Phase 4 second-pass review §1.
    if (this.consumedSignalIds.has(input.signalId)) {
      throw new Error(`LlmRateGate.installThrottle: signalId ${input.signalId} has already been consumed (replay refused).`);
    }

    // Capability-token verification when a key is configured. The canonical
    // payload includes signalId so captured tokens cannot be replayed with a
    // different signal context.
    if (this.capabilityKey) {
      const expected = this.signWithKey({
        attributionKey: input.attributionKey,
        durationMs: input.durationMs,
        issuer: input.issuer,
        signalId: input.signalId,
      });
      if (!input.capabilityToken || input.capabilityToken !== expected) {
        throw new Error('LlmRateGate.installThrottle: invalid or missing capability token.');
      }
    }

    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(nowMs + input.durationMs).toISOString();
    const throttle: InstalledThrottle = {
      attributionKey: input.attributionKey,
      installedAt: nowIso,
      expiresAt: expiresIso,
      reason: input.reason,
      issuer: input.issuer,
    };
    this.throttles.set(input.attributionKey, throttle);
    this.consumedSignalIds.set(input.signalId, nowMs);

    // Track the longest duration we've ever seen for GC bookkeeping.
    if (input.durationMs > this.maxThrottleDurationMs) {
      this.maxThrottleDurationMs = input.durationMs;
    }
    // GC consumed signal IDs older than 2x the longest throttle TTL.
    const gcCutoff = nowMs - 2 * this.maxThrottleDurationMs;
    for (const [sigId, sigTs] of this.consumedSignalIds.entries()) {
      if (sigTs < gcCutoff) this.consumedSignalIds.delete(sigId);
    }

    return throttle;
  }

  private signWithKey(payload: { attributionKey: string; durationMs: number; issuer: string; signalId: string }): string {
    const canonical = JSON.stringify({
      attributionKey: payload.attributionKey,
      durationMs: payload.durationMs,
      issuer: payload.issuer,
      signalId: payload.signalId,
    });
    return crypto.createHmac('sha256', this.capabilityKey!).update(canonical).digest('hex');
  }

  /**
   * Revoke an active throttle. Idempotent (no-op if no throttle exists).
   * Called by the Telegram inline-button handler in Phase 5 and by the
   * runbook's manual-override path.
   */
  revokeThrottle(attributionKey: string): boolean {
    return this.throttles.delete(attributionKey);
  }

  /**
   * List currently-active throttles. Used by the verification step (Phase 6)
   * and by the dashboard surface.
   */
  listActiveThrottles(): InstalledThrottle[] {
    const now = this.now();
    const active: InstalledThrottle[] = [];
    for (const [key, throttle] of this.throttles.entries()) {
      const expiresMs = Date.parse(throttle.expiresAt);
      if (!Number.isNaN(expiresMs) && now < expiresMs) {
        active.push(throttle);
      } else {
        this.throttles.delete(key);
      }
    }
    return active;
  }

  /**
   * Compute the capability token for an install payload. Used by the
   * runbook to sign its own throttle requests. Returns null when no
   * capability key is configured (test mode).
   *
   * **Threat-model note (Phase 4 second-pass review §2):** this mint and the
   * verification it pairs with both live on the same gate object, so any
   * in-process caller holding a gate reference can forge a valid token. The
   * HMAC therefore defends the **external/cross-process boundary** only
   * — chiefly the persistent throttle-overrides file the scheduler reads
   * (Phase 4-extension, not in this PR). For in-process integrity we rely
   * on the fact that all callers of LlmRateGate are instar source under
   * the same `/instar-dev` review gate. If/when the runbook is moved to a
   * separate process, this mint method should be relocated to the runbook
   * service alone and removed from the gate's API surface.
   */
  computeCapabilityToken(input: { attributionKey: string; durationMs: number; issuer: string; signalId: string }): string | null {
    if (!this.capabilityKey) return null;
    return this.signWithKey(input);
  }

  /**
   * Reset all installed throttles. Exposed for tests so a misconfigured
   * singleton can't bleed across `describe` blocks.
   */
  reset(): void {
    this.throttles.clear();
  }
}
