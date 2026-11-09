/**
 * Tier-3 E2E "feature is alive": memory privacy on the production wiring path.
 * wireMemoryPrivacy is what startServer calls; AgentServer is real; the fact,
 * the people and the fixture are made up. Spec: docs/specs/memory-privacy.md.
 *
 * Standing regression (Dawn: a brand-new user is how Portal's second leak was
 * found): two people plus a new person with no memory of their own.
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
import { memoryScopeDir } from '../../src/users/MemoryAudience.js';
import type { InstarConfig, UserProfile } from '../../src/core/types.js';

const person = (id: string, slackUserId: string, extra: Partial<UserProfile> = {}): UserProfile =>
  ({ id, name: id, channels: [], permissions: [], preferences: {}, slackUserId, ...extra }) as UserProfile;

describe('memory privacy (alive on the production wiring path)', () => {
  let dir: string;
  let stateDir: string;
  let app: Parameters<typeof request>[0];
  let wiring: ReturnType<typeof wireMemoryPrivacy>;
  const running: unknown[] = [];
  const agentToken = 'e2e-agent-token';

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-privacy-e2e-')));
    stateDir = path.join(dir, 'agent', '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'mp-e2e', authToken: agentToken }));
    fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([
      person('pat', 'U1', { orgRole: 'owner' }), person('sam', 'U2'), person('newbie', 'U3'),
    ]));
    const config = {
      projectName: 'mp-e2e', projectDir: path.join(dir, 'agent'), stateDir, port: 0, authToken: agentToken,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [{ type: 'slack', config: { authorizedUserIds: ['U1', 'U2', 'U3'] } }], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    let status: unknown = null;
    const sessionManager = {
      listRunningSessions: () => running, getSession: () => null,
      setMemoryPrivacy(w: { privacy: { isMultiPerson(): boolean; ownerUserId(): string | null; enabled: boolean }; sandboxReady(): boolean }) {
        status = () => ({ enabled: w.privacy.enabled, multiPerson: w.privacy.isMultiPerson(), ownerUserId: w.privacy.ownerUserId(), sandboxReady: w.sandboxReady() });
      },
      retireSessionsForAudienceChange: async () => [],
      retireSessionUnlessAudience: async () => undefined,
      memoryPrivacyStatus: () => (status as () => unknown)(),
      memoryAudienceKind: () => 'open',
    };
    wiring = wireMemoryPrivacy({
      projectDir: path.join(dir, 'agent'), stateDir, projectName: 'mp-e2e', instarRoot: path.join(dir, '.instar'),
      framework: () => 'claude-code', memoryPrivacy: () => ({ enabled: true }),
      messaging: () => config.messaging as never, sessionManager: sessionManager as never, probe: async () => true, slackBotUserId: () => 'B',
    });
    await wiring.ready;
    app = new AgentServer({ config, state: new StateManager(stateDir), memoryPrivacy: wiring.privacy, sessionManager: sessionManager as never }).getApp();
  });
  afterAll(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/memory-privacy-lifecycle.test.ts' }));

  it('is alive: the status route answers 200 with the real state', async () => {
    const res = await request(app).get('/memory-privacy').set('Authorization', `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, multiPerson: true, ownerUserId: 'pat', sandboxReady: true });
  });

  it('is wired: a session token issued by the live object is honoured by the auth layer', async () => {
    const token = wiring.privacy.issueSessionToken('s', { kind: 'person', userId: 'sam' }, 'slack:D2');
    const res = await request(app).get('/memory-privacy').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not-available-to-this-session');
  });

  it('keeps a fact in the folder of the person who said it', () => {
    const { privacy } = wiring;
    privacy.recordPlace('slack:D1', 'private', 'pat');
    privacy.recordPlace('slack:D2', 'private', 'sam');
    privacy.recordPlace('slack:D3', 'private', 'newbie');
    const audiences = ['D1', 'D2', 'D3'].map((d) => privacy.audienceFor(privacy.placeFor({ slackChannelId: d }, null)));
    expect(audiences.map((a) => a.kind)).toEqual(['owner', 'person', 'person']);
    const samDir = privacy.ensureScopeDir(audiences[1], 's')!;
    const newDir = privacy.ensureScopeDir(audiences[2], 's')!;
    fs.writeFileSync(path.join(samDir, 'note.md'), 'made-up budget 61,800');
    expect(fs.readdirSync(newDir).sort()).toEqual(['inbox', 'tmp']);
    expect(samDir).toBe(memoryScopeDir(path.join(dir, '.instar'), 'mp-e2e', audiences[1]));
    expect(samDir.startsWith(path.join(dir, 'agent'))).toBe(false);
  });

  it('gives a channel the channel, even for the fact\'s own owner', () => {
    const { privacy } = wiring;
    expect(privacy.audienceFor(privacy.placeFor({ slackChannelId: 'C1' }, null))).toEqual({ kind: 'place', placeKey: 'slack:C1' });
  });
});
