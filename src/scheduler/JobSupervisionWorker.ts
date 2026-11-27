/**
 * Per-result judgment worker. It consumes the durable attempt queue and never
 * re-executes a job. The code-owned audit gate and a separate cohort gate must
 * both be open before the server constructs this worker.
 * @self-action-controller: job-supervision-provider-retry
 */
import crypto from 'node:crypto';
import { bandFor } from '../core/JevCascade.js';
import { triageQuestions, TRIAGE_JEV_MODEL } from './JobResultTriage.js';
import { SUPERVISION_EVIDENCE_POLICY } from './JobSupervisionEvidence.js';
import { buildJobReplacementPrompt, JOB_REPLACEMENT_PROMPT_HASH } from './JobSupervisionReplacementPrompt.js';
import type { JobSupervisionStore, SupervisionVerdict } from './JobSupervisionStore.js';

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DECISION_POINT = 'job-result-supervision-v2';
const JEV_TIMEOUT_MS = 15_000;
const REPLACEMENT_DAILY_BUDGET = Object.freeze({ maxCalls: 100,
  maxInputTokens: 250_000, reserveInputTokens: 25_000 });

export interface ReplacementChoice {
  model: string;
  provider: string;
  /** True only after the job-shaped benchmark and audit readiness checks. */
  benchmarkReady: boolean;
  /** Receives the exact code-owned prompt whose hash is committed pre-call. */
  call(prompt: string, runId: string, signal: AbortSignal,
    observe: (value: { actualModel?: string; actualProvider?: string;
      tokensIn?: number; tokensOut?: number; costUsd?: number }) => void): Promise<{
    verdict: Exclude<SupervisionVerdict, null>;
    actualModel: string;
    actualProvider: string;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    /** A parsed but malformed reply is a failed call, not a cannot-tell verdict. */
    formatValid: boolean;
  }>;
}

export interface JobSupervisionWorkerDeps {
  store: JobSupervisionStore;
  readJevKey: () => string | null;
  /** Benchmarked Haiku or Luna; absent on one-provider agents without proof. */
  replacement?: () => ReplacementChoice | null;
  /** The caller wires this only when every model call is registered and gradeable. */
  auditReady: () => boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onAttention?: (attemptId: string, reason: string) => void;
}

interface JevPayload {
  model?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
  answers?: Record<string, unknown>;
}

function sha(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }

