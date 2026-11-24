import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildHealthBase, healthProjectProjection, formatUptime } from '../../src/server/healthBaseRead.js';
import { createBrowserStatusRead, type BrowserStatusReadDeps } from '../../src/server/browserStatusRead.js';
import { mountMobileHealthRoutes } from '../../src/server/mobileHealthRoutes.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
afterEach(() => vi.restoreAllMocks());
const raw = () => ({ uptimeMs: 1000, uptimeHuman: '1s', sessionExhausted: false, totalFailures: 0, degradations: 0,
 degradationSummary: () => [], llmReliability: null, claudeKeyDead: () => false, gateRouteVersion: 1, gateRouteMinimumVersion: 1 });
describe('shared health projection semantics', () => {
 it('retains health thresholds and unavailable telemetry without inventing success', () => {
  expect(buildHealthBase(raw()).base).toEqual({ status: 'ok', uptime: 1000, uptimeHuman: '1s', degradations: 0, gateRouteVersion: 1, gateRouteMinimumVersion: 1 });
  for (const extra of [{ sessionExhausted: true }, { totalFailures: 5 }, { degradations: 1 }, { llmReliability: { status: 'unavailable' } }, { claudeKeyDead: () => true }]) expect(buildHealthBase({ ...raw(), ...extra }).base.status).toBe('degraded');
  expect(buildHealthBase({ ...raw(), totalFailures: 4 }).base.status).toBe('ok');
  const key = vi.fn(() => true); buildHealthBase({ ...raw(), sessionExhausted: true, claudeKeyDead: key }); expect(key).not.toHaveBeenCalled();
 });
 it('keeps project privacy and exact existing uptime wording', () => {
  expect(healthProjectProjection(false, 'private name')).toEqual({});
  expect(healthProjectProjection(true, 'synthetic')).toEqual({ project: 'synthetic' });
  expect([1000, 61000, 3661000, 90000000].map(formatUptime)).toEqual(['1s', '1m 1s', '1h 1m', '1d 1h']);
 });
});
function browserDeps(): BrowserStatusReadDeps { return { browserOn: () => true, bearerOk: req => req.get('Authorization') === 'Bearer synthetic', machineId: () => 'seed-machine', nickname: () => null, projectName: () => 'seed-project', approvalPath: () => null, approveEnabled: () => false, ownerPhoneCanApprove: () => false, telegramConfigured: () => false, holdsLease: () => false, keyState: () => ({ state: 'not-found' }), now: () => 123 }; }
function browserApp(deps: BrowserStatusReadDeps) { const app = express(); app.get('/status', createBrowserStatusRead(deps)); return app; }
describe('shared production browser status read', () => {
 it('preserves full successful output while unavailable owner/send capabilities stay false', async () => {
  const response = await request(browserApp(browserDeps())).get('/status').set('Authorization', 'Bearer synthetic').expect(200);
  expect(response.body).toMatchObject({ enabled: true, machineId: 'seed-machine', nickname: 'seed-project', approvalChat: null, serverTime: 123, approvalPath: null, approveEnabled: false, ownerPhoneApproves: false, telegramSend: false });
  expect(Object.keys(response.body.limits).sort()).toEqual(['chunkBytes', 'maxFileBytes', 'maxFiles', 'maxMessageBytes']);
 });
 it('preserves off-before-auth, unauthorized, malformed-key and actual key-state branches', async () => {
  await request(browserApp({ ...browserDeps(), browserOn: () => false })).get('/status').expect(503, { error: 'browser-devices-off', detail: 'Conversations in the dashboard are switched off on this agent.' });
  await request(browserApp(browserDeps())).get('/status').expect(403, { error: 'bearer-required' });
  await request(browserApp(browserDeps())).get('/status?keyHash=bad').set('Authorization', 'Bearer synthetic').expect(400, { error: 'bad-key-hash' });
  const keyState = vi.fn(() => ({ state: 'not-found' }));
  const response = await request(browserApp({ ...browserDeps(), keyState })).get(`/status?keyHash=${'A'.repeat(64)}`).set('Authorization', 'Bearer synthetic').expect(200);
  expect(keyState).toHaveBeenCalledWith('a'.repeat(64)); expect(response.body.key).toEqual({ state: 'not-found' });
 });
});
it('retains actual default production degradation reporting when no fixture override is supplied', async () => {
 const report = vi.fn(); vi.spyOn(DegradationReporter, 'getInstance').mockReturnValue({ report } as never);
 const app = express(), router = express.Router();
 mountMobileHealthRoutes(router, { bearerOk: () => true, readHealth: async () => { throw new Error('provider failed'); }, recentEvents: () => [], current: () => ({}) });
 app.use(router);
 await request(app).get('/mobile/health-issues').expect(500);
 expect(report).toHaveBeenCalledWith(expect.objectContaining({ feature: 'MobileHealthIssues.read', reason: 'GET /mobile/health-issues: provider failed', fallback: 'The phone and console say they could not read the agent’s health' }));
});
