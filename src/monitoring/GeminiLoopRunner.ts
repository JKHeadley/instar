/**
 * GeminiLoopRunner (need-gem-002, increment 2) — the budget-gated, dark-by-default
 * service that makes the GeminiLoopDriver invocable.
 *
 * A multi-turn gemini loop can run for minutes (several turns × a turn each), so
 * it CANNOT block an HTTP request. `startRun` admits a run (enabled? under
 * concurrency cap? budget ok?), kicks off `driver.run()` in the background, and
 * returns a `runId` immediately; the result lands in a bounded in-memory registry
 * retrievable via `getRun`. Ships DARK (`enabled: false`); the `developmentAgent`
 * gate turns it on for dev agents only.
 *
 * Subscription auth is structural: the runner's spawn dep is the production
 * transport spawn (`buildGeminiChildEnv` strips every billing var), so no run can
 * introduce an API key.
 *
 * Spec: docs/specs/gemini-multi-turn-loop-driver.md
 */

import { randomUUID } from 'node:crypto';
import {
  GeminiLoopDriver,
  type GeminiLoopSpawn,
  type GeminiLoopHandleCapture,
  type GeminiLoopBudgetGate,
  type GeminiLoopResult,
} from './GeminiLoopDriver.js';

export interface GeminiLoopDriverConfig {
  enabled: boolean;
  /** Model passed to every turn (explicit -m bypasses the router classifier). */
  model: string;
  /** Hard cap on turns per run. */
  maxTurns: number;
  /** Min ms between turns (anti-spin). */
  minTurnIntervalMs: number;
  /** Max concurrent runs. 1 keeps shared-cwd handle capture unambiguous. */
  maxConcurrent: number;
  /** Bounded registry size — oldest finished runs are evicted past this. */
  maxRetainedRuns: number;
  /** Sentinel the mentee emits when done. */
  doneSentinel?: string;
}

export type GeminiLoopRunStatus = 'running' | 'done' | 'error';

export interface GeminiLoopRunRecord {
  runId: string;
  status: GeminiLoopRunStatus;
  goalPrompt: string;
  model: string;
  maxTurns: number;
  startedAt: number;
  finishedAt?: number;
  result?: GeminiLoopResult;
  error?: string;
}

export interface GeminiLoopStartRequest {
  goalPrompt: string;
  model?: string;
  maxTurns?: number;
}

export type GeminiLoopStartOutcome =
  | { ok: true; runId: string }
  | { ok: false; reason: 'disabled' | 'at-capacity' | 'budget' | 'invalid'; detail?: string };

export interface GeminiLoopRunnerDeps {
  config: GeminiLoopDriverConfig;
  spawn: GeminiLoopSpawn;
  captureHandle: GeminiLoopHandleCapture;
  budgetGate: GeminiLoopBudgetGate;
  now?: () => number;
  genId?: () => string;
  log?: (msg: string) => void;
}

export class GeminiLoopRunner {
  private readonly config: GeminiLoopDriverConfig;
  private readonly spawn: GeminiLoopSpawn;
  private readonly captureHandle: GeminiLoopHandleCapture;
  private readonly budgetGate: GeminiLoopBudgetGate;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly log: (msg: string) => void;

  private readonly runs = new Map<string, GeminiLoopRunRecord>();
  private activeCount = 0;

  constructor(deps: GeminiLoopRunnerDeps) {
    this.config = deps.config;
    this.spawn = deps.spawn;
    this.captureHandle = deps.captureHandle;
    this.budgetGate = deps.budgetGate;
    this.now = deps.now ?? (() => Date.now());
    this.genId = deps.genId ?? (() => randomUUID());
    this.log = deps.log ?? (() => {});
  }

  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  activeRuns(): number {
    return this.activeCount;
  }

  /**
   * Admit + launch a run. Returns immediately with a runId; the loop runs in the
   * background. Admission order: feature enabled → under concurrency cap → valid
   * goal → budget gate open.
   */
  startRun(req: GeminiLoopStartRequest): GeminiLoopStartOutcome {
    if (!this.isEnabled()) return { ok: false, reason: 'disabled' };
    if (this.activeCount >= this.config.maxConcurrent) {
      return { ok: false, reason: 'at-capacity', detail: `maxConcurrent=${this.config.maxConcurrent}` };
    }
    const goalPrompt = (req.goalPrompt ?? '').trim();
    if (!goalPrompt) return { ok: false, reason: 'invalid', detail: 'goalPrompt is required' };

    const gate = this.budgetGate();
    if (!gate.ok) return { ok: false, reason: 'budget', detail: gate.reason };

    const runId = this.genId();
    const model = (req.model ?? this.config.model) || this.config.model;
    const maxTurns = Number.isInteger(req.maxTurns) && (req.maxTurns as number) > 0
      ? Math.min(req.maxTurns as number, this.config.maxTurns)
      : this.config.maxTurns;

    const record: GeminiLoopRunRecord = {
      runId,
      status: 'running',
      goalPrompt,
      model,
      maxTurns,
      startedAt: this.now(),
    };
    this.runs.set(runId, record);
    this.evictOldFinished();
    this.activeCount += 1;
    this.log(`[gemini-loop] run ${runId} started (model=${model}, maxTurns=${maxTurns})`);

    // Fire-and-forget — do NOT await; the HTTP caller already has the runId.
    void this.execute(record);

    return { ok: true, runId };
  }

  getRun(runId: string): GeminiLoopRunRecord | null {
    return this.runs.get(runId) ?? null;
  }

  listRuns(): GeminiLoopRunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  private async execute(record: GeminiLoopRunRecord): Promise<void> {
    const driver = new GeminiLoopDriver({
      spawn: this.spawn,
      captureHandle: this.captureHandle,
      budgetGate: this.budgetGate,
    });
    try {
      const result = await driver.run({
        model: record.model,
        goalPrompt: record.goalPrompt,
        maxTurns: record.maxTurns,
        minTurnIntervalMs: this.config.minTurnIntervalMs,
        doneSentinel: this.config.doneSentinel,
      });
      record.status = 'done';
      record.result = result;
      record.finishedAt = this.now();
      this.log(`[gemini-loop] run ${record.runId} done (${result.stopReason}, ${result.turns.length} turns)`);
    } catch (err) {
      record.status = 'error';
      record.error = err instanceof Error ? err.message : String(err);
      record.finishedAt = this.now();
      this.log(`[gemini-loop] run ${record.runId} error: ${record.error}`);
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
  }

  /** Keep the registry bounded — drop the oldest FINISHED runs past the cap. */
  private evictOldFinished(): void {
    if (this.runs.size <= this.config.maxRetainedRuns) return;
    const finished = [...this.runs.values()]
      .filter((r) => r.status !== 'running')
      .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
    let over = this.runs.size - this.config.maxRetainedRuns;
    for (const r of finished) {
      if (over <= 0) break;
      this.runs.delete(r.runId);
      over -= 1;
    }
  }
}
