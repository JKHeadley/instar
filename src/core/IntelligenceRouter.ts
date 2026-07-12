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
import {
  LLM_ROUTING_NATURE,
  type RoutingNature,
  type TaskNature,
  type RoutingChain,
  type RoutingDoor,
  type ChainPosition,
  type NatureRoutingChains,
  NATURE_ROUTING_DEFAULT_CHAINS,
  ROUTING_LABEL_TO_MODEL_ID,
  CLAUDE_CODE_RESERVE_MODEL_ID,
  METERED_ROUTING_DOORS,
  NATURE_ROUTING_CRITICAL_GATES,
  resolveInjectionExposure,
} from '../data/llmBenchCoverage.js';
import {
  DECISION_CORRELATION_ID,
  DECISION_MINT_MARKER,
  mintRouterCorrelationId,
  getDecisionQualityRecorder,
  bumpOnCorrelationIdThrow,
  type DecisionAttemptCapture,
  type DecisionProvenanceBlock,
} from './decisionQualityTypes.js';

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
   * Per-attempt swap timeout in ms for NON-GATING failure-swap attempts only.
   * Non-gating swaps are not safety gates; cold-start providers may legitimately
   * exceed the safety-gating 5s fail-closed bound. Resolution in the non-gating
   * helper uses this cap as its global fallback while the gating/deferrable swap
   * loop continues to use `swapAttemptTimeoutMs`.
   */
  nonGatingSwapTimeoutMs?: number;
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
   * NON-GATING failure-swap (docs/specs/nongating-failure-swap.md). Extends the bounded
   * failure-swap tail to NON-gating internal calls (e.g. TopicIntentExtractor — 28% codex
   * invocation-error rate in production) — but with a TIGHTER bound than gating calls:
   *  - it fires ONLY on an INVOCATION-level primary failure (the primary threw AND produced
   *    ZERO tokens — a spawn failure / timeout / empty output), NEVER on a content/parse
   *    error that carried tokens (the caller fail-opens that per provider-fallback §6.4);
   *  - it takes at most `maxAttempts` (default 1) steps down the active config tail; and
   *  - it NEVER lands on `claude-code` or the default framework — the provider-fallback §6.2
   *    invariant that non-gating background traffic must never herd onto the last-resort
   *    Claude tail (that population is the small set of safety-gating callers, by design).
   * Absent ⇒ feature OFF (byte-identical to today — a non-gating primary failure re-throws
   * straight to the caller's heuristic). `enabled` is resolved at the construction site
   * (default TRUE — a strict error reduction; the one-step + Claude-exclusion bound keeps
   * cost/herd flat). Reuses the SAME per-attempt cap machinery the gating loop uses.
   */
  nonGatingFailureSwap?: { enabled: boolean; maxAttempts?: number };
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
  /**
   * S4 A2 — the live, dev-gate-RESOLVED view of `sessions.natureRouting` (read on EVERY
   * call so the kill switch is hot). `enabled` is already the gate-resolved boolean
   * (resolved at the construction boundary, like `ladder`). Absent OR `enabled:false`
   * ⇒ the nature router is inert and routing is BYTE-IDENTICAL to today. When enabled +
   * dryRun (the dev-agent default) the resolver OBSERVES (computes + logs the plan via
   * `onNatureRoutePlan`) and still passes through to today's selection. When enabled +
   * `dryRun:false` (the operator's deliberate post-soak flip — A2.2) the resolved plan
   * REPLACES today's selection: the primary `(door, model)` is used and the swapTail feeds
   * the existing failure-swap loop.
   */
  resolveNatureRouting?: () => NatureRoutingRuntime | undefined;
  /**
   * S4 A2 — the resolved-plan observation sink (FD11 readable canary). Invoked with the
   * resolved plan on EVERY nature-routing call (dryRun AND enforcing) so the plan is always
   * observable. No-op downstream by default; the router calls it freely. The durable
   * `logs/nature-routing.jsonl` + `GET /intelligence/routing` surfaces that consume this,
   * and the FD6 critical-gate drift notice / baseline, are tracked follow-ups.
   */
  onNatureRoutePlan?: (plan: NatureRoutePlan) => void;
}

interface CachedFramework {
  provider: IntelligenceProvider | null; // null = built but unavailable (binary missing)
}

/**
 * Router-internal per-invocation decision context — the correlation spine
 * (llm-decision-quality-meter §5.1, FD1/FD7). Minted at `evaluate()` entry,
 * settled write-once at EVERY exit. Never escapes the router.
 */
