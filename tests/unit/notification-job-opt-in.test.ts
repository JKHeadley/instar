import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotificationSelectivityGate, verifiedJobEnvelope, isVerifiedJobEnvelope } from '../../src/messaging/NotificationSelectivityGate.js';
import type { OutboundEnvelope, SelectivityConfig } from '../../src/messaging/NotificationSelectivityGate.js';
import { NotificationPreferences } from '../../src/messaging/NotificationPreferences.js';
import { isNotificationJobSlug, jobReportChoice, scheduledJobSlug } from '../../src/messaging/notificationCategories.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function gateWith(push: SelectivityConfig['push'], now = Date.now) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-opt-in-'));
  const config: SelectivityConfig = { enabled: true, dryRun: false, push };
  const gate = new NotificationSelectivityGate(root, 'machine-a', () => config, now);
  cleanup.push(async () => { await gate.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/notification-job-opt-in.test.ts' }); });
  return { gate, root, config };
}

describe('per-job opt-in decision', () => {
  it('delivers a verified report from the opted-in job with its own reason', async () => {
    const { gate } = gateWith({ jobs: { 'instar2-checkin': true } });
    const { verdict, receipt } = await gate.route(102965, 'status', verifiedJobEnvelope('instar2-checkin'));
    expect(verdict).toMatchObject({ decision: 'deliver-push', reason: 'job-opt-in', category: 'job-status' });
    expect(receipt).toBeUndefined();
  });
  it('keeps every other job quiet', async () => {
    const { gate } = gateWith({ jobs: { 'instar2-checkin': true } });
    const { verdict, receipt } = await gate.route(1, 'status', verifiedJobEnvelope('bugs-overseer'));
    expect(verdict).toMatchObject({ decision: 'record', reason: 'quiet-default' });
    expect(receipt?.recorded).toBe(true);
  });
  it('keeps a claimed slug quiet: a plain envelope naming an opted-in job has no authority', async () => {
    const { gate } = gateWith({ jobs: { 'instar2-checkin': true } });
    const forged: OutboundEnvelope = { origin: 'automated', category: 'job-status', sourceContext: 'instar2-checkin', verifiedJobSlug: 'instar2-checkin' };
    expect(isVerifiedJobEnvelope(forged)).toBe(false);
    expect((await gate.route(1, 'URGENT from instar2-checkin', forged)).verdict).toMatchObject({ decision: 'record', reason: 'quiet-default' });
  });
  it('a spread copy of a verified envelope loses the capability', async () => {
    const { gate } = gateWith({ jobs: { 'instar2-checkin': true } });
    const copied = { ...verifiedJobEnvelope('instar2-checkin') };
    expect((await gate.route(1, 'x', copied)).verdict.decision).toBe('record');
  });
  it('a verified envelope mutated to another slug loses the opt-in', async () => {
    const { gate } = gateWith({ jobs: { 'instar2-checkin': true } });
    const envelope = verifiedJobEnvelope('bugs-overseer'); envelope.sourceContext = 'instar2-checkin';
    expect((await gate.route(1, 'x', envelope)).verdict.decision).toBe('record');
  });
  it('an explicit false, an absent key and an inherited name all stay quiet', async () => {
    const { gate } = gateWith({ jobs: { off: false } });
    expect((await gate.route(1, 'x', verifiedJobEnvelope('off'))).verdict.decision).toBe('record');
    expect((await gate.route(1, 'x', verifiedJobEnvelope('never-asked'))).verdict.decision).toBe('record');
    expect((await gate.route(1, 'x', verifiedJobEnvelope('constructor'))).verdict.decision).toBe('record');
  });
  it('priority fields confer nothing on an unopted job', async () => {
    const { gate } = gateWith({ jobs: {} });
    const envelope = verifiedJobEnvelope('some-job'); envelope.significantClass = 'security-incident';
    expect((await gate.route(1, 'SECURITY', envelope)).verdict.decision).toBe('record');
  });
  it('a category opt-in keeps its existing reason', async () => {
    const { gate } = gateWith({ categories: { 'job-status': true }, jobs: { a: true } });
    expect((await gate.route(1, 'x', verifiedJobEnvelope('a'))).verdict.reason).toBe('category-opt-in');
  });
  it('dry run and a disabled gate keep their existing decisions', async () => {
    const dry = gateWith({ jobs: { a: true } }); dry.config.dryRun = true;
    expect((await dry.gate.route(1, 'x', verifiedJobEnvelope('a'))).verdict.dryRun).toBe(true);
    const off = gateWith({ jobs: { a: true } }); off.config.enabled = false;
    expect((await off.gate.route(1, 'x', verifiedJobEnvelope('a'))).verdict.reason).toBe('disabled');
  });
  it('shares the job-status push budget, recording past it', async () => {
    const { gate } = gateWith({ jobs: { a: true, b: true } });
    const reasons: string[] = [];
    for (const slug of ['a', 'b', 'a', 'b']) reasons.push((await gate.route(1, 'x', verifiedJobEnvelope(slug))).verdict.reason);
    expect(reasons).toEqual(['job-opt-in', 'job-opt-in', 'job-opt-in', 'push-budget']);
  });
  it('sends the overflow line for an opted-in job even with the category off', async () => {
    vi.useFakeTimers();
    try {
      const { gate } = gateWith({ jobs: { a: true } });
      gate.onSummary = vi.fn().mockResolvedValue(undefined);
      for (let i = 0; i < 4; i++) await gate.route(1, 'x', verifiedJobEnvelope('a'));
      await vi.advanceTimersByTimeAsync(600000);
      expect(gate.onSummary).toHaveBeenCalledTimes(1);
      expect(vi.mocked(gate.onSummary).mock.calls[0][0]).toContain('scheduled job reports');
    } finally { vi.useRealTimers(); }
  });
  it('an opted-in report stays only in the topic the operator chose it in', () => {
    const { gate } = gateWith({ jobs: { a: true, b: true }, jobTopics: { a: 102965, b: null } });
    const hub = { chatId: '-1', topicId: 99 };
    gate.pushDestination = () => hub;
    expect(gate.destination(verifiedJobEnvelope('a'), 102965)).toBeNull();
    expect(gate.destination(verifiedJobEnvelope('a'), 555)).toEqual(hub);
    expect(gate.destination(verifiedJobEnvelope('a'))).toEqual(hub);
    expect(gate.destination(verifiedJobEnvelope('b'), 102965)).toEqual(hub);
    expect(gate.destination(verifiedJobEnvelope('c'), 102965)).toEqual(hub);
    expect(gate.destination({ origin: 'automated', category: 'job-status', sourceContext: 'a', verifiedJobSlug: 'a' }, 102965)).toEqual(hub);
  });
  it('holdsCategory stays category-level', () => {
    const { gate } = gateWith({ jobs: { a: true } });
    expect(gate.holdsCategory('job-status')).toBe(true);
    expect(gate.categoryPushEnabled('job-status')).toBe(false);
  });
  it('lists pushed jobs in the digest inventory', async () => {
    const { gate, config } = gateWith({ jobs: { 'instar2-checkin': true, off: false } });
    config.digest = { enabled: true, cadence: 'daily' };
    await gate.route(1, 'x', verifiedJobEnvelope('other'));
    gate.onSummary = vi.fn().mockResolvedValue(undefined);
    await gate.tickDigest();
    const text = vi.mocked(gate.onSummary).mock.calls[0][0];
    expect(text).toContain('Pushed jobs: instar2-checkin');
    expect(text).not.toContain('off');
  });
});

describe('job preference writer', () => {
  function writer(extra: Partial<ConstructorParameters<typeof NotificationPreferences>[0]> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-pref-'));
    const jobs = new Map<string, boolean>();
    const topics = new Map<string, number | undefined>();
    const send = vi.fn().mockResolvedValue(true);
    const apply = vi.fn();
    const preferences = new NotificationPreferences({ root, self: () => 'machine-a', peers: () => ['machine-b'], apply, send,
      applyJob: (slug, enabled, topicId) => { jobs.set(slug, enabled); topics.set(slug, topicId); }, ...extra });
    cleanup.push(async () => { await preferences.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/notification-job-opt-in.test.ts' }); });
    return { preferences, root, jobs, topics, send, apply };
  }
  it('writes the job, never the category, and replicates an intent an older peer rejects', async () => {
    const { preferences, jobs, send, apply } = writer();
    const intent = await preferences.setJob('instar2-checkin', true, 'dashboard-pin');
    await preferences.drain();
    expect(jobs.get('instar2-checkin')).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    expect(intent).not.toHaveProperty('category');
    expect(send).toHaveBeenCalledWith('machine-b', expect.objectContaining({ job: 'instar2-checkin', enabled: true }));
  });
  it('carries the confirming topic to every machine and refuses a malformed one', async () => {
    const source = writer(); const target = writer();
    const intent = await source.preferences.setJob('a', true, 'operator-conversational-confirm', 102965);
    expect(await target.preferences.receive(intent, 'machine-a')).toBe(true);
    expect(target.topics.get('a')).toBe(102965);
    for (const topicId of [0, -1, 1.5, '7']) expect(await target.preferences.receive({ ...intent, topicId, version: intent.version.replace(/^\d{4}/, '2099') }, 'machine-a')).toBe(false);
  });
  it('keeps a slow retry for a peer that exhausted its attempts, for one that upgrades in place', async () => {
    const { preferences, send } = writer();
    send.mockResolvedValue(false);
    await preferences.setJob('a', true, 'dashboard-pin');
    const internals = preferences as unknown as { pending: Array<{ attempts: number; nextAt: number }> };
    internals.pending[0].attempts = 8; internals.pending[0].nextAt = Date.now() - 1000;
    await preferences.drain(); expect(send).not.toHaveBeenCalled();
    internals.pending[0].nextAt = Date.now() - 86400001;
    send.mockResolvedValue(true);
    await preferences.drain(); expect(send).toHaveBeenCalledOnce();
    expect(preferences.status().pending).toBe(0);
  });
  it('applies a peer intent once and ignores an older one', async () => {
    const source = writer(); const target = writer();
    const newer = await source.preferences.setJob('a', true, 'dashboard-pin');
    expect(await target.preferences.receive(newer, 'machine-a')).toBe(true);
    expect(target.jobs.get('a')).toBe(true);
    const older = { ...newer, enabled: false, version: newer.version.replace(/^\d{4}/, '2000') };
    expect(await target.preferences.receive(older, 'machine-a')).toBe(true);
    expect(target.jobs.get('a')).toBe(true);
  });
  it('rejects bad slugs and a sender that is not the issuer', async () => {
    const { preferences, jobs } = writer();
    const intent = await preferences.setJob('a', true, 'dashboard-pin');
    jobs.clear();
    expect(await preferences.receive({ ...intent, job: '__proto__' }, 'machine-a')).toBe(false);
    expect(await preferences.receive({ ...intent, job: 'a.b' }, 'machine-a')).toBe(false);
    expect(await preferences.receive(intent, 'machine-z')).toBe(false);
    expect(jobs.size).toBe(0);
  });
  it('rejects an intent naming both a category and a job', async () => {
    const { preferences, jobs, apply } = writer();
    const intent = await preferences.setJob('a', true, 'dashboard-pin'); jobs.clear();
    expect(await preferences.receive({ ...intent, category: 'job-status' }, 'machine-a')).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });
  it('job choices and category choices keep separate versions', async () => {
    const { preferences, jobs, apply } = writer();
    await preferences.set('job-status', true, 'dashboard-pin');
    await preferences.setJob('job-status', true, 'dashboard-pin');
    expect(apply).toHaveBeenCalledTimes(1); expect(jobs.get('job-status')).toBe(true);
  });
  it('survives a restart and reapplies the durable choice', async () => {
    const first = writer(); await first.preferences.setJob('a', true, 'dashboard-pin'); await first.preferences.close();
    const jobs = new Map<string, boolean>();
    const state = JSON.parse(fs.readFileSync(path.join(first.root, 'state', 'notification-preferences.json'), 'utf8'));
    expect(state.desired['job:a']).toMatchObject({ job: 'a', enabled: true });
    state.versions = {}; fs.writeFileSync(path.join(first.root, 'state', 'notification-preferences.json'), JSON.stringify(state));
    const restarted = new NotificationPreferences({ root: first.root, self: () => 'machine-a', peers: () => [], apply: vi.fn(), send: vi.fn(), applyJob: (slug, enabled) => jobs.set(slug, enabled) });
    await restarted.ready; await restarted.close();
    expect(jobs.get('a')).toBe(true);
  });
  it('refuses rather than dropping the choice when the job writer is not wired', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-pref-'));
    const preferences = new NotificationPreferences({ root, self: () => 'machine-a', peers: () => [], apply: vi.fn(), send: vi.fn() });
    cleanup.push(async () => { await preferences.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/notification-job-opt-in.test.ts' }); });
    await expect(preferences.setJob('a', true, 'dashboard-pin')).rejects.toThrow();
  });
});

describe('production wiring', () => {
  const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
  it('both boot paths resolve job identity through the scheduler mark, and the writer is wired', () => {
    const server = source('src/commands/server.ts');
    expect(server.match(/notificationJobSlug = id => id \? scheduledJobSlug\(state\.getSession\(id\)\) : undefined/g)).toHaveLength(2);
    expect(server).toContain('applyJob: (slug, enabled, topicId) =>');
  });
  it('the scheduler names the job on its report, failure and silence notices, not on its topic intro', () => {
    const scheduler = source('src/scheduler/JobScheduler.ts');
    expect(scheduler.match(/withNotificationEnvelope\(verifiedJobEnvelope\(job\.slug\)/g)).toHaveLength(4);
    expect(scheduler).toContain('withNotificationEnvelope(stampNotification(), async () => (this.telegram)!.sendToTopic(topic.topicId,');
  });
  it('the reply route still does not treat metadata.jobSlug as identity', () => {
    expect(source('src/server/routes.ts')).not.toMatch(/verifiedJobEnvelope/);
  });
  it('both last-hop readers restore the identity', () => {
    expect(source('src/server/notificationRoutes.ts')).toContain('runtime.service.restoreJobEnvelope(record, envelope)');
    expect(source('src/messaging/telegram-origin/TelegramOriginService.ts')).toContain('this.restoreJobEnvelope(operation.record, envelope)');
  });
});

describe('slug rule and creation advice', () => {
  it('accepts real slugs and refuses object-shape names', () => {
    for (const slug of ['instar2-checkin', 'a_b', 'A1']) expect(isNotificationJobSlug(slug)).toBe(true);
    for (const slug of ['__proto__', 'constructor', 'prototype', 'a.b', '', 'x'.repeat(101), 7]) expect(isNotificationJobSlug(slug)).toBe(false);
  });
  it('tells the agent the default, how to record a yes, and never to self-grant', () => {
    const advice = jobReportChoice('my-job', { enforcing: true, categoryPush: false });
    expect(advice).toMatchObject({ default: 'quiet', effective: 'quiet', route: 'POST /notifications/jobs/my-job/push' });
    expect(advice.agentAction).toMatch(/ask/i);
    expect(advice.agentAction).toMatch(/never/i);
    expect(advice.agentAction).toContain('/telegram/topics/');
  });
  it('states what will really happen when the job would not be quiet', () => {
    expect(jobReportChoice('j', { enforcing: true, categoryPush: true }).effective).toBe('pushed-by-category');
    const observing = jobReportChoice('j', { enforcing: false, categoryPush: false });
    expect(observing.effective).toBe('delivered-while-observing');
    expect(observing.agentAction).toContain('only observing');
  });
  it('trusts the scheduler mark, not a jobSlug alone', () => {
    expect(scheduledJobSlug({ jobSlug: 'a', triggeredBy: 'scheduler:cron' })).toBe('a');
    expect(scheduledJobSlug({ jobSlug: 'a' })).toBeUndefined();
    expect(scheduledJobSlug({ jobSlug: 'a', triggeredBy: 'api' })).toBeUndefined();
    expect(scheduledJobSlug({ triggeredBy: 'scheduler:cron' })).toBeUndefined();
    expect(scheduledJobSlug(undefined)).toBeUndefined();
  });
});
