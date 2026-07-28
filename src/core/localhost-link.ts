/**
 * localhost-link — deterministic detector for machine-local URLs in
 * user-facing messages.
 *
 * Operator-mandated STRONG RULE (Justin, 2026-06-05): never send a
 * localhost / loopback link to a user. The user is almost never on the
 * machine the agent's server runs on — a `http://localhost:4042/...`
 * link is brittle and confusing. User-facing links must be the public
 * tunnel URL (`GET /tunnel`), or the message should honestly say the
 * link will follow.
 *
 * This is deliberately a HARD deterministic rule, not a signal for the
 * LLM tone authority: per docs/signal-vs-authority.md, detectors whose
 * verdict requires conversational judgment emit signals — but a
 * loopback link in a user-bound message has no legitimate reading, so
 * it blocks like the 4096-length check does. The narrow escape hatch
 * (`allowLocalhostLink`) exists for the rare case where the operator
 * explicitly asks to see the raw local URL.
 *
 * Scope: only SCHEME-BEARING clickable links (`http://` / `https://`)
 * are matched. Prose mentions like "port 4042" or "localhost config"
 * stay legal — the rule is about links a user might tap, not about
 * discussing local machinery.
 */

// Host boundary lookahead (?![\w.-]) prevents matching loopback-looking
// PREFIXES of public hostnames (e.g. localhost.example.com). All of 127/8
// is loopback, so any 127.x.y.z matches.
const LOCALHOST_LINK_RE =
  /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])(?![\w.-])(?::\d+)?(?:\/[^\s)\]>'"]*)?/i;

export interface LocalhostLinkResult {
  detected: boolean;
  /** The first offending link, for the rejection message. */
  match?: string;
}

export function detectLocalhostLink(text: string): LocalhostLinkResult {
  const m = LOCALHOST_LINK_RE.exec(text);
  if (m) {
    return { detected: true, match: m[0] };
  }
  return { detected: false };
}
