import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { writeFile } from 'node:fs/promises';
import { mountTelegramOriginRoutes } from '../../src/server/telegramOriginRoutes.js';
import { detectorFixture, detectorWorkers } from '../helpers/originDetectorBoot.js';
let workers: Awaited<ReturnType<typeof detectorWorkers>>;
beforeAll(async () => { workers = await detectorWorkers(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('serves real fresh detector health through the operator HTTP boundary without leaking config or creating origin rows', async () => {
  const fixture = await detectorFixture(workers); cleanup.push(fixture.cleanup);
  const boot = await fixture.boot(); cleanup.push(boot.close);
  const originsBefore = (await boot.runtime.store.listOrigins()).records;
  const app = express(); app.use(express.json());
  mountTelegramOriginRoutes(app, { runtime: () => boot.runtime, verifyOperator: proof => proof === 'operator-proof' });
  expect((await request(app).get('/telegram/origins/status')).status).toBe(403);
  const get = () => request(app).get('/telegram/origins/status').set('X-Instar-Operator-Session', 'operator-proof');
  await vi.waitFor(async () => expect((await get()).body.detectorHealth).toMatchObject({
    sources: { config: { state: 'healthy' }, noticePolicy: { state: 'healthy' } },
    canaries: { ownedContracts: { state: 'pass' } },
  }), { timeout: 8000 });
  const response = await get(); expect(response.status).toBe(200);
  expect(response.body.detectorHealth.canaries.nativeModels).toMatchObject({ state: 'unavailable', providerExecutionVerified: false });
  expect(JSON.stringify(response.body.detectorHealth)).not.toMatch(/detector-fixture|\/tmp\//);
  const observedAt = response.body.detectorHealth.canaries.ownedContracts.finishedAt;
  expect((await get()).body.detectorHealth.canaries.ownedContracts.finishedAt).toBe(observedAt);
  await writeFile(fixture.configPath, '{malformed');
  // Invalidation is automatic: allow the actual five-second refresh and its
  // bounded two-second source read, without manually invoking either reader.
  await vi.waitFor(async () => expect((await get()).body.detectorHealth.sources.config.state).toBe('unavailable'), { timeout: 8000 });
  expect((await boot.runtime.store.listOrigins()).records).toEqual(originsBefore);
});
