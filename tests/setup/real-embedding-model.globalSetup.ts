/** Prepare the real model once, before workers; never fetch from a suite hook. */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
import { analyzeVitestArgv } from '../../src/core/testRunnerRunClassifier.js';

export const REAL_MODEL_TESTS = [
  'tests/unit/vector-search.test.ts',
  'tests/integration/hybrid-search.test.ts',
  'tests/e2e/hybrid-search-lifecycle.test.ts',
];
export function needsEmbeddingModel(argv: string[]): boolean {
  const analysis = analyzeVitestArgv(argv);
  if (analysis.isList) return false;
  if (analysis.subcommand === 'related' || analysis.unknownFlags.some(flag => /^--(changed|related|shard)(=|$)/.test(flag))) return true;
  if (analysis.positionals.length === 0) return true;
  return analysis.positionals.some(filter => {
    if (/[*?\[\]{}]/.test(filter)) return true; // Conservative for glob selections.
    const normalized = path.isAbsolute(filter) ? path.relative(ROOT, filter) : filter.replace(/^\.\//, '');
    return REAL_MODEL_TESTS.some(file => file.includes(normalized.replaceAll('\\', '/')));
  });
}
export default async function setup(): Promise<void> {
  if (!needsEmbeddingModel(process.argv)) return;
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [fileURLToPath(new URL('./real-embedding-cache.mjs', import.meta.url)), '--prepare'], {
      // Download preparation has a separate finite budget. A failed acquisition
      // fails setup; it cannot turn native semantic assertions into skipped tests.
      timeout: 600_000, killSignal: 'SIGKILL', maxBuffer: 1_000_000,
    }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) reject(new Error(`Real embedding test-model preparation failed before workers: ${err.message}`));
      else resolve();
    });
  });
}
