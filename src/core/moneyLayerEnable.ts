/**
 * moneyLayerEnable — the PURE vocabulary and state derivation of the money-layer
 * operator enable surface (docs/specs/money-layer-operator-enable-surface.md,
 * Phase 1).
 *
 * This module holds NO I/O. It exists so the five terms the spec's glossary
 * separates stay separated in code as well as in prose:
 *
 *   intentEnabled   — the operator ASKED for the layer on (store OR config)
 *   lifecycleState  — the CONSTRUCTION/probe state
 *   servingReady    — money MAY move (intent && probed && lock held)
 *   enforcementReady— the API field for servingReady, identical BY DEFINITION
 *   enableSources   — WHICH source enabled it
 *
 * The trap this vocabulary exists to avoid: *asked for*, *built*, and *permitted
 * to spend* are three different facts, and collapsing any two produces a surface
 * that reports one while the spend path enforces another (MLE-2).
 */

/**
 * The pre-gate action allowlist (§2). The commit route accepts a signed action
 * IFF it is a member of this enum — keyed on the ACTION VALUE, never on "the
 * body looks like an enable", so the exempt set is greppable and testable.
 *
 * FOUR public actions. `money-layer-disable-store-only` is public precisely so
 * that what the operator approved is visible in the signed plan and the audit.
 */
export const MONEY_LAYER_PREGATE_ACTIONS = [
  'money-layer-enable',
  'money-layer-mirror-config',
  'money-layer-disable',
  'money-layer-disable-store-only',
] as const;

export type MoneyLayerPregateAction = (typeof MONEY_LAYER_PREGATE_ACTIONS)[number];

const PREGATE_ACTION_SET: ReadonlySet<string> = new Set(MONEY_LAYER_PREGATE_ACTIONS);

export function isMoneyLayerPregateAction(v: unknown): v is MoneyLayerPregateAction {
  return typeof v === 'string' && PREGATE_ACTION_SET.has(v);
}

/**
 * The construction/probe state. The token `ready` is REJECTED legacy
 * terminology and must never appear as a lifecycle value (T22) — `probed` is
 * the value. `enforcementReady` is a different, retained FIELD name; the banned
 * thing is the bare lifecycle value.
 */
export type MoneyLifecycleState =
  | 'disabled'
  | 'enable-pending-restart'
  | 'probed'
  | 'probe-failed'
  | 'construction-failed';

/** WHICH source enabled the layer (MLE-1). A separate axis from lifecycleState; the two are never merged. */
export type EnableSourceState = 'disabled' | 'operator-enabled' | 'config-enabled' | 'both-enabled';

export interface EnableSources {
  state: EnableSourceState;
  store: boolean;
  config: boolean;
  /**
   * TRUE when the operator should be told about this state on the primary
   * surface. `config-enabled` is surfaced because a disable cannot clear it;
   * `both-enabled` is informational only (detail view).
   */
  surfaced: boolean;
}

/**
 * MLE-1 — two inputs, one question. An OR, so neither source can silently
 * disable what the other enabled.
 */
export function resolveEnableSources(store: boolean, config: boolean): EnableSources {
  const state: EnableSourceState = store && config
    ? 'both-enabled'
    : store
      ? 'operator-enabled'
      : config
        ? 'config-enabled'
        : 'disabled';
  return { state, store, config, surfaced: state === 'config-enabled' };
}

/** `intentEnabled` — the operator asked for the layer on. Never permission to spend (MLE-2). */
export function resolveIntentEnabled(sources: EnableSources): boolean {
  return sources.store || sources.config;
}

/**
 * Should the money layer's COMPONENTS be constructed at server start?
 *
 * This is `intentEnabled` and nothing else — but it lives as its own named
 * export because getting it wrong is silent and total. The layer is built once
 * at boot, so if construction keyed on the config file alone, an operator's
 * PIN-committed enable would persist, the surface would honestly promise "the
 * layer comes up on the next server restart", and the restart would construct
 * nothing — leaving the state pinned at `enable-pending-restart` with no error
 * anywhere. That is exactly what happened when this was first built, and it was
 * found by driving the flow against a real server rather than by review.
 *
 * AgentServer and the E2E harness both call THIS function, so the two cannot
 * drift apart.
 */
