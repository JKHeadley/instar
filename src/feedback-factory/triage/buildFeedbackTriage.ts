/**
 * Production construction of feedback triage (docs/specs/feedback-triage-and-execution.md).
 * Called from AgentServer inside the operated-drain block, so triage shares the drain's
 * store, owner fence and epoch. Test seams (`overrides`) replace only external I/O.
 */
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InstarConfig, IntelligenceProvider } from '../../core/types.js';
import type { InitiativeTracker } from '../../core/InitiativeTracker.js';
import type { FeedbackDrainStore } from '../drain/FeedbackDrainStore.js';
import type { FeedbackProcessingService } from '../processing/FeedbackProcessingService.js';
import type { SubscriptionPool } from '../../core/SubscriptionPool.js';
import type { CodexUsageSnapshot } from '../../providers/adapters/openai-codex/observability/codexRateLimitReader.js';
import { readLatestCodexUsage } from '../../providers/adapters/openai-codex/observability/codexRateLimitReader.js';
import { buildIntelligenceProvider, type IntelligenceFramework } from '../../core/intelligenceProviderFactory.js';
import { LlmCircuitBreaker } from '../../core/LlmCircuitBreaker.js';
import { DegradationReporter } from '../../monitoring/DegradationReporter.js';
import { FeedbackTriageArbiter } from './FeedbackTriageArbiter.js';
import { FeedbackTriageStore } from './FeedbackTriageStore.js';
import { FeedbackTriageAuditLog } from './FeedbackTriageAuditLog.js';
import { FeedbackTriageService, resolveTriageConfig, type AttentionInput, type FeedbackTriageServiceOptions } from './FeedbackTriageService.js';
import type { MergedPr } from './triagePacket.js';

const execFileAsync = promisify(execFile);

export interface FeedbackTriageRouteContext {
  service: FeedbackTriageService;
  store: FeedbackTriageStore;
  /** The shared audit log (logs/feedback-triage.jsonl); the executor appends its transitions here too. */
  audit: FeedbackTriageAuditLog;
  ownerMachineId: () => string | null;
  isCanonicalOwner: () => boolean;
  /** Fetch a GET route from the owner over the authenticated peer transport; null when unreachable or no transport. */
  fetchFromOwner: (route: string) => Promise<{ status: number; body: unknown } | null>;
  /** Last owner copy per route, for stale fallback when the owner is unreachable. */
  ownerCache: Map<string, { body: unknown; fetchedAt: number }>;
}

/** A usage reading older than this cannot vouch for current headroom (matches the Claude branch). */
export const QUOTA_READING_MAX_AGE_MS = 60 * 60_000;

/**
 * Highest used percent across the account's usage windows, or null when it cannot be read.
 * A rollout-file reading is only as fresh as the account's last completed turn, so one older
 * than QUOTA_READING_MAX_AGE_MS (or undated) is treated as unreadable → triage pauses.
 */
export function maxUsedPercent(snapshot: CodexUsageSnapshot | null, now: number = Date.now()): number | null {
  if (!snapshot || snapshot.windowsUnavailable) return null;
  if (snapshot.source === 'codex-rollout') {
    const captured = snapshot.capturedAt ? Date.parse(snapshot.capturedAt) : NaN;
    if (!Number.isFinite(captured) || now - captured > QUOTA_READING_MAX_AGE_MS) return null;
  }
  const windows = [snapshot.primary, snapshot.secondary].filter((w): w is NonNullable<typeof w> => w !== null);
  if (windows.length === 0) return null;
  return Math.max(...windows.map((w) => w.usedPercent));
}

