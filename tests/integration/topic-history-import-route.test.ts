/**
 * Integration — POST /topic/import over the real HTTP pipeline
 * (docs/specs/topic-history-import.md): file and inline modes, dry run,
 * path-escape refusal, paired-device refusal, the audit trail, idempotence,
 * and GET /topic/search reaching a restored row with recent history still
 * ending on the newest live message.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const T = (min: number) => new Date(Date.UTC(2026, 7, 1, 12, min)).toISOString();

describe('POST /topic/import', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let topicMemory: TopicMemory;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH = 'test-auth-topic-import';
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);

  beforeAll(async () => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    topicMemory = new TopicMemory(project.stateDir);
    await topicMemory.open();
    for (const [mid, min] of [[1000, 10], [1002, 30], [1004, 50]] as const) {
      topicMemory.insertMessage({ messageId: mid, topicId: 135786, text: `live message ${mid}`, fromUser: false, timestamp: T(min), sessionName: null });
    }
    fs.mkdirSync(path.join(project.stateDir, 'recovery'), { recursive: true });
    const recovered = [
      { messageId: 1001, topicId: 135786, text: 'the flamingo deployment plan', fromUser: true, timestamp: T(20), sessionName: null, recoveredFrom: 'mini' },
      { messageId: 1003, topicId: 135786, text: 'agent answer about flamingos', fromUser: false, timestamp: T(40), sessionName: 'echo-x', recoveredFrom: 'mini' },
      { messageId: 'app:msg-abc', topicId: 135786, text: 'typed in the app', fromUser: true, timestamp: T(41), sessionName: null },
      { messageId: 'g3test-1', topicId: 888888, text: 'fixture', fromUser: true, timestamp: T(1), sessionName: null },
    ];
    fs.writeFileSync(path.join(project.stateDir, 'recovery', 'recovered.jsonl'), recovered.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const config: InstarConfig = {
      projectName: 'test-topic-import', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 5000, version: '0.9.1',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    };
    server = new AgentServer({ config, sessionManager: mockSM as any, state: project.state, topicMemory });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    topicMemory.close();
    project.cleanup();
  });

  it('requires the bearer token', async () => {
    await request(app).post('/topic/import').send({ rows: [] }).expect(401);
  });

  it('refuses a paired-device principal', async () => {
    const wrapped = express();
    wrapped.use((req, _res, next) => { (req as unknown as { instarPrincipal: unknown }).instarPrincipal = { kind: 'device', deviceId: 'team-phone' }; next(); });
    wrapped.use(app);
    const res = await auth(request(wrapped).post('/topic/import')).send({ rows: [] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('agent-token-required');
  });

  it('refuses a path outside the state directory', async () => {
    expect((await auth(request(app).post('/topic/import')).send({ file: '../../etc/passwd' })).status).toBe(400);
    expect((await auth(request(app).post('/topic/import')).send({ file: '/etc/passwd' })).status).toBe(400);
    const link = path.join(project.stateDir, 'escape.jsonl');
    fs.symlinkSync('/etc/hosts', link);
    expect((await auth(request(app).post('/topic/import')).send({ file: 'escape.jsonl' })).status).toBe(400);
    expect((await auth(request(app).post('/topic/import')).send({})).status).toBe(400);
  });

  it('dry run reports without writing', async () => {
    const res = await auth(request(app).post('/topic/import')).send({ file: 'recovery/recovered.jsonl', dryRun: true }).expect(200);
    expect(res.body).toMatchObject({ dryRun: true, received: 4, accepted: 2, importId: null });
    expect(res.body.rejected).toEqual({ 'app-message': 1, 'bad-id': 1 });
    expect(topicMemory.getMessageCount(135786)).toBe(3);
  });

  it('imports from a file, merges by time, and search finds the restored words', async () => {
    const res = await auth(request(app).post('/topic/import')).send({ file: 'recovery/recovered.jsonl', source: 'test-recovery' }).expect(200);
    expect(res.body).toMatchObject({ accepted: 2, merged: { topics: 1, inserted: 2 } });
    expect(res.body.perTopic['135786']).toEqual({ accepted: 2, duplicate: 0 });
    expect(typeof res.body.importId).toBe('string');

    const search = await auth(request(app).get('/topic/search?topic=135786&q=flamingo')).expect(200);
    expect(search.body.results.map((r: { messageId: number }) => r.messageId).sort()).toEqual([1001, 1003]);

    const ctx = await auth(request(app).get('/topic/context/135786?recent=10')).expect(200);
    const recentIds = ctx.body.recentMessages.map((m: { messageId: number }) => m.messageId);
    expect(recentIds).toEqual([1000, 1001, 1002, 1003, 1004]);

    const audit = fs.readFileSync(path.join(project.stateDir, 'logs', 'topic-history-imports.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(audit.map((a) => a.phase)).toEqual(['accepted', 'merged']);
    expect(audit[0]).toMatchObject({ source: 'test-recovery', file: 'recovered.jsonl', importId: res.body.importId });
    expect(JSON.stringify(audit)).not.toContain('flamingo');
  });

  it('a second identical import accepts nothing', async () => {
    const res = await auth(request(app).post('/topic/import')).send({ file: 'recovery/recovered.jsonl' }).expect(200);
    expect(res.body).toMatchObject({ accepted: 0, duplicate: 2, importId: null });
  });

  it('accepts inline rows', async () => {
    const res = await auth(request(app).post('/topic/import')).send({
      rows: [{ messageId: 999, topicId: 135786, text: 'an earlier inline row', fromUser: true, timestamp: T(5), sessionName: null }],
    }).expect(200);
    expect(res.body.accepted).toBe(1);
    const ctx = await auth(request(app).get('/topic/context/135786?recent=10')).expect(200);
    expect(ctx.body.recentMessages[0].messageId).toBe(999);
    expect(ctx.body.recentMessages.at(-1).messageId).toBe(1004);
  });
});