interface DecisionCallContext {
  /** The router-minted correlation id (`d-<machineId8>-<uuid>` / `d-<uuid>`). */
  correlationId: string;
  /** The caller's Layer-B enrollment block, CONSUMED at mint (undefined = not enrolled). */
  provenance?: DecisionProvenanceBlock;
  /**
   * The router-INTERNAL shallow clone of the caller's options: `provenance`
   * stripped, correlation id + single-use mint marker attached (symbol-keyed,
   * enumerable — so every per-attempt spread of this clone carries its OWN
   * marker copy for the breaker to consume). The caller-visible object is
   * NEVER mutated (SEC r3), and any inbound correlation id on it is ignored.
   */
  internal: IntelligenceOptions;
  mintedAtMs: number;
  /** Write-once settlement latch; also discards late attempt callbacks (§5.1.5). */
  settled: boolean;
  /** Capture of the attempt whose promise the router actually returned. */
  settledCapture?: DecisionAttemptCapture;
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

/* ────────────────────────────────────────────────────────────────────────────
 * S4 Increment A2 — the nature-axis routing RESOLVER.
 *
 * `resolveRoute` is a PURE, side-effect-free evaluator (spec CR2-5): a stateless
 * fold `component → resolvedNature → ordered eligible positions → { primary, swapTail }
 * | 'fall-through' | 'no-route' | throw`. It owns no retry/backoff/breaker/budget
 * machinery — those stay in the existing IntelligenceRouter primitives. Wired into
 * `evaluate()` ONLY when `sessions.natureRouting.enabled` (dev-gated dark). In dryRun
 * (the dev-agent default, A2.1) it OBSERVES: computes + logs the plan, then passes through
 * to today's routing (byte-identical selection). When `dryRun:false` (A2.2, the operator's
 * deliberate post-soak flip) the resolved plan REPLACES today's selection — the primary
 * `(door, model)` is used and the swapTail feeds the existing failure-swap loop verbatim.
 * Spec: docs/specs/nature-axis-routing.md §Resolver / FD3 / FD4 / FD9.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The critical-gate fail-closed outcome (spec CR10-3/CR8-4): a DISTINCT typed error
 * so a caller can never mistake it for an ordinary model failure. A mapped FD6
 * critical gate whose chain has NO available door throws this; the caller applies its
 * existing gating fail-closed semantics (block/deny). The low-stakes empty-set case is
 * deliberately the ordinary non-gating error instead ('no-route'), typed apart on purpose.
 */
export class RouterFailClosedError extends Error {
  constructor(
    public readonly component: string | undefined,
    public readonly resolvedChain: RoutingChain,
  ) {
    super(
      `RouterFailClosedError: critical gate '${component ?? '(none)'}' has no available door on ` +
        `chain ${resolvedChain} — failing closed (never legacy category routing, never the harness door)`,
    );
    this.name = 'RouterFailClosedError';
  }
}

/** A chain position resolved to a concrete model id, after the FD4 allowlist clamp. */
export interface ResolvedRoutePosition {
  readonly door: RoutingDoor;
  /** The original benchmark label / tier hint from the chain position. */
  readonly label: string;
  /** The concrete model id the door should be asked for (post-registry, post-clamp). */
  readonly modelId: string;
  /** Whether the FD4 harness-door allowlist clamp rewrote this position to the reserve id. */
  readonly clamped: boolean;
}

/** The four load-bearing `resolveRoute` outcomes (verifier r7 — never collapse them). */
export type RouteResolution =
  | {
      outcome: 'route';
      resolvedNature: TaskNature;
      resolvedChain: RoutingChain;
      primary: ResolvedRoutePosition;
      swapTail: ResolvedRoutePosition[];
    }
  | { outcome: 'fall-through' } // unmapped → legacy category routing (the byte-identical safe default)
  | { outcome: 'no-route' }; // low-stakes mapped, all doors down → caller's own heuristic

/**
 * Tier ordering for the FD3 nature tighten rule `E, B ≥ D ≥ A`. E and B are
 * EQUIVALENT (both JUDGE-tier). A caller-declared nature may only ever RAISE the tier
 * (tighten, the safe direction); a same-tier or lower declared nature is ignored (map
 * wins), and a value outside {A,B,D,E} is ignored.
 */
const NATURE_TIER_RANK: Readonly<Record<TaskNature, number>> = { A: 0, D: 1, B: 2, E: 2 };

function isTaskNature(v: unknown): v is TaskNature {
  return v === 'A' || v === 'B' || v === 'D' || v === 'E';
}

/**
 * FD3 — resolve `{ resolvedNature, resolvedChain }` from the component's static map row
 * and an optional caller-declared `attribution.nature`. The component's OWN map row
 * `{nature, chain}` is authoritative by default (preserving a per-component A/FAST vs
 * A/SORT choice a pure nature→chain function could not). A caller-declared nature that
 * TIGHTENS (strictly raises the tier) replaces the chain with the deterministically
 * safe `JUDGE`; anything else is ignored. Returns `undefined` for an unmapped component.
 * Pure — always available, independent of `sessions.natureRouting`.
 */
export function resolveNatureAndChain(
  component: string | undefined,
  declaredNature?: unknown,
): { resolvedNature: TaskNature; resolvedChain: RoutingChain } | undefined {
  const row = routingNatureFor(component);
  if (!row) return undefined;
  const tightened =
    isTaskNature(declaredNature) && NATURE_TIER_RANK[declaredNature] > NATURE_TIER_RANK[row.nature];
  if (tightened) {
    // A tightened nature is always B or E (you only tighten UP a tier) → JUDGE ladder.
    return { resolvedNature: declaredNature as TaskNature, resolvedChain: 'JUDGE' };
  }
  return { resolvedNature: row.nature, resolvedChain: row.chain };
}

/**
 * FD-LABEL / FD4.1 — resolve a chain position's `model` label to a concrete model id via
 * `ROUTING_LABEL_TO_MODEL_ID`. A label absent from the registry (a tier hint like `fast`
 * / `capable`) passes through unchanged and is resolved downstream by the existing
 * per-adapter tier map. Pure.
 */
export function resolvePositionModelId(pos: ChainPosition): string {
  return ROUTING_LABEL_TO_MODEL_ID[pos.door]?.[pos.model] ?? pos.model;
}

/**
 * FD4 place 3 — the harness-door ALLOWLIST clamp (deny-by-default), the nature-routing
 * RUNTIME safety guarantee. For a bounded/gating (FAST/SORT/JUDGE) chain, the ONLY
 * permitted `claude-code` position is the single sanctioned CONCRETE reserve id
 * (`CLAUDE_CODE_RESERVE_MODEL_ID`); any OTHER claude-code id is clamped down to it. This
 * is an allowlist, NOT a denylist — a future/unrecognized capable Claude id can never
 * slip past. `WRITE` is exempt (its Opus-via-CLI quality lane is legitimate), and every
 * non-claude-code door passes through.
 *
 * DELIBERATELY SEPARATE from A1's `clampClaudeCliSwapModel` (which returns the `balanced`
 * TIER token and fires UNCONDITIONALLY on the always-on degrade/swap path): touching that
 * function would change A1's shipped, byte-identical-when-off behavior. This clamp is
 * nature-routing-scoped and concrete-id-based (FD4.1), applied only inside `resolveRoute`.
 */
export function clampToReserveOnCleanDoor(
  pos: ResolvedRoutePosition,
  resolvedChain: RoutingChain,
): ResolvedRoutePosition {
  if (resolvedChain === 'WRITE') return pos; // WRITE is the sole Opus-via-CLI-exempt lane
  if (pos.door !== 'claude-code') return pos; // the ban applies only to the harness door
  if (pos.modelId === CLAUDE_CODE_RESERVE_MODEL_ID) return pos; // allowlisted — the sanctioned reserve
  return { ...pos, modelId: CLAUDE_CODE_RESERVE_MODEL_ID, clamped: true }; // deny-by-default → reserve
}

/* ────────────────────────────────────────────────────────────────────────────
 * FD4.3 — the resolve-time + config-load CHAIN VALIDATOR (the static harness-door
 * ban as a PURE PREDICATE). This is the SAME rule the build-lint
 * (`scripts/lint-nature-chains.mjs`) enforces at compile time over the authored
 * defaults, run AGAIN on LIVE config: because an operator may `PATCH /config` a chain
 * wholesale (Adv2/Sec1), a banned chain must be rejected at config LOAD and at RESOLVE
 * time — not merely clamped per-position. Deny-by-default ALLOWLIST, never a denylist:
 * a future/unrecognized capable Claude id can never slip past (the Adv3 class).
 * Spec: docs/specs/nature-axis-routing.md FD4 (§202-225), FD4.2 (§296), FD8 (§393).
 *
 * DEV-GATED / BYTE-IDENTICAL WHEN OFF (the load-bearing safety property): this
 * predicate is consulted ONLY inside `mergeNatureRoutingChains` + `resolveRoute`, both
 * of which run ONLY when `sessions.natureRouting.enabled`. With the feature unset/off the
 * resolve path never reaches here, so routing is byte-identical to today (asserted in
 * tests: `evaluate() — nature routing is BYTE-IDENTICAL when unset/off`).
 * ──────────────────────────────────────────────────────────────────────────── */

/** The FD4 static-ban rules + the FD4.2 R-rule position bans a chain position can violate. */
export type NatureChainBanRule =
  | 'claude-code-non-reserve' // claude-code FAST/SORT/JUDGE resolves to a NON-reserve concrete id (e.g. Opus-family)
  | 'claude-code-tier-label' // claude-code FAST/SORT/JUDGE is an UNPINNED tier label (must be the PINNED concrete reserve id)
  | 'fable-banned' // ANY chain position (incl. WRITE) resolves to a Fable model (FD8 §393)
  | 'rrule-r3-qwen-strict-format' // R3: qwen-tier in a strict-format (FAST/SORT) position — chronic reason-burn self-clipping
  | 'rrule-r4-gemini-cli-judge' // R4: gemini-cli (consumer Flash 2.5) in an injection-exposed JUDGE position
  | 'rrule-r5-weak-model-judge' // R5: gpt-oss-20b / llama-4-scout in a gate (JUDGE) position
  | 'rrule-r7-deepseek-judge'; // R7: any DeepSeek door/model in an injection-exposed JUDGE position

/** One authored chain position that violates the FD4 harness-door ban. */
export interface NatureChainViolation {
  chain: RoutingChain;
  index: number;
  door: RoutingDoor;
  model: string;
  resolvedModelId: string;
  rule: NatureChainBanRule;
  detail: string;
}

/** Tier LABELS (as opposed to concrete model ids) — for message classification only; not load-bearing. */
const KNOWN_TIER_LABELS: ReadonlySet<string> = new Set([
  'fast',
  'balanced',
  'capable',
  'ultra',
  'reasoning',
]);

/** A model label/id names a Fable model — FD8 §393, never emitted by any nature chain. Pure. */
export function isFableModel(s: string): boolean {
  return /fable/i.test(s);
}

/**
 * Validate ONE chain position against the FD4 static ban (pure). Returns a violation or
 * null. The claude-code allowlist test compares the REGISTRY-RESOLVED concrete id against
 * the single sanctioned reserve id (FD4.1 — a tier label is permitted ONLY because/if it
 * pins through `ROUTING_LABEL_TO_MODEL_ID` to that concrete id; an unpinned label fails).
 */
export function validateChainPosition(
  chain: RoutingChain,
  pos: ChainPosition,
  index: number,
): NatureChainViolation | null {
  const resolvedModelId = ROUTING_LABEL_TO_MODEL_ID[pos.door]?.[pos.model] ?? pos.model;
  // FD8 §393 — no chain (incl. the Opus-CLI-exempt WRITE lane) may resolve to a Fable model.
  if (isFableModel(resolvedModelId) || isFableModel(pos.model)) {
    return {
      chain,
      index,
      door: pos.door,
      model: pos.model,
      resolvedModelId,
      rule: 'fable-banned',
      detail:
        `chain ${chain}[${index}] (${pos.door}/'${pos.model}') resolves to a Fable model ` +
        `('${resolvedModelId}') — no nature chain may emit Fable (FD8 §393).`,
    };
  }
  // The FD4 harness-door ban is scoped to bounded/gating chains; WRITE is the sole
  // Opus-via-CLI-exempt lane (open-ended writing is where Opus-via-CLI is the best route).
  if (chain === 'WRITE') return null;
  if (pos.door !== 'claude-code') return null; // the ban targets ONLY the harness door
  if (resolvedModelId === CLAUDE_CODE_RESERVE_MODEL_ID) return null; // allowlisted — the sanctioned pinned reserve
  const pinnedInRegistry = ROUTING_LABEL_TO_MODEL_ID['claude-code']?.[pos.model] !== undefined;
  if (!pinnedInRegistry && KNOWN_TIER_LABELS.has(pos.model)) {
    return {
      chain,
      index,
      door: pos.door,
      model: pos.model,
      resolvedModelId,
      rule: 'claude-code-tier-label',
      detail:
        `chain ${chain}[${index}] is claude-code/'${pos.model}' — an UNPINNED tier label. The one ` +
        `permitted claude-code position in a bounded/gating (FAST/SORT/JUDGE) chain must be the PINNED ` +
        `concrete reserve id '${CLAUDE_CODE_RESERVE_MODEL_ID}', not a tier label (FD4 §205: a label could ` +
        `resolve differently under a future CLI alias/tier remap).`,
    };
  }
  return {
    chain,
    index,
    door: pos.door,
    model: pos.model,
    resolvedModelId,
    rule: 'claude-code-non-reserve',
    detail:
      `chain ${chain}[${index}] resolves claude-code → '${resolvedModelId}', which is NOT the sanctioned ` +
      `reserve '${CLAUDE_CODE_RESERVE_MODEL_ID}'. Deny-by-default allowlist ban — the only permitted ` +
      `claude-code FAST/SORT/JUDGE position is that single reserve id (FD4 §202-217).`,
  };
}

/** Validate ONE chain's positions against the FD4 ban (pure). */
export function validateNatureRoutingChain(
  chain: RoutingChain,
  positions: ReadonlyArray<ChainPosition>,
): NatureChainViolation[] {
  const out: NatureChainViolation[] = [];
  positions.forEach((p, i) => {
    const v = validateChainPosition(chain, p, i);
    if (v) out.push(v);
  });
  return out;
}

/** Validate ALL four chains against the FD4 ban (pure). Empty array ⇒ the chain map is clean. */
export function validateNatureRoutingChains(chains: NatureRoutingChains): NatureChainViolation[] {
  const out: NatureChainViolation[] = [];
  for (const c of ['FAST', 'SORT', 'JUDGE', 'WRITE'] as RoutingChain[]) {
    out.push(...validateNatureRoutingChain(c, chains[c] ?? []));
  }
  return out;
}

/** True iff every chain passes the FD4 static harness-door ban. Pure. */
export function isNatureRoutingChainsValid(chains: NatureRoutingChains): boolean {
  return validateNatureRoutingChains(chains).length === 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * FD4.2 — the R-rule POSITION bans (R3/R4/R5/R7), enforced as pure predicates
 * exactly like the FD4 ban above and mirrored by the build-lint
 * (scripts/lint-nature-chains.mjs). These are STRUCTURAL exclusions over the
 * authored chains: a bench-condemned door/model must never appear in the chain
 * whose consumers it is unsafe for. They change NO runtime selection — the
 * shipped defaults are clean, so the rejection branch is never taken; the point
 * is that a future chain edit (source OR an operator `PATCH /config` override)
 * that reintroduced a banned placement is rejected → built-in defaults + notice.
 * Spec: docs/specs/nature-axis-routing.md FD5(c) §296-314; LLM-ROUTING-REGISTRY
 * hard rules #3/#5/#6. (R6/R8 are COMPONENT-scoped map pins — build-lint-only,
 * since the maps they guard are never operator-overridable.)
 * ──────────────────────────────────────────────────────────────────────────── */

/** Strict-format positions (R3): the bounded strict-JSON/verdict chains. */
const RRULE_STRICT_FORMAT_CHAINS: ReadonlySet<RoutingChain> = new Set(['FAST', 'SORT']);
/** R3 — qwen-tier is bench-condemned for bounded contract work (0.116/0.028 reason-burn self-clip). */
const RRULE_R3_QWEN = /qwen/i;
/** R4 — the consumer-Flash-2.5 CLI door (fell for a judge-directed injection). */
const RRULE_R4_GEMINI_CLI_DOOR: RoutingDoor = 'gemini-cli';
/** R5 — models bench-condemned for gate verdicts (injection-credulous / over-conservative contract-breakers). */
const RRULE_R5_WEAK_GATE = /gpt-oss-20b|llama-4-scout/i;
/** R7 — any DeepSeek door/model in an injection-exposed JUDGE slot. */
const RRULE_R7_DEEPSEEK = /deepseek/i;

/**
 * Validate ONE chain position against the FD4.2 R-rule position bans (R3/R4/R5/R7).
 * Returns the first violation or null. Pure. Both the authored LABEL (`pos.model`)
 * and the REGISTRY-RESOLVED concrete id are checked, so a banned model authored as a
 * label that resolves to it cannot slip past.
 */
export function validateChainPositionRRule(
  chain: RoutingChain,
  pos: ChainPosition,
  index: number,
): NatureChainViolation | null {
  const resolvedModelId = ROUTING_LABEL_TO_MODEL_ID[pos.door]?.[pos.model] ?? pos.model;
  const modelText = `${pos.model} ${resolvedModelId}`;
  const base = (rule: NatureChainBanRule, detail: string): NatureChainViolation => ({
    chain,
    index,
    door: pos.door,
    model: pos.model,
    resolvedModelId,
    rule,
    detail,
  });

  // R3 — qwen-tier never in a strict-format (FAST/SORT) bounded-contract position.
  if (RRULE_STRICT_FORMAT_CHAINS.has(chain) && RRULE_R3_QWEN.test(modelText)) {
    return base(
      'rrule-r3-qwen-strict-format',
      `chain ${chain}[${index}] (${pos.door}/'${pos.model}') is a qwen-tier model in a strict-format ` +
        `(FAST/SORT) position — R3: qwen-tier chronically reason-burns and self-clips its own JSON on bounded ` +
        `contract work (0.116/0.028). Route bounded verdicts to gpt-5.4-mini / flash-lite / the reserve instead.`,
    );
  }

  // R4/R5/R7 apply ONLY to the JUDGE (gate) chain — its consumers are the injection-exposed safety gates.
  if (chain !== 'JUDGE') return null;

  // R4 — gemini-cli (consumer Flash 2.5) never in an injection-exposed JUDGE position.
  if (pos.door === RRULE_R4_GEMINI_CLI_DOOR) {
    return base(
      'rrule-r4-gemini-cli-judge',
      `chain JUDGE[${index}] is the '${RRULE_R4_GEMINI_CLI_DOOR}' door — R4: consumer Flash 2.5 fell for a ` +
        `judge-directed injection; it may never take an injection-exposed JUDGE (safety-gate) position.`,
    );
  }
  // R5 — gpt-oss-20b / llama-4-scout never take a gate (JUDGE) verdict position.
  if (RRULE_R5_WEAK_GATE.test(modelText)) {
    return base(
      'rrule-r5-weak-model-judge',
      `chain JUDGE[${index}] (${pos.door}/'${pos.model}') — R5: gpt-oss-20b (injection-credulous, fabricates ` +
        `evidence wording) and llama-4-scout (systematic over-conservatism + contract-breaking prose) may never ` +
        `take a gate (JUDGE) verdict position.`,
    );
  }
  // R7 — any DeepSeek door/model never in an injection-exposed JUDGE position.
  if (RRULE_R7_DEEPSEEK.test(modelText) || RRULE_R7_DEEPSEEK.test(pos.door)) {
    return base(
      'rrule-r7-deepseek-judge',
      `chain JUDGE[${index}] (${pos.door}/'${pos.model}') is a DeepSeek door/model — R7: DeepSeek may never take ` +
        `an injection-exposed JUDGE (safety-gate) position.`,
    );
  }
  return null;
}

/** Validate ONE chain's positions against the FD4.2 R-rule position bans (pure). */
export function validateNatureRoutingChainRRules(
  chain: RoutingChain,
  positions: ReadonlyArray<ChainPosition>,
): NatureChainViolation[] {
  const out: NatureChainViolation[] = [];
  positions.forEach((p, i) => {
    const v = validateChainPositionRRule(chain, p, i);
    if (v) out.push(v);
  });
  return out;
}

/** Validate ALL four chains against BOTH the FD4 ban AND the FD4.2 R-rule position bans (pure). */
export function validateNatureRoutingChainAll(
  chain: RoutingChain,
  positions: ReadonlyArray<ChainPosition>,
): NatureChainViolation[] {
  return [
    ...validateNatureRoutingChain(chain, positions),
    ...validateNatureRoutingChainRRules(chain, positions),
  ];
}

/** The base component key (strip a "/segment" operation suffix + a `server:` prefix). */
function baseComponentKey(component: string | undefined): string | undefined {
  if (!component) return undefined;
  return component.split('/')[0].replace(/^server:/, '').trim();
}

/**
 * FD5b — is THIS call injection-exposed? Composes the STATIC per-component
 * classification (`resolveInjectionExposure`, fail-safe) with an OPTIONAL per-call
 * `attribution.injectionExposed` that may only TIGHTEN (mark an otherwise-trusted
 * call exposed), never relax a statically-exposed component. The static map is
 * authoritative for the exposed direction; the per-call flag can only raise it.
 * Pure — the resolver reads only the static data map.
 */
export function isComponentInjectionExposed(
  component: string | undefined,
  perCallExposed?: boolean,
): boolean {
  return resolveInjectionExposure(component) || perCallExposed === true;
}

/**
 * The PURE nature-routing fold (spec §Resolver, steps 1–7). Deps are injected so the
 * function is side-effect-free + trivially testable: `isDoorReachable` reports CLI-door
 * reachability (the class wraps its provider cache). Metered doors are ALWAYS skipped in
 * Increment A. The empty-`available` branch splits by authority class (CR6-2/CR3-1):
 * unmapped → 'fall-through'; low-stakes mapped → 'no-route'; FD6 critical gate → throw
 * RouterFailClosedError. (The R6 doc-tree refuse-to-author branch is a tracked A2.2
 * remainder; until it lands a `claudeBanned` component falls into the low-stakes 'no-route'
 * path — never onto Claude, since resolveRoute never emits a claude-code position for it
 * unless its chain contains one, and R6 chains are authored off-Claude.)
 */
export function resolveRoute(
  component: string | undefined,
  declaredNature: unknown,
  chains: NatureRoutingChains,
  deps: {
    isDoorReachable: (door: RoutingDoor) => boolean;
    /** FD4.3 — called when a live chain is rejected for a harness-door-ban violation (→ defaults). */
    onInvalidChain?: (chain: RoutingChain, violations: NatureChainViolation[]) => void;
    /**
     * FD5b — is this call injection-exposed? Injected so the exposure verdict is
     * evaluated FRESH per call (never served from a cached door-health verdict —
     * the injection-cache isolation contract, spec §764-766). Defaults to the
     * STATIC fail-safe classification; the class caller composes in the per-call
     * `attribution.injectionExposed` tighten via `isComponentInjectionExposed`.
     */
    isInjectionExposed?: (component: string | undefined) => boolean;
  },
): RouteResolution {
  const nc = resolveNatureAndChain(component, declaredNature);
  if (!nc) return { outcome: 'fall-through' }; // unmapped ⇒ legacy category routing (LA5 byte-identical)

  // FD4.3 resolve-time assertion (spec §221-225 / §Resolver step 3): a live chain that
  // violates the static harness-door ban is REJECTED → built-in defaults + notice. Because
  // chains are read live per call and an operator may `PATCH /config` a chain wholesale, this
  // runs on EVERY resolution (the same predicate the config-load merge + the build-lint use) —
  // a runtime chain edit can never open the banned route. The per-position clamp below is a
  // belt-and-suspenders third place; this rejection keeps the whole banned chain out.
  let positions = chains[nc.resolvedChain] ?? NATURE_ROUTING_DEFAULT_CHAINS[nc.resolvedChain];
  // FD4 harness-door ban + FD4.2 R-rule position bans (R3/R4/R5/R7) — same predicate
  // the config-load merge + the build-lint use. Clean defaults ⇒ empty ⇒ byte-identical.
  const chainViolations = validateNatureRoutingChainAll(nc.resolvedChain, positions);
  if (chainViolations.length > 0) {
    deps.onInvalidChain?.(nc.resolvedChain, chainViolations);
    positions = NATURE_ROUTING_DEFAULT_CHAINS[nc.resolvedChain];
  }
  // FD5b — evaluate injection exposure ONCE per call, fresh (never cached with door health).
  const exposed = (deps.isInjectionExposed ?? resolveInjectionExposure)(component);
  const available: ResolvedRoutePosition[] = [];
  for (const p of positions) {
    // Increment A: metered-API doors are DEFINED but always unavailable (skipped) until Increment B.
    if (METERED_ROUTING_DOORS.has(p.door)) continue;
    // FD5b injection gate (spec §283-294): an injection-exposed component may never land on a
    // non-injection-safe door (`injectionSafe: false`, e.g. groq-api/gpt-oss-120B). NO-OP in
    // Increment A — the only such door is ALSO metered, so it is already skipped above; this
    // preserves byte-identical behavior while sealing the route structurally for Increment B.
    if (exposed && p.injectionSafe === false) continue; // reason: injectionUnsafe
    if (!deps.isDoorReachable(p.door)) continue;
    const resolved: ResolvedRoutePosition = {
      door: p.door,
      label: p.model,
      modelId: resolvePositionModelId(p),
      clamped: false,
    };
    available.push(clampToReserveOnCleanDoor(resolved, nc.resolvedChain));
  }

  if (available.length === 0) {
    // FD6 critical gate with no door ⇒ FAIL CLOSED (distinct typed error). NEVER legacy routing.
    if (NATURE_ROUTING_CRITICAL_GATES.has(baseComponentKey(component) ?? '')) {
      throw new RouterFailClosedError(component, nc.resolvedChain);
    }
    // Low-stakes mapped ⇒ the caller's own non-gating heuristic (the ordinary provider-down contract).
    return { outcome: 'no-route' };
  }

  return {
    outcome: 'route',
    resolvedNature: nc.resolvedNature,
    resolvedChain: nc.resolvedChain,
    primary: available[0],
    swapTail: available.slice(1),
  };
}

/**
 * Merge an operator's partial `chains` override (config) over the built-in v3 defaults,
 * per-chain. A chain the operator did not override keeps its default. (The FD4.3
 * resolve-time validation that REJECTS a harness-door-violating override → defaults +
 * notice is a tracked A2.2 remainder; the FD4 place-3 runtime clamp above already keeps
 * the banned route closed on every resolved position regardless.)
 */
export function mergeNatureRoutingChains(
  override: Partial<Record<RoutingChain, ReadonlyArray<ChainPosition>>> | undefined,
  onReject?: (chain: RoutingChain, violations: NatureChainViolation[]) => void,
): NatureRoutingChains {
  if (!override) return NATURE_ROUTING_DEFAULT_CHAINS;
  // FD4.3 config-load assertion (spec §221-225): an operator override chain that violates the
  // static harness-door ban is REJECTED at LOAD → the built-in default for that chain (never the
  // banned override). Same predicate as the build-lint + the resolve-time assertion. A valid
  // override is passed through verbatim; an un-overridden chain keeps its default (unvalidated —
  // the shipped defaults are lint-verified clean).
  const pick = (c: RoutingChain): ReadonlyArray<ChainPosition> => {
    const ov = override[c];
    if (!ov) return NATURE_ROUTING_DEFAULT_CHAINS[c];
    // FD4 harness-door ban + FD4.2 R-rule position bans — reject a violating override → default.
    const violations = validateNatureRoutingChainAll(c, ov);
    if (violations.length > 0) {
      onReject?.(c, violations);
      return NATURE_ROUTING_DEFAULT_CHAINS[c]; // reject the banned override → built-in default
    }
    return ov;
  };
  return {
    FAST: pick('FAST'),
    SORT: pick('SORT'),
    JUDGE: pick('JUDGE'),
    WRITE: pick('WRITE'),
  };
}

/**
 * The dev-gate-resolved live view of `sessions.natureRouting` the router reads per call.
 * `enabled` is ALREADY gate-resolved at the construction boundary (like `ladder`), so the
 * router just reads the boolean. Absent ⇒ feature off ⇒ byte-identical routing.
 */
export interface NatureRoutingRuntime {
  enabled: boolean;
  /** Observe-only (default true on first enable): compute + log the plan, do NOT re-route. */
  dryRun: boolean;
  chains?: Partial<Record<RoutingChain, ReadonlyArray<ChainPosition>>>;
}

/** The dryRun observation record handed to `onNatureRoutePlan` (FD11 readable canary). */
export interface NatureRoutePlan {
  component: string | undefined;
  category: ComponentCategory;
  dryRun: boolean;
  resolution?: RouteResolution;
  /** Set when the resolver would FAIL CLOSED (critical-gate empty set). */
  failClosed?: boolean;
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

