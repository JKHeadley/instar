/**
 * IntelligenceRouter — routes each LLM call to a framework-specific provider
 * based on the calling component's category/name, so different Instar components
 * can run on different agentic frameworks (e.g. sentinels on Codex while the
 * agent's conversation stays on Claude). Implements docs/specs/
 * per-component-framework-routing.md (B1).
 *
 * KEY DESIGN (corrected by convergence):
 *  - Routing is resolved at CALL TIME, at the single funnel every `.evaluate()`
 *    already passes through — NOT at construction. The component name only
 *    exists at call time (`attribution.component`), and ~half the LLM callers
 *    never receive a constructor-injected provider, so construction-time routing
 *    is unworkable. The router IS the injected provider; it dispatches per call.
 *  - Config is read LIVE on each call, so a `componentFrameworks` change takes
 *    effect on the next call with no restart (no session-start staleness trap).
 *  - Each non-default framework gets its OWN circuit breaker (built by the
 *    injected `buildProvider`), so a Claude rate-limit trip does NOT pause Codex.
 *    The default framework keeps using the existing shared (global-breaker)
 *    provider, so unconfigured behavior is byte-identical to today.
 *  - Fallback is circuit-aware: a framework whose binary is MISSING degrades to
 *    the default framework (config/install problem, low volume) and reports it; a
 *    framework that is merely RATE-LIMITED surfaces LlmCircuitOpenError, which
 *    callers already swallow into their heuristic — so we never herd a Codex
 *    outage's worth of calls onto Claude all at once.
 */

import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import type { IntelligenceFramework } from './intelligenceProviderFactory.js';
import {
  type ComponentCategory,
  isComponentCategory,
  categoryForComponent,
} from './componentCategories.js';
import { LLM_ROUTING_NATURE, type RoutingNature } from '../data/llmBenchCoverage.js';

export interface ComponentFrameworksConfig {
  /** Framework for anything not otherwise specified. Defaults to the router's defaultFramework. */
  default?: IntelligenceFramework;
  /** Per-category framework, e.g. { sentinel: 'codex-cli' }. */
  categories?: Partial<Record<ComponentCategory, IntelligenceFramework>>;
  /** Per-component-name override, highest precedence. */
  overrides?: Record<string, IntelligenceFramework>;
  /** When a routed framework's provider is unavailable (binary missing): 'default' degrades, 'none' errors. */
  fallback?: 'default' | 'none';
  /**
   * Ordered fallback frameworks to try when a SAFETY-GATING call's primary
   * provider FAILS at runtime (rate-limit / circuit-open / error), BEFORE the
   * caller falls closed. Each target has its OWN circuit breaker, so a target
   * whose circuit is already open throws fast and is skipped — no herd onto a
   * stressed provider. Only calls flagged `attribution.gating` swap, keeping the
   * herd tiny. If every target is also down, the original error re-throws so the
   * caller fails closed. Default: undefined ⇒ no swap (exactly today's behavior).
   * This implements the "No Silent Degradation to Brittle Fallback" standard:
   * swap-provider before fail-closed, never silently degrade to a brittle heuristic.
   */
  failureSwap?: IntelligenceFramework[];
}

export interface RouterDegradeInfo {
  component: string;
  category: ComponentCategory;
  from: IntelligenceFramework;
  to: IntelligenceFramework;
  reason: string;
}

/**
 * Minimal structural view of `LlmQueue` (src/monitoring/LlmQueue.ts) used by the deferrable queue
 * rung. Declared here so `core` does NOT import `monitoring` (avoids a layering cycle); the real
 * LlmQueue satisfies this shape structurally.
 */
export interface DeferrableQueue {
  enqueue(
    lane: 'interactive' | 'background',
    fn: (signal: AbortSignal) => Promise<string>,
    costCents?: number,
  ): Promise<string>;
}