export function buildFeedbackTriage(input: {
  config: InstarConfig;
  drainStore: FeedbackDrainStore;
  processing: FeedbackProcessingService;
  initiativeTracker: InitiativeTracker;
  intelligence: IntelligenceProvider | null;
  dataDir: string;
  tokenKey: Buffer;
  ownerHost: string;
  ownerMachineId: () => string | null;
  ownerEpoch: () => number;
  isCanonicalOwner: () => boolean;
  resolvePeerUrls?: () => Array<{ machineId: string; url: string }>;
  codexLiveUsageReader: ((opts?: { codexHome?: string }) => Promise<CodexUsageSnapshot | null>) | null;
  subscriptionPool: SubscriptionPool | null;
  telegram: { sendToTopic: (topicId: number, text: string, opts?: { provenance?: 'automation' }) => Promise<unknown> } | null;
  raiseAttention: (item: AttentionInput) => Promise<void>;
  tunnelUrl: () => string | null;
  overrides?: Partial<Pick<FeedbackTriageServiceOptions, 'secondOpinion' | 'quotaUsedPercent' | 'listMergedPrs' | 'sendToTopic' | 'raiseAttention' | 'clock'>>;
}): FeedbackTriageRouteContext {
  const { config } = input;
  const clock = input.overrides?.clock ?? Date.now;
  const store = new FeedbackTriageStore(input.drainStore, { hmacKey: input.tokenKey, clock });
  const audit = new FeedbackTriageAuditLog(path.join(config.stateDir, 'logs'), path.join(input.dataDir, 'triage-packets'), clock);

  // Second opinion: one dedicated provider per framework (own breaker), built lazily.
  const secondOpinionCache = new Map<IntelligenceFramework, IntelligenceProvider | null>();
  const secondOpinion = input.overrides?.secondOpinion ?? ((exclude: string) => {
    for (const framework of ['claude-code', 'codex-cli', 'gemini-cli'] as IntelligenceFramework[]) {
      if (framework === exclude) continue;
      if (!secondOpinionCache.has(framework)) {
        let provider: IntelligenceProvider | null = null;
        try { provider = buildIntelligenceProvider({ framework, breaker: new LlmCircuitBreaker() }); } catch { provider = null; }
        secondOpinionCache.set(framework, provider);
      }
      const provider = secondOpinionCache.get(framework);
      if (provider) return provider;
    }
    return null;
  });

  const quotaUsedPercent = input.overrides?.quotaUsedPercent ?? (async (framework: string): Promise<number | null> => {
    if (framework === 'codex-cli') {
      let snapshot: CodexUsageSnapshot | null = null;
      if (input.codexLiveUsageReader) { try { snapshot = await input.codexLiveUsageReader(); } catch { snapshot = null; } }
      if (!snapshot) { try { snapshot = await readLatestCodexUsage(); } catch { snapshot = null; } }
      return maxUsedPercent(snapshot, clock());
    }
    if (framework === 'claude-code' && input.subscriptionPool) {
      const home = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
      const account = input.subscriptionPool.list().find((a) => a.framework === 'claude-code' && path.resolve(a.configHome) === home);
      const quota = account?.lastQuota;
      const measured = quota?.measuredAt ? Date.parse(quota.measuredAt) : NaN;
      if (!quota || !Number.isFinite(measured) || clock() - measured > 60 * 60_000) return null;
      const values = [quota.fiveHour?.utilizationPct, quota.sevenDay?.utilizationPct].filter((v): v is number => typeof v === 'number');
      return values.length ? Math.max(...values) : null;
    }
    return null;
  });

  const listMergedPrs = input.overrides?.listMergedPrs ?? (async (): Promise<MergedPr[] | null> => {
    try {
      const since = new Date(clock() - 30 * 24 * 60 * 60_000).toISOString().slice(0, 10);
      const { stdout } = await execFileAsync('gh', ['pr', 'list', '--state', 'merged', '--search', `merged:>=${since}`, '--limit', '200', '--json', 'number,title,body,commits'],
        { cwd: config.projectDir, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
      // RULE 3: EXEMPT — not a provider/CLI state-detector: this parses gh's documented --json output (a
      // stable, versioned data contract) into a list of merged PRs; any parse error yields `unknown`.
      const parsed = JSON.parse(stdout) as Array<{ number: number; title?: string; body?: string; commits?: Array<{ messageHeadline?: string; messageBody?: string }> }>;
      if (!Array.isArray(parsed)) return null;
      return parsed.map((pr) => ({
        number: pr.number, title: String(pr.title ?? ''), body: String(pr.body ?? ''),
        commits: (pr.commits ?? []).map((c) => `${c.messageHeadline ?? ''}\n${c.messageBody ?? ''}`),
      }));
    } catch {
      return null; // @silent-fallback-ok: the packet carries mergedPrs 'unknown' and floor 6 holds possibly-fixed
    }
  });

  const telegram = input.telegram;
  const sendToTopic = input.overrides?.sendToTopic ?? (telegram ? async (topicId: number, text: string) => { await telegram.sendToTopic(topicId, text, { provenance: 'automation' }); } : undefined);

  const service = new FeedbackTriageService({
    drainStore: input.drainStore,
    store,
    audit,
    processing: input.processing,
    initiatives: input.initiativeTracker,
    arbiter: input.intelligence ? new FeedbackTriageArbiter(input.intelligence) : null,
    secondOpinion,
    ownerHost: input.ownerHost,
    ownerEpoch: input.ownerEpoch,
    isCanonicalOwner: input.isCanonicalOwner,
    config: () => resolveTriageConfig(config.feedbackFactory?.triage as Record<string, unknown> | undefined, config.feedbackFactory?.execute as Record<string, unknown> | undefined),
    quotaUsedPercent,
    listMergedPrs,
    executorStatus: () => ({ available: false, reason: 'not-built' }),
    raiseAttention: input.overrides?.raiseAttention ?? input.raiseAttention,
    reportDegradation: (event) => DegradationReporter.getInstance().report(event),
    sendToTopic,
    dashboardLink: () => `${input.tunnelUrl() ?? `http://localhost:${config.port}`}/dashboard?tab=feedback-drain`,
    clock,
  });

  const fetchFromOwner = async (route: string): Promise<{ status: number; body: unknown } | null> => {
    const owner = input.ownerMachineId();
    if (!owner || !input.resolvePeerUrls) return null;
    const peer = input.resolvePeerUrls().find((candidate) => candidate.machineId === owner);
    if (!peer) return null;
    try {
      const response = await fetch(`${peer.url}${route}`, {
        headers: { Authorization: `Bearer ${config.authToken ?? ''}`, 'X-Instar-AgentId': config.projectName },
        signal: AbortSignal.timeout(5_000),
      });
      return { status: response.status, body: await response.json() };
    } catch { return null; }
  };

  return { service, store, audit, ownerMachineId: input.ownerMachineId, isCanonicalOwner: input.isCanonicalOwner, fetchFromOwner, ownerCache: new Map() };
}