  /**
   * S4 A2 — CLI-door reachability probe for the nature router (FD5 availability walk).
   * CLI doors coincide 1:1 with `IntelligenceFramework`. `resolveRoute` skips metered
   * doors before ever calling this, so `door` is always a CLI door. The default framework
   * is always reachable (shared provider); a non-default door is reachable iff its provider
   * builds (binary present). Result is cached by `providerFor`.
   */
  private isCliDoorReachable(door: RoutingDoor): boolean {
    return this.resolveProvider(door as IntelligenceFramework) !== null;
  }

  /** Chains already warned about as rejected (warn ONCE per chain, never per call). */
  private warnedRejectedChains?: Set<RoutingChain>;

  /**
   * FD4.3 — a live/hot chain (an operator `PATCH /config` override, or a resolved chain)
   * violated the static harness-door ban and was REJECTED → built-in defaults. Warn ONCE
   * per chain so the rejection is visible (the banned route is never opened; the built-in
   * default is used instead). The full FD6 aggregated critical-gate attention item is a
   * tracked A2.2 remainder; this is the honest, non-silent minimum.
   */
  private warnNatureChainRejected(chain: RoutingChain, violations: NatureChainViolation[]): void {
    if (!this.warnedRejectedChains) this.warnedRejectedChains = new Set();
    if (this.warnedRejectedChains.has(chain)) return;
    this.warnedRejectedChains.add(chain);
    console.warn(
      `IntelligenceRouter: nature-routing chain '${chain}' REJECTED — it violates the FD4 harness-door ` +
        `ban and was replaced with the built-in default (the banned route is never opened). ` +
        violations.map((v) => v.detail).join(' | '),
    );
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    // ── Decision-quality correlation spine (llm-decision-quality-meter §5.1,
    // FD1/FD7). The router is the ONLY layer that sees one logical decision as
    // one call, so the mint lives here — unconditionally, always-on. Settlement
    // is write-once at EVERY exit: ladder success, ladder-final failure, the
    // !cfg early return, the provider-unavailable degrade arm, the
    // enforcedNoRoute throw, the RouterFailClosedError rethrow, and the
    // fallback-'none' throw ALL flow through this one try/catch.
    const decision = this.mintDecision(options);
    try {
      const result = await this.evaluateRouted(prompt, options, decision);
      this.settleDecision(decision, result);
      return result;
    } catch (err) {
      this.settleDecisionErrored(decision, err);
      throw err;
    }
  }

