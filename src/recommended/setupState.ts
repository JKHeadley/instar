/**
 * What this machine knows about setting a service up (docs/specs/recommended-services.md, "per
 * machine: verified"). A login or install lives on one disk, so this is never replicated.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ServiceSetupState {
  verified?: { at: string; result: 'pass' | 'fail' | 'unknown'; detail: string };
  commitmentId?: string;
  /** The tmux session doing the work, and the conversation it talks to the person in. */
  sessionName?: string;
  topicId?: number;
  /** A check passed before any setup ran, so this machine already held what it checks. */
  alreadyHeld?: boolean;
  /** Bounded restarts, so a session that keeps dying ends in one notice rather than a loop. */
  attempts?: number;
  lastAttemptAt?: string;
  exhausted?: boolean;
  /** Ran a long while and stopped, most likely waiting on the person. Not restarted. */
  dormant?: boolean;
  /** The person stopped this, or said not now to something it needs. Only their next word brings it back. */
  held?: boolean;
  /** This key came from setup, so setup may correct it until it has passed. */
  keyStoredBySetup?: boolean;
}

export function setupStateFile(stateDir: string): string {
  return path.join(stateDir, 'state', 'recommended-service-setup', 'setup.json');
}

export function readSetupStates(stateDir: string): Record<string, ServiceSetupState> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(setupStateFile(stateDir), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, ServiceSetupState> : {};
  } catch {
    return {}; // @silent-fallback-ok — no file means nothing has been verified, which is what a reader assumes
  }
}

export function updateSetupState(stateDir: string, service: string, change: Partial<ServiceSetupState>): ServiceSetupState {
  const all = readSetupStates(stateDir);
  const next = { ...all[service], ...change };
  all[service] = next;
  const file = setupStateFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, file);
  return next;
}

/**
 * A person stopped this session on purpose, so if it was doing setup, setup must not restart it.
 * The topic matters because a reply brings a session back under a different name.
 */
export function holdSetupForSession(stateDir: string, sessionName: string, topicId?: number | null): void {
  for (const [service, state] of Object.entries(readSetupStates(stateDir))) {
    if (state.sessionName === sessionName || (topicId != null && state.topicId === topicId)) updateSetupState(stateDir, service, { held: true });
  }
}

/** "Kill all sessions" also covers a setup whose session is already dead and waiting to restart. */
export function holdAllSetups(stateDir: string): void {
  for (const [service, state] of Object.entries(readSetupStates(stateDir))) {
    if (state.verified?.result !== 'pass') updateSetupState(stateDir, service, { held: true });
  }
}
