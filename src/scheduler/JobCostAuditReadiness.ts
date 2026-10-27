/**
 * New job model calls stay closed until their benchmark, provenance, outcome
 * grading, and bulk review paths are wired. This is code-owned: saved config,
 * developmentAgent status, and a manual route call cannot enable them early.
 *
 * Justin's 2026-10-27 directive (topic 130742) makes this a ship condition.
 * A later reviewed change opens each family separately with its audit evidence.
 */
export const JOB_COST_AUDIT_READY = Object.freeze({
  laterScriptJobs: false,
  resultTriage: false,
  anomalyNarration: false,
  dailySupervision: false,
});

/** The two first-wave jobs only call existing deterministic server endpoints. */
export const AUDIT_READY_SCRIPT_SLUGS: ReadonlySet<string> = new Set([
  'llm-decision-grading',
  'correction-class-review-backstop',
]);