  /**
   * Mint the per-decision correlation id on a router-INTERNAL clone (§5.1.1).
   * The caller's options object is NEVER mutated; `options.provenance` is
   * consumed here (stripped before any per-attempt spread can carry it down —
   * §5.1.6); `onCorrelationId` fires synchronously at mint, exactly once per
   * `evaluate()` invocation INCLUDING calls that later throw, never after
   * settlement — and a throwing callback is caught + counted, never propagated
   * (the decision call is never failed by its audit trail, §5.1.4).
   */
  private mintDecision(options: IntelligenceOptions | undefined): DecisionCallContext {
    const correlationId = mintRouterCorrelationId();
    const provenance = options?.provenance;
    if (provenance?.onCorrelationId) {
      try {
        provenance.onCorrelationId(correlationId);
      } catch {
        bumpOnCorrelationIdThrow();
      }
    }
    const internal: IntelligenceOptions = { ...(options ?? {}) };
    delete internal.provenance;
    // Assign (never spread-inherit) both slots: an inbound correlation id or
    // marker on the caller's object is ignored by construction (FD8).
    (internal as Record<PropertyKey, unknown>)[DECISION_CORRELATION_ID] = correlationId;
    (internal as Record<PropertyKey, unknown>)[DECISION_MINT_MARKER] = true;
    return { correlationId, provenance, internal, mintedAtMs: Date.now(), settled: false };
  }

