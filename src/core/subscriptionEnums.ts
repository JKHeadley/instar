/**
 * subscriptionEnums — the ONE definition of the subscription registry's closed
 * value sets (providers / frameworks / statuses / quota sources).
 *
 * Round-11 (grok-build spec, lessons finding): these lists previously existed
 * TWICE — module-local in `SubscriptionPool.ts` and hand-copied into
 * `SubscriptionAccountMetaReplicatedStore.ts` under a comment reading "KEEP IN
 * SYNC — a drift is caught by the schema-parity unit test below." The drift was
 * live (the replica set was missing `xai` and `grok-build`) and no such test
 * existed, so the receive-side validator SILENTLY dropped every record whose
 * framework the local pool would have accepted — a declared cross-machine
 * carrier that structurally could not carry the value.
 *
 * A shared constant removes the drift instead of testing for it: "KEEP IN SYNC"
 * is a wish, one import is a guarantee. This module deliberately holds VALUES
 * only (no imports of its own) so either side can consume it without a cycle.
 */

/** Provider behind a subscription (the account's billing identity). */
export const SUBSCRIPTION_PROVIDERS = [
  'anthropic',
  'openai',
  'github-copilot',
  'google',
  'xai',
] as const;

/** Framework client that drives the account. */
export const SUBSCRIPTION_FRAMEWORKS = [
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'pi-cli',
  'grok-build',
] as const;

/** Account lifecycle status. */
export const SUBSCRIPTION_STATUSES = [
  'active',
  'warming',
  'rate-limited',
  'needs-reauth',
  'disabled',
] as const;

/** Which read path produced a quota snapshot. */
export const SUBSCRIPTION_QUOTA_SOURCES = [
  'claude-code-usage-screen',
  'oauth-usage-endpoint-fallback',
  'codex-rollout',
] as const;

export type SubscriptionProviderValue = (typeof SUBSCRIPTION_PROVIDERS)[number];
export type SubscriptionFrameworkValue = (typeof SUBSCRIPTION_FRAMEWORKS)[number];
export type SubscriptionStatusValue = (typeof SUBSCRIPTION_STATUSES)[number];
export type SubscriptionQuotaSourceValue = (typeof SUBSCRIPTION_QUOTA_SOURCES)[number];
