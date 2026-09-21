#!/usr/bin/env node
/**
 * jev-shadow-report.mjs — read the Jev signal-layer shadow log and report the
 * soak as PER-RULE CONFUSION MATRICES plus COVERAGE. Never one blended
 * agreement percentage: 99% agreement can hide total failure on rare positives.
 *
 * Spec: docs/specs/jev-signal-layer-shadow.md (graduation criterion).
 *
 * Usage (from the agent home):
 *   node scripts/jev-shadow-report.mjs [logPath] [--json]
 * Default logPath: logs/jev-signal-shadow.jsonl
 *
 * Rows are deduplicated by sha256 (a message re-entering the gate on retry is
 * one candidate, not two). Detector truth = the B1–B7 deterministic signal
 * kinds recorded in the row; Jev "positive" = p > 0.5 (the frozen threshold).
 */
import fs from 'node:fs';

const RULE_TO_KIND = {
  raw_path: 'file-path', cli_command: 'cli-command', config_key: 'config-key',
  api_endpoint: 'api-endpoint', copy_paste_code: 'copy-paste-code', env_var: 'env-var',
  cron_or_slug: 'cron-or-slug',
};
const THRESHOLD = 0.5;
const MIN_POSITIVES = 20;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const logPath = args.find((a) => !a.startsWith('--')) ?? 'logs/jev-signal-shadow.jsonl';

export function buildReport(lines) {
  const seen = new Set();
  const compared = [];
  const notCompared = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.kind === 'not-compared') { notCompared[row.reason] = (notCompared[row.reason] ?? 0) + 1; continue; }
    if (row.kind !== 'compared' || seen.has(row.sha256)) continue;
    seen.add(row.sha256);
    compared.push(row);
  }
  const perRule = {};
  for (const [rule, kind] of Object.entries(RULE_TO_KIND)) {
    const m = { hits: 0, misses: 0, falseAlarms: 0, trueNegatives: 0, answered: 0 };
    for (const r of compared) {
      const p = r.jev?.[rule];
      if (typeof p !== 'number') continue;
      m.answered++;
      const det = (r.detectorSignals ?? []).includes(kind);
      const jev = p > THRESHOLD;
      if (det && jev) m.hits++; else if (det && !jev) m.misses++;
      else if (!det && jev) m.falseAlarms++; else m.trueNegatives++;
    }
    const positives = m.hits + m.misses;
    m.positiveCases = positives;
    m.agreement = m.answered ? +((m.hits + m.trueNegatives) / m.answered).toFixed(4) : null;
    m.verdict = positives < MIN_POSITIVES ? 'insufficient-evidence'
      : (m.agreement >= 0.99 && m.misses === 0 ? 'meets-bar' : 'below-bar');
    perRule[rule] = m;
  }
  const notComparedTotal = Object.values(notCompared).reduce((a, b) => a + b, 0);
  const candidates = compared.length + notComparedTotal;
  return {
    candidates,
    comparedDistinct: compared.length,
    coverage: candidates ? +(compared.length / candidates).toFixed(4) : null,
    notCompared,
    perRule,
    graduationEligible: candidates > 0
      && compared.length / candidates >= 0.9
      && Object.values(perRule).every((m) => m.verdict !== 'below-bar')
      && Object.values(perRule).some((m) => m.verdict === 'meets-bar'),
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (!fs.existsSync(logPath)) { console.error(`no shadow log at ${logPath}`); process.exit(1); }
  const report = buildReport(fs.readFileSync(logPath, 'utf8').split('\n'));
  if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
  console.log(`candidates ${report.candidates} · compared (distinct) ${report.comparedDistinct} · coverage ${report.coverage}`);
  console.log(`not compared: ${JSON.stringify(report.notCompared)}`);
  console.log('rule              positives  hits  misses  falseAlarms  agreement  verdict');
  for (const [rule, m] of Object.entries(report.perRule)) {
    console.log(`${rule.padEnd(17)} ${String(m.positiveCases).padStart(9)} ${String(m.hits).padStart(5)} ${String(m.misses).padStart(7)} ${String(m.falseAlarms).padStart(12)}  ${String(m.agreement).padStart(9)}  ${m.verdict}`);
  }
  console.log(`graduation-eligible: ${report.graduationEligible}`);
}
