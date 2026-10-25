// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Wiring integrity for feedback triage's production construction (buildFeedbackTriage):
 * dependencies are real, not null and not no-ops — the triage store shares the drain's
 * database and owner fence, the arbiter is built from the provided intelligence, the owner
 * helpers delegate, and the quota reader turns real usage windows into a pause signal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { FeedbackDrainStore } from '../../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { InitiativeTracker } from '../../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { buildFeedbackTriage, maxUsedPercent } from '../../../src/feedback-factory/triage/buildFeedbackTriage.js';
import type { InstarConfig } from '../../../src/core/types.js';
import type { FeedbackProcessingService } from '../../../src/feedback-factory/processing/FeedbackProcessingService.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'triage-wiring.test.ts' }); });

function build(overrides: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-wiring-'));
  dirs.push(dir);
  const drain = new FeedbackDrainStore({ dbPath: ':memory:', db: new Database(':memory:'), tokenHmacKey: 'k'.repeat(32) });
  const processing = { activeClusters: () => [], feedbackByCluster: () => new Map() } as unknown as FeedbackProcessingService;
  const ctx = buildFeedbackTriage({
    config: { stateDir: dir, projectDir: dir, port: 4999, authToken: 't', feedbackFactory: { triage: { maxCallsPerDay: 7 }, execute: { actionTopicId: 99 } } } as unknown as InstarConfig,
    drainStore: drain, processing, initiativeTracker: new InitiativeTracker(dir), intelligence: { evaluate: async () => '' },
    dataDir: path.join(dir, 'store'), tokenKey: Buffer.alloc(32, 1), ownerHost: 'm1', ownerMachineId: () => 'm1', ownerEpoch: () => 3,
    isCanonicalOwner: () => true, codexLiveUsageReader: null, subscriptionPool: null, telegram: null,
    raiseAttention: async () => {}, tunnelUrl: () => null, ...overrides,
  });
  return { ctx, drain };
}

describe('buildFeedbackTriage wiring', () => {
  it('shares the drain database and its owner fence; reads live config; the arbiter is real', async () => {
    const { ctx, drain } = build();
    ctx.store.ensure(3, { initiativeId: 'i1', clusterId: 'c1', feedbackWorkKey: 'feedback-work:c1:1', firstSeenAt: 0, reportCount: 1 });
    expect(drain.sharedDatabase().prepare("SELECT COUNT(*) n FROM triage").get()).toEqual({ n: 1 });
    expect(ctx.service.summary()).toMatchObject({ authority: 'awaiting-approval', maxCallsPerDay: 7, executor: { available: false, reason: 'not-built' } });
    expect((await ctx.service.tick()).reason).toBe('authority-awaiting-approval');
    expect(ctx.ownerMachineId()).toBe('m1');
    expect(ctx.isCanonicalOwner()).toBe(true);
    expect(await ctx.fetchFromOwner('/feedback-factory/triage/summary')).toBeNull();
  });
  it('delivers the action list through the configured topic when telegram is present', async () => {
    const sent: Array<[number, string]> = [];
    // 16:00 UTC is outside the 23:00–07:30 quiet window in every UTC-8..UTC+6 host time zone.
    const { ctx } = build({ telegram: { sendToTopic: async (topic: number, text: string) => { sent.push([topic, text]); } }, overrides: { clock: () => Date.UTC(2026, 9, 7, 16, 0) } });
    const result = await ctx.service.sendActionList();
    expect(result.sent).toBe(true);
    expect(sent[0][0]).toBe(99);
    expect(sent[0][1]).toContain('/dashboard?tab=feedback-drain');
  });
  it('maxUsedPercent takes the higher window and refuses to guess', () => {
    const w = (usedPercent: number) => ({ usedPercent, remainingPercent: 100 - usedPercent, windowMinutes: 300, resetsAt: 0, resetsAtIso: null, resetsInSeconds: null });
    const now = Date.UTC(2026, 9, 9, 12, 0);
    const base = { source: 'codex-rollout' as const, rolloutPath: '', threadId: null, capturedAt: new Date(now - 5 * 60_000).toISOString(), model: null, planType: null, rateLimitReachedType: null };
    expect(maxUsedPercent({ ...base, primary: w(40), secondary: w(76) }, now)).toBe(76);
    // A rollout reading older than 60 minutes, or undated, cannot vouch for headroom → null (pause).
    expect(maxUsedPercent({ ...base, capturedAt: new Date(now - 61 * 60_000).toISOString(), primary: w(10), secondary: w(10) }, now)).toBeNull();
    expect(maxUsedPercent({ ...base, capturedAt: null, primary: w(10), secondary: w(10) }, now)).toBeNull();
    // The live app-server reading is current by construction.
    expect(maxUsedPercent({ ...base, source: 'codex-app-server', capturedAt: null, primary: w(10), secondary: w(20) }, now)).toBe(20);
    expect(maxUsedPercent({ ...base, primary: null, secondary: null })).toBeNull();
    expect(maxUsedPercent({ ...base, primary: null, secondary: null, windowsUnavailable: true })).toBeNull();
    expect(maxUsedPercent(null)).toBeNull();
  });
});

describe('audit log retention', () => {
  it('rotates at 20 MB, prunes rotated segments after 90 days and packets after 14 days', async () => {
    const { FeedbackTriageAuditLog, TRIAGE_LOG_MAX_BYTES } = await import('../../../src/feedback-factory/triage/FeedbackTriageAuditLog.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-audit-'));
    dirs.push(dir);
    let now = Date.UTC(2026, 9, 7);
    const log = new FeedbackTriageAuditLog(path.join(dir, 'logs'), path.join(dir, 'packets'), () => now);
    log.append('decision', { initiativeId: 'feedback-a', note: 'free text that is not an id, it is replaced by its length' });
    expect(fs.readFileSync(log.path(), 'utf8')).toContain('"note":"[text:');
    fs.truncateSync(log.path(), TRIAGE_LOG_MAX_BYTES);
    log.append('decision', { initiativeId: 'feedback-b' });
    const rotated = fs.readdirSync(path.join(dir, 'logs')).filter((n) => n.startsWith('feedback-triage.jsonl.'));
    expect(rotated).toHaveLength(1);
    expect(fs.statSync(log.path()).size).toBeLessThan(1_000);
    log.writePacket('pkt-' + 'a'.repeat(24), { x: 1 });
    expect(log.readPacket('pkt-' + 'a'.repeat(24))).toEqual({ x: 1 });
    now = Date.now() + 120 * 24 * 60 * 60_000; // file mtimes are real; age them past both windows
    expect(log.prunePackets()).toBe(1);
    expect(log.pruneRotated()).toBe(1);
  });
});
