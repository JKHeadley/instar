/**
 * Where a test writes debugging evidence: phase logs, wire captures, proof reports.
 *
 * Tests used to write these into the repository's git-ignored `.instar/state/build`,
 * which exists only on a machine that has run /build, so on a clean checkout the
 * writes failed with ENOENT.
 *
 * - Default: one temporary folder per test file, made on first use and removed after
 *   the file's last test. It lives for the whole file on purpose: a fixture or a
 *   wrapper can still write evidence after the test that set it up has finished.
 * - `INSTAR_TEST_EVIDENCE_DIR=<folder>`: write there instead and keep it, for runs
 *   (such as the opt-in scale proofs) whose reports someone wants to read afterwards.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string | null = null;
let kept = false;

export function testEvidenceDir(): string {
  if (dir) return dir;
  const keep = process.env.INSTAR_TEST_EVIDENCE_DIR;
  if (keep) {
    dir = path.resolve(keep);
    fs.mkdirSync(dir, { recursive: true });
    kept = true;
  } else {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-test-evidence-'));
    kept = false;
  }
  return dir;
}

afterAll(() => {
  if (dir && !kept) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/helpers/test-evidence-dir.ts' });
  dir = null;
});
