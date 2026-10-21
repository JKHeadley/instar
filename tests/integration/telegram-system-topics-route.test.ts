/**
 * Tier 2 — GET /telegram/system-topics through the real HTTP pipeline, and a
 * standby converging onto it. The holder serves its record; a read-only
 * standby adopts it via adoptHolderSystemTopics over real HTTP, instead of
 * minting its own Updates / Attention / Agent Health topics.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager, SYSTEM_TOPIC_STATE_KEYS } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { adoptHolderSystemTopics } from '../../src/messaging/SystemTopicAdoption.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'system-topics-test';
let tmp = '';
let server: AgentServer;
let holderState: StateManager;
let baseUrl = '';

describe('GET /telegram/system-topics', () => {
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'system-topics-'));
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    holderState = new StateManager(stateDir);
    holderState.set(SYSTEM_TOPIC_STATE_KEYS.updates, 48153);
    holderState.set(SYSTEM_TOPIC_STATE_KEYS.attention, 48154);
    holderState.set(SYSTEM_TOPIC_STATE_KEYS.agentHealth, 48183);
    const config = { projectName: 'st', projectDir: tmp, stateDir, port: 0, authToken: AUTH, requestTimeoutMs: 10000, version: '0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, monitoring: {} } as unknown as InstarConfig;
    server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as never, state: holderState });
    await server.start();
    const addr = (server as unknown as { server?: { address(): AddressInfo } }).server?.address();
    baseUrl = addr ? `http://127.0.0.1:${addr.port}` : '';
  });
  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'system-topics-test' });
  });

  it('is authenticated and returns the holder\'s record', async () => {
    const app = server.getApp();
    expect((await request(app).get('/telegram/system-topics')).status).toBe(401);
    const r = await request(app).get('/telegram/system-topics').set({ Authorization: `Bearer ${AUTH}` });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ topics: { updates: 48153, attention: 48154, agentHealth: 48183 }, holdsLease: true });
  });

  it('a read-only standby adopts the holder\'s ids over HTTP and keeps its other state read-only', async () => {
    const standbyDir = path.join(tmp, 'standby', '.instar');
    fs.mkdirSync(standbyDir, { recursive: true });
    const standby = new StateManager(standbyDir);
    standby.setReadOnly(true);
    const app = server.getApp();
    const out = await adoptHolderSystemTopics({
      holdsLease: () => !standby.readOnly,
      leaseHolder: () => 'holder',
      selfMachineId: 'standby',
      fetchHolder: async () => {
        if (baseUrl) {
          const res = await fetch(`${baseUrl}/telegram/system-topics`, { headers: { Authorization: `Bearer ${AUTH}` } });
          return res.json();
        }
        return (await request(app).get('/telegram/system-topics').set({ Authorization: `Bearer ${AUTH}` })).body;
      },
      get: k => standby.get(k),
      adopt: (k, v) => standby.adoptSystemTopicId(k, v),
    });
    expect(out).toEqual({ outcome: 'adopted', adopted: ['updates', 'attention', 'agentHealth'] });
    expect(standby.get(SYSTEM_TOPIC_STATE_KEYS.updates)).toBe(48153);
    expect(standby.get(SYSTEM_TOPIC_STATE_KEYS.agentHealth)).toBe(48183);
    expect(() => standby.set('some-other-key', 1)).toThrow(/read-only/);
  });
});
