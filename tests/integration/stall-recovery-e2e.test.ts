/**
 * Stall Recovery E2E Tests
 *
 * End-to-end lifecycle tests for stall detection and recovery.
 * Simulates the full path: message injected -> session stalls ->
 * nurse triggers -> diagnosis -> escalation -> recovery/failure.
 *
 * Uses controlled mocks for tmux and Telegram (no real network),
 * but wires components together using the real wiring pattern from server.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StallTriageNurse } from '../../src/monitoring/StallTriageNurse.js';
import type { TriageDeps } from '../../src/monitoring/StallTriageNurse.types.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';

// ─── Test Infrastructure ──────────────────────────────────

interface SimulatedSession {
  name: string;
  alive: boolean;
  output: string;
  topicId: number;
}

interface SimulatedTelegram {
  sentMessages: Array<{ topicId: number; text: string }>;
  pendingMessages: Map<string, { topicId: number; sessionName: string; injectedAt: number; alerted: boolean }>;
  topicSessions: Map<number, string>;
}

/**
 * Creates a controlled test environment that simulates the real
 * Telegram + SessionManager + StallTriageNurse interaction.
 */
function createTestEnvironment(opts?: {
  intelligenceResponses?: string[];
  sessions?: SimulatedSession[];
}) {
  // Simulated session state
  const sessions = new Map<string, SimulatedSession>();
  for (const s of opts?.sessions ?? []) {
    sessions.set(s.name, { ...s });
  }

  // Simulated Telegram state
  const telegram: SimulatedTelegram = {
    sentMessages: [],
    pendingMessages: new Map(),
    topicSessions: new Map(),
  };

  // Track all respawn calls
  const respawnCalls: Array<{ name: string; topicId: number }> = [];

  // Intelligence provider with queued responses
  const responseQueue = [...(opts?.intelligenceResponses ?? [])];
  const intelligence: IntelligenceProvider = {
    evaluate: vi.fn(async () => {
      if (responseQueue.length > 0) {
        return responseQueue.shift()!;
      }
      return JSON.stringify({
        summary: 'Default diagnosis',
        action: 'nudge',
        confidence: 'medium',
        userMessage: 'Trying to nudge the session...',
      });
    }),
  };

  // Build TriageDeps using the same pattern as server.ts
  const deps: TriageDeps = {
    captureSessionOutput: vi.fn((name: string, _lines: number) => {
      const session = sessions.get(name);
      if (!session) return null;
      return session.output;
    }),

    isSessionAlive: vi.fn((name: string) => {
      const session = sessions.get(name);
      return session?.alive ?? false;
    }),

    sendKey: vi.fn((name: string, key: string) => {
      const session = sessions.get(name);
      if (!session?.alive) return false;
      // Simulate key effects
      if (key === 'Escape') {
        session.output += '\n^[';
      } else if (key === 'C-c') {
        session.output += '\n^C';
      }
      return true;
    }),

    sendInput: vi.fn((name: string, text: string) => {
      const session = sessions.get(name);
      if (!session?.alive) return false;
      session.output += `\n${text}`;
      return true;
    }),

    getTopicHistory: vi.fn((_topicId: number, _limit: number) => []),

    sendToTopic: vi.fn(async (topicId: number, text: string) => {
      telegram.sentMessages.push({ topicId, text });
    }),

    respawnSession: vi.fn(async (name: string, topicId: number) => {
      respawnCalls.push({ name, topicId });
      // Simulate respawn: create a new alive session
      sessions.set(name, {
        name,
        alive: true,
        output: 'Mock Claude session started\nReady.',
        topicId,
      });
      telegram.topicSessions.set(topicId, name);
    }),

    clearStallForTopic: vi.fn((topicId: number) => {
      for (const [key, pending] of telegram.pendingMessages) {
        if (pending.topicId === topicId) {
          telegram.pendingMessages.delete(key);
        }
      }
    }),
  };

  return {
    sessions,
    telegram,
    respawnCalls,
    intelligence,
    deps,

    // Helper to mutate session state mid-test (simulating recovery)
    simulateSessionRecovery(name: string) {
      const session = sessions.get(name);
      if (session) {
        session.output += '\nRead tool completed\nWrite tool completed\ntelegram-reply sent';
        session.alive = true;
      }
    },

    simulateSessionDeath(name: string) {
      const session = sessions.get(name);
      if (session) {
        session.alive = false;
        session.output = '';
      }
    },

    getMessagesForTopic(topicId: number) {
      return telegram.sentMessages.filter(m => m.topicId === topicId);
    },
  };
}

