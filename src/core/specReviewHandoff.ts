/**
 * specReviewHandoff.ts — the B27 detector (docs/specs/spec-review-link-at-delivery.md §1).
 *
 * SIGNAL ONLY. It carries over the text tests the retired hook check 8
 * (SPEC_REVIEW_LINK) used, and returns them as separate facts. It combines
 * nothing and decides nothing: whether a message hands the person a spec without a
 * readable link is the tone gate's judgment (B27_SPEC_REVIEW_UNLINKED), made over the
 * whole message. A link's presence never suppresses the rule, because only the model
 * can tell whether a link opens the spec in question.
 *
 * Pure and total: bounded input, no I/O, never throws for any string.
 */

/** One link found in the text, by shape. */
export interface SpecReviewLink {
  /** `doc` = a /docs/<id> path, `view` = a /view/<id> path, `other` = any other URL. */
  shape: 'doc' | 'view' | 'other';
  /** The document or view id, for `doc` and `view`. */
  id?: string;
  /** The URL's host (lower-cased), when the link carried one. */
  host?: string;
}

export interface SpecReviewFacts {
  /** The spec reference found (a docs/specs path, or a pull request URL beside the word spec). */
  reference: string | null;
  /** True when review or approval wording is present. */
  handoffWording: boolean;
  /** Every link found, in order, at most MAX_LINKS. */
  links: SpecReviewLink[];
}

/** Longest text the detector reads; the gate reads the whole message regardless. */
export const SPEC_REVIEW_DETECTOR_MAX_CHARS = 64_000;
const MAX_LINKS = 20;

const SPEC_PATH_RE = /docs\/specs\/[^\s)]+\.md/i;
const PR_URL_RE = /github\.com\/[^\s)]+\/pull\/\d+/i;
const SPEC_WORD_RE = /\bspec(?:s|ification)?\b/i;
// Check 8's wording list. `approv\w*` (not the hook's `approv\b`, which never matched
// "approve") — a hint, so a slightly wider net only adds context.
const HANDOFF_RE = /\b(?:review\w*|approv\w*|sign[- ]?off|take a look|for your|ready for)\b/i;
const URL_RE = /\bhttps?:\/\/[^\s<>()"'`]+/gi;
const DOC_PATH_RE = /\/(docs|view)\/([0-9a-f][0-9a-f-]{7,})/i;
const BARE_PATH_RE = /(?:^|[\s(])\/(docs|view)\/([0-9a-f][0-9a-f-]{7,})/gi;

export function detectSpecReviewHandoff(input: string): SpecReviewFacts {
  const text = typeof input === 'string' ? input.slice(0, SPEC_REVIEW_DETECTOR_MAX_CHARS) : '';
  let reference: string | null = null;
  const path = SPEC_PATH_RE.exec(text);
  if (path) reference = path[0];
  else {
    const pr = PR_URL_RE.exec(text);
    if (pr && SPEC_WORD_RE.test(text)) reference = pr[0];
  }
  const links: SpecReviewLink[] = [];
  for (const m of text.matchAll(URL_RE)) {
    if (links.length >= MAX_LINKS) break;
    const url = m[0].replace(/[.,;:!?]+$/, '');
    let host: string | undefined;
    try { host = new URL(url).host.toLowerCase(); } catch { host = undefined; /* @silent-fallback-ok — an unparseable URL is still a link shape */ }
    const d = DOC_PATH_RE.exec(url);
    if (d) links.push({ shape: d[1].toLowerCase() === 'docs' ? 'doc' : 'view', id: d[2].toLowerCase(), ...(host ? { host } : {}) });
    else links.push({ shape: 'other', ...(host ? { host } : {}) });
  }
  // A bare /docs/<id> or /view/<id> path with no scheme (the hook accepted these too).
  for (const m of text.matchAll(BARE_PATH_RE)) {
    if (links.length >= MAX_LINKS) break;
    const id = m[2].toLowerCase();
    const shape = m[1].toLowerCase() === 'docs' ? 'doc' : 'view';
    if (!links.some((l) => l.shape === shape && l.id === id)) links.push({ shape, id });
  }
  return { reference, handoffWording: HANDOFF_RE.test(text), links };
}

/** The link shapes as one primitive string, for evidence rows (context values must be primitives). */
export function linkShapesString(links: SpecReviewLink[]): string {
  return links.length === 0 ? 'none' : links.map((l) => l.shape).join(',');
}
