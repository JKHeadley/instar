/**
 * Feature-is-alive proof for the People read (docs/specs/team-roles-and-access.md §3.10): the real
 * wireMemoryPrivacy feeds the real tracker with memory privacy OFF, an inbound sender is counted
 * through the real MemoryInboundTracker, and GET /team/people on a real AgentServer answers 200.
 * Wiring integrity: the reach seam is a live delegate, not a no-op.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { wireMemoryPrivacy } from '../../src/users/wireMemoryPrivacy.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('team people is alive', () => {
  const token = 'team-people-e2e-token';
  let dir: string;
  let app: Parameters<typeof request>[0];
  let wiring: ReturnType<typeof wireMemoryPrivacy>;

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-people-e2e-')));
    const stateDir = path.join(dir, 'agent', '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'tp-e2e', authToken: token }));
    const config = {
      projectName: 'tp-e2e', projectDir: path.join(dir, 'agent'), stateDir, port: 0, authToken: token,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [{ type: 'slack', config: { authorizedUserIds: ['U1'] } }], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    const sessionManager = {
      listRunningSessions: () => [], getSession: () => null, setMemoryPrivacy() {},
      retireSessionsForAudienceChange: async () => [], retireSessionUnlessAudience: async () => undefined,
      memoryPrivacyStatus: () => ({ enabled: false, multiPerson: false, ownerUserId: null, sandboxReady: false, blocker: null, fix: null }),
      memoryAudienceKind: () => 'open',
    };
    wiring = wireMemoryPrivacy({
      projectDir: path.join(dir, 'agent'), stateDir, projectName: 'tp-e2e', instarRoot: path.join(dir, '.instar'),
      framework: () => 'claude-code', memoryPrivacy: () => undefined, ownerName: () => 'Pat',
      messaging: () => config.messaging as never, sessionManager: sessionManager as never, probe: async () => true, slackBotUserId: () => 'B',
    });
    await wiring.ready;
    app = new AgentServer({ config, state: new StateManager(stateDir), reachablePeople: wiring.reachablePeople, sessionManager: sessionManager as never }).getApp();
  });
  afterAll(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/team-people-alive.test.ts' }));

  it('answers 200, and counts a second sender with memory privacy off', async () => {
    const auth = (r: ReturnType<ReturnType<typeof request>['get']>) => r.set('Authorization', `Bearer ${token}`);
    const before = await auth(request(app).get('/team/people'));
    expect(before.status).toBe(200);
    expect(before.body.count).toBe(1);
    // The team settings summary rides the same read on the production boot path (memory privacy is off here).
    expect(Array.isArray(before.body.teamSwitches)).toBe(true);
    expect(before.body.teamSwitches.map((l: { setting: string }) => l.setting)).toContain('memory-privacy');
    expect(wiring.reachablePeople.warning()).toBeNull();

    const verdict = await wiring.tracker.onInbound({ senderKey: 'slack:U9', placeKey: 'slack:C1', placeKind: 'shared' } as never);
    expect(verdict).toBe('deliver');

    const after = await auth(request(app).get('/team/people'));
    expect(after.body.count).toBe(2);
    expect(after.body.people.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['Pat']));

    // The new sender wakes the notice pass: one item on the owner's list, then held.
    await vi.waitFor(async () => {
      const list = await auth(request(app).get('/attention'));
      const item = list.body.items.find((i: { id: string }) => i.id === 'agent:team:second-person');
      expect(item?.summary).toContain('2 people can reach this agent');
    });
    expect(wiring.reachablePeople.warning()).toBeNull();
  });
});
