/** Observe-only Verify-Before-Done signal. Never blocks or rewrites a response. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { IntelligenceProvider } from '../core/types.js';
import { scrubSecrets } from './scrubSecrets.js';
import type { EvidenceActionKind, TurnEvidence } from './TurnEvidence.js';
import { ClaimClauseArbiter, type ClaimClauseArbitration } from './ClaimClauseArbiter.js';
import { ClaimObservationAdmissionQueue } from './ClaimObservationAdmissionQueue.js';
import {
  applyClaimCriticalityFloor, assessClaim, prepareClaimObservation, protectedCueGaps,
  ClaimObservationRecorder, newMessageAttemptId,
} from './ClaimObservation.js';

export interface CompletionClaim {
  isCompletionClaim: boolean;
  completionScope: 'this-turn' | 'prior-turn' | 'background' | 'none';
  actionKind: EvidenceActionKind;
  target?: string;
  corroborated: boolean;
  rationale: string;
}

export type CompletionObservationVerdict = 'corroborated' | 'uncorroborated-contradicted' | 'uncorroborated-unknown' | 'not-eligible';

export interface CompletionClaimVerifierOptions {
  intelligence?: IntelligenceProvider | null;
  stateDir: string;
  enabled: boolean;
  dryRun: boolean;
  maxAuditBytes?: number;
  maxQueued?: number;
  maxQueuedPerTopic?: number;
  maxConcurrent?: number;
  queueTtlMs?: number;
  arbiter?: ClaimClauseArbiter;
  generalObservation?: boolean;
  recorder?: ClaimObservationRecorder;
  bootId?: string;
  admissionQueue?: ClaimObservationAdmissionQueue;
}

export interface ClaimObservationContext { messageAttemptId?: string; topicId?: number; originFramework?: 'claude-code';
  sessionSnapshot?: { state: string; elapsedMs: number; revision: string; observedAt: string };
  commitmentSnapshots?: Record<string, { state: string; revision: string; observedAt: string }>;
  guardSnapshots?: Record<string, { state: string; revision: string; observedAt: string }> }

export interface CompletionEnqueueResult { accepted: boolean; reason?: string }
export interface CompletionObserveResult { flagged: boolean; verdict?: CompletionObservationVerdict; claim?: CompletionClaim; reason?: string; arbitration?: ClaimClauseArbitration }
export interface CompletionClaimStats {
  candidateTurns: number;
  classifiedTurns: number;
  noClaimTurns: number;
  invalidOutputTurns: number;
  providerUnavailableTurns: number;
  flaggedTurns: number;
  duplicateTurns: number;
  falsePositiveDispositions: number;
  falseNegativeDispositions: number;
  canaryDriftSignals: number;
  generalAdmittedTurns: number;
  generalClaims: number;
  protectedCueGaps: number;
  coverageIncompleteTurns: number;
  corpusDrops: number;
  retentionFailures: number;
  verdicts: Record<CompletionObservationVerdict, number>;
  updatedAt?: string;
}

export class CompletionClaimVerifier {
  private readonly arbiter: ClaimClauseArbiter;
  private readonly admissionQueue: ClaimObservationAdmissionQueue;
  private readonly authoritativeMessages = new Map<string, { at: number; arbitration: ClaimClauseArbitration }>();
  private counters: CompletionClaimStats;

  constructor(private readonly opts: CompletionClaimVerifierOptions) {
    this.arbiter = opts.arbiter ?? new ClaimClauseArbiter({ intelligence: opts.intelligence });
    this.admissionQueue = opts.admissionQueue ?? new ClaimObservationAdmissionQueue({ maxQueued: opts.maxQueued,
      maxQueuedPerTopic: opts.maxQueuedPerTopic, maxConcurrent: opts.maxConcurrent, queueTtlMs: opts.queueTtlMs });
    this.admissionQueue.setWorker((item) => this.processQueuedObservation(item.message, item.evidence, item.onArbitrated, item.context));
    this.counters = this.readStats();
  }

  static mightContainCompletionClaim(message: string): boolean {
    // Drop-only prefilter: tense/action stems deliberately broad; never decides a positive.
    return /\b(done|sent|ship|shipped|deploy|deployed|handed|commit|committed|push|pushed|merge|merged|restart|restarted|fixed|live|getting\s+.+\s+done)\b/i.test(message);
  }

  /**
   * Constant-time HTTP seam: admits bounded work and returns before intelligence
   * evaluation begins. The route should answer 202 from this result.
   */
  enqueue(
    message: string,
    evidence: TurnEvidence,
    onArbitrated?: (arbitration: ClaimClauseArbitration) => void | Promise<void>,
    context: ClaimObservationContext = {},
  ): CompletionEnqueueResult {
    if (!this.opts.enabled) return { accepted: false, reason: 'disabled' };
    if (!this.opts.generalObservation && !CompletionClaimVerifier.mightContainCompletionClaim(message)) return { accepted: false, reason: 'prefilter-skip' };
    if (Buffer.byteLength(message, 'utf8') > 32_768) { this.bump('coverageIncompleteTurns'); return { accepted: false, reason: 'input-bound' }; }
    const fingerprint = completionFingerprint(message, evidence);
    const result = this.admissionQueue.enqueue({ message, evidence, onArbitrated, context }, fingerprint);
    if (!result.accepted && result.reason === 'duplicate') this.bump('duplicateTurns');
    return result;
  }

  private async processQueuedObservation(
    message: string,
    evidence: TurnEvidence,
    onArbitrated?: (arbitration: ClaimClauseArbitration) => void | Promise<void>,
    context: ClaimObservationContext = {},
  ): Promise<void> {
    try {
      let arbitration: ClaimClauseArbitration;
      try {
        const result = await this.observe(message, evidence, context);
        arbitration = result.arbitration ?? { clauses: [], authoritative: false };
      } catch { /* @silent-fallback-ok — unexpected observation failure routes one conservative result */
        arbitration = { clauses: [], authoritative: false };
      }

      try {
        // Route every clause before publishing suppression authority. If the
        // process or callback fails in between, the legacy sentinel remains
        // authoritative and no future commitment can be lost.
        if (onArbitrated) await onArbitrated(arbitration);
      } catch { /* @silent-fallback-ok — callback failure leaves legacy authority and is never retried */
        return;
      }
      if (arbitration.authoritative) {
        this.authoritativeMessages.set(messageFingerprint(message), { at: Date.now(), arbitration });
      }
    } finally { /* queue accounting is owned by drainQueue.finally */ }
  }

  getRecentAuthoritativeArbitration(message: string, now = Date.now()): ClaimClauseArbitration | null {
    const key = messageFingerprint(message);
    const result = this.authoritativeMessages.get(key);
    if (!result || now - result.at > 60_000) { this.authoritativeMessages.delete(key); return null; }
    return result.arbitration;
  }

  async observe(message: string, evidence: TurnEvidence, context: ClaimObservationContext = {}): Promise<CompletionObserveResult> {
    if (!this.opts.enabled) return { flagged: false, reason: 'disabled' };
    if (!this.opts.generalObservation && !CompletionClaimVerifier.mightContainCompletionClaim(message)) return { flagged: false, reason: 'prefilter-skip' };
    this.bump('candidateTurns');
    if (evidence.unavailable || !evidence.canaryOk || (!this.opts.intelligence && !this.opts.arbiter)) {
      this.bump('providerUnavailableTurns');
      return { flagged: false, reason: 'evidence-or-provider-unavailable' };
    }
    try {
      const prepared = prepareClaimObservation(message, evidence);
      if (prepared.policy !== 'standard-scrubbed') {
        this.bump('coverageIncompleteTurns');
        this.appendAudit({ ts: new Date().toISOString(), evaluated: false, event: 'coverage-incomplete', reason: 'privacy-boundary' });
        return { flagged: false, reason: 'privacy-boundary' };
      }
      if (this.opts.generalObservation) this.bump('generalAdmittedTurns');
      const arbitration = await this.arbiter.arbitrate(prepared.message, prepared.evidence);
      if (!arbitration.authoritative && !arbitration.general) {
        this.bump('invalidOutputTurns');
        return { flagged: false, reason: 'invalid-output', arbitration };
      }
      if (arbitration.authoritative) this.bump('classifiedTurns');
      if (this.opts.generalObservation) {
        const claims = arbitration.general?.claims ?? [];
        const gaps = protectedCueGaps(prepared.message, claims);
        for (const _claim of claims) this.bump('generalClaims');
        for (const _gap of gaps) this.bump('protectedCueGaps');
        if (arbitration.general?.saturated || gaps.length > 0) this.bump('coverageIncompleteTurns');
        const messageAttemptId = context.messageAttemptId ?? newMessageAttemptId();
        for (const claim of claims) {
          const assessment = assessClaim(claim, { evidence: prepared.evidence, sessionSnapshot: context.sessionSnapshot,
            commitmentSnapshots: context.commitmentSnapshots, guardSnapshots: context.guardSnapshots });
          const finalCriticality = applyClaimCriticalityFloor(claim);
          if (this.opts.recorder && !this.opts.recorder.record({ messageAttemptId, topicId: context.topicId,
            claim, assessment, finalCriticality, dryRun: this.opts.dryRun,
            bootId: this.opts.bootId ?? 'unknown-boot', modelDoor: arbitration.generalModel?.framework,
            modelId: arbitration.generalModel?.model, inputTokens: arbitration.generalModel?.inputTokens,
            outputTokens: arbitration.generalModel?.outputTokens })) this.bump('corpusDrops');
        }
        if (gaps.length > 0) this.appendAudit({ ts: new Date().toISOString(), evaluated: true,
          event: 'protected-cue-unextracted', gapKinds: gaps, dryRun: this.opts.dryRun });
      }
      if (!arbitration.authoritative) {
        this.bump('invalidOutputTurns');
        return { flagged: false, reason: 'invalid-legacy-output', arbitration };
      }
      const completionClauses = arbitration.clauses.filter((clause) => clause.label === 'completed-or-in-progress-assertion');
      if (completionClauses.length === 0) {
        this.bump('noClaimTurns');
        this.bumpVerdict('not-eligible');
        return { flagged: false, reason: 'not-eligible', arbitration };
      }
      const assessed = completionClauses.map((clause) => {
        const claim: CompletionClaim = {
          isCompletionClaim: true, completionScope: clause.completionScope,
          actionKind: clause.actionKind, ...(clause.target ? { target: clause.target } : {}),
          corroborated: clause.corroborated, rationale: clause.rationale,
        };
        return { claim, verdict: decideVerdict(claim, evidence) };
      });
      const contradicted = assessed.find((item) => item.verdict === 'uncorroborated-contradicted');
      const selected = contradicted ?? assessed[0];
      const { claim, verdict } = selected;
      const flagged = !!contradicted;
      this.bumpVerdict(verdict);
      if (flagged) this.bump('flaggedTurns');
      this.appendAudit({
        ts: new Date().toISOString(), dryRun: this.opts.dryRun, evaluated: true, flagged, verdict,
        actionKind: claim.actionKind, target: claim.target,
        rationale: scrubSecrets(claim.rationale).slice(0, 500), hadToolCalls: evidence.hadToolCalls,
      });
      return { flagged, verdict, claim, arbitration, ...(verdict === 'not-eligible' ? { reason: 'not-eligible' } : {}) };
    } catch { /* @silent-fallback-ok — content-free provider-unavailable metric records conservative fallback */
      this.bump('providerUnavailableTurns');
      return { flagged: false, reason: 'provider-failure' };
    }
  }

  /** Content-free aggregate metrics safe for /metrics/features. */
  stats(): CompletionClaimStats { return JSON.parse(JSON.stringify(this.counters)) as CompletionClaimStats; }

  /** Operator/reviewer disposition seam used to measure precision and misses. */
  recordDisposition(kind: 'false-positive' | 'false-negative'): void {
    this.bump(kind === 'false-positive' ? 'falsePositiveDispositions' : 'falseNegativeDispositions');
  }
  recordCanaryDrift(): void { this.bump('canaryDriftSignals'); }
  recordRetentionFailures(count: number): void { for (let i = 0; i < count; i++) this.bump('retentionFailures'); }

  readAudit(limit = 100): Array<Record<string, unknown>> {
    if (this.opts.recorder) return this.opts.recorder.readAudit(limit);
    try {
      const file = path.join(this.opts.stateDir, 'logs', 'completion-claim-audit.jsonl');
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-Math.max(1, Math.min(limit, 500)))
        .flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { /* @silent-fallback-ok — malformed untrusted audit row is excluded */ return []; } });
    } catch { /* @silent-fallback-ok — read surface is advisory and cannot gain authority */ return []; }
  }
  readPoolAggregates(limit = 100): Array<Record<string, unknown>> { return this.opts.recorder?.readPoolAggregates(limit) ?? []; }
  readPoolPage(limit = 100, cursor?: string): { records: Array<Record<string, unknown>>; nextCursor?: string } {
    return this.opts.recorder?.readPoolPage(limit, cursor) ?? { records: [] };
  }

  private appendAudit(row: Record<string, unknown>): void {
    if (this.opts.recorder) { this.opts.recorder.recordEvent(row); return; }
    try {
      const file = path.join(this.opts.stateDir, 'logs', 'completion-claim-audit.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > (this.opts.maxAuditBytes ?? 2_000_000)) {
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    } catch { /* @silent-fallback-ok — observe-only audit cannot alter or suppress the response */ }
  }

  private statsFile(): string { return path.join(this.opts.stateDir, 'logs', 'completion-claim-stats.json'); }

  private readStats(): CompletionClaimStats {
    const empty = emptyStats();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statsFile(), 'utf8')) as Partial<CompletionClaimStats>;
      for (const key of Object.keys(empty) as Array<keyof CompletionClaimStats>) {
        if (key === 'verdicts' || key === 'updatedAt') continue;
        if (typeof parsed[key] === 'number' && Number.isFinite(parsed[key]) && (parsed[key] as number) >= 0) {
          (empty[key] as number) = Math.floor(parsed[key] as number);
        }
      }
      if (parsed.verdicts && typeof parsed.verdicts === 'object') for (const verdict of Object.keys(empty.verdicts) as CompletionObservationVerdict[]) {
        const count = parsed.verdicts[verdict];
        if (typeof count === 'number' && Number.isFinite(count) && count >= 0) empty.verdicts[verdict] = Math.floor(count);
      }
      if (typeof parsed.updatedAt === 'string') empty.updatedAt = parsed.updatedAt;
    } catch { /* @silent-fallback-ok — counters are signal-only; corrupt/absent state restarts at zero */ }
    return empty;
  }

  private bump(key: Exclude<keyof CompletionClaimStats, 'verdicts' | 'updatedAt'>): void {
    this.counters[key]++;
    this.persistStats();
  }

  private bumpVerdict(verdict: CompletionObservationVerdict): void {
    this.counters.verdicts[verdict]++;
    this.persistStats();
  }

  private persistStats(): void {
    try {
      this.counters.updatedAt = new Date().toISOString();
      const file = this.statsFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.counters)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* @silent-fallback-ok — metrics are signal-only and cannot affect the response */ }
  }
}