// ─── Tests ──────────────────────────────────────────────

describe('Stall Recovery E2E', () => {
  let project: TempProject;

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
    vi.restoreAllMocks();
  });

  // ─── Scenario 1: Dead Session ──────────────────────────

  describe('dead session recovery', () => {
    it('detects dead session, skips LLM, and restarts quietly', async () => {
      const env = createTestEnvironment({
        sessions: [{
          name: 'test-session',
          alive: false, // dead
          output: '',
          topicId: 1,
        }],
      });

      // Add a pending stall message
      env.telegram.pendingMessages.set('msg-1', {
        topicId: 1,
        sessionName: 'test-session',
        injectedAt: Date.now() - 600000, // 10 min ago
        alerted: false,
      });

      const nurse = new StallTriageNurse(env.deps, {
        config: { enabled: true, verifyDelayMs: 0, maxEscalations: 2 },
        intelligence: env.intelligence,
        state: project.state,
      });

      const result = await nurse.triage(1, 'test-session', 'hello', Date.now() - 600000);

      // Dead session should short-circuit to restart without LLM
      expect(env.intelligence.evaluate).not.toHaveBeenCalled();
      expect(result.resolved).toBe(true);
      expect(result.actionsTaken).toEqual(['restart']);
      expect(result.diagnosis?.action).toBe('restart');
      expect(result.diagnosis?.confidence).toBe('high');

      // Recovery is automatic; this path must not announce a stopped session.
      expect(env.getMessagesForTopic(1)).toHaveLength(0);

      // Session was respawned
      expect(env.respawnCalls).toHaveLength(1);
      expect(env.respawnCalls[0]).toEqual({ name: 'test-session', topicId: 1 });

      // Stall tracking was cleared
      expect(env.deps.clearStallForTopic).toHaveBeenCalledWith(1);
      expect(env.telegram.pendingMessages.size).toBe(0);
    });
  });

  // ─── Scenario 2: Alive Session, Diagnosed Working ─────

  describe('alive session diagnosed as working', () => {
    it('sends status update to user without intervening', async () => {
      const env = createTestEnvironment({
        sessions: [{
          name: 'busy-session',
          alive: true,
          output: 'Read tool output...\nprocessing files...\nthinking...',
          topicId: 2,
        }],
        intelligenceResponses: [JSON.stringify({
          summary: 'Session is actively processing a build',
          action: 'status_update',
          confidence: 'high',
          userMessage: 'The session is busy building your project. Should be done soon!',
        })],
      });

      const nurse = new StallTriageNurse(env.deps, {
        config: { enabled: true, verifyDelayMs: 0 },
        intelligence: env.intelligence,
        state: project.state,
      });

      const result = await nurse.triage(2, 'busy-session', 'status?', Date.now() - 300000);

      expect(result.resolved).toBe(true);
      expect(result.actionsTaken).toEqual(['status_update']);

      // User got an informative message
      const userMessages = env.getMessagesForTopic(2);
      expect(userMessages.length).toBeGreaterThanOrEqual(1);
      expect(userMessages[0].text).toContain('busy building');

      // No intervention happened
      expect(env.deps.sendKey).not.toHaveBeenCalled();
      expect(env.deps.sendInput).not.toHaveBeenCalled();
      expect(env.deps.respawnSession).not.toHaveBeenCalled();
    });
  });

  // ─── Scenario 3: Nudge Recovers ──────────────────────

  describe('nudge recovers stalled session', () => {
    it('nudges session, session recovers, user notified', async () => {
      const env = createTestEnvironment({
        sessions: [{
          name: 'idle-session',
          alive: true,
          output: 'Waiting for input...',
          topicId: 3,
        }],
        intelligenceResponses: [JSON.stringify({
          summary: 'Session idle at prompt',
          action: 'nudge',
          confidence: 'high',
          userMessage: 'Nudging the session...',
        })],
      });

      const nurse = new StallTriageNurse(env.deps, {
        config: { enabled: true, verifyDelayMs: 0, maxEscalations: 2 },
        intelligence: env.intelligence,
        state: project.state,
      });

      // After the nudge is sent, simulate recovery by changing output significantly
      // The verification check happens after executeAction, so we need to intercept
      // the second captureSessionOutput call
      let captureCallCount = 0;
      (env.deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
        captureCallCount++;
        if (captureCallCount <= 1) return 'Waiting for input...'; // gatherContext
        // After nudge: show new tool call activity (Read( and Write( patterns)
        return 'Waiting for input...\nRead(config.json) output: scanning files...\nWrite(config.json) completed: updated settings';
      });

      const result = await nurse.triage(3, 'idle-session', 'hello?', Date.now() - 300000);

      expect(result.resolved).toBe(true);
      expect(result.actionsTaken).toEqual(['nudge']);
      expect(env.deps.sendInput).toHaveBeenCalledWith('idle-session', '');
      expect(env.deps.clearStallForTopic).toHaveBeenCalledWith(3);
    });
  });

  // ─── Scenario 4: Escalation Chain ─────────────────────

  describe('escalation from nudge to interrupt to unstick', () => {
    it('escalates through actions until one works', async () => {
      const env = createTestEnvironment({
        sessions: [{
          name: 'stuck-session',
          alive: true,
          output: 'Hanging on network call...',
          topicId: 4,
        }],
        intelligenceResponses: [JSON.stringify({
          summary: 'Session might need a nudge',
          action: 'nudge',
          confidence: 'medium',
          userMessage: 'Trying to nudge...',
        })],
      });

      const nurse = new StallTriageNurse(env.deps, {
        config: { enabled: true, verifyDelayMs: 0, maxEscalations: 2 },
        intelligence: env.intelligence,
        state: project.state,
      });

      // Simulate: nudge and interrupt fail, unstick succeeds
      // Verification requires work indicators or 100+ char growth
      let captureCallCount = 0;
      (env.deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        captureCallCount++;
        if (captureCallCount <= 5) return 'Hanging on network call...'; // same = verification fails
        // After unstick: show new tool call activity (Bash( pattern)
        return 'Hanging on network call...\n^C\nBash(npm test) passed with all checks green';
      });

      const result = await nurse.triage(4, 'stuck-session', 'hello?', Date.now() - 600000);

      expect(result.resolved).toBe(true);
      expect(result.actionsTaken).toEqual(['nudge', 'interrupt', 'unstick']);

      // User received escalation messages
      const userMessages = env.getMessagesForTopic(4);
      expect(userMessages.length).toBeGreaterThanOrEqual(3); // nudge + interrupt + unstick messages
    });
  });

  // ─── Scenario 5: All Escalations Fail ─────────────────

  describe('all escalations exhausted', () => {
    it('force-restarts after exhausting escalations, notifies user on failure', async () => {
      const env = createTestEnvironment({
        sessions: [{
          name: 'hopeless-session',
          alive: true,
          output: 'Completely frozen',
          topicId: 5,
        }],
        intelligenceResponses: [JSON.stringify({
          summary: 'Session unresponsive',
          action: 'nudge',
          confidence: 'low',
          userMessage: 'Trying to nudge...',
        })],
      });

      const nurse = new StallTriageNurse(env.deps, {
        config: { enabled: true, verifyDelayMs: 0, maxEscalations: 2 },
        intelligence: env.intelligence,
        state: project.state,
      });

      // All verifications fail (output never changes)
      (env.deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue('Completely frozen');

      // After force-restart, session is still dead
      (env.deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)    // gatherContext: alive
        .mockReturnValueOnce(false);  // verify force-restart: still dead

      const result = await nurse.triage(5, 'hopeless-session', 'help?', Date.now() - 600000);

      expect(result.resolved).toBe(false);
      expect(result.fallbackReason).toBe('max_escalations_reached');
      // Should have tried: nudge -> interrupt -> unstick -> force restart
      expect(result.actionsTaken).toContain('nudge');
      expect(result.actionsTaken).toContain('restart');

      // Earlier intervention updates can exist, but triage must not issue
      // the final recovery-failure notice owned by SessionMonitor.
      expect(env.getMessagesForTopic(5).some(m => m.text.includes("wasn't able to recover"))).toBe(false);
    });
  });

  // ─── Scenario 6: Cooldown Prevents Spam ───────────────

  describe('cooldown prevents rapid re-triage', () => {
    it('blocks triage during cooldown period', async () => {
      const env = createTestEnvironment({
        sessions: [{
          name: 'session-1',
          alive: false,
          output: '',
          topicId: 6,
        }],
      });

      const nurse = new StallTriageNurse(env.deps, {
        config: { enabled: true, verifyDelayMs: 0, cooldownMs: 60000 },
        intelligence: env.intelligence,
        state: project.state,
      });

      // First triage: dead session, restarts
      const first = await nurse.triage(6, 'session-1', 'hello', Date.now());
      expect(first.resolved).toBe(true);

      // Second triage: blocked by cooldown
      const second = await nurse.triage(6, 'session-1', 'hello again', Date.now());
      expect(second.resolved).toBe(false);
      expect(second.fallbackReason).toBe('cooldown_active');
      expect(second.actionsTaken).toEqual([]);
    });
  });

  // ─── Scenario 7: Concurrent Triage Protection ─────────

  describe('concurrent triage protection', () => {
    it('blocks concurrent triage on same topic', async () => {
      const env = createTestEnvironment({
        sessions: [{
          name: 'slow-session',
          alive: true,
          output: 'processing...',
          topicId: 7,
        }],
      });

      // Make intelligence take a while to respond
      let resolveEvaluate: (value: string) => void;
      const slowPromise = new Promise<string>((resolve) => {
        resolveEvaluate = resolve;
      });
      (env.intelligence.evaluate as ReturnType<typeof vi.fn>).mockReturnValueOnce(slowPromise);

      const nurse = new StallTriageNurse(env.deps, {
        config: { enabled: true, verifyDelayMs: 0 },
        intelligence: env.intelligence,
        state: project.state,
      });

      // Start first triage (will hang at diagnose)
      const firstPromise = nurse.triage(7, 'slow-session', 'msg1', Date.now());

      // Second triage on same topic should be blocked
      const second = await nurse.triage(7, 'slow-session', 'msg2', Date.now());
      expect(second.resolved).toBe(false);
      expect(second.fallbackReason).toBe('already_triaging');

      // Resolve first triage
      resolveEvaluate!(JSON.stringify({
        summary: 'working', action: 'status_update', confidence: 'high', userMessage: 'busy',
      }));
      const first = await firstPromise;
      expect(first.resolved).toBe(true);
    });
  });

  // ─── Scenario 8: Events Fire in Correct Order ─────────

  describe('lifecycle events', () => {
    it('emits events in correct order: started -> diagnosed -> treated -> resolved', async () => {
      const env = createTestEnvironment({
        sessions: [{
          name: 'event-session',
          alive: true,
          output: 'working...',
          topicId: 8,
        }],
        intelligenceResponses: [JSON.stringify({
          summary: 'active', action: 'status_update', confidence: 'high', userMessage: 'All good',
        })],
      });

      const nurse = new StallTriageNurse(env.deps, {
        config: { enabled: true, verifyDelayMs: 0 },
        intelligence: env.intelligence,
        state: project.state,
      });

      const events: string[] = [];
      nurse.on('triage:started', () => events.push('started'));
      nurse.on('triage:diagnosed', () => events.push('diagnosed'));
      nurse.on('triage:treated', () => events.push('treated'));
      nurse.on('triage:resolved', () => events.push('resolved'));
      nurse.on('triage:failed', () => events.push('failed'));
      nurse.on('triage:escalated', () => events.push('escalated'));

      await nurse.triage(8, 'event-session', 'hello', Date.now());

      expect(events).toEqual(['started', 'diagnosed', 'treated', 'resolved']);
    });

    it('emits escalation events during escalation chain', async () => {
      const env = createTestEnvironment({
        sessions: [{
          name: 'escalation-session',
          alive: true,
          output: 'stuck...',
          topicId: 9,
        }],
        intelligenceResponses: [JSON.stringify({
          summary: 'stuck', action: 'nudge', confidence: 'medium', userMessage: 'nudging',
        })],
      });

      const nurse = new StallTriageNurse(env.deps, {
        config: { enabled: true, verifyDelayMs: 0, maxEscalations: 1 },
        intelligence: env.intelligence,
        state: project.state,
      });

      // Output never changes = all verifications fail
      (env.deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue('stuck...');
      // Force-restart also fails
      (env.deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)    // gatherContext
        .mockReturnValueOnce(false);  // force-restart verify

      const escalations: Array<{ from: string; to: string }> = [];
      nurse.on('triage:escalated', (data) => {
        escalations.push({ from: data.from, to: data.to });
      });

      await nurse.triage(9, 'escalation-session', 'help', Date.now());

      expect(escalations).toHaveLength(1);
      expect(escalations[0]).toEqual({ from: 'nudge', to: 'interrupt' });
    });
  });

  // ─── Scenario 9: History Persistence ──────────────────

  describe('history persists across triage calls', () => {
    it('records each triage result in history', async () => {
      const env = createTestEnvironment({
        sessions: [
          { name: 'sess-a', alive: false, output: '', topicId: 10 },
          { name: 'sess-b', alive: false, output: '', topicId: 11 },
        ],
      });

      const nurse = new StallTriageNurse(env.deps, {
        config: { enabled: true, verifyDelayMs: 0, cooldownMs: 0 },
        intelligence: env.intelligence,
        state: project.state,
      });

      await nurse.triage(10, 'sess-a', 'msg1', Date.now());
      await nurse.triage(11, 'sess-b', 'msg2', Date.now());

      const history = nurse.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].topicId).toBe(10);
      expect(history[1].topicId).toBe(11);

      const status = nurse.getStatus();
      expect(status.historyCount).toBe(2);
    });
  });

  // ─── Scenario 10: LLM Error Falls Back to Heuristic ──

  describe('LLM error fallback', () => {
    it('uses heuristic when LLM fails, with context-aware action selection', async () => {
      const env = createTestEnvironment({
        sessions: [{
          name: 'errored-session',
          alive: true,
          output: 'SIGTERM received\nProcess exited with error code 1',
          topicId: 12,
        }],
      });

      // LLM will fail
      (env.intelligence.evaluate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API down'));

      const nurse = new StallTriageNurse(env.deps, {
        config: { enabled: true, verifyDelayMs: 0, useIntelligenceProvider: true },
        intelligence: env.intelligence,
        state: project.state,
      });

      const result = await nurse.triage(12, 'errored-session', 'hello', Date.now() - 300000);

      // LLM failed, so heuristic kicks in
      // Output contains 'SIGTERM' and 'exited' -> heuristic should choose restart
      expect(result.diagnosis).not.toBeNull();
      expect(result.diagnosis!.confidence).toBe('low');

      // The heuristic should detect error indicators in the output
      // and choose restart instead of defaulting to nudge
      expect(result.diagnosis!.action).toBe('restart');
    });

    it('heuristic chooses interrupt for long-wait alive sessions', async () => {
      const env = createTestEnvironment({
        sessions: [{
          name: 'long-wait-session',
          alive: true,
          output: 'waiting for something...',
          topicId: 13,
        }],
      });

      (env.intelligence.evaluate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API down'));

      const nurse = new StallTriageNurse(env.deps, {
        config: { enabled: true, verifyDelayMs: 0, useIntelligenceProvider: true },
        intelligence: env.intelligence,
        state: project.state,
      });

      // Injected 6 minutes ago (>= 5 min threshold)
      const result = await nurse.triage(13, 'long-wait-session', 'hello', Date.now() - 360000);

      // Heuristic: alive + 5+ min wait = interrupt (not default nudge)
      expect(result.diagnosis!.action).toBe('interrupt');
      expect(result.diagnosis!.confidence).toBe('low');
    });
  });
});
