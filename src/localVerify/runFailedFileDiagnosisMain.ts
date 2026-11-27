/** Detached peer child for one advisory failed-file diagnosis. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDiagnosisPeerRequest } from './failedFileDiagnosisPeer.js';
import { realDiagnosisSeams } from './diagnosisSeams.js';
import { failedFileRunPaths, runFailedFileDiagnosis, type FailedFileRunInput, type FailedFileRunResult } from './runFailedFileDiagnosis.js';
import { computeVerifierVersion, installedVerifierDir } from './verifierVersion.js';

function argsOf(argv: readonly string[]): { input: string; result: string; token: string } | null {
  const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const input = get('--input'), result = get('--result'), token = get('--attempt-token');
  return input && result && token && /^[0-9a-f]{32}$/.test(token) ? { input, result, token } : null;
}

function writeResult(file: string, result: FailedFileRunResult | { kind: 'crash'; reason: string }): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = argsOf(argv);
  if (!args) return 2;
  // The peer persists intent before spawn. This child writes its own PID before
  // creating worktrees so a restart can recover the narrow spawn/PID gap.
  try { fs.writeFileSync(`${args.input}.pid`, String(process.pid), { mode: 0o600 }); }
  catch { return 2; }
  const ac = new AbortController();
  const abort = () => ac.abort();
  process.on('SIGTERM', abort);
  process.on('SIGINT', abort);
  const log = (event: Record<string, unknown>) => process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  try {
    const input = JSON.parse(fs.readFileSync(args.input, 'utf8')) as FailedFileRunInput;
    if (!input || !parseDiagnosisPeerRequest(input.request) || input.request.attemptId !== args.token
      || !Array.isArray(input.protectedList) || !input.protectedList.every((s) => typeof s === 'string')
      || !input.agentHome || !input.remoteUrl || !input.peerMachineId) throw new Error('invalid diagnosis input');
    const mine = computeVerifierVersion(installedVerifierDir(), undefined, { protectedList: input.protectedList });
    if (mine !== input.request.verifierVersion) throw new Error('verifier-mismatch');
    const paths = failedFileRunPaths(input.agentHome, args.token);
    const result = await runFailedFileDiagnosis(input, realDiagnosisSeams(log, paths.verifyRoot, paths.root, ac.signal));
    writeResult(args.result, result);
    return result.kind === 'done' ? 0 : 1;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log({ event: 'diagnosis-child-error', reason: reason.slice(0, 160) });
    try { writeResult(args.result, { kind: 'crash', reason: reason.slice(0, 160) }); } catch { /* missing result is also a crash */ }
    return 1;
  } finally {
    process.off('SIGTERM', abort);
    process.off('SIGINT', abort);
  }
}

const isEntry = (() => {
  try { return process.argv[1] ? fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) : false; } catch { return false; }
})();
if (isEntry) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
