/**
 * bootRegistration — production registration of the Anthropic adapters.
 *
 * This is the "separate cycle" deferred when the Phase-5 routing policy was
 * installed at server boot: the policy was wired but NO adapters were ever
 * registered against the providers registry, so `registry.resolve()` had
 * nothing to choose between and the cost-aware routing was a no-op. This
 * module closes that gap (Rule 1 of
 * specs/provider-portability/04-anthropic-path-constraints.md — the
 * subscription-backed interactive pool must be an operational floor, not a
 * designed-only one).
 *
 * Properties (all load-bearing for the server boot path):
 *   - GATED: never registers Claude adapters on a codex-only agent
 *     (process-level claudeForbidden flag + enabledFrameworks check).
 *   - IDEMPOTENT: re-entering startServer in the same process (tests,
 *     in-proc respawn) does not double-register or clobber.
 *   - LAZY: registration spawns NOTHING. Both adapter factories are pure
 *     in-memory construction; the interactive pool only spawns tmux REPL
 *     sessions on first use (or an explicit `start()`).
 *   - HONEST CREDIT READS: `readSdkCredit` is plumbed from the headless
 *     adapter's UsageMeterProvider (GET /api/oauth/usage). Unknown state
 *     (no OAuth credential, API error, no agentSdkCredit field yet) returns
 *     null, which the CostAwareRoutingPolicy treats as "fall to the
 *     subscription floor" — conservative by design.
 */

import { registry as defaultRegistry, Registry, type ProviderAdapter } from './registry.js';
import { CapabilityFlag } from './capabilities.js';
import type { ProviderId } from './types.js';
import type {
  AgentSdkCreditSnapshot,
  UsageMeterProvider,
} from './primitives/observability/usageMeterProvider.js';
import {
  createAnthropicHeadlessAdapter,
  ANTHROPIC_HEADLESS_ID,
  type AnthropicHeadlessConfig,
} from './adapters/anthropic-headless/index.js';
import {
  createAnthropicInteractivePoolAdapter,
  ANTHROPIC_INTERACTIVE_POOL_ID,
  type InteractivePoolAdapter,
} from './adapters/anthropic-interactive-pool/index.js';
import type { InteractivePoolConfig } from './adapters/anthropic-interactive-pool/config.js';
import { isClaudeForbidden } from '../core/claudeForbiddenGuard.js';

export interface RegisterAnthropicAdaptersOptions {
  /**
   * The agent's enabled frameworks (InstarConfig.enabledFrameworks). When
   * unset or empty, defaults to ['claude-code'] — the historical behavior,
   * matching the migrator's reading of the same field.
   */
  enabledFrameworks?: ReadonlyArray<string>;
  /** Detected `claude` binary path. Unset → adapter env defaults. */
  claudePath?: string;
  /** Detected `tmux` binary path. Unset → adapter env defaults. */
  tmuxPath?: string;
  /** Overrides for the headless adapter config (credential, model, ...). */
  headless?: Partial<AnthropicHeadlessConfig>;
  /** Overrides for the interactive-pool config (poolSize, model, workingDirectory, ...). */
  pool?: Partial<InteractivePoolConfig>;
  /** Registry to register against. Defaults to the module singleton. */
  registryInstance?: Registry;
  /** TTL for the cached SDK-credit read (ms). Default 60s. */
  creditCacheTtlMs?: number;
}

export interface RegisterAnthropicAdaptersResult {
  /** Adapter ids newly registered by THIS call. */
  registered: ProviderId[];
  /** Adapter ids that were already present (idempotent re-entry). */
  alreadyRegistered: ProviderId[];
  /** Set when the gate skipped registration entirely. */
  skippedReason?: 'claude-forbidden' | 'claude-code-not-enabled';
  /** The headless adapter (undefined when skipped). */
  headless?: ProviderAdapter;
  /** The interactive-pool adapter (undefined when skipped). */
  pool?: InteractivePoolAdapter;
  /**
   * Real SDK-credit reader for CostAwareRoutingPolicy. Returns null when
   * the state is unknown (skipped registration, no credential, API error,
   * or Anthropic not yet exposing the credit pot) — never throws.
   */
  readSdkCredit: () => Promise<AgentSdkCreditSnapshot | null>;
}

const NULL_CREDIT: () => Promise<AgentSdkCreditSnapshot | null> = async () => null;

/**
 * Build a TTL-cached SDK-credit reader from the headless adapter's
 * UsageMeterProvider. Bounded cost: at most one GET /api/oauth/usage per
 * TTL window regardless of routing-decision volume.
 */