  /**
   * Run ONE attempt of the current decision (§5.1.5 — per-attempt capture
   * scoping). Every attempt gets a FRESH options object: a spread of the
   * internal clone (the symbol-keyed correlation id + mint marker ride the
   * spread; the breaker consumes each copy's marker single-use) with fresh
   * capture wrappers composed over the caller's callbacks and any attempt
   * extras. Only the attempt whose promise the router actually returns
   * contributes its capture to the settlement: a rejected attempt's callbacks
   * land in its own unread capture, and any callback firing AFTER settlement
   * (a withSwapTimeout-abandoned attempt) is discarded by the settled latch.
   */
  private async runAttempt(
    provider: IntelligenceProvider,
    prompt: string,
    decision: DecisionCallContext,
    opts?: {
      /** Attempt-specific option overrides (timeoutMs / model / rateLimitWaitMs). */
      extra?: Partial<IntelligenceOptions>;
      /** withSwapTimeout race cap for this attempt (the same bound flows as `extra.timeoutMs`). */
      capMs?: number;
      capTarget?: string;
      /** Extra usage observer for this attempt (the non-gating produced-tokens probe). */
      usageProbe?: (u: { inputTokens: number; outputTokens: number; cachedTokens?: number }) => void;
    },
  ): Promise<string> {
    const base = decision.internal;
    const callerOnUsage = base.onUsage;
    const callerOnModel = base.onModel;
    const capture: DecisionAttemptCapture = {};
    const attemptOptions: IntelligenceOptions = {
      ...base,
      ...(opts?.extra ?? {}),
      onUsage: (u) => {
        opts?.usageProbe?.(u);
        if (!decision.settled) capture.usage = u;
        callerOnUsage?.(u);
      },
      onModel: (info) => {
        if (!decision.settled) capture.resolved = info;
        callerOnModel?.(info);
      },
    };
    const inFlight = provider.evaluate(prompt, attemptOptions);
    const result =
      opts?.capMs !== undefined
        ? await withSwapTimeout(inFlight, opts.capMs, opts.capTarget ?? 'unknown')
        : await inFlight;
    // This resolution is the one being returned up the ladder — its capture is
    // the settlement capture. A withSwapTimeout-abandoned attempt never reaches
    // this line (its race already rejected), and a queue-abandoned late
    // resolution is discarded by the latch.
    if (!decision.settled) decision.settledCapture = capture;
    return result;
  }

