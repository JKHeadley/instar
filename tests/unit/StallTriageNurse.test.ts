import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StallTriageNurse } from '../../src/monitoring/StallTriageNurse.js';
import type {
  TriageDeps,
  StallTriageConfig,
  TriageResult,
  TreatmentAction,
  TriageContext,
  TriageDiagnosis,
} from '../../src/monitoring/StallTriageNurse.types.js';

// ─── Test Helpers ──────────────────────────────────────────

function createMockDeps(): TriageDeps {
  return {
    captureSessionOutput: vi.fn().mockReturnValue('some output'),
    isSessionAlive: vi.fn().mockReturnValue(true),
    sendKey: vi.fn().mockReturnValue(true),
    sendInput: vi.fn().mockReturnValue(true),
    getTopicHistory: vi.fn().mockReturnValue([]),
    sendToTopic: vi.fn().mockResolvedValue({}),
    respawnSession: vi.fn().mockResolvedValue(undefined),
    clearStallForTopic: vi.fn(),
  };
}

const VALID_DIAGNOSIS_JSON = JSON.stringify({
  summary: 'Session is processing a long build',
  action: 'status_update',
  confidence: 'high',
  userMessage: 'The session is busy building. Hang tight!',
});

const NUDGE_DIAGNOSIS_JSON = JSON.stringify({
  summary: 'Session idle at prompt',
  action: 'nudge',
  confidence: 'high',
  userMessage: 'Nudging the session...',
});

function createMockIntelligence(response: string = VALID_DIAGNOSIS_JSON) {
  return {
    evaluate: vi.fn().mockResolvedValue(response),
  };
}

function createMockState(initial: any = null) {
  return {
    get: vi.fn().mockReturnValue(initial),
    set: vi.fn(),
  };
}

/** Minimal config that avoids real delays and API calls */
const TEST_CONFIG: Partial<StallTriageConfig> = {
  enabled: true,
  verifyDelayMs: 0,
  cooldownMs: 5000,
  maxEscalations: 2,
  apiKey: 'test-key',
  useIntelligenceProvider: true,
  postInterventionDelayMs: 0,
};

// ─── Tests ─────────────────────────────────────────────────

