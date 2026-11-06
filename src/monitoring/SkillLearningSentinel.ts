/**
 * SkillLearningSentinel — procedural memory: repeated requests become skills
 * that earn their keep (docs/specs/skill-learning-sentinel.md, slice 1:
 * observe → floor → rung/arbiter → draft → lint → cross-family review →
 * shadow proposal). Ships OFF (`monitoring.skillLearning.enabled`); in slice 1
 * `mode: shadow` is the only acting mode: every draft lands under
 * `<stateDir>/skill-learning/proposals/<name>/` — a directory no framework
 * discovers — and NOTHING is written under `.instar/skills`, `.claude/skills`
 * or `.agents/skills`.
 *
 * Tick (every `tickMinutes`): ledger ingest → classifier tick (1A's, through
 * an injected `{tick()}`) → outcome windows close → per key: floor (§3.3) →
 * default rung + arbiter (§3.4, both logged) → RunSlice evidence → drafter →
 * structural lint + semantic flags → cross-family review → proposal write.
 * Every phase failure is reported to DegradationReporter and counted; a tick
 * never throws out. LLM calls go through the sentinel's OWN LlmQueue
 * (`maxConcurrent: 1`, `maxDailyCents: llm.maxDailyCents`); an admission
 * refusal is counted and the key is retried next tick. Every judgment is
 * recorded through JudgmentProvenanceLog (`arbiter: true`); an unrecorded
 * judgment is discarded (fail closed, §3).
 *
 * Self-action posture (registered as `skill-learning-tick` in
 * src/testing/selfActionRegistry.ts): one classify/draft batch per
 * `llm.batchSize` keys per tick; every key reaches a durable verdict row
 * (draft → proposal exists; wait/never/refused → an unexpired VerdictRow holds
 * it until the re-ask horizon), so with an empty backlog a tick makes ZERO
 * calls. The growth notice is a SIGNAL (attention item, silent) at most once
 * per 7-day window — never a refusal (§3.3 "growth signal, not a wall").
 */
/* @self-action-controller: skill-learning-tick */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { featureEvidence as sharedFeatureEvidence, type FeatureEvidenceInput } from './FeatureEvidenceLog.js';
import { buildIntelligenceProvider, type IntelligenceFramework } from '../core/intelligenceProviderFactory.js';
import type { IntelligenceProvider } from '../core/types.js';
import type { TopicMemory } from '../memory/TopicMemory.js';
import { resolveFrameworkTranscriptPath, type SessionFramework } from '../core/FrameworkSessionStore.js';
import { HumanAsDetectorLog } from './HumanAsDetectorLog.js';
import { Ledger } from './skillLearning/Ledger.js';
import { Outcomes } from './skillLearning/Outcomes.js';
import { Classifier } from './skillLearning/Classifier.js';
import { SeamFilter, installSkillLearningSeamFilter, skillLearningUnlinkedMessages, type AttachSeamsInput } from './skillLearning/SeamFilter.js';
import { LlmQueue, LlmQueueAdmissionError } from './LlmQueue.js';
import { scrubSecrets } from './scrubSecrets.js';
import { buildBoundedContext, type DecisionRowInput } from '../core/JudgmentProvenanceLog.js';
import { evaluateFloor, type FloorResult } from './skillLearning/Floor.js';
import { buildArbiterPrompt, decideKey, parseArbiterOutput, type ArbiterContext, type ArbiterDecision } from './skillLearning/Arbiter.js';
import { readRunSlice, renderOutline, type RunSlice } from './skillLearning/RunSlice.js';
import {
  buildDrafterPrompt, buildReviewPrompt, familyOfFramework, parseDrafterOutput, parseReviewOutput, parseSkillDoc, pickReviewer,
  renderProposalSkillMd, validateDraftAction, validSkillName,
  type CleanRunEvidence, type ExistingSkill, type FamilyProvider, type ParsedSkillDoc,
} from './skillLearning/Drafter.js';
import { lintDraft, DRAFT_BODY_MAX_CHARS } from './skillLearning/Lint.js';
import {
  SKILL_LEARNING_PATHS,
  type EventRow, type LearnedSkillSummary, type LedgerReader, type LedgerWriter, type OutcomeRow, type ProposalSidecar,
  type ProposalSummary, type RequestRow, type RowSource, type SkillLearningConfig, type SkillLearningSentinelLike,
  type SkillLearningStatus, type VerdictRow,
} from './skillLearning/types.js';

export const SKILL_LEARNING_FEATURE = 'monitoring.skillLearning';
const COMPONENT_DRAFTER = 'skillLearning.drafter';
const COMPONENT_REVIEWER = 'skillLearning.reviewer';
const WEEK_MS = 7 * 86_400_000;
const LEARNED_ORIGIN_KEY = 'instar-learned-origin';

/** The attention-item shape the sentinel raises (TelegramAdapter.createAttentionItem's observation subset). */
export interface SkillLearningAttentionItem {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  conditionKey: string;
  silent: true;
}

export interface SkillLearningDegradationEvent {
  feature: string; primary: string; fallback: string; reason: string; impact: string;
}

export interface JudgmentRecorder {
  recordDecision(input: DecisionRowInput): string | null;
  isRecordingLive(): boolean;
}

export interface SkillLearningSentinelDeps {
  config: SkillLearningConfig;
  /** The `.instar` directory (SKILL_LEARNING_PATHS are relative to it). */
  stateDir: string;
  /** The agent home: holds `.instar/skills`, `.claude/skills`, `.agents/skills`. */
  projectDir: string;
  machineId: string;
  ledger: LedgerReader & LedgerWriter;
  /** 1A's seam catch-up (TopicMemory watermark), when wired. */
  ingest?: { ingestNew(): Promise<void> | void };
  /** 1A's batch classifier tick, when wired (decoupled through this seam). */
  classifier?: { tick(): Promise<unknown> | unknown };
  /** 1A's outcome-window closer, when wired. */
  outcomes?: { close(): Promise<void> | void };
  /** 1A's filter + classifier counters, merged into status(). */
  counters?: () => Partial<Pick<SkillLearningStatus, 'filtered' | 'classifierFailures24h' | 'abortedUnreachable24h' | 'pendingBacklog'>>;
  /** Reachable model families, preference order; the first is the drafter, a different one reviews. */
  families: () => ReadonlyArray<FamilyProvider>;
  /** The transcript file for a run's session; null when unknown. */
  transcriptPath: (run: { sessionName?: string; topicId: string; runId: string }) => string | null;
  /** The operator's message text for a ledger source (TopicMemory by source); null when unavailable. */
  operatorMessage: (source: RowSource) => string | null;
  /** Verified operator-authored correction-class messages for a corrected run (scrubbed by the sentinel). */
  correctionMessages?: (runId: string, procedureKey: string) => string[];
  /** `GET /preferences/session-context` block — injected, never fetched from inside. */
  preferencesBlock?: () => string | null;
  createAttentionItem?: (item: SkillLearningAttentionItem) => Promise<unknown> | unknown;
  degradation?: { report(event: SkillLearningDegradationEvent): void } | null;
  provenance: JudgmentRecorder;
  /** Measured skill-index bytes (§3.9), when the server measures it. */
  indexBytes?: () => number | null;
  /** Injectable queue (tests); default: the sentinel's own. */
  queue?: LlmQueue;
  /** Feature-evidence sink; default: the process-wide `featureEvidence`. */
  evidence?: { record(featureId: string, input: FeatureEvidenceInput): string | null } | null;
  /** Owned sub-components' lifecycle (ledger cache, seam filter), run by start()/stop(). `create()` fills this. */
  bound?: { start(): void; stop(): void };
  /** `skillLearningUnlinkedMessages()` — messages a seam link saw while no filter was installed. */
  unlinkedMessages?: () => number;
  /**
   * Does this machine hold the operator-messaging lease (§3.2 single writer)? When false the sentinel is
   * observe-only: no key evaluation, no drafting, no growth notice (the holder does those). Default true.
   */
  holdsLease?: () => boolean;
  now?: () => number;
  logger?: (message: string) => void;
}

