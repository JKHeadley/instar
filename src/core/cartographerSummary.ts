/**
 * cartographerSummary — pure, deterministic helpers for the doc-freshness sweep
 * (spec #2). NO LLM here: this is the AUTHORITY layer the spec puts under the
 * background author. A weak model grading its own output over untrusted input is
 * one injection payload away from passing garbage; a deterministic symbol-presence
 * check is not. Everything here is synchronous, side-effect-free, and unit-tested.
 *
 * Provides:
 *  - secret-path deny-globs + a content tripwire (reuses redactForLiveTail) so a
 *    credential-bearing file is never read-and-sent to a third-party framework;
 *  - distinctive-symbol extraction + the deterministic validity check;
 *  - instruction-shaped-content neutralization (summaries are an injection vector
 *    INTO spec #5's navigator — neutralized on OUTPUT, not just delimited on input);
 *  - the child-digest hash that powers the dir re-author amplification guard;
 *  - untrusted-data delimiting for prompts.
 */
import crypto from 'node:crypto';
import { redactForLiveTail } from './liveTailRedaction.js';

// ── Secret exclusion ─────────────────────────────────────────────────────────

/**
 * Path globs whose files are NEVER read-and-sent to an author model. Matched
 * against the repo-relative POSIX path AND its basename. Beyond spec #1's
 * skip-set; an egress guarantee, not just churn-avoidance.
 */
export const SECRET_DENY_GLOBS: readonly RegExp[] = [
  /(^|\/)\.env($|\.|[^/]*$)/i,     // .env, .env.local, .env.production …
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa([^/]*)$/i,
  /\.p12$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)secrets[^/]*$/i,          // **/secrets, secrets.json …
  /credential/i,                    // **/*credential*
];

/** True if this repo-relative path is credential-bearing and must never be summarized. */
export function isSecretBearingPath(repoRelPath: string): boolean {
  return SECRET_DENY_GLOBS.some((re) => re.test(repoRelPath));
}

/**
 * Content tripwire — true if the committed content carries credential-shaped
 * material (api keys, secret assignments, opaque tokens). Reuses the live-tail
 * redactor's rule set so there is ONE definition of "looks like a secret".
 */
export function contentHasCredentialMaterial(content: string): boolean {
  return redactForLiveTail(content).redactedCount > 0;
}

// ── Distinctive-symbol extraction + deterministic validity ───────────────────

// Language keywords / ultra-common tokens that are NOT distinctive identifiers.
const NON_DISTINCTIVE = new Set<string>([
  'function', 'class', 'interface', 'type', 'enum', 'const', 'let', 'var',
  'return', 'import', 'export', 'from', 'async', 'await', 'this', 'super',
  'public', 'private', 'protected', 'readonly', 'static', 'extends', 'implements',
  'string', 'number', 'boolean', 'void', 'null', 'undefined', 'true', 'false',
  'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'default',
  'new', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of',
]);

/**
 * Extract DISTINCTIVE identifiers from covered code (or, for a dir, from its
 * concatenated child summaries + child basenames). "Distinctive" = a declared
 * name (after function/class/const/…), OR a token with an internal uppercase or
 * underscore (camelCase / PascalCase / snake_case). Generic English prose that
 * happens to appear in code (e.g. "data", "the") is intentionally NOT enough to
 * satisfy validation — a summary must name something the code actually defines.
 */
