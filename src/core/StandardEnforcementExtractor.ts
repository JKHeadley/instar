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
const FILE_RE = /`([a-zA-Z0-9_./-]+\.(?:ts|js|mjs|cjs|md|json|sh))`/g;

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
  return ENFORCEMENT_PATH_PREFIXES.some((pre) => p.startsWith(pre));
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * Extract enforcement references from a single article. Scans both `inPractice` and
 * `appliedThrough` (the two prose lines that name enforcement). Pure + deterministic:
 * same article in → same refs out, in stable (sorted) order.
 */
export function extractEnforcementRefs(article: StandardArticle): ExtractedRefs {
  const text = `${article.inPractice ?? ''}\n${article.appliedThrough ?? ''}`;

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
