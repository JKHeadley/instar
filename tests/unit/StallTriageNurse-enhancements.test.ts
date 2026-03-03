/**
 * StallTriageNurse Enhancement Tests — Comprehensive coverage for heuristic
 * pre-filter, process-tree fallback, and post-intervention follow-up.
 *
 * Ported and expanded from Dawn Server's StallTriageNurse-enhancements.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StallTriageNurse } from '../../src/monitoring/StallTriageNurse.js';
import type {
  TriageDeps,
  StallTriageConfig,
  TriageContext,
  TriageDiagnosis,
  TreatmentAction,
  ProcessInfo,
} from '../../src/monitoring/StallTriageNurse.types.js';

// ─── Test Helpers ──────────────────────────────────────────

function createMockDeps(overrides?: Partial<TriageDeps>): TriageDeps {
  return {
    captureSessionOutput: vi.fn().mockReturnValue('some output'),
    isSessionAlive: vi.fn().mockReturnValue(true),
    sendKey: vi.fn().mockReturnValue(true),
    sendInput: vi.fn().mockReturnValue(true),
    getTopicHistory: vi.fn().mockReturnValue([]),
    sendToTopic: vi.fn().mockResolvedValue({}),
    respawnSession: vi.fn().mockResolvedValue(undefined),
    clearStallForTopic: vi.fn(),
    ...overrides,
  };
}

function createMockIntelligence(response?: string) {
  return {
    evaluate: vi.fn().mockResolvedValue(response ?? JSON.stringify({
      summary: 'Session is processing',
      action: 'status_update',
      confidence: 'high',
      userMessage: 'The session is busy.',
    })),
  };
}

function createFailIntelligence() {
  return {
    evaluate: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
  };
}

const TEST_CONFIG: Partial<StallTriageConfig> = {
  enabled: true,
  verifyDelayMs: 0,
  cooldownMs: 5000,
  maxEscalations: 2,
  apiKey: 'test-key',
  useIntelligenceProvider: true,
  postInterventionDelayMs: 0,
};

function makeContext(overrides?: Partial<TriageContext>): TriageContext {
  return {
    sessionName: 'test-session',
    topicId: 1,
    tmuxOutput: '',
    sessionStatus: 'alive',
    recentMessages: [],
    pendingMessage: 'hello',
    waitMinutes: 3,
    ...overrides,
  };
}

function diagnosisJson(action: TreatmentAction = 'status_update'): string {
  return JSON.stringify({
    summary: `LLM says ${action}`,
    action,
    confidence: 'high',
    userMessage: `Trying to ${action}...`,
  });
}

// ═══════════════════════════════════════════════════════════
// 1. HEURISTIC PRE-FILTER — Unit Tests
// ═══════════════════════════════════════════════════════════

describe('StallTriageNurse Enhancements', () => {
  let deps: TriageDeps;
  let mockIntelligence: ReturnType<typeof createMockIntelligence>;

  beforeEach(() => {
    deps = createMockDeps();
    mockIntelligence = createMockIntelligence();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('heuristicDiagnose', () => {
    let nurse: StallTriageNurse;

    beforeEach(() => {
      nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });
    });

    // --- Base cases ---

    it('returns null when tmuxOutput is empty', () => {
      expect(nurse.heuristicDiagnose(makeContext({ tmuxOutput: '' }))).toBeNull();
    });

    it('returns null when no patterns match', () => {
      expect(nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'just some normal output here',
      }))).toBeNull();
    });

    it('returns null for normal Claude activity', () => {
      expect(nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Read file_path=/foo.ts\n  function hello() {\n  }\nEdit old_string="hello"\n',
      }))).toBeNull();
    });

    it('returns null for normal tool output with spinners', () => {
      expect(nurse.heuristicDiagnose(makeContext({
        tmuxOutput: '⠋ Thinking...\n⠙ Processing...',
      }))).toBeNull();
    });

    // --- Pattern 1: Running bash command ---

    it('detects (running) with bash command as unstick after 10+ min', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Bash(# Run the build\n  npm run build)\n  (53s · timeout 2m)\n  (running)',
        waitMinutes: 10,
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('unstick');
      expect(result!.confidence).toBe('high');
    });

    it('detects (running) with python script as unstick after 10+ min', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Bash(python3 scripts/deploy.py --env prod)\n  (running)\n  timeout 5m',
        waitMinutes: 12,
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('unstick');
    });

    it('detects (running) with curl as unstick after 10+ min', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Bash(curl -s https://api.example.com/health)\n  (running)',
        waitMinutes: 15,
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('unstick');
    });

    it('detects (running) with node as unstick after 10+ min', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: '> Bash(node scripts/migrate.js) (running)',
        waitMinutes: 10,
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('unstick');
    });

    it('detects (running) with pnpm as unstick after 10+ min', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: '> Bash(pnpm test) (running)',
        waitMinutes: 10,
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('unstick');
    });

    it('detects (running) with shell script as unstick after 10+ min', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: '> Bash(./deploy.sh --prod) (running)',
        waitMinutes: 10,
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('unstick');
    });

    it('does NOT match (running) when waitMinutes < 10 (prevents killing test suites)', () => {
      // This is the core regression test: (running) is a normal Claude Code indicator
      // for any executing Bash tool. Test suites, builds, and installs legitimately
      // take several minutes. The heuristic should NOT fire for short waits.
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: '> Bash(npx vitest run) (running)',
        waitMinutes: 5,
      }));
      expect(result).toBeNull(); // Should fall through to LLM
    });

    it('does NOT match (running) at default waitMinutes (3)', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: '> Bash(npm run build) (running)',
      }));
      expect(result).toBeNull(); // Default waitMinutes is 3, below threshold
    });

    it('does NOT match (running) without recognizable command patterns', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Some random text (running) without command indicators',
        waitMinutes: 15,
      }));
      expect(result).toBeNull();
    });

    // --- Pattern 2: OAuth/browser flow ---

    it('detects OAuth browser flow as unstick', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Opening browser — please click Allow...\n  (53s · timeout 2m)',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('unstick');
      expect(result!.summary).toContain('OAuth');
    });

    it('detects "please click" browser prompt as unstick', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'please click the authorize button in your browser',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('unstick');
    });

    it('detects authentication browser flow as unstick', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Waiting for authentication in browser window...',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('unstick');
    });

    it('detects "Opening browser" prompt', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Opening browser to complete OAuth flow...',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('unstick');
    });

    // --- Pattern 3: Context nearly exhausted ---

    it('detects context at 0% as restart', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Context left until auto-compact: 0%',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('restart');
      expect(result!.confidence).toBe('high');
    });

    it('detects context at 1% as restart', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Context left until auto-compact: 1%\nSome other output',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('restart');
    });

    it('detects context at 2% as restart', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Context left until auto-compact: 2%',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('restart');
    });

    it('detects context at 3% as restart (boundary)', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Context left until auto-compact: 3%',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('restart');
    });

    it('does NOT restart at 4% context (above threshold)', () => {
      expect(nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Context left until auto-compact: 4%',
      }))).toBeNull();
    });

    it('does NOT restart at 5% context', () => {
      expect(nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Context left until auto-compact: 5%\nSome other output',
      }))).toBeNull();
    });

    it('does NOT restart at 50% context', () => {
      expect(nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Context left until auto-compact: 50%',
      }))).toBeNull();
    });

    it('includes percentage in user message', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Context left until auto-compact: 1%',
      }));
      expect(result!.userMessage).toContain('1%');
    });

    // --- Pattern 4: Bare shell prompt (Claude exited) ---

    it('detects bare $ prompt as restart', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'previous output here\nsome more stuff\n\n\n$\n',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('restart');
    });

    it('detects $ with space as restart', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'previous output\n$ \n',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('restart');
    });

    it('detects bash version prompt as restart', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'some output\nbash-5.2$ \n',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('restart');
    });

    it('detects bash-3.2 prompt as restart', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'bash-3.2$ ',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('restart');
    });

    it('does NOT trigger on $ in Claude tool output', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Read file_path=/foo/bar.ts\n  $ export FOO=bar\nGlob pattern="*.ts"\n',
      }));
      expect(result).toBeNull();
    });

    it('does NOT restart when Claude activity (Read) present alongside shell prompt', () => {
      expect(nurse.heuristicDiagnose(makeContext({
        tmuxOutput: '$ \nRead(/some/file)\nclaude processing',
      }))).toBeNull();
    });

    it('does NOT restart when spinner characters present alongside shell prompt', () => {
      expect(nurse.heuristicDiagnose(makeContext({
        tmuxOutput: '$ \n⠋ processing...',
      }))).toBeNull();
    });

    it('does NOT restart when Bash( tool call present alongside shell prompt', () => {
      expect(nurse.heuristicDiagnose(makeContext({
        tmuxOutput: '$ \nBash(ls -la)',
      }))).toBeNull();
    });

    // --- Pattern 5: Fatal errors ---

    it('detects ENOMEM as restart', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Error: ENOMEM — not enough memory to continue',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('restart');
      expect(result!.confidence).toBe('high');
    });

    it('detects SIGKILL as restart', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Process terminated by SIGKILL',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('restart');
    });

    it('detects out of memory as restart', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'FATAL: out of memory in worker thread',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('restart');
    });

    it('detects fatal error as restart', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'fatal error: unable to allocate heap',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('restart');
    });

    it('detects panic as restart', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'panic: runtime error: index out of range',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('restart');
    });

    // --- Pattern 6: "esc to interrupt" with long wait ---

    it('detects "esc to interrupt" with 3+ min wait as interrupt', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: '⠋ Thinking... (esc to interrupt)',
        waitMinutes: 4,
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('interrupt');
      expect(result!.confidence).toBe('medium');
    });

    it('detects "esc to interrupt" at exactly 3 min (boundary)', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: '⠋ Thinking... (esc to interrupt)',
        waitMinutes: 3,
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('interrupt');
    });

    it('does NOT trigger "esc to interrupt" with short wait (< 3 min)', () => {
      expect(nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'some output with esc to interrupt text',
        waitMinutes: 1,
      }))).toBeNull();
    });

    it('does NOT trigger "esc to interrupt" at 2 min', () => {
      expect(nurse.heuristicDiagnose(makeContext({
        tmuxOutput: '⠋ Thinking... (esc to interrupt)',
        waitMinutes: 2,
      }))).toBeNull();
    });

    // --- Pattern priority (first match wins) ---

    it('(running) pattern takes priority over esc-to-interrupt when wait >= 10 min', () => {
      // Both patterns present: (running) is checked first
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Bash(npm run build) (running)\nesc to interrupt',
        waitMinutes: 10,
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('unstick'); // Pattern 1 wins, not Pattern 6
    });

    it('esc-to-interrupt wins over (running) when wait < 10 min (Pattern 1 gated)', () => {
      // When waitMinutes < 10, Pattern 1 doesn't fire, so Pattern 6 can match
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Bash(npm run build) (running)\nesc to interrupt',
        waitMinutes: 5,
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('interrupt'); // Pattern 6 wins because Pattern 1 is gated
    });

    it('OAuth pattern takes priority over context exhaustion', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Opening browser for OAuth...\nContext left until auto-compact: 1%',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('unstick'); // Pattern 2 wins, not Pattern 3
    });

    it('context exhaustion pattern takes priority over shell prompt', () => {
      const result = nurse.heuristicDiagnose(makeContext({
        tmuxOutput: 'Context left until auto-compact: 2%\n$ \n',
      }));
      expect(result).not.toBeNull();
      expect(result!.action).toBe('restart');
      expect(result!.summary).toContain('Context'); // Pattern 3, not Pattern 4
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 2. HEURISTIC INTEGRATION — Runs before LLM in triage
  // ═══════════════════════════════════════════════════════════

  describe('heuristic integration — runs before LLM in diagnose()', () => {
    it('skips LLM when heuristic matches (running) pattern (10+ min wait)', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        '> Bash(curl https://api.example.com/data) (running)'
      );

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const tenMinAgo = Date.now() - 10 * 60_000;
      const result = await nurse.triage(1, 'sess', 'hello', tenMinAgo);

      expect(mockIntelligence.evaluate).not.toHaveBeenCalled();
      expect(result.diagnosis?.action).toBe('unstick');
      expect(result.diagnosis?.confidence).toBe('high');
    });

    it('skips LLM when heuristic matches OAuth pattern', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        'Opening browser for OAuth...\nPlease click Allow'
      );

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(2, 'sess', 'hello', Date.now());

      expect(mockIntelligence.evaluate).not.toHaveBeenCalled();
      expect(result.diagnosis?.action).toBe('unstick');
    });

    it('skips LLM when heuristic matches context exhaustion', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        'Context left until auto-compact: 2%\nSome output'
      );

      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)   // gatherContext
        .mockReturnValueOnce(true);  // verify restart

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(3, 'sess', 'hello', Date.now());

      expect(mockIntelligence.evaluate).not.toHaveBeenCalled();
      expect(result.diagnosis?.action).toBe('restart');
    });

    it('skips LLM when heuristic matches fatal error', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        'FATAL ERROR: out of memory\nAborted (core dumped)'
      );

      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(4, 'sess', 'hello', Date.now());

      expect(mockIntelligence.evaluate).not.toHaveBeenCalled();
      expect(result.diagnosis?.action).toBe('restart');
    });

    it('falls through to LLM when no heuristic matches', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        'some ambiguous output that no pattern matches'
      );

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      await nurse.triage(5, 'sess', 'hello', Date.now());

      expect(mockIntelligence.evaluate).toHaveBeenCalledTimes(1);
    });

    it('heuristic beats LLM even when LLM would disagree (10+ min wait)', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        '> Bash(npm run build) (running)'
      );

      // LLM would say status_update
      const statusIntelligence = createMockIntelligence(diagnosisJson('status_update'));

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: statusIntelligence as any,
      });

      const tenMinAgo = Date.now() - 10 * 60_000;
      const result = await nurse.triage(6, 'sess', 'hello', tenMinAgo);

      expect(result.diagnosis?.action).toBe('unstick'); // Heuristic wins
      expect(statusIntelligence.evaluate).not.toHaveBeenCalled();
    });

    it('LLM handles (running) pattern when wait < 10 min (heuristic gated)', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        '> Bash(npm run build) (running)'
      );

      const statusIntelligence = createMockIntelligence(diagnosisJson('status_update'));

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: statusIntelligence as any,
      });

      const result = await nurse.triage(7, 'sess', 'hello', Date.now());

      // With short wait, heuristic doesn't fire — LLM handles it
      expect(statusIntelligence.evaluate).toHaveBeenCalled();
      expect(result.diagnosis?.action).toBe('status_update');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 3. PROCESS-TREE FALLBACK
  // ═══════════════════════════════════════════════════════════

  describe('process-tree fallback', () => {
    it('uses process-tree when LLM fails and stuck process exists', async () => {
      const stuckProcesses: ProcessInfo[] = [
        { pid: 12345, command: 'curl https://stuck.example.com', elapsedMs: 300000 },
      ];

      const depsWithPT = createMockDeps({
        getStuckProcesses: vi.fn().mockResolvedValue(stuckProcesses),
      });

      const nurse = new StallTriageNurse(depsWithPT, {
        config: TEST_CONFIG,
        intelligence: createFailIntelligence() as any,
      });

      let callCount = 0;
      (depsWithPT.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'new output with Read( tool call and more content' : 'some output';
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(depsWithPT.getStuckProcesses).toHaveBeenCalledWith('sess');
      expect(result.diagnosis?.action).toBe('unstick');
      expect(result.diagnosis?.confidence).toBe('medium');
      expect(result.diagnosis?.summary).toContain('process tree');
    });

    it('reports elapsed time in process-tree diagnosis', async () => {
      const depsWithPT = createMockDeps({
        getStuckProcesses: vi.fn().mockResolvedValue([
          { pid: 99999, command: 'curl -s https://api.example.com/slow', elapsedMs: 300_000 },
        ]),
      });

      let callCount = 0;
      (depsWithPT.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'new output with Bash( tool call' : 'some output';
      });

      const nurse = new StallTriageNurse(depsWithPT, {
        config: TEST_CONFIG,
        intelligence: createFailIntelligence() as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.diagnosis?.summary).toContain('5min');
      expect(result.diagnosis?.userMessage).toContain('5 minutes');
    });

    it('uses first stuck process when multiple exist', async () => {
      const depsWithPT = createMockDeps({
        getStuckProcesses: vi.fn().mockResolvedValue([
          { pid: 1, command: 'first-stuck-command', elapsedMs: 120_000 },
          { pid: 2, command: 'second-stuck-command', elapsedMs: 60_000 },
        ]),
      });

      let callCount = 0;
      (depsWithPT.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'new output with Read(' : 'some output';
      });

      const nurse = new StallTriageNurse(depsWithPT, {
        config: TEST_CONFIG,
        intelligence: createFailIntelligence() as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.diagnosis?.summary).toContain('first-stuck-command');
    });

    it('truncates long command names to 80 chars', async () => {
      const longCommand = 'x'.repeat(120);
      const depsWithPT = createMockDeps({
        getStuckProcesses: vi.fn().mockResolvedValue([
          { pid: 1, command: longCommand, elapsedMs: 120_000 },
        ]),
      });

      let callCount = 0;
      (depsWithPT.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'new output with Bash(' : 'some output';
      });

      const nurse = new StallTriageNurse(depsWithPT, {
        config: TEST_CONFIG,
        intelligence: createFailIntelligence() as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      // Summary should contain truncated command
      expect(result.diagnosis?.summary).not.toContain(longCommand);
      expect(result.diagnosis?.summary!.length).toBeLessThan(200);
    });

    it('falls through to terminal heuristic when no stuck processes found', async () => {
      const depsWithPT = createMockDeps({
        getStuckProcesses: vi.fn().mockResolvedValue([]),
      });

      const nurse = new StallTriageNurse(depsWithPT, {
        config: TEST_CONFIG,
        intelligence: createFailIntelligence() as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.diagnosis?.action).toBe('interrupt');
      expect(result.diagnosis?.confidence).toBe('low');
    });

    it('falls through gracefully when getStuckProcesses throws', async () => {
      const depsWithPT = createMockDeps({
        getStuckProcesses: vi.fn().mockRejectedValue(new Error('process tree error')),
      });

      const nurse = new StallTriageNurse(depsWithPT, {
        config: TEST_CONFIG,
        intelligence: createFailIntelligence() as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.diagnosis?.action).toBe('interrupt');
    });

    it('skips process-tree when getStuckProcesses not provided', async () => {
      const depsNoProcessTree = createMockDeps();

      const nurse = new StallTriageNurse(depsNoProcessTree, {
        config: TEST_CONFIG,
        intelligence: createFailIntelligence() as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.diagnosis?.action).toBe('interrupt');
    });

    it('LLM > process-tree: uses LLM when both available and LLM succeeds', async () => {
      const depsWithPT = createMockDeps({
        getStuckProcesses: vi.fn().mockResolvedValue([
          { pid: 1, command: 'npm run test', elapsedMs: 120_000 },
        ]),
      });

      const nurse = new StallTriageNurse(depsWithPT, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      // LLM should win — process-tree not even consulted
      expect(result.diagnosis?.action).toBe('status_update');
      expect(depsWithPT.getStuckProcesses).not.toHaveBeenCalled();
    });

    it('process-tree used only when heuristic misses AND LLM fails', async () => {
      const depsWithPT = createMockDeps({
        captureSessionOutput: vi.fn().mockReturnValue('normal looking output'),
        getStuckProcesses: vi.fn().mockResolvedValue([
          { pid: 1, command: 'npm run test', elapsedMs: 120_000 },
        ]),
      });

      let callCount = 0;
      (depsWithPT.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'new output with Bash(' : 'normal looking output';
      });

      const nurse = new StallTriageNurse(depsWithPT, {
        config: TEST_CONFIG,
        intelligence: createFailIntelligence() as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(depsWithPT.getStuckProcesses).toHaveBeenCalledWith('sess');
      expect(result.diagnosis?.action).toBe('unstick');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 4. POST-INTERVENTION FOLLOW-UP
  // ═══════════════════════════════════════════════════════════

  describe('post-intervention follow-up', () => {
    it('sends follow-up message after unstick (Ctrl+C)', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        '> Bash(curl https://stuck.example.com) (running)'
      );

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const tenMinAgo = Date.now() - 10 * 60_000;
      await nurse.triage(1, 'sess', 'check the logs', tenMinAgo);

      const sendInputCalls = (deps.sendInput as ReturnType<typeof vi.fn>).mock.calls;
      const followUpCall = sendInputCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('[system]')
      );
      expect(followUpCall).toBeDefined();
      expect(followUpCall![1]).toContain('Ctrl+C');
      expect(followUpCall![1]).toContain('check the logs');
      expect(followUpCall![1]).toContain('alternative approach');
    });

    it('sends follow-up message after interrupt (Escape)', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        '⠋ Thinking... (esc to interrupt)'
      );

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      // 4+ minutes for esc-to-interrupt heuristic
      const fourMinAgo = Date.now() - 4 * 60000;
      await nurse.triage(2, 'sess', 'what happened', fourMinAgo);

      const sendInputCalls = (deps.sendInput as ReturnType<typeof vi.fn>).mock.calls;
      const followUpCall = sendInputCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('[system]')
      );
      expect(followUpCall).toBeDefined();
      expect(followUpCall![1]).toContain('Escape');
      expect(followUpCall![1]).toContain('what happened');
    });

    it('includes pending message in follow-up for context recovery', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        '> Bash(python3 deploy.py) (running)'
      );

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const tenMinAgo = Date.now() - 10 * 60_000;
      await nurse.triage(1, 'sess', 'Can you check the deployment status?', tenMinAgo);

      const sendInputCalls = (deps.sendInput as ReturnType<typeof vi.fn>).mock.calls;
      const followUpCall = sendInputCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('[system]')
      );
      expect(followUpCall![1]).toContain('Can you check the deployment status?');
    });

    it('does NOT send follow-up for status_update', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: createMockIntelligence(diagnosisJson('status_update')) as any,
      });

      await nurse.triage(1, 'sess', 'hello', Date.now());

      const sendInputCalls = (deps.sendInput as ReturnType<typeof vi.fn>).mock.calls;
      const followUpCall = sendInputCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('[system]')
      );
      expect(followUpCall).toBeUndefined();
    });

    it('does NOT send follow-up for nudge when nudge resolves', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: createMockIntelligence(diagnosisJson('nudge')) as any,
      });

      // Nudge verification succeeds: output changed AND has work indicators
      let callCount = 0;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) return 'some output'; // gatherContext
        // verify: changed output with work indicators
        return 'some output\nRead( file contents and additional work done here for verification';
      });

      await nurse.triage(1, 'sess', 'hello', Date.now());

      const sendInputCalls = (deps.sendInput as ReturnType<typeof vi.fn>).mock.calls;
      // Nudge sends empty string via sendInput, but NOT a [system] follow-up
      const followUpCall = sendInputCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('[system]')
      );
      expect(followUpCall).toBeUndefined();
    });

    it('does NOT send follow-up for restart (dead session)', async () => {
      (deps.isSessionAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      await nurse.triage(1, 'dead-sess', 'hello', Date.now());

      const sendInputCalls = (deps.sendInput as ReturnType<typeof vi.fn>).mock.calls;
      const followUpCall = sendInputCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('[system]')
      );
      expect(followUpCall).toBeUndefined();
    });

    it('follow-up does not crash triage if sendInput throws', async () => {
      let followUpAttempted = false;
      const throwDeps = createMockDeps({
        captureSessionOutput: vi.fn().mockReturnValue(
          '> Bash(curl https://stuck.example.com) (running)'
        ),
        sendInput: vi.fn().mockImplementation((_session: string, text: string) => {
          if (typeof text === 'string' && text.includes('[system]')) {
            followUpAttempted = true;
            throw new Error('tmux send-keys failed');
          }
          return true;
        }),
      });

      const nurse = new StallTriageNurse(throwDeps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      // Should not throw even if follow-up fails
      const tenMinAgo = Date.now() - 10 * 60_000;
      const result = await nurse.triage(1, 'sess', 'hello', tenMinAgo);
      expect(result).toBeDefined();
      expect(followUpAttempted).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 5. DIAGNOSIS PRIORITY CHAIN
  // ═══════════════════════════════════════════════════════════

  describe('diagnosis priority chain', () => {
    it('dead session short-circuits before heuristic, LLM, and process-tree', async () => {
      (deps.isSessionAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        '> Bash(curl https://stuck.example.com) (running)' // Would match heuristic
      );

      const depsWithPT = createMockDeps({
        ...deps,
        isSessionAlive: vi.fn().mockReturnValue(false),
        captureSessionOutput: vi.fn().mockReturnValue(
          '> Bash(npm run build) (running)'
        ),
        getStuckProcesses: vi.fn().mockResolvedValue([
          { pid: 1, command: 'npm', elapsedMs: 120_000 },
        ]),
      });

      const nurse = new StallTriageNurse(depsWithPT, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.diagnosis?.action).toBe('restart');
      expect(mockIntelligence.evaluate).not.toHaveBeenCalled();
      expect(depsWithPT.getStuckProcesses).not.toHaveBeenCalled();
    });

    it('heuristic beats LLM when pattern matches (10+ min wait)', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        '> Bash(npm run build) (running)'
      );

      const statusIntelligence = createMockIntelligence(diagnosisJson('status_update'));

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: statusIntelligence as any,
      });

      const tenMinAgo = Date.now() - 10 * 60_000;
      const result = await nurse.triage(1, 'sess', 'hello', tenMinAgo);

      expect(result.diagnosis?.action).toBe('unstick');
      expect(statusIntelligence.evaluate).not.toHaveBeenCalled();
    });

    it('process-tree beats terminal heuristic when LLM fails', async () => {
      const depsWithPT = createMockDeps({
        getStuckProcesses: vi.fn().mockResolvedValue([
          { pid: 999, command: 'node stuck-script.js', elapsedMs: 180000 },
        ]),
      });

      let callCount = 0;
      (depsWithPT.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'new output with Bash( tool output' : 'some output';
      });

      const nurse = new StallTriageNurse(depsWithPT, {
        config: TEST_CONFIG,
        intelligence: createFailIntelligence() as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.diagnosis?.action).toBe('unstick');
      expect(result.diagnosis?.confidence).toBe('medium');
      expect(result.diagnosis?.summary).toContain('process tree');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 6. END-TO-END INTEGRATION SCENARIOS
  // ═══════════════════════════════════════════════════════════

  describe('end-to-end scenarios', () => {
    it('stuck OAuth flow: heuristic → unstick → follow-up → verify → resolved', async () => {
      let captureCount = 0;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        captureCount++;
        if (captureCount === 1) {
          return 'Opening browser for OAuth authentication...\nPlease click Allow in your browser\nContext left until auto-compact: 2%';
        }
        return 'some output\nRead( file contents here and new tool output with extra content';
      });

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'test-sess', 'please check the session', Date.now());

      expect(result.diagnosis?.action).toMatch(/unstick|restart/);
      expect(result.diagnosis?.confidence).toBe('high');
      expect(mockIntelligence.evaluate).not.toHaveBeenCalled();

      // Follow-up should have been sent if action was unstick
      if (result.diagnosis?.action === 'unstick') {
        const sendInputCalls = (deps.sendInput as ReturnType<typeof vi.fn>).mock.calls;
        const followUpCall = sendInputCalls.find(
          (call: any[]) => typeof call[1] === 'string' && call[1].includes('[system]')
        );
        expect(followUpCall).toBeDefined();
        expect(followUpCall![1]).toContain('please check the session');
      }

      // User should have been notified
      expect(deps.sendToTopic).toHaveBeenCalled();
    });

    it('context exhaustion: heuristic → restart → respawn → resolved', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        'lots of output here\nContext left until auto-compact: 1%\nmore output'
      );

      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)   // gatherContext
        .mockReturnValueOnce(true);  // verify restart

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.resolved).toBe(true);
      expect(result.diagnosis?.action).toBe('restart');
      expect(result.diagnosis?.summary).toContain('Context nearly exhausted');
      expect(deps.respawnSession).toHaveBeenCalled();
    });

    it('fatal error: heuristic → restart → respawn → resolved', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        'FATAL ERROR: out of memory\nAborted (core dumped)'
      );

      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.resolved).toBe(true);
      expect(result.diagnosis?.action).toBe('restart');
      expect(result.diagnosis?.summary).toContain('Fatal error');
    });

    it('LLM failure + stuck process: process-tree → unstick → follow-up → resolved', async () => {
      const depsWithPT = createMockDeps({
        getStuckProcesses: vi.fn().mockResolvedValue([
          { pid: 54321, command: 'node /usr/local/bin/npm run test', elapsedMs: 180_000 },
        ]),
      });

      let callCount = 0;
      (depsWithPT.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'output changed after recovery with Read(' : 'normal looking output';
      });

      const nurse = new StallTriageNurse(depsWithPT, {
        config: TEST_CONFIG,
        intelligence: createFailIntelligence() as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.resolved).toBe(true);
      expect(result.diagnosis?.action).toBe('unstick');
      expect(result.diagnosis?.summary).toContain('process tree');
      expect(depsWithPT.getStuckProcesses).toHaveBeenCalledWith('sess');

      // Follow-up sent
      const sendInputCalls = (depsWithPT.sendInput as ReturnType<typeof vi.fn>).mock.calls;
      const followUpCall = sendInputCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('[system]')
      );
      expect(followUpCall).toBeDefined();
    });

    it('heuristic unstick → verify fails → escalates to restart', async () => {
      // Output never changes (all verifications fail)
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        '> Bash(npm run build) (running)'
      );

      // After exhausted escalations, force-restart. Session alive after restart.
      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)   // gatherContext
        .mockReturnValueOnce(true);  // verify force-restart

      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, maxEscalations: 2 },
        intelligence: mockIntelligence as any,
      });

      const tenMinAgo = Date.now() - 10 * 60_000;
      const result = await nurse.triage(1, 'sess', 'hello', tenMinAgo);

      expect(result.actionsTaken).toContain('unstick');
      expect(result.actionsTaken).toContain('restart');
      expect(mockIntelligence.evaluate).not.toHaveBeenCalled();
    });

    it('multiple concurrent sessions handled independently', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, cooldownMs: 0 },
        intelligence: mockIntelligence as any,
      });

      const result1 = await nurse.triage(100, 'sess-a', 'msg1', Date.now());
      const result2 = await nurse.triage(200, 'sess-b', 'msg2', Date.now());
      const result3 = await nurse.triage(300, 'sess-c', 'msg3', Date.now());

      expect(result1.resolved).toBe(true);
      expect(result2.resolved).toBe(true);
      expect(result3.resolved).toBe(true);
      expect(nurse.getHistory().length).toBe(3);
    });

    it('shell prompt detected: heuristic → restart → respawn', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        'some output\nbash-5.2$ '
      );

      (deps.isSessionAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      expect(result.resolved).toBe(true);
      expect(result.diagnosis?.action).toBe('restart');
      expect(deps.respawnSession).toHaveBeenCalled();
      expect(mockIntelligence.evaluate).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 7. EVENT EMISSION DURING HEURISTIC PATH
  // ═══════════════════════════════════════════════════════════

  describe('event emission during heuristic path', () => {
    it('emits started, diagnosed, treated, resolved for heuristic unstick', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        '> Bash(curl https://api.example.com/stuck) (running)'
      );

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      const events: string[] = [];
      nurse.on('triage:started', () => events.push('started'));
      nurse.on('triage:diagnosed', () => events.push('diagnosed'));
      nurse.on('triage:treated', () => events.push('treated'));
      nurse.on('triage:resolved', () => events.push('resolved'));

      // Make verification succeed
      let callCount = 0;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return callCount > 1 ? 'new output with Read( call' : '> Bash(curl) (running)';
      });

      const tenMinAgo = Date.now() - 10 * 60_000;
      await nurse.triage(1, 'sess', 'hello', tenMinAgo);

      expect(events).toEqual(['started', 'diagnosed', 'treated', 'resolved']);
    });

    it('emits escalated events when heuristic action fails and escalates', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        '> Bash(npm run build) (running)'
      );

      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, maxEscalations: 1 },
        intelligence: mockIntelligence as any,
      });

      const escalations: Array<{ from: TreatmentAction; to: TreatmentAction }> = [];
      nurse.on('triage:escalated', (data) => {
        escalations.push({ from: data.from, to: data.to });
      });

      const tenMinAgo = Date.now() - 10 * 60_000;
      await nurse.triage(1, 'sess', 'hello', tenMinAgo);

      expect(escalations.length).toBeGreaterThanOrEqual(1);
      expect(escalations[0].from).toBe('unstick');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 8. DELAY CONFIGURATION
  // ═══════════════════════════════════════════════════════════

  describe('delay configuration', () => {
    it('uses default delay when postInterventionDelayMs not specified', () => {
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, postInterventionDelayMs: undefined },
        intelligence: mockIntelligence as any,
      });
      expect(nurse).toBeInstanceOf(StallTriageNurse);
    });

    it('respects custom postInterventionDelayMs', () => {
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, postInterventionDelayMs: 5000 },
        intelligence: mockIntelligence as any,
      });
      expect(nurse).toBeInstanceOf(StallTriageNurse);
    });

    it('executes follow-up with configured delay', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        '> Bash(curl) (running)'
      );

      const startTime = Date.now();
      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, postInterventionDelayMs: 50 },
        intelligence: mockIntelligence as any,
      });
      const tenMinAgo = Date.now() - 10 * 60_000;
      await nurse.triage(1, 'sess', 'hello', tenMinAgo);
      const elapsed = Date.now() - startTime;

      // Should have waited at least ~50ms
      expect(elapsed).toBeGreaterThanOrEqual(30);

      // Follow-up should still have been sent
      const sendInputCalls = (deps.sendInput as ReturnType<typeof vi.fn>).mock.calls;
      const followUpCall = sendInputCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('[system]')
      );
      expect(followUpCall).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 9. TERMINAL HEURISTIC FALLBACK (Layer 4)
  // ═══════════════════════════════════════════════════════════

  describe('terminal heuristic fallback (when LLM fails, no process-tree)', () => {
    it('uses restart for dead/missing session in fallback', async () => {
      const depsWithDeadSession = createMockDeps({
        captureSessionOutput: vi.fn().mockReturnValue('some normal output'),
        isSessionAlive: vi.fn().mockReturnValue(true), // alive for gatherContext
      });

      const nurse = new StallTriageNurse(depsWithDeadSession, {
        config: TEST_CONFIG,
        intelligence: createFailIntelligence() as any,
      });

      // This test verifies the inner fallback heuristic (error/Error/SIGTERM/exited)
      (depsWithDeadSession.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        'some output with error indicators and process exited'
      );

      const result = await nurse.triage(1, 'sess', 'hello', Date.now());

      // Terminal heuristic should detect "error" and "exited"
      expect(result.diagnosis?.action).toBe('restart');
      expect(result.diagnosis?.confidence).toBe('low');
    });

    it('uses interrupt for 5+ minute wait in fallback', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: createFailIntelligence() as any,
      });

      // 6 minutes ago
      const sixMinAgo = Date.now() - 6 * 60_000;
      const result = await nurse.triage(1, 'sess', 'hello', sixMinAgo);

      expect(result.diagnosis?.action).toBe('interrupt');
      expect(result.diagnosis?.confidence).toBe('low');
      expect(result.diagnosis?.summary).toContain('unresponsive');
    });

    it('defaults to interrupt when no terminal clues in fallback', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        'clean output with no indicators'
      );

      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: createFailIntelligence() as any,
      });

      // Recent message (1 minute ago)
      const oneMinAgo = Date.now() - 60_000;
      const result = await nurse.triage(1, 'sess', 'hello', oneMinAgo);

      expect(result.diagnosis?.action).toBe('interrupt');
      expect(result.diagnosis?.confidence).toBe('low');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 10. REGRESSION: Verify existing behavior preserved
  // ═══════════════════════════════════════════════════════════

  describe('regression — existing behavior preserved', () => {
    it('cooldown still respected after heuristic triage', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        '> Bash(curl) (running)'
      );

      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, cooldownMs: 60000 },
        intelligence: mockIntelligence as any,
      });

      const tenMinAgo = Date.now() - 10 * 60_000;
      await nurse.triage(1, 'sess', 'hello', tenMinAgo);

      // Second attempt on same topic should hit cooldown
      const result2 = await nurse.triage(1, 'sess', 'hello again', tenMinAgo);
      expect(result2.resolved).toBe(false);
      expect(result2.fallbackReason).toBe('cooldown_active');
    });

    it('concurrent triage prevention still works with heuristic', async () => {
      const nurse = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: mockIntelligence as any,
      });

      // Make first triage hang on intelligence
      let resolveFirst: (value: string) => void;
      const hangingIntelligence = {
        evaluate: vi.fn().mockReturnValueOnce(
          new Promise<string>((resolve) => { resolveFirst = resolve; })
        ),
      };

      // No heuristic match → will go to LLM (which hangs)
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        'no matching patterns here'
      );

      const nurseWithHang = new StallTriageNurse(deps, {
        config: TEST_CONFIG,
        intelligence: hangingIntelligence as any,
      });

      const first = nurseWithHang.triage(1, 'sess', 'msg1', Date.now());
      const second = await nurseWithHang.triage(1, 'sess', 'msg2', Date.now());

      expect(second.fallbackReason).toBe('already_triaging');

      resolveFirst!(diagnosisJson('status_update'));
      await first;
    });

    it('history records heuristic-resolved results', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        '> Bash(curl) (running)'
      );

      const nurse = new StallTriageNurse(deps, {
        config: { ...TEST_CONFIG, cooldownMs: 0 },
        intelligence: mockIntelligence as any,
      });

      const tenMinAgo = Date.now() - 10 * 60_000;
      await nurse.triage(1, 'sess', 'hello', tenMinAgo);

      const history = nurse.getHistory();
      expect(history.length).toBe(1);
      expect(history[0].result.diagnosis?.action).toBe('unstick');
      expect(history[0].result.diagnosis?.confidence).toBe('high');
    });
  });
});
