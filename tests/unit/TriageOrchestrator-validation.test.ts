import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TriageOrchestrator, type TriageOrchestratorDeps } from '../../src/monitoring/TriageOrchestrator.js';

/**
 * TriageOrchestrator validation tests — deterministic action predicates.
 *
 * Tests the validateAction bug fix: auto_interrupt must be downgraded to
 * suggest_interrupt when no stuck process exists and the session is alive.
 * Tests are run through the public activate() method using the heuristic fast-path.
 */

function createMockTriageDeps(overrides: Partial<TriageOrchestratorDeps> = {}): TriageOrchestratorDeps {
  return {
    captureSessionOutput: vi.fn(() => ''),
    isSessionAlive: vi.fn(() => true),
    sendKey: vi.fn(() => true),
    sendInput: vi.fn(() => true),
    getTopicHistory: vi.fn(() => []),
    sendToTopic: vi.fn(async () => ({ messageId: 1 })),
    respawnSession: vi.fn(async () => {}),
    clearStallForTopic: vi.fn(),
    getStuckProcesses: vi.fn(async () => []),
    spawnTriageSession: vi.fn(async () => 'triage-1'),
    getTriageSessionUuid: vi.fn(() => undefined),
    killTriageSession: vi.fn(),
    scheduleFollowUpJob: vi.fn(() => 'job-1'),
    cancelJob: vi.fn(),
    injectMessage: vi.fn(),
    captureTriageOutput: vi.fn(() => null),
    isTriageSessionAlive: vi.fn(() => false),
    projectDir: '/tmp/test-project',
    ...overrides,
  };
}