  /** Write-once settlement on a SUCCESSFUL exit (FD7). */
  private settleDecision(decision: DecisionCallContext, result: string): void {
    if (decision.settled) return; // write-once
    decision.settled = true;
    if (!getDecisionQualityRecorder()) return; // no substrate injected — clean no-op
    // classifyVerdict is documented pure/cheap and try/catch-contained
    // (types.ts): the settlement re-runs it for the decision row's verdict
    // class + the FD8 callerRef relocation (the funnel's metric-row
    // classification is a separate concern).
    let verdictClass = 'unclassified';
    let callerRef: string | undefined;
    const classify = decision.internal.classifyVerdict;
    if (classify) {
      try {
        const v = classify(result);
        verdictClass = v?.acted ? 'fired' : 'noop';
        callerRef = v?.verdictId;
      } catch {
        /* contained: a throwing classifier leaves 'unclassified' */
      }
    }
    // §5.1.5: an ENROLLED unclassified settlement carries a bounded raw-response
    // head for the provenance row's context (the seam scrubs + clamps to 300);
    // it never enters the served `decision` field, and unenrolled settlements
    // never carry raw content at all.
    const rawResponseHead =
      decision.provenance !== undefined && verdictClass === 'unclassified'
        ? result.slice(0, 600)
        : undefined;
    this.recordSettlement(decision, verdictClass, undefined, callerRef, rawResponseHead);
  }

  /**
   * Write-once settlement on ANY throwing exit (FD7): the decision still yields
   * exactly one row — `'<errored>'` + the error class — so failure-swap-ladder
   * quality is itself gradeable, without N phantom decisions.
   */
  private settleDecisionErrored(decision: DecisionCallContext, err: unknown): void {
    if (decision.settled) return; // write-once
    decision.settled = true;
    if (!getDecisionQualityRecorder()) return;
    const errorClass =
      err instanceof Error ? err.constructor?.name || err.name || 'Error' : typeof err;
    this.recordSettlement(decision, '<errored>', errorClass, undefined);
  }

  /** The single settlement write — isolated so a recorder throw can never reach the decision path (§5.1.7). */
  private recordSettlement(
    decision: DecisionCallContext,
    verdictClass: string,
    errorClass: string | undefined,
    callerRef: string | undefined,
    rawResponseHead?: string,
  ): void {
    const recorder = getDecisionQualityRecorder();
    if (!recorder) return;
    const p = decision.provenance;
    const capture = decision.settledCapture;
    try {
      recorder.recordSettlement({
        correlationId: decision.correlationId,
        mintedBy: 'router',
        enrolled: p !== undefined,
        provenance: p
          ? {
              decisionPoint: p.decisionPoint,
              context: p.context,
              optionsPresented: p.optionsPresented,
              promptId: p.promptId,
            }
          : undefined,
        settledAttempt: {
          model: capture?.resolved?.model,
          framework: capture?.resolved?.framework,
          usage: capture?.usage,
        },
        verdictClass,
        errorClass,
        // FD8: a caller-supplied classifyVerdict.verdictId is recorded as
        // callerRef ONLY when a provenance row is being written (enrolled);
        // it is dropped for llm rows otherwise.
        callerRef: p !== undefined ? callerRef : undefined,
        rawResponseHead,
        mintedAtMs: decision.mintedAtMs,
        settledAtMs: Date.now(),
      });
    } catch {
      /* the decision call is never failed or delayed by its audit trail */
    }
  }

