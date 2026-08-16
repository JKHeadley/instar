/**
 * serveCapability — the pure §5.1 per-account serveability derivation for the
 * cross-machine account & quota sharing feature (spec:
 * docs/specs/cross-machine-account-quota-sharing.md §5.1/§5.2).
 *
 * `canServe` answers: "can THIS machine produce a reply for a conversation on a
 * given channel right now?" — derived from BOTH (a) whether the machine has a
 * live, NON-walled account (its llm-circuit closed / not rate-limited) and (b)
 * whether its adapter actually reaches the conversation's channel.
 *
 * THE DESIGN CONTRACT (D8): `canServe` is an ADVISORY SIGNAL, never a blocking
 * authority. It feeds the failover candidate filter; the elected destination
 * REVALIDATES at admission. A stale/wrong advert can never produce a dead reply
 * because admission bounces it → next candidate → else honest degradation.
 *
 * Why this replaces the coarse `quotaState.blocked` reliance (F1): `quotaState`
 * is single-account/default-home granularity. `canServe` is a derived, per-machine
 * boolean PLUS a small capability summary so the inbound path can resolve the
 * per-topic answer by a local cached lookup — never a live read on the hot path.
 *
 * Pure functions only — no I/O — so the two-signal contract is unit-testable and
 * cannot silently regress.
 */

import { machineServesChannel } from './machineServesChannel.js';
import type { ServesChannels, ChannelScope, ServeResult } from './machineServesChannel.js';

/**
 * The requirement a conversation places on a serving machine (external/codex #1).
 * v1 fills `{platform, chatId/workspaceId}` (channel reachability). The shape is
 * deliberately extensible so a future model/tool/org-tier check (D12) extends the
 * SAME contract rather than becoming admission-only retry logic.
 */
export type ServeRequirement = ChannelScope;

/** The block-state input — the SAME shape `MachineCapacity.quotaState` carries. */
export interface ServeQuotaState {
  blocked: boolean;
  blockedUntil?: string;
  reason?: string;
}

/**
 * The compact, heartbeat-carried serve-capability summary (external/codex #2).
 * NOT a single misleading global boolean — it carries the non-walled flag AND the
 * per-platform/workspace reachability so the inbound path resolves the per-topic
 * `canServe` by a local cached lookup against this summary. Precomputed + advert-
 * carried; never recomputed live on the inbound path.
 */
export interface ServeCapabilitySummary {
  /** True when the machine has at least one live, non-walled account RIGHT NOW
   *  (its llm-circuit closed / account not rate-limited). Derived from quotaState. */
  hasNonWalledAccount: boolean;
  /** Which channels the machine's adapters are connected to (adapter-derived).
   *  Reused verbatim from the platform-aware placement advert. */
  servesChannels?: ServesChannels;
}

/**
 * Derive whether a machine has at least one live, non-walled account.
 *
 * v1 assumes all pool accounts are model/provider equivalent (D12 — the operator's
 * own Claude subscriptions), so a single not-blocked self-quota signal == "has a
 * non-walled account". `quotaState.blocked === true` means the machine cannot do
 * LLM work right now (provider block / 5-hour exhausted / llm-circuit-open).
 * ABSENT quotaState (older heartbeats) = unknown = treated as NOT walled (fail-open,
 * the same posture PlacementExecutor's quota gate takes).
 */
export function hasNonWalledAccount(quotaState: ServeQuotaState | undefined): boolean {
  return quotaState?.blocked !== true;
}

/**
 * Build the compact serve-capability summary for the capacity heartbeat (§5.1).
 * Pure: the caller passes this machine's self-quota block + adapter-derived
 * servesChannels (both already computed for today's placement advert).
 */
export function buildServeCapabilitySummary(
  quotaState: ServeQuotaState | undefined,
  servesChannels: ServesChannels | undefined,
): ServeCapabilitySummary {
  return {
    hasNonWalledAccount: hasNonWalledAccount(quotaState),
    ...(servesChannels ? { servesChannels } : {}),
  };
}

/**
 * Resolve whether a machine `canServe` a specific conversation, from its
 * heartbeat-carried summary + the conversation's ServeRequirement.
 *
 * `canServe = hasNonWalledAccount AND the adapter reaches the channel`.
 * Channel reachability is three-valued (machineServesChannel): a `'no'` is a hard
 * structural exclusion; `'unknown'` (older heartbeat / no scope) fails OPEN (treated
 * as reachable) so a rolling deploy never strands a peer. This is a LOCAL,
 * O(1)-per-peer in-memory lookup — never a live network read.
 *
 * @returns `{ canServe, reason }` — `reason` is a typed, NON-free-text category
 *   (the spec's untrusted-string rule: never key on a peer's free-text `reason`).
 */
export function resolveCanServe(
  summary: ServeCapabilitySummary | undefined,
  requirement: ServeRequirement | undefined,
): { canServe: boolean; reason: 'serveable' | 'walled' | 'channel-unreachable' | 'no-summary' } {
  // No summary at all = older peer / advert not yet pulled. The spec's representation
  // note: a machine that has NEVER advertised a summary is unknown, NOT serveable —
  // we cannot assert it can serve. But channel reachability still fails open. We
  // model "no summary" as not-serveable for the FILTER (it is never picked as a
  // candidate), which is the safe direction (admission would bounce it anyway).
  if (!summary) return { canServe: false, reason: 'no-summary' };
  if (!summary.hasNonWalledAccount) return { canServe: false, reason: 'walled' };
  const reach: ServeResult = machineServesChannel(summary.servesChannels, requirement);
  if (reach === 'no') return { canServe: false, reason: 'channel-unreachable' };
  // 'yes' or 'unknown' (fail-open) → serveable (subject to admission revalidation).
  return { canServe: true, reason: 'serveable' };
}
