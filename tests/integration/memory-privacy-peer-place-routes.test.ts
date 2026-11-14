/**
 * Integration — another agent's place against the full HTTP pipeline, with real `mps_` tokens.
 * Spec: docs/specs/memory-privacy-agent-places.md §5, §6.
 *
 * The reply route sends to the agent in the token's place and nowhere else, on a thread that
 * belongs to that agent. The place reaches no memory route, cannot reach the owner or the
 * maintainers, and cannot use relay-send. A fake listener on the configured port records what
 * the route hands to relay-send, the same outbound path threadline_send uses.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { MemoryPrivacy } from '../../src/users/MemoryPrivacy.js';
import { ThreadResumeMap } from '../../src/threadline/ThreadResumeMap.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('memory privacy — peer place routes (integration)', () => {
  let dir: string;
  let app: Parameters<typeof request>[0];
  let fake: http.Server;
  let sent: Array<{ path: string; auth: string; body: Record<string, unknown> }> = [];
  let peerToken: string;
  let personToken: string;
  let threads: ThreadResumeMap;
  const agentToken = 'agent-token-for-test';
  const placeSession = 'mp-msg-place-1';

  beforeAll(async () => {
    fake = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        sent.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? ''), body: JSON.parse(raw || '{}') });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, delivered: true }));
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const port = (fake.address() as AddressInfo).port;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-place-routes-'));
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port, projectName: 'mp', authToken: agentToken }));
    const config = {
      projectName: 'mp', projectDir: dir, stateDir, port, authToken: agentToken, requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 5, defaultMaxDurationMinutes: 30, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    const privacy = new MemoryPrivacy({
      stateDir, instarRoot: dir, agentId: 'mp', config: () => ({ enabled: true }), users: () => [],
      reachable: () => ({ slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'BOT' }),
    });
    peerToken = privacy.issueSessionToken('p1', { kind: 'place', placeKey: `agent:${A}` }, `agent:${A}`);
    personToken = privacy.issueSessionToken('s1', { kind: 'person', userId: 'u2' }, 'slack:D2');
    threads = new ThreadResumeMap(stateDir, dir);
    const server = new AgentServer({
      config, state: new StateManager(stateDir), memoryPrivacy: privacy, threadResumeMap: threads,
      sessionManager: {
        listRunningSessions: () => [{ id: 'p1', name: placeSession, tmuxSession: placeSession }],
        getSession: () => null,
        memoryPrivacyStatus: () => ({ enabled: true, multiPerson: true, ownerUserId: null, sandboxReady: true, blocker: null, fix: null, agentSessions: 'own-place' }),
        memoryAudienceKind: () => 'place',
        isMultiPersonAgent: () => true,
        linkedPeerReplies: () => 'deliver',
      } as never,
    });
    app = server.getApp();
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/memory-privacy-peer-place-routes.test.ts' });
  });
  beforeEach(() => { sent = []; });

  const post = (token: string, route: string, body: Record<string, unknown>) =>
    request(app).post(route).set('Authorization', `Bearer ${token}`).send(body);

  it('sends a reply to the agent in the token\'s place, on that agent\'s thread', async () => {
    threads.claimOwner('thread-a', A, { hasStoredMessages: false });
    const res = await post(peerToken, '/threadline/session-reply', { threadId: 'thread-a', text: 'hello from my place' });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe('/threadline/relay-send');
    expect(sent[0].auth).toBe(`Bearer ${agentToken}`);
    expect(sent[0].body).toMatchObject({ targetAgent: A, threadId: 'thread-a', message: 'hello from my place', originSessionName: placeSession });
  });

  it('a co-located agent with exactly this fingerprint is addressed by name:fingerprint over the local route', async () => {
    const known = path.join(dir, '.instar', 'threadline', 'known-agents.json');
    fs.mkdirSync(path.dirname(known), { recursive: true });
    fs.writeFileSync(known, JSON.stringify({ agents: [{ name: 'peer-a', fingerprint: A }, { name: 'peer-b', fingerprint: B }] }));
    threads.claimOwner('thread-local', A, { hasStoredMessages: false });
    const res = await post(peerToken, '/threadline/session-reply', { threadId: 'thread-local', text: 'local hello' });
    SafeFsExecutor.safeRmSync(known, { force: true, operation: 'tests/integration/memory-privacy-peer-place-routes.test.ts' });
    expect(res.status).toBe(200);
    expect(sent[0].body.targetAgent).toBe(`peer-a:${A.slice(0, 16)}`);
  });

  it('the request can never name the recipient', async () => {
    threads.claimOwner('thread-a2', A, { hasStoredMessages: false });
    const res = await post(peerToken, '/threadline/session-reply', { threadId: 'thread-a2', text: 'x', targetAgent: B, to: B });
    expect(res.status).toBe(200);
    expect(sent[0].body.targetAgent).toBe(A);
  });

  it('refuses another agent\'s thread, and sends nothing', async () => {
    threads.claimOwner('thread-b', B, { hasStoredMessages: false });
    const res = await post(peerToken, '/threadline/session-reply', { threadId: 'thread-b', text: 'leak' });
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('refuses an unowned thread', async () => {
    const res = await post(peerToken, '/threadline/session-reply', { threadId: 'never-claimed', text: 'x' });
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('with no thread named, uses the one thread this session serves for this agent, and asks when there are several', async () => {
    threads.claimOwner('bound-1', A, { hasStoredMessages: false });
    const entry = (id: string) => ({ uuid: '', sessionName: placeSession, createdAt: '', savedAt: '', lastAccessedAt: new Date().toISOString(), remoteAgent: A, subject: 's', state: 'active' as const, pinned: false, messageCount: 1 });
    // Only bound entries with a live session resolve through get(); the route reads the store.
    threads.save('bound-1', entry('bound-1'));
    const before = threads.getBySessionName(placeSession).length;
    const res = await post(peerToken, '/threadline/session-reply', { text: 'x' });
    if (before === 1) {
      expect(res.status).toBe(200);
      expect(sent[0].body.threadId).toBe('bound-1');
    } else {
      expect(res.status).toBe(409);
    }
    threads.claimOwner('bound-2', A, { hasStoredMessages: false });
    threads.save('bound-2', entry('bound-2'));
    const res2 = await post(peerToken, '/threadline/session-reply', { text: 'x' });
    expect(res2.status).toBe(409);
  });

  it('refuses files from a place session', async () => {
    threads.claimOwner('thread-f', A, { hasStoredMessages: false });
    const res = await post(peerToken, '/threadline/session-reply', { threadId: 'thread-f', text: 'x', files: [{ path: '/etc/passwd' }] });
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('is a peer place\'s only: a person\'s session and the agent token are refused', async () => {
    expect((await post(personToken, '/threadline/session-reply', { text: 'x' })).status).toBe(403);
    expect((await post(agentToken, '/threadline/session-reply', { text: 'x' })).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['GET', '/memory/search?q=budget'], ['GET', '/topic/context?assembled=true'], ['GET', '/commitments'],
    ['GET', '/api/files/read?path=.instar/MEMORY.md'], ['GET', '/semantic/search?q=x'], ['GET', '/relationships'],
    ['GET', '/context/working-memory'], ['GET', '/sessions'], ['GET', '/memory-privacy'],
    ['POST', '/team/proposals'], ['POST', '/feedback'], ['POST', '/threadline/relay-send'], ['POST', '/threadline/ack'],
    ['POST', '/slack/session-reply'], ['POST', '/app/session-reply'], ['GET', '/app/media-path/x'],
    ['POST', `/telegram/reply/1`], ['POST', '/slack/reply/C1'], ['POST', '/whatsapp/send/1'],
  ])('a peer place token is refused on %s %s', async (method, route) => {
    const req = method === 'GET' ? request(app).get(route) : request(app).post(route).send({});
    const res = await req.set('Authorization', `Bearer ${peerToken}`);
    expect(res.status).toBe(403);
  });
});
