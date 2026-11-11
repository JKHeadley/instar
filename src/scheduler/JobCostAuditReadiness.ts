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

/** No benchmark-backed job session pin may activate until its call and effect
 * audit has been registered, graded and made available for bulk review. */
export const JOB_MODEL_ROUTING_AUDIT_READY = false;

/**
 * Script conversions that add no model call, so they may run as scripts on a
 * development agent before `laterScriptJobs` opens. The rule is about model
 * calls (Justin, topic 130742, 2026-10-27 08:41 PDT: "ALL calls to Jev or ANY
 * LLM should abide by our benchmark auditing standards"):
 * - llm-decision-grading: the grading pass is deterministic.
 * - health-check (CMT-1586): the script reads only the authenticated /health
 *   and disk space; its Jev triage stays closed by `resultTriage` above, so a
 *   script run makes no model call and replaces a Haiku session every 5 min.
 * correction-class-review-backstop stays out: its backfill can call an LLM.
 * The fleet is unchanged: the development-agent gate and the default
 * `disabledSlugs` still keep these on their session path there.
 */
export const AUDIT_READY_SCRIPT_SLUGS: ReadonlySet<string> = new Set([
  'llm-decision-grading',
  'health-check',
]);
