/**
 * TunnelProvider — abstraction over the underlying tunnel implementation.
 *
 * Per spec specs/dev-infrastructure/tunnel-failure-resilience.md Part 1:
 * the TunnelManager is the single owner of the lifecycle state machine,
 * and each backend (cloudflared quick, cloudflared named, localtunnel,
 * bore) implements this interface. The manager treats providers as
 * interchangeable units; trust-tier ordering (Tier 1 vs Tier 2) and the
 * consent gate live in the manager, NOT in the providers themselves.
 *
 * Two tiers:
 *   - Tier 1: automatic, secure. Cloudflare providers. Tried silently.
 *   - Tier 2: consent-gated relays. localtunnel, bore. Never activated
 *     without explicit owner approval recorded against the episode.
 *
 * Every provider's `start()` MUST resolve only after the URL has passed
 * a post-start reachability probe (verified by the manager via the
 * /health endpoint through the public URL). A URL that emits from
 * cloudflared but doesn't actually serve (e.g. localtunnel interstitial,
 * bore.pub down) is NOT counted as `active` — that prevents a false
 * "back online" broadcast for a dead link.
 *
 * The provider does NOT decide retry, fallback, or notification — those
 * are the manager's responsibility. Provider responsibilities are
 * narrowly: spawn the backend, surface the URL, surface a stop handle.
 */

/** Trust tier — Tier 1 is automatic/secure, Tier 2 is consent-gated. */
export type ProviderTier = 1 | 2;

/** Stable identifier the manager uses to route episode/consent records. */
export type ProviderName =
  | 'cloudflare-named'
  | 'cloudflare-quick'
  | 'localtunnel'
  | 'bore';

export interface TunnelProviderHandle {
  /** The public URL the provider exposes. */
  readonly url: string;
  /**
   * Stop the provider. MUST escalate SIGINT → SIGKILL with PID
   * verification (mirror the existing `forceStop()` pattern) so the
   * manager can guarantee no relay child lingers across a self-heal
   * switch-back. Tunnel teardown is security-load-bearing for Tier 2.
   */
  stop(): Promise<void>;
}

export interface TunnelProvider {
  /** Stable name routed through episode/consent records and audit logs. */
  readonly name: ProviderName;

  /** Trust tier — manager uses this to decide whether the consent gate applies. */
  readonly tier: ProviderTier;

  /**
   * True if the provider can be started in this environment without further
   * user setup. Used by the manager to filter the provider pool BEFORE
   * declaring `exhausted`. Reasons for `false`: required binary missing,
   * required token/credentials not configured, OS unsupported, etc.
   *
   * The manager calls this once per episode (cheap signal), not per attempt.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Start the provider against the given local port. Resolves with the
   * URL + a stop handle when the URL is emitted by the backend. The
   * manager performs the reachability probe AFTER resolution and before
   * transitioning to `active`; providers MUST NOT do their own probing
   * here (the manager owns post-start verification per spec Part 1).
   *
   * Implementations should reject with a structured Error whose `message`
   * carries the classification the manager will surface to the notifier
   * (e.g. "rate-limited (HTTP 429 / Cloudflare 1015)", "binary missing",
   * "network unreachable", "process exited code 1"). The manager parses
   * these strings into ProviderFailureReason classifications.
   */
  start(localPort: number): Promise<TunnelProviderHandle>;
}

/**
 * Classification the manager applies to a provider failure for the
 * notifier and for deciding whether to advance to the next provider.
 *
 * The classification is owned by the manager (not the provider) per the
 * signal-vs-authority discipline: providers raise errors with reason
 * strings; the manager classifies into this enum and routes accordingly.
 */
export type ProviderFailureReason =
  | 'rate-limited'         // Cloudflare 429 / 1015; localtunnel rate-limit
  | 'binary-missing'       // isAvailable() returned false OR start() failed because the binary isn't installed
  | 'network'              // DNS/network unreachable
  | 'process-exit'         // child exited non-zero for an unknown reason
  | 'timeout'              // URL didn't emit within the start timeout
  | 'reachability-failed'  // URL emitted but post-start /health probe didn't succeed
  | 'unknown';
