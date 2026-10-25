/**
 * Child-process entry for one local-verify run (spec local-verify-merge-authority.md §2).
 *
 *   node dist/localVerify/runVerifyMain.js --input <file> --result <file> --attempt-token <token>
 *
 * The service spawns this detached (its own process group) under `nice`, so a
 * server restart can never leave two verifies running: the in-flight record names
 * this group, and the attempt token on THIS argv is how the next boot corroborates
 * the group's identity before killing it. The result JSON is written atomically;
 * the service's completion path is the only thing that turns it into a record.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runVerify, verifyPaths, type VerifyRunInput, type VerifyRunResult } from './orchestrator.js';
import { realSeams } from './orchestratorSeams.js';
import { computeVerifierVersion, installedVerifierDir } from './verifierVersion.js';

export function parseMainArgs(argv: readonly string[]): { input: string; result: string; attemptToken: string } | null {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const input = get('--input');
  const result = get('--result');
  const attemptToken = get('--attempt-token');
  if (!input || !result || !attemptToken || !/^[0-9a-f]{16,64}$/.test(attemptToken)) return null;
  return { input, result, attemptToken };
}

function writeResult(file: string, result: VerifyRunResult | { kind: 'crash'; detail: string }): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The run child's own view of the verifier version: refuse when it differs from what the server passed. */
export function checkVerifierVersion(input: Pick<VerifyRunInput, 'verifierVersion' | 'protectedList'>, ownDir: string = installedVerifierDir()): { ok: true } | { ok: false; detail: string } {
  const mine = computeVerifierVersion(ownDir, undefined, { protectedList: input.protectedList });
  return mine === input.verifierVersion
    ? { ok: true }
    : { ok: false, detail: `verifier-mismatch: server ${input.verifierVersion}, child ${mine}` };
}

export async function main(argv: readonly string[], ownDir?: string): Promise<number> {
  const args = parseMainArgs(argv);
  if (!args) {
    process.stderr.write('usage: runVerifyMain --input <file> --result <file> --attempt-token <hex>\n');
    return 2;
  }
  const log = (event: Record<string, unknown>) => {
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  };
  try {
    const input = JSON.parse(fs.readFileSync(args.input, 'utf-8')) as VerifyRunInput;
    // The code on disk must be the code the server labels records with: an npm-replaced
    // dist under a still-running old server is refused, never recorded under the old version.
    const v = checkVerifierVersion(input, ownDir);
    if (!v.ok) {
      log({ event: 'verifier-mismatch', detail: v.detail });
      writeResult(args.result, { kind: 'crash', detail: v.detail });
      return 1;
    }
    const result = await runVerify(input, realSeams(log, verifyPaths(input.agentHome, input.headSha).verifyRoot));
    writeResult(args.result, result);
    return 0;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log({ event: 'crash', detail });
    try { writeResult(args.result, { kind: 'crash', detail: detail.slice(0, 500) }); } catch { /* @silent-fallback-ok: the service treats a missing result as a crash */ }
    return 1;
  }
}

const isEntry = (() => {
  try { return process.argv[1] ? fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) : false; } catch { return false; }
})();
if (isEntry) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
