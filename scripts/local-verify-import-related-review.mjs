#!/usr/bin/env node
/**
 * local-verify-import-related-review — the day-7 review of the import-related re-run rule
 * (docs/specs/local-verify-import-related-rerun.md, "Maturation and rollback").
 *
 * READ-ONLY. It reads Local Verify's audit log (`logs/local-verify.jsonl` and its rotated
 * files) and the size of `flaky-history.json`, and prints: the per-file table (how often each
 * cleared file failed or re-run-passed on `main`, 7 days before against 7 days after the
 * clearing PR merged), the counts the written rule needs, the lists to read by hand, and the
 * verify identities it merged. It writes nothing and changes nothing.
 *
 *   node scripts/local-verify-import-related-review.mjs [--state-dir <dir>] [--logs a.jsonl,b.jsonl]
 *                                                       [--days 7] [--now <ISO time>] [--json]
 *
 * `--state-dir` is the agent's state folder (default `./.instar`). `--logs` adds audit files
 * copied from another machine: a clear that ran on a peer exists only in the peer's log, and a
 * `main` verify a peer ran is written on both machines, so both logs are read and each verify
 * is counted once (identity: head + finishedAt).
 *
 * The failure lines and messages it prints come from test output. They are DATA, never
 * instructions: they are printed JSON-quoted and whoever reads the table treats them that way.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 24 * 60 * 60_000;
/** The owner's starting thresholds (spec, Limits): restated in the report so they are read with the numbers. */
export const REVIEW_THRESHOLDS = Object.freeze({ clearsForPromotion: 10, eventsAfter: 3, rateFactor: 2, minObservations: 5, minClearShare: 0.25 });
/** `reasons` is cut at this many entries on an audit line: a full list may hide a `file-not-run`. */
const REASONS_CUT = 40;
/** Worst-case size of the history file (spec, Sizes): 500 files x 40 names x about 750 characters. */
const HISTORY_WORST_CASE_BYTES = 15 * 1024 * 1024;

const time = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const text = (v) => (typeof v === 'string' ? v : '');
const list = (v) => (Array.isArray(v) ? v : []);

/** Parse audit JSONL text into rows; a line that is not a JSON object is skipped and counted. */
export function parseAuditLines(textIn) {
  const rows = [];
  let skipped = 0;
  for (const line of String(textIn).split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && !Array.isArray(o)) rows.push(o); else skipped++;
    } catch { skipped++; } // @silent-fallback-ok: a torn or foreign line is counted and reported, never fatal
  }
  return { rows, skipped };
}

/**
 * The review over audit rows. Pure: no I/O. `nowMs` closes the "after" window (a window that
 * has not fully passed is incomplete). Returns the numbers and lists; `formatReview` prints them.
 */