function emptyStats(): CompletionClaimStats {
  return {
    candidateTurns: 0, classifiedTurns: 0, noClaimTurns: 0, invalidOutputTurns: 0,
    providerUnavailableTurns: 0, flaggedTurns: 0, duplicateTurns: 0,
    falsePositiveDispositions: 0, falseNegativeDispositions: 0, canaryDriftSignals: 0,
    generalAdmittedTurns: 0, generalClaims: 0, protectedCueGaps: 0, coverageIncompleteTurns: 0, corpusDrops: 0, retentionFailures: 0,
    verdicts: { corroborated: 0, 'uncorroborated-contradicted': 0, 'uncorroborated-unknown': 0, 'not-eligible': 0 },
  };
}

function completionFingerprint(message: string, evidence: TurnEvidence): string {
  return createHash('sha256').update(`${scrubSecrets(message).slice(0, 16_384)}\n${JSON.stringify(evidence)}`).digest('hex');
}
function messageFingerprint(message: string): string {
  return createHash('sha256').update(scrubSecrets(message).slice(0, 16_384)).digest('hex');
}

export function parseCompletionClaim(raw: string): CompletionClaim | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const v = JSON.parse(match?.[0] ?? raw) as Record<string, unknown>;
    const scopes = new Set(['this-turn', 'prior-turn', 'background', 'none']);
    const kinds = new Set(['sent', 'deployed', 'handed-off', 'committed', 'pushed', 'merged', 'restarted', 'fixed', 'other']);
    if (typeof v.isCompletionClaim !== 'boolean' || !scopes.has(String(v.completionScope))
      || !kinds.has(String(v.actionKind)) || typeof v.corroborated !== 'boolean') return null;
    return {
      isCompletionClaim: v.isCompletionClaim,
      completionScope: String(v.completionScope) as CompletionClaim['completionScope'],
      actionKind: String(v.actionKind) as EvidenceActionKind,
      ...(typeof v.target === 'string' ? { target: v.target.slice(0, 200) } : {}),
      corroborated: v.corroborated,
      rationale: typeof v.rationale === 'string' ? v.rationale : '',
    };
  } catch { /* @silent-fallback-ok — malformed model output is non-authoritative */ return null; }
}