export function buildReadSdkCredit(
  headless: ProviderAdapter,
  ttlMs = 60_000,
): () => Promise<AgentSdkCreditSnapshot | null> {
  let cachedAt = 0;
  let cached: AgentSdkCreditSnapshot | null = null;
  let inFlight: Promise<AgentSdkCreditSnapshot | null> | null = null;

  return async () => {
    const now = Date.now();
    if (now - cachedAt < ttlMs) return cached;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const meter = headless.primitive(CapabilityFlag.UsageMeterProvider) as UsageMeterProvider;
        const snapshot = await meter.read();
        cached = snapshot?.agentSdkCredit ?? null;
      } catch {
        // @silent-fallback-ok — meter errors are expected (no OAuth
        // credential, transient API failure); unknown state = null and the
        // CostAwareRoutingPolicy conservatively falls to the subscription
        // floor. Never throw into a routing decision.
        cached = null;
      } finally {
        // finally, not tail code: even an unforeseeable throw between the
        // catch and here must never wedge the reader with a stale inFlight.
        cachedAt = Date.now();
        inFlight = null;
      }
      return cached;
    })();
    return inFlight;
  };
}

/**
 * Single-flight guard: concurrent registerAnthropicAdapters calls against
 * the SAME registry instance await one shared registration instead of
 * racing get()-then-register() (Registry.register throws on duplicates, so
 * a TOCTOU race would make the loser throw — breaking the idempotency
 * contract under exactly the re-entrant boots it exists for).
 */
const inFlightByRegistry = new WeakMap<Registry, Promise<RegisterAnthropicAdaptersResult>>();

/**
 * Register both Anthropic adapters with the providers registry, gated and
 * idempotent (including under concurrent calls). See module docstring for
 * the contract.
 */
export async function registerAnthropicAdapters(
  options: RegisterAnthropicAdaptersOptions = {},
): Promise<RegisterAnthropicAdaptersResult> {
  const targetRegistry = options.registryInstance ?? defaultRegistry;
  const existing = inFlightByRegistry.get(targetRegistry);
  if (existing) return existing;
  const run = registerAnthropicAdaptersInner(options, targetRegistry).finally(() => {
    inFlightByRegistry.delete(targetRegistry);
  });
  inFlightByRegistry.set(targetRegistry, run);
  return run;
}

async function registerAnthropicAdaptersInner(
  options: RegisterAnthropicAdaptersOptions,
  reg: Registry,
): Promise<RegisterAnthropicAdaptersResult> {
  // Gate 1 — process-level codex-only enforcement (mirrors the
  // ClaudeCliIntelligenceProvider constructor guard).
  if (isClaudeForbidden()) {
    return {
      registered: [],
      alreadyRegistered: [],
      skippedReason: 'claude-forbidden',
      readSdkCredit: NULL_CREDIT,
    };
  }

  // Gate 2 — enabledFrameworks. Unset/empty defaults to ['claude-code']
  // (historical behavior; mirrors PostUpdateMigrator's reading).
  const frameworks =
    options.enabledFrameworks && options.enabledFrameworks.length > 0
      ? options.enabledFrameworks
      : ['claude-code'];
  if (!frameworks.includes('claude-code')) {
    return {
      registered: [],
      alreadyRegistered: [],
      skippedReason: 'claude-code-not-enabled',
      readSdkCredit: NULL_CREDIT,
    };
  }

  const registered: ProviderId[] = [];
  const alreadyRegistered: ProviderId[] = [];

  // Headless (SDK-credit `claude -p` path) — idempotent.
  let headless = reg.get(ANTHROPIC_HEADLESS_ID);
  if (headless) {
    alreadyRegistered.push(ANTHROPIC_HEADLESS_ID);
  } else {
    headless = createAnthropicHeadlessAdapter({
      ...(options.claudePath ? { claudePath: options.claudePath } : {}),
      ...(options.tmuxPath ? { tmuxPath: options.tmuxPath } : {}),
      ...options.headless,
    });
    await reg.register(headless);
    registered.push(ANTHROPIC_HEADLESS_ID);
  }

  // Interactive pool (subscription floor) — idempotent, lazy (no spawn).
  let pool = reg.get(ANTHROPIC_INTERACTIVE_POOL_ID) as InteractivePoolAdapter | undefined;
  if (pool) {
    alreadyRegistered.push(ANTHROPIC_INTERACTIVE_POOL_ID);
  } else {
    pool = createAnthropicInteractivePoolAdapter({
      ...(options.claudePath ? { claudePath: options.claudePath } : {}),
      ...(options.tmuxPath ? { tmuxPath: options.tmuxPath } : {}),
      ...options.pool,
    });
    await reg.register(pool);
    registered.push(ANTHROPIC_INTERACTIVE_POOL_ID);
  }

  return {
    registered,
    alreadyRegistered,
    headless,
    pool,
    readSdkCredit: buildReadSdkCredit(headless, options.creditCacheTtlMs),
  };
}

