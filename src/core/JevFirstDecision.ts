/**
 * One shared, reversible Jev-first route for bounded yes/no decision points.
 * The caller's incumbent remains the authority whenever Jev cannot settle the
 * complete question. No caller may use this route without an auditable context.
 */
import { createHash } from 'node:crypto';
import { scrubForStore } from './durableSecretScrub.js';
import type { DecisionRowInput } from './JudgmentProvenanceLog.js';

export type JevStage = 'off' | 'shadow' | 'live';
export interface JevBand { noMax: number; yesMin: number }
export interface JevPoint {
  id: string;
  promptId: string;
  question: string;
  stage: JevStage;
  band: JevBand;
  model: string;
  timeoutMs: number;
  maxStateBytes: number;
  auditRate: number;
  /** A positive may need structured details from the incumbent; only settle the safe direction. */
  settleOnly?: 'yes' | 'no';
  /** Exact task-matched benchmark id, if one exists for this prompt. */
  benchmarkTaskId?: string;
  /** Describes why this incumbent was selected; recorded for every call. */
  fallbackSelection: 'benchmark' | 'incumbent-no-benchmark';
  /** Why rows from this point cannot yet be graded against an outcome. */
  gradingGap?: string;
}
export interface JevAnswer { model: string; probability: number; ms: number; tokensIn?: number }
export interface FallbackAnswer { answer: boolean; model: string; ms?: number; tokensIn?: number; tokensOut?: number }
export interface JevDecisionResult {
  answer: boolean;
  source: 'jev' | 'incumbent';
  reason: 'confident' | 'requires-detail' | 'audit' | 'shadow' | 'off' | 'no-key' | 'oversize' | 'scrub-error' | 'jev-error' | 'wrong-model' | 'invalid-answer' | 'uncertain' | 'record-error';
  probability?: number;
  fallback?: FallbackAnswer;
  recordId?: string;
}
export interface JevFirstDeps {
  readKey: () => string | null;
  askJev: (input: { key: string; state: string; question: string; model: string; timeoutMs: number }) => Promise<JevAnswer>;
  recordDecision: (row: DecisionRowInput) => string | null | Promise<string | null>;
  random?: () => number;
  now?: () => number;
  onJevCall?: (pointId: string, answer: JevAnswer | null) => void;
  onOutcome?: (pointId: string, reason: JevDecisionResult['reason'], source: JevDecisionResult['source'], auditDisagree: boolean | null) => void;
}

function validPoint(p: JevPoint): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(p.id)
    && /^[A-Za-z0-9_-]{1,64}$/.test(p.promptId)
    && p.question.trim().length > 0 && p.question.length <= 2_000
    && Number.isFinite(p.band.noMax) && Number.isFinite(p.band.yesMin)
    && p.band.noMax >= 0 && p.band.noMax < p.band.yesMin && p.band.yesMin <= 1
    && p.timeoutMs >= 100 && p.timeoutMs <= 10_000
    && p.maxStateBytes > 0 && p.maxStateBytes <= 32_000
    && (p.settleOnly === undefined || p.settleOnly === 'yes' || p.settleOnly === 'no')
    && p.auditRate >= 0 && p.auditRate <= 1;
}

/** Pure threshold decision. Missing/invalid probabilities are uncertain. */
export function settleJevProbability(probability: unknown, band: JevBand): boolean | null {
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
  if (probability <= band.noMax) return false;
  if (probability >= band.yesMin) return true;
  return null;
}

export class JevFirstDecision {
  constructor(private readonly deps: JevFirstDeps) {}