export function moneyLayerShouldConstruct(sources: { configEnabled: boolean; operatorEnabled: boolean }): boolean {
  return resolveIntentEnabled(resolveEnableSources(sources.operatorEnabled, sources.configEnabled));
}

/** A stored failure that must not be forgotten by the act of crashing (§3 recovery rule). */
export interface MoneyFailureRecord {
  state: 'probe-failed' | 'construction-failed';
  failingComponent: string;
  at: string;
}

export interface LifecycleDerivationInput {
  intentEnabled: boolean;
  /** Were the money-layer components actually constructed in THIS process? */
  componentsConstructed: boolean;
  /**
   * The probe outcome for a CONSTRUCTED layer: `null` when no probe has run yet
   * in this process, otherwise pass/fail with the component that failed.
   */
  probe: { passed: boolean; failingComponent?: string } | null;
  /** The persisted failure record, if any, with no successful enable since. */
  storedFailure: MoneyFailureRecord | null;
}

export interface LifecycleDerivation {
  lifecycleState: MoneyLifecycleState;
  failingComponent?: string;
}

/**
 * §3 recovery rule, stated as one function so boot and every read agree:
 *
 *   intent false                              ⇒ disabled
 *   intent + constructed                      ⇒ probe ⇒ probed | probe-failed
 *   intent + absent                           ⇒ enable-pending-restart
 *     …UNLESS a failure record is stored with no successful enable since, in
 *     which case the state is that stored failure carrying its component.
 *
 * `lifecycleState` is NEVER persisted — a stored in-progress state would be a
 * lie after that process died. Only the FAILURE record is persisted.
 */
export function deriveLifecycleState(input: LifecycleDerivationInput): LifecycleDerivation {
  if (!input.intentEnabled) return { lifecycleState: 'disabled' };

  if (input.componentsConstructed) {
    if (input.probe === null) {
      // Constructed but not yet probed in this process. An unmeasured probe is
      // NOT a pass (P20: unmeasurable ⇒ unknown ⇒ not ready).
      return { lifecycleState: 'probe-failed', failingComponent: 'probe-not-yet-run' };
    }
    if (input.probe.passed) return { lifecycleState: 'probed' };
    return { lifecycleState: 'probe-failed', failingComponent: input.probe.failingComponent ?? 'unknown' };
  }

  // Components absent. A failure must not be forgotten by the act of crashing.
  if (input.storedFailure) {
    return { lifecycleState: input.storedFailure.state, failingComponent: input.storedFailure.failingComponent };
  }
  return { lifecycleState: 'enable-pending-restart' };
}

/**
 * MLE-2 — `servingReady` is the ONE predicate the paid path consults, and
 * `enforcementReady` is the API field for it, identical by definition. A surface
 * that could report enforcement-ready while the spend path disagreed would be
 * the symbol-not-state failure this spec exists to avoid.
 */
export function resolveServingReady(args: {
  intentEnabled: boolean;
  lifecycleState: MoneyLifecycleState;
  singleInstanceLockHeld: boolean;
}): boolean {
  return args.intentEnabled && args.lifecycleState === 'probed' && args.singleInstanceLockHeld;
}

/** The three states a restart can plausibly clear (§4). Refused in `disabled` and `probed`. */
export const RESTARTABLE_STATES: ReadonlySet<MoneyLifecycleState> = new Set<MoneyLifecycleState>([
  'enable-pending-restart',
  'probe-failed',
  'construction-failed',
]);

export function isRestartEligible(state: MoneyLifecycleState): boolean {
  return RESTARTABLE_STATES.has(state);
}

/**
 * The renderer's action choice for a disable (§5): when the config key is set,
 * plain `money-layer-disable` is REFUSED and the acknowledged variant is
 * rendered in its place, because a button labelled "disable" that leaves money
 * flowing is an operator hazard however well documented.
 */
export function disableActionFor(sources: EnableSources): 'money-layer-disable' | 'money-layer-disable-store-only' {
  return sources.config ? 'money-layer-disable-store-only' : 'money-layer-disable';
}
