/**
 * AttributionRuntime — the composition root of the attribution paper trail, and every consumer's
 * one entry point. Spec: docs/specs/attribution-paper-trail.md.
 *
 * Exists only when `attribution.enabled` resolves true through the dev-agent gate. Budgets, its own
 * LLM queue and the mode live here, so the hook, the routes, the send gate and the audit share them.
 * A provider failure after failover passes as `unchecked`, reported and counted: failing closed
 * would block every memory write during an outage, a far worse harm than a claim the audit re-checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LlmQueue, type LlmLane } from '../../monitoring/LlmQueue.js';
import { DegradationReporter } from '../../monitoring/DegradationReporter.js';
import { featureEvidence } from '../../monitoring/FeatureEvidenceLog.js';
import type { TopicMemory } from '../../memory/TopicMemory.js';
import type { PoolPeerTarget, RopeResultRecorder } from '../../server/poolPeerFetch.js';
import type { ThreadLog } from '../../threadline/ThreadLog.js';
import type { UserManager } from '../../users/UserManager.js';
import type { AppConversationStore } from '../AppConversationStore.js';
import { boundedHead } from '../boundedInput.js';
import { scrubString } from '../CredentialAuditEmit.js';
import { SafeGitExecutor } from '../SafeGitExecutor.js';
import type { AttributionSourcesSignal } from '../MessagingToneGate.js';
import type { AttributionConfig, IntelligenceOptions, IntelligenceProvider } from '../types.js';
import { AttributionAudit, type AuditReport, type AuditSlice, AUDIT_BUDGET, type ReportItem } from './AttributionAudit.js';
import { AttributionBudget, type BudgetUse } from './AttributionBudget.js';
import { AttributionJudge } from './AttributionJudge.js';
import { AttributionLedger, type AttributionSurface, type LedgerRow } from './AttributionLedger.js';
import { AttributionService, type CheckContext, type CheckResult, type ClaimFinding } from './AttributionService.js';
import { isInScope, listScopeFiles, realpathLoose, withoutManagedRegion, type ScopeOptions } from './attributionScope.js';
import { ChannelReaders } from './channelReaders.js';
import { findLocal, findSources, type FindCandidate, type FindOptions, type FindResult } from './findSources.js';
import { AttributionIdentity } from './identity.js';
import { parseMarkers, quoteIsInRecord, type SourceRef } from './marker.js';
import { PeerFanout, type PeerJson } from './peerFanout.js';
import { PinStore } from './PinStore.js';
import { mightCreditSomeone } from './prefilter.js';
import { checkEligibility } from './recordEligibility.js';
import { SourceResolver, type LocalLookup, type ResolveResult } from './SourceResolver.js';
import { changedBlocks, changedLines, planWrites } from './writeDiff.js';

export type AttributionMode = 'record' | 'enforce';
export type { AttributionConfig, AttributionSourcesSignal };

export const SIGNAL_BUDGET_MS = 6_000;
export const ROUTE_BUDGET_MS = 19_500;
const TIME_FOR_SUGGESTIONS_MS = 4_000;
const DEGRADATION_REPORT_GAP_MS = 60 * 60_000;

export interface AttributionRuntimeDeps {
  stateDir: string;
  projectDir: string;
  machineId: string;
  machineName: string;
  intelligence: IntelligenceProvider | null | undefined;
  config: () => AttributionConfig | undefined;
  /** Live reading of the feature's switch: `attribution.enabled: false` stops every consumer. */
  isEnabled: () => boolean;
  users?: () => UserManager | null | undefined;
  topicMemory?: () => TopicMemory | null | undefined;
  threadLog?: () => ThreadLog | null | undefined;
  appStore?: () => AppConversationStore | null | undefined;
  configuredOwnerUid?: () => unknown;
  slackOwnerUserId?: () => string | null | undefined;
  peers?: () => PoolPeerTarget[];
  /** Every active machine of this agent. One with no usable URL has not answered, so it is never absence. */
  registeredMachines?: () => string[];
  authToken?: () => string | undefined;
  recordRope?: RopeResultRecorder;
  fetchImpl?: typeof fetch;
  holdsLease?: () => boolean;
  now?: () => Date;
  /** Test seam: how long a route waits before answering with a recorded timeout. */
  routeBudgetMs?: number;
}

