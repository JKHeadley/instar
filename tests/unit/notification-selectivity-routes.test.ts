import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotificationSelectivityGate } from '../../src/messaging/NotificationSelectivityGate.js';
import { NotificationPreferences } from '../../src/messaging/NotificationPreferences.js';
import { mountNotificationRoutes } from '../../src/server/notificationRoutes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-route-'));
  const values = new Map<string, unknown>();
  const gate = new NotificationSelectivityGate(root, 'machine-a', () => ({ enabled: true, dryRun: false }));
  const sendToTopic = vi.fn().mockResolvedValue({ messageId: 7 });
  const apply = vi.fn((category, enabled) => values.set(`notifications.selectivity.push.categories.${category}`, enabled));
  const applyJob = vi.fn((slug, enabled) => values.set(`notifications.selectivity.push.jobs.${slug}`, enabled));
  const scheduler = { getJobs: vi.fn(() => [{ slug: 'instar2-checkin', name: '2.0 check-in', enabled: true }]), refreshJobs: vi.fn() };
  const send = vi.fn().mockResolvedValue(false);
  gate.preferences = new NotificationPreferences({ root, self: () => 'machine-a', peers: () => ['machine-b'], apply, applyJob, send });
  const app = express(); app.use(express.json()); const router = express.Router();
  const peers: Array<{ machineId: string; url: string; kind: string }> = [];
  mountNotificationRoutes(router, { config: { stateDir: root, multiMachine: { peerUrlAllowlist: ['http://127.0.0.1:9'] } }, telegram: { selectivity: gate, sendToTopic }, scheduler, resolvePeerUrls: () => peers,
    liveConfig: { get: (key: string, fallback: unknown) => values.get(key) ?? fallback },
    verifyDashboardOperatorSession: (proof: string | undefined) => proof === 'pin-proof',
  } as unknown as RouteContext, () => false);
  app.use(router);
  cleanup.push(async () => { await gate.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/notification-selectivity-routes.test.ts' }); });
  return { app, gate, values, sendToTopic, root, apply, applyJob, scheduler, send, peers };
}
describe('per-job push route', () => {
  const route = '/notifications/jobs/instar2-checkin/push';
  it('refuses without confirmation and writes nothing', async () => {
    const { app, applyJob } = setup();
    expect((await request(app).post(route).send({ enabled: true })).status).toBe(400);
    expect((await request(app).post(route).send({ enabled: true, confirmedBy: 'dashboard-pin' })).status).toBe(400);
    expect((await request(app).post(route).send({ enabled: true, confirmedBy: 'operator-conversational-confirm', topicId: 42, confirmingMessageId: 'made-up' })).status).toBe(400);
    expect(applyJob).not.toHaveBeenCalled();
  });
  it('a non-operator message is no confirmation', async () => {
    const { app, gate, applyJob } = setup(); gate.observeInbound(42, 'm1', false);
    expect((await request(app).post(route).send({ enabled: true, confirmedBy: 'operator-conversational-confirm', topicId: 42, confirmingMessageId: 'm1' })).status).toBe(400);
    expect(applyJob).not.toHaveBeenCalled();
  });
  it('accepts a PIN, and keeps the report on the hub since no topic was chosen', async () => {
    const { app, applyJob, values } = setup();
    const result = await request(app).post(route).set('X-Instar-Operator-Session', 'pin-proof').send({ enabled: true, confirmedBy: 'dashboard-pin', topicId: 42 });
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ ok: true, slug: 'instar2-checkin', enabled: true, topicId: null });
    expect(applyJob).toHaveBeenCalledWith('instar2-checkin', true, undefined);
    expect(values.get('notifications.selectivity.push.jobs.instar2-checkin')).toBe(true);
  });
  it('accepts a recent operator message, binds that topic and confirms in chat', async () => {
    const { app, gate, applyJob, sendToTopic } = setup(); gate.observeInbound(102965, 'm9', true);
    const result = await request(app).post(route).send({ enabled: true, confirmedBy: 'operator-conversational-confirm', topicId: 102965, confirmingMessageId: 'm9' });
    expect(result.status).toBe(200); expect(result.body.topicId).toBe(102965);
    expect(applyJob).toHaveBeenCalledWith('instar2-checkin', true, 102965);
    expect(sendToTopic.mock.calls[0][1]).toContain('2.0 check-in');
  });
  it('refuses an unknown or malformed slug, but only after confirmation', async () => {
    const { app, applyJob, scheduler } = setup(); const proof = { enabled: true, confirmedBy: 'dashboard-pin' };
    expect((await request(app).post('/notifications/jobs/no-such-job/push').send(proof)).status).toBe(400);
    expect((await request(app).post('/notifications/jobs/no-such-job/push').set('X-Instar-Operator-Session', 'pin-proof').send(proof)).status).toBe(404);
    expect((await request(app).post('/notifications/jobs/__proto__/push').set('X-Instar-Operator-Session', 'pin-proof').send(proof)).status).toBe(400);
    expect(scheduler.refreshJobs).toHaveBeenCalled();
    expect(applyJob).not.toHaveBeenCalled();
  });
  it('finds a job written seconds ago', async () => {
    const { app, scheduler } = setup();
    scheduler.refreshJobs.mockImplementation(() => { scheduler.getJobs.mockReturnValue([{ slug: 'fresh', name: 'Fresh', enabled: true }]); });
    expect((await request(app).post('/notifications/jobs/fresh/push').set('X-Instar-Operator-Session', 'pin-proof').send({ enabled: true, confirmedBy: 'dashboard-pin' })).status).toBe(200);
  });
  it('a job file that cannot be parsed answers 503 for a yes and does not block a no', async () => {
    const { app, scheduler, applyJob } = setup();
    scheduler.refreshJobs.mockImplementation(() => { throw new Error('Failed to parse jobs file'); });
    expect((await request(app).post(route).set('X-Instar-Operator-Session', 'pin-proof').send({ enabled: true, confirmedBy: 'dashboard-pin' })).status).toBe(503);
    expect((await request(app).post(route).set('X-Instar-Operator-Session', 'pin-proof').send({ enabled: false, confirmedBy: 'dashboard-pin' })).status).toBe(200);
    expect(applyJob).toHaveBeenCalledTimes(1);
  });
  it('accepts a job another machine runs, and is honest when a machine is dark', async () => {
    const { app, peers } = setup();
    peers.push({ machineId: 'machine-b', url: 'http://127.0.0.1:9', kind: 'lan' });
    const proof = { enabled: true, confirmedBy: 'dashboard-pin' };
    const network = vi.fn(async () => new Response(JSON.stringify({ jobs: [{ slug: 'on-b', name: 'On B', enabled: true }] })));
    vi.stubGlobal('fetch', network);
    try {
      expect((await request(app).post('/notifications/jobs/on-b/push').set('X-Instar-Operator-Session', 'pin-proof').send(proof)).status).toBe(200);
      expect((await request(app).post('/notifications/jobs/nowhere/push').set('X-Instar-Operator-Session', 'pin-proof').send(proof)).status).toBe(404);
      const pool = (await request(app).get('/notifications/selectivity?scope=pool')).body;
      expect(pool.jobs.map((job: { slug: string }) => job.slug).sort()).toEqual(['instar2-checkin', 'on-b']);
      network.mockRejectedValue(new Error('dark'));
      expect((await request(app).post('/notifications/jobs/nowhere/push').set('X-Instar-Operator-Session', 'pin-proof').send(proof)).status).toBe(503);
      expect((await request(app).get('/notifications/selectivity?scope=pool')).body.jobsUnavailable).toEqual(['machine-b']);
    } finally { vi.unstubAllGlobals(); }
  });
  it('turning a job off never needs the job to exist', async () => {
    const { app, applyJob } = setup();
    expect((await request(app).post('/notifications/jobs/deleted-job/push').set('X-Instar-Operator-Session', 'pin-proof').send({ enabled: false, confirmedBy: 'dashboard-pin' })).status).toBe(200);
    expect(applyJob).toHaveBeenCalledWith('deleted-job', false, undefined);
  });
  it('says the opt-in changes nothing yet while the gate is only observing', async () => {
    const { app, gate } = setup();
    (gate as unknown as { config: () => object }).config = () => ({ enabled: true, dryRun: true });
    const body = (await request(app).post(route).set('X-Instar-Operator-Session', 'pin-proof').send({ enabled: true, confirmedBy: 'dashboard-pin' })).body;
    expect(body).toMatchObject({ enforcing: false }); expect(body.message).toContain('only observing');
    expect(body.message).not.toContain('Attention topic');
  });
  it('shows per-job state, separating never-asked from an explicit no', async () => {
    const { gate, app } = setup();
    (gate as unknown as { config: () => object }).config = () => ({ enabled: true, dryRun: false, push: { jobs: { 'instar2-checkin': false } } });
    const body = (await request(app).get('/notifications/selectivity')).body;
    expect(body.jobs).toEqual([{ slug: 'instar2-checkin', name: '2.0 check-in', enabled: true, push: false, decided: true }]);
    expect(body.jobsScope).toBe('this-machine');
    (gate as unknown as { config: () => object }).config = () => ({ enabled: true, dryRun: false });
    expect((await request(app).get('/notifications/selectivity')).body.jobs[0]).toMatchObject({ push: false, decided: false });
  });
});
describe('notification surfaces and confirmation authority', () => {
  it('serves and acknowledges durable quiet notices', async () => {
    const { app, gate } = setup(); const row = await gate.route(42, '<script>quoted data</script>');
    const feed = await request(app).get('/notifications/quiet?unread=true');
    expect(feed.status).toBe(200); expect(feed.body.items[0].text).toBe('<script>quoted data</script>');
    expect((await request(app).patch('/notifications/quiet/' + row.receipt!.quietId).send({})).status).toBe(200);
    expect((await request(app).get('/notifications/quiet?unread=true')).body.items).toHaveLength(0);
  });
  it('does not accept a claimed dashboard confirmation without PIN proof', async () => {
    const { app, apply } = setup();
    expect((await request(app).post('/notifications/categories/job-status/push').send({ enabled: true, confirmedBy: 'dashboard-pin' })).status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });
  it('accepts a PIN-confirmed registered category and durably retains dark-peer delivery', async () => {
    const { app, gate, values, root } = setup();
    const result = await request(app).post('/notifications/categories/job-status/push').set('X-Instar-Operator-Session', 'pin-proof').send({ enabled: true, confirmedBy: 'dashboard-pin' });
    expect(result.status).toBe(200); expect(values.get('notifications.selectivity.push.categories.job-status')).toBe(true);
    await gate.preferences!.close();
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state', 'notification-preferences.json'), 'utf8'));
    expect(state.pending[0]).toMatchObject({ peer: 'machine-b', intent: { category: 'job-status', enabled: true } });
  });
  it('refuses unknown categories even with a valid PIN', async () => {
    const { app } = setup();
    expect((await request(app).post('/notifications/categories/new-privileged-class/push').set('X-Instar-Operator-Session', 'pin-proof').send({ enabled: true, confirmedBy: 'dashboard-pin' })).status).toBe(400);
  });
  it('requires the operator-bound inbound and emits its own conversational confirmation', async () => {
    const { app, gate, sendToTopic } = setup();
    gate.observeInbound(42, 7, false);
    const body = { enabled: true, confirmedBy: 'operator-conversational-confirm', topicId: 42, confirmingMessageId: '7' };
    expect((await request(app).post('/notifications/categories/job-status/push').send(body)).status).toBe(400);
    gate.observeInbound(42, 7, true);
    expect((await request(app).post('/notifications/categories/job-status/push').send(body)).status).toBe(200);
    expect(sendToTopic).toHaveBeenCalledWith(42, expect.stringContaining('will now be pushed'), expect.anything());
  });
  it('does not accept a plain Bearer caller on the lifeline classifier', async () => {
    const { app } = setup();
    expect((await request(app).post('/notifications/internal/classify').send({ operationId: 'made-up', origin: 'verified-reply' })).status).toBe(403);
  });
  it('rejects preference replication attributed to another machine', async () => {
    const { gate, apply } = setup();
    expect(await gate.preferences!.receive({ category: 'job-status', enabled: true, issuer: 'machine-b',
      version: new Date().toISOString() + ':machine-b', confirmedBy: 'dashboard-pin', confirmedAt: new Date().toISOString() }, 'machine-c')).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('preference version order', () => {
  it('applies successive toggles during the same millisecond', async () => {
    const { gate, values } = setup();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
    try {
      const first = await gate.preferences!.set('job-status', true, 'dashboard-pin');
      const second = await gate.preferences!.set('job-status', false, 'dashboard-pin');
      expect(second.version > first.version).toBe(true);
      expect(values.get('notifications.selectivity.push.categories.job-status')).toBe(false);
    } finally { clock.mockRestore(); }
  });
  it('lets a slower-clock machine disable push after a future peer update', async () => {
    const { gate, values } = setup();
    const future = `${new Date(Date.now() + 86400000).toISOString()}:0000000000:machine-b`;
    expect(await gate.preferences!.receive({ category: 'job-status', enabled: true, issuer: 'machine-b', version: future,
      confirmedBy: 'dashboard-pin', confirmedAt: new Date().toISOString() }, 'machine-b')).toBe(true);
    const local = await gate.preferences!.set('job-status', false, 'dashboard-pin');
    expect(local.version > future).toBe(true);
    expect(values.get('notifications.selectivity.push.categories.job-status')).toBe(false);
  });
});


describe('preference retry convergence', () => {
  it('does not rearm exhausted delivery on every successful presence poll', async () => {
    const { gate, root, send } = setup();
    await gate.preferences!.set('job-status', true, 'dashboard-pin');
    const clock = vi.spyOn(Date, 'now'); let now = Date.now();
    try {
      for (let i = 0; i < 8; i++) { now += 86400000; clock.mockReturnValue(now); await gate.preferences!.drain(); }
      expect(send).toHaveBeenCalledTimes(8);
      for (let i = 0; i < 10; i++) { gate.preferences!.peerReturned('machine-b'); await gate.preferences!.close(); }
      expect(send).toHaveBeenCalledTimes(8);
      gate.preferences!.peerUnavailable('machine-b'); await gate.preferences!.close();
      expect(JSON.parse(fs.readFileSync(path.join(root, 'state', 'notification-preferences.json'), 'utf8')).offlinePeers).toContain('machine-b');
      gate.preferences!.peerReturned('machine-b'); await gate.preferences!.close(); await gate.preferences!.drain();
      expect(send).toHaveBeenCalledTimes(9);
    } finally { clock.mockRestore(); }
  });
});


describe('bounded preference queue fairness', () => {
  it('does not let sixteen exhausted intents starve a newer eligible category', async () => {
    const { root } = setup(); const send = vi.fn().mockResolvedValue(false);
    const prefs = new NotificationPreferences({ root: path.join(root, 'fairness'), self: () => 'self', peers: () => Array.from({ length: 16 }, (_, i) => `peer-${i}`), apply: () => {}, send });
    const clock = vi.spyOn(Date, 'now'); let now = Date.now();
    try {
      await prefs.set('job-status', true, 'dashboard-pin');
      for (let i = 0; i < 8; i++) { now += 86400000; clock.mockReturnValue(now); await prefs.drain(); }
      expect(send).toHaveBeenCalledTimes(128);
      await prefs.set('spend-alert', true, 'dashboard-pin'); send.mockResolvedValue(true);
      await prefs.drain(); expect(send).toHaveBeenCalledTimes(144);
      expect(prefs.status().pending).toBe(16);
    } finally { clock.mockRestore(); await prefs.close(); }
  });
});


describe('fixed conversation floors are not preference switches', () => {
  it('refuses a floor preference even with valid operator confirmation', async () => {
    const { app, apply } = setup();
    const response = await request(app).post('/notifications/categories/command-response/push').set('X-Instar-Operator-Session', 'pin-proof').send({ enabled: false, confirmedBy: 'dashboard-pin' });
    expect(response.status).toBe(400); expect(apply).not.toHaveBeenCalled();
  });
});
