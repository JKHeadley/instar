import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

interface LocalRoundDiagnostic {
  stderr: string;
  spawnError?: string;
}

function diagnosticPath(stateDir: string, projectId: string, roundIndex: number): string {
  const key = createHash('sha256').update(JSON.stringify([projectId, roundIndex])).digest('hex');
  return path.join(stateDir, 'logs', 'project-round-diagnostics', `${key}.json`);
}

/** One latest diagnostic per round on the machine that ran the child. */
export function writeProjectRoundDiagnostic(
  stateDir: string,
  projectId: string,
  roundIndex: number,
  diagnostic: LocalRoundDiagnostic,
): string {
  const file = diagnosticPath(stateDir, projectId, roundIndex);
  const ref = randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  SafeFsExecutor.atomicWriteJsonSync(file, { ref, ...diagnostic }, {
    operation: 'ProjectRoundDiagnostics.write',
    mode: 0o600,
  });
  return ref;
}

export function readProjectRoundDiagnostic(
  stateDir: string,
  projectId: string,
  roundIndex: number,
  ref: string | undefined,
): LocalRoundDiagnostic | undefined {
  if (!ref) return undefined;
  const file = diagnosticPath(stateDir, projectId, roundIndex);
  try {
    if (fs.statSync(file).size > 128 * 1024) return undefined;
    const local = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LocalRoundDiagnostic> & { ref?: string };
    if (local.ref !== ref || typeof local.stderr !== 'string') return undefined;
    return { stderr: local.stderr, spawnError: typeof local.spawnError === 'string' ? local.spawnError : undefined };
  } catch {
    return undefined; // This machine may not have run the round.
  }
}