// ── pi-cli adapter registration (PI-HARNESS-INTEGRATION-SPEC §4.2) ──────

export interface RegisterPiAdaptersOptions {
  /**
   * The agent's enabled frameworks (InstarConfig.enabledFrameworks). pi is
   * ADDITIVE and ships dark: registration happens ONLY when 'pi-cli' is
   * explicitly present — unset/empty means NOT enabled (the inverse of the
   * Anthropic default, deliberately: existing agents see zero change).
   */
  enabledFrameworks?: ReadonlyArray<string>;
  /** Detected `pi` binary path. Unset → adapter env detection. */
  piPath?: string | null;
  /** The pi `--model` pattern (frameworkDefaultModels['pi-cli']). */
  model?: string;
  /** Subscription-guard override (config `piCli.allowAnthropicProviders`). */
  allowAnthropicProviders?: boolean;
  /** Session-dir for RPC sessions (durable transcripts). */
  sessionDir?: string;
  /** Target registry override for tests. */
  registryInstance?: Registry;
}

export interface RegisterPiAdaptersResult {
  registered: ProviderId[];
  alreadyRegistered: ProviderId[];
  skippedReason?: 'pi-not-enabled' | 'pi-binary-missing';
  adapter?: ProviderAdapter;
}

const inFlightPiByRegistry = new WeakMap<Registry, Promise<RegisterPiAdaptersResult>>();

/**
 * Register the pi-cli adapter, gated and idempotent (mirrors
 * registerAnthropicAdapters' contract):
 *
 *   - GATED on explicit opt-in: `enabledFrameworks` must contain 'pi-cli'.
 *   - GATED on the binary: a configured-but-missing pi degrades to a
 *     skip + doctor-visible reason, never a boot failure.
 *   - IDEMPOTENT including under concurrent calls (single-flight).
 *   - LAZY: pure in-memory construction; nothing spawns at registration.
 *   - GUARDED: the adapter's transports enforce the Anthropic-deny
 *     subscription guard at every call construction (spec §4.3).
 */
export async function registerPiAdapters(
  options: RegisterPiAdaptersOptions = {},
): Promise<RegisterPiAdaptersResult> {
  const targetRegistry = options.registryInstance ?? defaultRegistry;
  const existing = inFlightPiByRegistry.get(targetRegistry);
  if (existing) return existing;
  const run = registerPiAdaptersInner(options, targetRegistry).finally(() => {
    inFlightPiByRegistry.delete(targetRegistry);
  });
  inFlightPiByRegistry.set(targetRegistry, run);
  return run;
}

async function registerPiAdaptersInner(
  options: RegisterPiAdaptersOptions,
  reg: Registry,
): Promise<RegisterPiAdaptersResult> {
  // Gate 1 — explicit opt-in (ships dark).
  if (!options.enabledFrameworks?.includes('pi-cli')) {
    return { registered: [], alreadyRegistered: [], skippedReason: 'pi-not-enabled' };
  }

  // Gate 2 — binary present. Lazy import keeps the adapter graph out of
  // boots that never enable pi.
  const { detectPiPath } = await import('../core/Config.js');
  const piPath = options.piPath ?? detectPiPath();
  if (!piPath) {
    return { registered: [], alreadyRegistered: [], skippedReason: 'pi-binary-missing' };
  }

  const { createPiCliAdapter, PI_CLI_ID } = await import('./adapters/pi-cli/index.js');

  const already = reg.get(PI_CLI_ID);
  if (already) {
    return { registered: [], alreadyRegistered: [PI_CLI_ID], adapter: already };
  }
  const adapter = createPiCliAdapter({
    piPath,
    ...(options.model ? { model: options.model } : {}),
    ...(options.allowAnthropicProviders !== undefined
      ? { allowAnthropicProviders: options.allowAnthropicProviders }
      : {}),
    ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
  });
  await reg.register(adapter);
  return { registered: [PI_CLI_ID], alreadyRegistered: [], adapter };
}
