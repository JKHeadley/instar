import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SessionPoolPromotionActivation } from '../../src/core/sessionPoolPromotionActivation.js';
import type { SessionPoolRolloutDriver } from '../../src/core/SessionPoolRolloutDriver.js';

async function serve(activation: SessionPoolPromotionActivation | null) {
  const app = express();
  app.use(express.json());
  app.use(createRoutes({
    config: { authToken: 'test', stateDir: '/tmp', port: 0 },
    stateDir: '/tmp',
    sessionPoolPromotionActivation: activation,
  } as never));
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = app.listen(0, () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((done) => server.close(() => done())),
    }));
  });
}

describe('POST /session-pool/promote', () => {
  it('dark → 503', async () => {
    const server = await serve(null);
    const response = await fetch(`${server.url}/session-pool/promote`, { method: 'POST' });
    await server.close();
    expect(response.status).toBe(503);
  });

  it('live → 200 and returns the one-step driver result', async () => {
    const driver = {
      tick: () => ({
        ran: true,
        reconciledTo: 'shadow',
        advancedTo: 'live-transfer',
        advanceSkippedReason: null,
      }),
    } as unknown as SessionPoolRolloutDriver;
    const activation = new SessionPoolPromotionActivation(
      { model: 'operator', ceiling: 'live-transfer', tickMs: 60_000 },
      driver,
    );
    const server = await serve(activation);
    const response = await fetch(`${server.url}/session-pool/promote`, { method: 'POST' });
    const body = await response.json() as Record<string, any>;
    await server.close();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      model: 'operator',
      ceiling: 'live-transfer',
      result: { advancedTo: 'live-transfer' },
    });
  });
});
