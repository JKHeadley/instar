/**
 * Production construction of the ecosystem idea pipeline (docs/specs/ecosystem-idea-pipeline.md).
 * Test seams replace only external I/O: model callers, attention and sessions.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { InstarConfig } from '../core/types.js';
import { buildIntelligenceProvider, type IntelligenceFramework } from '../core/intelligenceProviderFactory.js';
import { claudeSupportsReviewerHardening, detectClaudeReviewer, detectCodexReviewer, detectGeminiReviewer, resolveClaudeReviewerModel } from '../core/crossModelReviewer.js';
import { readLatestCodexUsage } from '../providers/adapters/openai-codex/observability/codexRateLimitReader.js';
import { maxUsedPercent } from '../feedback-factory/triage/buildFeedbackTriage.js';
import { EcosystemLedger } from './EcosystemLedger.js';
import { EcosystemIdeaService, type AttentionNotice, type EcosystemIdeaServiceOptions, type EcosystemLimits } from './EcosystemIdeaService.js';
import { GitSourceSearch, type SourceRootSpec, type SourceSearch } from './sourceSearch.js';
import type { FetchOptions } from './projectFetch.js';
import type { ModelCaller } from './types.js';

const execFileAsync = promisify(execFile);

export interface EcosystemIdeasConfig {
  enabled?: boolean;
  sourceRoots?: SourceRootSpec[];
  purposeDoc?: { repo: string; file: string } | null;
  cadenceHours?: number;
  limits?: Partial<EcosystemLimits>;
  agentStartsSpecs?: boolean;
}

export const INSTAR_DEFAULT_ROOTS: SourceRootSpec[] = [{ repo: 'JKHeadley/instar' }, { repo: 'JKHeadley/instar-2', docGlobs: ['docs'] }];
const INSTAR_PURPOSE = { repo: 'JKHeadley/instar-2', file: 'docs/00-the-purpose.md' };

/** The configured roots; an Instar maintainer agent defaults to Instar's own. Empty means 503 no-source. */
export function resolveSourceRoots(config: Pick<InstarConfig, 'developmentAgent'> & { ecosystemIdeas?: EcosystemIdeasConfig }): SourceRootSpec[] {
  return config.ecosystemIdeas?.sourceRoots ?? (config.developmentAgent === true ? INSTAR_DEFAULT_ROOTS : []);
}

/** One call path for probes and real reviews: the framework's locked-down provider, with outside text as the prompt. */
export function productionCallers(config: InstarConfig): ModelCaller[] {
  const callers: ModelCaller[] = [];
  const add = (framework: IntelligenceFramework, options: (timeoutMs: number) => Parameters<NonNullable<ReturnType<typeof buildIntelligenceProvider>>['evaluate']>[1]) => {
    let provider: ReturnType<typeof buildIntelligenceProvider> = null;
    try { provider = buildIntelligenceProvider({ framework }); } catch { return; /* @silent-fallback-ok: an unusable framework is simply not offered, and shows as absent on the status route */ }
    if (!provider) return;
    const usable = provider;
    callers.push({
      framework, family: framework,
      call: (prompt, { timeoutMs }) => usable.evaluate(prompt, options(timeoutMs)),
    });
  };
  const attribution = { component: 'EcosystemIdeaReview' };
  if (detectCodexReviewer().available) add('codex-cli', (timeoutMs) => ({ model: 'capable', noLocalTools: true, timeoutMs, attribution }));
  if (detectGeminiReviewer().available) add('gemini-cli', (timeoutMs) => ({ model: 'capable', timeoutMs, attribution }));
  if (detectClaudeReviewer().available && claudeSupportsReviewerHardening()) {
    const model = resolveClaudeReviewerModel(config as never);
    if (model.ok) add('claude-code', (timeoutMs) => ({ reviewerHardening: { model: model.model, noTools: true }, timeoutMs, attribution }));
  }
  return callers;
}

const VERSION_BIN: Record<string, string> = { 'codex-cli': 'codex', 'gemini-cli': 'gemini', 'claude-code': 'claude' };

