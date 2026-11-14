/**
 * E2E "feature is alive" — GET /preferences on the production AgentServer boot path:
 * 200 with the dated list when correction learning is on (and the entry a real
 * PreferencesManager wrote), 503 on the same path when it is off.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH_TOKEN = 'test-prefs-list-e2e';
const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

function boot(enabled: boolean) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `prefs-list-e2e-${enabled ? 'on' : 'off'}-`));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'prefs-list-e2e' }));
  const config = {
    projectName: 'prefs-list-e2e', agentName: 'E2E Agent', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH_TOKEN,
    monitoring: { correctionLearning: { enabled } },
  } as InstarConfig;
  const server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
  return { tmpDir, stateDir, server, app: server.getApp() };
}

describe('GET /preferences is alive on the production boot path', () => {
  let on: ReturnType<typeof boot>;
  let off: ReturnType<typeof boot>;
  beforeAll(() => { on = boot(true); off = boot(false); });
  afterAll(async () => {
    for (const b of [on, off]) {
      try { await (b.server as unknown as { stop?: () => Promise<void> }).stop?.(); } catch { /* ignore */ }
      SafeFsExecutor.safeRmSync(b.tmpDir, { recursive: true, force: true, operation: 'tests/e2e/preferences-list-alive.test.ts' });
    }
  });

  it('answers 200 (not 404/503) with the dated list when enabled', async () => {
    const empty = await request(on.app).get('/preferences').set(auth());
    expect(empty.status).toBe(200);
    expect(empty.body.entries).toEqual([]);
    new PreferencesManager(on.stateDir).recordPreference({ learning: 'Answer first.', dedupeKey: 'user-preference:answer-first', confidence: 0.9, recordedAt: '2026-10-25T12:00:00.000Z' });
    const res = await request(on.app).get('/preferences').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toMatchObject({ learning: 'Answer first.', recordedAt: '2026-10-25T12:00:00.000Z', dedupeCount: 1 });
  });

  it('answers 503 on the same boot path when disabled', async () => {
    const res = await request(off.app).get('/preferences').set(auth());
    expect(res.status).toBe(503);
  });
});