export function decideVerdict(claim: CompletionClaim, evidence: TurnEvidence): CompletionObservationVerdict {
  if (!claim.isCompletionClaim || claim.completionScope !== 'this-turn') return 'not-eligible';
  if (claim.actionKind === 'other') return claim.corroborated ? 'corroborated' : 'uncorroborated-unknown';
  const target = normalizeTarget(claim.target);
  const matching = evidence.toolCalls.some((item) => {
    if (!item.ok || item.actionKind !== claim.actionKind) return false;
    if (!target) return true;
    const evidenceTarget = normalizeTarget(item.targetSummary);
    if (evidenceTarget?.startsWith('id:')) {
      const direct = `id:${createHash('sha256').update(target).digest('hex').slice(0, 16)}`;
      if (direct === evidenceTarget) return true;
      // Extractors may retain a safe remote/target prefix. Hash each plausible
      // suffix without ever recovering or persisting the original identifier.
      const parts = target.split('/');
      return parts.some((_, index) => `id:${createHash('sha256').update(parts.slice(index).join('/')).digest('hex').slice(0, 16)}` === evidenceTarget);
    }
    return !!evidenceTarget && (evidenceTarget === target || evidenceTarget.endsWith(`/${target}`) || target.endsWith(`/${evidenceTarget}`));
  });
  return matching ? 'corroborated' : 'uncorroborated-contradicted';
}

function normalizeTarget(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/^refs\/heads\//, '');
  return normalized || undefined;
}
