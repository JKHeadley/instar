#!/usr/bin/env node
/**
 * transitions-parity.mjs — LOCAL parity gate for the lifecycle state-machine port.
 *
 * Runs the REAL reference Python (`can_transition` + `detect_cycling` from
 * the-portal/.claude/scripts/feedback-processor.py) and the TS port over the
 * shared corpus and asserts BOTH the `allowed` decision AND the `reason` string
 * match byte-for-byte (the reason interpolates Python's sorted-list repr, which
 * the port reproduces). LOCAL evidence gate, not CI (CI lacks the reference).
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
const CORPUS = path.join(__dirname, 'transitions-corpus.json');
const PY_REF = path.join(__dirname, '_py_transitions_ref.py');

if (!fs.existsSync(PROCESSOR)) {
  console.error(`[tx-parity] reference processor not found: ${PROCESSOR}`);
  console.error('[tx-parity] set PORTAL_PROCESSOR to the reference feedback-processor.py');
  process.exit(2);
}

const py = spawnSync('python3', [PY_REF, PROCESSOR, CORPUS], { encoding: 'utf8' });
if (py.status !== 0) {
  console.error('[tx-parity] python reference failed:\n', py.stderr || py.stdout);
  process.exit(2);
}
const reference = JSON.parse(py.stdout);

const distUrl = new URL('file://' + path.join(ROOT, 'dist', 'feedback-factory', 'processor', 'transitions.js'));
const { canTransition, detectCycling } = await import(distUrl.href);

let mismatches = 0;

for (const ref of reference.transitions) {
  const c = ref.case;
  const [allowed, reason] = canTransition(c.current, c.new, c.justification ?? null, c.context ?? null);
  if (allowed !== ref.allowed || reason !== ref.reason) {
    mismatches++;
    console.error(`[MISMATCH tx] ${JSON.stringify(c)}`);
    console.error(`   python: allowed=${ref.allowed} reason=${JSON.stringify(ref.reason)}`);
    console.error(`   ts    : allowed=${allowed} reason=${JSON.stringify(reason)}`);
  }
}

for (const ref of reference.cycling) {
  const got = detectCycling(ref.cluster);
  if (got !== ref.cycling) {
    mismatches++;
    console.error(`[MISMATCH cycling] ${JSON.stringify(ref.cluster)} — python=${ref.cycling} ts=${got}`);
  }
}

const total = reference.transitions.length + reference.cycling.length;
if (mismatches === 0) {
  console.error(`[tx-parity] ✓ ${total}/${total} transition decisions + reasons + cycling results match the reference Python.`);
  process.exit(0);
} else {
  console.error(`[tx-parity] ✗ ${mismatches}/${total} mismatches — the TS port diverges from the reference.`);
  process.exit(1);
}
