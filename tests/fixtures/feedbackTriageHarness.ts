// safe-fs-allow: test fixture — SafeFsExecutor used for tmpdir cleanup.
/**
 * Shared harness for feedback triage tests: a real drain store (in-memory SQLite), the real
 * triage store/audit log/arbiter/service and a real InitiativeTracker; only the model, the
 * processing snapshot and external I/O are scripted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { FeedbackDrainStore } from '../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FeedbackTriageStore } from '../../src/feedback-factory/triage/FeedbackTriageStore.js';
import { FeedbackTriageAuditLog } from '../../src/feedback-factory/triage/FeedbackTriageAuditLog.js';
import {
  FeedbackTriageArbiter, FEEDBACK_TRIAGE_DECISION_POINT, FEEDBACK_TRIAGE_PROMPT_ID, FEEDBACK_TRIAGE_SCHEMA_ID,
} from '../../src/feedback-factory/triage/FeedbackTriageArbiter.js';
import { FeedbackTriageService, type AttentionInput, type TriageLiveConfig } from '../../src/feedback-factory/triage/FeedbackTriageService.js';
import { TRIAGE_AUTHORITY_ID } from '../../src/feedback-factory/triage/triageAuthorityProposal.js';
import type { Cluster, FeedbackItem } from '../../src/feedback-factory/processor/types.js';
import type { IntelligenceOptions, IntelligenceProvider } from '../../src/core/types.js';
import type { TriagePacket } from '../../src/feedback-factory/triage/triagePacket.js';

export const KEY = 'k'.repeat(32);
export const T0 = Date.UTC(2026, 9, 7, 16, 0); // 09:00 in Los Angeles

export type Row = Record<string, unknown>;
export type Decide = (packets: TriagePacket[], prompt: string) => Row[] | string;

export function decisionRow(clusterId: string, over: Row = {}): Row {
  return {
    clusterId, disposition: 'work', reason: 'actionable', duplicateOf: null, fixedBy: null, severity: 'medium', effort: 'm',
    needsSpec: false, userFacing: true, priority: 50, confidence: 0.9, summary: `summary for ${clusterId}`,
    brief: { component: 'scheduler', symptom: 'crash', expected: 'no crash', reproduction: 'run the job' }, ...over,
  };
}

export function packetsFrom(prompt: string): TriagePacket[] {
  const start = prompt.lastIndexOf('<evidence>');
  const end = prompt.lastIndexOf('</evidence>');
  return start >= 0 && end > start ? JSON.parse(prompt.slice(start + '<evidence>'.length, end)) as TriagePacket[] : [];
}

export interface Harness {
  dir: string;
  now: { value: number };
  drain: FeedbackDrainStore;
  store: FeedbackTriageStore;
  audit: FeedbackTriageAuditLog;
  tracker: InitiativeTracker;
  service: FeedbackTriageService;
  clusters: Map<string, Cluster>;
  reports: Map<string, FeedbackItem[]>;
  calls: string[];
  secondCalls: number;
  attention: AttentionInput[];
  degradations: string[];
  sent: Array<{ topicId: number; text: string }>;
  config: TriageLiveConfig & { timeZone?: string };
  quota: { value: number | null };
  model: { model: string; framework: string };
  decide: { fn: Decide };
  second: { verdict: boolean | null; framework: string; available: boolean; advanceMs: number };
  /** Simulated duration of each triage-authority call (advances the harness clock). */
  callAdvanceMs: { value: number };
  approve(action?: 'create' | 'replace' | 'revoke'): void;
  addItem(id: string, opts?: { reports?: number; title?: string; description?: string; createdAt?: number }): Promise<string>;
  cleanup(): void;
}

