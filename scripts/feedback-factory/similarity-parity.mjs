#!/usr/bin/env node
/**
 * similarity-parity.mjs — LOCAL parity gate for the Jaccard title-similarity port.
 *
 * Runs the REAL reference Python (`_jaccard_similarity` from
 * the-portal/.claude/scripts/feedback-processor.py) and the TS port over the
 * shared pairs corpus and asserts the similarity values match. Like the
 * fingerprint harness this is a LOCAL evidence gate, not a CI test (CI lacks the
 * reference checkout). Values should be bit-identical (same IEEE-754 division);
 * we allow a 1e-12 tolerance only to absorb float-string serialization, and we
 * ALSO assert the threshold decisions (≥0.35, ≥0.55) agree exactly — those are
 * what actually drive clustering.
 *
 * Reference path: PORTAL_PROCESSOR env, else the default the-portal checkout.
 * TS port is imported from the built dist (`npm run build` first).
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
const CORPUS = path.join(__dirname, 'similarity-corpus.json');
const PY_REF = path.join(__dirname, '_py_similarity_ref.py');
const EPS = 1e-12;

if (!fs.existsSync(PROCESSOR)) {
  console.error(`[sim-parity] reference processor not found: ${PROCESSOR}`);
  console.error('[sim-parity] set PORTAL_PROCESSOR to the reference feedback-processor.py');
  process.exit(2);
}

const py = spawnSync('python3', [PY_REF, PROCESSOR, CORPUS], { encoding: 'utf8' });
if (py.status !== 0) {
  console.error('[sim-parity] python reference failed:\n', py.stderr || py.stdout);
  process.exit(2);
}
const reference = JSON.parse(py.stdout);

const distUrl = new URL('file://' + path.join(ROOT, 'dist', 'feedback-factory', 'processor', 'similarity.js'));
const { jaccardSimilarity } = await import(distUrl.href);

const decide = (v) => (v >= 0.55 ? 'fixed-merge' : v >= 0.35 ? 'merge' : 'no-merge');

let mismatches = 0;
for (const ref of reference) {
  const pySim = Number(ref.sim);
  const tsSim = jaccardSimilarity(ref.a, ref.b);
  const valueOk = Math.abs(tsSim - pySim) < EPS;
  const decisionOk = decide(tsSim) === decide(pySim);
  if (!valueOk || !decisionOk) {
    mismatches++;
    console.error(`[MISMATCH] a=${JSON.stringify(ref.a)} b=${JSON.stringify(ref.b)}`);
    console.error(`           python=${pySim} (${decide(pySim)})  ts=${tsSim} (${decide(tsSim)})`);
  }
}

const total = reference.length;
if (mismatches === 0) {
  console.error(`[sim-parity] ✓ ${total}/${total} similarity values + threshold decisions match the reference Python.`);
  process.exit(0);
} else {
  console.error(`[sim-parity] ✗ ${mismatches}/${total} mismatches — the TS port diverges from the reference.`);
  process.exit(1);
}
