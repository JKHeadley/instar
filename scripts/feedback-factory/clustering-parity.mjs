#!/usr/bin/env node
/**
 * clustering-parity.mjs — LOCAL parity gate for the clustering driver port.
 *
 * Runs the REAL reference cmd_cluster (DB monkeypatched to a fixture) and the TS
 * clusterItems() over the same fixture, and asserts the per-item decisions match
 * exactly: action (merge/create), clusterId, rounded similarity, and the merge
 * note. LOCAL evidence gate, not CI (CI lacks the reference checkout).
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
const FIXTURE = path.join(__dirname, 'clustering-corpus.json');
const PY_REF = path.join(__dirname, '_py_clustering_ref.py');

if (!fs.existsSync(PROCESSOR)) {
  console.error(`[cluster-parity] reference processor not found: ${PROCESSOR}`);
  process.exit(2);
}

const py = spawnSync('python3', [PY_REF, PROCESSOR, FIXTURE], { encoding: 'utf8' });
if (py.status !== 0) {
  console.error('[cluster-parity] python reference failed:\n', py.stderr || py.stdout);
  process.exit(2);
}
const reference = JSON.parse(py.stdout);

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const distUrl = new URL('file://' + path.join(ROOT, 'dist', 'feedback-factory', 'processor', 'cluster.js'));
const { clusterItems } = await import(distUrl.href);
const got = clusterItems(fixture.items, fixture.clusters);

let mismatches = 0;
const norm = (r) => JSON.stringify({
  feedbackId: r.feedbackId, action: r.action, clusterId: r.clusterId,
  similarity: r.similarity, note: r.note ?? null,
});

if (got.length !== reference.length) {
  console.error(`[cluster-parity] length mismatch: ts=${got.length} python=${reference.length}`);
  mismatches++;
}
for (let i = 0; i < Math.max(got.length, reference.length); i++) {
  const a = got[i] ? norm(got[i]) : '(missing)';
  const b = reference[i] ? norm(reference[i]) : '(missing)';
  if (a !== b) {
    mismatches++;
    console.error(`[MISMATCH #${i}]`);
    console.error(`   python: ${b}`);
    console.error(`   ts    : ${a}`);
  }
}

const total = reference.length;
if (mismatches === 0) {
  console.error(`[cluster-parity] ✓ ${total}/${total} clustering decisions match the reference cmd_cluster.`);
  process.exit(0);
} else {
  console.error(`[cluster-parity] ✗ ${mismatches} mismatch(es) — the TS port diverges from the reference.`);
  process.exit(1);
}
