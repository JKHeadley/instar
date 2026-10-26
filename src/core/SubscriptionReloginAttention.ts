/**
 * attention-lifecycle-close-on-cause §3.3/§3.4 — the sign-in repair producer's
 * authoritative "is this attention row's condition over?" answer, used by the
 * hourly reconciliation pass.
 *
 * A row is recognised by its producer `conditionKey`
 * (`subscription-relogin:<accountId>:<machineId>`) or, for rows raised before
 * condition keys existed, by its legacy id
 * (`subscription-relogin-<episode uuid>-<kind>…`, the delivery key with its
 * colons replaced). Anything else is `unknown` — not this resolver's row.
 *
 * `cleared` only on VERIFIED recovery: the episode reached `succeeded`, the
 * operator cancelled it, it was resolved elsewhere, or the LOCAL pool cell for
 * that account reads healthy. `failed` / `refused` / a live attempt keep the
 * row `active` (the operator still has something to do). No episode on disk
 * and no healthy cell → `unknown` (never "probably fine").
 */

import type { SubscriptionReloginEpisode } from './SubscriptionReloginStore.js';

export interface SubscriptionReloginAttentionDeps {
  getEpisode: (id: string) => SubscriptionReloginEpisode | null;
  /** Newest first. */
  listEpisodes: (accountId: string) => SubscriptionReloginEpisode[];
  /** This machine's pool id; a healthy local cell clears only rows about THIS machine. */
  localMachineId: string | null;
  localCellHealthy: (accountId: string) => boolean;
}

export const SUBSCRIPTION_RELOGIN_CONDITION_PREFIX = 'subscription-relogin:';
const LEGACY_ID = /^subscription-relogin-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i;

export function subscriptionReloginConditionKey(episode: Pick<SubscriptionReloginEpisode, 'accountId' | 'machineId'>): string {
  return `${SUBSCRIPTION_RELOGIN_CONDITION_PREFIX}${episode.accountId}:${episode.machineId}`;
}

function verdictOf(episode: SubscriptionReloginEpisode): 'cleared' | 'active' {
  if (episode.state === 'succeeded' || episode.state === 'cancelled' || episode.failureClass === 'resolved-elsewhere') return 'cleared';
  return 'active';
}

export function resolveSubscriptionReloginAttention(
  item: { id: string; conditionKey?: string },
  deps: SubscriptionReloginAttentionDeps,
): 'cleared' | 'active' | 'unknown' {
  const key = item.conditionKey?.trim();
  if (key && key.startsWith(SUBSCRIPTION_RELOGIN_CONDITION_PREFIX)) {
    const rest = key.slice(SUBSCRIPTION_RELOGIN_CONDITION_PREFIX.length);
    const sep = rest.indexOf(':');
    if (sep <= 0) return 'unknown';
    const accountId = rest.slice(0, sep);
    const machineId = rest.slice(sep + 1);
    if (deps.localMachineId && machineId === deps.localMachineId && deps.localCellHealthy(accountId)) return 'cleared';
    const episode = deps.listEpisodes(accountId).find((e) => e.machineId === machineId);
    return episode ? verdictOf(episode) : 'unknown';
  }
  const legacy = LEGACY_ID.exec(item.id);
  if (legacy) {
    const episode = deps.getEpisode(legacy[1]);
    if (!episode) return 'unknown';
    if (deps.localMachineId && episode.machineId === deps.localMachineId && deps.localCellHealthy(episode.accountId)) return 'cleared';
    return verdictOf(episode);
  }
  return 'unknown';
}
