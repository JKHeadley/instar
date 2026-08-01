/**
 * StandardEnforcementExtractor — pull the structural enforcement references a
 * constitutional standard NAMES in its prose (cartographer-conformance-audit spec #3,
 * Part A).
 *
 * The constitution declares its own enforcement: nearly every article carries an
 * `**In practice.**` / `**Applied through.**` line naming the mechanism that enforces
 * it — a test ratchet (`tests/unit/no-silent-llm-fallback.test.ts`), a gate marker
 * (`B16_UNVERIFIED_WALL` in `MessagingToneGate`), a route (`POST /spec/conformance-check`),
 * a lint (`scripts/lint-*.js`), or a spec (`docs/specs/*.md`). This module extracts
 * those references so the auditor can VERIFY each one actually resolves on disk.
 *
 * PURE — no I/O. It only recognizes enforcement-shaped tokens; verification (does the
 * file/route/symbol actually exist?) is the auditor's job. Extraction is conservative:
 * a reference is only pulled if it matches a known enforcement shape. Unmatched prose
 * contributes nothing (→ the standard reads as having no NAMED guard, itself a signal).
 *
 * Provenance refs (`#NNN` PR/issue numbers) are deliberately NOT treated as enforcement
 * — they record where a guard was built, not a live guard.
 */

import type { StandardArticle } from './StandardsRegistryParser.js';

/** A single enforcement reference extracted from a standard's prose. */
export interface EnforcementRef {
  /** The reference token (a repo-relative path, a `METHOD /route`, or a symbol/marker). */
  ref: string;
  /** Which recognizer matched it. */
  kind: 'file' | 'route' | 'marker';
}

export interface ExtractedRefs {
  files: string[];
  routes: string[];
  markers: string[];
}

// ── Recognizers (the prototype regexes, broadened) ──────────────────────────

/**
 * Backtick-fenced file paths with a known source/test/script/spec/config extension.
 * Matches `scripts/lint-foo.js`, `tests/unit/x.test.ts`, `docs/specs/y.md`,
 * `src/core/Z.ts`, `.instar/config.json`, a `.sh` hook. The leading char class
 * tolerates a leading `.` (e.g. `.github/...`).
 */
// NOTE the `..` exclusion. The char class previously permitted it, so a ref like
// `../../../../etc/hosts.json` was joined onto projectDir and existence-probed, with the
// boolean echoed back in `danglingRefs` — an existence oracle outside the project,
// sourced from registry prose. Narrow (authorship is whoever ships a release) but free
// to close, and it contradicted the resolver module's own "the ONLY place a path is
// constructed" contract.
const FILE_RE = /`([a-zA-Z0-9_./-]+\.(?:ts|js|mjs|cjs|md|json|sh))`/g;
/** Reject any ref that could escape the project root before it is ever joined. */
export function isContainedRef(ref: string): boolean {
  // HARDENING OF AN EXPORTED PREDICATE — not the closing of a live hole. Stated that way
  // because an earlier version of this comment claimed the backslash forms were getting
  // "through", and measurement says they are not reachable from the only current caller:
  // `FILE_RE`'s character class is `[a-zA-Z0-9_./-]`, which cannot match `\`, and every
  // `ENFORCEMENT_PATH_PREFIXES` entry is relative, so a leading `/` already failed the
  // prefix test. Over the real 81-article constitution — 111 file-shaped candidates — the
  // branches below change ZERO verdicts. The load-bearing, reachable protection is the
  // `/`-segment split on the last line.
  //
  // They are kept because this function is EXPORTED and is the containment predicate for
  // any future caller that does not inherit `FILE_RE`'s narrowing — and because a
  // containment check that is correct only on the platform it happens to run on is the kind
  // of guard that fails the day the assumption moves. Codey's audit contributed the
  // backslash/mixed forms and then UNC, which reaches a remote root with no drive letter
  // and no `..`. Each branch is directly tested against `isContainedRef`.
  if (ref.startsWith('/')) return false;              // /etc/passwd
  if (/^[A-Za-z]:[\\/]/.test(ref)) return false;      // C:\Windows, C:/Windows
  if (/^[\\/]{2}/.test(ref)) return false;            // \\server\share, //server/share
  return !ref.split(/[\\/]/).includes('..');
}

