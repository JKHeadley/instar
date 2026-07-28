/**
 * GeminiLoopDriver (need-gem-002) — multi-turn re-prompt engine for the Gemini
 * mentee.
 *
 * A one-shot `gemini -p` runs one turn and exits, so a gemini mentee is bounded
 * to one-shot tasks (the #1 maiden-voyage lesson). Unlike Claude/codex — which
 * run as persistent hook-capable sessions and re-prompt via the autonomous Stop
 * hook — gemini runs as one-shots, so the loop is driven EXTERNALLY: each turn
 * re-spawns `gemini -m <model> -r <handle> -p "<nudge>"`, and gemini restores the
 * session's full context natively (empirically proven, gemini-cli 0.25.2). That
 * means the driver re-prompts with only the next instruction — never the
 * accumulated transcript — which is the quota-efficient design that respects the
 * no-overspend / subscription-auth rule.
 *
 * This is increment 1: the pure engine. Every side effect is INJECTED (the
 * gemini spawn, the budget gate, the session-handle capture, sleep, clock), so
 * the loop logic is fully unit-testable with zero real gemini calls / zero
 * quota. Lifecycle invocation (a route / the apprenticeship machinery calling
 * `run()`, plus the real `--list-sessions` handle parser) is increment 2.
 *
 * Spec: docs/specs/gemini-multi-turn-loop-driver.md
 */

import {
  buildGeminiOneShotArgv,
  buildGeminiResumeArgv,
} from '../providers/adapters/gemini-cli/transport/geminiSpawn.js';

/** Outcome of a single gemini spawn (subset of GeminiSpawnResult the loop needs). */
export interface GeminiLoopSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/**
 * Injected gemini spawn. Receives the FULL argv (already including `-m`, and on
 * resume turns `-r <handle>`) and runs gemini, returning the result. The real
 * impl wraps `spawnGeminiAndWait` + `buildGeminiChildEnv` (which strips every
 * billing env var → subscription auth is structural). A wiring-integrity test
 * asserts the real driver routes through that transport, never a raw spawn.
 */
export type GeminiLoopSpawn = (argv: string[]) => Promise<GeminiLoopSpawnResult>;

/**
 * Injected budget gate — checked BEFORE every turn (including turn 1). `ok:false`
 * halts the loop immediately (no spawn). The real impl reuses the existing
 * QuotaTracker / autonomous can-start budget accounting; the engine stays
 * number-agnostic so the §6 guardrail values live entirely in config/wiring.
 */
export type GeminiLoopBudgetGate = () => { ok: boolean; reason?: string };

/**
 * Capture the stable session handle created by turn 1 (the real impl parses
 * `gemini --list-sessions` for the newest row in the loop's dedicated cwd).
 * Returns `null` when the handle cannot be resolved — in which case the loop
 * ABORTS rather than silently falling back to `latest` (which could resume a
 * foreign session). Injected so the engine never depends on parsing in tests.
 */
export type GeminiLoopHandleCapture = (
  turn1: GeminiLoopSpawnResult,
) => Promise<string | null>;

export interface GeminiLoopDriverDeps {
  spawn: GeminiLoopSpawn;
  captureHandle: GeminiLoopHandleCapture;
  budgetGate?: GeminiLoopBudgetGate;
  /** Injectable for tests (default: real timer). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (default: Date.now). */
  now?: () => number;
}

export interface GeminiLoopRunOptions {
  model: string;
  /** The goal / framing for turn 1. */
  goalPrompt: string;
  /** Hard cap on total turns (including turn 1). Clamped to >= 1. */
  maxTurns: number;
  /** Token the mentee emits when the goal is complete. Default GEMINI_LOOP_DONE. */
  doneSentinel?: string;
  /** Continuation instruction sent on turns 2..N (context is already resumed). */
  continuationPrompt?: string;
  /** Min ms between turn spawns (anti-spin). Default 0. */
  minTurnIntervalMs?: number;
}

export interface GeminiLoopTurn {
  turn: number;
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** True when the doneSentinel appeared in this turn's stdout. */
  done: boolean;
}

export type GeminiLoopStopReason =
  | 'done-sentinel'
  | 'max-turns'
  | 'budget-halt'
  | 'spawn-failure'
  | 'handle-capture-failure';

