/**
 * windowAwarePlacement — quota pacing step 2 (docs/specs/quota-pacing-account-choice.md §§3-5).
 *
 * The one spawn-placement decision both spawn resolvers share while
 * `subscriptionPool.pacing.windowAwareChoice` is on: rank with the window-aware
 * tiered score, compute the old rule alongside (inside a try whose failure is
 * counted and can never change the result), and hand one shadow row per executed
 * placement to the shadow log.
 */

import type { SubscriptionAccount, SubscriptionFramework } from './SubscriptionPool.js';
import { rankAccounts, explainChoice, windowNow, isValidState } from './windowAwareChoice.js';
import type { ModelSource, PlacementShadowInput, ShadowAccountRow } from '../monitoring/AccountChoiceShadowLog.js';
import { resolveDevAgentGate } from './devAgentGate.js';

/** What a spawn call site knows about the session it is placing. */
export interface SpawnPlacementContext {
  model?: string | null;
  modelSource?: ModelSource;
  sessionName?: string | null;
  /** false = a non-spawn use of the resolver (the reviewer login): no shadow row. */
  shadow?: false;
}

/** The window-aware inputs a resolver reads live per decision. */
export interface WindowAwareDeps {
  enabled: () => boolean;
  requestRead?: (accountId: string) => void;
  failedReads?: (accountId: string) => number;
  breakerOpen?: (accountId: string) => boolean;
  pollIntervalMs?: () => number;
  record?: (row: PlacementShadowInput) => void;
}

/** `subscriptionPool.pacing.windowAwareChoice`, through the dev-agent gate (dev on, fleet off). */
export function isWindowAwareChoiceEnabled(config: unknown): boolean {
  const c = config as { developmentAgent?: boolean; subscriptionPool?: { pacing?: { windowAwareChoice?: unknown } } } | undefined;
  const explicit = c?.subscriptionPool?.pacing?.windowAwareChoice;
  return resolveDevAgentGate(typeof explicit === 'boolean' ? explicit : undefined, c);
}

/** Read a window-aware switch without ever throwing (unreadable = off). */
export function windowAwareOn(deps: WindowAwareDeps | undefined): boolean {
  if (!deps) return false;
  try { return deps.enabled() === true; } catch { return false; } // @silent-fallback-ok: an unreadable switch is off
}

function accountRows(accounts: SubscriptionAccount[], nowMs: number): ShadowAccountRow[] {
  return accounts.map((a) => {
    const r = (k: 'fiveHour' | 'sevenDay' | 'fable') => windowNow(a.lastQuota, k, nowMs, { provider: a.provider });
    const five = r('fiveHour');
    const week = r('sevenDay');
    const fable = r('fable');
    const pct = (x: ReturnType<typeof r>) => (isValidState(x.state) ? x.pct : null);
    return {
      id: a.id,
      fiveHour: pct(five),
      sevenDay: pct(week),
      fable: pct(fable),
      states: { fiveHour: five.state, sevenDay: week.state, fable: fable.state },
    };
  });
}

/**
 * Decide one spawn placement with the window-aware rule. `oldPick` computes
 * today's choice for the shadow row only; it never affects the result.
 */
export function decideWindowAwarePlacement(args: {
  accounts: SubscriptionAccount[];
  framework: SubscriptionFramework;
  softThresholdPct: number;
  nowMs: number;
  ctx?: SpawnPlacementContext;
  deps: WindowAwareDeps;
  caller: string;
  excludeId?: string | null;
  filter?: (a: SubscriptionAccount) => boolean;
  oldPick: () => SubscriptionAccount | null;
}): SubscriptionAccount | null {
  const { deps, ctx } = args;
  const result = rankAccounts(args.accounts, {
    nowMs: args.nowMs,
    softThresholdPct: args.softThresholdPct,
    framework: args.framework,
    model: ctx?.model ?? null,
    excludeId: args.excludeId ?? null,
    filter: args.filter,
    failedReads: deps.failedReads,
    pollIntervalMs: deps.pollIntervalMs?.(),
    onNeedsRead: deps.requestRead,
  });
  const pick = result.ranked[0]?.account ?? null;
  if (deps.record && ctx?.shadow !== false) {
    let oldId: string | null = null;
    try {
      oldId = args.oldPick()?.id ?? null;
    } catch {
      oldId = null; // @silent-fallback-ok: the old rule is shadow-only; its failure never changes the pick
    }
    try {
      const relevant = args.accounts.filter((a) => a.framework === args.framework);
      deps.record({
        sessionName: ctx?.sessionName ?? null,
        caller: args.caller,
        framework: args.framework,
        model: ctx?.model ?? null,
        modelSource: ctx?.modelSource ?? (ctx?.model ? 'explicit' : 'unknown'),
        executed: pick?.id ?? null,
        oldPick: oldId,
        newPick: pick?.id ?? null,
        reasons: explainChoice(result, oldId),
        accounts: accountRows(relevant, args.nowMs),
        rereadBreakerOpen: deps.breakerOpen ? relevant.filter((a) => deps.breakerOpen!(a.id)).map((a) => a.id) : undefined,
      });
    } catch {
      // @silent-fallback-ok: a shadow-row failure never changes a placement
    }
  }
  return pick;
}
