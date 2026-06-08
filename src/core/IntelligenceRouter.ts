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

export interface IntelligenceRouterOptions {
  /** The existing shared provider for the default framework (global breaker). Used unconfigured + for default-routed calls. */
  defaultProvider: IntelligenceProvider;
  /** Which framework defaultProvider speaks. */
  defaultFramework: IntelligenceFramework;
  /** Live config getter — read on EVERY call so changes are hot. Returns undefined ⇒ routing disabled (all default). */
  resolveConfig: () => ComponentFrameworksConfig | undefined;
  /**
   * Build a provider for a non-default framework, with its OWN circuit breaker.
   * Returns null when that framework's binary isn't available. Called at most
   * once per framework (result cached). MUST NOT throw (catch internally).
   */
  buildProvider: (framework: IntelligenceFramework) => IntelligenceProvider | null;
  /** Optional: invoked when a routed call degrades to the default framework (for DegradationReporter). */
  onDegrade?: (info: RouterDegradeInfo) => void;
}

interface CachedFramework {
  provider: IntelligenceProvider | null; // null = built but unavailable (binary missing)
}

export class IntelligenceRouter implements IntelligenceProvider {
  private readonly cache = new Map<IntelligenceFramework, CachedFramework>();

  constructor(private readonly opts: IntelligenceRouterOptions) {}

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
      return this.opts.defaultProvider.evaluate(prompt, options);
    }

    // Failure-swap: ONLY a safety-gating call with configured failureSwap targets
    // swaps on a RUNTIME failure (rate-limit / circuit-open / error). Non-gating
    // calls keep today's behavior — the error propagates and the caller swallows it
    // into its heuristic (no herd onto the fallback). This is the herd-aware half of
    // "No Silent Degradation to Brittle Fallback": swap-before-fail-closed, scoped
    // tightly so a rate-limited framework can't dump its whole load onto another.
    const gating = options?.attribution?.gating === true;
    const swapTargets = gating && cfg.failureSwap ? cfg.failureSwap : [];

    try {
      return await primary.evaluate(prompt, options);
    } catch (err) {
      if (swapTargets.length === 0) throw err; // not gating / no swap configured ⇒ today's behavior
      for (const target of swapTargets) {
        if (target === framework) continue; // don't retry the framework that just failed
        const tp = this.resolveProvider(target);
        if (!tp) continue; // target binary missing → skip
        try {
          const result = await tp.evaluate(prompt, options);
          this.opts.onDegrade?.({
            component: component ?? '(none)',
            category,
            from: framework,
            to: target,
            reason: `failure-swap: '${framework}' failed (${err instanceof Error ? err.message : 'error'}); served by '${target}'`,
          });
          return result;
        } catch {
          continue; // target also down (circuit-open / error) → try the next one
        }
      }
      // Every swap target is also down → re-throw so the (gating) caller fails CLOSED,
      // never silently degrading to a brittle heuristic.
      throw err;
    }
  }
}