describe('StallTriageNurse', () => {
  let deps: TriageDeps;
  let mockIntelligence: ReturnType<typeof createMockIntelligence>;
  let mockState: ReturnType<typeof createMockState>;

  beforeEach(() => {
    deps = createMockDeps();
    mockIntelligence = createMockIntelligence();
    mockState = createMockState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── 1. Constructor and Config ─────────────────────────────

  describe('constructor and config', () => {
    it('applies defaults when no config provided', () => {
      const nurse = new StallTriageNurse(deps);
      const status = nurse.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.activeCases).toBe(0);
      expect(status.historyCount).toBe(0);
      expect(status.cooldowns).toBe(0);
    });

    it('respects custom config overrides', () => {
      const nurse = new StallTriageNurse(deps, {
        config: { enabled: false, cooldownMs: 999, maxEscalations: 5 },
      });
      const status = nurse.getStatus();
      expect(status.enabled).toBe(false);
    });

    it('falls back to env for API key when none provided in config', () => {
      const originalEnv = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'env-test-key';
      try {
        const nurse = new StallTriageNurse(deps, { config: { enabled: true } });
        // The API key is private, so we verify indirectly via a triage that would need it.
        // If no key at all, diagnose would throw; with env key, it should proceed.
        // Just verify construction doesn't throw.
        expect(nurse).toBeInstanceOf(StallTriageNurse);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = originalEnv;
        }
      }
    });

    it('returns early from triage when disabled', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, enabled: false },
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'test-session', 'hello', Date.now());
      expect(result.resolved).toBe(false);
      expect(result.fallbackReason).toBe('disabled');
      expect(result.diagnosis).toBeNull();
      expect(result.actionsTaken).toEqual([]);
      // Should not call any deps
      expect(deps.captureSessionOutput).not.toHaveBeenCalled();
    });
  });

  // ─── 1b. Framework-aware heuristics (Tier 2.B) ─────────────

  describe('framework-aware model tier normalization', () => {
    it('claude-code: tier name → canonical Anthropic model id', () => {
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, framework: 'claude-code', model: 'sonnet' },
      });
      // Stored on the merged config; downstream tooling that greps the
      // model id sees the canonical Anthropic name, not the tier alias.
      expect((nurse as unknown as { config: { model: string } }).config.model)
        .toBe('claude-sonnet-4-6');
    });
    it('claude-code: generic tier "balanced" resolves to sonnet → canonical Anthropic id', () => {
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, framework: 'claude-code', model: 'balanced' },
      });
      expect((nurse as unknown as { config: { model: string } }).config.model)
        .toBe('claude-sonnet-4-6');
    });
    it('codex-cli: generic tier "balanced" resolves to Codex model id (no Anthropic mapping)', () => {
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, framework: 'codex-cli', model: 'balanced' },
      });
      expect((nurse as unknown as { config: { model: string } }).config.model)
        .toBe('gpt-5.3-codex');
    });
    it('codex-cli: legacy Claude tier name maps to Codex equivalent', () => {
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, framework: 'codex-cli', model: 'haiku' },
      });
      expect((nurse as unknown as { config: { model: string } }).config.model)
        .toBe('gpt-5.2');
    });
    it('codex-cli: raw Codex model id passes through verbatim', () => {
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, framework: 'codex-cli', model: 'gpt-5.4-codex' },
      });
      expect((nurse as unknown as { config: { model: string } }).config.model)
        .toBe('gpt-5.4-codex');
    });
  });

  describe('framework-aware heuristicDiagnose', () => {
    /** Build a TriageContext suitable for heuristicDiagnose calls. */
    function ctx(tmuxOutput: string, waitMinutes = 0): TriageContext {
      return {
        sessionName: 'echo-test',
        topicId: 1,
        tmuxOutput,
        sessionStatus: 'alive',
        recentMessages: [],
        pendingMessage: 'hi',
        waitMinutes,
      };
    }

    it('claude-code: shell prompt + Claude activity → no restart (Claude still alive)', () => {
      const nurse = new StallTriageNurse(deps, { config: { ...TEST_CONFIG, framework: 'claude-code' } });
      // Bare shell prompt is visible at end, but Claude is still rendering tool output.
      const output = 'Read(/etc/hosts)\nsome output\n$ ';
      expect(nurse.heuristicDiagnose(ctx(output))).toBeNull();
    });

    it('claude-code: shell prompt without Claude activity → restart', () => {
      const nurse = new StallTriageNurse(deps, { config: { ...TEST_CONFIG, framework: 'claude-code' } });
      const output = 'logged out\n$ ';
      const result = nurse.heuristicDiagnose(ctx(output));
      expect(result?.action).toBe('restart');
      expect(result?.summary).toContain('Claude Code');
    });

    it('codex-cli: shell prompt + Codex activity → no restart (Codex still alive)', () => {
      const nurse = new StallTriageNurse(deps, { config: { ...TEST_CONFIG, framework: 'codex-cli' } });
      // Codex is rendering shell tool output, then a bare prompt.
      const output = 'exec(npm test)\nrunning tests...\n$ ';
      expect(nurse.heuristicDiagnose(ctx(output))).toBeNull();
    });

    it('codex-cli: shell prompt + Claude tool tokens → STILL restarts (Codex signal does not match Claude tokens)', () => {
      const nurse = new StallTriageNurse(deps, { config: { ...TEST_CONFIG, framework: 'codex-cli' } });
      // Output happens to contain "Read(" which Claude would treat as activity,
      // but the Codex signal correctly ignores it — bare prompt means restart.
      const output = 'previously: Read(/foo)\n$ ';
      const result = nurse.heuristicDiagnose(ctx(output));
      expect(result?.action).toBe('restart');
      expect(result?.summary).toContain('Codex CLI');
    });

    it('codex-cli: Ctrl+C-to-cancel hint visible for 3+ min → interrupt', () => {
      const nurse = new StallTriageNurse(deps, { config: { ...TEST_CONFIG, framework: 'codex-cli' } });
      const output = 'streaming response\npress Ctrl+C to cancel';
      const result = nurse.heuristicDiagnose(ctx(output, 4));
      expect(result?.action).toBe('interrupt');
    });

    it('claude-code: "esc to interrupt" hint visible for 3+ min → interrupt (default framework)', () => {
      const nurse = new StallTriageNurse(deps, { config: { ...TEST_CONFIG } });
      const output = 'doing things\npress esc to interrupt';
      const result = nurse.heuristicDiagnose(ctx(output, 5));
      expect(result?.action).toBe('interrupt');
    });
  });

  // ─── 2. isInCooldown ────────────────────────────────────────

  describe('isInCooldown', () => {
    it('returns false for a topic that was never triaged', () => {
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });
      expect(nurse.isInCooldown(999)).toBe(false);
    });

    it('returns true within the cooldown window', async () => {
      vi.useFakeTimers();
      try {
        const nurse = new StallTriageNurse(deps, {
          config: { ...TEST_CONFIG, cooldownMs: 10000 },
          intelligence: mockIntelligence as any,
        });

        // Trigger a triage so a cooldown is set
        (deps.isSessionAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);
        await nurse.triage(42, 'sess', 'hello', Date.now());

        // Advance less than cooldown
        vi.advanceTimersByTime(5000);
        expect(nurse.isInCooldown(42)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns false after cooldown expires', async () => {
      vi.useFakeTimers();
      try {
        const nurse = new StallTriageNurse(deps, {
          config: { ...TEST_CONFIG, cooldownMs: 10000 },
          intelligence: mockIntelligence as any,
        });

        (deps.isSessionAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);
        await nurse.triage(42, 'sess', 'hello', Date.now());

        vi.advanceTimersByTime(11000);
        expect(nurse.isInCooldown(42)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ─── 3. parseDiagnosis ─────────────────────────────────────

  describe('parseDiagnosis', () => {
    let nurse: StallTriageNurse;

    beforeEach(() => {
      nurse = new StallTriageNurse(deps, { config: TEST_CONFIG });
    });

    it('parses valid JSON correctly', () => {
      const result = nurse.parseDiagnosis(VALID_DIAGNOSIS_JSON);
      expect(result.action).toBe('status_update');
      expect(result.confidence).toBe('high');
      expect(result.summary).toBe('Session is processing a long build');
      expect(result.userMessage).toBe('The session is busy building. Hang tight!');
    });

    it('strips markdown code fences', () => {
      const wrapped = '```json\n' + VALID_DIAGNOSIS_JSON + '\n```';
      const result = nurse.parseDiagnosis(wrapped);
      expect(result.action).toBe('status_update');
      expect(result.confidence).toBe('high');
    });

    it('extracts JSON from surrounding text', () => {
      const withText = 'Here is my analysis:\n' + VALID_DIAGNOSIS_JSON + '\nThat is my recommendation.';
      const result = nurse.parseDiagnosis(withText);
      expect(result.action).toBe('status_update');
      expect(result.confidence).toBe('high');
    });

    it('falls back when action is invalid', () => {
      const invalid = JSON.stringify({
        summary: 'test',
        action: 'destroy_everything',
        confidence: 'high',
        userMessage: 'bad',
      });
      const result = nurse.parseDiagnosis(invalid);
      expect(result.action).toBe('nudge');
      expect(result.confidence).toBe('low');
      expect(result.summary).toContain('Invalid action');
    });

    it('falls back on empty response', () => {
      const result = nurse.parseDiagnosis('');
      expect(result.action).toBe('nudge');
      expect(result.confidence).toBe('low');
      expect(result.summary).toBe('Could not parse LLM response');
    });
  });

  // ─── 4. Diagnose via IntelligenceProvider ──────────────────

  describe('diagnose via IntelligenceProvider', () => {
    it('uses IntelligenceProvider when configured', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, useIntelligenceProvider: true },
        intelligence: mockIntelligence as any,
      });

      // Run a triage that hits the LLM path (session alive)
      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(mockIntelligence.evaluate).toHaveBeenCalledTimes(1);
      expect(mockIntelligence.evaluate).toHaveBeenCalledWith(
        expect.stringContaining('session recovery specialist'),
        expect.objectContaining({ model: 'balanced' }),
      );
      expect(result.diagnosis).not.toBeNull();
    });

    it('without an IntelligenceProvider, the LLM layer surfaces an error and the heuristic fallback runs', async () => {
      // Per Rule 2 (specs/provider-portability/04-anthropic-path-constraints.md),
      // the direct-Anthropic-API fallback was removed. The previous version of this
      // test asserted that a missing intelligence provider caused a `fetch` to
      // api.anthropic.com — that's no longer the contract. The current contract:
      // when intelligence is absent, `diagnose` throws inside the LLM layer and
      // the layer-3 process-tree / layer-4 heuristic fallback decides the action.
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG },
        // No intelligence provider
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      // Must not invoke the LLM (we didn't supply one).
      expect(mockIntelligence.evaluate).not.toHaveBeenCalled();
      // A diagnosis must still be produced — fallback layer is responsible.
      expect(result.diagnosis).not.toBeNull();
      expect(['interrupt', 'restart', 'nudge', 'unstick']).toContain(result.diagnosis!.action);
      expect(result.diagnosis!.confidence).toBe('low');
    });

    it('falls back to nudge on LLM error', async () => {
      const failIntelligence = {
        evaluate: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      };

      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, useIntelligenceProvider: true },
        intelligence: failIntelligence as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.diagnosis).not.toBeNull();
      expect(result.diagnosis!.action).toBe('interrupt');
      expect(result.diagnosis!.confidence).toBe('low');
      expect(result.diagnosis!.summary).toContain('LLM diagnosis unavailable');
    });

    it('dead/missing sessions bypass LLM entirely', async () => {
      (deps.isSessionAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'dead-session', 'hello', Date.now());

      expect(mockIntelligence.evaluate).not.toHaveBeenCalled();
      expect(result.resolved).toBe(true);
      expect(result.actionsTaken).toContain('restart');
      expect(result.diagnosis?.action).toBe('restart');
      expect(result.diagnosis?.confidence).toBe('high');
    });
  });

  // ─── 5. executeAction ──────────────────────────────────────

  describe('executeAction', () => {
    let nurse: StallTriageNurse;

    beforeEach(() => {
      // Use status_update diagnosis so initial action is just sendToTopic
      mockIntelligence = createMockIntelligence(VALID_DIAGNOSIS_JSON);
      nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });
    });

    it('status_update calls sendToTopic', async () => {
      // status_update diagnosis -> verifyAction returns true
      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(deps.sendToTopic).toHaveBeenCalledWith(
        1,
        expect.stringContaining('busy building'),
      );
      expect(result.actionsTaken).toContain('status_update');
    });

    it('status_update does not call sendKey or sendInput', async () => {
      await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(deps.sendKey).not.toHaveBeenCalled();
      expect(deps.sendInput).not.toHaveBeenCalled();
    });

    it('nudge calls sendInput with empty string', async () => {
      mockIntelligence = createMockIntelligence(NUDGE_DIAGNOSIS_JSON);
      nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      // Make verification succeed (output changed)
      let callCount = 0;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'new output' : 'some output';
      });

      await nurse.triage(2, 'sess', 'hello', Date.now());

      expect(deps.sendInput).toHaveBeenCalledWith('sess', '');
    });

    it('nudge also notifies user via sendToTopic', async () => {
      mockIntelligence = createMockIntelligence(NUDGE_DIAGNOSIS_JSON);
      nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      let callCount = 0;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'new output' : 'some output';
      });

      await nurse.triage(2, 'sess', 'hello', Date.now());

      expect(deps.sendToTopic).toHaveBeenCalledWith(2, expect.any(String));
    });

    it('interrupt calls sendKey with Escape', async () => {
      mockIntelligence = createMockIntelligence(JSON.stringify({
        summary: 'stuck', action: 'interrupt', confidence: 'high', userMessage: 'Interrupting...',
      }));
      nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      let callCount = 0;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'new output' : 'some output';
      });

      await nurse.triage(3, 'sess', 'hello', Date.now());

      expect(deps.sendKey).toHaveBeenCalledWith('sess', 'Escape');
    });

    it('interrupt also notifies user', async () => {
      mockIntelligence = createMockIntelligence(JSON.stringify({
        summary: 'stuck', action: 'interrupt', confidence: 'high', userMessage: 'Interrupting...',
      }));
      nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      let callCount = 0;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'new output' : 'some output';
      });

      await nurse.triage(3, 'sess', 'hello', Date.now());

      expect(deps.sendToTopic).toHaveBeenCalledWith(3, expect.stringContaining('Interrupting'));
    });

    it('unstick calls sendKey with C-c', async () => {
      mockIntelligence = createMockIntelligence(JSON.stringify({
        summary: 'hung', action: 'unstick', confidence: 'high', userMessage: 'Unsticking...',
      }));
      nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      let callCount = 0;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'new output' : 'some output';
      });

      await nurse.triage(4, 'sess', 'hello', Date.now());

      expect(deps.sendKey).toHaveBeenCalledWith('sess', 'C-c');
    });

    it('unstick also notifies user', async () => {
      mockIntelligence = createMockIntelligence(JSON.stringify({
        summary: 'hung', action: 'unstick', confidence: 'high', userMessage: 'Unsticking...',
      }));
      nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      let callCount = 0;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'new output' : 'some output';
      });

      await nurse.triage(4, 'sess', 'hello', Date.now());

      expect(deps.sendToTopic).toHaveBeenCalledWith(4, expect.stringContaining('Unsticking'));
    });

    it('restart calls sendToTopic then respawnSession', async () => {
      mockIntelligence = createMockIntelligence(JSON.stringify({
        summary: 'dead', action: 'restart', confidence: 'high', userMessage: 'Restarting...',
      }));
      nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      // After restart, verification checks isSessionAlive
      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)   // gatherContext check: alive
        .mockReturnValueOnce(true);  // verifyAction: alive after restart

      await nurse.triage(5, 'sess', 'hello', Date.now());

      expect(deps.sendToTopic).toHaveBeenCalledWith(5, expect.stringContaining('Restarting'));
      expect(deps.respawnSession).toHaveBeenCalledWith('sess', 5, { silent: true });
    });

    it('restart notifies before respawning', async () => {
      mockIntelligence = createMockIntelligence(JSON.stringify({
        summary: 'dead', action: 'restart', confidence: 'high', userMessage: 'Restarting...',
      }));
      nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);

      await nurse.triage(5, 'sess', 'hello', Date.now());

      // sendToTopic should have been called before respawnSession
      const sendToTopicOrder = (deps.sendToTopic as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const respawnOrder = (deps.respawnSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(sendToTopicOrder).toBeLessThan(respawnOrder);
    });
  });

  // ─── 6. verifyAction ───────────────────────────────────────

  describe('verifyAction', () => {
    it('status_update always returns true (verified via resolved result)', async () => {
      mockIntelligence = createMockIntelligence(VALID_DIAGNOSIS_JSON);
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      // status_update verifyAction returns true, so triage should resolve
      expect(result.resolved).toBe(true);
      expect(result.actionsTaken).toEqual(['status_update']);
    });

    it('nudge with changed output verifies as recovered', async () => {
      mockIntelligence = createMockIntelligence(NUDGE_DIAGNOSIS_JSON);
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      let callCount = 0;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'different output after nudge' : 'some output';
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.resolved).toBe(true);
    });

    it('nudge with unchanged output does not verify', async () => {
      mockIntelligence = createMockIntelligence(NUDGE_DIAGNOSIS_JSON);
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, maxEscalations: 0 },
        intelligence: mockIntelligence as any,
      });

      // Output stays the same
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue('some output');

      // After exhausted escalations, nurse force-restarts. Mock isSessionAlive to
      // return true for gatherContext but false after the force-restart so it fails.
      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)   // gatherContext
        .mockReturnValueOnce(false); // force-restart verification

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.resolved).toBe(false);
    });

    it('interrupt with null output does not verify', async () => {
      mockIntelligence = createMockIntelligence(JSON.stringify({
        summary: 'stuck', action: 'interrupt', confidence: 'high', userMessage: 'Interrupting...',
      }));
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, maxEscalations: 0 },
        intelligence: mockIntelligence as any,
      });

      // First call returns output for context, second returns null
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce('some output')
        .mockReturnValueOnce(null);

      // After exhausted escalations, nurse force-restarts. Mock isSessionAlive to
      // return true for gatherContext but false after the force-restart so it fails.
      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)   // gatherContext
        .mockReturnValueOnce(false); // force-restart verification

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.resolved).toBe(false);
    });

    it('restart verifies when session is alive after respawn', async () => {
      // Dead session -> short-circuit restart -> verify alive
      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(false)   // gatherContext: dead
        .mockReturnValueOnce(true);   // verifyAction: alive

      // Wait, the short-circuit path doesn't call verifyAction. Let's use
      // a live session with LLM-diagnosed restart instead.
      (deps.isSessionAlive as ReturnType<typeof vi.fn>).mockReset();
      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)   // gatherContext: alive
        .mockReturnValueOnce(true);  // verifyAction after restart

      mockIntelligence = createMockIntelligence(JSON.stringify({
        summary: 'broken', action: 'restart', confidence: 'high', userMessage: 'Restarting...',
      }));
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.resolved).toBe(true);
      expect(result.actionsTaken).toContain('restart');
    });

    it('restart does not verify when session is still dead', async () => {
      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)    // gatherContext: alive
        .mockReturnValueOnce(false);  // verifyAction: still dead after restart

      mockIntelligence = createMockIntelligence(JSON.stringify({
        summary: 'broken', action: 'restart', confidence: 'high', userMessage: 'Restarting...',
      }));
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, maxEscalations: 0 },
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      // restart is the last action in escalation order, so with maxEscalations: 0
      // it should not resolve
      expect(result.resolved).toBe(false);
    });
  });

  // ─── 7. triage — full flow ─────────────────────────────────

  describe('triage — full flow', () => {
    it('disabled returns early with fallbackReason', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, enabled: false },
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.resolved).toBe(false);
      expect(result.fallbackReason).toBe('disabled');
      expect(result.trigger).toBe('telegram_stall');
    });

    it('returns cooldown_active when topic is in cooldown', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, cooldownMs: 60000 },
        intelligence: mockIntelligence as any,
      });

      // First triage to set cooldown (dead session for quick resolve)
      (deps.isSessionAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);
      await nurse.triage(1, 'sess', 'hello', Date.now());

      // Reset to alive for second attempt
      (deps.isSessionAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

      // Second triage should hit cooldown
      const result = await nurse.triage(1, 'sess', 'hello again', Date.now());

      expect(result.resolved).toBe(false);
      expect(result.fallbackReason).toBe('cooldown_active');
    });

    it('returns already_triaging when concurrent triage on same topic', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      // Make the first triage hang by having intelligence.evaluate never resolve quickly
      let resolveFirst: (value: string) => void;
      const firstPromise = new Promise<string>((resolve) => {
        resolveFirst = resolve;
      });
      mockIntelligence.evaluate.mockReturnValueOnce(firstPromise);

      // Start first triage (will hang at diagnose)
      const first = nurse.triage(1, 'sess', 'hello', Date.now());

      // Second triage on same topic
      const second = await nurse.triage(1, 'sess', 'hello again', Date.now());

      expect(second.resolved).toBe(false);
      expect(second.fallbackReason).toBe('already_triaging');

      // Clean up
      resolveFirst!(VALID_DIAGNOSIS_JSON);
      await first;
    });

    it('short-circuits to restart for missing/dead session without LLM', async () => {
      (deps.isSessionAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'dead-sess', 'hello', Date.now());

      expect(result.resolved).toBe(true);
      expect(result.actionsTaken).toEqual(['restart']);
      expect(result.diagnosis?.summary).toContain('missing');
      expect(mockIntelligence.evaluate).not.toHaveBeenCalled();
      expect(deps.respawnSession).toHaveBeenCalledWith('dead-sess', 1, { silent: true });
      expect(deps.clearStallForTopic).toHaveBeenCalledWith(1);
    });

    it('alive session goes through LLM diagnosis path', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(mockIntelligence.evaluate).toHaveBeenCalledTimes(1);
      expect(result.diagnosis).not.toBeNull();
      expect(result.diagnosis!.action).toBe('status_update');
    });

    it('resolves when verification succeeds', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      // status_update always verifies true
      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.resolved).toBe(true);
      expect(deps.clearStallForTopic).toHaveBeenCalledWith(1);
    });

    it('emits events in correct order', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const events: string[] = [];
      nurse.on('triage:started', () => events.push('started'));
      nurse.on('triage:diagnosed', () => events.push('diagnosed'));
      nurse.on('triage:treated', () => events.push('treated'));
      nurse.on('triage:resolved', () => events.push('resolved'));

      await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(events).toEqual(['started', 'diagnosed', 'treated', 'resolved']);
    });

    it('records result in history', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      expect(nurse.getHistory()).toHaveLength(0);

      await nurse.triage(1, 'sess', 'hello', Date.now());

      const history = nurse.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].topicId).toBe(1);
      expect(history[0].sessionName).toBe('sess');
      expect(history[0].result.resolved).toBe(true);
    });
  });

  // ─── 8. triage — escalation ────────────────────────────────

  describe('triage — escalation', () => {
    it('escalates one level when verification fails', async () => {
      // Diagnose as nudge, nudge fails -> escalate to interrupt
      mockIntelligence = createMockIntelligence(NUDGE_DIAGNOSIS_JSON);
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, maxEscalations: 1 },
        intelligence: mockIntelligence as any,
      });

      // First verify (nudge): same output = fail
      // Second verify (interrupt): output with work indicators = success
      // Verification now requires work indicators (new occurrences of Read/Write/etc.) or 100+ char growth
      let verifyCallCount = 0;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        verifyCallCount++;
        if (verifyCallCount <= 1) return 'some output';     // gatherContext
        if (verifyCallCount === 2) return 'some output';     // verify nudge: same = fail
        if (verifyCallCount === 3) return 'some output';     // re-capture context before interrupt verify
        return 'some output\nRead tool output... telegram-reply completed successfully with new content here';  // verify interrupt: has work indicators
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.resolved).toBe(true);
      expect(result.actionsTaken).toEqual(['nudge', 'interrupt']);
    });

    it('escalates multiple levels', async () => {
      // Diagnose as nudge, keep failing
      mockIntelligence = createMockIntelligence(NUDGE_DIAGNOSIS_JSON);
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, maxEscalations: 2 },
        intelligence: mockIntelligence as any,
      });

      // nudge fails, interrupt fails, unstick succeeds (with new tool call evidence)
      // Verification now requires: Sent N chars to topic, pending message keywords in
      // new output, or NEW tool call activity (Read(, Write(, Bash(, etc.).
      // captureSessionOutput calls:
      //   gatherContext(1), verifyNudge(2),
      //   re-capture before interrupt(3), verifyInterrupt(4),
      //   re-capture before unstick(5), verifyUnstick(6)
      let verifyCallCount = 0;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        verifyCallCount++;
        if (verifyCallCount <= 5) return 'some output';     // gatherContext + verify + re-captures: same = fail
        return 'some output\nSent 142 chars to topic';  // verify unstick: Telegram reply evidence
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.resolved).toBe(true);
      expect(result.actionsTaken).toEqual(['nudge', 'interrupt', 'unstick']);
    });

    it('stops at maxEscalations and reports failure', async () => {
      mockIntelligence = createMockIntelligence(NUDGE_DIAGNOSIS_JSON);
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, maxEscalations: 1 },
        intelligence: mockIntelligence as any,
      });

      // All verifications fail
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue('some output');

      // After exhausted escalations, nurse force-restarts since restart wasn't tried yet.
      // Mock isSessionAlive: true for gatherContext, false after force-restart so it fails.
      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)   // gatherContext
        .mockReturnValueOnce(false); // force-restart verification

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.resolved).toBe(false);
      expect(result.fallbackReason).toBe('max_escalations_reached');
      // Now includes the force-restart attempt after escalations
      expect(result.actionsTaken).toEqual(['nudge', 'interrupt', 'restart']);
    });

    it('sets fallbackReason when escalations exhausted', async () => {
      mockIntelligence = createMockIntelligence(NUDGE_DIAGNOSIS_JSON);
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, maxEscalations: 0 },
        intelligence: mockIntelligence as any,
      });

      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue('some output');

      // After exhausted escalations, nurse force-restarts. Mock isSessionAlive to
      // return true for gatherContext but false after the force-restart so it fails.
      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)   // gatherContext
        .mockReturnValueOnce(false); // force-restart verification

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.resolved).toBe(false);
      expect(result.fallbackReason).toBe('max_escalations_reached');
    });

    it('emits escalation events', async () => {
      mockIntelligence = createMockIntelligence(NUDGE_DIAGNOSIS_JSON);
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, maxEscalations: 1 },
        intelligence: mockIntelligence as any,
      });

      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue('some output');

      const escalations: Array<{ from: TreatmentAction; to: TreatmentAction }> = [];
      nurse.on('triage:escalated', (data) => {
        escalations.push({ from: data.from, to: data.to });
      });

      await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(escalations).toHaveLength(1);
      expect(escalations[0]).toEqual({ from: 'nudge', to: 'interrupt' });
    });
  });

  // ─── 9. triage — error handling ────────────────────────────

  describe('triage — error handling', () => {
    it('catches API errors and returns result (does not throw)', async () => {
      const failIntelligence = {
        evaluate: vi.fn().mockRejectedValue(new Error('API exploded')),
      };

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: failIntelligence as any,
      });

      // diagnose falls back to nudge on error; but then nudge may fail verification
      // The key test: triage itself should not throw
      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result).toBeDefined();
      expect(result.diagnosis).not.toBeNull();
      // The fallback interrupt diagnosis (Layer 4 default changed from nudge to interrupt)
      expect(result.diagnosis!.action).toBe('interrupt');
    });

    it('handles captureSessionOutput returning null', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      // Should not throw — gatherContext handles null with || ''
      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result).toBeDefined();
      expect(result.diagnosis).not.toBeNull();
    });

    it('handles sendToTopic throwing without crashing triage', async () => {
      (deps.sendToTopic as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Telegram down'));

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      // executeAction catches sendToTopic errors internally (.catch)
      // So triage should still complete
      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result).toBeDefined();
      // status_update verifyAction still returns true
      expect(result.resolved).toBe(true);
    });

    it('handles respawnSession throwing and reports error', async () => {
      (deps.isSessionAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (deps.respawnSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('spawn failed'));

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      // Dead session -> short-circuit restart -> respawn throws -> caught in try/catch
      expect(result.resolved).toBe(false);
      expect(result.fallbackReason).toContain('spawn failed');
    });
  });

  // ─── 10. getHistory and getStatus ──────────────────────────

  describe('getHistory and getStatus', () => {
    it('starts empty', () => {
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      expect(nurse.getHistory()).toEqual([]);
      expect(nurse.getStatus().historyCount).toBe(0);
    });

    it('records entries after triage', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      await nurse.triage(1, 'sess-a', 'msg1', Date.now());

      // Advance past cooldown for topic 1 or use a different topic
      await nurse.triage(2, 'sess-b', 'msg2', Date.now());

      expect(nurse.getHistory()).toHaveLength(2);
      expect(nurse.getHistory(1)).toHaveLength(1);
      expect(nurse.getHistory(1)[0].topicId).toBe(2); // last entry

      const status = nurse.getStatus();
      expect(status.historyCount).toBe(2);
      expect(status.cooldowns).toBe(2);
      expect(status.activeCases).toBe(0); // all finished
    });

    it('getStatus reflects current state accurately', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const initial = nurse.getStatus();
      expect(initial.enabled).toBe(true);
      expect(initial.activeCases).toBe(0);
      expect(initial.historyCount).toBe(0);
      expect(initial.cooldowns).toBe(0);

      await nurse.triage(1, 'sess', 'hello', Date.now());

      const after = nurse.getStatus();
      expect(after.historyCount).toBe(1);
      expect(after.cooldowns).toBe(1);
      expect(after.activeCases).toBe(0);
    });
  });

  // ─── 11. State persistence ─────────────────────────────────

  describe('state persistence', () => {
    it('loads history from state on construction', () => {
      const existingHistory = [
        {
          topicId: 99,
          sessionName: 'old-sess',
          timestamp: '2026-01-01T00:00:00.000Z',
          result: { resolved: true, actionsTaken: ['nudge' as TreatmentAction], diagnosis: null },
        },
      ];
      const stateWithHistory = createMockState(existingHistory);

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
        state: stateWithHistory as any,
      });

      expect(stateWithHistory.get).toHaveBeenCalledWith('triage-active');
      expect(nurse.getHistory()).toHaveLength(1);
      expect(nurse.getHistory()[0].topicId).toBe(99);
    });

    it('saves state after triage completes', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
        state: mockState as any,
      });

      await nurse.triage(1, 'sess', 'hello', Date.now());

      // saveState is called in finally block and after recordResult
      expect(mockState.set).toHaveBeenCalled();
      const lastCall = mockState.set.mock.calls[mockState.set.mock.calls.length - 1];
      expect(lastCall[0]).toBe('triage-active');
      expect(Array.isArray(lastCall[1])).toBe(true);
      expect(lastCall[1].length).toBeGreaterThan(0);
    });

    it('handles missing state gracefully (null state manager)', () => {
      // No state manager provided
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
        // state: undefined — no state manager
      });

      // Should not throw during construction
      expect(nurse.getHistory()).toEqual([]);
    });
  });
});
