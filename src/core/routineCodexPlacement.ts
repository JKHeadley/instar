/** Temporary owner-configured placement for new routine Sol work; no session moves. */
import fs from 'node:fs';
import { CODEX_CLI_FRAMEWORK } from './frameworkFacts.js';
import path from 'node:path';
import { isLocallyExecutable, isDeviceLimitBenched, type SubscriptionAccount } from './SubscriptionPool.js';
import { KNOWN_CODEX_MODEL_IDS } from './ModelTierEscalation.js';
import { FRESH_READING_MS, isValidState, windowNow } from './windowAwareChoice.js';

export interface RoutineCodexPlacementConfig {
  enabled?: boolean;
  /** Ordered local pool IDs; no other account is an implicit fallback. */
  accountIds?: string[];
  /** Required finite expiry. Removing/disabling the block restores ordinary future placement. */
  expiresAt?: string;
}
export interface RoutineCodexPlacementContext { routine?: boolean; model?: string | null }
export type RoutineCodexPlacement =
  | { kind: 'inactive' }
  | { kind: 'refused'; reason: string }
  | { kind: 'selected'; accountId: string; configHome: string; validUntil: number };

export function isRoutineSolModel(model?: string | null): boolean {
  return typeof model === 'string' && (KNOWN_CODEX_MODEL_IDS as readonly string[]).includes(model) && model.endsWith('-sol');
}

export function selectRoutineCodexAccount(
  accounts: SubscriptionAccount[], config: RoutineCodexPlacementConfig | undefined,
  context: RoutineCodexPlacementContext = {},
  options: { nowMs?: number; softThresholdPct?: number; homeReady?: (home: string) => boolean } = {},
): RoutineCodexPlacement {
  if (config?.enabled !== true || context.routine !== true || !isRoutineSolModel(context.model)) return { kind: 'inactive' };
  const now = options.nowMs ?? Date.now();
  const expires = Date.parse(config.expiresAt ?? '');
  const refused = (reason: string): RoutineCodexPlacement => ({ kind: 'refused', reason: `routine-codex-placement: ${reason}` });
  if (!Number.isFinite(expires)) return refused('a finite expiry is required');
  if (now >= expires) return { kind: 'inactive' };
  if (!Array.isArray(config.accountIds) || !config.accountIds.length || config.accountIds.some(id => typeof id !== 'string' || !id.trim())) return refused('ordered account IDs are required');
  const ready = options.homeReady ?? ((home: string) => {
    try { return fs.statSync(home).isDirectory(); }
    catch { return false; } // @silent-fallback-ok: a missing/unreadable home is not executable
  });
  const soft = Math.min(options.softThresholdPct ?? 90, 100);
  if (!Number.isFinite(soft) || soft <= 0) return refused('invalid capacity threshold');
  for (const id of config.accountIds) {
    const matches = accounts.filter(account => account.id === id);
    if (matches.length !== 1) continue;
    const a = matches[0];
    if (a.framework !== CODEX_CLI_FRAMEWORK || a.provider !== 'openai' || a.status !== 'active' || !isLocallyExecutable(a) || isDeviceLimitBenched(a) || a.deviceLimitSuspectedAt) continue;
    if (!path.isAbsolute(a.configHome) || !ready(a.configHome)) continue;
    const measured = Date.parse(a.lastQuota?.measuredAt ?? '');
    if (!Number.isFinite(measured) || measured > now || now - measured >= FRESH_READING_MS || a.lastQuota?.measuredAtSynthesized === true) continue;
    const weekly = windowNow(a.lastQuota, 'sevenDay', now, { provider: a.provider });
    const five = windowNow(a.lastQuota, 'fiveHour', now, { provider: a.provider });
    const room = (r: typeof weekly) => isValidState(r.state) && r.pct !== null && r.pct >= 0 && r.pct < soft;
    if (!room(weekly) || (five.state !== 'not-offered' && !room(five))) continue;
    return { kind: 'selected', accountId: a.id, configHome: a.configHome,
      validUntil: Math.min(expires, measured + FRESH_READING_MS, weekly.resetsAtMs ?? expires, five.resetsAtMs ?? expires) };
  }
  return refused('no preferred account has fresh usable local capacity; no default account was selected');
}

/** Same-host server resolves the current credential slot; never read or copy login secrets. */
export async function routineCodexReviewLease(
  config: { port?: number; subscriptionPool?: { routineCodexPlacement?: RoutineCodexPlacementConfig } } | undefined,
  model: string,
  deps: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): Promise<{ accountOverride: { accountId: string; configHome: string }; launchGuard: () => Promise<boolean> } | null> {
  const policy = config?.subscriptionPool?.routineCodexPlacement;
  if (policy?.enabled !== true || !isRoutineSolModel(model)) return null;
  const now = deps.now ?? Date.now;
  const expiry = Date.parse(policy.expiresAt ?? '');
  if (Number.isFinite(expiry) && now() >= expiry) return null;
  const env = deps.env ?? process.env;
  if (!env.INSTAR_AUTH_TOKEN || !Number.isInteger(config?.port) || (config?.port ?? 0) <= 0 || (config?.port ?? 0) > 65535) {
    if (policy?.enabled === true) throw new Error('routine-codex-placement: local server credentials unavailable');
    return null;
  }
  const read = () => (deps.fetch ?? fetch)(`http://127.0.0.1:${config!.port}/subscription-pool/routine-codex-placement?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${env.INSTAR_AUTH_TOKEN}` }, signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  const response = await read();
  if (!response.ok) throw new Error('routine-codex-placement: preferred local account unavailable');
  const body = await response.json() as { mode?: string; accountOverride?: { accountId?: string; configHome?: string }; validUntil?: number };
  // A stale caller config must not turn a missing/disabled server route into an ambient call.
  if (body.mode !== 'selected' || !body.accountOverride || typeof body.accountOverride.accountId !== 'string' || !body.accountOverride.accountId.trim() || (policy?.enabled === true && !policy.accountIds?.includes(body.accountOverride.accountId ?? '')) || !path.isAbsolute(body.accountOverride.configHome ?? '') || !Number.isFinite(body.validUntil) || (body.validUntil ?? 0) <= now()) throw new Error('routine-codex-placement: no current account lease');
  const accountOverride = { accountId: body.accountOverride.accountId!, configHome: body.accountOverride.configHome! };
  const validUntil = Math.min(expiry, body.validUntil!);
  if (!Number.isFinite(validUntil) || validUntil <= now()) throw new Error('routine-codex-placement: invalid lease expiry');
  return { accountOverride, launchGuard: async () => {
    if (now() >= validUntil) return false;
    try {
      const response = await read();
      if (!response.ok) return false;
      const current = await response.json() as typeof body;
      return now() < validUntil && current.mode === 'selected'
        && current.accountOverride?.accountId === accountOverride.accountId
        && current.accountOverride?.configHome === accountOverride.configHome
        && typeof current.validUntil === 'number' && now() < current.validUntil;
    } catch { return false; } // @silent-fallback-ok: an unavailable live recheck refuses the child
  } };
}
