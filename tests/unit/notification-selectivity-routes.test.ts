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
  const send = vi.fn().mockResolvedValue(false);
  gate.preferences = new NotificationPreferences({ root, self: () => 'machine-a', peers: () => ['machine-b'], apply, send });
  const app = express(); app.use(express.json()); const router = express.Router();
  mountNotificationRoutes(router, { config: { stateDir: root }, telegram: { selectivity: gate, sendToTopic },
    liveConfig: { set: (key: string, value: unknown) => values.set(key, value), get: (key: string, fallback: unknown) => values.get(key) ?? fallback },
    verifyDashboardOperatorSession: (proof: string | undefined) => proof === 'pin-proof',
  } as unknown as RouteContext, () => false);
  app.use(router);
  cleanup.push(async () => { await gate.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/notification-selectivity-routes.test.ts' }); });
  return { app, gate, values, sendToTopic, root, apply, send };
}
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
