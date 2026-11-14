/**
 * Tier-3 E2E: an existing agent after an update, on the production wiring path. Several
 * people, a Telegram group topic, no working sandbox, and no memoryPrivacy setting at
 * all, which is what the first boot sees before its migration reaches memory.
 * Justin, 2026-11-04: an update must never restrict an existing agent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { wireMemoryPrivacy } from '../../src/users/wireMemoryPrivacy.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('memory privacy on an upgraded agent (alive on the production wiring path)', () => {
  let dir: string;
  let app: Parameters<typeof request>[0];
  let wiring: ReturnType<typeof wireMemoryPrivacy>;
  const agentToken = 'e2e-upgraded-token';

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-upgraded-e2e-')));
    const stateDir = path.join(dir, 'agent', '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'mp-up', authToken: agentToken }));
    fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([
      { id: 'pat', name: 'pat', channels: [], permissions: [], preferences: {}, slackUserId: 'U1', orgRole: 'owner' },
      { id: 'sam', name: 'sam', channels: [], permissions: [], preferences: {}, slackUserId: 'U2' },
    ]));
    const config = {
      projectName: 'mp-up', projectDir: path.join(dir, 'agent'), stateDir, port: 0, authToken: agentToken, requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [{ type: 'slack', config: { authorizedUserIds: ['U1', 'U2'] } }], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    let status: () => unknown = () => null;
    const sessionManager = {
      listRunningSessions: () => [], getSession: () => null, memoryAudienceKind: () => 'open',
      setMemoryPrivacy(w: { privacy: { enabled: boolean; isMultiPerson(): boolean; ownerUserId(): string | null }; sandboxReady(): boolean }) {
        status = () => ({ enabled: w.privacy.enabled, multiPerson: w.privacy.isMultiPerson(), ownerUserId: w.privacy.ownerUserId(), sandboxReady: w.sandboxReady() });
      },
      retireSessionsForAudienceChange: async () => { throw new Error('must not run on an upgraded agent'); },
      retireSessionUnlessAudience: async () => { throw new Error('must not run on an upgraded agent'); },
      memoryPrivacyStatus: () => status(),
    };
    wiring = wireMemoryPrivacy({
      projectDir: path.join(dir, 'agent'), stateDir, projectName: 'mp-up', instarRoot: path.join(dir, '.instar'),
      framework: () => 'claude-code', memoryPrivacy: () => undefined, probe: async () => false,
      messaging: () => config.messaging as never, sessionManager: sessionManager as never, slackBotUserId: () => 'B',
    });
    await wiring.ready;
    app = new AgentServer({ config, state: new StateManager(stateDir), memoryPrivacy: wiring.privacy, sessionManager: sessionManager as never }).getApp();
  });
  afterAll(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/memory-privacy-existing-agent-lifecycle.test.ts' }));

  it('is alive and reports privacy off', async () => {
    const res = await request(app).get('/memory-privacy').set('Authorization', `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, multiPerson: false });
  });

  it('a group topic message is delivered, with no refusal and no session ended', async () => {
    expect(await wiring.tracker.onInbound({
      placeKey: 'telegram:-100123', placeKind: 'shared', senderKey: 'telegram:42', personId: null,
      readerCount: async () => 5, liveSession: () => 'topic-session',
    })).toBe('deliver');
  });

  it('a channel and a direct message from someone other than the owner are delivered too', async () => {
    for (const placeKind of ['shared', 'private'] as const) {
      expect(await wiring.tracker.onInbound({ placeKey: `slack:${placeKind}`, placeKind, senderKey: 'user:sam', personId: 'sam' })).toBe('deliver');
    }
  });
});
