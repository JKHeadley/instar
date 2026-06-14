/**
 * canonicalFeedback.ts — the ONE place the fleet's canonical feedback endpoint
 * is defined (docs/specs/feedback-factory-migration.md §2.5 Phase 4).
 *
 * MERGING A CHANGE TO `CANONICAL_FEEDBACK_URL` IS THE CUTOVER FLIP: new installs
 * pick it up via `init`, and DEPLOYED agents are repointed by the idempotent
 * `PostUpdateMigrator` migration (Migration Parity — a cutover that only works
 * for new agents is a broken cutover). The flip may only ship inside the
 * announced cutover window (freeze → final AS-IS catch-up import → flip →
 * old receiver becomes a 301/proxy-forward).
 *
 * `LEGACY_FEEDBACK_URLS` exists so the migrator rewrites ONLY known prior
 * canonical values — an operator's custom webhook URL is never touched.
 */

/**
 * The canonical fleet feedback endpoint (the Echo-operated instance's Vercel front).
 *
 * `feedback.dawn-tunnel.dev` is the operated endpoint that went live first: its DNS
 * zone (Cloudflare) is self-serviceable, so the receiver could be stood up + verified
 * end-to-end (signed HMAC POST → Blob inbox, confirmed). `feedback.instar.sh` is the
 * intended long-term canonical name, but its DNS (Namecheap) was not reachable at
 * cutover time; when that becomes serviceable, re-pointing here is a one-line change +
 * an idempotent migration (add the dawn-tunnel.dev URL to LEGACY_FEEDBACK_URLS then).
 */
export const CANONICAL_FEEDBACK_URL = 'https://feedback.dawn-tunnel.dev/api/feedback';

/** Prior canonical defaults the migrator is allowed to rewrite. Order: newest-first. */
export const LEGACY_FEEDBACK_URLS: readonly string[] = [
  'https://dawn.bot-me.ai/api/instar/feedback',
];