export interface HookCheckInput {
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface HookCheckAnswer {
  status: 'pass' | 'refuse' | 'unchecked' | 'timeout' | 'recording';
  blocked: boolean;
  reason?: string;
}

export interface TraceResult {
  query: Record<string, string>;
  origin: { ref: SourceRef; outcome: string; machine?: string; text?: string; timestamp?: string; relation?: string } | null;
  rows: Array<LedgerRow & { inferred?: boolean; attachedAt?: string }>;
  failed: string[];
  nextCursor: string | null;
  note?: string;
}

const TRACE_PAGE = 100;

function nowMs(deps: AttributionRuntimeDeps): number {
  return deps.now?.().getTime() ?? Date.now();
}

/** Each judge gets its own budget and shares this feature's queue, so callers elsewhere cannot abort it. */
function meteredProvider(options: {
  base: IntelligenceProvider;
  queue: LlmQueue;
  lane: LlmLane;
  take: () => boolean;
  budget: AttributionBudget;
  onFailure: (message: string) => void;
}): IntelligenceProvider {
  return {
    evaluate: async (prompt: string, intelligenceOptions?: IntelligenceOptions) => {
      if (!options.take()) throw new Error('attribution-over-budget');
      options.budget.count('judgeCalls');
      try {
        return await options.queue.enqueue(options.lane, (signal) => options.base.evaluate(prompt, { ...intelligenceOptions, signal }));
      } catch (err) {
        options.budget.count('judgeErrors');
        options.onFailure(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
  };
}

/** The first commit holding this text. Bounded, read-only and off the event loop; any failure is unknown. */
function firstCommitHolding(file: string, text: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!text.trim()) { resolve(null); return; }
    let child: ReturnType<typeof SafeGitExecutor.readStream>;
    try {
      child = SafeGitExecutor.readStream(['log', '--reverse', '--format=%aI', '-S', text.slice(0, 200), '--', path.basename(file)], {
        cwd: path.dirname(file),
        operation: 'src/core/attribution/attributionRuntime.ts:firstCommitHolding',
      });
    } catch {
      // @silent-fallback-ok — no history reads as an unknown first-seen, which the spec allows.
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 1_500);
    child.stdout?.on('data', (chunk) => { if (out.length < 4_096) out += String(chunk); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const at = Date.parse(out.split('\n')[0]?.trim() ?? '');
      resolve(Number.isFinite(at) ? new Date(at).toISOString() : null);
    });
  });
}

export class AttributionRuntime {
  readonly ledger: AttributionLedger;
  readonly pins: PinStore;
  readonly resolver: SourceResolver;
  readonly readers: ChannelReaders;
  readonly identity: AttributionIdentity;
  readonly budget: AttributionBudget;
  readonly audit: AttributionAudit;
  readonly service: AttributionService;

  private readonly queue = new LlmQueue({ maxConcurrent: 2, interactiveReservePct: 0, maxDailyCents: 500 });
  private readonly peers: PeerFanout;
  private readonly judges: Record<'write' | 'send', AttributionJudge>;
  private readonly auditJudges: Record<AuditSlice, AttributionJudge>;
  private readonly auditRunUse: Record<AuditSlice, number> = { newBlocks: 0, sampled: 0, retries: 0 };
  private activeSlice: AuditSlice = 'newBlocks';
  private lastDegradationAt = 0;
  private lineagePendingFile: string;

