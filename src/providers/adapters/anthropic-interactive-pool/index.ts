/**
 * anthropic-interactive-pool adapter — entry point.
 *
 * Sister adapter to `anthropic-headless`. Instead of one `claude -p`
 * subprocess per call, this adapter maintains a pool of long-lived
 * `claude` REPL sessions in tmux and routes work through them by
 * prompt-injection. Post-2026-06-15, this is the path that draws from the
 * user's Max subscription (rather than the Agent SDK credit pot).
 *
 * Usage:
 *
 *   import { createAnthropicInteractivePoolAdapter } from
 *     './providers/adapters/anthropic-interactive-pool/index.js';
 *   import { registry } from './providers/registry.js';
 *
 *   const adapter = createAnthropicInteractivePoolAdapter({ poolSize: 2 });
 *   await registry.register(adapter);
 *   // …on shutdown:
 *   await adapter.dispose?.();
 */

import type { CapabilityFlag } from '../../capabilities.js';
import type { ProviderAdapter } from '../../registry.js';
import { UnsupportedCapabilityError } from '../../errors.js';
import { anthropicInteractivePoolCapabilities } from './capabilities.js';
import { ANTHROPIC_INTERACTIVE_POOL_ID } from './errors.js';
import { configFromEnv, type InteractivePoolConfig } from './config.js';
import { InteractivePool } from './pool.js';

import { createOneShotCompletion } from './transport/oneShotCompletion.js';
import { createWarmSessionInbox } from './transport/warmSessionInbox.js';

import { createInputInjection } from './control/inputInjection.js';
import { createHardKill } from './control/hardKill.js';
import { createInterrupt } from './control/interrupt.js';
import {
  createTimeoutBound,
  createIdleBound,
  createStopGateInterceptor,
} from './control/simpleControls.js';
import { createAuthCredentialInjection } from './control/authCredentialInjection.js';
import { createContextScopeControl } from './control/contextScopeControl.js';
import { createCompactionLifecycle } from './control/compactionLifecycle.js';

import { createLiveOutputStream } from './observability/liveOutputStream.js';
import { createProcessLifecycle } from './observability/processLifecycle.js';
import { createSessionId } from './observability/sessionId.js';

import { createStubPrimitive } from './stubs.js';
import { CapabilityFlag as Cap } from '../../capabilities.js';

/**
 * Extended adapter shape: in addition to the standard ProviderAdapter
 * surface, this adapter exposes `start()` to warm the pool eagerly and the
 * underlying `pool` for callers that need to inspect it (status, tests,
 * smoke runs). Most consumers will use only the ProviderAdapter contract.
 */
export interface InteractivePoolAdapter extends ProviderAdapter {
  /** Start the pool (idempotent). Must be called before first allocate. */
  start(): Promise<void>;
  /** Underlying pool, exposed for tests and observability tooling. */
  readonly pool: InteractivePool;
}

/**
 * Create the anthropic-interactive-pool adapter with the given config
 * (or environment defaults if omitted).
 */