  async decide(input: { point: JevPoint; state: string; fallback: () => Promise<FallbackAnswer> }): Promise<JevDecisionResult> {
    const { point, state, fallback } = input;
    if (!validPoint(point)) throw new Error(`invalid Jev decision point: ${point.id}`);
    const now = this.deps.now ?? Date.now;
    const stateHash = createHash('sha256').update(state).digest('hex');
    const bytes = Buffer.byteLength(state, 'utf8');
    const scrub = bytes <= point.maxStateBytes ? scrubForStore(state, { maxBytes: point.maxStateBytes }) : null;
    let reason: JevDecisionResult['reason'] = 'off';
    let jev: JevAnswer | undefined;
    let selected: boolean | null = null;
    let key: string | null = null;
    if (point.stage !== 'off') {
      if (bytes > point.maxStateBytes) reason = 'oversize';
      else if (!scrub || scrub.error || scrub.truncated) reason = 'scrub-error';
      else {
        try { key = this.deps.readKey(); } catch {
          // @silent-fallback-ok — no key is an allowed one-provider state;
          // reason=no-key is recorded and the incumbent handles the decision.
          key = null;
        }
        if (!key) reason = 'no-key';
        else {
          try {
            jev = await this.deps.askJev({ key, state: scrub.text, question: point.question, model: point.model, timeoutMs: point.timeoutMs });
            try { this.deps.onJevCall?.(point.id, jev); } catch {
              /* @silent-fallback-ok — a metrics write cannot change the decision */
            }
            if (jev.model !== point.model) reason = 'wrong-model';
            else {
              selected = settleJevProbability(jev.probability, point.band);
              reason = selected === null
                ? (Number.isFinite(jev.probability) && jev.probability >= 0 && jev.probability <= 1 ? 'uncertain' : 'invalid-answer')
                : 'confident';
              if (selected !== null && point.settleOnly && (selected ? 'yes' : 'no') !== point.settleOnly) {
                selected = null;
                reason = 'requires-detail';
              }
            }
          } catch {
            reason = 'jev-error';
            try { this.deps.onJevCall?.(point.id, null); } catch {
              /* @silent-fallback-ok — the Jev failure already routes to the incumbent */
            }
          }
        }
      }
    }
    if (point.stage === 'shadow' && selected !== null) reason = 'shadow';
    const audit = point.stage === 'live' && selected !== null && reason === 'confident'
      && (this.deps.random ?? Math.random)() < point.auditRate;
    if (audit) reason = 'audit';
    let incumbent: FallbackAnswer | undefined;
    if (point.stage !== 'live' || selected === null || audit) incumbent = await fallback();
    const answer = incumbent?.answer ?? selected;
    if (answer === null) throw new Error('Jev decision has neither Jev nor incumbent answer');
    const source: JevDecisionResult['source'] = incumbent ? 'incumbent' : 'jev';
    const auditDisagree = incumbent && selected !== null ? incumbent.answer !== selected : null;
    const row: DecisionRowInput = {
      component: 'JevFirstDecision', decisionPoint: point.id, promptId: point.promptId,
      context: {
        stateSha256: stateHash, stateBytes: bytes, stage: point.stage, band: point.band,
        promptVersion: point.promptId, gradingGap: point.gradingGap ?? 'no-linked-outcome-for-commitment-prefilter',
        jevModel: point.model, jevProbability: jev?.probability ?? null, jevMs: jev?.ms ?? null,
        jevTokensIn: jev?.tokensIn ?? null, fallbackModel: incumbent?.model ?? null,
        fallbackSelection: point.fallbackSelection, benchmarkTaskId: point.benchmarkTaskId ?? null,
        handoffReason: reason, auditDisagree,
        _contentFull: {
          question: point.question,
          state: scrub && !scrub.error && !scrub.truncated ? scrub.text : '[withheld: context unavailable]',
        },
      },
      optionsPresented: ['yes', 'no'], decision: answer ? 'yes' : 'no', reason,
      floor: `no<=${point.band.noMax};yes>=${point.band.yesMin}`,
      fallbackRung: source, arbiter: true, model: incumbent?.model ?? jev?.model,
      tokensIn: incumbent?.tokensIn ?? jev?.tokensIn,
      tokensOut: incumbent?.tokensOut, latencyMs: incumbent?.ms ?? jev?.ms,
    };
    let recordId: string | null = null;
    try { recordId = await this.deps.recordDecision(row); } catch {
      /* @silent-fallback-ok — record-error routes a Jev settlement to the incumbent below */
    }
    if (!recordId && source === 'jev') {
      const recovered = await fallback();
      reason = 'record-error';
      try { this.deps.onOutcome?.(point.id, reason, 'incumbent', null); } catch {
        /* @silent-fallback-ok — a metrics write cannot change the incumbent result */
      }
      return { answer: recovered.answer, source: 'incumbent', reason, probability: jev?.probability, fallback: recovered };
    }
    try { this.deps.onOutcome?.(point.id, reason, source, auditDisagree); } catch {
      /* @silent-fallback-ok — a metrics write cannot change the settled result */
    }
    return { answer, source, reason, ...(jev ? { probability: jev.probability } : {}), ...(incumbent ? { fallback: incumbent } : {}), ...(recordId ? { recordId } : {}) };
  }
}

/** Strict TypeSafe System One transport; inject `fetchImpl` in tests. */
export function createJevAsk(fetchImpl: typeof fetch = fetch): JevFirstDeps['askJev'] {
  return async ({ key, state, question, model, timeoutMs }) => {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, model, questions: { decision: { type: 'noul', instructions: question } } }),
        signal: ctrl.signal,
      });
      if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
      const body = await response.json() as { model?: unknown; answers?: { decision?: { noul?: unknown } }; usage?: { input_tokens?: unknown } };
      return {
        model: typeof body.model === 'string' ? body.model : '',
        probability: typeof body.answers?.decision?.noul === 'number' ? body.answers.decision.noul : NaN,
        ms: Date.now() - t0,
        ...(typeof body.usage?.input_tokens === 'number' ? { tokensIn: body.usage.input_tokens } : {}),
      };
    } finally { clearTimeout(timer); }
  };
}