export interface GeminiLoopResult {
  sessionHandle: string | null;
  turns: GeminiLoopTurn[];
  stopReason: GeminiLoopStopReason;
  /** stdout of the last spawned turn ('' if none ran). */
  finalOutput: string;
  /** Reason text from the budget gate when stopReason === 'budget-halt'. */
  haltReason?: string;
}

export const DEFAULT_DONE_SENTINEL = 'GEMINI_LOOP_DONE';

const DEFAULT_CONTINUATION =
  'Continue toward the goal. If the goal is now fully complete, end your reply ' +
  `with the exact token ${DEFAULT_DONE_SENTINEL} on its own line.`;

export class GeminiLoopDriver {
  private readonly spawn: GeminiLoopSpawn;
  private readonly captureHandle: GeminiLoopHandleCapture;
  private readonly budgetGate: GeminiLoopBudgetGate;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: GeminiLoopDriverDeps) {
    this.spawn = deps.spawn;
    this.captureHandle = deps.captureHandle;
    this.budgetGate = deps.budgetGate ?? (() => ({ ok: true }));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Drive a multi-turn gemini task to one of: done-sentinel, max-turns,
   * budget-halt, spawn-failure, or handle-capture-failure. Pure orchestration —
   * no I/O except via the injected deps.
   */
  async run(opts: GeminiLoopRunOptions): Promise<GeminiLoopResult> {
    const maxTurns = Math.max(1, Math.floor(opts.maxTurns));
    const doneSentinel = opts.doneSentinel ?? DEFAULT_DONE_SENTINEL;
    const continuation = opts.continuationPrompt ?? DEFAULT_CONTINUATION;
    const minInterval = Math.max(0, opts.minTurnIntervalMs ?? 0);
    const turns: GeminiLoopTurn[] = [];

    // --- Turn 1 (one-shot; establishes the session) ---
    const gate0 = this.budgetGate();
    if (!gate0.ok) {
      return {
        sessionHandle: null,
        turns,
        stopReason: 'budget-halt',
        finalOutput: '',
        haltReason: gate0.reason,
      };
    }

    const argv1 = buildGeminiOneShotArgv(opts.model, opts.goalPrompt);
    const r1 = await this.spawn(argv1);
    const done1 = r1.stdout.includes(doneSentinel);
    turns.push({ turn: 1, argv: argv1, ...r1, done: done1 });

    if (r1.exitCode !== 0) {
      return { sessionHandle: null, turns, stopReason: 'spawn-failure', finalOutput: r1.stdout };
    }
    if (done1) {
      return { sessionHandle: null, turns, stopReason: 'done-sentinel', finalOutput: r1.stdout };
    }

    // --- Capture the stable handle (abort, never fall back to 'latest') ---
    const handle = await this.captureHandle(r1);
    if (!handle) {
      return {
        sessionHandle: null,
        turns,
        stopReason: 'handle-capture-failure',
        finalOutput: r1.stdout,
      };
    }

    // --- Turns 2..maxTurns (resume by stable handle) ---
    let lastOutput = r1.stdout;
    for (let turn = 2; turn <= maxTurns; turn++) {
      const gate = this.budgetGate();
      if (!gate.ok) {
        return {
          sessionHandle: handle,
          turns,
          stopReason: 'budget-halt',
          finalOutput: lastOutput,
          haltReason: gate.reason,
        };
      }

      if (minInterval > 0) {
        await this.sleep(minInterval);
      }

      const argv = buildGeminiResumeArgv(opts.model, handle, continuation);
      const r = await this.spawn(argv);
      const done = r.stdout.includes(doneSentinel);
      turns.push({ turn, argv, ...r, done });
      lastOutput = r.stdout;

      if (r.exitCode !== 0) {
        return { sessionHandle: handle, turns, stopReason: 'spawn-failure', finalOutput: r.stdout };
      }
      if (done) {
        return { sessionHandle: handle, turns, stopReason: 'done-sentinel', finalOutput: r.stdout };
      }
    }

    return { sessionHandle: handle, turns, stopReason: 'max-turns', finalOutput: lastOutput };
  }
}
