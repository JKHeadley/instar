/**
 * integrityPassRunner.ts — the REAL pre-click import-integrity pass that greens the
 * cutover door's INTEGRITY leg (spec §2.4; feedback-factory-migration.md §2.5).
 *
 * Runs the canonical pipeline — HttpParitySource captureRaw (read-only GET
 * /api/instar/read) → runImport into a PERSISTED shadow target → the pure integrity
 * gate over the readback — and returns the IntegrityReport verdict. The caller
 * (AgentServer) feeds a PASSING report to `CutoverReadiness.recordIntegrityReport()`.
 *
 * Why this is a standalone module with a CLI entry (not an in-process closure like
 * runParityCheck): the full 145K-row captureRaw fetch + import cannot settle inside
 * the server's single-flight budget when run IN the event loop — that is exactly why
 * the in-process import-dryrun budget-fails at 720s (#948), and why the parity-pass
 * had to drop to clustersOnly (#1007). The heavy pass belongs OFF the event loop, so
 * AgentServer spawns this module as a child `node` process. Exporting the logic as a
 * function ALSO keeps it unit-testable against an injected source.
 */
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runImport, type ImportRunResult } from './importRunner.js';
import { PersistedShadowImportTarget } from './PersistedShadowImportTarget.js';
import { HttpParitySource } from '../dryrun/HttpParitySource.js';

/** What the pass returns (and prints as stdout JSON in CLI mode). */
export interface IntegrityPassResult {
  passed: boolean;
  imported: ImportRunResult['imported'];
  abortedPreImport: ImportRunResult['abortedPreImport'];
  report: ImportRunResult['report'];
  fetchSeconds: number;
  importSeconds: number;
}

/** The minimal source contract the pass consumes — lets tests inject a fake. */
export interface RawCorpusSource {
  prepare(): Promise<void>;
  readRawClusters(): Record<string, unknown>[];
  readRawFeedback(): Record<string, unknown>[];
}

/**
 * Run the AS-IS import of `source`'s corpus into a persisted shadow under `shadowDir`,
 * then the integrity gate over the readback. The shadow dir is removed afterward unless
 * `keepShadow`. Pure w.r.t. canonical state — the shadow is a verification target only.
 */
export async function runIntegrityPass(
  source: RawCorpusSource,
  shadowDir: string,
  opts: { keepShadow?: boolean; now?: () => number } = {},
): Promise<IntegrityPassResult> {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const target = new PersistedShadowImportTarget(shadowDir);
  try {
    await source.prepare();
    const clusters = source.readRawClusters();
    const feedback = source.readRawFeedback();
    const tFetch = now();
    const result = runImport({ clusters, feedback }, target);
    const tDone = now();
    return {
      passed: result.passed,
      imported: result.imported,
      abortedPreImport: result.abortedPreImport,
      report: result.report,
      fetchSeconds: Number(((tFetch - t0) / 1000).toFixed(1)),
      importSeconds: Number(((tDone - tFetch) / 1000).toFixed(1)),
    };
  } finally {
    if (!opts.keepShadow) target.dispose();
  }
}

/** CLI entry: env-driven, prints the verdict JSON to stdout. Used by AgentServer's child spawn. */
async function main(): Promise<void> {
  const token = process.env.TOKEN;
  if (!token) {
    console.error('FATAL: TOKEN env required (instar:read scope)');
    process.exit(2);
  }
  const baseUrl = process.env.BASE_URL || 'https://dawn.bot-me.ai';
  const shadowDir = process.env.SHADOW_DIR || join(tmpdir(), `cutover-integrity-shadow-${process.pid}`);
  const keepShadow = process.env.KEEP_SHADOW === '1';

  const source = new HttpParitySource({
    baseUrl,
    token,
    captureRaw: true,
    pageTimeoutMs: 120_000,
    // Stay UNDER CutoverReadiness's 12-min single-flight max-hold backstop so the
    // child self-exits before the in-process guard fires (measured pass ~2.7min).
    totalTimeoutMs: 600_000,
  });
  console.error(`[integrity-pass] fetching corpus from ${baseUrl}/api/instar/read (captureRaw) → shadow ${shadowDir} ...`);
  const out = await runIntegrityPass(source, shadowDir, { keepShadow });
  console.error(`[integrity-pass] fetch ${out.fetchSeconds}s + import/integrity ${out.importSeconds}s → passed=${out.passed}`);
  console.log(JSON.stringify(out));
  process.exit(out.passed ? 0 : 1);
}

// Direct-run detection (ESM): run main() only when invoked as a script, not when imported.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