  private async evaluateRouted(
    prompt: string,
    options: IntelligenceOptions | undefined,
    decision: DecisionCallContext,
  ): Promise<string> {
    const component = options?.attribution?.component;
    const explicitCategory = (options?.attribution as { category?: unknown } | undefined)?.category;
    const category: ComponentCategory = isComponentCategory(explicitCategory)
      ? explicitCategory
      : categoryForComponent(component);

    const cfg = this.opts.resolveConfig();

    // ── S4 A2 — nature-axis routing (dev-gated dark; dryRun-first). ──
    // Byte-identical when unset/off: when the feature is absent OR `enabled:false` this
    // whole block is skipped and NOTHING about selection changes. In dryRun (the dev-agent
    // default) it OBSERVES only — computes + logs the plan via `onNatureRoutePlan` — and
    // still falls through to today's selection below. When ENFORCING (`dryRun:false`, the
    // operator's deliberate flip after the dryRun soak — A2.2) the resolved plan REPLACES
    // today's selection (spec §Resolver steps 8-9): the primary `(door, model)` becomes the
    // selection and the `swapTail` feeds the EXISTING failure-swap loop verbatim. A resolver
    // error can never break routing here — the DESIGNED critical-gate fail-closed throw
    // (`RouterFailClosedError`) propagates on the real path so the gate caller applies its
    // own fail-closed semantics; any UNEXPECTED resolver error falls through to today's
    // selection (fail-safe). In dryRun EVERY outcome (route / no-route / throw) is recorded
    // only — nothing is ever withheld or re-routed.
    let enforced: { primary: ResolvedRoutePosition; swapTail: ResolvedRoutePosition[] } | undefined;
    let enforcedNoRoute = false;
    const natureRt = this.opts.resolveNatureRouting?.();
    if (natureRt?.enabled) {
      const dryRun = natureRt.dryRun !== false; // default true on first enable
      try {
        const resolution = resolveRoute(
          component,
          options?.attribution?.nature,
          mergeNatureRoutingChains(natureRt.chains, (c, v) => this.warnNatureChainRejected(c, v)),
          {
            isDoorReachable: (d) => this.isCliDoorReachable(d),
            onInvalidChain: (c, v) => this.warnNatureChainRejected(c, v),
            // FD5b — static exposure OR the per-call tightening flag (never relaxes static).
            isInjectionExposed: (comp) =>
              isComponentInjectionExposed(
                comp,
                (options?.attribution as { injectionExposed?: unknown } | undefined)?.injectionExposed === true,
              ),
          },
        );
        this.opts.onNatureRoutePlan?.({ component, category, dryRun, resolution });
        if (!dryRun) {
          // ENFORCE (A2.2): the resolved plan becomes the actual selection.
          if (resolution.outcome === 'route') {
            enforced = { primary: resolution.primary, swapTail: resolution.swapTail };
          } else if (resolution.outcome === 'no-route') {
            // Low-stakes mapped, all chain doors down ⇒ the caller's OWN non-gating heuristic
            // (the ordinary provider-down contract) — NEVER legacy category routing, so the
            // harness door can't re-open for a nature-routed component (spec §573-581).
            enforcedNoRoute = true;
          }
          // 'fall-through' (unmapped) ⇒ leave enforcement unset → today's category routing below.
        }
      } catch (e) {
        if (e instanceof RouterFailClosedError) {
          this.opts.onNatureRoutePlan?.({ component, category, dryRun, failClosed: true });
          // ENFORCE (A2.2): a mapped FD6 critical gate with no available door FAILS CLOSED on
          // the real path — the caller applies its gating fail-closed semantics (block/deny),
          // never legacy routing and never the harness door. In dryRun the throw is swallowed
          // (observe-and-record only), never surfaced to the call path.
          if (!dryRun) throw e;
        } else {
          // An UNEXPECTED resolver error (the pure fold only THROWS `RouterFailClosedError` by
          // design). Record it and fall through to today's selection — an unexpected error must
          // never break routing (fail-safe); a real empty-set critical gate is the typed error
          // above, never this branch.
          this.opts.onNatureRoutePlan?.({ component, category, dryRun });
        }
      }
    }

    // ENFORCE 'no-route': raise the ordinary non-gating error the caller already catches into
    // its heuristic (tracked never-silent). NEVER legacy category routing (harness-door re-open).
    if (enforcedNoRoute) {
      this.opts.onHeuristicFallthrough?.(component ?? '(none)', this.opts.defaultFramework);
      throw new Error(
        `IntelligenceRouter: nature-routing 'no-route' — no available door for low-stakes ` +
          `'${component ?? '(none)'}' (all chain doors unreachable); caller uses its heuristic.`,
      );
    }

    // Selection: an enforced nature plan supersedes category routing (its primary door is
    // guaranteed reachable — the resolver only emits reachable CLI doors). Otherwise today's
    // behavior: unconfigured componentFrameworks ⇒ the default provider verbatim.
    let framework: IntelligenceFramework;
    if (enforced) {
      framework = enforced.primary.door as IntelligenceFramework; // resolver emits CLI doors only
      // The resolved primary's CONCRETE model id REPLACES the caller's tier hint (spec step 8).
      // It is already reserve-clamped by the resolver (clampToReserveOnCleanDoor); a concrete id
      // rides `options.model` verbatim to the provider (the adapters resolve tier-or-id).
      // Folded into the decision's internal clone so every subsequent attempt inherits it.
      decision.internal = {
        ...decision.internal,
        model: enforced.primary.modelId as IntelligenceOptions['model'],
      };
    } else {
      if (!cfg) return this.runAttempt(this.opts.defaultProvider, prompt, decision);
      framework = this.resolveFramework(component, category, cfg);
    }
    const primary = this.resolveProvider(framework);

    // Provider unavailable (binary missing / not built) — unchanged: degrade or error.
    // (`cfg?.` because an enforced nature plan may have superseded category routing with a
    // null `cfg`; an enforced primary door is always reachable, so this branch stays legacy.)
    if (!primary) {
      if ((cfg?.fallback ?? 'default') === 'none') {
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
      let degradeExtra: Partial<IntelligenceOptions> | undefined;
      if (isBoundedGatingDegrade(component, options)) {
        const { model: clampedModel, clamped } = clampClaudeCliSwapModel(
          this.opts.defaultFramework,
          options?.model,
        );
        if (clamped) {
          degradeExtra = { model: clampedModel };
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
      return this.runAttempt(this.opts.defaultProvider, prompt, decision, { extra: degradeExtra });
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
    // An enforced nature plan supplies the resolved `swapTail` (each a door + concrete model,
    // already reserve-clamped); the legacy path supplies the config `failureSwap` frameworks
    // (each taking the caller's tier, clamped per-door in the loop). BOTH ride the SAME
    // gating||deferrable gate and the SAME loop below — the spec's "reuse verbatim".
    const swapPositions: ReadonlyArray<{ door: IntelligenceFramework; model?: string }> =
      gating || deferrable
        ? enforced
          ? enforced.swapTail.map((p) => ({ door: p.door as IntelligenceFramework, model: p.modelId }))
          : (cfg?.failureSwap ?? []).map((fw) => ({ door: fw }))
        : [];
    // GATING budget: a single hard wall-clock deadline over the whole gating failure path so an
    // awaited gate stays responsive (no stacking rungs). Deferrable calls are not budgeted this way.
    const gatingDeadlineAt = gating && ladder ? Date.now() + ladder.gatingLadderBudgetMs : undefined;

    // NON-GATING bounded failure-swap (docs/specs/nongating-failure-swap.md). A non-gating,
    // non-deferrable, non-nature-enforced internal call is ELIGIBLE for a bounded, herd-safe
    // swap when the feature is on and a config `failureSwap` tail exists. To honor the §6.4
    // caller-handled-malformed-output contract, the swap must fire ONLY on an INVOCATION-level
    // failure (zero tokens produced), never on a content/parse error that carried tokens — so
    // we compose an onUsage probe onto the PRIMARY attempt to observe whether it produced any
    // tokens. The probe is installed ONLY on the eligible path; gating/deferrable/enforced
    // calls carry no probe (byte-identical). A provider that never surfaces usage
    // (gemini-cli) leaves `primaryProducedTokens` false, so its errors are treated as
    // invocation-level (swap) — the conservative, error-reducing direction when unobservable.
    const nonGatingSwapEligible =
      !gating &&
      !deferrable &&
      !enforced &&
      this.opts.nonGatingFailureSwap?.enabled === true &&
      (cfg?.failureSwap?.length ?? 0) > 0;
    let primaryProducedTokens = false;
    // The produced-tokens probe is composed INTO the primary attempt's fresh
    // per-attempt wrapper (runAttempt) — installed only on the eligible path.
    const primaryUsageProbe = nonGatingSwapEligible
      ? (u: { inputTokens: number; outputTokens: number }) => {
          if (u.inputTokens > 0 || u.outputTokens > 0) primaryProducedTokens = true;
        }
      : undefined;

    let err: unknown;
    try {
      const mainResult = await this.runAttempt(primary, prompt, decision, {
        usageProbe: primaryUsageProbe,
      });
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
            const boResult = await this.runAttempt(primary, prompt, decision, {
              extra: { rateLimitWaitMs: jittered },
            });
            this.opts.onResolved?.(component ?? '(none)', framework); // recovered on backoff → auto-resolve
            return boResult;
          } catch (retryErr) {
            err = retryErr;
            if (!isRateLimitError(retryErr)) break; // a hard error → stop backing off, go to swap
          }
        }
      }
      if (swapPositions.length === 0) {
        // NON-GATING bounded failure-swap: a non-gating call whose PRIMARY INVOCATION failed
        // (zero tokens produced) gets a bounded, herd-safe swap onto the next active off-Claude
        // framework before dropping to its heuristic. A content/parse error that carried tokens is
        // NOT swapped (`primaryProducedTokens` true ⇒ skip — the caller fail-opens it, §6.4). On
        // success we return before the heuristic-fallthrough tracking below (no false degradation).
        if (nonGatingSwapEligible && !primaryProducedTokens) {
          const ng = await this.tryNonGatingSwap(
            cfg, prompt, decision, component ?? '(none)', framework, category, err,
          );
          if (ng.ok) return ng.result;
        }
        // RUNG (c) — DEFERRABLE queue: no swap configured, but a deferrable call can WAIT for capacity
        // in the LlmQueue before dropping to its heuristic. gating can never reach here (deferrable =
        // !gating && …) — the D5 queue-skip invariant is structural.
        if (deferrable) {
          const q = await this.tryDeferrableQueue(primary, prompt, decision, component ?? '(none)', framework, category);
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
      for (const t of swapPositions) {
        const target = t.door;
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
        // Model for this swap attempt:
        //  - NATURE-enforced position (`t.model` set): its OWN concrete model id, already
        //    reserve-clamped by the resolver (`clampToReserveOnCleanDoor`) — so it always
        //    overrides the base options.model, and the A1 tier-clamp below is a no-op on it.
        //  - LEGACY position (`t.model` undefined): the caller's tier, clamped per SAFETY
        //    (S2, R1/R2) — a bounded/gating swap onto claude-code requesting `capable` would
        //    resolve to Opus-via-Claude-CLI (the measured-banned door, 81.7% vs 99.1%); clamp
        //    it down to `balanced` (Sonnet CLI reserve). Only ever narrows; never upgrades.
        let attemptModel: IntelligenceOptions['model'] | undefined;
        let overrideModel: boolean;
        if (t.model !== undefined) {
          attemptModel = t.model as IntelligenceOptions['model'];
          overrideModel = true;
        } else {
          const clamp = clampClaudeCliSwapModel(target, options?.model);
          attemptModel = clamp.model;
          overrideModel = clamp.clamped;
          if (clamp.clamped) {
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
        }
        // Pass the cap through as the provider's per-call timeout so the subprocess
        // self-terminates at the bound (no AbortSignal exists on IntelligenceOptions).
        // Base is the decision's internal clone (byte-identical to `options` on the
        // legacy path, plus the correlation plumbing); an enforced position's model
        // always overrides it below.
        const attemptExtra: Partial<IntelligenceOptions> | undefined =
          cap !== undefined || overrideModel
            ? {
                ...(cap !== undefined ? { timeoutMs: cap } : {}),
                ...(overrideModel ? { model: attemptModel } : {}),
              }
            : undefined;
        try {
          // withSwapTimeout (inside runAttempt) keeps the shipped, crash-safe
          // Promise.race pattern (InputGuard precedent): it attaches a settlement
          // handler to EACH input, so a late rejection from an abandoned attempt is
          // already handled (no unhandledRejection) and a late resolve is ignored.
          // NEVER a detached/awaited handle. It additionally CLEARS the timer on
          // settle (FD7) so a fast success does not leak a pending timer.
          const result = await this.runAttempt(tp, prompt, decision, {
            extra: attemptExtra,
            capMs: cap,
            capTarget: target,
          });
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
        const q = await this.tryDeferrableQueue(primary, prompt, decision, component ?? '(none)', framework, category);
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
   * NON-GATING bounded failure-swap (docs/specs/nongating-failure-swap.md). Invoked ONLY from
   * the non-gating branch of evaluate() after the PRIMARY suffered an INVOCATION-level failure
   * (threw with ZERO tokens produced). It attempts at most `maxAttempts` (default 1) steps down
   * the config `failureSwap` tail — each target circuit-checked (a binary-missing or
   * circuit-open target is skipped) and bounded by the SAME per-attempt cap machinery the gating
   * loop uses (resolveSwapCap + withSwapTimeout). It NEVER targets `claude-code` or the default
   * framework: a non-gating background call must never herd onto the last-resort Claude tail
   * (provider-fallback §6.2). Returns the first successful answer, else `{ ok: false }` so the
   * caller falls through to its heuristic (the byte-identical legacy outcome). Metrics honesty is
   * automatic: each provider's own CircuitBreaking wrapper records its own feature_metrics row
   * (the codex error row with zero usage; the pi success row with pi's usage/model) — this helper
   * adds no recording, only onDegrade/onResolved observability notes.
   */
  private async tryNonGatingSwap(
    cfg: ComponentFrameworksConfig | undefined,
    prompt: string,
    decision: DecisionCallContext,
    component: string,
    primaryFramework: IntelligenceFramework,
    category: ComponentCategory,
    firstErr: unknown,
  ): Promise<{ ok: true; result: string } | { ok: false }> {
    const ng = this.opts.nonGatingFailureSwap;
    if (!ng?.enabled) return { ok: false };
    const tail = cfg?.failureSwap ?? [];
    if (tail.length === 0) return { ok: false };
    const maxAttempts =
      typeof ng.maxAttempts === 'number' && Number.isInteger(ng.maxAttempts) && ng.maxAttempts > 0
        ? ng.maxAttempts
        : 1;
    // Herd-safety (§6.2 / R1): a non-gating background call must NEVER herd onto the last-resort
    // default framework or claude-code (the measured-banned bounded-verdict door). Exclude both
    // + the framework that just failed, then take at most `maxAttempts` steps down the tail.
    const targets = tail
      .filter((fw) => fw !== 'claude-code' && fw !== this.opts.defaultFramework && fw !== primaryFramework)
      .slice(0, maxAttempts);
    if (targets.length === 0) return { ok: false };

    const globalCapMs = this.opts.nonGatingSwapTimeoutMs;
    const byFramework = this.opts.swapAttemptTimeoutMsByFramework;
    this.warnUnknownSwapCapKeys(byFramework);
    const maxCapMs = this.opts.swapAttemptTimeoutMsMax;

    for (const target of targets) {
      const tp = this.resolveProvider(target);
      if (!tp) continue; // target binary missing → skip
      const cap = resolveSwapCap(target, globalCapMs, byFramework, maxCapMs);
      try {
        // Model-size preservation (Q5): the caller's tier travels verbatim. No claude-code
        // tier-clamp is needed here — claude-code is excluded from non-gating targets above.
        // withSwapTimeout (inside runAttempt) keeps the shipped crash-safe Promise.race
        // pattern (per-input settlement handlers → a late reject/resolve from an abandoned
        // attempt is handled/ignored) and clears the timer on settle. The cap also flows
        // through as the provider's per-call `timeoutMs` so the CLI subprocess SIGTERMs
        // itself at the same bound.
        const result = await this.runAttempt(tp, prompt, decision, {
          extra: cap !== undefined ? { timeoutMs: cap } : undefined,
          capMs: cap,
          capTarget: target,
        });
        this.opts.onDegrade?.({
          component,
          category,
          from: primaryFramework,
          to: target,
          reason: `nongating-failure-swap: '${primaryFramework}' invocation failed (${firstErr instanceof Error ? firstErr.message : 'error'}); served by '${target}'`,
        });
        this.opts.onResolved?.(component, primaryFramework); // a real answer via swap → auto-resolve
        return { ok: true, result };
      } catch (attemptErr) {
        // A timed-out attempt emits a distinct degrade reason (visible in DegradationReporter +
        // /metrics/features), then the loop advances / gives up (fail-open per-attempt).
        if (attemptErr instanceof Error && attemptErr.message.startsWith('swap-attempt-timeout:')) {
          this.opts.onDegrade?.({
            component,
            category,
            from: primaryFramework,
            to: target,
            reason: `nongating-swap-attempt-timeout: ${target}`,
          });
        }
        continue; // target also down (timeout / circuit-open / binary-missing / error) → next / give up
      }
    }
    return { ok: false };
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
    decision: DecisionCallContext,
    component: string,
    framework: IntelligenceFramework,
    category: ComponentCategory,
  ): Promise<{ ok: true; result: string } | { ok: false }> {
    const q = this.opts.llmQueue;
    const ladder = this.opts.ladder;
    if (!q || !ladder?.queueEnabled) return { ok: false };
    const bound = ladder.queueAttemptTimeoutMs ?? 0;
    try {
      const result = await q.enqueue('background', () =>
        this.runAttempt(primary, prompt, decision, {
          extra: bound > 0 ? { timeoutMs: bound } : undefined,
        }),
      );
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