export function extractCodeSymbols(coveredText: string): Set<string> {
  const out = new Set<string>();
  // 1. Declared names.
  const declRe = /\b(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (let m = declRe.exec(coveredText); m; m = declRe.exec(coveredText)) {
    if (m[1] && m[1].length >= 3) out.add(m[1]);
  }
  // 2. Distinctive-shaped tokens (internal uppercase or underscore), length >= 4.
  const shapeRe = /\b([A-Za-z_$][\w$]*(?:[A-Z_][\w$]*)+)\b/g;
  for (let m = shapeRe.exec(coveredText); m; m = shapeRe.exec(coveredText)) {
    const tok = m[1];
    if (tok.length >= 4 && !NON_DISTINCTIVE.has(tok)) out.add(tok);
  }
  return out;
}

/** Tokenize a summary into candidate identifier-words for the presence check. */
function summaryTokens(summary: string): string[] {
  return summary.match(/[A-Za-z_$][\w$]*/g) ?? [];
}

/** True if the summary names ≥1 symbol verifiably present in the covered code. */
export function summaryReferencesCoveredSymbol(summary: string, coveredSymbols: Set<string>): boolean {
  if (coveredSymbols.size === 0) return true; // nothing distinctive to reference (e.g. a config/data file)
  for (const tok of summaryTokens(summary)) {
    if (coveredSymbols.has(tok)) return true;
  }
  return false;
}

export interface SummaryValidation {
  ok: boolean;
  reason: string;
}

/**
 * The deterministic quality bar (spec §Tier 2.9 + Tier 1 parity). A summary must
 * be non-empty, within [minChars, maxChars] (a length FLOOR, not just a cap), and
 * reference ≥1 distinctive symbol present in the covered code. No LLM. Same check
 * for the inline write route and the background sweep — the inline path is never a
 * lower-validation backdoor.
 */
export function validateSummaryDeterministic(opts: {
  summary: string;
  minChars: number;
  maxChars: number;
  coveredSymbols: Set<string>;
}): SummaryValidation {
  const s = opts.summary.trim();
  if (s.length === 0) return { ok: false, reason: 'empty summary' };
  if (s.length < opts.minChars) return { ok: false, reason: `summary shorter than ${opts.minChars} chars` };
  if (s.length > opts.maxChars) return { ok: false, reason: `summary longer than ${opts.maxChars} chars` };
  if (!summaryReferencesCoveredSymbol(s, opts.coveredSymbols)) {
    return { ok: false, reason: 'summary names no symbol present in the covered code' };
  }
  return { ok: true, reason: 'ok' };
}

// ── Injection neutralization (output-side) ───────────────────────────────────

const INSTRUCTION_SHAPED: readonly RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|context)\b/gi,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|above)\b/gi,
  /\b(?:system|developer)\s*(?:prompt|message|instruction)s?\s*[:=]/gi,
  /\byou\s+are\s+now\b/gi,
  /\bnew\s+instructions?\s*[:=]/gi,
  /<\/?(?:system|assistant|user|tool)\b[^>]*>/gi, // role-tag spoofing
];

/**
 * Neutralize instruction-shaped content in a model-authored summary BEFORE it is
 * persisted. The persisted summary is later read by spec #5's navigating
 * sub-agent; a summary that smuggled "ignore previous instructions" would be an
 * injection into that agent. We declaw the phrasing (it stays human-readable) and
 * report whether anything was neutralized.
 */
export function neutralizeInstructionShapedContent(summary: string): { text: string; neutralized: boolean } {
  let neutralized = false;
  let text = summary;
  for (const re of INSTRUCTION_SHAPED) {
    text = text.replace(re, (match) => {
      neutralized = true;
      // Insert a zero-width-free marker that breaks the imperative without hiding it.
      return `[neutralized: ${match.replace(/\s+/g, ' ').trim()}]`;
    });
  }
  return { text, neutralized };
}

// ── Dir re-author amplification guard ────────────────────────────────────────

/**
 * A stable hash of the concatenated DIRECT-child summaries. A dir is re-authored
 * (an LLM call) ONLY when this changes; a dir whose tree-oid flipped but whose
 * child digest is unchanged gets a fingerprint-only refresh (no LLM call).
 */
export function childDigestHash(childSummaries: readonly string[]): string {
  const joined = childSummaries.join(' ');
  return crypto.createHash('sha256').update(joined, 'utf8').digest('hex').slice(0, 40);
}

// ── Untrusted-data delimiting (input-side) ───────────────────────────────────

/** Wrap untrusted repo content / child summaries as DATA, never instructions. */
export function delimitUntrusted(label: string, content: string): string {
  const fence = '<<<CARTOGRAPHER-UNTRUSTED-DATA>>>';
  // Strip any attempt to forge our own fence out of the content.
  const safe = content.split(fence).join('');
  return `${fence} ${label}\n${safe}\n${fence}`;
}