/** Everything `SkillLearningSentinel.create` needs from the server; the sentinel owns every sub-component it builds. */
/** The frameworks that may serve the drafter/reviewer: grok-build is excluded from internal routing (its spec) and pi-cli is untrusted for review. */
export type DrafterFramework = 'claude-code' | 'codex-cli' | 'gemini-cli';

export interface SkillLearningCreateInput {
  projectDir: string;
  stateDir: string;
  machineId: string;
  config: SkillLearningConfig;
  /** Framework routing inputs (config `enabledFrameworks`, the default framework, `componentFrameworks.overrides`). */
  frameworks?: { enabled?: ReadonlyArray<IntelligenceFramework>; default?: IntelligenceFramework; overrides?: Record<string, IntelligenceFramework | undefined> };
  /** The shared router — the classifier's (1A) door. The drafter/reviewer use per-framework providers (see `families`). */
  sharedIntelligence: IntelligenceProvider | null;
  topicMemory: Pick<TopicMemory, 'getMessagesSince'> | null;
  telegram?: { createAttentionItem?(item: SkillLearningAttentionItem): Promise<unknown> } | null;
  slack?: AttachSeamsInput['slack'];
  topicOperatorStore: { asVerifiedOperator(topicId: number | string): { uid: string } | null };
  userManager?: { listUsers(): Array<{ permissions: string[]; channels: Array<{ type: string; identifier: string }> }> } | null;
  /** Slack channel id → the synthetic numeric topic id TopicMemory stores the channel under (server-local helper). */
  slackTopicId?: (channelId: string) => string;
  hasOutstandingConfirmation?: (topicId: string) => boolean;
  /** Default: `HumanAsDetectorLog.getInstance()`; pass null to disable. */
  detector?: { classify(text: string): { category: string } | null } | null;
  /** `StateManager.findSessionByTmux` projection (transcript location for RunSlice + the §3.9 join). */
  findSession?: (sessionName: string) => { claudeSessionId?: string; framework?: SessionFramework } | undefined;
  sessionClockEnd?: (topicId: string) => string | null;
  /** Operator-messaging lease probe (§3.2 single writer). Default: always the holder (single-machine agents). */
  holdsLease?: () => boolean;
  provenanceLog: { recordDecision(input: DecisionRowInput): string | null; status(): { counters: Record<string, number> } } | null;
  degradationReporter?: { report(event: SkillLearningDegradationEvent): void } | null;
  featureEvidence?: { record(featureId: string, input: FeatureEvidenceInput): string | null } | null;
  createAttentionItem?: (item: SkillLearningAttentionItem) => Promise<unknown> | unknown;
  preferencesBlock?: () => string | null;
  /** Test seam: per-framework provider builder (default `buildIntelligenceProvider({ framework })`). */
  buildProvider?: (framework: DrafterFramework) => IntelligenceProvider | null;
  logger?: (message: string) => void;
  now?: () => number;
}

export interface TickSummary {
  at: string;
  keysSeen: number;
  floorPassed: number;
  drafted: number;
  refused: number;
  held: number;
  arbiterCalls: number;
  phaseFailures: string[];
  admissionRefusals: number;
  /** True when this tick skipped the keys/growth phases because the machine does not hold the lease. */
  observeOnly: boolean;
}

type RefusalReason =
  | 'evidence-cut' | 'no-family' | 'unrecorded' | 'unparseable' | 'review' | 'admission'
  | `lint:${string}` | `action:${string}` | 'provider-error' | 'invalid-name';

interface SentinelState { growthNoticeAt?: string }

interface LoadedProposal { sidecar: ProposalSidecar; dir: string }

function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { SafeFsExecutor.safeRmSync(tmp, { force: true, operation: 'skill-learning-sentinel:temp-cleanup' }); } catch { /* @silent-fallback-ok — best-effort temp cleanup after a failed write */ }
    throw err;
  }
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T; } catch { return null; } // @silent-fallback-ok — absent/corrupt state reads as none; callers handle null
}

/** Flat metadata values of a canonical/rendered SKILL.md, or null when it is not a skill. */
function skillMeta(text: string): { doc: ParsedSkillDoc; learned: boolean } | null {
  const doc = parseSkillDoc(text);
  if (!doc) return null;
  const origin = doc.metadata[LEARNED_ORIGIN_KEY];
  return { doc, learned: typeof origin === 'string' && origin.trim().length > 0 };
}

export class SkillLearningSentinel implements SkillLearningSentinelLike {
  private readonly deps: SkillLearningSentinelDeps;
  private readonly cfg: SkillLearningConfig;
  private readonly queue: LlmQueue;
  private readonly evidence: { record(featureId: string, input: FeatureEvidenceInput): string | null };
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastTickAt: string | undefined;
  private lastTick: TickSummary | null = null;
  private readonly counters = {
    ticks: 0, tickFailures: 0, admissionRefusals: 0, arbiterOutages: 0, draftsWritten: 0, draftsRefused: 0,
    reviewsPassed: 0, reviewsFailed: 0, oneFamilyHolds: 0, coveredByHandwritten: 0, improveEvents: 0, growthNotices: 0,
  };
  /** In-process dedupe of once-per-key notices (covered-by-handwritten); the log row is the durable record. */
  private readonly notedCovered = new Set<string>();

  constructor(deps: SkillLearningSentinelDeps) {
    this.deps = deps;
    this.cfg = deps.config;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.logger ?? (() => {});
    this.queue = deps.queue ?? new LlmQueue({ maxConcurrent: 1, maxDailyCents: Math.max(0, deps.config.llm.maxDailyCents) });
    this.evidence = deps.evidence ?? sharedFeatureEvidence;
  }

  // ─── Paths ──────────────────────────────────────────────────────────

  get proposalsDir(): string { return path.join(this.deps.stateDir, SKILL_LEARNING_PATHS.proposalsDir); }
  get logPath(): string { return path.join(this.deps.stateDir, SKILL_LEARNING_PATHS.log); }
  /** Per-machine (the directory is git-synced; a shared name would conflict between machines). */
  private get statePath(): string { return path.join(this.deps.stateDir, 'skill-learning', `sentinel-state.${this.deps.machineId}.json`); }

