#!/usr/bin/env node
/**
 * fingerprint-parity.mjs — LOCAL parity gate for the feedback fingerprint port.
 *
 * Runs the REAL reference Python (the-portal/.claude/scripts/feedback-processor.py
 * compute_fingerprint) and the TS port over the shared corpus and asserts every
 * fingerprint is byte-identical. This is the empirical equivalence gate the spec
 * requires — it is intentionally NOT a CI test (CI doesn't have the reference
 * checkout); it is run locally and its output recorded as evidence, and re-run
 * whenever the port's regexes/normalization change.
 *
 * Reference path is configurable: PORTAL_PROCESSOR env var, else the default
 * the-portal checkout. The TS port is imported from the built dist (run
 * `npm run build` first).
 *
 * Exit 0 = 100% parity; exit 1 = at least one mismatch (printed).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const PROCESSOR = process.env.PORTAL_PROCESSOR
  || '/Users/justin/Documents/Projects/the-portal/.claude/scripts/feedback-processor.py';
const CORPUS = path.join(__dirname, 'fingerprint-corpus.json');
const PY_REF = path.join(__dirname, '_py_fingerprint_ref.py');

if (!fs.existsSync(PROCESSOR)) {
  console.error(`[parity] reference processor not found: ${PROCESSOR}`);
  console.error('[parity] set PORTAL_PROCESSOR to the reference feedback-processor.py');
  process.exit(2);
}

// Reference fingerprints from the real Python.
const py = spawnSync('python3', [PY_REF, PROCESSOR, CORPUS], { encoding: 'utf8' });
if (py.status !== 0) {
  console.error('[parity] python reference failed:\n', py.stderr || py.stdout);
  process.exit(2);
}
const reference = JSON.parse(py.stdout);

// TS port from the built dist.
const distUrl = new URL('file://' + path.join(ROOT, 'dist', 'feedback-factory', 'processor', 'fingerprint.js'));
const { computeFingerprint } = await import(distUrl.href);

let mismatches = 0;
for (const ref of reference) {
  const got = computeFingerprint(ref.type, ref.title, ref.component);
  const ok = got === ref.fp;
  if (!ok) {
    mismatches++;
    console.error(`[MISMATCH] type=${JSON.stringify(ref.type)} title=${JSON.stringify(ref.title)} component=${JSON.stringify(ref.component)}`);
    console.error(`           python=${ref.fp}`);
    console.error(`           ts    =${got}`);
  }
}

const total = reference.length;
if (mismatches === 0) {
  console.error(`[parity] ✓ ${total}/${total} fingerprints byte-identical to the reference Python.`);
  process.exit(0);
} else {
  console.error(`[parity] ✗ ${mismatches}/${total} mismatches — the TS port diverges from the reference.`);
  process.exit(1);
}
