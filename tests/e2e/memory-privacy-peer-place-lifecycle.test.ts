/**
 * Tier-3 E2E "feature is alive": another agent's place on the production wiring path.
 * wireMemoryPrivacy is what startServer calls; AgentServer is real. Spec:
 * docs/specs/memory-privacy-agent-places.md.
 *
 * Alive means: the status the app reads says agents get their own place, the reply route is
 * mounted and reached by a session token issued for a peer place, and that token still reaches
 * no memory route and cannot write to the owner or the maintainers.
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
import { agentSessionsStatus } from '../../src/users/peerPlaceAdmission.js';
import type { InstarConfig, UserProfile } from '../../src/core/types.js';

const person = (id: string, slackUserId: string, extra: Partial<UserProfile> = {}): UserProfile =>
  ({ id, name: id, channels: [], permissions: [], preferences: {}, slackUserId, ...extra }) as UserProfile;
const PEER = 'e'.repeat(64);

describe('another agent\'s place (alive on the production wiring path)', () => {
  let dir: string;
  let app: Parameters<typeof request>[0];
  let wiring: ReturnType<typeof wireMemoryPrivacy>;
  const agentToken = 'e2e-agent-token';

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'peer-place-e2e-')));
    const stateDir = path.join(dir, 'agent', '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'pp-e2e', authToken: agentToken }));
    fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([person('pat', 'U1', { orgRole: 'owner' }), person('sam', 'U2')]));
    const config = {
      projectName: 'pp-e2e', projectDir: path.join(dir, 'agent'), stateDir, port: 0, authToken: agentToken,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 5, defaultMaxDurationMinutes: 30, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [{ type: 'slack', config: { authorizedUserIds: ['U1', 'U2'] } }], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    let status: () => unknown = () => null;
    const sessionManager = {
      listRunningSessions: () => [], getSession: () => null,
      setMemoryPrivacy(w: { privacy: { isMultiPerson(): boolean; ownerUserId(): string | null; enabled: boolean; refuseAgentSessions(): boolean }; sandboxReady(): boolean }) {
        status = () => ({
          enabled: w.privacy.enabled, multiPerson: w.privacy.isMultiPerson(), ownerUserId: w.privacy.ownerUserId(), sandboxReady: w.sandboxReady(),
          agentSessions: agentSessionsStatus({ multiPerson: w.privacy.enabled && w.privacy.isMultiPerson(), refuseAgentSessions: w.privacy.refuseAgentSessions(), scopedSessionsReady: w.sandboxReady() }),
        });
      },
      retireSessionsForAudienceChange: async () => [],
      retireSessionUnlessAudience: async () => undefined,
      memoryPrivacyStatus: () => status(),
      memoryAudienceKind: () => 'place',
      isMultiPersonAgent: () => true,
      linkedPeerReplies: () => 'deliver',
    };
    wiring = wireMemoryPrivacy({
      projectDir: path.join(dir, 'agent'), stateDir, projectName: 'pp-e2e', instarRoot: path.join(dir, '.instar'),
      framework: () => 'claude-code', memoryPrivacy: () => ({ enabled: true }),
      messaging: () => config.messaging as never, sessionManager: sessionManager as never, probe: async () => true, slackBotUserId: () => 'B',
    });
    await wiring.ready;
    app = new AgentServer({ config, state: new StateManager(stateDir), memoryPrivacy: wiring.privacy, sessionManager: sessionManager as never }).getApp();
  });
  afterAll(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/memory-privacy-peer-place-lifecycle.test.ts' }));

  it('is alive: the status route tells the app agents get their own place', async () => {
    const res = await request(app).get('/memory-privacy').set('Authorization', `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, multiPerson: true, agentSessions: 'own-place' });
  });

  it('is wired: a peer place token from the live object reaches the reply route, not a refusal', async () => {
    const token = wiring.privacy.issueSessionToken('peer-s', { kind: 'place', placeKey: `agent:${PEER}` }, `agent:${PEER}`);
    const res = await request(app).post('/threadline/session-reply').set('Authorization', `Bearer ${token}`).send({ text: 'hello' });
    // Past the guard: the handler answers (no Threadline store on this fixture), not the 403 of a refused route.
    expect(res.status).not.toBe(403);
    expect(res.body.error).not.toBe('not-available-to-this-session');
  });

  it('a peer place token reaches no memory and cannot write to the owner or the maintainers', async () => {
    const token = wiring.privacy.issueSessionToken('peer-s2', { kind: 'place', placeKey: `agent:${PEER}` }, `agent:${PEER}`);
    for (const route of ['/memory/search?q=salary', '/topic/context?assembled=true', '/commitments']) {
      expect((await request(app).get(route).set('Authorization', `Bearer ${token}`)).status).toBe(403);
    }
    for (const route of ['/team/proposals', '/feedback', '/threadline/relay-send']) {
      expect((await request(app).post(route).set('Authorization', `Bearer ${token}`).send({})).status).toBe(403);
    }
  });
});
