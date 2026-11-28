#!/usr/bin/env node
/** Read-only report. Scheduling and message delivery belong to the operator, never this script. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

export async function throughputReport(stateDir, hours = 2, now = Date.now()) {
  if (!(hours > 0 && hours <= 744)) throw new Error('hours must be greater than zero and at most744');
  const since = now - hours * 3_600_000;
  const dir = path.join(stateDir, 'state', 'local-verify');
  const records = [];
  let invalidJournalLines = 0, legacyFinishTimeFallbacks = 0;
  const source = path.join(dir, 'journal.jsonl');
  if (fs.existsSync(source)) {
    const lines = readline.createInterface({ input: fs.createReadStream(source), crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const entry = JSON.parse(line), r = entry.record;
        const writtenAt = Date.parse(entry.writtenAt);
        const at = Number.isFinite(writtenAt) ? writtenAt : Date.parse(r.finishedAt);
        if (!Number.isFinite(writtenAt)) legacyFinishTimeFallbacks++;
        if (r.kind !== 'main' && Number.isInteger(r.pr) && at >= since && at <= now) records.push(r);
      } catch { invalidJournalLines++; }
    }
  }
  let rows = [], timingAvailable = false;
  const timingPath = path.join(dir, 'throughput-metrics.json');
  try {
    if (fs.statSync(timingPath).size > 4_000_000) throw new Error('metrics size bound');
    const saved = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
    if (saved.v !== 1 || !Array.isArray(saved.rows) || saved.rows.length > 2000) throw new Error('metrics format');
    rows = saved.rows; timingAvailable = true;
  } catch { /* Missing telemetry is unknown, never a zero-latency claim. */ }
  const inventoryState = (r) => {
    const c = r.inventoryCoverage;
    const usable = c && Number.isSafeInteger(c.expectedFiles) && c.expectedFiles > 0 && Number.isSafeInteger(c.reportedFiles) && c.reportedFiles >= 0
      && typeof c.complete === 'boolean' && (!c.complete || c.expectedFiles === c.reportedFiles);
    return usable ? (c.complete ? 'complete' : 'incomplete') : !c && r.outcome === 'success' ? 'complete' : 'unknown';
  };
  const complete = records.filter((r) => inventoryState(r) === 'complete');
  const green = complete.filter((r) => r.outcome === 'success');
  const lowerBounds = [], unresolved = [];
  for (const row of rows) {
    if (!Number.isSafeInteger(row.firstObservedPublishedHeadAt) || row.firstObservedPublishedHeadAt > now) continue;
    const matching = records.filter((r) => r.pr === row.pr && r.repo === row.repo && r.headSha === row.headSha && r.baseSha === row.baseSha && r.baseRefName === row.baseRefName);
    for (const r of matching) {
      const verdictAt = (row.verdicts ?? []).find((v) => v.runFinishedAt === Date.parse(r.finishedAt) && v.runStartedAt === Date.parse(r.startedAt))?.at;
      if (Number.isSafeInteger(verdictAt) && verdictAt >= row.firstObservedPublishedHeadAt) lowerBounds.push(verdictAt - row.firstObservedPublishedHeadAt);
    }
    if (!(row.verdicts ?? []).length) unresolved.push({ repo: row.repo, pr: row.pr, headSha: row.headSha, baseSha: row.baseSha, baseRefName: row.baseRefName, elapsedSinceFirstObservationMs: now - row.firstObservedPublishedHeadAt, lastObservedAt: row.lastObservedAt });
  }
  lowerBounds.sort((a, b) => a - b);
  const median = (xs) => !xs.length ? null : xs.length % 2 ? xs[Math.floor(xs.length / 2)] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  return { asOf: new Date(now).toISOString(), since: new Date(since).toISOString(), hours,
    attempts: records.length, completeInventoryVerdicts: complete.length, completeInventoryVerdictsPerHour: complete.length / hours,
    completeGreenHeadVerdicts: green.length, completeGreenHeadVerdictsPerHour: green.length / hours,
    distinctGreenPrs: new Set(green.map((r) => `${r.repo}:${r.pr}`)).size,
    incompleteInventories: records.filter((r) => inventoryState(r) === 'incomplete').length,
    unknownInventoryFailures: records.filter((r) => inventoryState(r) === 'unknown').length,
    exactPublicationTimeAvailable: false,
    observedHeadToVerdictLowerBound: { timingAvailable, samples: lowerBounds.length, medianMs: median(lowerBounds), p90Ms: lowerBounds.length ? lowerBounds[Math.ceil(.9 * lowerBounds.length) - 1] : null,
      meaning: 'Elapsed since first observed published exact head/base, a LOWER BOUND on publication-to-verdict; not actual publication time.' },
    unresolvedObservations: unresolved, invalidJournalLines, legacyFinishTimeFallbacks,
    limitations: 'Unresolved observations are NOT a live queue: they may include superseded, closed or remotely completed candidates. Elapsed age does not assert continued waiting. Fallback/invalid-line counts cover all scanned history. Machine-local metadata. Timing rows retain30days/max2000 keys/eight verdicts per key. Missing timings and legacy failure coverage remain unknown. Existing accepted skips are not zero-skip proof. Derived records are verdicts but may not represent new physical executions.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
  const stateDir = process.argv.includes('--state-dir') ? value('--state-dir') : path.resolve('.instar');
  const hours = process.argv.includes('--hours') ? Number(value('--hours')) : 2;
  console.log(JSON.stringify(await throughputReport(stateDir, hours), null, 2));
}
