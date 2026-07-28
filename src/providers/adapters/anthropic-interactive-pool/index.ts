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

  // Each entry in `impls` matches a real capability declared in
  // capabilities.ts. The pool no longer wires throwing stubs for
  // primitives it doesn't actually implement — those primitives are
  // simply not declared, so the registry resolves them on the headless
  // adapter instead.
  const impls = new Map<CapabilityFlag, unknown>();

  // Transport
  impls.set(Cap.OneShotCompletion, wrappedOneShot);
  impls.set(Cap.WarmSessionInbox, wrappedInbox);

  // Observability — pool-session-state primitives only.
  impls.set(Cap.LiveOutputStream, createLiveOutputStream(config));
  impls.set(Cap.ProcessLifecycle, createProcessLifecycle(config));
  impls.set(Cap.SessionId, createSessionId(pool));

  // Control — session-management primitives needed by the pool.
  impls.set(Cap.InputInjection, createInputInjection(config));
  impls.set(Cap.HardKill, createHardKill(pool));
  impls.set(Cap.Interrupt, createInterrupt(config));
  impls.set(Cap.StopGateInterceptor, createStopGateInterceptor());
  impls.set(Cap.TimeoutBound, createTimeoutBound());
  impls.set(Cap.IdleBound, createIdleBound());
  impls.set(Cap.AuthCredentialInjection, createAuthCredentialInjection());
  impls.set(Cap.ContextScopeControl, createContextScopeControl());
  impls.set(Cap.CompactionLifecycle, createCompactionLifecycle());

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

/**
 * Build a CanaryLlmFallback that delegates to an IntelligenceProvider.
 *
 * The pool's recurring empty-prompt canary calls the fallback only when
 * its deterministic re-derivation has already failed — so this is a
 * rare, last-line-of-defense path. The prompt is intentionally narrow
 * ("does this terminal capture show Claude Code at a completed prompt?")
 * and routes through the fast tier (Haiku-class).
 *
 * Wire at the application layer:
 *
 *   const adapter = createAnthropicInteractivePoolAdapter({
 *     ...,
 *     llmFallback: buildCanaryLlmFallback(intelligence),
 *   });
 *
 * Omitting the fallback leaves the canary deterministic-only — a failed
 * re-derivation will surface as a hard failure rather than a soft
 * llm-confirmed pass.
 */
export function buildCanaryLlmFallback(
  intelligence: import('../../../core/types.js').IntelligenceProvider,
): import('./canary/emptyPromptCanary.js').CanaryLlmFallback {
  return async (capturedPane, context) => {
    const prompt =
      'You are inspecting a terminal capture of a Claude Code session.\n\n'
      + 'Question: does the bottom of this capture indicate Claude Code is at a '
      + 'completed prompt and ready for the next user input? Answer with the single '
      + 'word "complete" or "not-complete" — nothing else.\n\n'
      + `Canary prompt that was sent (for context): ${JSON.stringify(context.canaryPrompt)}\n`
      + `Expected response pattern: ${context.canaryExpected.source}\n\n`
      + 'Terminal capture (bottom 30 lines):\n'
      + '<<<CAPTURE>>>\n'
      + capturedPane.split('\n').slice(-30).join('\n')
      + '\n<<<CAPTURE>>>';
    try {
      const raw = await intelligence.evaluate(prompt, {
        model: 'fast',
        maxTokens: 16,
        temperature: 0,
        attribution: { component: 'InteractivePoolCanaryJudge' },
      });
      const verdict = raw.trim().toLowerCase();
      if (verdict.startsWith('complete')) return 'complete';
      if (verdict.startsWith('not-complete') || verdict.startsWith('not complete')) return 'not-complete';
      return 'error';
    } catch {
      return 'error';
    }
  };
}
