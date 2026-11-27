/**
 * Tier-3 E2E: the owner recovery, on the production wiring path. Mirrors the 2026-11-04
 * Indra report: a Mac agent set to a Claude below the floor, a working one elsewhere,
 * and the owner refused in a private channel. wireMemoryPrivacy and AgentServer are
 * real, and the two binaries are real executables. Only the OS sandbox probe is fixed,
 * so this runs the same on any host. Spec: docs/specs/memory-privacy.md, "Owner recovery".
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { wireMemoryPrivacy } from '../../src/users/wireMemoryPrivacy.js';
import { MEMORY_PRIVACY_OWNER_CHANNEL_REPLY, MEMORY_PRIVACY_UNAVAILABLE_REPLY } from '../../src/users/MemoryInboundTracker.js';
import type { InstarConfig } from '../../src/core/types.js';

vi.mock('../../src/core/memorySandboxProbe.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/memorySandboxProbe.js')>()),
  memorySandboxWorks: async () => true,
}));

describe('memory privacy owner recovery (alive on the production wiring path)', () => {
  let dir: string;
  let configFile: string;
  let good: string;
  let app: Parameters<typeof request>[0];
  let wiring: ReturnType<typeof wireMemoryPrivacy>;
  const agentToken = 'e2e-recovery-token';
  const sessions = { claudePath: '' };
  const owner = { placeKey: 'slack:G1', placeKind: 'shared' as const, senderKey: 'user:pat', personId: 'pat' };
  const other = { ...owner, senderKey: 'user:sam', personId: 'sam' };

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-recovery-e2e-')));
    const stateDir = path.join(dir, 'agent', '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    const binary = (name: string, version: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
      return file;
    };
    const old = binary('old-claude', '2.1.300');
    good = binary('new-claude', '2.1.318');
    sessions.claudePath = old;
    configFile = path.join(stateDir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ port: 0, projectName: 'mp-rec', authToken: agentToken, sessions: { claudePath: old } }));
    fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([
      { id: 'pat', name: 'pat', channels: [], permissions: [], preferences: {}, slackUserId: 'U1', orgRole: 'owner' },
      { id: 'sam', name: 'sam', channels: [], permissions: [], preferences: {}, slackUserId: 'U2' },
    ]));
    const config = {
      projectName: 'mp-rec', projectDir: path.join(dir, 'agent'), stateDir, port: 0, authToken: agentToken, requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: old, maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [{ type: 'slack', config: { authorizedUserIds: ['U1', 'U2'] } }], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    // The real SessionManager methods, on a stand-in that starts no tmux.
    const real = SessionManager.prototype;
    const manager = {
      config: sessions,
      memoryPrivacyWiring: undefined as unknown,
      setMemoryPrivacy(w: unknown) { this.memoryPrivacyWiring = w; },
      setClaudeBinary: real.setClaudeBinary,
      memoryPrivacyStatus: real.memoryPrivacyStatus,
      memoryPrivacyRecovery: real.memoryPrivacyRecovery,
      listRunningSessions: () => [], getSession: () => null, memoryAudienceKind: () => 'open',
      retireSessionsForAudienceChange: async () => [], retireSessionUnlessAudience: async () => true,
    };
    wiring = wireMemoryPrivacy({
      projectDir: path.join(dir, 'agent'), stateDir, projectName: 'mp-rec', instarRoot: path.join(dir, '.instar'),
      framework: () => 'claude-code', memoryPrivacy: () => ({ enabled: true }), claudePath: old, claudeCandidates: [good],
      linkFor: (p) => p, messaging: () => config.messaging as never, sessionManager: manager as never, slackBotUserId: () => 'B',
    });
    await wiring.ready;
    app = new AgentServer({ config, state: new StateManager(stateDir), memoryPrivacy: wiring.privacy, sessionManager: manager as never }).getApp();
  });
  afterAll(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/memory-privacy-recovery-lifecycle.test.ts' }));

  const status = () => request(app).get('/memory-privacy').set('Authorization', `Bearer ${agentToken}`);

  it('boots blocked, and the status route names the real cause', async () => {
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body.sandboxReady).toBe(false);
    expect(res.body.blocker).toBe('claude-too-old');
    expect(res.body.fix).toContain('2.1.300');
  });

  it('refuses the message rather than run it unprotected', async () => {
    expect(await wiring.tracker.onInbound(owner)).toBe('unavailable');
  });

  it('someone else in that channel learns nothing', async () => {
    const sent: string[] = [];
    expect(await wiring.tracker.refuse(other, async (t) => { sent.push(t); return true; })).toBe(MEMORY_PRIVACY_UNAVAILABLE_REPLY);
    expect(sent).toEqual([]);
  });

  it('the owner repairs it from the private link, and the next message is delivered', async () => {
    let privateMessage = '';
    const reply = await wiring.tracker.refuse(owner, async (t) => { privateMessage = t; return true; });
    expect(reply).toBe(MEMORY_PRIVACY_OWNER_CHANNEL_REPLY);
    const link = /\/memory-privacy\/fix\/[A-Za-z0-9_-]{43}/.exec(privateMessage)?.[0] as string;

    expect((await request(app).get(link)).status).toBe(200);
    expect((await status()).body.sandboxReady).toBe(false);

    expect((await request(app).post(link)).status).toBe(200);
    const after = (await status()).body;
    expect(after).toMatchObject({ enabled: true, sandboxReady: true, blocker: null, fix: null });
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).sessions.claudePath).toBe(good);
    expect(sessions.claudePath).toBe(good);
    expect(await wiring.tracker.onInbound(owner)).toBe('deliver');
    expect((await request(app).post(link)).status).toBe(410);
  });
});