  constructor(private readonly deps: AttributionRuntimeDeps) {
    const stateDir = deps.stateDir;
    const now = deps.now;
    this.ledger = new AttributionLedger({ stateDir, machineId: deps.machineId, scrub: scrubString, ...(now ? { now } : {}) });
    this.pins = new PinStore({ stateDir, scrub: scrubString, ...(now ? { now } : {}) });
    this.budget = new AttributionBudget({ stateDir, ...(now ? { now } : {}) });
    this.readers = new ChannelReaders({ stateDir, appStore: deps.appStore, threadLog: deps.threadLog });
    this.identity = new AttributionIdentity({ stateDir, users: deps.users, configuredOwnerUid: deps.configuredOwnerUid, slackOwnerUserId: deps.slackOwnerUserId });
    this.peers = new PeerFanout({
      peers: deps.peers ?? (() => []),
      registeredMachines: deps.registeredMachines,
      authToken: deps.authToken ?? (() => undefined),
      recordRope: deps.recordRope,
      fetchImpl: deps.fetchImpl,
    });
    this.lineagePendingFile = path.join(stateDir, 'attribution', 'lineage-pending.json');

    const base: IntelligenceProvider = deps.intelligence ?? { evaluate: async () => { throw new Error('no-intelligence-provider'); } };
    const judgeFor = (use: BudgetUse, lane: LlmLane) => new AttributionJudge(meteredProvider({
      base, queue: this.queue, lane, budget: this.budget, take: () => this.budget.take(use), onFailure: (message) => this.reportJudgeFailure(message),
    }));
    this.judges = { write: judgeFor('write', 'interactive'), send: judgeFor('send', 'background') };
    const auditJudge = (slice: AuditSlice) => new AttributionJudge(meteredProvider({
      base, queue: this.queue, lane: 'background', budget: this.budget,
      take: () => {
        if (this.auditRunUse[slice] >= AUDIT_BUDGET[slice]) return false;
        this.auditRunUse[slice] += 1;
        return true;
      },
      onFailure: (message) => this.reportJudgeFailure(message),
    }));
    this.auditJudges = { newBlocks: auditJudge('newBlocks'), sampled: auditJudge('sampled'), retries: auditJudge('retries') };

    this.resolver = new SourceResolver({
      machineName: deps.machineName,
      readLocal: this.readers.readLocal,
      askPeers: deps.peers ? (ref) => this.peers.askResolve(ref) : undefined,
      readPin: (ref) => this.pins.read(ref),
      dropPin: (ref) => this.pins.drop(ref),
      localAuthorship: (ref, row) => this.readers.localVerdictOnPeerRow(ref, row),
      recordGaps: () => this.deps.config()?.recordGaps ?? [],
      ...(now ? { now: () => now().getTime() } : {}),
    });

    this.service = new AttributionService({
      judge: (surface) => this.judgeForSurface(surface),
      resolve: (ref) => this.resolveWithPinnedAuthorship(ref),
      identity: this.identity.map,
      ledger: this.ledger,
      knownRef: (ref) => this.pins.has(ref) || this.ledger.hasRef(ref),
      pin: (ref, row, authorship) => this.pins.pin(ref, row, authorship),
      firstCommitHolding,
    });

    this.audit = new AttributionAudit({
      stateDir,
      machine: deps.machineName,
      listFiles: () => listScopeFiles(this.scope()),
      check: (text, context, slice) => this.auditCheck(text, context, slice),
      firstCommitHolding,
      ledger: this.ledger,
      knownPeople: () => this.identity.knownPeople(),
      holdsLease: deps.holdsLease ?? (() => true),
      isEnabled: () => this.enabled,
      report: ({ reason, impact }) => this.reportDegradation(reason, impact),
      scrub: scrubString,
      counters: { sample: (miss) => { this.budget.count('sampleJudged'); if (miss) this.budget.count('sampleMisses'); } },
      suggest: (item) => this.suggestFor(item),
      machinesAnswering: () => this.machinesAnswering(),
      callsUsed: (slice) => this.auditRunUse[slice],
      beforeRun: async () => {
        this.auditRunUse.newBlocks = 0;
        this.auditRunUse.sampled = 0;
        this.auditRunUse.retries = 0;
        await this.retryPendingLineage();
      },
      ...(now ? { now: () => now().getTime() } : {}),
    });
    this.audit.sampleStats = () => {
      const { counters } = this.budget.snapshot();
      return { sampled: counters.sampleJudged, misses: counters.sampleMisses };
    };
  }

  get enabled(): boolean {
    return this.deps.isEnabled();
  }

  get routeBudgetMs(): number {
    return this.deps.routeBudgetMs ?? ROUTE_BUDGET_MS;
  }

  get mode(): AttributionMode {
    return this.deps.config()?.mode === 'enforce' ? 'enforce' : 'record';
  }

  start(): void {
    this.audit.start();
  }

  stop(): void {
    this.audit.stop();
  }

  scope(): ScopeOptions {
    return { projectDir: this.deps.projectDir, stateDir: this.deps.stateDir, extraPaths: this.deps.config()?.paths };
  }

  // ── Write gate ─────────────────────────────────────────────────────

