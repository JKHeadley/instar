/**
 * redactUrl — strip credentials from URLs before they reach any log sink.
 *
 * The 2026-05-27 incident: `instar join` formatted a clone URL containing a
 * live GitHub token (`https://x-access-token:gho_…@github.com/…`) into an
 * error message that was printed to stdout. Node's own fetch/URL errors echo
 * the full credentialed URL in `err.message`, so even catching the error and
 * logging `err.message` leaks the secret.
 *
 * This module is the single redaction funnel. Anywhere a URL (or a string that
 * may embed one) is about to be logged, route it through `redactUrl` /
 * `redactUrlsInText` first. The companion lint rule
 * (`scripts/lint-no-direct-url-log.js`) bans logging a raw `user:pass@host`
 * URL outside this module + its tests.
 *
 * Design notes:
 * - Fail-OPEN to the SAFE side: on any parse failure we still attempt a
 *   regex-based scrub rather than returning the raw input, because the whole
 *   point is "never leak a credential." We never throw.
 * - Idempotent: redacting an already-redacted string is a no-op.
 * - Preserves everything except the userinfo segment, so logs stay useful
 *   (host, path, query — minus any token that lived in the query is NOT
 *   handled here; query-embedded secrets are a separate concern, see
 *   `scrubKnownTokenPatterns`).
 */

const REDACTED = '***';

/**
 * Known secret token shapes that can appear OUTSIDE a userinfo segment
 * (e.g. embedded in a path or query). Conservative — only well-known,
 * unambiguous prefixes, to avoid mangling benign strings.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /gh[posru]_[A-Za-z0-9_]{20,}/g,        // GitHub PAT / OAuth / refresh / server / user-to-server
  /github_pat_[A-Za-z0-9_]{20,}/g,        // GitHub fine-grained PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,        // Slack tokens
  /\d{8,10}:[A-Za-z0-9_-]{30,}/g,         // Telegram bot tokens (id:secret) — no \b: the API path form is /bot<id>:<secret>/
  /sk-[A-Za-z0-9]{20,}/g,                 // OpenAI-style keys
];

/**
 * Redact the userinfo (user:password@) segment of a single URL string.
 * Returns the URL with `***:***@` (or `***@`) in place of any credentials.
 * Non-URL input is returned with token-pattern scrubbing applied.
 */
export function redactUrl(input: string | URL): string {
  const raw = typeof input === 'string' ? input : input.toString();

  // Fast path: try structured parse so we redact exactly the userinfo segment.
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      const user = u.username ? REDACTED : '';
      const pass = u.password ? REDACTED : '';
      const userinfo = user && pass ? `${user}:${pass}` : (user || pass);
      // Rebuild without mutating via URL (which would re-encode); string-splice
      // the authority so the rest of the URL is byte-preserved.
      const schemeSep = raw.indexOf('://');
      if (schemeSep !== -1) {
        const afterScheme = schemeSep + 3;
        const atIdx = raw.indexOf('@', afterScheme);
        if (atIdx !== -1) {
          return raw.slice(0, afterScheme) + userinfo + raw.slice(atIdx);
        }
      }
    }
    // No credentials in the structured URL — still scrub stray token patterns
    // (a token could be sitting in the path or query).
    return scrubKnownTokenPatterns(raw);
  } catch {
    // Not parseable as a single URL (could be a sentence containing one, or
    // malformed). Fall back to regex scrubbing — never return raw.
    return scrubKnownTokenPatterns(redactUserinfoByRegex(raw));
  }
}

/**
 * Redact every URL embedded in a larger block of text (e.g. an error message
 * that interpolated a URL). Use this when logging `err.message` or any string
 * that might contain a credentialed URL somewhere inside it.
 */
export function redactUrlsInText(text: string): string {
  if (!text) return text;
  // First scrub `scheme://user:pass@` authorities anywhere in the text.
  const userinfoScrubbed = redactUserinfoByRegex(text);
  // Then scrub bare known-token patterns (covers tokens in query/path/headers).
  return scrubKnownTokenPatterns(userinfoScrubbed);
}

/** Regex pass: replace `scheme://user:pass@` (or `scheme://user@`) with redacted. */
function redactUserinfoByRegex(text: string): string {
  // Matches scheme://USERINFO@host where USERINFO has no '/', '@', or whitespace.
  return text.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s]+)@/g,
    (_m, scheme) => `${scheme}${REDACTED}@`,
  );
}

/** Scrub well-known standalone token shapes wherever they appear. */
function scrubKnownTokenPatterns(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}