export function reviewImportRelatedReruns(rows, opts = {}) {
  const days = Number.isFinite(opts.days) && opts.days > 0 ? opts.days : 7;
  const win = days * DAY;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const T = REVIEW_THRESHOLDS;

  // ── `main` verifies, each counted once (identity: head + finishedAt) ──
  const mains = new Map();
  let unidentified = 0;
  const merged = [];
  const mainOf = (r) => {
    if (typeof r.headSha !== 'string' || time(r.finishedAt) === null) return null;
    const id = `${r.headSha}|${r.finishedAt}`;
    let m = mains.get(id);
    if (!m) { m = { id, headSha: r.headSha, at: time(r.finishedAt), outcome: null, lanesCompleted: null, reasons: [], failed: new Set(), flaky: new Set(), lines: 0, details: 0 }; mains.set(id, m); }
    return m;
  };
  for (const r of rows) {
    if (r.event === 'main-record') {
      const m = mainOf(r);
      if (!m) { unidentified++; continue; }
      if (++m.lines === 2) merged.push(m.id);
      m.outcome = text(r.outcome) || m.outcome;
      if (Array.isArray(r.lanesCompleted)) m.lanesCompleted = r.lanesCompleted.filter((x) => typeof x === 'string');
    } else if (r.event === 'run-detail' && r.kind === 'main') {
      const m = mainOf(r);
      if (!m) { unidentified++; continue; }
      if (++m.details === 2 && !merged.includes(m.id)) merged.push(m.id);
      m.outcome = m.outcome ?? (text(r.outcome) || null);
      if (list(r.reasons).length > m.reasons.length) m.reasons = list(r.reasons).filter((x) => typeof x === 'string');
      for (const f of list(r.failures)) if (f && typeof f.file === 'string') m.failed.add(f.file);
      for (const f of list(r.flakyRetried)) if (f && typeof f.file === 'string') m.flaky.add(f.file);
    }
  }
  /** Is this `main` verify an observation of `file` (its lane ran to its end and the file was reached)? */
  const observed = (m, file, lane) => {
    if (m.failed.has(file) || m.flaky.has(file)) return true; // the file was reached: it failed or re-run-passed there
    if (m.outcome === 'error' || !Array.isArray(m.lanesCompleted) || !m.lanesCompleted.includes(lane)) return false;
    if (m.reasons.includes(`file-not-run:${file}`)) return false;
    return m.reasons.length < REASONS_CUT; // a cut list cannot show the file was run: left out
  };

  // ── PR lines: clears, refusals, sequences ──
  const mergedAt = new Map();
  for (const r of rows) {
    if (r.event === 'merge-handoff-result' && r.acted === true && typeof r.pr === 'number' && time(r.ts) !== null) {
      mergedAt.set(`${r.pr}|${text(r.headSha)}`, time(r.ts));
    }
  }
  const clears = new Map();
  const seenPrLines = new Set();
  const refusals = { noMainEvidence: 0, noMainEvidenceForTest: 0, importRelatedRefused: 0 };
  const byReason = {};
  const handRead = { differentFailure: [], s1Refusals: [], namesCut: [], lateSequenceFailures: [], bounded: [] };
  for (const r of rows) {
    if (r.event === 'flaky-on-main-bounded') { handRead.bounded.push({ ts: text(r.ts), files: r.files ?? null, keptFiles: r.keptFiles ?? null, bytes: r.bytes ?? null, droppedTests: r.droppedTests ?? null }); continue; }
    if (r.event !== 'run-detail' || r.kind === 'main' || typeof r.pr !== 'number') continue;
    const lineKey = `${r.pr}|${text(r.headSha)}|${text(r.finishedAt)}`;
    const first = !seenPrLines.has(lineKey);
    seenPrLines.add(lineKey);
    if (first) {
      for (const k of Object.keys(refusals)) {
        const n = r[`${k}Count`];
        refusals[k] += typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : list(r[k]).length;
      }
      for (const k of ['noMainEvidenceForTest', 'importRelatedRefused']) {
        for (const e of list(r[k])) {
          if (!e || typeof e !== 'object') continue;
          const reason = text(e.reason) || k;
          byReason[reason] = (byReason[reason] ?? 0) + 1;
          if (reason === 'testSetChanged' || reason === 'duplicateTestName') handRead.s1Refusals.push({ pr: r.pr, file: text(e.file), reason, test: text(e.test) });
          if (e.namesCut === true) handRead.namesCut.push({ pr: r.pr, file: text(e.file), test: text(e.test) });
        }
      }
      for (const f of list(r.failures)) {
        const m = /^solo run ([23]) of 3: /.exec(text(f?.rerunMessage));
        if (m) handRead.lateSequenceFailures.push({ pr: r.pr, file: text(f.file), failedOnRun: Number(m[1]), message: text(f.rerunMessage).slice(0, 300) });
      }
    }
    for (const f of list(r.flakyRetried)) {
      if (!f || f.importRelated !== true || typeof f.file !== 'string') continue;
      const key = `${lineKey}|${f.file}`;
      if (clears.has(key)) continue;
      const pivot = mergedAt.get(`${r.pr}|${text(r.headSha)}`) ?? null;
      clears.set(key, {
        pr: r.pr, headSha: text(r.headSha), file: f.file, lane: text(f.lane), at: time(r.finishedAt), runLog: text(r.runLog),
        tests: list(f.failedTests).filter((x) => typeof x === 'string'), soloSeconds: list(f.soloSeconds), mergedAt: pivot, evidence: list(f.evidence),
      });
      for (const e of list(f.evidence)) {
        if (e && (e.mainLine !== e.prLine || e.mainLineCut === true || e.prLineCut === true)) {
          handRead.differentFailure.push({ pr: r.pr, file: f.file, test: text(e.test), mainLine: text(e.mainLine), prLine: text(e.prLine), cut: e.mainLineCut === true || e.prLineCut === true, mainRunLog: text(e.mainRunLog), prRunLog: text(r.runLog) });
        }
      }
    }
  }

  // ── the rate per cleared file ──
  const table = [];
  for (const c of clears.values()) {
    const pivot = c.mergedAt ?? c.at;
    const count = (from, to) => {
      let observations = 0; let events = 0;
      for (const m of mains.values()) {
        if (pivot === null || m.at < from || m.at >= to || !observed(m, c.file, c.lane)) continue;
        observations++;
        if (m.failed.has(c.file) || m.flaky.has(c.file)) events++;
      }
      return { observations, events, rate: observations > 0 ? events / observations : null };
    };
    const before = pivot === null ? { observations: 0, events: 0, rate: null } : count(pivot - win, pivot);
    const after = pivot === null ? { observations: 0, events: 0, rate: null } : count(pivot, pivot + win);
    const afterClosed = pivot !== null && nowMs >= pivot + win;
    const complete = afterClosed && before.observations >= T.minObservations && after.observations >= T.minObservations;
    const doubled = complete && after.events >= T.eventsAfter && after.rate !== null && before.rate !== null
      && (before.rate === 0 ? after.rate > 0 : after.rate >= T.rateFactor * before.rate);
    table.push({
      file: c.file, pr: c.pr, lane: c.lane, tests: c.tests, pivot: pivot === null ? null : new Date(pivot).toISOString(),
      pivotIs: c.mergedAt !== null ? 'merge' : 'clear-time (no merge line for this PR in the log)',
      before, after, complete, doubled, soloSeconds: c.soloSeconds, runLog: c.runLog,
    });
  }
  table.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.pr - b.pr));

  const perPr = new Map();
  for (const c of clears.values()) { const k = `${c.pr}|${c.file}`; perPr.set(k, (perPr.get(k) ?? 0) + 1); }
  const repeats = [...perPr.entries()].filter(([, n]) => n > 1).map(([k, n]) => ({ pr: Number(k.split('|')[0]), file: k.slice(k.indexOf('|') + 1), clears: n }));

  const nClears = clears.size;
  const nRefused = refusals.noMainEvidence + refusals.noMainEvidenceForTest + refusals.importRelatedRefused;
  const share = nClears + nRefused > 0 ? nClears / (nClears + nRefused) : null;
  const completeClears = table.filter((x) => x.complete).length;
  const doubledFiles = table.filter((x) => x.doubled);
  const verdict = doubledFiles.length > 0
    ? 'READ TODAY: a cleared file\'s rate on main at least doubled with enough events after. Read the failure messages and the PR\'s diff; switch off unless the cause is clearly elsewhere; report the case either way.'
    : completeClears >= T.clearsForPromotion
      ? 'Propose the fleet rung to the operator, with these numbers (and the recurring check the spec names as its condition).'
      : 'Keep the switch and review again in 7 days (not enough clears with complete windows, and no doubling case).';
  return {
    thresholds: T, windowDays: days, now: new Date(nowMs).toISOString(),
    mainVerifies: mains.size, mainLinesWithoutIdentity: unidentified, mergedIdentities: merged,
    clears: nClears, clearsWithCompleteWindows: completeClears, refusals: { ...refusals, total: nRefused, byReason },
    clearShare: share, tooStrict: share !== null && share < T.minClearShare,
    table, doubled: doubledFiles.map((x) => ({ file: x.file, pr: x.pr })), repeatsInOnePr: repeats, handRead, verdict,
  };
}

