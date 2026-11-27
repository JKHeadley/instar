import path from 'node:path';
import os from 'node:os';
import { vi } from 'vitest';
import { SessionManager } from '../../src/core/SessionManager.js';
import { PasteManager } from '../../src/paste/PasteManager.js';
import { createTempProject } from './setup.js';

export function notificationRefusalFixture() {
  const project = createTempProject();
  vi.spyOn(os, 'tmpdir').mockReturnValue(project.dir);
  const session = { id: 'fixture-id', name: 'fixture-session', tmuxSession: 'fixture-session',
    status: 'running' as const, startedAt: new Date().toISOString(), model: 'fixture', maxDurationMinutes: 30 };
  project.state.saveSession(session);
  const manager = new SessionManager({ tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/echo',
    projectDir: project.dir, maxSessions: 2, protectedSessions: [], completionPatterns: [] }, project.state);
  // Simulate the monitor's read-only cache, without querying any live terminal.
  vi.spyOn(manager, 'getCachedRunningSessions').mockReturnValue({ count: 1, sessions: [session] });
  const decision = { accepted: false };
  const inject = vi.spyOn(manager, 'injectMessage').mockImplementation(() => decision.accepted);
  const pasteManager = new PasteManager({ pasteDir: path.join(project.stateDir, 'paste'),
    stateDir: project.stateDir, projectDir: project.dir });
  return { project, manager, decision, inject, pasteManager,
    cleanup() { manager.stopMonitoring(); project.cleanup(); } };
}