export async function createHarness(opts: { config?: Partial<TriageLiveConfig>; approve?: boolean; maxWallClockMs?: number } = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-triage-'));
  const now = { value: T0 };
  const drain = new FeedbackDrainStore({ dbPath: ':memory:', db: new Database(':memory:'), tokenHmacKey: KEY, clock: () => now.value });
  const store = new FeedbackTriageStore(drain, { hmacKey: KEY, clock: () => now.value });
  const audit = new FeedbackTriageAuditLog(path.join(dir, 'logs'), path.join(dir, 'store', 'triage-packets'), () => now.value);
  const tracker = new InitiativeTracker(dir);
  const clusters = new Map<string, Cluster>();
  const reports = new Map<string, FeedbackItem[]>();
  const h = {
    dir, now, drain, store, audit, tracker, clusters, reports, calls: [] as string[], secondCalls: 0,
    attention: [] as AttentionInput[], degradations: [] as string[], sent: [] as Array<{ topicId: number; text: string }>,
    config: { maxBatchChars: 24_000, reportsPerItem: 4, charsPerReport: 1_200, maxCallsPerDay: 150, timeZone: 'America/Los_Angeles', ...(opts.config ?? {}) },
    quota: { value: 10 as number | null },
    model: { model: 'gpt-6-astra', framework: 'codex-cli' },
    decide: { fn: ((packets: TriagePacket[]) => packets.map((p) => decisionRow(p.clusterId))) as Decide },
    second: { verdict: true as boolean | null, framework: 'claude-code', available: true, advanceMs: 0 },
    callAdvanceMs: { value: 0 },
  } as Harness;
  const intelligence: IntelligenceProvider = {
    evaluate: async (prompt: string, options?: IntelligenceOptions) => {
      h.calls.push(prompt);
      now.value += h.callAdvanceMs.value;
      options?.onModel?.({ model: h.model.model, framework: h.model.framework });
      options?.provenance?.onCorrelationId?.(`d-test-${h.calls.length}`);
      const out = h.decide.fn(packetsFrom(prompt), prompt);
      return typeof out === 'string' ? out : JSON.stringify({ decisions: out });
    },
  };
  const secondProvider: IntelligenceProvider = {
    evaluate: async (_prompt: string, options?: IntelligenceOptions) => {
      h.secondCalls++;
      now.value += h.second.advanceMs;
      options?.onModel?.({ model: 'claude-opus-4-8', framework: h.second.framework });
      if (h.second.verdict === null) throw new Error('second opinion failed');
      return JSON.stringify({ ignore: h.second.verdict });
    },
  };
  h.service = new FeedbackTriageService({
    drainStore: drain, store, audit,
    processing: { activeClusters: () => [...clusters.values()].map((c) => ({ ...c })), feedbackByCluster: () => new Map([...reports].map(([k, v]) => [k, v.map((r) => ({ ...r }))])) },
    initiatives: tracker,
    arbiter: new FeedbackTriageArbiter(intelligence),
    secondOpinion: () => (h.second.available ? secondProvider : null),
    ownerHost: 'm1', ownerEpoch: () => 1, isCanonicalOwner: () => true,
    config: () => h.config,
    quotaUsedPercent: async () => h.quota.value,
    listMergedPrs: async () => [],
    executorStatus: () => ({ available: false, reason: 'not-built' }),
    raiseAttention: async (item) => { h.attention.push(item); },
    reportDegradation: (event) => { h.degradations.push(event.feature); },
    sendToTopic: async (topicId, text) => { h.sent.push({ topicId, text }); },
    dashboardLink: () => 'https://agent.example/dashboard?tab=feedback-drain',
    ...(opts.maxWallClockMs ? { maxWallClockMs: opts.maxWallClockMs } : {}),
    clock: () => now.value,
  });
  h.approve = (action = 'create') => {
    drain.mutateAuthority({
      action, operatorDecisionRef: `operator-pin-${action}`, authorityId: TRIAGE_AUTHORITY_ID, agentId: 'echo',
      ownerMachineId: 'm1', ownerEpoch: 1, provider: 'codex-cli', modelFamily: 'gpt-6-astra', promptVersion: FEEDBACK_TRIAGE_PROMPT_ID,
      schemaVersion: FEEDBACK_TRIAGE_SCHEMA_ID, decisionPointId: FEEDBACK_TRIAGE_DECISION_POINT, maxBatch: 20, maxTokens: 8000, maxDailySpendUsd: 5,
    });
  };
  h.addItem = async (id, o = {}) => {
    const count = o.reports ?? 1;
    const createdAt = o.createdAt ?? T0 - 2 * 24 * 60 * 60_000;
    clusters.set(id, { clusterId: id, title: o.title ?? `Problem ${id}`, description: '', type: 'bug', reportCount: count, createdAt: new Date(createdAt).toISOString(), updatedAt: new Date(createdAt).toISOString() });
    reports.set(id, Array.from({ length: count }, (_, i) => ({
      feedbackId: `fb-${id}-${i}`, title: o.title ?? `Problem ${id}`, description: o.description ?? `report ${i} body for ${id}`, type: 'bug',
      receivedAt: new Date(createdAt + i * 1000).toISOString(), clusterId: id,
    })));
    const initiative = await tracker.create({
      id: `feedback-${id}`, kind: 'task', pipelineStage: 'outline', feedbackWorkKey: `feedback-work:${id}:1`, title: o.title ?? `Problem ${id}`, description: 'd',
      phases: [{ id: 'class-review', name: 'Class review' }, { id: 'spec', name: 'Spec' }, { id: 'build', name: 'Build' }, { id: 'verify', name: 'Verify' }],
      links: [{ type: 'other', label: 'Feedback cluster', ref: id }],
    });
    return initiative.id;
  };
  h.cleanup = () => { drain.close(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedbackTriageHarness' }); };
  if (opts.approve !== false) h.approve();
  return h;
}

export function setReports(h: Harness, id: string, count: number): void {
  const cluster = h.clusters.get(id)!;
  h.clusters.set(id, { ...cluster, reportCount: count });
  const existing = h.reports.get(id) ?? [];
  while (existing.length < count) existing.push({ feedbackId: `fb-${id}-${existing.length}`, title: cluster.title, description: `later report ${existing.length}`, type: 'bug', receivedAt: new Date(h.now.value).toISOString(), clusterId: id });
  h.reports.set(id, existing);
}