  /**
   * POST /attribution/check from the hook. In `record` the hook does not wait: this answers at once
   * and the check finishes in the background. In `enforce` the verdict comes first; suggestions
   * are added only if time is left, and an overrun passes and is counted.
   */
  async checkWrite(input: HookCheckInput): Promise<HookCheckAnswer> {
    if (!this.enabled) return { status: 'pass', blocked: false };
    const plans = this.planForScope(input);
    if (plans.length === 0) return { status: 'pass', blocked: false };

    if (this.mode === 'record') {
      void this.runWriteChecks(plans, false).catch((err) => this.reportJudgeFailure(String(err)));
      return { status: 'recording', blocked: false };
    }

    const started = nowMs(this.deps);
    const checks = this.runWriteChecks(plans, true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), this.routeBudgetMs); });
    const outcome = await Promise.race([checks, timeout]).finally(() => { if (timer) clearTimeout(timer); });
    if (outcome === 'timeout') {
      // The check runs on and writes its row. The hook has passed; the overrun is the recorded outcome.
      this.budget.count('hookTimeouts');
      void checks.catch(() => {});
      return { status: 'timeout', blocked: false };
    }
    const refused = outcome.filter((result) => result.check.verdict === 'refuse');
    if (refused.length === 0) {
      return { status: outcome.some((result) => result.check.verdict === 'unchecked') ? 'unchecked' : 'pass', blocked: false };
    }
    this.budget.count('refused');
    const left = this.routeBudgetMs - (nowMs(this.deps) - started);
    const suggestions = left > TIME_FOR_SUGGESTIONS_MS ? await this.suggestionsWithin(refused, left - 1_000) : [];
    return { status: 'refuse', blocked: true, reason: refusalText(refused.flatMap((result) => result.check.findings), suggestions) };
  }

  private planForScope(input: HookCheckInput): ReturnType<typeof planWrites> {
    const read = (file: string) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return '';
      }
    };
    return planWrites(input.toolName, input.toolInput, read).filter((plan) => isInScope(plan.path, this.scope()));
  }

  private async runWriteChecks(plans: ReturnType<typeof planWrites>, enforced: boolean): Promise<Array<{ path: string; check: CheckResult }>> {
    const results: Array<{ path: string; check: CheckResult }> = [];
    for (const plan of plans) {
      const before = withoutManagedRegion(plan.path, plan.before);
      const after = withoutManagedRegion(plan.path, plan.after);
      const changed = changedLines(before, after);
      if (changed.length === 0) continue;
      const blocks = changedBlocks(after, changed);
      const check = await this.checkAndCount(blocks.text, {
        surface: 'note-write',
        path: realpathLoose(plan.path),
        changedLines: blocks.refusable,
        ...(plan.oldText ? { oldText: plan.oldText } : {}),
        enforced,
      });
      results.push({ path: plan.path, check });
    }
    return results;
  }

  private async checkAndCount(text: string, context: CheckContext): Promise<CheckResult> {
    this.budget.count('checks');
    const result = await this.service.check(text, context);
    if (result.verdict === 'unchecked') {
      this.budget.count('unchecked');
      this.reportDegradationOnce('A check ran with no model or over budget', 'Claims were written or sent unchecked. The daily audit will re-check them.');
    }
    if (result.verdict === 'refuse' && context.enforced === false) this.budget.count('wouldRefuse');
    featureEvidence.record('attribution.paper-trail', { kind: result.verdict === 'unchecked' ? 'error' : 'fired', reason: result.verdict, context: { surface: context.surface } });
    // Seeded rows are roots for later claims to link to. Linking each one would outrun the audit's budget.
    if (context.surface !== 'audit') void this.linkLineage(result.written ?? [], context.surface).catch(() => {});
    return result;
  }

  private async suggestionsWithin(refused: Array<{ check: CheckResult }>, budgetMs: number): Promise<FindCandidate[]> {
    const finding = refused.flatMap((result) => result.check.findings).find((f) => f.verdict === 'refuse' && f.person);
    if (!finding?.person) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<FindCandidate[]>((resolve) => { timer = setTimeout(() => resolve([]), budgetMs); });
    const found = this.find({ person: finding.person, claim: finding.span }, 'write').then((result) => result.suggestions.slice(0, 3)).catch(() => []);
    return Promise.race([found, late]).finally(() => { if (timer) clearTimeout(timer); });
  }

  // ── Plain text checks ──────────────────────────────────────────────

  checkText(text: string, context: CheckContext): Promise<CheckResult> {
    return this.checkAndCount(text, context);
  }

  /**
   * Send record, memory routes: background, behind the cheap filter, on the send budget. Writes
   * ledger rows and nothing else. What the filter skips is counted: a miss loses a history row.
   */
  recordInBackground(text: string, context: Pick<CheckContext, 'surface' | 'path' | 'recentConversation'>): void {
    // Called beside a send or a store write, so nothing here may throw into the caller.
    try {
      if (!this.enabled || !text?.trim()) return;
      if (!mightCreditSomeone(text, this.identity.knownPeople())) {
        this.budget.count('prefilterSkipped');
        return;
      }
      void this.checkAndCount(text, { ...context, enforced: false }).catch((err) => this.reportJudgeFailure(String(err)));
    } catch (err) {
      this.reportJudgeFailure(String(err));
    }
  }

  /**
   * Threadline: run alongside the send, never before it. The route reads `settled()` when it answers;
   * a check not finished by then still lands its ledger row.
   */
  checkAlongside(text: string): { settled: () => string | null } {
    let advisory: string | null = null;
    try {
      if (this.enabled && text?.trim() && mightCreditSomeone(text, this.identity.knownPeople())) {
        void this.checkAndCount(text, { surface: 'threadline', enforced: false })
          .then((result) => { if (this.mode === 'enforce') advisory = peerAdvisory(result.findings); })
          .catch((err) => this.reportJudgeFailure(String(err)));
      }
    } catch (err) {
      this.reportJudgeFailure(String(err));
    }
    return { settled: () => advisory };
  }

  // ── Send gate signal ───────────────────────────────────────────────

  /** Exact facts for each marker in a message. Over the 6s sub-budget it reads `unmeasured`. */
  async sourcesSignal(text: string, conversationContext: boolean): Promise<AttributionSourcesSignal> {
    const { markers, malformed } = parseMarkers(text);
    const unmeasured: AttributionSourcesSignal = {
      status: 'unmeasured',
      conversationContext,
      markers: [...markers.map((m) => ({ raw: m.raw, outcome: 'unmeasured' })), ...malformed.map((m) => ({ raw: m.raw, outcome: 'malformed-marker' }))],
    };
    if (markers.length === 0) return { status: 'resolved', conversationContext, markers: unmeasured.markers };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<AttributionSourcesSignal>((resolve) => { timer = setTimeout(() => resolve(unmeasured), SIGNAL_BUDGET_MS); });
    const measured = Promise.all(markers.slice(0, 8).map(async (marker) => {
      const resolved = await this.resolveWithPinnedAuthorship(marker.ref);
      const row = resolved.row;
      const lineStart = text.lastIndexOf('\n', marker.index) + 1;
      const quote = [...text.slice(lineStart, marker.index).matchAll(/["“]([^"”]+)["”]/g)].pop()?.[1] ?? null;
      const timestamp = typeof row?.timestamp === 'string' ? row.timestamp : null;
      const eligibility = row ? this.ownerEligibility(marker.ref, row, resolved) : null;
      return {
        raw: marker.raw,
        outcome: resolved.outcome,
        ...(eligibility?.eligible ? { strength: eligibility.strength } : {}),
        eligible: eligibility?.eligible ?? false,
        dateMatches: timestamp ? timestamp.slice(0, 10) === marker.ref.date : null,
        quoteInRecord: row && quote !== null && typeof row.text === 'string' ? quoteIsInRecord(quote, row.text) : null,
      };
    })).then((rows): AttributionSourcesSignal => ({ status: 'resolved', conversationContext, markers: [...rows, ...malformed.map((m) => ({ raw: m.raw, outcome: 'malformed-marker' }))] }));
    return Promise.race([measured, late]).catch(() => unmeasured).finally(() => { if (timer) clearTimeout(timer); });
  }

  /** Eligibility with the logged person's identity. A send signal has no extracted person to compare. */
  private ownerEligibility(ref: SourceRef, row: Record<string, unknown>, resolved: ResolveResult) {
    const platformId = row.telegramUserId ?? row.platformUserId ?? (row.senderPerson as { userId?: unknown } | undefined)?.userId ?? row.peerFingerprint;
    const person = platformId !== undefined ? this.identity.map(ref.channel, String(platformId), { conversation: ref.conversation }) : null;
    if (!person) return { eligible: false as const };
    return checkEligibility({ channel: ref.channel, conversation: ref.conversation, row, person, identity: this.identity.map, authorship: resolved.authorship });
  }

  // ── Resolve, find, trace, status ───────────────────────────────────

  resolve(ref: SourceRef): Promise<ResolveResult> {
    return this.resolveWithPinnedAuthorship(ref);
  }

  resolveLocal(ref: SourceRef): Promise<LocalLookup> {
    return this.resolver.resolveLocal(ref).then((lookup) => {
      if (lookup.pinned) return { ...lookup, authorship: this.pins.readPin(ref)?.authorship };
      return lookup;
    });
  }

  private async resolveWithPinnedAuthorship(ref: SourceRef): Promise<ResolveResult> {
    const resolved = await this.resolver.resolve(ref);
    return resolved.outcome === 'pinned-copy' && !resolved.authorship
      ? { ...resolved, authorship: this.pins.readPin(ref)?.authorship }
      : resolved;
  }

  findLocal(options: FindOptions): Promise<FindCandidate[]> {
    return findLocal({ readers: this.readers, identity: this.identity.map, topicMemory: this.deps.topicMemory, machine: this.deps.machineName }, options);
  }

  find(options: FindOptions, use: BudgetUse = 'write'): Promise<FindResult> {
    return findSources({
      readers: this.readers,
      identity: this.identity.map,
      topicMemory: this.deps.topicMemory,
      machine: this.deps.machineName,
      judge: this.judges[use],
      askPeers: this.deps.peers ? (query) => this.askPeersFind(query) : undefined,
    }, options);
  }

  private async askPeersFind(options: FindOptions) {
    const query = new URLSearchParams({ scope: 'local', person: options.person, claim: boundedHead(options.claim, 500) });
    if (options.around?.date) query.set('date', options.around.date);
    if (options.around?.topicId !== undefined) query.set('topicId', String(options.around.topicId));
    const answers = await this.peers.getAll(`/attribution/find?${query.toString()}`);
    return answers.map((answer) => ({
      machine: answer.machine,
      answered: answer.answered,
      candidates: answer.answered && Array.isArray((answer.json as { candidates?: unknown })?.candidates)
        ? ((answer.json as { candidates: FindCandidate[] }).candidates).filter((c) => typeof c?.text === 'string' && typeof c?.marker === 'string')
        : [],
    }));
  }

  /** This machine's rows matching a query, whole lineages included. What a peer answers with. */
  traceLocal(query: { claim?: string; ref?: SourceRef; q?: string; includeArchives?: boolean }): LedgerRow[] {
    const all = query.includeArchives ? [...this.ledger.archivedRows(), ...this.ledger.rows()] : this.ledger.rows();
    const claimIds = new Set<string>();
    if (query.claim) claimIds.add(query.claim);
    if (query.ref) {
      for (const row of all) {
        if (row.ref?.channel === query.ref.channel && row.ref.conversation === query.ref.conversation && row.ref.message === query.ref.message) claimIds.add(row.claimId);
      }
    }
    if (query.q) {
      const needle = query.q.toLowerCase();
      for (const row of all) if (row.claim.toLowerCase().includes(needle) || row.person.toLowerCase().includes(needle)) claimIds.add(row.claimId);
    }
    const rows = new Map<string, LedgerRow>();
    for (const id of claimIds) for (const row of this.ledger.lineage(id, { includeArchives: query.includeArchives })) rows.set(row.id, row);
    return [...rows.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /** Origin record first, then every row in order, merged across machines, with who did not answer. */
  async trace(query: { claim?: string; ref?: SourceRef; q?: string; includeArchives?: boolean; cursor?: string; limit?: number }): Promise<TraceResult> {
    const local = this.traceLocal(query);
    const failed: string[] = [];
    const merged = new Map<string, LedgerRow>(local.map((row) => [row.id, row]));
    if (this.deps.peers) {
      const params = new URLSearchParams({ scope: 'local' });
      if (query.claim) params.set('claim', query.claim);
      if (query.q) params.set('q', query.q);
      if (query.ref) { params.set('channel', query.ref.channel); params.set('conversation', query.ref.conversation); params.set('message', query.ref.message); params.set('date', query.ref.date); }
      if (query.includeArchives) params.set('archives', '1');
      const collect = (answers: PeerJson[]) => {
        for (const answer of answers) {
          if (!answer.answered) { if (!failed.includes(answer.machine)) failed.push(answer.machine); continue; }
          const rows = (answer.json as { rows?: unknown })?.rows;
          // A peer's rows are data: only the shape this code sorts and shows gets through.
          if (Array.isArray(rows)) for (const row of rows as LedgerRow[]) if (isLedgerRow(row) && !merged.has(row.id)) merged.set(row.id, row);
        }
      };
      collect(await this.peers.getAll(`/attribution/trace?${params.toString()}`));
      // A parent named by another machine's row is asked for once more. Bounded: one extra hop.
      const asked = new Set([query.claim].filter(Boolean) as string[]);
      const newParents = [...merged.values()].map((row) => row.parentClaimId).filter((id): id is string => !!id && !asked.has(id) && ![...merged.values()].some((row) => row.claimId === id));
      if (newParents.length) collect(await this.peers.getAll(`/attribution/trace?scope=local&claim=${encodeURIComponent(newParents[0])}`));
    }
    const ordered = [...merged.values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
    const start = query.cursor ? ordered.findIndex((row) => row.id === query.cursor) + 1 : 0;
    const limit = Math.min(query.limit ?? TRACE_PAGE, 500);
    const page = ordered.slice(start, start + limit);
    const lastIndex = start + page.length;

    let origin: TraceResult['origin'] = null;
    const first = ordered.find((row) => row.ref);
    const ref = query.ref ?? first?.ref;
    if (ref) {
      const resolved = await this.resolveWithPinnedAuthorship(ref);
      for (const machine of resolved.failed) if (!failed.includes(machine)) failed.push(machine);
      const relation = first?.relation;
      origin = {
        ref,
        outcome: resolved.outcome,
        ...(resolved.machine ? { machine: resolved.machine } : {}),
        ...(typeof resolved.row?.text === 'string' ? { text: resolved.row.text } : {}),
        ...(typeof resolved.row?.timestamp === 'string' ? { timestamp: resolved.row.timestamp } : {}),
        ...(relation ? { relation } : {}),
      };
    }
    return {
      query: Object.fromEntries(Object.entries({ claim: query.claim, q: query.q }).filter(([, v]) => v)) as Record<string, string>,
      origin,
      rows: page.map((row) => ({
        ...row,
        ...(row.linkedBy === 'judge' ? { inferred: true } : {}),
        ...(row.relation === 'reconstructed' && row.ref ? { attachedAt: row.ts } : {}),
      })),
      failed,
      nextCursor: lastIndex < ordered.length && page.length ? page[page.length - 1].id : null,
      ...(ordered.length === 0 ? { note: 'No rows on any machine that answered. Rows before the ledger existed have no lineage.' } : {}),
    };
  }

  status(): Record<string, unknown> {
    const budget = this.budget.snapshot();
    const report = this.audit.readReport();
    const counters = budget.counters;
    const unchecked = this.ledger.rows().filter((row) => row.verdict === 'unchecked').length;
    const waiting = report ? report.unsourced.length + report.falseCitations.length + report.notFoundOnLiveMachines.length : 0;
    return {
      enabled: this.enabled,
      mode: this.mode,
      machine: this.deps.machineName,
      budget: { date: budget.date, used: budget.used, limits: budget.limits, auditPerRun: AUDIT_BUDGET },
      counters,
      judgeErrorRate: counters.judgeCalls ? counters.judgeErrors / counters.judgeCalls : null,
      uncheckedRows: unchecked,
      ledgerRows: this.ledger.rows().length,
      pins: this.pins.size,
      filter: {
        skipped: counters.prefilterSkipped,
        sampled: counters.sampleJudged,
        misses: counters.sampleMisses,
        estimatedMissRate: counters.sampleJudged ? counters.sampleMisses / counters.sampleJudged : null,
      },
      audit: this.audit.snapshot(),
      report,
      backlog: report?.backlog ?? null,
      sessionLine: waiting > 0 ? `Attribution report: ${waiting} notes credit someone without a checkable source. Fix them through normal edits; they pass the same check.` : null,
    };
  }

  async runAudit(paths?: string[]): Promise<AuditReport | null> {
    return this.audit.run(paths);
  }

  // ── Lineage by judgment ────────────────────────────────────────────

  /**
   * After the verdict, never slowing a write. A newly found parent is another row, and it triggers a
   * re-check of the earlier-than-the-claim rule against the older root. An unreachable peer leaves the
   * claim pending; the next audit tick tries again.
   */
  private async linkLineage(rows: LedgerRow[], surface: AttributionSurface): Promise<void> {
    for (const row of rows) {
      if (row.parentClaimId || row.person === 'unnamed' || row.kind === 'unchecked-text' || row.verdict === 'unchecked') continue;
      await this.linkOne(row, surface === 'note-write' ? 'write' : 'send');
    }
  }

  private async linkOne(row: LedgerRow, use: BudgetUse): Promise<void> {
    const local = this.ledger.candidatesFor(row.person, row.claimId);
    const peerAnswers = this.deps.peers ? await this.peers.getAll(`/attribution/trace?scope=local&q=${encodeURIComponent(row.person)}`) : [];
    const failed = peerAnswers.filter((answer) => !answer.answered);
    const remote = peerAnswers.flatMap((answer) => {
      const rows = (answer.json as { rows?: unknown })?.rows;
      return Array.isArray(rows) ? (rows as LedgerRow[]) : [];
    }).filter((candidate) => isLedgerRow(candidate) && candidate.claimId !== row.claimId && candidate.person === row.person);
    const seen = new Set<string>();
    const candidates = [...local, ...remote].filter((candidate) => !seen.has(candidate.claimId) && seen.add(candidate.claimId)).slice(0, 20);
    if (candidates.length === 0) {
      if (failed.length) this.markLineagePending(row.claimId);
      return;
    }
    const ruling = await this.judges[use].matchLineage(row.claim, candidates.map((candidate) => candidate.claim));
    if (ruling === null) {
      this.markLineagePending(row.claimId);
      return;
    }
    if (ruling.match === null) {
      if (failed.length) this.markLineagePending(row.claimId);
      return;
    }
    const parent = candidates[ruling.match];
    const { id: _id, ts: _ts, machineId: _machine, ...rest } = row;
    this.ledger.record({ ...rest, parentClaimId: parent.claimId, linkedBy: 'judge' });
    // The older root may now predate the cited record.
    if (row.ref) {
      const resolved = await this.resolveWithPinnedAuthorship(row.ref);
      const recorded = typeof resolved.row?.timestamp === 'string' ? Date.parse(resolved.row.timestamp) : NaN;
      if (Number.isFinite(recorded) && recorded > Date.parse(parent.ts)) {
        this.ledger.record({ ...rest, parentClaimId: parent.claimId, linkedBy: 'judge', verdict: 'later-than-claim', relation: 'reconstructed' });
      }
    }
  }

  private markLineagePending(claimId: string): void {
    try {
      const pending = this.readLineagePending();
      if (pending.includes(claimId) || pending.length >= 2_000) return;
      fs.writeFileSync(this.lineagePendingFile, JSON.stringify([...pending, claimId]), { mode: 0o600 }); /* state-registry: attribution-audit */
    } catch {
      // @silent-fallback-ok — the claim stays unlinked and its row says so; the next write to it retries.
    }
  }

  private readLineagePending(): string[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.lineagePendingFile, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  /** Retries pending links within the audit's retry budget. */
  async retryPendingLineage(limit = 5): Promise<void> {
    const pending = this.readLineagePending();
    if (pending.length === 0) return;
    const rows = this.ledger.rows();
    const left: string[] = [];
    let tried = 0;
    for (const claimId of pending) {
      const row = rows.filter((candidate) => candidate.claimId === claimId).pop();
      if (!row || row.parentClaimId) continue;
      if (tried >= limit) { left.push(claimId); continue; }
      tried += 1;
      await this.linkOne(row, 'send').catch(() => left.push(claimId));
    }
    const stillPending = new Set([...left, ...this.readLineagePending().filter((id) => !pending.includes(id) || left.includes(id))]);
    fs.writeFileSync(this.lineagePendingFile, JSON.stringify([...stillPending]), { mode: 0o600 }); /* state-registry: attribution-audit */
  }

  // ── Internals ──────────────────────────────────────────────────────

  private judgeForSurface(surface: AttributionSurface): AttributionJudge {
    if (surface === 'audit') return this.auditJudges[this.activeSlice];
    return surface === 'note-write' ? this.judges.write : this.judges.send;
  }

  private auditCheck(text: string, context: CheckContext, slice: AuditSlice): Promise<CheckResult> {
    this.activeSlice = slice;
    return this.checkAndCount(text, { ...context, enforced: false });
  }

  private async suggestFor(item: ReportItem): Promise<unknown[]> {
    if (!item.person) return [];
    const found = await findSources({
      readers: this.readers,
      identity: this.identity.map,
      topicMemory: this.deps.topicMemory,
      machine: this.deps.machineName,
      judge: this.auditJudges.retries,
      askPeers: this.deps.peers ? (query) => this.askPeersFind(query) : undefined,
    }, { person: item.person, claim: item.claim });
    // These land in report.json, so the logged text is scrubbed like everything else this feature stores.
    return found.suggestions.map((candidate) => ({ marker: candidate.marker, text: scrubString(candidate.text), strength: candidate.strength }));
  }

  private async machinesAnswering(): Promise<string[]> {
    if (!this.deps.peers) return [];
    const answers = await this.peers.getAll('/health');
    return answers.filter((answer) => answer.answered).map((answer) => answer.machine);
  }

  private reportJudgeFailure(message: string): void {
    if (message === 'attribution-over-budget') return;
    this.reportDegradationOnce(`The model call failed: ${boundedHead(message, 300)}`, 'Claims were written or sent unchecked. The daily audit will re-check them.');
  }

  private reportDegradationOnce(reason: string, impact: string): void {
    const now = nowMs(this.deps);
    if (now - this.lastDegradationAt < DEGRADATION_REPORT_GAP_MS) return;
    this.lastDegradationAt = now;
    this.reportDegradation(reason, impact);
  }

  private reportDegradation(reason: string, impact: string): void {
    DegradationReporter.getInstance().report({
      feature: 'AttributionPaperTrail',
      primary: 'A model checks what a note or message credits to a person',
      fallback: 'The text passes as unchecked and the daily audit checks it later',
      reason,
      impact,
    });
  }
}

function isLedgerRow(row: unknown): row is LedgerRow {
  const value = row as Partial<LedgerRow> | null;
  return !!value && typeof value.id === 'string' && typeof value.claimId === 'string' && typeof value.ts === 'string' && typeof value.claim === 'string' && typeof value.person === 'string';
}

const WAYS_THROUGH = 'Two honest ways through:\n'
  + '1. Quote the exact words and point at the logged message: Name: "exact words" [source: <channel> <conversation>/<message> <YYYY-MM-DD>]\n'
  + '2. Remove the credit and say there is no source: X. An earlier note credited this to Name; source unknown. [source unknown] (or [my inference] if it is your own conclusion). A label removes the credit; it does not decorate it.';

const REASON_TEXT: Record<string, string> = {
  'malformed-marker': 'the source marker does not parse',
  unsourced: 'it credits someone with no source',
  'quote-not-in-record': 'the quoted words are not in that message, or there is no quote beside the marker',
  'date-mismatch': 'the marker date is not the date of that message',
  'record-not-theirs': 'that message is not from this person',
  'identity-unverified': 'nothing on file proves who wrote that message',
  relayed: 'that message passes on someone else\'s words',
  overstated: 'the line is stronger, wider or more permanent than the words',
  'promoted-unsourced': 'the label is there, but the wording still credits them',
  'later-than-claim': 'that message is newer than the claim, so the claim cannot have come from it',
  'cannot-be-shown': 'no machine can show that message',
};

export function refusalText(findings: ClaimFinding[], suggestions: FindCandidate[]): string {
  const lines = findings
    .filter((finding) => finding.verdict === 'refuse')
    .map((finding) => `- "${finding.span}": ${REASON_TEXT[finding.reason ?? ''] ?? finding.reason}${finding.why ? ` (${finding.why})` : ''}`);
  const offered = suggestions.length
    ? `\n\nPossible sources (suggestions only, check each one):\n${suggestions.map((s) => `- ${s.marker}: ${JSON.stringify(boundedHead(s.text, 300))}`).join('\n')}`
    : '';
  return `This write credits someone in a way the logs cannot support:\n${lines.join('\n')}\n\n${WAYS_THROUGH}${offered}`;
}

function peerAdvisory(findings: ClaimFinding[]): string | null {
  const refused = findings.filter((finding) => finding.verdict === 'refuse');
  if (refused.length === 0) return null;
  return `This message credits someone without a checkable source: ${refused.map((finding) => `"${finding.span}" (${REASON_TEXT[finding.reason ?? ''] ?? finding.reason})`).join('; ')}. A peer report proves the peer, not a human yes. Correct it in your next message if it was wrong.`;
}