/** Backtick-fenced `METHOD /route` tokens (the route table shape). */
const ROUTE_RE = /`(GET|POST|PUT|DELETE|PATCH)\s+(\/[a-zA-Z0-9/_:-]+)`/g;

/**
 * CONSTANT_CASE gate markers (e.g. `B16_UNVERIFIED_WALL`, `B17_FALSE_BLOCKER`).
 * Requires at least one underscore so it doesn't sweep up ALL-CAPS prose words
 * (`RLHF`, `CI`, `LLM`), while still catching the real gate-marker shape. Matched
 * with OR without surrounding backticks (the registry uses both).
 */
const MARKER_RE = /\b([A-Z][A-Z0-9]{2,}_[A-Z0-9_]{2,})\b/g;

/**
 * Named class / symbol guards the registry cites in backticks but WITHOUT a file
 * extension or method — `MessagingToneGate`, `IntelligenceRouter.failureSwap`,
 * `FencedLease`, `UserManager`. PascalCase (optionally `.member`), ≥2 segments of
 * casing so it isn't a bare lowercase word. Treated as a `marker` (a symbol the
 * auditor greps src/** for).
 */
const SYMBOL_RE = /`([A-Z][a-zA-Z0-9]+(?:\.[a-zA-Z][a-zA-Z0-9]*)?)`/g;

/** Prefixes that count as a real on-disk enforcement artifact (vs. arbitrary prose). */
const ENFORCEMENT_PATH_PREFIXES = ['tests/', 'scripts/', 'src/', 'docs/', '.github/', '.instar/', '.husky/'];

/** True if a path looks like an enforcement artifact (a guard we can verify on disk). */
function isEnforcementPath(p: string): boolean {
  // Containment FIRST. A prefix match alone is satisfied by `tests/../../../etc/x.json`,
  // so the prefix check on its own never bounded anything.
  if (!isContainedRef(p)) return false;
  return ENFORCEMENT_PATH_PREFIXES.some((pre) => p.startsWith(pre));
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * Extract enforcement references from a single article. Scans both `inPractice` and
 * `appliedThrough` / allowlisted `enforcementSections` (the prose blocks that name enforcement). Pure + deterministic:
 * same article in → same refs out, in stable (sorted) order.
 */
export function extractEnforcementRefs(article: StandardArticle): ExtractedRefs {
  const text = [
    article.inPractice ?? '',
    article.appliedThrough ?? '',
    ...(article.enforcementSections ?? []).map((section) => section.text),
  ].join('\n');

  const files: string[] = [];
  for (const m of text.matchAll(FILE_RE)) {
    const p = m[1];
    if (isEnforcementPath(p)) files.push(p);
  }

  const routes: string[] = [];
  for (const m of text.matchAll(ROUTE_RE)) {
    routes.push(`${m[1].toUpperCase()} ${m[2]}`);
  }

  const markers: string[] = [];
  for (const m of text.matchAll(MARKER_RE)) markers.push(m[1]);
  for (const m of text.matchAll(SYMBOL_RE)) {
    // A `.member` symbol (IntelligenceRouter.failureSwap) → grep the base class name.
    const base = m[1].split('.')[0];
    markers.push(base);
  }

  return {
    files: dedupe(files).sort(),
    routes: dedupe(routes).sort(),
    markers: dedupe(markers).sort(),
  };
}

/** Flatten an ExtractedRefs into a typed list (auditor convenience). */
export function flattenRefs(refs: ExtractedRefs): EnforcementRef[] {
  return [
    ...refs.files.map((ref): EnforcementRef => ({ ref, kind: 'file' })),
    ...refs.routes.map((ref): EnforcementRef => ({ ref, kind: 'route' })),
    ...refs.markers.map((ref): EnforcementRef => ({ ref, kind: 'marker' })),
  ];
}

/** True if the article names ANY enforcement reference at all. */
export function hasAnyRef(refs: ExtractedRefs): boolean {
  return refs.files.length > 0 || refs.routes.length > 0 || refs.markers.length > 0;
}