export interface IntelligenceRouterOptions {
  /** The existing shared provider for the default framework (global breaker). Used unconfigured + for default-routed calls. */
  defaultProvider: IntelligenceProvider;
  /** Which framework defaultProvider speaks. */
  defaultFramework: IntelligenceFramework;
  /** Live config getter — read on EVERY call so changes are hot. Returns undefined ⇒ routing disabled (all default). */
  resolveConfig: () => ComponentFrameworksConfig | undefined;
  /**
   * Per-attempt swap timeout in ms (provider-fallback-default-policy.md §4.5). Each
   * failure-swap attempt races this cap; a slow-but-not-erroring provider is abandoned
   * at the cap and the loop advances. The cap is ALSO passed through to the provider as
   * its `timeoutMs` so the CLI subprocess SIGTERMs itself at the same bound (the cap and
   * the subprocess kill are the same bound). Inline-defaulted to 5000ms by the caller
   * (no ConfigDefaults entry — codexExecJson precedent). Omitted ⇒ no per-attempt cap
   * (legacy unbounded behavior, for callers that build the router without the policy).
   */
  swapAttemptTimeoutMs?: number;
  /**
   * Per-TARGET-framework swap-attempt caps in ms (per-target-swap-timeout-spec.md).
   * Resolution per swap target: `byFramework[target]` (if valid: finite number > 0)
   * → the global `swapAttemptTimeoutMs` (if valid) → undefined (no cap). An INVALID
   * per-framework value (0, negative, NaN, Infinity, non-number) FALLS THROUGH to
   * the global — never "no cap", never an immediate-0ms kill (FD5). DEFAULT UNSET ⇒
   * the global cap applies to every target — byte-identical routing behavior to today.
   */
  swapAttemptTimeoutMsByFramework?: Partial<Record<IntelligenceFramework, number>>;
  /**
   * Clamp (ms) on any single resolved swap-attempt cap, so a huge/typo'd value
   * cannot create an effectively unbounded subprocess that pins a host spawn-cap
   * slot (FD7). The value is itself validated (finite > 0); invalid/unset ⇒ 120000.
   */
  swapAttemptTimeoutMsMax?: number;
  /**
   * Wall-clock TOTAL budget (ms) over the WHOLE failure-swap tail (FD6). UNSET ⇒ no
   * budget enforcement — semantics unchanged from today (the dark default). When set,
   * each attempt's effective cap is `min(resolvedCap, budgetRemaining)` — measured on
   * a MONOTONIC clock, never Date.now() — and the loop stops and falls closed once
   * `budgetRemaining ≤ 250ms`, so worst-case swap-tail latency is literally ≤ this
   * value (the budget clamps each IN-FLIGHT attempt, not just the loop gate). An
   * invalid value (0, negative, NaN, non-number) is treated as unset.
   */
  swapTotalBudgetMs?: number;
  /**
   * Test seam: the monotonic clock used for the total-budget elapsed measurement.
   * Defaults to `performance.now()` — a wall-clock jump (NTP step, DST) must not
   * make the budget spuriously short or long (round-3 external finding).
   */
  monotonicNow?: () => number;
  /**
   * Build a provider for a non-default framework, with its OWN circuit breaker.
   * Returns null when that framework's binary isn't available. Called at most
   * once per framework (result cached). MUST NOT throw (catch internally).
   */
  buildProvider: (framework: IntelligenceFramework) => IntelligenceProvider | null;
  /** Optional: invoked when a routed call degrades to the default framework (for DegradationReporter). */
  onDegrade?: (info: RouterDegradeInfo) => void;
  /**
   * Never-silent tracking (Resilient Degradation Ladder §4). `onHeuristicFallthrough` fires when a
   * NON-gating call exhausts the ladder and throws (the caller will use its heuristic) — the
   * DegradationReporter opens/refreshes a degradation. `onResolved` fires on a SUCCESSFUL real-LLM
   * answer for that (component, framework) — the reporter auto-resolves any open degradation. Both
   * are no-ops downstream when never-silent tracking is disabled, so the router calls them freely.
   */
  onHeuristicFallthrough?: (component: string, framework: string) => void;
  onResolved?: (component: string, framework: string) => void;
  /**
   * The shared LLM call queue (LlmQueue) for the DEFERRABLE queue rung (§3b.3). Absent ⇒ no queue
   * rung (a deferrable call falls straight through to its heuristic after framework-swap, as before).
   */
  llmQueue?: DeferrableQueue;
  /**
   * Resilient Degradation Ladder (docs/specs/resilient-degradation-ladder.md), RESOLVED at the
   * construction site (the dev-agent gate is applied there, so `*Enabled` are already the
   * gate-resolved booleans). Absent ⇒ no ladder (today's framework-swap-only behavior). The ladder
   * is path-dependent: a GATING call stays fast under `gatingLadderBudgetMs`; only a DEFERRABLE call
   * gets the backoff + queue rungs.
   */
  ladder?: {
    /** Hard total wall-clock budget (ms) for the whole GATING failure path; exceeded ⇒ fail closed. */
    gatingLadderBudgetMs: number;
    /** Whether the DEFERRABLE backoff rung is enabled (gate-resolved). */
    backoffEnabled: boolean;
    backoff: { baseMs: number; factor: number; maxAttempts: number; ceilingMs: number; maxWaitMs: number };
    /** Whether the DEFERRABLE queue rung is enabled (gate-resolved). Absent/false ⇒ no queue rung. */
    queueEnabled?: boolean;
    /** Bound (ms) for a single enqueued deferrable call so a stuck/abandoned one self-terminates. */
    queueAttemptTimeoutMs?: number;
  };
}

