#!/usr/bin/env node
// Round driver — orchestrates a systematic set of harness runs for one round,
// bounding intensity so benchmark load never starves the agent's own outbound
// path (shared host spawn cap = 8). Produces ONE consolidated summary per round
// instead of scattered ad-hoc files.
//
// Usage:
//   node run-round.mjs --round r2-baseline --n 30 --prompt ping \
//        --pathways claude-haiku,claude-sonnet,claude-opus,pi-gpt55,gemini-flash
//   node run-round.mjs --round r2-baseline-codex --n 30 --prompt ping \
//        --pathways codex-gpt55,codex-gpt54mini,codex-gpt55-plain --concurrency 1
//
// Runs each pathway sequentially (concurrency defaults to 1 = uncontended
// baseline), one harness invocation per pathway, and appends a consolidated
// row to results/<round>.consolidated.json.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(__dir, 'results');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const round = arg('round', 'r2-baseline');
const N = arg('n', '30');
const prompt = arg('prompt', 'ping');
const concurrency = arg('concurrency', '1');
const timeout = arg('timeout', '120000');
const pathways = arg('pathways', 'claude-haiku').split(',').map(s => s.trim()).filter(Boolean);

function runHarness(pw) {
  return new Promise((resolve) => {
    const label = `${round}_${pw}`;
    const args = ['harness.mjs', '--pathway', pw, '--prompt', prompt, '--n', N,
      '--concurrency', concurrency, '--timeout', timeout, '--label', label];
    const t0 = Date.now();
    process.stderr.write(`\n[round ${round}] ${pw} n=${N} c=${concurrency} prompt=${prompt} ...\n`);
    const child = spawn('node', args, { cwd: __dir, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('close', (code) => {
      process.stderr.write(`[round ${round}] ${pw} done in ${Math.round((Date.now()-t0)/1000)}s (exit ${code})\n`);
      resolve();
    });
  });
}

// Pull the freshest summary.json for a pathway+round from results/.
function latestSummaryFor(pw) {
  const needle = `${round}_${pw}_`;
  const files = readdirSync(RESULTS).filter(f => f.includes(needle) && f.endsWith('.summary.json'));
  if (!files.length) return null;
  files.sort();
  const f = files[files.length - 1];
  try {
    const j = JSON.parse(readFileSync(join(RESULTS, f), 'utf8'));
    return (j.summaries && j.summaries[0]) ? { file: f, ...j.summaries[0] } : null;
  } catch { return null; }
}

async function main() {
  for (const pw of pathways) await runHarness(pw);

  const consolidated = pathways.map(pw => latestSummaryFor(pw)).filter(Boolean);
  const outFile = join(RESULTS, `${round}.consolidated.json`);
  const prev = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : { round, rows: [] };
  // Merge by pathway (latest wins).
  const byId = new Map(prev.rows.map(r => [r.pathway, r]));
  for (const r of consolidated) byId.set(r.pathway, r);
  const merged = { round, prompt, n: Number(N), concurrency: Number(concurrency), rows: [...byId.values()] };
  writeFileSync(outFile, JSON.stringify(merged, null, 2));
  process.stderr.write(`\n[round ${round}] consolidated ${consolidated.length} pathways -> ${outFile}\n`);
  // Compact table to stdout for quick reading.
  for (const r of merged.rows) {
    process.stdout.write(`${r.pathway.padEnd(20)} ok=${r.okRate} p50=${r.latencyMs?.p50}ms p95=${r.latencyMs?.p95}ms meanIn=${r.tokens?.meanIn} meanOut=${r.tokens?.meanOut} err=${JSON.stringify(r.byError)}\n`);
  }
}

main();