async function cliVersion(framework: string): Promise<string> {
  const bin = VERSION_BIN[framework];
  if (!bin) return 'unknown';
  const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 20_000 });
  return stdout.trim().slice(0, 80);
}

export interface EcosystemRouteContext {
  service: EcosystemIdeaService;
  ledger: EcosystemLedger;
  isHolder: () => boolean;
  holderName: () => string | null;
  stop: () => void;
}

export interface BuildEcosystemInput {
  config: InstarConfig & { ecosystemIdeas?: EcosystemIdeasConfig };
  ledger?: EcosystemLedger;
  machineId: () => string;
  isHolder: () => boolean;
  holderName: () => string | null;
  epoch: () => number;
  raiseAttention: (notice: AttentionNotice) => Promise<void>;
  closeAttention: (conditionKey: string, resolution: string) => Promise<void>;
  startSession: (name: string, brief: string) => Promise<void>;
  sessionExists: (name: string) => Promise<boolean>;
  claudeQuotaPercent?: () => Promise<number | null>;
  overrides?: Partial<Pick<EcosystemIdeaServiceOptions, 'callers' | 'frameworkVersion' | 'quotaUsedPercent' | 'testOnlySkipFileRead' | 'clock'>> & { search?: SourceSearch; fetch?: FetchOptions };
}

export function ecosystemDir(stateDir: string): string { return path.join(stateDir, 'state', 'ecosystem'); }

export function buildEcosystemIdeas(input: BuildEcosystemInput): EcosystemRouteContext | { unavailable: 'no-source' } {
  const { config } = input;
  const roots = resolveSourceRoots(config);
  if (roots.length === 0 && !input.overrides?.search) return { unavailable: 'no-source' };
  const dir = ecosystemDir(config.stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const ledger = input.ledger ?? new EcosystemLedger({ dir, machineId: input.machineId, clock: input.overrides?.clock });
  const search: SourceSearch = input.overrides?.search ?? new GitSourceSearch({
    dir, roots,
    attachEmbeddings: async (memory) => {
      const { EmbeddingProvider } = await import('../memory/EmbeddingProvider.js');
      const provider = new EmbeddingProvider();
      if (!await provider.loadVecModule()) return false;
      memory.setEmbeddingProvider(provider);
      if (!await memory.initializeVectorSearch()) return false;
      await provider.initialize();
      return true;
    },
    ...(input.overrides?.fetch ?? {}),
  });
  const logFile = path.join(config.stateDir, 'logs', 'ecosystem-ideas.jsonl');
  const service = new EcosystemIdeaService({
    ledger, dir,
    callers: input.overrides?.callers ?? (() => productionCallers(config)),
    frameworkVersion: input.overrides?.frameworkVersion ?? cliVersion,
    search,
    purposeDoc: config.ecosystemIdeas?.purposeDoc !== undefined ? config.ecosystemIdeas.purposeDoc : (roots.some((r) => r.repo === INSTAR_PURPOSE.repo) ? INSTAR_PURPOSE : null),
    isHolder: input.isHolder,
    holderName: input.holderName,
    epoch: input.epoch,
    quotaUsedPercent: input.overrides?.quotaUsedPercent ?? (async (framework) => {
      if (framework === 'codex-cli') return maxUsedPercent(await readLatestCodexUsage().catch(() => null));
      if (framework === 'claude-code') return input.claudeQuotaPercent ? input.claudeQuotaPercent() : null;
      return null;
    }),
    raiseAttention: input.raiseAttention,
    closeAttention: input.closeAttention,
    startSession: input.startSession,
    sessionExists: input.sessionExists,
    audit: (entry) => {
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
      } catch { /* @silent-fallback-ok: an audit line must never stop a review; the ledger keeps the record */ }
    },
    fetch: input.overrides?.fetch,
    limits: config.ecosystemIdeas?.limits,
    cadenceHours: config.ecosystemIdeas?.cadenceHours,
    agentStartsSpecs: config.ecosystemIdeas?.agentStartsSpecs,
    testOnlySkipFileRead: input.overrides?.testOnlySkipFileRead,
    clock: input.overrides?.clock,
  });
  return { service, ledger, isHolder: input.isHolder, holderName: input.holderName, stop: () => search.close() };
}