interface CachedFramework {
  provider: IntelligenceProvider | null; // null = built but unavailable (binary missing)
}

/**
 * Runtime framework ids for the unknown-key hygiene warning on
 * `swapAttemptTimeoutMsByFramework` (per-target-swap-timeout-spec.md, change
 * surface). The TYPE is the compile-time guard; this set catches a stray key
 * arriving from raw JSON config at runtime (no effect — warn once, ignore).
 */
const KNOWN_FRAMEWORKS: ReadonlySet<string> = new Set(['claude-code', 'codex-cli', 'gemini-cli', 'pi-cli']);

/** Default clamp on any single resolved swap-attempt cap (per-target-swap-timeout-spec.md FD7). */
const DEFAULT_SWAP_ATTEMPT_TIMEOUT_MAX_MS = 120_000;

/**
 * Below this much remaining total budget (ms), a swap attempt is not worth
 * admitting — the loop stops and falls closed (per-target-swap-timeout-spec.md
 * FD6, fixed floor). A configured `swapTotalBudgetMs` below this value passes
 * validation but simply disables swapping on the first attempt (fail-SAFE).
 */
const SWAP_BUDGET_MIN_REMAINING_MS = 250;

/**
 * The spec's uniform validity contract for every timeout/budget value:
 * `typeof x === 'number' && Number.isFinite(x) && x > 0`. `0`, negatives, NaN,
 * Infinity, and non-numbers are all INVALID — selection never uses `||` (the
 * zero-is-falsy lesson).
 */
function isValidMs(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

/**
 * resolveSwapCap — per-TARGET swap-attempt cap resolution
 * (docs/specs/per-target-swap-timeout-spec.md, `resolveCap` contract).
 *
 * Resolution: `byFramework[target]` (if valid) → `globalCap` (if valid) →
 * `undefined` (no cap — today's behavior when the global is ≤0/unset). An
 * INVALID per-framework value (0, negative, NaN, Infinity, non-number) FALLS
 * THROUGH to the global — it NEVER means "no cap" and NEVER produces an
 * immediate-0ms kill (FD5: per-framework config cannot express "unbounded";
 * only the global's ≤0/unset does — closes the accidental-uncap footgun).
 * The resolved cap is clamped to `maxCap` (itself validated; invalid → 120s
 * default) so a huge/typo'd value cannot pin a host spawn-cap slot unbounded.
 *
 * Exported for direct unit testing (pure function, no router state).
 */
export function resolveSwapCap(
  target: IntelligenceFramework,
  globalCap: number | undefined,
  byFramework: Partial<Record<IntelligenceFramework, number>> | undefined,
  maxCap: number | undefined,
): number | undefined {
  const perTarget = byFramework?.[target];
  const candidate = isValidMs(perTarget) ? perTarget : isValidMs(globalCap) ? globalCap : undefined;
  if (candidate === undefined) return undefined;
  const effMax = isValidMs(maxCap) ? maxCap : DEFAULT_SWAP_ATTEMPT_TIMEOUT_MAX_MS;
  return Math.min(candidate, effMax);
}

/**
 * withSwapTimeout — the shipped Promise.race crash-safe pattern (per-input
 * settlement handlers; a late reject/resolve from the abandoned attempt is
 * handled/ignored), PLUS timer hygiene: the pending timeout timer is CLEARED
 * on settle in a `finally` so a fast success does not leak a timer per call
 * (per-target-swap-timeout-spec.md FD7 / codex-review finding). The rejection
 * message format (`swap-attempt-timeout: <target> (<cap>ms)`) is load-bearing —
 * the swap loop's degrade-reason detection prefix-matches it.
 */
async function withSwapTimeout<T>(promise: Promise<T>, capMs: number, target: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`swap-attempt-timeout: ${target} (${capMs}ms)`)),
          capMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Is this a rate-limit / usage-limit / 429 error? The circuit-breaking provider wraps these as a
 * `RateLimitError` (name-checked, no import needed); we also duck-type the message so a provider
 * that throws a plain Error on a limit is still recognized. Used by the deferrable backoff rung to
 * decide whether to slow-down-and-retry (a rate-limit) vs proceed to the swap (a hard error).
 */
function isRateLimitError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === 'RateLimitError' || /rate.?limit|usage.?limit|too many requests|\b429\b/i.test(e.message);
}

