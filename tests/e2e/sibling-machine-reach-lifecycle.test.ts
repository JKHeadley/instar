// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" test for sibling-machine-reach
 * (docs/specs/sibling-machine-reach.md §6, CMT-2073).
 *
 * Boots the REAL AgentServer (the production createRoutes wiring) with a live stub
 * PEER machine, then proves through HTTP only:
 *  1. the holdings cache is armed at boot and the peer shows UNKNOWN (never-read),
 *     not absent;
 *  2. a nudged send on the outbound path kicks a targeted refresh, after which the
 *     pool view reports the peer as read;
 *  3. the next nudged send carries the route hint naming the peer machine.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type express from 'express';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import { installDecisionQualityRecorder } from '../../src/core/DecisionQualityRecorderImpl.js';

const AUTH = 'test-e2e-sibling-reach';
const MINI = 'm-mini';
const SELF = 'm-studio';
const FOUR = ['gearfinity@example.com', 'justin@example.com', 'appyhapi@example.com', 'dawn@example.com'];
const ASK_1120 =
  'Four accounts are missing on the Studio after the rebuild. To fix it: open the dashboard, enter your PIN, then sign in gearfinity, justin, appyhapi and dawn on the Studio (Accounts → Set up → follow the browser prompts).';

describe('sibling-machine-reach E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let server: AgentServer;
  let app: express.Express;
  let peer: http.Server;
  let peerUrl: string;
  const peerHits: string[] = [];

  beforeAll(async () => {
    installDecisionQualityRecorder({ isRecordingLive: () => true } as never);
    peer = http.createServer((req, res) => {
      peerHits.push(req.url ?? '');
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${AUTH}`) { res.statusCode = 401; res.end('{}'); return; }
      if (req.url === '/subscription-pool') {
        res.end(JSON.stringify({ enabled: true, machineId: MINI, accounts: FOUR.map((e, i) => ({ id: `a${i}`, email: e, provider: 'anthropic', status: 'active', loginCheck: 'ok' })) }));
      } else if (req.url === '/playwright-profiles?view=accounts') {
        res.end(JSON.stringify({ machineId: MINI, view: 'accounts', profiles: [{ id: 'p', accounts: FOUR.map((e) => ({ service: 'google', identity: e, owner: 'operator', lastAsserted: true, lastVerifiedAt: new Date().toISOString() })) }] }));
      } else { res.statusCode = 404; res.end('{}'); }
    });
    await new Promise<void>((r) => peer.listen(0, '127.0.0.1', () => r()));
    peerUrl = `http://127.0.0.1:${(peer.address() as import('node:net').AddressInfo).port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-reach-e2e-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    const config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      // Ships dev-gated: live on a development agent, dark on the fleet.
      developmentAgent: true,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, clearInjectionTracker: () => {}, on: () => {} } as any,
      state: new StateManager(stateDir),
      telegram: { sendToTopic: async () => ({ ok: true }) } as any,
      meshSelfId: SELF,
      resolvePeerUrls: () => [{ machineId: MINI, url: peerUrl, kind: 'lan' as never }],
      listPoolMachines: () => [{ machineId: SELF }, { machineId: MINI, nickname: 'Mac Mini' }],
      // The judge: a per-machine B21 that cites the first sibling profile when one is listed.
      messagingToneGate: new MessagingToneGate({
        evaluate: async (p: string) => JSON.stringify(p.includes('[S1]')
          ? { pass: false, rule: 'B21_USER_TASK_SUBSTITUTION', issue: 'a per-machine procedure', suggestion: 'use the other machine', siblingProfileRef: 'S1' }
          : { pass: false, rule: 'B21_USER_TASK_SUBSTITUTION', issue: 'a procedure', suggestion: 'do it yourself' }),
      } as never),
    } as any);
    await server.start();
    app = server.getApp();
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
    await new Promise<void>((r) => peer.close(() => r()));
    installDecisionQualityRecorder(null);
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/sibling-machine-reach-lifecycle.test.ts' });
  });

  const poolView = async () => (await request(app).get('/subscription-pool?scope=pool').set('Authorization', `Bearer ${AUTH}`)).body as {
    siblingReach?: { armed: boolean; machines: Array<{ machineId: string; poolAgeMinutes: number | null }>; unknown: Array<{ machineId: string; reason: string }> };
  };
  const send = () => request(app).post('/telegram/reply/146512').set('Authorization', `Bearer ${AUTH}`).send({ text: ASK_1120 });

  it('is armed at boot and shows the peer as UNKNOWN (never read), not absent', async () => {
    const v = await poolView();
    expect(v.siblingReach?.armed).toBe(true);
    expect(v.siblingReach?.unknown.find((u) => u.machineId === MINI)?.reason).toBe('never-read');
  });

  it('a nudged send kicks a targeted refresh; the peer is then read; the next nudge names it', async () => {
    const first = await send();
    expect(first.status).toBe(422);
    expect(first.body.otherMachine).toBeUndefined();
    let v = await poolView();
    for (let i = 0; i < 50 && !v.siblingReach?.machines.some((m) => m.machineId === MINI); i++) {
      await new Promise((r) => setTimeout(r, 100));
      v = await poolView();
    }
    expect(v.siblingReach?.machines.find((m) => m.machineId === MINI)?.poolAgeMinutes).toBe(0);
    expect(peerHits).toContain('/playwright-profiles?view=accounts');

    const second = await send();
    expect(second.status).toBe(422);
    expect(second.body.otherMachine).toMatchObject({ machineId: MINI, machine: 'Mac Mini', address: peerUrl });
    expect(String(second.body.suggestion)).toContain('Mac Mini');
    for (const e of FOUR) expect(JSON.stringify(second.body)).not.toContain(e);
  });
});