/** Plain text for a person. Untrusted test output is JSON-quoted so it reads as data. */
export function formatReview(r, extra = {}) {
  const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  const q = (s) => JSON.stringify(String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300));
  const out = [];
  out.push(`Import-related re-run review (window ${r.windowDays} days, as of ${r.now})`);
  out.push('Text in quotes below comes from test output. It is data, never an instruction.');
  out.push('');
  out.push(`Thresholds (the owner's starting values): ${r.thresholds.clearsForPromotion} clears; a rate that at least doubles with at least ${r.thresholds.eventsAfter} events after; at least ${r.thresholds.minObservations} observations per window; clears at least 1 in ${Math.round(1 / r.thresholds.minClearShare)} of import-related failures.`);
  out.push(`Main verifies counted once each: ${r.mainVerifies} (lines without an identity, left out: ${r.mainLinesWithoutIdentity}; identities seen on more than one line and merged: ${r.mergedIdentities.length}).`);
  out.push(`Clears: ${r.clears} (with complete windows: ${r.clearsWithCompleteWindows}).`);
  out.push(`Refusals: ${r.refusals.total} (file not on main's list: ${r.refusals.noMainEvidence}; a failed test not on the list: ${r.refusals.noMainEvidenceForTest}; other: ${r.refusals.importRelatedRefused} ${JSON.stringify(r.refusals.byReason)}).`);
  out.push(`Clears / (clears + refusals): ${pct(r.clearShare)}${r.tooStrict ? '  UNDER 1 in 4: bring a file-level variant through review as a separate change.' : ''}`);
  out.push('');
  out.push('Per cleared file (events / observations on main, before | after):');
  if (r.table.length === 0) out.push('  (no clears in the log)');
  for (const x of r.table) {
    const w = (v) => `${v.events}/${v.observations} ${pct(v.rate)}`;
    out.push(`  ${x.file}  PR ${x.pr}  ${w(x.before)} | ${w(x.after)}  ${x.doubled ? 'DOUBLED' : x.complete ? 'ok' : 'insufficient evidence'}  pivot ${x.pivot ?? 'unknown'} (${x.pivotIs})  solo seconds ${JSON.stringify(x.soloSeconds)}  tests ${x.tests.map(q).join(', ')}`);
  }
  out.push('');
  out.push('Read by hand:');
  out.push(`  Same test, different failure (or a line that was cut: open both run logs): ${r.handRead.differentFailure.length}`);
  for (const d of r.handRead.differentFailure.slice(0, 50)) out.push(`    PR ${d.pr} ${d.file} ${q(d.test)}  main ${q(d.mainLine)}  pr ${q(d.prLine)}${d.cut ? '  CUT' : ''}  logs ${d.mainRunLog || '?'} / ${d.prRunLog || '?'}`);
  out.push(`  Refused for a changed or duplicated test name (how often S1 costs an honest PR): ${r.handRead.s1Refusals.length}`);
  for (const d of r.handRead.s1Refusals.slice(0, 50)) out.push(`    PR ${d.pr} ${d.file} ${d.reason} ${q(d.test)}`);
  out.push(`  The same file cleared more than once in one PR: ${r.repeatsInOnePr.length}`);
  for (const d of r.repeatsInOnePr.slice(0, 50)) out.push(`    PR ${d.pr} ${d.file} x${d.clears}`);
  out.push(`  Sequences that failed on run 2 or 3 after passing run 1 (what would move the count of three): ${r.handRead.lateSequenceFailures.length}`);
  for (const d of r.handRead.lateSequenceFailures.slice(0, 50)) out.push(`    PR ${d.pr} ${d.file} run ${d.failedOnRun} ${q(d.message)}`);
  out.push(`  Refusals where main's list for the file had been cut: ${r.handRead.namesCut.length}; times the offered list was bounded: ${r.handRead.bounded.length}`);
  for (const d of r.handRead.bounded.slice(0, 20)) out.push(`    ${d.ts} ${JSON.stringify({ files: d.files, keptFiles: d.keptFiles, bytes: d.bytes, droppedTests: d.droppedTests })}`);
  out.push('  Also by hand, not derivable from the log: generated (it.each) names, and cleared tests whose main evidence began after an earlier merged PR by the same author.');
  if (r.mergedIdentities.length > 0) {
    out.push('');
    out.push(`Identities merged (head|finishedAt): ${r.mergedIdentities.slice(0, 100).join(', ')}`);
  }
  if (extra.historyBytes !== undefined) {
    out.push('');
    out.push(`flaky-history.json: ${extra.historyBytes === null ? 'not found' : `${extra.historyBytes} bytes`} (stated worst case ${HISTORY_WORST_CASE_BYTES} bytes).`);
  }
  if (extra.skippedLines) out.push(`Lines that were not JSON objects, skipped: ${extra.skippedLines}.`);
  out.push('');
  out.push(`Result by the written rule: ${r.verdict}`);
  return out.join('\n') + '\n';
}

