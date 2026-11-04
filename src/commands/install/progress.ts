/**
 * The installer's completion ledger (spec install-experience 4.2).
 *
 * Lives at ~/.instar/state/install-progress.json because the first steps run before any agent
 * exists. A harness polls it, and `instar install --resume` continues from it. It records names
 * and step outcomes only: never a token, a link or a PIN.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WizardAnswers } from '../setup-wizard/state-machine.js';

export type InstallStatus = 'running' | 'needs-answers' | 'awaiting-person' | 'failed' | 'declined' | 'complete';

export interface InstallProgress {
  version: 1;
  installId: string;
  startedAt: string;
  updatedAt: string;
  status: InstallStatus;
  /** The state to run next. A state is only passed after it verified its own result. */
  cursor: string;
  answers: WizardAnswers;
  completed: Record<string, { at: string; note?: string }>;
  /** Set while status is awaiting-person. Plain words for the person, nothing secret. */
  awaiting?: { state: string; instruction: string; loginPid?: number; loginStamp?: string };
  /** Set while status is needs-answers: the answers-file field that is missing or refused. */
  needs?: { state: string; field: string; reason?: string };
  /** Set while status is failed. */
  failure?: { state: string; message: string; nextStep: string };
}

export function installProgressPath(home: string = os.homedir()): string {
  return path.join(home, '.instar', 'state', 'install-progress.json');
}

export function readInstallProgress(file: string): InstallProgress | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as InstallProgress;
  if (parsed?.version !== 1 || typeof parsed.cursor !== 'string') {
    throw new Error(`Unrecognized install progress file: ${file}`);
  }
  return parsed;
}

export function writeInstallProgress(file: string, progress: InstallProgress, now: Date = new Date()): void {
  progress.updatedAt = now.toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(progress, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function newInstallProgress(cursor: string, now: Date = new Date()): InstallProgress {
  const at = now.toISOString();
  return {
    version: 1,
    installId: randomUUID(),
    startedAt: at,
    updatedAt: at,
    status: 'running',
    cursor,
    answers: {},
    completed: {},
  };
}
