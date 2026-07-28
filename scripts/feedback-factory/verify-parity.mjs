#!/usr/bin/env node
/**
 * verify-parity.mjs — LOCAL parity gate for the fix-verification port.
 *
 * Runs the REAL can_transition_to_verified (datetime.now + DB query monkeypatched
 * deterministically to each case) and the TS canTransitionToVerified over the same
 * fixed `now` + recentReportsSinceFix, and asserts the full result object matches
 * (allowed, evidence, recommendation, confidence, verified_by). LOCAL evidence
 * gate, not CI.
 *
 * Exit 0 = parity; exit 1 = mismatch.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const PROCESSOR = process.env.PORTAL_PROCESSOR
  || '/Users/justin/Documents/Projects/the-portal/.claude/scripts/feedback-processor.py';
const CORPUS = path.join(__dirname, 'verify-corpus.json');
const PY_REF = path.join(__dirname, '_py_verify_ref.py');

if (!fs.existsSync(PROCESSOR)) {
  console.error(`[verify-parity] reference processor not found: ${PROCESSOR}`);
  process.exit(2);
}

const py = spawnSync('python3', [PY_REF, PROCESSOR, CORPUS], { encoding: 'utf8' });
if (py.status !== 0) {
  console.error('[verify-parity] python reference failed:\n', py.stderr || py.stdout);
  process.exit(2);
}
const reference = JSON.parse(py.stdout);

const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
const distUrl = new URL('file://' + path.join(ROOT, 'dist', 'feedback-factory', 'processor', 'verify.js'));
const { canTransitionToVerified } = await import(distUrl.href);

const norm = (r) => JSON.stringify({
  allowed: r.allowed, evidence: r.evidence,
  recommendation: r.recommendation ?? null, confidence: r.confidence ?? null,
  verified_by: r.verified_by ?? null,
});

let mismatches = 0;
for (let i = 0; i < corpus.cases.length; i++) {
  const c = corpus.cases[i];
  const got = canTransitionToVerified(c.cluster, { now: c.now, recentReportsSinceFix: c.recentReportsSinceFix });
  const want = reference[i].result;
  if (norm(got) !== norm(want)) {
    mismatches++;
    console.error(`[MISMATCH] ${c._name || c.cluster.clusterId}`);
    console.error(`   python: ${norm(want)}`);
    console.error(`   ts    : ${norm(got)}`);
  }
}

const total = corpus.cases.length;
if (mismatches === 0) {
  console.error(`[verify-parity] ✓ ${total}/${total} verification results match the reference can_transition_to_verified.`);
  process.exit(0);
} else {
  console.error(`[verify-parity] ✗ ${mismatches}/${total} mismatches — the TS port diverges from the reference.`);
  process.exit(1);
}