/**
 * SAFETY GUARDRAIL — INSTAR-Bench v3, Task-4 S2 (bench rules R1/R2).
 *
 * The `capable` tier resolves to Opus on `claude-code`, and Opus-via-Claude-Code-CLI
 * is the one MEASURED-BANNED route for bounded/gating verdicts: identical Opus 4.8
 * scores 99.1% via clean API but 81.7% via the Claude Code CLI (a 17.4-pt door
 * penalty), and on the emergency-stop classifier it missed canonical STOP commands
 * (73%). The Claude Code harness wraps every prompt in ~20k tokens of "helpful
 * coding agent" framing, turning a skeptical judge into a credulous assistant.
 *
 * A failure-swap only ever fires on a GATING or DEFERRABLE call (the swap loop is
 * unreachable otherwise), and those are exactly the bounded-verdict calls R1
 * forbids on that door. So when a swap lands on `claude-code` requesting the
 * `capable` tier, we CLAMP the tier down to `balanced` (Sonnet 4.6 CLI — 99.5%,
 * 28/28 adversarial, the sanctioned injection-safe Claude-CLI reserve). This only
 * ever NARROWS a dangerous fallback (Opus→Sonnet on one specific door) — it is
 * strictly the safe direction and never upgrades or blocks a call. It does NOT
 * touch the CHAIN WRITE quality lane, where `claude-code`+Opus is the resolved
 * PRIMARY framework (open-ended writing) rather than a bounded-verdict swap target.
 *
 * Returns the model tier the swap attempt should actually request, and whether a
 * clamp occurred (so the caller can emit an audit/degrade note).
 */
export function clampClaudeCliSwapModel(
  target: IntelligenceFramework,
  requested: IntelligenceOptions['model'] | undefined,
): { model: IntelligenceOptions['model'] | undefined; clamped: boolean } {
  if (target === 'claude-code' && requested === 'capable') {
    return { model: 'balanced', clamped: true };
  }
  return { model: requested, clamped: false };
}

/**
 * Resolve a component's static routing nature from the merged S1 map
 * (`LLM_ROUTING_NATURE`). Mirrors `categoryForComponent`'s per-operation key
 * handling (FD3): an exact key (incl. a "/segment" operation suffix) wins, else the
 * base component name (`split('/')[0]`, `server:` prefix stripped) is the fallback.
 * Returns `undefined` for an unmapped component. Pure map lookup — always available,
 * independent of `sessions.natureRouting`.
 */
export function routingNatureFor(component: string | undefined): RoutingNature | undefined {
  if (!component) return undefined;
  const exact = LLM_ROUTING_NATURE[component];
  if (exact) return exact;
  const base = component.split('/')[0].replace(/^server:/, '').trim();
  return LLM_ROUTING_NATURE[base];
}

/**
 * LA4 (S4 A1) degrade-path safety predicate (FD4 / codex CR6-3). A binary-missing
 * degrade to the default door is a bounded/gating call — and so must be clamped OFF
 * the Opus-via-Claude-CLI landing — iff either:
 *   (a) the caller declared `attribution.gating === true`, OR
 *   (b) the component maps to a NON-`WRITE` chain in `LLM_ROUTING_NATURE`
 *       (mapped nature A/B, or D-non-WRITE — all bounded/gating).
 * A `WRITE`-chain component (Opus-via-CLI is its legitimate open-ended-writing quality
 * lane) or an unmapped, non-gating call is left UNCHANGED — the clamp stays exactly as
 * narrow as bench rules R1/R2. This is a pure lookup over `attribution` + the static
 * map, so it never depends on `sessions.natureRouting` being set.
 */
export function isBoundedGatingDegrade(
  component: string | undefined,
  options?: IntelligenceOptions,
): boolean {
  if (options?.attribution?.gating === true) return true;
  const row = routingNatureFor(component);
  if (!row) return false; // unmapped + not gating ⇒ out of R1's scope, unchanged
  return row.chain !== 'WRITE'; // WRITE is the sanctioned Opus-CLI lane; everything else is bounded/gating
}

export class IntelligenceRouter implements IntelligenceProvider {
  private readonly cache = new Map<IntelligenceFramework, CachedFramework>();

  /** Unknown byFramework keys already warned about (warn ONCE per key, never per call). */
  private warnedUnknownCapKeys?: Set<string>;

  constructor(private readonly opts: IntelligenceRouterOptions) {}