function choice(answer: unknown): { label: string; p: number } | null {
  if (!answer || typeof answer !== 'object') return null;
  const a = answer as { choice?: unknown; probabilities?: { needs_session?: unknown } };
  const p = a.probabilities?.needs_session;
  if (typeof a.choice !== 'string' || !['routine', 'needs_session', 'cannot_tell'].includes(a.choice)
    || typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null;
  return { label: a.choice, p };
}

export function parseJevSupervisionVerdict(payload: unknown): Exclude<SupervisionVerdict, null> {
  if (!payload || typeof payload !== 'object') return 'cannot-tell';
  const answers = (payload as { answers?: Record<string, unknown> }).answers;
  const forward = choice(answers?.triage);
  const reverse = choice(answers?.triage_rev);
  if (!forward || !reverse || forward.label !== reverse.label) return 'cannot-tell';
  if (forward.label === 'cannot_tell') return 'cannot-tell';
  const band = bandFor('needs_session');
  if (forward.p >= band.lo && forward.p <= band.hi) return 'cannot-tell';
  if (forward.label === 'needs_session' && forward.p > band.hi) return 'needs-session';
  if (forward.label === 'routine' && forward.p < band.lo) return 'routine';
  return 'cannot-tell';
}

export class JobSupervisionWorker {
  private readonly deps: JobSupervisionWorkerDeps;
  private running = false;

  constructor(deps: JobSupervisionWorkerDeps) { this.deps = deps; }

  /** Process a bounded oldest-first page; every result retains its own verdict. */
  async drain(limit = 100): Promise<number> {
    if (this.running || !this.deps.auditReady()) return 0;
    this.running = true;
    let processed = 0;
    try {
      this.deps.store.expireLeases(this.now());
      this.deps.store.expireRetries(this.now());
      for (const attempt of this.deps.store.claimable(this.now(), Math.min(limit, 2000))) {
        await this.process(attempt.attemptId);
        processed++;
      }
      return processed;
    } finally { this.running = false; }
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private async process(attemptId: string): Promise<void> {
    const row = this.deps.store.get(attemptId);
    const evidence = this.deps.store.evidenceText(attemptId);
    if (!row || !evidence || sha(evidence) !== row.evidenceHash) {
      this.deps.store.markUnchecked(attemptId, 'evidence-withheld', this.now());
      return;
    }
    let key: string | null;
    try { key = this.deps.readJevKey(); } catch { key = null; /* @silent-fallback-ok — provider-unavailable is journaled below. */ }
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (!key || this.deps.store.countCalls('jev', `${today}T00:00:00.000Z`) >= 1500) {
      this.deps.store.markUnchecked(attemptId, 'provider-unavailable', this.now());
      await this.useReplacement(attemptId, evidence);
      return;
    }
    const questions = triageQuestions();
    const promptHash = sha(JSON.stringify(questions));
    const audit = this.deps.store.beginCall({ attemptId, provider: 'jev', decisionPoint: DECISION_POINT,
      promptHash, evidencePolicyHash: sha(SUPERVISION_EVIDENCE_POLICY), evidenceHash: row.evidenceHash!,
      intendedModel: TRIAGE_JEV_MODEL, leaseMs: JEV_TIMEOUT_MS + 1000, now: this.now() });
    if (!audit) { this.deps.store.markUnchecked(attemptId, 'audit-refused', this.now()); return; }
    const started = this.now();
    let failure: string | null = null;
    let payload: JevPayload | null = null;
    try {
      const response = await (this.deps.fetchImpl ?? fetch)(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: evidence, model: TRIAGE_JEV_MODEL, questions }),
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
      if (!response.ok) failure = 'provider-error';
      else payload = await response.json() as JevPayload;
      if (payload && payload.model !== TRIAGE_JEV_MODEL) failure = 'provider-unavailable';
    } catch (error) {
      failure = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? 'provider-timeout' : 'provider-error';
    }
    if (failure || !payload) {
      this.deps.store.failCall(attemptId, audit.epoch, failure ?? 'provider-error', this.now());
      await this.useReplacement(attemptId, evidence);
      return;
    }
    const verdict = parseJevSupervisionVerdict(payload);
    const settled = this.deps.store.settleCall({ attemptId, epoch: audit.epoch,
      actualProvider: 'typesafe-api', actualModel: TRIAGE_JEV_MODEL, verdict,
      latencyMs: this.now() - started, tokensIn: payload.usage?.input_tokens,
      tokensOut: payload.usage?.output_tokens, now: this.now() });
    if (settled === 'settled') this.afterVerdict(attemptId);
  }

  private async useReplacement(attemptId: string, evidence: string): Promise<void> {
    const choice = this.deps.replacement?.() ?? null;
    if (!choice?.benchmarkReady || !choice.model || !choice.provider) {
      this.deps.onAttention?.(attemptId, 'replacement-unavailable');
      return;
    }
    const row = this.deps.store.get(attemptId);
    if (!row?.evidenceHash || sha(evidence) !== row.evidenceHash) return;
    const dayStart = `${new Date(this.now()).toISOString().slice(0, 10)}T00:00:00.000Z`;
    const used = this.deps.store.replacementBudgetSince(dayStart);
    if (used.calls >= REPLACEMENT_DAILY_BUDGET.maxCalls
      || used.inputTokens + REPLACEMENT_DAILY_BUDGET.reserveInputTokens > REPLACEMENT_DAILY_BUDGET.maxInputTokens) {
      this.deps.store.markUnchecked(attemptId, 'replacement-budget-exhausted', this.now());
      this.deps.onAttention?.(attemptId, 'replacement-budget-exhausted');
      return;
    }
    const audit = this.deps.store.beginCall({ attemptId, provider: 'replacement', decisionPoint: DECISION_POINT,
      promptHash: JOB_REPLACEMENT_PROMPT_HASH, evidencePolicyHash: sha(SUPERVISION_EVIDENCE_POLICY),
      evidenceHash: row.evidenceHash, intendedModel: choice.model, leaseMs: 30_000,
      dailyBudget: REPLACEMENT_DAILY_BUDGET, now: this.now() });
    if (!audit) {
      this.deps.store.markUnchecked(attemptId, 'audit-refused', this.now());
      return;
    }
    const started = this.now();
    const controller = new AbortController();
    const observed: { actualModel?: string; actualProvider?: string;
      tokensIn?: number; tokensOut?: number; costUsd?: number } = {};
    let failed = false;
    const observe = (value: typeof observed): void => {
      Object.assign(observed, value);
      if (failed) {
        // The provider may finish reporting usage after our timeout. This can
        // enrich the exact failed call, but cannot revive its verdict.
        try { this.deps.store.recordLateFailedCallObservation(attemptId, audit.epoch, observed); }
        catch { /* @silent-fallback-ok — Store may have closed during shutdown; the reserved budget remains. */ }
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('replacement-timeout')); }, 30_000);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([choice.call(buildJobReplacementPrompt(evidence), row.runId, controller.signal, observe), timeout]);
      if (result.formatValid !== true) {
        this.deps.store.failCall(attemptId, audit.epoch, 'provider-format-error', this.now(), {
          actualProvider: result.actualProvider, actualModel: result.actualModel,
          latencyMs: this.now() - started, tokensIn: result.tokensIn,
          tokensOut: result.tokensOut, costUsd: result.costUsd,
        });
        return;
      }
      if (result.actualModel !== choice.model || result.actualProvider !== choice.provider) {
        this.deps.store.failCall(attemptId, audit.epoch, 'provider-model-mismatch', this.now(), {
          actualProvider: result.actualProvider, actualModel: result.actualModel,
          latencyMs: this.now() - started, tokensIn: result.tokensIn,
          tokensOut: result.tokensOut, costUsd: result.costUsd,
        });
        return;
      }
      const settled = this.deps.store.settleCall({ attemptId, epoch: audit.epoch,
        actualProvider: result.actualProvider, actualModel: result.actualModel,
        verdict: result.verdict, latencyMs: this.now() - started,
        tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd, now: this.now() });
      if (settled === 'settled') this.afterVerdict(attemptId);
    } catch (error) {
      failed = this.deps.store.failCall(attemptId, audit.epoch,
        error instanceof Error && error.message === 'replacement-timeout' ? 'provider-timeout' : 'provider-error',
        this.now(), { ...observed, latencyMs: this.now() - started });
    } finally { if (timer) clearTimeout(timer); }
  }

  private afterVerdict(attemptId: string): void {
    const row = this.deps.store.get(attemptId);
    // Only a separately verified empty grade pass can provide a positive
    // production outcome for this first script. The ordinary server receipt
    // is included in Jev's input and is never itself a grade.
    if (row?.slug === 'llm-decision-grading' && row.status === 'resolved'
      && row.verdict === 'routine' && row.evidenceSufficient) {
      const proof = this.deps.store.gradePassIdleProof(row.runId);
      if (proof) {
        try {
          this.deps.store.gradeOutcome({ attemptId, evidenceId: proof.evidenceId,
            ruleId: proof.ruleId, gradedBy: 'JobGradePassEffectVerifier', grade: 'correct', now: this.now() });
        } catch {
          this.deps.onAttention?.(attemptId, 'outcome-grading-failed');
        }
      }
    }
    if (row?.status !== 'unresolved') return;
    // Automatic investigation stays closed until a real OS isolation boundary
    // is attested. An old unrestricted triage session is never used here.
    this.deps.store.blockInvestigation(attemptId, 'investigation-unavailable', this.now());
    this.deps.onAttention?.(attemptId, 'investigation-unavailable');
  }
}
