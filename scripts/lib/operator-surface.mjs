/**
 * operator-surface.mjs — pure decision logic for the Operator-Surface Quality
 * review gate in the instar-dev commit gate (docs/STANDARDS-REGISTRY.md →
 * "Operator-Surface Quality", CMT-1434).
 *
 * Two pure predicates, extracted so the gate's load-bearing decisions are
 * unit-testable without git/fs mocking (the classify-tier.mjs pattern):
 *
 *   - isOperatorSurfaceFile(path): is this staged file an operator surface — a
 *     dashboard renderer/markup file, an approval page, or a grant/secret form?
 *   - artifactAddressesOperatorSurfaceQuality(content): does the side-effects
 *     artifact engage the operator-surface-quality question in writing?
 *
 * SIGNAL-FREE: these never block; the gate (instar-dev-precommit.js) reads them
 * and decides. Keeping them pure means both sides of every boundary are pinned
 * by tests (Testing Integrity → semantic-correctness).
 */

/**
 * An operator surface is anything a person uses to authorize, decide, or act:
 *   - dashboard renderer / markup files (dashboard/*.js, dashboard/*.html), AND
 *   - approval pages / one-time-approval links / secret-drop forms (a file whose
 *     basename starts with approval / operator-approval / secret-drop).
 * Build/test/spec siblings (*.test.js, *.spec.js) are NOT surfaces.
 */
export const OPERATOR_SURFACE_RE =
  /^dashboard\/.+\.(?:js|html)$|(?:^|\/)(?:approval|operator-approval|secret-drop)[^/]*\.(?:js|html|ts)$/i;

/**
 * True when a staged file path is an operator surface.
 * @param {string} file repo-relative path
 * @returns {boolean}
 */
export function isOperatorSurfaceFile(file) {
  const f = String(file ?? '');
  if (!f) return false;
  // A test/spec file that happens to live under dashboard/ or match the approval
  // basename is NOT itself an operator surface — it's a guard for one.
  if (/\.(?:test|spec)\.(?:js|ts|mjs)$/.test(f)) return false;
  return OPERATOR_SURFACE_RE.test(f);
}

/**
 * The artifact engages the operator-surface-quality question when it carries the
 * §6b heading/phrase (seeded by side-effects-artifact.md). The gate's job is to
 * ensure the question is structurally PRESENT for every operator-surface change —
 * an agent that deletes/skips the section (or writes a bespoke artifact omitting
 * it) is blocked. (Same strength as the framework-generality gate.)
 * @param {string} content the side-effects artifact text
 * @returns {boolean}
 */
export function artifactAddressesOperatorSurfaceQuality(content) {
  return /operator[- ]surface quality/i.test(String(content ?? ''));
}
