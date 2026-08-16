#!/usr/bin/env node
/**
 * Phase-acceptance gate.
 *
 * Reads a phase manifest at specs/provider-portability/acceptance/phase-
 * <N>.json and runs every gate (structural + real-API). Exits 0 if every
 * gate passed against a live provider. Exits non-zero with a structured
 * report otherwise.
 *
 * Rationale: on 2026-05-15 I declared Phase 4 (OpenAI Codex adapter)
 * "complete" with only structural evidence — 7/7 parity scenarios in
 * realApi=false mode, smoke test exit-0 under AUTH-BLOCKED. Zero
 * successful real Codex calls. Justin caught this and named the
 * underlying failure: my own soft-failure escape hatches let me move on
 * before verifying behavior. This script makes that pattern
 * structurally impossible — auth-blocked is non-zero exit, this script
 * treats non-zero as FAIL, phase status stays code-complete instead of
 * advancing to verified.
 *
 * See: specs/provider-portability/acceptance/README.md
 *      memory/feedback_phase_completion_real_api_verified.md
 *
 * Usage:
 *   node scripts/check-phase-complete.cjs <phase-id>
 *   node scripts/check-phase-complete.cjs 4
 *   node scripts/check-phase-complete.cjs 4 --structural-only
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const phaseId = args.find((a) => !a.startsWith('--'));
const structuralOnly = args.includes('--structural-only');

if (!phaseId) {
  console.error('Usage: check-phase-complete.cjs <phase-id> [--structural-only]');
  process.exit(2);
}

const manifestPath = path.resolve(
  __dirname,
  '..',
  'specs',
  'provider-portability',
  'acceptance',
  `phase-${phaseId}.json`,
);

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
} catch (err) {
  console.error(`Cannot read manifest at ${manifestPath}: ${err.message}`);
  process.exit(2);
}

function runGate(gate, category) {
  const start = Date.now();
  const result = spawnSync('sh', ['-c', gate.command], {
    encoding: 'utf-8',
    timeout: gate.timeoutMs ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  const elapsed = Date.now() - start;
  const exitCode = result.status;
  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();

  let status = 'pass';
  let reason = '';

  if (result.error) {
    status = 'fail';
    reason = `spawn error: ${result.error.message}`;
  } else if (gate.expectExitCode !== undefined && exitCode !== gate.expectExitCode) {
    status = 'fail';
    reason = `expected exit ${gate.expectExitCode}, got ${exitCode}`;
  } else if (gate.expectStdoutContains && !stdout.includes(gate.expectStdoutContains) && !stderr.includes(gate.expectStdoutContains)) {
    status = 'fail';
    reason = `expected stdout to contain "${gate.expectStdoutContains}"`;
  }

  return {
    category,
    id: gate.id,
    description: gate.description,
    status,
    reason,
    exitCode,
    elapsedMs: elapsed,
    stdoutTail: stdout.slice(-500),
    stderrTail: stderr.slice(-500),
  };
}

const results = [];

console.error(`\nPhase-acceptance gate — phase ${manifest.phase} (${manifest.name})`);
console.error(`Manifest status: ${manifest.status}`);
console.error('');

console.error('Structural gates:');
for (const gate of manifest.structuralGates ?? []) {
  const r = runGate(gate, 'structural');
  results.push(r);
  console.error(`  [${r.status === 'pass' ? 'PASS' : 'FAIL'}] ${r.id} (${r.elapsedMs}ms)${r.reason ? ' — ' + r.reason : ''}`);
}

if (!structuralOnly) {
  console.error('');
  console.error('Real-API gates:');
  for (const gate of manifest.realApiGates ?? []) {
    const r = runGate(gate, 'real-api');
    results.push(r);
    console.error(`  [${r.status === 'pass' ? 'PASS' : 'FAIL'}] ${r.id} (${r.elapsedMs}ms)${r.reason ? ' — ' + r.reason : ''}`);
    if (r.status === 'fail' && r.stderrTail) {
      const head = r.stderrTail.split('\n').slice(0, 3).join(' | ');
      console.error(`         stderr: ${head}`);
    }
  }
} else {
  console.error('');
  console.error('Real-API gates: SKIPPED (--structural-only)');
}

const failed = results.filter((r) => r.status === 'fail');
const realApiResults = results.filter((r) => r.category === 'real-api');
const realApiPassed = realApiResults.length > 0 && realApiResults.every((r) => r.status === 'pass');

console.error('');
console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
if (failed.length === 0 && !structuralOnly && realApiPassed) {
  console.error(`Phase ${manifest.phase}: VERIFIED — all ${results.length} gate(s) passed`);
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  process.exit(0);
}
if (failed.length === 0 && structuralOnly) {
  console.error(`Phase ${manifest.phase}: CODE-COMPLETE — ${results.length}/${results.length} structural, real-API skipped`);
  console.error('  Phase is NOT verified — re-run without --structural-only with credentials available');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  process.exit(1);
}
console.error(`Phase ${manifest.phase}: BLOCKED — ${failed.length}/${results.length} gate(s) failed`);
for (const r of failed) {
  console.error(`  ✗ ${r.category}/${r.id}: ${r.reason}`);
}
console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
process.exit(1);
