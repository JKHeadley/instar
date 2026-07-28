/**
 * convergence-recognition.mjs — the PRECOMMIT gate's pure recognizer for a
 * spec's convergence / approval / report-backing state.
 *
 * Spec: docs/specs/CONVERGING-AUDIT-DEFAULT.md (Part C — gate consistency).
 *
 * WHY a separate pure module: the precommit (scripts/instar-dev-precommit.js)
 * runs PRE-COMPILE and CANNOT import the TS StageTransitionValidator across the
 * compile boundary, so the two gates cannot share a single source of truth in
 * code. Instead, the precommit's recognition logic is factored HERE, into a
 * tiny dependency-free function, and a unit test
 * (tests/unit/convergence-gate-consistency.test.ts) feeds the SAME fixture
 * table to both this recognizer and the validator's `isConvergenceTagPresent`
 * + report logic, asserting they agree. A drift between the two gates fails CI.
 *
 * This module does NO I/O: callers pass the frontmatter text and the
 * report-existence boolean. It is the precommit-side mirror of the validator's
 * pure predicate — same convergence-tag rule (non-empty string OR boolean
 * true), same report-backing rule (report must exist when required).
 */

/**
 * Recognize the convergence tag in a `review-convergence` frontmatter VALUE.
 *
 * Mirror of StageTransitionValidator.isConvergenceTagPresent: a non-empty
 * string (the ISO timestamp the converging-audit tooling writes) OR boolean
 * `true` (the legacy/hand-added form) counts as present. Empty string, false,
 * null/undefined, and any other type do NOT.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isConvergenceTagPresent(value) {
  if (value === true) return true;
  if (typeof value === 'string' && value.trim().length > 0) return true;
  return false;
}

/**
 * Parse the raw `review-convergence` value out of a YAML frontmatter BLOCK
 * (the text between the `---` fences, NOT including the fences). Mirrors the
 * precommit's existing lenient regex exactly so recognition stays identical.
 *
 * Returns the matched string value (quotes stripped, trimmed) when the line is
 * present, or `undefined` when the key is absent. Note: this returns a STRING
 * for both `review-convergence: true` and `review-convergence: "<ts>"` — the
 * precommit's regex captures the literal token; `isConvergenceTagPresent`
 * treats any non-empty captured token as present, which matches the validator's
 * acceptance of both the boolean-true and timestamp-string forms.
 *
 * @param {string} frontmatterText
 * @returns {string | undefined}
 */
export function parseConvergenceValue(frontmatterText) {
  const m = String(frontmatterText).match(
    /^\s*review-convergence\s*:\s*["']?([^"'\n]+)/m,
  );
  if (!m) return undefined;
  return m[1].trim();
}

/**
 * Parse whether the spec carries an `approved: true` tag (precommit's regex).
 *
 * @param {string} frontmatterText
 * @returns {boolean}
 */
export function isApprovedTagPresent(frontmatterText) {
  return /^\s*approved\s*:\s*(true|"true"|'true')/m.test(String(frontmatterText));
}

/**
 * The precommit's verdict for "is this spec converged + approved (+ report-backed
 * when required)?" — the same question the formal validator answers, expressed
 * over frontmatter text + a report-existence boolean.
 *
 * @param {string} frontmatterText — the YAML frontmatter block (between the `---` fences).
 * @param {{ requireReport?: boolean, reportExists?: boolean }} [opts]
 *   requireReport — true when INSTAR_DEV_REQUIRE_CONVERGENCE_REPORT=1.
 *   reportExists  — whether docs/specs/reports/<slug>-convergence.md exists.
 * @returns {{ converged: boolean, approved: boolean, reportBacked: boolean,
 *             accepted: boolean, reason: string }}
 *   - converged:    the convergence tag is present.
 *   - approved:     the approved tag is present.
 *   - reportBacked: the report requirement is satisfied (vacuously true when
 *                   requireReport is false).
 *   - accepted:     converged AND approved AND reportBacked — the precommit's
 *                   Step-6 verdict for a tier-2/3 spec.
 *   - reason:       a short machine-stable reason for the verdict.
 */
export function recognizeConvergence(frontmatterText, opts = {}) {
  const requireReport = opts.requireReport === true;
  const reportExists = opts.reportExists === true;

  const convergenceValue = parseConvergenceValue(frontmatterText);
  const converged = isConvergenceTagPresent(convergenceValue);
  const approved = isApprovedTagPresent(frontmatterText);
  const reportBacked = !requireReport || reportExists;

  let reason;
  if (!converged) reason = 'convergence-tag-missing';
  else if (!approved) reason = 'approved-tag-missing';
  else if (!reportBacked) reason = 'convergence-report-missing';
  else reason = 'accepted';

  const accepted = converged && approved && reportBacked;
  return { converged, approved, reportBacked, accepted, reason };
}

/**
 * Convenience: the precommit-side answer to "is this spec CONVERGED?" in the
 * exact sense the consistency test compares against the validator's converged
 * verdict (convergence tag present AND report-backed when required). Approval
 * is a separate downstream gate in BOTH paths, so it is NOT folded in here.
 *
 * @param {string} frontmatterText
 * @param {{ requireReport?: boolean, reportExists?: boolean }} [opts]
 * @returns {boolean}
 */
export function isSpecConverged(frontmatterText, opts = {}) {
  const requireReport = opts.requireReport === true;
  const reportExists = opts.reportExists === true;
  const converged = isConvergenceTagPresent(parseConvergenceValue(frontmatterText));
  const reportBacked = !requireReport || reportExists;
  return converged && reportBacked;
}
