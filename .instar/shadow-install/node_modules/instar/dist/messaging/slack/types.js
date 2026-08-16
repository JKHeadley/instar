/**
 * Slack adapter types — configuration, messages, events, and rate limit tiers.
 */
// ── Rate Limit Tiers ──
/** Slack API rate limit tiers (requests per minute). */
export var RateLimitTier;
(function (RateLimitTier) {
    /** ~1 req/min — conversations.create, conversations.archive */
    RateLimitTier[RateLimitTier["Tier1"] = 1] = "Tier1";
    /** ~20 req/min — reactions.add, reactions.remove */
    RateLimitTier[RateLimitTier["Tier2"] = 20] = "Tier2";
    /** ~50 req/min — chat.postMessage, conversations.history */
    RateLimitTier[RateLimitTier["Tier3"] = 50] = "Tier3";
    /** ~100 req/min — users.info, auth.test */
    RateLimitTier[RateLimitTier["Tier4"] = 100] = "Tier4";
})(RateLimitTier || (RateLimitTier = {}));
/**
 * Rate limit tier assignment per Slack API method.
 * Methods not listed default to Tier3.
 */
export const SLACK_API_TIERS = {
    // Tier 1 — very restricted
    'conversations.create': RateLimitTier.Tier1,
    'conversations.archive': RateLimitTier.Tier1,
    'conversations.unarchive': RateLimitTier.Tier1,
    'conversations.rename': RateLimitTier.Tier1,
    'conversations.setTopic': RateLimitTier.Tier1,
    'conversations.setPurpose': RateLimitTier.Tier1,
    // Tier 2 — moderate
    'reactions.add': RateLimitTier.Tier2,
    'reactions.remove': RateLimitTier.Tier2,
    'pins.add': RateLimitTier.Tier2,
    'pins.remove': RateLimitTier.Tier2,
    'chat.update': RateLimitTier.Tier2,
    // Tier 3 — standard (also the default)
    'chat.postMessage': RateLimitTier.Tier3,
    'chat.postEphemeral': RateLimitTier.Tier3,
    'conversations.history': RateLimitTier.Tier3,
    'conversations.list': RateLimitTier.Tier3,
    'conversations.info': RateLimitTier.Tier3,
    'conversations.members': RateLimitTier.Tier3,
    'files.getUploadURLExternal': RateLimitTier.Tier3,
    'files.completeUploadExternal': RateLimitTier.Tier3,
    // Tier 4 — generous
    'auth.test': RateLimitTier.Tier4,
    'users.info': RateLimitTier.Tier4,
    'users.list': RateLimitTier.Tier4,
    'apps.connections.open': RateLimitTier.Tier4,
};
/** Get the rate limit tier for a Slack API method. Defaults to Tier3. */
export function getTier(method) {
    return SLACK_API_TIERS[method] ?? RateLimitTier.Tier3;
}
//# sourceMappingURL=types.js.map