describe('TriageOrchestrator validateAction', () => {
  let orchestrator: TriageOrchestrator;
  let deps: TriageOrchestratorDeps;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('auto_interrupt downgrade', () => {
    it('downgrades auto_interrupt to suggest_interrupt when no stuck process and session alive', async () => {
      deps = createMockTriageDeps({
        isSessionAlive: vi.fn(() => true),
        // "esc to interrupt" visible for 5 min triggers the stuck_on_tool heuristic
        // which suggests suggest_interrupt (not auto_interrupt).
        // To test validateAction, we need to trigger a path that produces auto_interrupt.
        // The heuristic patterns don't produce auto_interrupt for alive sessions.
        // Instead, test validateAction directly by accessing the private method.
        getStuckProcesses: vi.fn(async () => []),
      });

      orchestrator = new TriageOrchestrator(deps, {
        config: {
          heuristicFastPath: true,
          autoActionEnabled: true,
          autoInterruptRequiresStuckProcess: true,
        },
      });

      // Access validateAction directly since heuristics don't produce auto_interrupt for alive sessions
      const validateAction = (orchestrator as any).validateAction.bind(orchestrator);

      const decision = {
        classification: 'stuck_on_tool' as const,
        confidence: 0.9,
        summary: 'Stuck on tool',
        userMessage: 'Session stuck',
        action: 'auto_interrupt' as const,
        followUpMinutes: null,
        reasoning: 'test',
      };

      const evidence = {
        sessionAlive: true,
        tmuxOutput: '',
        processTree: [], // No stuck processes
        jsonlMtime: null,
        jsonlSize: null,
        pendingMessage: 'hello',
        pendingMessageAge: 10,
        recentMessages: [],
        sessionAge: 0,
        trigger: 'stall_detector' as const,
        checkCount: 1,
      };

      const result = validateAction(decision, evidence);
      expect(result).toBe('suggest_interrupt');
    });

    it('allows auto_interrupt when stuck process exists', async () => {
      deps = createMockTriageDeps({
        isSessionAlive: vi.fn(() => true),
        getStuckProcesses: vi.fn(async () => [
          { pid: 1234, command: 'npm test', elapsedMs: 600000 },
        ]),
      });

      orchestrator = new TriageOrchestrator(deps, {
        config: {
          heuristicFastPath: true,
          autoActionEnabled: true,
          autoInterruptRequiresStuckProcess: true,
        },
      });

      const validateAction = (orchestrator as any).validateAction.bind(orchestrator);

      const decision = {
        classification: 'stuck_on_tool' as const,
        confidence: 0.9,
        summary: 'Stuck on tool',
        userMessage: 'Session stuck',
        action: 'auto_interrupt' as const,
        followUpMinutes: null,
        reasoning: 'test',
      };

      const evidence = {
        sessionAlive: true,
        tmuxOutput: '',
        processTree: [{ pid: 1234, command: 'npm test', elapsedMs: 600000 }], // >5 min
        jsonlMtime: null,
        jsonlSize: null,
        pendingMessage: 'hello',
        pendingMessageAge: 10,
        recentMessages: [],
        sessionAge: 0,
        trigger: 'stall_detector' as const,
        checkCount: 1,
      };

      const result = validateAction(decision, evidence);
      expect(result).toBe('auto_interrupt');
    });

    it('allows auto_interrupt when session is dead (even without stuck process)', async () => {
      deps = createMockTriageDeps({
        isSessionAlive: vi.fn(() => false),
      });

      orchestrator = new TriageOrchestrator(deps, {
        config: {
          heuristicFastPath: true,
          autoActionEnabled: true,
          autoInterruptRequiresStuckProcess: true,
        },
      });

      const validateAction = (orchestrator as any).validateAction.bind(orchestrator);

      const decision = {
        classification: 'stuck_on_tool' as const,
        confidence: 0.9,
        summary: 'Stuck on tool',
        userMessage: 'Session stuck',
        action: 'auto_interrupt' as const,
        followUpMinutes: null,
        reasoning: 'test',
      };

      const evidence = {
        sessionAlive: false,
        tmuxOutput: '',
        processTree: [], // No stuck processes, but session is dead
        jsonlMtime: null,
        jsonlSize: null,
        pendingMessage: 'hello',
        pendingMessageAge: 10,
        recentMessages: [],
        sessionAge: 0,
        trigger: 'stall_detector' as const,
        checkCount: 1,
      };

      const result = validateAction(decision, evidence);
      expect(result).toBe('auto_interrupt');
    });
  });

  describe('auto_restart downgrade', () => {
    it('downgrades auto_restart to suggest_restart when session is alive', async () => {
      deps = createMockTriageDeps({
        isSessionAlive: vi.fn(() => true),
      });

      orchestrator = new TriageOrchestrator(deps, {
        config: {
          heuristicFastPath: true,
          autoActionEnabled: true,
          autoRestartRequiresDeadProcess: true,
        },
      });

      const validateAction = (orchestrator as any).validateAction.bind(orchestrator);

      const decision = {
        classification: 'crashed' as const,
        confidence: 0.9,
        summary: 'Crashed',
        userMessage: 'Session crashed',
        action: 'auto_restart' as const,
        followUpMinutes: null,
        reasoning: 'test',
      };

      const evidence = {
        sessionAlive: true, // Still alive — should downgrade
        tmuxOutput: '',
        processTree: [],
        jsonlMtime: null,
        jsonlSize: null,
        pendingMessage: '',
        pendingMessageAge: 0,
        recentMessages: [],
        sessionAge: 0,
        trigger: 'stall_detector' as const,
        checkCount: 1,
      };

      const result = validateAction(decision, evidence);
      expect(result).toBe('suggest_restart');
    });
  });

  describe('non-auto actions pass through', () => {
    it('returns the action unchanged for suggest_interrupt', async () => {
      deps = createMockTriageDeps();
      orchestrator = new TriageOrchestrator(deps, {
        config: { autoActionEnabled: true },
      });

      const validateAction = (orchestrator as any).validateAction.bind(orchestrator);

      const decision = {
        classification: 'stuck_on_tool' as const,
        confidence: 0.8,
        summary: 'test',
        userMessage: 'test',
        action: 'suggest_interrupt' as const,
        followUpMinutes: null,
        reasoning: 'test',
      };

      const evidence = {
        sessionAlive: true,
        tmuxOutput: '',
        processTree: [],
        jsonlMtime: null,
        jsonlSize: null,
        pendingMessage: '',
        pendingMessageAge: 0,
        recentMessages: [],
        sessionAge: 0,
        trigger: 'stall_detector' as const,
        checkCount: 1,
      };

      const result = validateAction(decision, evidence);
      expect(result).toBe('suggest_interrupt');
    });
  });

  describe('circuit breaker', () => {
    it('downgrades auto actions when autoActionEnabled is false', async () => {
      deps = createMockTriageDeps();
      orchestrator = new TriageOrchestrator(deps, {
        config: { autoActionEnabled: false },
      });

      const validateAction = (orchestrator as any).validateAction.bind(orchestrator);

      const decision = {
        classification: 'crashed' as const,
        confidence: 1.0,
        summary: 'Dead',
        userMessage: 'Session dead',
        action: 'auto_restart' as const,
        followUpMinutes: null,
        reasoning: 'test',
      };

      const evidence = {
        sessionAlive: false,
        tmuxOutput: '',
        processTree: [],
        jsonlMtime: null,
        jsonlSize: null,
        pendingMessage: '',
        pendingMessageAge: 0,
        recentMessages: [],
        sessionAge: 0,
        trigger: 'stall_detector' as const,
        checkCount: 1,
      };

      const result = validateAction(decision, evidence);
      expect(result).toBe('suggest_restart');
    });
  });
});