export function createAnthropicInteractivePoolAdapter(
  partialConfig: Partial<InteractivePoolConfig> = {},
): InteractivePoolAdapter {
  const config: InteractivePoolConfig = {
    ...configFromEnv(),
    ...partialConfig,
  };

  const pool = new InteractivePool(config);

  // Start the pool lazily on first allocate. Multiple concurrent callers
  // share a single start promise.
  let startPromise: Promise<void> | null = null;
  const ensureStarted = async (): Promise<void> => {
    if (!startPromise) {
      startPromise = pool.start();
    }
    await startPromise;
  };

  // Wrap allocate-driven primitives so the pool starts on first use without
  // requiring callers to remember an explicit setup step. Other primitives
  // (snapshot/state/etc.) refer to handles that must have come from a prior
  // allocate, so the pool is guaranteed running by the time they run.
  const oneShot = createOneShotCompletion(pool, config);
  const wrappedOneShot = {
    capability: oneShot.capability,
    evaluate: async (prompt: string, options?: Parameters<typeof oneShot.evaluate>[1]) => {
      await ensureStarted();
      return oneShot.evaluate(prompt, options);
    },
  };

  const inbox = createWarmSessionInbox(pool, config);
  const wrappedInbox = {
    capability: inbox.capability,
    start: async (options: Parameters<typeof inbox.start>[0]) => {
      await ensureStarted();
      return inbox.start(options);
    },
    send: inbox.send.bind(inbox),
    retire: inbox.retire.bind(inbox),
  };

  const impls = new Map<CapabilityFlag, unknown>();

  // Transport
  impls.set(Cap.OneShotCompletion, wrappedOneShot);
  impls.set(Cap.StructuredOneShot, createStubPrimitive(Cap.StructuredOneShot));
  impls.set(Cap.AgenticSessionHeadless, createStubPrimitive(Cap.AgenticSessionHeadless));
  impls.set(Cap.AgenticSessionInteractive, createStubPrimitive(Cap.AgenticSessionInteractive));
  impls.set(Cap.WarmSessionInbox, wrappedInbox);
  impls.set(Cap.AgenticSessionRpc, createStubPrimitive(Cap.AgenticSessionRpc));

  // Capability layer — all stubbed (same as 3a's posture for non-active
  // consumer primitives; spec primitives are present so the registry can
  // route, real impls land when a consumer arrives).
  impls.set(Cap.ToolAccess, createStubPrimitive(Cap.ToolAccess));
  impls.set(Cap.ToolAllowlist, createStubPrimitive(Cap.ToolAllowlist));
  impls.set(Cap.FileSystemAccess, createStubPrimitive(Cap.FileSystemAccess));
  impls.set(Cap.PathAllowlist, createStubPrimitive(Cap.PathAllowlist));
  impls.set(Cap.BashExecution, createStubPrimitive(Cap.BashExecution));
  impls.set(Cap.WebAccess, createStubPrimitive(Cap.WebAccess));

  // Observability — three real implementations land in Phase 3b.
  impls.set(Cap.LiveOutputStream, createLiveOutputStream(config));
  impls.set(Cap.ProcessLifecycle, createProcessLifecycle(config));
  impls.set(Cap.SessionId, createSessionId(pool));
  impls.set(Cap.ConversationLogReader, createStubPrimitive(Cap.ConversationLogReader));
  impls.set(Cap.ConversationLogTailer, createStubPrimitive(Cap.ConversationLogTailer));
  impls.set(Cap.HookEventReceiver, createStubPrimitive(Cap.HookEventReceiver));
  impls.set(Cap.SubagentLifecycleObserver, createStubPrimitive(Cap.SubagentLifecycleObserver));
  impls.set(Cap.UsageMeterProvider, createStubPrimitive(Cap.UsageMeterProvider));
  impls.set(Cap.InteractivePromptObserver, createStubPrimitive(Cap.InteractivePromptObserver));

  // Control
  impls.set(Cap.InputInjection, createInputInjection(config));
  impls.set(Cap.HardKill, createHardKill(pool));
  impls.set(Cap.Interrupt, createInterrupt(config));
  impls.set(Cap.StopGateInterceptor, createStopGateInterceptor());
  impls.set(Cap.TimeoutBound, createTimeoutBound());
  impls.set(Cap.IdleBound, createIdleBound());
  impls.set(Cap.AuthCredentialInjection, createAuthCredentialInjection());
  impls.set(Cap.CredentialStorageProvider, createStubPrimitive(Cap.CredentialStorageProvider));
  impls.set(Cap.ContextScopeControl, createContextScopeControl());
  impls.set(Cap.CompactionLifecycle, createCompactionLifecycle());
  impls.set(Cap.IntelligenceCallQueue, createStubPrimitive(Cap.IntelligenceCallQueue));

  // Integration — stubbed pending consumer arrival
  impls.set(Cap.ProviderScaffolder, createStubPrimitive(Cap.ProviderScaffolder));
  impls.set(Cap.McpToolRegistry, createStubPrimitive(Cap.McpToolRegistry));
  impls.set(Cap.SessionResumeIndex, createStubPrimitive(Cap.SessionResumeIndex));
  impls.set(Cap.ConversationLogProvider, createStubPrimitive(Cap.ConversationLogProvider));

  return {
    id: ANTHROPIC_INTERACTIVE_POOL_ID,
    capabilities: anthropicInteractivePoolCapabilities,
    pool,
    primitive(capability: CapabilityFlag): unknown {
      const impl = impls.get(capability);
      if (impl === undefined) {
        throw new UnsupportedCapabilityError(capability, ANTHROPIC_INTERACTIVE_POOL_ID);
      }
      return impl;
    },
    async start(): Promise<void> {
      await ensureStarted();
    },
    async dispose(): Promise<void> {
      await pool.shutdown();
    },
  };
}

// Re-export the config types for callers wiring this in.
export type { InteractivePoolConfig } from './config.js';
export { configFromEnv } from './config.js';
export { ANTHROPIC_INTERACTIVE_POOL_ID } from './errors.js';