  private holdsLease(): boolean {
    try { return this.deps.holdsLease ? this.deps.holdsLease() !== false : true; } catch { return false; } // @silent-fallback-ok — an unreadable lease reads as "not the holder": observe-only is the safe side
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    try { this.deps.bound?.start(); } catch (err) {
      this.log(`[SkillLearningSentinel] bound start failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const minutes = Number.isFinite(this.cfg.tickMinutes) && this.cfg.tickMinutes > 0 ? this.cfg.tickMinutes : 10;
    this.timer = setInterval(() => { void this.tick(); }, minutes * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.deps.bound?.stop(); } catch (err) {
      this.log(`[SkillLearningSentinel] bound stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Tick ───────────────────────────────────────────────────────────

  async tick(): Promise<TickSummary> {
    const summary: TickSummary = { at: new Date(this.now()).toISOString(), keysSeen: 0, floorPassed: 0, drafted: 0, refused: 0, held: 0, arbiterCalls: 0, phaseFailures: [], admissionRefusals: 0, observeOnly: false };
    if (this.running) return summary;
    this.running = true;
    this.counters.ticks++;
    try {
      await this.phase('ingest', summary, async () => { await this.deps.ingest?.ingestNew(); });
      await this.phase('classifier', summary, async () => { await this.deps.classifier?.tick(); });
      await this.phase('outcomes', summary, async () => { await this.deps.outcomes?.close(); });
      if (this.holdsLease()) {
        await this.phase('keys', summary, async () => { await this.evaluateKeys(summary); });
        await this.phase('growth', summary, async () => { await this.checkGrowthSignal(); });
      } else {
        summary.observeOnly = true;          // the lease holder drafts; this machine observes (§3.2 single writer)
      }
      this.lastTickAt = summary.at;
      this.lastTick = summary;
    } finally {
      this.running = false;
    }
    return summary;
  }

  private async phase(name: string, summary: TickSummary, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.phaseFailures.push(name);
      this.counters.tickFailures++;
      this.deps.degradation?.report({
        feature: 'SkillLearningSentinel',
        primary: `tick phase "${name}"`,
        fallback: 'phase skipped this tick; the next tick retries from durable state',
        reason: message.slice(0, 300),
        impact: 'Skill learning lags one tick; nothing is lost (the ledger is append-only).',
      });
      this.appendLog({ kind: 'tick-failure', phase: name, error: message.slice(0, 300) });
      this.log(`[SkillLearningSentinel] phase ${name} failed: ${message}`);
    }
  }

  // ─── Keys: floor → rung/arbiter → draft ─────────────────────────────

  private async evaluateKeys(summary: TickSummary): Promise<void> {
    const nowMs = this.now();
    const existing = this.loadExistingSkills();
    const proposals = this.loadProposals();
    const proposedKeys = new Set(proposals.map((p) => p.sidecar.key));
    const learnedNames = new Set(existing.filter((s) => s.learned).map((s) => s.name));
    const batch = Math.max(1, Math.floor(this.cfg.llm.batchSize));
    let llmBudgetThisTick = batch;

    for (const k of this.deps.ledger.keys()) {
      summary.keysSeen++;
      const key = k.procedureKey;
      if (proposedKeys.has(key)) continue;
      const requests = this.deps.ledger.requestsForKey(key);
      const outcomes = this.deps.ledger.outcomesForKey(key);
      const verdicts = this.deps.ledger.verdictsForKey(key);

      if (this.isHeld(verdicts, nowMs)) { summary.held++; continue; }

      const floor = evaluateFloor({ requests, outcomes, floor: this.cfg.floor, isLearnedSkill: (n) => learnedNames.has(n) });
      if (!floor.passes) {
        this.onBelowFloor(key, floor);
        continue;
      }
      summary.floorPassed++;
      if (llmBudgetThisTick <= 0) { summary.held++; continue; }   // the batch bound: the rest waits for the next tick

      const operatorVerdicts = proposals.filter((p) => p.sidecar.verdict).map((p) => ({ name: p.sidecar.name, verdict: p.sidecar.verdict!.verdict, reason: p.sidecar.verdict!.reason }));
      const cleanOutlines = this.quickOutlines(outcomes, floor);
      let admissionRefused = false;
      const decision = await decideKey({
        procedureKey: key,
        requests,
        verdicts,
        floor,
        cfg: this.cfg,
        nowMs,
        askArbiter: async (ctx) => {
          llmBudgetThisTick--;
          summary.arbiterCalls++;
          const res = await this.askArbiter(ctx);
          if (res === 'admission') { admissionRefused = true; return null; }
          return res;
        },
        context: {
          paraphrases: this.paraphrasesOf(requests),
          cleanRunOutlines: cleanOutlines,
          libraryDescriptions: existing.map((s) => `${s.name}${s.learned ? ' [learned]' : ''}: ${s.description}`),
          indexBytes: this.deps.indexBytes?.() ?? null,
          operatorVerdicts,
        },
      });
      if (admissionRefused) { summary.admissionRefusals++; this.counters.admissionRefusals++; break; }
      this.onDecision(key, decision);
      if (decision.action !== 'draft') { summary.held++; continue; }

      if (llmBudgetThisTick <= 0) { summary.held++; continue; }
      llmBudgetThisTick--;
      const outcome = await this.draft(key, requests, outcomes, floor, decision, existing, proposals);
      if (outcome === 'written') { summary.drafted++; proposedKeys.add(key); }
      else if (outcome === 'admission') { summary.admissionRefusals++; this.counters.admissionRefusals++; break; }
      else summary.refused++;
    }
  }

  /** A key held by an unexpired default-rung `wait` (a refusal / covered-by hold) or an unexpired arbiter `never`/`wait`. */
  private isHeld(verdicts: VerdictRow[], nowMs: number): boolean {
    for (const v of verdicts) {
      if (v.by !== 'default-rung' || v.verdict !== 'wait' || !v.expiresAt) continue;
      const exp = Date.parse(v.expiresAt);
      if (Number.isFinite(exp) && exp > nowMs) return true;
    }
    return false;
  }

  private onBelowFloor(key: string, floor: FloorResult): void {
    if (floor.failure === 'covered-by-learned' && floor.coveredBy) {
      const events = this.deps.ledger.eventsForKey(key);
      if (!events.some((e) => e.event === 'improve' && e.skill === floor.coveredBy!.skill)) {
        const row: EventRow = {
          kind: 'event', eventId: crypto.randomUUID(), event: 'improve', runId: floor.cleanRunIds[0] ?? '', procedureKey: key,
          skill: floor.coveredBy.skill, reason: `skillUsed on ${floor.coveredBy.occurrences} occurrences`, at: new Date(this.now()).toISOString(), machineId: this.deps.machineId,
        };
        this.deps.ledger.append(row);
        this.counters.improveEvents++;
        this.appendLog({ kind: 'improve', key, skill: floor.coveredBy.skill, occurrences: floor.coveredBy.occurrences });
        this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'held', reason: 'covered-by-learned', context: { key, skill: floor.coveredBy.skill } });
      }
      return;
    }
    if (floor.failure === 'covered-by-handwritten' && floor.coveredBy) {
      const dedupe = `${key}|${floor.coveredBy.skill}`;
      if (!this.notedCovered.has(dedupe)) {
        this.notedCovered.add(dedupe);
        this.counters.coveredByHandwritten++;
        this.appendLog({ kind: 'covered-by-handwritten', key, skill: floor.coveredBy.skill, occurrences: floor.coveredBy.occurrences });
        this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'held', reason: 'covered-by-handwritten', context: { key, skill: floor.coveredBy.skill } });
      }
    }
  }

  private onDecision(key: string, d: ArbiterDecision): void {
    this.appendLog(d.logRow);
    if (d.arbiter === 'unavailable') { this.counters.arbiterOutages++; }
    if (d.verdictRow) {
      this.deps.ledger.append({ ...d.verdictRow, eventId: crypto.randomUUID(), machineId: this.deps.machineId });
    }
    if (d.action === 'wait' && d.arbiter === 'never') {
      this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'held', reason: 'arbiter-never', context: { key, cached: d.arbiterCached, default: d.default.verdict } });
    }
  }

  private paraphrasesOf(requests: RequestRow[]): string[] {
    const seen = new Set<string>();
    for (const r of requests) { if (r.paraphrase && seen.size < 12) seen.add(scrubSecrets(r.paraphrase)); }
    return [...seen];
  }

  /** Content-free outlines for the arbiter: run id + label + window only (the full slice is read when drafting). */
  private quickOutlines(outcomes: OutcomeRow[], floor: FloorResult): string[] {
    const clean = new Set(floor.cleanRunIds);
    return outcomes.filter((o) => clean.has(o.runId)).map((o) => `run ${o.runId}: ${o.label}, window ${o.windowStart} → ${o.windowEnd ?? 'open'}`);
  }

  // ─── LLM calls (own queue, provenance-recorded) ─────────────────────

  private async callFamily(provider: FamilyProvider, component: typeof COMPONENT_DRAFTER | typeof COMPONENT_REVIEWER, prompt: string): Promise<string | 'admission'> {
    // Cost estimate against the daily money floor: ~1 cent per 4 K prompt chars (capable tier, rounded up).
    const cost = Math.max(1, Math.ceil(prompt.length / 4000));
    try {
      // The attribution component is INLINED as a literal at each callsite (lint-llm-attribution: a variable is not attribution).
      return await this.queue.enqueue('background', (signal) => component === COMPONENT_REVIEWER
        ? provider.evaluate(prompt, { model: 'capable', maxTokens: 4000, temperature: 0, attribution: { component: 'skillLearning.reviewer', deferrable: true }, signal })
        : provider.evaluate(prompt, { model: 'capable', maxTokens: 4000, temperature: 0, attribution: { component: 'skillLearning.drafter', deferrable: true }, signal }), cost);
    } catch (err) {
      if (err instanceof LlmQueueAdmissionError) return 'admission';
      throw err;
    }
  }

  /** Record one judgment; false = unrecorded (the verdict must be discarded). */
  private recordJudgment(input: Omit<DecisionRowInput, 'arbiter'>): boolean {
    if (!this.deps.provenance.isRecordingLive()) return false;
    const id = this.deps.provenance.recordDecision({ ...input, arbiter: true });
    return typeof id === 'string' && id.length > 0;
  }

  private async askArbiter(ctx: ArbiterContext): Promise<{ verdict: 'draft' | 'wait' | 'never'; reason: string } | null | 'admission'> {
    const families = this.deps.families();
    const drafter = families[0];
    if (!drafter) return null;
    const prompt = buildArbiterPrompt(ctx);
    let raw: string | 'admission';
    try { raw = await this.callFamily(drafter, COMPONENT_DRAFTER, prompt); } catch { return null; } // @silent-fallback-ok — an arbiter outage is the logged 'unavailable' arm (default rung alone)
    if (raw === 'admission') return 'admission';
    const parsed = parseArbiterOutput(raw);
    const recorded = this.recordJudgment({
      component: COMPONENT_DRAFTER,
      decisionPoint: 'skill-learning-arbiter',
      context: buildBoundedContext({ key: ctx.procedureKey, occurrences: ctx.floor.occurrences, verified: ctx.floor.verifiedOccurrences, cleanRuns: ctx.floor.cleanRuns, defaultVerdict: ctx.defaultRung.verdict, family: drafter.family, promptChars: prompt.length, reason: parsed?.reason ?? null }),
      optionsPresented: ['draft', 'wait', 'never'],
      decision: parsed?.verdict ?? 'unclassified',
      reason: parsed?.reason ?? 'unparseable',
      floor: `minOccurrences=${this.cfg.floor.minOccurrences} minCorroboratedCleanRuns=${this.cfg.floor.minCorroboratedCleanRuns}`,
      fallbackRung: `default-gate ${this.cfg.defaultGate.minSupport}/${this.cfg.defaultGate.minDistinctDays}/${this.cfg.defaultGate.minDistinctSessions}@${this.cfg.defaultGate.windowDays}d`,
      model: 'capable',
      door: drafter.framework,
    });
    if (!recorded) { this.appendLog({ kind: 'arbiter-unrecorded', key: ctx.procedureKey }); return null; }
    return parsed;
  }

  // ─── Draft → lint → review → write ──────────────────────────────────

  private async draft(
    key: string, requests: RequestRow[], outcomes: OutcomeRow[], floor: FloorResult, decision: ArbiterDecision,
    existing: ExistingSkill[], proposals: LoadedProposal[],
  ): Promise<'written' | 'refused' | 'admission'> {
    const families = this.deps.families();
    const drafter = families[0];
    if (!drafter) { this.refuse(key, 'no-family'); return 'refused'; }

    // Evidence: the clean runs' operator messages + tool-call outlines.
    const byRun = new Map(outcomes.map((o) => [o.runId, o]));
    const reqByRun = new Map<string, RequestRow>();
    for (const r of requests) if (r.runId && r.identity === 'verified' && !reqByRun.has(r.runId)) reqByRun.set(r.runId, r);
    const cleanRuns: CleanRunEvidence[] = [];
    for (const runId of floor.cleanRunIds) {
      const o = byRun.get(runId); const r = reqByRun.get(runId);
      if (!o || !r) continue;
      const slice = await this.sliceFor(o, r);
      if (slice.truncated) {
        this.refuse(key, 'evidence-cut', { runId, cuts: slice.cuts.join(',') });
        return 'refused';
      }
      cleanRuns.push({ runId, source: r.source, operatorMessage: this.deps.operatorMessage(r.source), slice });
    }
    if (cleanRuns.length === 0) { this.refuse(key, 'evidence-cut', { detail: 'no clean run evidence readable' }); return 'refused'; }

    const corrected = floor.correctedRunIds.flatMap((runId) => this.deps.correctionMessages?.(runId, key) ?? []).map(scrubSecrets);
    const built = buildDrafterPrompt({
      procedureKey: key,
      paraphrases: this.paraphrasesOf(requests),
      cleanRuns,
      correctedMessages: corrected,
      preferencesBlock: this.deps.preferencesBlock?.() ?? null,
      existingSkills: existing,
    }, this.cfg.evidence.promptBudgetBytes);

    let raw: string | 'admission';
    try { raw = await this.callFamily(drafter, COMPONENT_DRAFTER, built.prompt); } catch (err) {
      this.refuse(key, 'provider-error', { error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      return 'refused';
    }
    if (raw === 'admission') return 'admission';
    const action = parseDrafterOutput(raw);
    const recorded = this.recordJudgment({
      component: COMPONENT_DRAFTER,
      decisionPoint: 'skill-learning-draft',
      context: buildBoundedContext({ key, cleanRuns: cleanRuns.length, corrected: corrected.length, promptChars: built.prompt.length, cuts: built.cuts.length, family: drafter.family, arbiterOnly: decision.arbiterOnly }),
      optionsPresented: ['covered-by', 'patch', 'new'],
      decision: action?.action ?? 'unclassified',
      reason: action ? (action.action === 'new' ? action.skill.name : action.target) : 'unparseable',
      floor: 'patch target must carry instar-learned-origin; structural lint; cross-family review',
      fallbackRung: 'no skill',
      model: 'capable',
      door: drafter.framework,
    });
    if (!recorded) { this.refuse(key, 'unrecorded'); return 'refused'; }
    if (!action) { this.refuse(key, 'unparseable'); return 'refused'; }

    const actionRefusal = validateDraftAction(action, existing);
    if (actionRefusal) { this.refuse(key, `action:${actionRefusal}`, { target: action.action === 'new' ? '' : action.target }); return 'refused'; }
    if (action.action === 'covered-by') {
      this.hold(key, `covered-by:${action.target}`);
      this.appendLog({ kind: 'covered-by', key, skill: action.target });
      this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'held', reason: 'covered-by', context: { key, skill: action.target } });
      return 'refused';
    }

    const doc = action.skill;
    if (!validSkillName(doc.name)) { this.refuse(key, 'invalid-name', { name: doc.name.slice(0, 80) }); return 'refused'; }
    const patchTarget = action.action === 'patch' ? action.target : undefined;
    const lint = lintDraft(doc, {
      operatorMessages: built.operatorMessages,
      toolTargets: built.toolTargets,
      argsExcerpts: built.argsExcerpts,
      existingSkillNames: [...existing.map((s) => s.name), ...proposals.map((p) => p.sidecar.name)],
      handWrittenDescriptions: existing.filter((s) => !s.learned).map((s) => s.description),
      patchTarget,
      bodyMaxChars: DRAFT_BODY_MAX_CHARS,
    });
    if (!lint.ok) {
      this.refuse(key, `lint:${lint.refusals[0].rule}`, { rules: lint.refusals.map((r) => r.rule).join(','), detail: lint.refusals[0].detail.slice(0, 200) });
      return 'refused';
    }

    const createdAt = new Date(this.now()).toISOString();
    const sources = cleanRuns.map((r) => r.source);
    const evidence = `clean=${floor.counts.cleanRuns} corrected=${floor.counts.correctedRuns} occurrences=${floor.counts.verifiedOccurrences} src=${sources.map((s) => `${s.channel === 'telegram' ? 'tg' : 'slack'}:${s.chatId}:${s.messageId}`).join(',')}`;
    const skillMd = renderProposalSkillMd(doc, { key, createdAt, evidence });

    // Cross-family review v1.
    const reviewer = this.cfg.review.requireDifferentFamily ? pickReviewer(families, drafter.family) : (families[1] ?? families[0]);
    let reviewerFamily: string | undefined;
    let pendingReason: 'one-family' | undefined;
    if (!reviewer) {
      pendingReason = 'one-family';
      this.counters.oneFamilyHolds++;
    } else {
      const reviewPrompt = buildReviewPrompt({
        skillMd, flags: lint.flags, operatorMessages: built.operatorMessages,
        outlines: cleanRuns.map((r, i) => renderOutline(r.slice, String(i + 1))), drafterFamily: drafter.family,
      });
      let reviewRaw: string | 'admission';
      try { reviewRaw = await this.callFamily(reviewer, COMPONENT_REVIEWER, reviewPrompt); } catch (err) {
        this.refuse(key, 'provider-error', { stage: 'review', error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
        return 'refused';
      }
      if (reviewRaw === 'admission') return 'admission';
      const verdict = parseReviewOutput(reviewRaw, lint.flags);
      const reviewRecorded = this.recordJudgment({
        component: COMPONENT_REVIEWER,
        decisionPoint: 'skill-learning-review',
        context: buildBoundedContext({ key, name: doc.name, flags: lint.flags.length, struck: verdict?.struck.length ?? null, family: reviewer.family, drafterFamily: drafter.family, promptChars: reviewPrompt.length }),
        optionsPresented: ['pass', 'refuse'],
        decision: verdict ? (verdict.pass ? 'pass' : 'refuse') : 'unclassified',
        reason: verdict?.reason ?? 'unparseable',
        floor: 'different family than the drafter; every flagged line explicitly cleared',
        fallbackRung: 'refuse',
        model: 'capable',
        door: reviewer.framework,
      });
      if (!reviewRecorded) { this.refuse(key, 'unrecorded', { stage: 'review' }); return 'refused'; }
      if (!verdict || !verdict.pass) {
        this.counters.reviewsFailed++;
        // A struck policy-relaxation line goes to Attention, as the correction sentinel does.
        for (const id of verdict?.struck ?? []) {
          const f = lint.flags.find((x) => x.id === id);
          if (f?.rule === 'policy-relaxation') void this.raiseAttention({
            id: `skill-learning:policy-relaxation:${doc.name}`, conditionKey: `skill-learning:policy-relaxation:${doc.name}`,
            title: `Skill draft "${doc.name}" tried to relax a policy`, summary: `The reviewer struck: ${f.line.slice(0, 160)}`,
            category: 'skill-learning', priority: 'NORMAL', silent: true,
          });
        }
        this.refuse(key, 'review', { name: doc.name, follows: verdict?.follows ?? null, struck: (verdict?.struck ?? []).join(',') });
        return 'refused';
      }
      this.counters.reviewsPassed++;
      reviewerFamily = reviewer.family;
    }

    const sidecar: ProposalSidecar = {
      name: doc.name, key, arbiterOnly: decision.arbiterOnly, disagreement: decision.disagreement, reviewerFamily, pendingReason, createdAt,
      evidence: { sources, runIds: cleanRuns.map((r) => r.runId) },
      draftKind: action.action, description: doc.description, paraphrases: this.paraphrasesOf(requests),
    };
    this.writeProposal(sidecar, skillMd);
    this.counters.draftsWritten++;
    this.appendLog({ kind: 'would-create', key, name: doc.name, draftKind: action.action, arbiterOnly: decision.arbiterOnly, disagreement: decision.disagreement, reviewerFamily: reviewerFamily ?? null, pendingReason: pendingReason ?? null, evidence, flags: lint.flags.length });
    this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'fired', reason: 'would-create', context: { key, name: doc.name, draftKind: action.action, arbiterOnly: decision.arbiterOnly, reviewerFamily: reviewerFamily ?? null, pendingReason: pendingReason ?? null } });
    return 'written';
  }

  private async sliceFor(o: OutcomeRow, r: RequestRow): Promise<RunSlice> {
    const file = this.deps.transcriptPath({ sessionName: o.sessionName ?? r.sessionName, topicId: o.topicId, runId: o.runId });
    if (!file) return { steps: [], truncated: true, cuts: ['unreadable'], scannedBytes: 0, windowCovered: false, stepsInWindow: 0 };
    const start = Date.parse(o.windowStart);
    const end = o.windowEnd ? Date.parse(o.windowEnd) : this.now();
    return readRunSlice({
      transcriptPath: file, windowStartMs: Number.isFinite(start) ? start : 0, windowEndMs: Number.isFinite(end) ? end : this.now(),
      transcriptScanBytes: this.cfg.evidence.transcriptScanBytes, runSliceBytesPerRun: this.cfg.evidence.runSliceBytesPerRun,
    });
  }

  /** Refuse a draft: durable hold until the re-ask horizon, log row, evidence row. */
  private refuse(key: string, reason: RefusalReason, context: Record<string, string | number | boolean | null> = {}): void {
    this.counters.draftsRefused++;
    this.hold(key, `draft-refused: ${reason}`);
    this.appendLog({ kind: 'draft-refused', key, reason, ...context });
    this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'held', reason: `draft-refused: ${reason}`, context: { key, ...context } });
  }

  /** Persist a default-rung `wait` with the re-ask horizon so the key is not re-drafted every tick. */
  private hold(key: string, reason: string): void {
    const nowMs = this.now();
    const row: VerdictRow = {
      kind: 'verdict', eventId: crypto.randomUUID(), procedureKey: key, by: 'default-rung', verdict: 'wait', reason,
      expiresAt: new Date(nowMs + Math.max(1, this.cfg.shadow.verdictReaskDays) * 86_400_000).toISOString(),
      at: new Date(nowMs).toISOString(), machineId: this.deps.machineId,
    };
    this.deps.ledger.append(row);
  }

  private writeProposal(sidecar: ProposalSidecar, skillMd: string): void {
    const dir = path.join(this.proposalsDir, sidecar.name);
    writeFileAtomic(path.join(dir, 'SKILL.md'), skillMd);
    writeFileAtomic(path.join(dir, 'proposal.json'), `${JSON.stringify(sidecar, null, 2)}\n`);
  }

  // ─── Growth signal (§3.3, attention item 6) ─────────────────────────

  private async checkGrowthSignal(): Promise<void> {
    const nowMs = this.now();
    const limit = Math.max(0, Math.floor(this.cfg.growthSignals.createdPerWeekNotice));
    const recent = this.loadProposals().filter((p) => { const t = Date.parse(p.sidecar.createdAt); return Number.isFinite(t) && nowMs - t <= WEEK_MS; });
    if (recent.length <= limit) return;
    const state = readJson<SentinelState>(this.statePath) ?? {};
    const last = state.growthNoticeAt ? Date.parse(state.growthNoticeAt) : NaN;
    if (Number.isFinite(last) && nowMs - last < WEEK_MS) return;
    const names = recent.map((p) => `${p.sidecar.name}${p.sidecar.arbiterOnly ? ' (arbiter-only)' : ''}`).join(', ');
    await this.raiseAttention({
      id: 'skill-learning:growth', conditionKey: 'skill-learning:growth', silent: true, category: 'skill-learning', priority: 'LOW',
      title: `${recent.length} skill proposals in 7 days (notice at ${limit})`,
      summary: `Proposals this week: ${names}. This is a signal for your review, not a limit — nothing was refused.`,
    });
    this.counters.growthNotices++;
    writeFileAtomic(this.statePath, `${JSON.stringify({ ...state, growthNoticeAt: new Date(nowMs).toISOString() }, null, 2)}\n`);
    this.appendLog({ kind: 'growth-signal', proposals7d: recent.length, limit });
    this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'fired', reason: 'growth-signal', context: { proposals7d: recent.length, limit } });
  }

  private async raiseAttention(item: SkillLearningAttentionItem): Promise<void> {
    if (!this.deps.createAttentionItem) return;
    try { await this.deps.createAttentionItem(item); } catch (err) {
      this.log(`[SkillLearningSentinel] attention item failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Disk reads ─────────────────────────────────────────────────────

  /** Every existing skill: canonical `.instar/skills`, plus `.claude/skills` and `.agents/skills` renderings. */
  loadExistingSkills(): ExistingSkill[] {
    const out: ExistingSkill[] = [];
    const seen = new Set<string>();
    for (const rel of ['.instar/skills', '.claude/skills', '.agents/skills']) {
      const root = path.join(this.deps.projectDir, rel);
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; } // @silent-fallback-ok — an absent layout is simply no skills there
      for (const e of entries) {
        if (!e.isDirectory() || seen.has(e.name)) continue;
        let text: string;
        try { text = fs.readFileSync(path.join(root, e.name, 'SKILL.md'), 'utf-8'); } catch { continue; } // @silent-fallback-ok — a dir without SKILL.md is not a skill
        const meta = skillMeta(text);
        if (!meta) continue;
        seen.add(e.name);
        out.push({ name: e.name, description: meta.doc.description, learned: meta.learned, location: rel });
      }
    }
    return out;
  }

  loadProposals(): LoadedProposal[] {
    const out: LoadedProposal[] = [];
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.proposalsDir, { withFileTypes: true }); } catch { return out; } // @silent-fallback-ok — no proposals yet
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(this.proposalsDir, e.name);
      const sidecar = readJson<ProposalSidecar>(path.join(dir, 'proposal.json'));
      if (sidecar && typeof sidecar.name === 'string' && typeof sidecar.key === 'string') out.push({ sidecar, dir });
    }
    return out;
  }

  private appendLog(row: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.logPath, `${JSON.stringify({ ts: new Date(this.now()).toISOString(), machineId: this.deps.machineId, ...row })}\n`, { mode: 0o600 });
    } catch (err) {
      this.log(`[SkillLearningSentinel] log append failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── One-expression construction for server.ts ──────────────────────

  /**
   * Build the whole slice-1 stack (Ledger → SeamFilter → Outcomes → Classifier → this sentinel) from the
   * server's objects, so server.ts needs exactly one expression:
   *   `const s = SkillLearningSentinel.create({...}); server.setSkillLearningSentinel(s); s.start();`
   * `start()` opens the ledger cache (async, off the boot path), re-opens outcome runs, and installs the seam
   * filter the adapters' links resolve per message (server.ts attaches the links; create() never re-attaches).
   * `stop()` uninstalls the filter and closes the cache. Every branch lives here, none in server.ts.
   */
  static create(input: SkillLearningCreateInput): SkillLearningSentinel {
    const now = input.now ?? (() => Date.now());
    const log = input.logger ?? (() => {});
    const cfg = input.config;
    const ledger = new Ledger({ stateDir: input.stateDir, machineId: input.machineId, windowDays: cfg.defaultGate.windowDays, now, logger: log });
    const outcomes = new Outcomes({
      ledger, machineId: input.machineId, stateDir: input.stateDir, projectDir: input.projectDir, windowDays: cfg.defaultGate.windowDays,
      transcriptScanBytes: cfg.evidence.transcriptScanBytes, findSession: input.findSession, sessionClockEnd: input.sessionClockEnd, holdsLease: input.holdsLease, now, logger: log,
    });
    const admins = (): Array<{ permissions: string[]; channels: Array<{ type: string; identifier: string }> }> => {
      try { return input.userManager?.listUsers() ?? []; } catch { return []; } // @silent-fallback-ok — an unreadable user list means no Slack admin resolves (rows stay not-operator)
    };
    const filter = new SeamFilter({
      ledger, machineId: input.machineId,
      operatorUidForTopic: (topicId) => { try { return input.topicOperatorStore.asVerifiedOperator(topicId)?.uid ?? null; } catch { return null; } }, // @silent-fallback-ok — no binding ⇒ not-operator
      slackAdminUser: (uid) => admins().some((u) => u.permissions.includes('admin') && u.channels.some((c) => c.type === 'slack' && c.identifier === uid)),
      slackTopicId: input.slackTopicId,
      hasOutstandingConfirmation: input.hasOutstandingConfirmation,
      detector: input.detector === undefined ? HumanAsDetectorLog.getInstance() : input.detector ?? undefined,
      topicMemory: input.topicMemory ?? undefined,
      onEvent: (e) => outcomes.observe(e),
      now, logger: log,
    });
    const queue = new LlmQueue({ maxConcurrent: 1, maxDailyCents: Math.max(0, cfg.llm.maxDailyCents), now });
    // Provenance: every judgment is recorded; a write-error delta inside a tick refuses the rest of that tick (§3).
    let writeErrorsAtTickStart: number | null = null;
    const writeErrors = (): number => input.provenanceLog?.status().counters.writeErrors ?? 0;
    const provenance: JudgmentRecorder = {
      recordDecision: (row) => input.provenanceLog ? input.provenanceLog.recordDecision(row) : null,
      isRecordingLive: () => input.provenanceLog !== null && input.provenanceLog !== undefined && (writeErrorsAtTickStart === null || writeErrors() === writeErrorsAtTickStart),
    };
    const classifier = new Classifier({
      ledger, machineId: input.machineId, topicMemory: input.topicMemory, intelligence: input.sharedIntelligence, queue,
      provenance: input.provenanceLog ?? null, degradation: input.degradationReporter ?? null, outcomes, batchSize: cfg.llm.batchSize, retryAfterDays: cfg.shadow.verdictReaskDays, now, logger: log,
    });
    // Families: one provider per reachable framework, through the same tier resolver the cross-model reviewer uses.
    // Order: the drafter override (per-component routing) or the default framework first, then the rest.
    // grok-build (excluded from internal routing by its spec) and pi-cli (untrusted for review) never serve here.
    const build = input.buildProvider ?? ((fw: DrafterFramework) => buildIntelligenceProvider({ framework: fw }));
    const cache = new Map<DrafterFramework, IntelligenceProvider | null>();
    const isDrafterFramework = (f: unknown): f is DrafterFramework => f === 'claude-code' || f === 'codex-cli' || f === 'gemini-cli';
    const families = (): FamilyProvider[] => {
      const enabled = (input.frameworks?.enabled?.length ? input.frameworks.enabled : [input.frameworks?.default ?? 'claude-code']).filter(isDrafterFramework);
      const first = input.frameworks?.overrides?.['skillLearning.drafter'] ?? input.frameworks?.default ?? enabled[0];
      const ordered = [...new Set([first, ...enabled])].filter((f): f is DrafterFramework => isDrafterFramework(f) && enabled.includes(f));
      const out: FamilyProvider[] = [];
      for (const fw of ordered) {
        if (!cache.has(fw)) { try { cache.set(fw, build(fw)); } catch { cache.set(fw, null); } } // @silent-fallback-ok — an unbuildable framework is simply not reachable
        const provider = cache.get(fw);
        if (!provider) continue;
        out.push({
          family: familyOfFramework(fw), framework: fw,
          // The component literal is re-stated here so the funnel callsite carries its own attribution (lint-llm-attribution).
          evaluate: (prompt, opts) => opts.attribution.component === 'skillLearning.reviewer'
            ? provider.evaluate(prompt, { ...opts, attribution: { component: 'skillLearning.reviewer', deferrable: true } })
            : provider.evaluate(prompt, { ...opts, attribution: { component: 'skillLearning.drafter', deferrable: true } }),
        });
      }
      return out;
    };
    const messageText = (source: RowSource): string | null => {
      const row = ledger.requestBySource(source);
      if (!row || !input.topicMemory) return null;
      const topicId = Number(row.topicId);
      if (!Number.isFinite(topicId)) return null;
      const since = new Date(Math.max(0, Date.parse(row.at) - 60_000)).toISOString();
      try {
        const hit = input.topicMemory.getMessagesSince(topicId, since, 200).messages.find((m) => String(m.messageId) === source.messageId && m.fromUser);
        return hit ? hit.text : null;
      } catch { return null; } // @silent-fallback-ok — an unreadable TopicMemory reads as "message unavailable" in the prompt
    };
    const sentinel = new SkillLearningSentinel({
      config: cfg, stateDir: input.stateDir, projectDir: input.projectDir, machineId: input.machineId, ledger,
      ingest: { ingestNew: async () => { writeErrorsAtTickStart = writeErrors(); await ledger.ingestNew(); } },
      classifier,
      outcomes: { close: () => { outcomes.tick(); } },
      counters: () => ({ filtered: filter.filtered(), classifierFailures24h: classifier.counters().classifierFailures24h, pendingBacklog: ledger.pendingCount() }),
      families,
      transcriptPath: (run) => {
        const session = run.sessionName ? input.findSession?.(run.sessionName) : undefined;
        if (!session?.claudeSessionId) return null;
        const file = resolveFrameworkTranscriptPath({ framework: session.framework ?? 'claude-code', sessionId: session.claudeSessionId, projectDir: input.projectDir });
        return file || null;
      },
      operatorMessage: messageText,
      correctionMessages: (runId) => { const closedBy = ledger.latestOutcome(runId)?.closedBy; const text = closedBy ? messageText(closedBy) : null; return text ? [text] : []; },
      preferencesBlock: input.preferencesBlock,
      createAttentionItem: input.createAttentionItem ?? (input.telegram?.createAttentionItem ? (item) => input.telegram!.createAttentionItem!(item) : undefined),
      degradation: input.degradationReporter ?? null,
      provenance,
      evidence: input.featureEvidence ?? null,
      queue,
      bound: {
        start: () => { installSkillLearningSeamFilter(filter); void ledger.start().then(() => outcomes.start()).catch((err) => log(`[SkillLearningSentinel] ledger start failed: ${err instanceof Error ? err.message : String(err)}`)); },
        stop: () => { installSkillLearningSeamFilter(null); ledger.close(); },
      },
      unlinkedMessages: skillLearningUnlinkedMessages,
      holdsLease: input.holdsLease,
      now, logger: log,
    });
    return sentinel;
  }

  // ─── SkillLearningSentinelLike ──────────────────────────────────────

  status(): SkillLearningStatus {
    const keys = this.deps.ledger.keys();
    const proposals = this.loadProposals();
    const skills = this.learnedSkillSummaries(keys.map((k) => k.procedureKey));
    const ext = this.deps.counters?.() ?? {};
    return {
      machine: this.deps.machineId,
      enabled: this.cfg.enabled,
      mode: this.cfg.mode,
      counts: {
        requests: keys.reduce((n, k) => n + k.requests, 0),
        verified: keys.reduce((n, k) => n + k.verifiedRequests, 0),
        keys: keys.length,
        proposals: proposals.length,
        skills: skills.length,
      },
      channels: { telegram: 'measured', slack: 'support-only', app: 'unmeasurable' },
      pendingBacklog: ext.pendingBacklog ?? this.deps.ledger.pendingCount(),
      classifierFailures24h: ext.classifierFailures24h ?? 0,
      abortedUnreachable24h: ext.abortedUnreachable24h ?? 0,
      filtered: ext.filtered ?? { 'not-user': 0, forwarded: 0, 'not-operator': 0, 'confirmation-reply': 0, 'slack-asserted': 0 },
      skills,
      proposals: proposals.map((p) => this.proposalSummary(p.sidecar)),
      pending: [],
      retired: [],
      lastTickAt: this.lastTickAt,
      llmSpendCentsToday: this.queue.getDailySpendCents(),
      unlinkedMessages: this.deps.unlinkedMessages?.() ?? 0,
      observeOnly: !this.holdsLease(),
    };
  }

  /** The sentinel's own counters (observability; not part of the route contract). */
  internalCounters(): Readonly<typeof this.counters> & { lastTick: TickSummary | null } {
    return { ...this.counters, lastTick: this.lastTick };
  }

  skill(name: string): LearnedSkillSummary | ProposalSummary | null {
    if (!validSkillName(name)) return null;
    const learned = this.learnedSkillSummaries(this.deps.ledger.keys().map((k) => k.procedureKey)).find((s) => s.name === name);
    if (learned) return learned;
    const p = this.loadProposals().find((x) => x.sidecar.name === name);
    return p ? this.proposalSummary(p.sidecar) : null;
  }

  recordOperatorVerdict(name: string, verdict: 'agree' | 'disagree', reason?: string): { ok: true } | { ok: false; error: string } {
    if (!validSkillName(name)) return { ok: false, error: 'invalid-name' };
    if (verdict !== 'agree' && verdict !== 'disagree') return { ok: false, error: 'invalid-verdict' };
    const p = this.loadProposals().find((x) => x.sidecar.name === name);
    if (!p) return { ok: false, error: 'proposal-not-found' };
    const at = new Date(this.now()).toISOString();
    const cleanReason = reason ? scrubSecrets(String(reason)).replace(/\s+/g, ' ').trim().slice(0, 240) : undefined;
    try {
      const next: ProposalSidecar = { ...p.sidecar, verdict: { by: 'operator', verdict, ...(cleanReason ? { reason: cleanReason } : {}), at } };
      writeFileAtomic(path.join(p.dir, 'proposal.json'), `${JSON.stringify(next, null, 2)}\n`);
      this.deps.ledger.append({
        kind: 'verdict', eventId: crypto.randomUUID(), procedureKey: p.sidecar.key, by: 'operator', verdict, reason: cleanReason, at, machineId: this.deps.machineId,
      });
      this.appendLog({ kind: 'operator-verdict', key: p.sidecar.key, name, verdict, reason: cleanReason ?? null });
      this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'outcome', reason: `operator-${verdict}`, outcome: verdict === 'agree' ? 'right' : 'wrong', gradedBy: 'operator', context: { key: p.sidecar.key, name, arbiterOnly: p.sidecar.arbiterOnly } });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `write-failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private proposalSummary(s: ProposalSidecar): ProposalSummary {
    return { name: s.name, key: s.key, arbiterOnly: s.arbiterOnly, disagreement: s.disagreement ?? (s.arbiterOnly ? 'arbiter-only' : null), createdAt: s.createdAt, reviewerFamily: s.reviewerFamily, pendingReason: s.pendingReason, verdict: s.verdict, paraphrases: s.paraphrases, description: s.description };
  }

  /** Learned canonicals under `.instar/skills` with their §3.6 counts from the ledger (read-only; slice 1 has no versions yet). */
  private learnedSkillSummaries(keys: string[]): LearnedSkillSummary[] {
    const root = path.join(this.deps.projectDir, '.instar', 'skills');
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; } // @silent-fallback-ok — no canonical layout yet
    const learned: Array<{ name: string; doc: ParsedSkillDoc }> = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      let text: string;
      try { text = fs.readFileSync(path.join(root, e.name, 'SKILL.md'), 'utf-8'); } catch { continue; } // @silent-fallback-ok — not a skill dir
      const meta = skillMeta(text);
      if (meta?.learned) learned.push({ name: e.name, doc: meta.doc });
    }
    if (learned.length === 0) return [];
    const uses = new Map<string, { uses: number; accepted: number; inferred: number; corrected: number; unknown: number; weak: number; corroborated: number; misfires: number; lastUsedAt?: string }>();
    for (const key of keys) {
      for (const o of this.deps.ledger.outcomesForKey(key)) {
        if (!o.skillUsed) continue;
        const u = uses.get(o.skillUsed.skill) ?? { uses: 0, accepted: 0, inferred: 0, corrected: 0, unknown: 0, weak: 0, corroborated: 0, misfires: 0 };
        u.uses++;
        if (o.skillUsed.corroborated) u.corroborated++;
        if (o.misfire) u.misfires++;
        if (o.label === 'accepted') u.accepted++;
        else if (o.label === 'accepted-inferred') u.inferred++;
        else if (o.label === 'corrected' || o.label === 'redo') u.corrected++;
        else if (o.label === 'weak-positive') u.weak++;
        else u.unknown++;
        if (!u.lastUsedAt || o.at > u.lastUsedAt) u.lastUsedAt = o.at;
        uses.set(o.skillUsed.skill, u);
      }
    }
    return learned.map(({ name, doc }) => {
      const u = uses.get(name) ?? { uses: 0, accepted: 0, inferred: 0, corrected: 0, unknown: 0, weak: 0, corroborated: 0, misfires: 0 };
      const measured = u.accepted + u.inferred + u.corrected;
      const score = measured > 0 ? (u.accepted + 0.5 * u.inferred + 1) / (u.accepted + 0.5 * u.inferred + u.corrected + 2) : null;
      const state = doc.metadata['instar-learned-state'];
      const version = Number.parseInt(doc.metadata['instar-learned-version'] ?? '1', 10);
      return {
        name,
        state: state === 'retired' ? 'retired' : state === 'proposal' || state === 'pending' ? 'proposal' : doc.metadata['instar-learned-locked'] === 'true' ? 'locked' : 'learned',
        score, uses: u.uses, accepted: u.accepted, acceptedInferred: u.inferred, corrected: u.corrected, unknown: u.unknown, weakPositive: u.weak,
        measurableRate: u.uses > 0 ? u.corroborated / u.uses : null, misfires: u.misfires,
        version: Number.isFinite(version) ? version : 1, lastUsedAt: u.lastUsedAt,
        locked: doc.metadata['instar-learned-locked'] === 'true',
      } satisfies LearnedSkillSummary;
    });
  }
}
