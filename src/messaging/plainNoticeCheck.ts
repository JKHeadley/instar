/**
 * plainNoticeCheck — deterministic plain-language check for fixed notices the
 * server writes to the user (docs/UX-AND-AGENT-AGENCY-STANDARD.md Rule 8).
 *
 * SIGNAL ONLY, used at TEST time over USER_NOTICE_CATALOG (and its term list
 * at build time by scripts/lint-plain-user-notices.mjs). It never runs on the
 * live send path: these notices travel deterministic delivery paths that must
 * not be held or rewritten at runtime (an alarm has to arrive when the model
 * is down). The check is brittle on purpose — literal tokens — which is fine
 * for a detector feeding a test, and would be wrong for a runtime authority.
 *
 * It covers the TOO-TECHNICAL side mechanically (internal words, code
 * identifiers, raw reason codes, ids, file paths) and the TOO-VAGUE side only
 * as a floor (a notice shorter than MIN_WORDS cannot say what happened, what
 * it means and what to do). Judging "enough information" beyond that floor is
 * for the reviewer; Rule 8's before/after examples are the reference.
 */
import fs from 'node:fs';
import { detectInternalIdLeak } from '../core/internal-id-leak.js';
import { detectRawFilePath } from '../core/raw-file-path.js';

export interface PlainNoticeProblem {
  code: string;
  match: string;
  why: string;
}

/** Below this, a notice cannot carry what happened + what it means + what to do. */
export const MIN_WORDS = 6;

// One term list for this check and the build-time lint (which cannot import
// TypeScript). '../../src/data' resolves from both src/messaging and dist/messaging.
const terms = JSON.parse(
  fs.readFileSync(new URL('../../src/data/plain-notice-terms.json', import.meta.url), 'utf-8'),
) as { internalTerms: string[]; codePatterns: Array<{ code: string; re: string; why: string }>; camelCaseAllow: string[] };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TERM_RES = (terms.internalTerms as string[]).map((t) => ({
  term: t,
  re: new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(t)}(?![A-Za-z0-9_-])`, t === t.toUpperCase() && t.length <= 4 ? '' : 'i'),
}));
const CODE_RES = (terms.codePatterns as Array<{ code: string; re: string; why: string }>).map((p) => ({
  ...p,
  rx: new RegExp(p.re, 'g'),
}));
const CAMEL_ALLOW = new Set((terms.camelCaseAllow as string[]).map((s) => s.toLowerCase()));

/** Strip Telegram HTML tags and emoji so they don't count as words or identifiers. */
function visibleText(text: string): string {
  return text.replace(/<[^>]+>/g, ' ');
}

export function findPlainNoticeProblems(text: string): PlainNoticeProblem[] {
  const out: PlainNoticeProblem[] = [];
  const t = visibleText(text ?? '');
  const words = t.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (words.length < MIN_WORDS) {
    out.push({ code: 'TOO_SHORT', match: t.trim(), why: `under ${MIN_WORDS} words cannot say what happened, what it means and what to do` });
  }
  for (const { term, re } of TERM_RES) {
    if (re.test(t)) out.push({ code: 'INTERNAL_TERM', match: term, why: 'an internal word the person cannot act on' });
  }
  for (const p of CODE_RES) {
    for (const m of t.matchAll(p.rx)) {
      if (p.code === 'CAMEL_CASE' && CAMEL_ALLOW.has(m[0].toLowerCase())) continue;
      out.push({ code: p.code, match: m[0], why: p.why });
    }
  }
  const leak = detectInternalIdLeak(t);
  for (const term of leak.terms) out.push({ code: 'INTERNAL_ID', match: term, why: 'an internal id or component name' });
  const fp = detectRawFilePath(t);
  if (fp.detected) out.push({ code: 'FILE_PATH', match: fp.match ?? '', why: 'a raw file path' });
  return out;
}
