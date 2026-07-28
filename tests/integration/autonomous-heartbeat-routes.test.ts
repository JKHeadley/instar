/**
 * Integration — GET /autonomous-heartbeat (autonomous-progress-heartbeat spec
 * §Status route + §Testing "Integration").
 *
 * Mounts the REAL router and exercises the HTTP surface:
 *  - 200 with the real status fields when the component is wired (the global
 *    __instarAutonomousHeartbeat ref — the same wiring pattern PromiseBeacon
 *    uses, since the heartbeat is constructed in the server.ts boot path).
 *  - 503 when dark (no component wired — the fleet default).
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import {
  AutonomousProgressHeartbeat,
  type AutonomousHeartbeatDeps,
} from '../../src/monitoring/AutonomousProgressHeartbeat.js';
import { ProxyCoordinator } from '../../src/monitoring/ProxyCoordinator.js';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  const ctx: any = { config: { authToken: 'test', stateDir: '/tmp', port: 0 }, stateDir: '/tmp' };
  app.use(createRoutes(ctx));
  return app;
}

function makeHeartbeat(): AutonomousProgressHeartbeat {
  const deps: AutonomousHeartbeatDeps = {
    listActiveAutonomousRuns: () => [],
    getRunMarkers: () => null,
    isSessionAlive: () => false,
    getTopicHistory: () => [],
    getSharedLastOutputAt: () => null,
    getFocusForTopic: () => null,
    proxyCoordinator: new ProxyCoordinator(),
    sendMessage: async () => {},
  };
  return new AutonomousProgressHeartbeat(deps, { enabled: true, dryRun: true });
}

const GLOBAL_KEY = '__instarAutonomousHeartbeat';

describe('GET /autonomous-heartbeat', () => {
  let server: Server | undefined;
  afterEach(async () => {
    delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
    if (server) await server.close();
    server = undefined;
  });

  it('returns 200 with the real status fields when the component is wired (alive, not 503)', async () => {
    const hb = makeHeartbeat();
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = hb;
    server = await listen(buildApp());
    const resp = await fetch(`${server.url}/autonomous-heartbeat`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty('enabled', true);
    expect(body).toHaveProperty('dryRun', true);
    expect(body).toHaveProperty('silenceThresholdMinutes', 25);
    expect(body).toHaveProperty('lastTickAt');
    expect(body).toHaveProperty('topicsConsidered');
    expect(Array.isArray(body.lastEmits)).toBe(true);
  });

  it('returns 503 when dark (no component wired — the fleet default)', async () => {
    delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
    server = await listen(buildApp());
    const resp = await fetch(`${server.url}/autonomous-heartbeat`);
    expect(resp.status).toBe(503);
  });
});
