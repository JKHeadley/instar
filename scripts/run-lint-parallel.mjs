#!/usr/bin/env node
/**
 * run-lint-parallel.mjs — run the `lint` chain's steps concurrently.
 *
 * `package.json` `scripts.lint` stays the single list of lint steps (Local Verify
 * splits it on `&&` and runs each step; tests assert which steps it names). This
 * runner reads that same list, so it can never drift from it, and runs the steps
 * at the same time instead of one after another. The steps are independent: none
 * reads another's output, and the three that can write files only do so in modes
 * the chain never passes (`--write-baseline`, or no `--check`).
 *
 * Differences from `npm run lint`, both deliberate:
 *   - every step runs even after one fails, so a single run reports every failure;
 *   - each step's output is buffered and printed whole, in list order.
 *
 * Exit codes: 0 — every step passed; 1 — at least one step failed.
 * INSTAR_LINT_CONCURRENCY=1 runs the steps one at a time, in order.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Split a script exactly as Local Verify's orchestrator does. */
export function parseLintSteps(script) {
  if (typeof script !== 'string') return [];
  return script.split('&&').map((s) => s.trim()).filter(Boolean);
}

export function defaultConcurrency(env = process.env) {
  const raw = Number.parseInt(env.INSTAR_LINT_CONCURRENCY ?? '', 10);
  if (Number.isInteger(raw) && raw >= 1) return raw;
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, cores - 1));
}

function runStep(command, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    // `npm run` puts node_modules/.bin first on PATH; do the same so a step such
    // as `tsc --noEmit` resolves identically when this runner is invoked directly.
    const env = { ...process.env, PATH: [path.join(cwd, 'node_modules', '.bin'), process.env.PATH].filter(Boolean).join(path.delimiter) };
    const child = spawn('sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', (err) => {
      chunks.push(Buffer.from(`run-lint-parallel: could not start step: ${err.message}\n`));
    });
    child.on('close', (code, signal) => {
      resolve({ command, code: code ?? 1, signal: signal ?? null, ms: Date.now() - started, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

/** Run every step with at most `concurrency` at once; results keep list order. */
export async function runSteps(steps, { concurrency = 1, cwd = ROOT } = {}) {
  const results = new Array(steps.length);
  let next = 0;
  const worker = async () => {
    while (next < steps.length) {
      const i = next++;
      results[i] = await runStep(steps[i], cwd);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), steps.length) }, worker));
  return results;
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const steps = parseLintSteps(pkg.scripts?.lint);
  if (steps.length === 0) {
    console.error('run-lint-parallel: package.json has no lint steps.');
    process.exit(1);
  }
  const concurrency = defaultConcurrency();
  const started = Date.now();
  const results = await runSteps(steps, { concurrency, cwd: ROOT });
  for (const r of results) {
    const status = r.code === 0 ? 'ok' : `FAILED (exit ${r.code}${r.signal ? `, ${r.signal}` : ''})`;
    process.stdout.write(`\n── ${r.command} — ${status}, ${(r.ms / 1000).toFixed(1)}s\n`);
    if (r.output) process.stdout.write(r.output.endsWith('\n') ? r.output : `${r.output}\n`);
  }
  const failed = results.filter((r) => r.code !== 0);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (failed.length > 0) {
    console.error(`\nrun-lint-parallel: ${failed.length} of ${results.length} lint step(s) failed in ${secs}s (concurrency ${concurrency}):`);
    for (const r of failed) console.error(`  - ${r.command}`);
    process.exit(1);
  }
  console.log(`\nrun-lint-parallel: all ${results.length} lint steps passed in ${secs}s (concurrency ${concurrency}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
