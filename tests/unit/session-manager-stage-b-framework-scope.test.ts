import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../../src/core/SessionManager.js';
import type { StageBActivationStatus } from '../../src/core/StageBActivationGate.js';
import { createTempProject, type TempProject } from '../helpers/setup.js';

const ACTIVE: StageBActivationStatus = {
  configured: true,
  pendingActivation: false,
  active: true,
  reason: 'candidate-canary',
  artifactDigest: null,
};

describe('SessionManager Stage-B framework scope', () => {
  let project: TempProject | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    project?.cleanup();
    project = undefined;
  });

  function managerFor(framework: 'claude-code' | null): SessionManager {
    project = createTempProject();
    const manager = new SessionManager({
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: project.dir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
    }, project.state, { stageBActivation: ACTIVE });
    const seams = manager as unknown as {
      getSessionFramework: () => 'claude-code' | null;
      performTmuxInjectionEffect: () => void;
      verifyInjection: () => void;
    };
    seams.getSessionFramework = () => framework;
    seams.performTmuxInjectionEffect = vi.fn();
    seams.verifyInjection = vi.fn();
    return manager;
  }

  it('keeps a known non-Codex session on the established injection path without creating an observerless row', () => {
    const manager = managerFor('claude-code');
    expect(manager.sendInput('known-claude-session', 'known non-Codex delivery')).toBe(true);
    const status = manager.inboundDeliveryStatus();
    if ('unavailable' in status) throw new Error('Stage B store unexpectedly unavailable');
    expect(status.logicalRows).toBe(0);
  });

  it('keeps an unknown-framework session on the established injection path without creating an observerless row', () => {
    const manager = managerFor(null);
    expect(manager.sendInput('legacy-unknown-session', 'unknown framework delivery')).toBe(true);
    const status = manager.inboundDeliveryStatus();
    if ('unavailable' in status) throw new Error('Stage B store unexpectedly unavailable');
    expect(status.logicalRows).toBe(0);
  });
});
