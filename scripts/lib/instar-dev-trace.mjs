/**
 * instar-dev-trace — the ONE implementation of "does this instar-dev trace
 * cover these files, and does its artifact match?" (written by
 * skills/instar-dev/scripts/write-trace.mjs).
 *
 * Two readers share it:
 *  - scripts/instar-dev-precommit.js — coverage, completeness and the artifact
 *    sha check on the staged commit;
 *  - the local verifier (src/localVerify/orchestrator.ts) — the independent
 *    second-pass review a flagged record needs (spec
 *    docs/specs/local-verify-merge-authority.md, "Harness-changing PRs"). The
 *    verifier reads the trace and its artifact from the PR head's tree, so a
 *    trace committed after the verified head can never count for it.
 *
 * Pure: no I/O.
 */

import crypto from 'node:crypto';

/** Where trace files live in the repository. */
export const TRACE_PATH_RE = /^\.instar\/instar-dev-traces\/[^/]+\.json$/;

/** The shortest artifact the precommit accepts (characters, trimmed). */
export const MIN_ARTIFACT_CHARS = 200;

export function isTracePath(p) {
  return typeof p === 'string' && TRACE_PATH_RE.test(p);
}

export function traceIsComplete(trace) {
  return !!trace && typeof trace === 'object' && trace.phase === 'complete';
}

/** The files in `files` that the trace's coveredFiles does not list. */
export function traceMissingCoverage(trace, files) {
  const covered = new Set(Array.isArray(trace?.coveredFiles) ? trace.coveredFiles.map(String) : []);
  return (files ?? []).filter((f) => !covered.has(f));
}

export function artifactSha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/**
 * The second pass ran and the reviewer concurred. write-trace.mjs stores
 * `--second-pass true` as the string "true"; the skill documents a boolean.
 */
export function secondPassConcurred(trace) {
  return (trace?.secondPass === true || trace?.secondPass === 'true') && trace?.reviewerConcurred === true;
}

/**
 * The problem that keeps a trace from counting as an independent review of
 * `flaggedPaths`, or null when it counts.
 *
 * @param {object} a
 * @param {unknown} a.trace         the parsed trace (null = unparseable)
 * @param {string[]|null} a.flaggedPaths  the paths that flagged the record; null = unknown
 * @param {string|null} a.artifactText    the trace's artifactPath read from the same tree; null = absent
 *
 * The trace's own secondPass/reviewerConcurred and the artifact's Reviewer line are
 * self-attested by the authoring agent (the pre-commit hook does not check them);
 * the binding of the review to the head is the caller's (no flagged path may change
 * after the trace's last commit).
 */
export function independentReviewProblem({ trace, flaggedPaths, artifactText }) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return 'trace-unparseable';
  if (!traceIsComplete(trace)) return `trace-phase-${String(trace.phase ?? 'missing')}`;
  if (!secondPassConcurred(trace)) return 'no-concurring-second-pass';
  if (!Array.isArray(flaggedPaths) || flaggedPaths.length === 0) return 'flagged-paths-unknown';
  const missing = traceMissingCoverage(trace, flaggedPaths);
  if (missing.length) return `not-covered:${missing.slice(0, 5).join(',')}`;
  if (typeof trace.artifactPath !== 'string' || !trace.artifactPath) return 'artifact-unnamed';
  if (artifactText == null) return 'artifact-not-in-tree';
  if (String(artifactText).trim().length < MIN_ARTIFACT_CHARS) return 'artifact-stub';
  if (typeof trace.artifactSha256 !== 'string' || !trace.artifactSha256) return 'artifact-sha-missing';
  if (trace.artifactSha256 !== artifactSha256(artifactText)) return 'artifact-sha-mismatch';
  if (!secondPassReviewerNamed(artifactText)) return 'second-pass-reviewer-missing';
  return null;
}

/**
 * The artifact's `## Second-pass review` section names its reviewer: a
 * `**Reviewer:**` line that is not empty, not a template placeholder
 * (`[agent name]`), and does not say "pending".
 */
export function secondPassReviewerNamed(artifactText) {
  const text = String(artifactText ?? '');
  const m = /^##\s+Second-pass review\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(text);
  if (!m) return false;
  const line = /^\*\*Reviewer:\*\*[ \t]*(.*)$/m.exec(m[1]);
  if (!line) return false;
  const who = line[1].replace(/[`*_]/g, '').trim();
  if (!who || /^\[.*\]$/.test(who)) return false;
  return !/pending/i.test(who);
}
