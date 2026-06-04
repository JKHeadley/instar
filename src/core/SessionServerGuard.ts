import fs from 'node:fs';
import path from 'node:path';
import { detectProjectDir } from './Config.js';

export interface SessionServerGuardDecision {
  reject: boolean;
  message?: string;
  detail?: string;
  supervisorHint?: string;
}

export interface SessionServerGuardInput {
  action: string;
  targetDir?: string;
  currentProjectDir?: string;
  sessionId?: string;
  uid?: number;
  projectName?: string;
}

function normalizeDir(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function defaultCurrentProjectDir(): string {
  const envDir = process.env.INSTAR_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR;
  return envDir ? normalizeDir(envDir) : normalizeDir(detectProjectDir());
}

function defaultSessionId(): string | undefined {
  return process.env.INSTAR_SESSION_ID || undefined;
}

function defaultUid(): number {
  return process.getuid?.() ?? 501;
}

function inferProjectName(dir: string, explicit?: string): string {
  return explicit || path.basename(dir);
}

export function shouldRejectServerLifecycleFromSession(
  input: SessionServerGuardInput
): SessionServerGuardDecision {
  const sessionId = input.sessionId ?? defaultSessionId();
  if (!sessionId) return { reject: false };

  const currentProjectDir = normalizeDir(input.currentProjectDir ?? defaultCurrentProjectDir());
  const targetDir = normalizeDir(input.targetDir ?? currentProjectDir);

  if (targetDir !== currentProjectDir) return { reject: false };

  const projectName = inferProjectName(currentProjectDir, input.projectName);
  const uid = input.uid ?? defaultUid();
  const supervisorHint = `launchctl kickstart -k gui/${uid}/ai.instar.${projectName}`;

  return {
    reject: true,
    message: `Cannot '${input.action}' for this agent from inside a session (session ${sessionId}).`,
    detail: 'The managing server owns this session. Restarting it from here can strand the conversation.',
    supervisorHint,
  };
}