  /**
   * Unknown-key hygiene (per-target-swap-timeout-spec.md, change surface): a stray/
   * misspelled key arriving from raw JSON config has NO effect (that target simply
   * falls through to the global cap) — but it is logged once so the typo is visible
   * instead of silently ignored. Type-level the map is keyed to the framework union;
   * this is the runtime backstop.
   */
  private warnUnknownSwapCapKeys(
    byFramework: Partial<Record<IntelligenceFramework, number>> | undefined,
  ): void {
    if (!byFramework) return;
    for (const key of Object.keys(byFramework)) {
      if (KNOWN_FRAMEWORKS.has(key)) continue;
      if (!this.warnedUnknownCapKeys) this.warnedUnknownCapKeys = new Set();
      if (this.warnedUnknownCapKeys.has(key)) continue;
      this.warnedUnknownCapKeys.add(key);
      console.warn(
        `IntelligenceRouter: unknown framework key '${key}' in swapAttemptTimeoutMsByFramework — ` +
          `ignored (that key has no effect; targets fall through to the global cap)`,
      );
    }
  }

  /**
   * The framework the default (shared, global-breaker) provider speaks — i.e. the
   * framework a component routes to when nothing routes it elsewhere. The
   * CartographerSweep off-Claude probe compares `for(...).framework` against this
   * to detect a silent resolve-to-default (Claude) and refuse to author there.
   */
  get defaultFramework(): IntelligenceFramework {
    return this.opts.defaultFramework;
  }

  /** Resolve the framework for a component+category against a config (pure). */
  resolveFramework(
    component: string | undefined,
    category: ComponentCategory,
    cfg: ComponentFrameworksConfig | undefined,
  ): IntelligenceFramework {
    if (!cfg) return this.opts.defaultFramework;
    if (component && cfg.overrides && cfg.overrides[component]) return cfg.overrides[component];
    const byCat = cfg.categories?.[category];
    if (byCat) return byCat;
    return cfg.default ?? this.opts.defaultFramework;
  }

  /**
   * Diagnostic resolver for the GET /intelligence/routing surface: what framework
   * a component WOULD route to right now, and whether that framework is available.
   */
  for(component: string, categoryOverride?: ComponentCategory): {
    component: string;
    category: ComponentCategory;
    framework: IntelligenceFramework;
    available: boolean;
  } {
    const category = categoryOverride ?? categoryForComponent(component);
    const cfg = this.opts.resolveConfig();
    const framework = this.resolveFramework(component, category, cfg);
    const available = framework === this.opts.defaultFramework ? true : this.providerFor(framework) !== null;
    return { component, category, framework, available };
  }

  /** Get-or-build the provider for a framework (cached). Default framework → shared provider. */
  private providerFor(framework: IntelligenceFramework): IntelligenceProvider | null {
    if (framework === this.opts.defaultFramework) return this.opts.defaultProvider;
    const cached = this.cache.get(framework);
    if (cached) return cached.provider;
    let provider: IntelligenceProvider | null = null;
    try {
      provider = this.opts.buildProvider(framework);
    } catch {
      provider = null; // never throw into the call path on a build failure
    }
    this.cache.set(framework, { provider });
    return provider;
  }

