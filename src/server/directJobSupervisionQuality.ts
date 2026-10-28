/**
 * Read-only bridge from direct TypeSafe job-supervision calls into the bulk
 * decision-quality view. These are not IntelligenceRouter settlements and must
 * never be counted among the router's decision_quality rows.
 */
import type { JobSupervisionStore } from '../scheduler/JobSupervisionStore.js';
import { isSideRun, type JobRunHistory } from '../scheduler/JobRunHistory.js';

const EXPECTED_DECISION_POINT = 'job-result-supervision-v2';

export function buildDirectJobSupervisionQuality(input: {
  store: JobSupervisionStore;
  history: JobRunHistory;
  sinceHours: number;
  now?: number;
}): Record<string, unknown> {
  const sinceHours = Number.isFinite(input.sinceHours) && input.sinceHours > 0
    ? Math.min(720, input.sinceHours) : 24;
  const since = new Date((input.now ?? Date.now()) - sinceHours * 3_600_000).toISOString();
  const scan = input.history.query({ sinceHours, limit: 5000, excludeSideRuns: true });
  const runs = scan.runs.filter(r => r.runner === 'script' && !isSideRun(r));
  const runIds = new Set(runs.map(r => r.runId));
  const attempts = input.store.listSince(since, 5000);
  const orphanAttempts = attempts.filter(a => !runIds.has(a.runId)).length;
  let missingRecords = 0;
  let correct = 0;
  let incorrect = 0;
  let unknown = 0;
  const countGrade = (grade: string): void => {
    if (grade === 'correct') correct++;
    else if (grade === 'incorrect') incorrect++;
    else unknown++;
  };
  for (const run of runs) {
    const row = input.store.findByRunId(run.runId);
    if (!row) { missingRecords++; unknown++; }
    else countGrade(row.grade);
  }
  for (const row of attempts) if (!runIds.has(row.runId)) countGrade(row.grade);
  const denominator = runs.length + orphanAttempts;
  const callAudit = input.store.callSummarySince(since);
  const callDetails = input.store.qualityCallRowsSince(since, 500);
  const observedDecisionPoints = [...new Set(callAudit.map(row => row.decisionPoint))].sort();
  const unexpectedDecisionPoints = observedDecisionPoints.filter(id => id !== EXPECTED_DECISION_POINT);
  const callAuditGroupsTruncated = callAudit.length > 500;
  const coverageIncomplete = scan.total > scan.runs.length || !input.history.isReadHealthy()
    || input.store.journalWasRecreated() || attempts.length === 5000
    || missingRecords > 0 || orphanAttempts > 0 || callAuditGroupsTruncated
    || unexpectedDecisionPoints.length > 0;
  return {
    available: true,
    source: 'job-supervision-store',
    routerEnrollment: 'pending',
    expectedDecisionPoint: EXPECTED_DECISION_POINT,
    observedDecisionPoints,
    unexpectedDecisionPoints,
    sinceHours,
    denominator,
    missingRecords,
    orphanAttempts,
    coverageIncomplete,
    gradeDistribution: { correct, incorrect, unknown },
    gradableFraction: coverageIncomplete || denominator === 0 ? null : (correct + incorrect) / denominator,
    accuracy: coverageIncomplete || correct + incorrect === 0 ? null : correct / (correct + incorrect),
    callCount: callAudit.reduce((n, row) => n + row.calls, 0),
    costUnknownCalls: callAudit.reduce((n, row) => n + row.costUnknown, 0),
    callAudit: callAudit.slice(0, 500),
    callAuditGroupsTruncated,
    callDetails: callDetails.rows,
    callDetailsTruncated: callDetails.truncated,
  };
}
