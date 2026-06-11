/**
 * raw-file-path — deterministic detector for literal filesystem paths in
 * user-facing messages.
 *
 * Sibling of `localhost-link.ts`, held to the same linear-regex discipline —
 * but unlike the localhost guard this is a pure SIGNAL, never a block
 * (spec: docs/specs/outbound-jargon-filepath-gap.md §2.3). A literal repo
 * path shown to a user ("/Users/justin/...", ".instar/config.json",
 * "src/core/Foo.ts") is something the user usually can't act on; the
 * existing B2_FILE_PATH judgment belongs to the LLM authority, and on
 * automated sends the preflight advisory informs the SENDER. This detector
 * only surfaces the observation.
 *
 * Hard requirements (r2 convergence):
 * - ReDoS-safe: linear, non-backtracking patterns; bounded segment count
 *   and length; an indexOf prescreen so the regex only runs when a path is
 *   plausibly present.
 * - Never matches inside an `http(s)://` URL — URLs containing paths are
 *   the legitimate form to preserve.
 * - Bounded match echo: the returned match is the regex token (whose char
 *   class already stops at whitespace/quote/`?`/`#`/`)`), truncated to
 *   120 chars, so a secret adjacent to a path can never ride into
 *   logs/advisories/transcripts.
 * - Callers wrap every call fail-OPEN: a throw skips the signal, never
 *   withholds a message and never 500s a route.
 */

/** Truncation cap for the echoed match (privacy bound on adjacent content). */
const MATCH_ECHO_MAX = 120;

/** Defensive input cap — callers already cap analyzed text (64KB at the
 * preflight route); this keeps the detector itself bounded regardless. */
const INPUT_MAX = 64 * 1024;

/**
 * Path-segment char class: stops at whitespace, quotes, `?`, `#`, `)`,
 * backticks and other prose punctuation by construction. Bounded segment
 * length (1–64) and bounded segment count keep the scan linear.
 *
 * Three alternatives, all anchored on a real separator so prose like
 * "and/or" or "TCP/IP" cannot match:
 *  A) absolute or home paths with at least two segments:  /Users/justin/x, ~/.config/foo
 *  B) dot-directory relative paths:                       .instar/config.json, .claude/hooks/x
 *  C) repo-relative paths under well-known dirs:          src/core/Foo.ts, logs/server.log
 */
const SEG = '[A-Za-z0-9._-]{1,64}';
const RAW_FILE_PATH_RE = new RegExp(
  // A: "/seg/seg..." or "~/seg/seg..." (>= 2 segments so "/tmp" alone or a
  //    lone slash in prose stays legal)
  `(?:(?:~)?/${SEG}(?:/${SEG}){1,12}` +
    // B: ".instar/...", ".claude/...", ".github/...", ".husky/..." (single
    //    segment after the dot-dir is enough — ".instar/config.json")
    `|\\.(?:instar|claude|github|husky|vscode|config)/${SEG}(?:/${SEG}){0,12}` +
    // C: repo-relative under well-known top-level dirs; require the word
    //    boundary via a non-path char or string start (handled in code, not
    //    lookbehind, to keep the pattern simple and linear)
    `|(?:src|docs|tests|scripts|logs|state|upgrades|dist|node_modules)/${SEG}(?:/${SEG}){0,12})`,
  'g',
);

export interface RawFilePathResult {
  detected: boolean;
  /** First offending path, bounded to 120 chars — safe to echo in advisories/audits. */
  match?: string;
}

/**
 * True when `index` sits inside a scheme-bearing URL token: the
 * whitespace-delimited token containing the match start carries "://"
 * before the match. Linear scan-back, bounded by the token itself.
 */
function insideUrl(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const prefix = text.slice(start, index);
  // `://` fully before the match, OR the match starts at the second slash of
  // a scheme separator (prefix ends with `:/` — e.g. match begins at
  // "/example.com/…" inside "https://example.com/…").
  return prefix.includes('://') || /:\/$/.test(prefix);
}

/**
 * For alternative C (bare repo-relative prefixes like "src/"), require a
 * word boundary on the left so "missrc/foo" or "RandomLogs/x" can't match.
 * Alternatives A/B self-anchor on '/', '~' or '.'.
 */
function hasWordBoundaryLeft(text: string, index: number): boolean {
  if (index === 0) return true;
  return !/[A-Za-z0-9._\-/]/.test(text[index - 1]);
}

export function detectRawFilePath(text: string): RawFilePathResult {
  if (typeof text !== 'string' || text.length === 0) return { detected: false };
  const input = text.length > INPUT_MAX ? text.slice(0, INPUT_MAX) : text;

  // indexOf prescreen — the regex only runs when a path separator exists.
  if (!input.includes('/')) return { detected: false };

  RAW_FILE_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RAW_FILE_PATH_RE.exec(input)) !== null) {
    const token = m[0];
    const at = m.index;
    // Never flag a path that lives inside an http(s):// URL.
    if (insideUrl(input, at)) continue;
    // Bare repo-relative alternative needs a real word boundary.
    const firstChar = token[0];
    if (firstChar !== '/' && firstChar !== '~' && firstChar !== '.') {
      if (!hasWordBoundaryLeft(input, at)) continue;
    }
    return { detected: true, match: token.slice(0, MATCH_ECHO_MAX) };
  }
  return { detected: false };
}