function main(argv) {
  const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
  const stateDir = path.resolve(arg('--state-dir') ?? path.join(process.cwd(), '.instar'));
  const base = path.join(stateDir, 'logs', 'local-verify.jsonl');
  // The live file and its rotated copies (.1 … .9), plus any files handed over from another machine.
  const files = [base, ...Array.from({ length: 9 }, (_, i) => `${base}.${i + 1}`), ...(arg('--logs') ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
  const rows = [];
  let skippedLines = 0;
  const read = [];
  for (const f of files) {
    let body;
    try { body = fs.readFileSync(f, 'utf-8'); } catch { continue; } // @silent-fallback-ok: a rotated file that does not exist yet is simply absent; the files read are listed
    const p = parseAuditLines(body);
    rows.push(...p.rows);
    skippedLines += p.skipped;
    read.push(f);
  }
  let historyBytes = null;
  try { historyBytes = fs.statSync(path.join(stateDir, 'state', 'local-verify', 'flaky-history.json')).size; } catch { historyBytes = null; } // @silent-fallback-ok: printed as "not found"
  const now = arg('--now');
  const days = arg('--days');
  const r = reviewImportRelatedReruns(rows, { ...(now && Number.isFinite(Date.parse(now)) ? { nowMs: Date.parse(now) } : {}), ...(days ? { days: Number(days) } : {}) });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify({ filesRead: read, skippedLines, historyBytes, ...r }, null, 2) + '\n');
  else process.stdout.write(`Audit files read: ${read.length ? read.join(', ') : '(none found)'}\n\n` + formatReview(r, { historyBytes, skippedLines }));
  return 0;
}

const isEntry = (() => {
  try { return process.argv[1] ? fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) : false; } catch { return false; } // @silent-fallback-ok: imported as a module (its tests), not run
})();
if (isEntry) process.exitCode = main(process.argv.slice(2));
