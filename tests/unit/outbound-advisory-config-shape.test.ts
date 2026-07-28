// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Unit (Tier 1) — outbound-advisory off-switch config-shape fix.
 *
 * THE BUG (same class as PR #1379): the preflight route read the off-switch at
 * `messaging.outboundAdvisory.enabled`. On a real install `messaging` is a JSON ARRAY
 * of adapter configs, so that dot-path resolves undefined → the `true` default → the
 * DOCUMENTED off-switch (`enabled: false`) had NO effect; an operator could not
 * disable the advisory. This is the un-DISABLABLE sub-class (default-ON). The fix reads
 * the reachable TOP-LEVEL `outboundAdvisory.enabled` (legacy nested key honored as a
 * fallback). Uses a REAL LiveConfig reading a REAL array-shaped config file — the flat
 * dot-path mock in outbound-advisory-routes.test.ts cannot reproduce the array shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';

let tmpDir: string;
function writeConfig(over: Record<string, unknown>) {
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ port: 0, ...over }));
}
function makeApp(): express.Express {
  const liveConfig = new LiveConfig(tmpDir);
  const ctx = {
    config: { projectName: 't', projectDir: tmpDir, stateDir: tmpDir, port: 0 } as any,
    liveConfig,
    sessionManager: { listRunningSessions: () => [], clearInjectionTracker: () => {} } as any,
    state: { listSessions: () => [] } as any,
    telegram: null, scheduler: null, relationships: null, feedback: null, commitmentTracker: null,
    startTime: new Date(),
  } as any as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

const ARRAY_MESSAGING = [
  { type: 'telegram', enabled: true, config: { botToken: 'x' } },
  { type: 'slack', enabled: true, config: { botToken: 'y', appToken: 'z' } },
];

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-shape-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('outbound-advisory off-switch on real (array-shaped) messaging', () => {
  it('array messaging + TOP-LEVEL outboundAdvisory.enabled:false → the advisory IS disablable', async () => {
    writeConfig({ messaging: ARRAY_MESSAGING, outboundAdvisory: { enabled: false } });
    const res = await request(makeApp()).post('/messaging/preflight').send({ text: 'hello', messageKind: 'reply' });
    expect(res.status).toBe(200);
    // Before the fix this returned enabled (the off-switch was unreachable). Now the
    // top-level off-switch works: the route reports disabled and proceeds to send.
    expect(res.body).toMatchObject({ disabled: true });
  });

  it('array messaging + NO outboundAdvisory config → enabled by default (not disabled)', async () => {
    writeConfig({ messaging: ARRAY_MESSAGING });
    const res = await request(makeApp()).post('/messaging/preflight').send({ text: 'hello', messageKind: 'reply' });
    expect(res.status).toBe(200);
    expect(res.body.disabled).not.toBe(true);
  });

  it('BACK-COMPAT: legacy object-shaped messaging.outboundAdvisory.enabled:false still disables', async () => {
    writeConfig({ messaging: { outboundAdvisory: { enabled: false } } });
    const res = await request(makeApp()).post('/messaging/preflight').send({ text: 'hello', messageKind: 'reply' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ disabled: true });
  });
});