  /** Default framework → shared provider; else the cached per-framework provider (null if binary missing). */
  private resolveProvider(framework: IntelligenceFramework): IntelligenceProvider | null {
    return framework === this.opts.defaultFramework ? this.opts.defaultProvider : this.providerFor(framework);
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const component = options?.attribution?.component;
    const explicitCategory = (options?.attribution as { category?: unknown } | undefined)?.category;
    const category: ComponentCategory = isComponentCategory(explicitCategory)
      ? explicitCategory
      : categoryForComponent(component);

    const cfg = this.opts.resolveConfig();
    // Unconfigured ⇒ exactly today's behavior.
    if (!cfg) return this.opts.defaultProvider.evaluate(prompt, options);

    const framework = this.resolveFramework(component, category, cfg);
    const primary = this.resolveProvider(framework);

    // Provider unavailable (binary missing / not built) — unchanged: degrade or error.
    if (!primary) {
      if ((cfg.fallback ?? 'default') === 'none') {
        throw new Error(
          `IntelligenceRouter: framework '${framework}' for component '${component ?? '(none)'}' ` +
            `is unavailable and fallback is 'none'.`,
        );
      }
      this.opts.onDegrade?.({
        component: component ?? '(none)',
        category,
        from: framework,
        to: this.opts.defaultFramework,
        reason: `framework '${framework}' unavailable (binary missing / not built) — degraded to default`,
      });
      // LA4 (S4 A1) — UNCONDITIONAL degrade-path safety clamp. This degrade lands on
      // `defaultFramework`; if that door is `claude-code` and the requested tier is
      // `capable`, the landing is Opus-via-Claude-CLI — the one MEASURED-BANNED route for a
      // bounded/gating verdict (81.7% vs 99.1% API; missed canonical STOPs at 73%). The
      // shipped router leaves this exit UNCLAMPED (the S2 clamp only guards the failure-swap
      // loop), so a binary-missing bounded/gating `capable` degrade with a `claude-code`
      // default fails OPEN onto Opus-via-CLI. Clamp it to the Sonnet-4.6-CLI reserve
      // (`balanced`, the SAME reserve `clampClaudeCliSwapModel` already uses) for
      // bounded/gating calls ONLY — `WRITE` keeps its legitimate Opus-CLI quality lane, and
      // an unmapped non-gating call is out of R1's scope. This fires REGARDLESS of
      // `sessions.natureRouting`: it is a standalone safety narrowing, NOT gated on the S4
      // feature flag (FD4 LA4-r2). Strictly the safe direction (a measured-worse route → the
      // sanctioned reserve) — never an upgrade, never a block.
      let degradeOptions = options;
      if (isBoundedGatingDegrade(component, options)) {
        const { model: clampedModel, clamped } = clampClaudeCliSwapModel(
          this.opts.defaultFramework,
          options?.model,
        );
        if (clamped) {
          degradeOptions = { ...(options ?? {}), model: clampedModel };
          this.opts.onDegrade?.({
            component: component ?? '(none)',
            category,
            from: framework,
            to: this.opts.defaultFramework,
            reason:
              `degrade-path-model-clamp (LA4): '${this.opts.defaultFramework}' capable→balanced ` +
              `(Opus-via-Claude-CLI is banned for bounded/gating verdicts — R1/R2; unconditional)`,
          });
        }
      }
      return this.opts.defaultProvider.evaluate(prompt, degradeOptions);
    }

    // Failure-swap: ONLY a safety-gating call with configured failureSwap targets
    // swaps on a RUNTIME failure (rate-limit / circuit-open / error). Non-gating
    // calls keep today's behavior — the error propagates and the caller swallows it
    // into its heuristic (no herd onto the fallback). This is the herd-aware half of
    // "No Silent Degradation to Brittle Fallback": swap-before-fail-closed, scoped
    // tightly so a rate-limited framework can't dump its whole load onto another.
    const gating = options?.attribution?.gating === true;
    // DEFERRABLE = background work not synchronously awaited. gating ALWAYS dominates (an awaited gate
    // can never be deferred/queued — the structural invariant). Resilient Degradation Ladder §3.
    const deferrable = !gating && options?.attribution?.deferrable === true;
    const ladder = this.opts.ladder;
    // Framework-swap applies to a gating OR a deferrable call (both ladder paths include it).
    const swapTargets = (gating || deferrable) && cfg.failureSwap ? cfg.failureSwap : [];
    // GATING budget: a single hard wall-clock deadline over the whole gating failure path so an
    // awaited gate stays responsive (no stacking rungs). Deferrable calls are not budgeted this way.
    const gatingDeadlineAt = gating && ladder ? Date.now() + ladder.gatingLadderBudgetMs : undefined;

    let err: unknown;
    try {
      const mainResult = await primary.evaluate(prompt, options);
      this.opts.onResolved?.(component ?? '(none)', framework); // a real answer → auto-resolve any open degradation
      return mainResult;
    } catch (firstErr) {
      err = firstErr;
      // RUNG (a) — DEFERRABLE backoff: slow down and retry the SAME provider BEFORE swapping, by
      // setting options.rateLimitWaitMs so the provider-layer acquireOrWait waits for the breaker
      // window (the router holds no breaker — spec §2). Bounded + jittered; a non-rate-limit error
      // stops the backoff and proceeds to the swap.
      if (deferrable && ladder?.backoffEnabled && isRateLimitError(err)) {
        const b = ladder.backoff;
        for (let attempt = 0; attempt < b.maxAttempts; attempt++) {
          const delay = Math.min(b.baseMs * Math.pow(b.factor, attempt), b.ceilingMs);
          const jittered = Math.min(Math.floor(delay * (0.5 + Math.random() * 0.5)), b.maxWaitMs);
          try {
            const boResult = await primary.evaluate(prompt, { ...(options ?? {}), rateLimitWaitMs: jittered });
            this.opts.onResolved?.(component ?? '(none)', framework); // recovered on backoff → auto-resolve
            return boResult;
          } catch (retryErr) {
            err = retryErr;
            if (!isRateLimitError(retryErr)) break; // a hard error → stop backing off, go to swap
          }
        }
      }
      if (swapTargets.length === 0) {
        // RUNG (c) — DEFERRABLE queue: no swap configured, but a deferrable call can WAIT for capacity
        // in the LlmQueue before dropping to its heuristic. gating can never reach here (deferrable =
        // !gating && …) — the D5 queue-skip invariant is structural.
        if (deferrable) {
          const q = await this.tryDeferrableQueue(primary, prompt, options, component ?? '(none)', framework, category);
          if (q.ok) return q.result;
        }
        // Non-gating ⇒ the caller will swallow this into its heuristic — track it (never-silent).
        // Gating ⇒ this is a fail-closed, NOT a heuristic, so it is not tracked.
        if (!gating) this.opts.onHeuristicFallthrough?.(component ?? '(none)', framework);
        throw err; // not gating/deferrable, or no swap configured ⇒ today's behavior
      }
      // §4.5 bounded per-attempt swap timeout, now resolved PER TARGET
      // (docs/specs/per-target-swap-timeout-spec.md): each attempt's cap resolves
      // `byFramework[target]` → global → undefined, clamped to `maxCap`, so a
      // slow-but-honest target (gemini p50 ≈ 8.5s) can be GIVEN its measured time
      // instead of being killed at a one-size-fits-all 5s. When a TOTAL budget is
      // set, each attempt is additionally clamped to the remaining budget (monotonic
      // clock) and the loop falls closed once < 250ms remains — so the whole tail is
      // literally ≤ swapTotalBudgetMs. All three knobs default UNSET ⇒ byte-identical
      // routing behavior to the single global cap. The cap also flows through to the
      // provider as `timeoutMs` so the CLI subprocess SIGTERMs itself at the same bound.
      const globalCapMs = this.opts.swapAttemptTimeoutMs;
      const byFramework = this.opts.swapAttemptTimeoutMsByFramework;
      this.warnUnknownSwapCapKeys(byFramework);
      const maxCapMs = this.opts.swapAttemptTimeoutMsMax;
      const budgetMs = isValidMs(this.opts.swapTotalBudgetMs) ? this.opts.swapTotalBudgetMs : undefined;
      const monotonicNow = this.opts.monotonicNow ?? (() => performance.now());
      const swapStartedAt = monotonicNow();
      for (const target of swapTargets) {
        // GATING budget: if the awaited gate's total wall-clock budget is consumed, stop swapping
        // and fail closed now (responsiveness over completeness — spec §3a). Deferrable calls have
        // no such deadline (gatingDeadlineAt is undefined for them).
        if (gatingDeadlineAt !== undefined && Date.now() > gatingDeadlineAt) break;
        if (target === framework) continue; // don't retry the framework that just failed
        const tp = this.resolveProvider(target);
        if (!tp) continue; // target binary missing → skip
        let cap = resolveSwapCap(target, globalCapMs, byFramework, maxCapMs);
        if (budgetMs !== undefined) {
          const remaining = budgetMs - (monotonicNow() - swapStartedAt);
          // Too little budget left to be worth an attempt → stop, fall closed (FD6).
          if (remaining <= SWAP_BUDGET_MIN_REMAINING_MS) break;
          // The budget clamps each IN-FLIGHT attempt, not just the loop gate — an
          // attempt admitted at budget−ε must NOT run its full per-target cap
          // (worst case would be budget + maxCap, not ≤ budget). It also bounds an
          // otherwise-UNcapped attempt (no per-target cap, global ≤0/unset).
          cap = cap === undefined ? remaining : Math.min(cap, remaining);
        }
        // SAFETY (S2, R1/R2): a bounded/gating swap onto claude-code that requests
        // the `capable` tier would resolve to Opus-via-Claude-CLI — the measured-banned
        // door (81.7% vs 99.1% API). Clamp it down to `balanced` (Sonnet CLI reserve).
        // Only ever narrows a dangerous fallback; never upgrades/blocks a call.
        const { model: clampedModel, clamped: modelClamped } = clampClaudeCliSwapModel(
          target,
          options?.model,
        );
        if (modelClamped) {
          this.opts.onDegrade?.({
            component: component ?? '(none)',
            category,
            from: framework,
            to: target,
            reason:
              `failure-swap-model-clamp: '${target}' capable→balanced ` +
              `(Opus-via-Claude-CLI is banned for bounded/gating verdicts — R1/R2)`,
          });
        }
        // Pass the cap through as the provider's per-call timeout so the subprocess
        // self-terminates at the bound (no AbortSignal exists on IntelligenceOptions).
        const attemptOptions: IntelligenceOptions | undefined =
          cap !== undefined || modelClamped
            ? {
                ...(options ?? {}),
                ...(cap !== undefined ? { timeoutMs: cap } : {}),
                ...(modelClamped ? { model: clampedModel } : {}),
              }
            : options;
        try {
          // withSwapTimeout keeps the shipped, crash-safe Promise.race pattern
          // (InputGuard precedent): it attaches a settlement handler to EACH input,
          // so a late rejection from an abandoned attempt is already handled (no
          // unhandledRejection) and a late resolve is ignored. NEVER a detached/
          // awaited handle. It additionally CLEARS the timer on settle (FD7) so a
          // fast success does not leak a pending timer.
          const result =
            cap !== undefined
              ? await withSwapTimeout(tp.evaluate(prompt, attemptOptions), cap, target)
              : await tp.evaluate(prompt, attemptOptions);
          this.opts.onDegrade?.({
            component: component ?? '(none)',
            category,
            from: framework,
            to: target,
            reason: `failure-swap: '${framework}' failed (${err instanceof Error ? err.message : 'error'}); served by '${target}'`,
          });
          this.opts.onResolved?.(component ?? '(none)', framework); // real answer via swap → auto-resolve
          return result;
        } catch (attemptErr) {
          // A timed-out attempt emits a distinct degrade reason so the cap firing is
          // visible in DegradationReporter + /metrics/features (§4.5 observability),
          // then the loop advances to the next target (fail-open per-attempt).
          if (
            attemptErr instanceof Error &&
            attemptErr.message.startsWith('swap-attempt-timeout:')
          ) {
            this.opts.onDegrade?.({
              component: component ?? '(none)',
              category,
              from: framework,
              to: target,
              reason: `swap-attempt-timeout: ${target}`,
            });
          }
          continue; // target also down (timeout / circuit-open / error) → try the next one
        }
      }
      // RUNG (c) — DEFERRABLE queue: every swap target is also down, but a deferrable call can WAIT
      // for capacity in the LlmQueue before dropping to its heuristic (the gentle order, §3b.3). A
      // gating call NEVER reaches here (deferrable = !gating && …) — D5 queue-skip is structural.
      if (deferrable) {
        const q = await this.tryDeferrableQueue(primary, prompt, options, component ?? '(none)', framework, category);
        if (q.ok) return q.result;
      }
      // Every swap target is also down → re-throw so the (gating) caller fails CLOSED,
      // never silently degrading to a brittle heuristic. A NON-gating caller WILL swallow this into
      // its heuristic, so track it (never-silent §4); a gating fail-closed is not a heuristic.
      if (!gating) this.opts.onHeuristicFallthrough?.(component ?? '(none)', framework);
      throw err;
    }
  }

  /**
   * Queue rung (Resilient Degradation Ladder §3b.3) — DEFERRABLE calls only. Enqueue the SAME
   * provider.evaluate so the call WAITS for capacity (the enqueued evaluate honors the account-global
   * breaker's retryAfterMs via acquireOrWait — the §3b.3 rate-awareness) instead of dropping to the
   * caller's heuristic. The AbortSignal cannot reach the subprocess (no IntelligenceOptions.signal —
   * same as the swap loop), so we bound the enqueued call with `timeoutMs` and rely on the queue to
   * free its slot on preemption; a preempted/abandoned call self-terminates at the bound. An enqueue
   * REJECTION (daily-cap / interactive-reserve) OR a failed queued call returns `{ ok: false }` so the
   * caller falls through to its heuristic — NEVER silently dropped (the callsite's onHeuristicFallthrough
   * tracks it, §4). Both outcomes emit a distinct onDegrade reason for /metrics/features (D7).
   */
  private async tryDeferrableQueue(
    primary: IntelligenceProvider,
    prompt: string,
    options: IntelligenceOptions | undefined,
    component: string,
    framework: IntelligenceFramework,
    category: ComponentCategory,
  ): Promise<{ ok: true; result: string } | { ok: false }> {
    const q = this.opts.llmQueue;
    const ladder = this.opts.ladder;
    if (!q || !ladder?.queueEnabled) return { ok: false };
    const bound = ladder.queueAttemptTimeoutMs ?? 0;
    const enqueueOptions: IntelligenceOptions | undefined =
      bound > 0 ? { ...(options ?? {}), timeoutMs: bound } : options;
    try {
      const result = await q.enqueue('background', () => primary.evaluate(prompt, enqueueOptions));
      this.opts.onDegrade?.({
        component,
        category,
        from: framework,
        to: framework,
        reason: 'queued: deferrable call waited for capacity in the LLM queue and was served',
      });
      this.opts.onResolved?.(component, framework); // a real answer via the queue → auto-resolve
      return { ok: true, result };
    } catch {
      this.opts.onDegrade?.({
        component,
        category,
        from: framework,
        to: framework,
        reason: 'queue-rejected: enqueue refused (daily-cap/reserve) or queued call failed — falling through to heuristic',
      });
      return { ok: false };
    }
  }
}
