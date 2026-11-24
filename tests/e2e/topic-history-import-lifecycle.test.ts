/**
 * E2E lifecycle — topic history import (docs/specs/topic-history-import.md).
 *
 * Mirrors the production boot path in server.ts: TopicMemory.open() →
 * importAllLogs() → AgentServer with the live store. Proves the feature is
 * alive (200, not 503), that a restore survives a server restart and a
 * destructive POST /topic/rebuild in message-time order, and that the live
 * log is never written.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T = (min: number) => new Date(Date.UTC(2026, 9, 1, 9, min)).toISOString();
const AUTH = 'test-e2e-topic-import';

describe('topic history import — E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let liveLog: string;
  let liveLogBefore: string;
  let topicMemory: TopicMemory;
  let server: AgentServer;

  async function boot(): Promise<ReturnType<AgentServer['getApp']>> {
    // The server.ts sequence: open, then replay every log (which re-applies import batches).
    topicMemory = new TopicMemory(stateDir);
    await topicMemory.open();
    await topicMemory.importAllLogs();
    const config: InstarConfig = {
      projectName: 'test-topic-import-e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.9.1',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    };
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir), topicMemory });
    await server.start();
    return server.getApp();
  }

  async function shutdown(): Promise<void> {
    await server.stop();
    topicMemory.close();
  }

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-import-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    for (const d of ['state/sessions', 'state/jobs', 'logs', 'recovery']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
    liveLog = path.join(stateDir, 'telegram-messages.jsonl');
    const live = [10, 30, 50].map((min, i) => JSON.stringify({ messageId: 2000 + i * 2, topicId: 141469, text: `live ${i}`, fromUser: i === 2, timestamp: T(min), sessionName: null }));
    fs.writeFileSync(liveLog, live.join('\n') + '\n');
    liveLogBefore = fs.readFileSync(liveLog, 'utf-8');
    const recovered = [
      { messageId: 2001, topicId: 141469, text: 'recovered heron notes', fromUser: true, timestamp: T(20), sessionName: null },
      { messageId: 2003, topicId: 141469, text: 'recovered agent reply', fromUser: false, timestamp: T(40), sessionName: 'echo-a' },
      { messageId: 500, topicId: 141133, text: 'a heron in another topic', fromUser: true, timestamp: T(1), sessionName: null },
    ];
    fs.writeFileSync(path.join(stateDir, 'recovery', 'r.jsonl'), recovered.map((r) => JSON.stringify(r)).join('\n') + '\n');
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/topic-history-import-lifecycle.test.ts' });
  });

  it('is alive on the production path and restores history in time order', async () => {
    const app = await boot();
    const res = await request(app).post('/topic/import').set('Authorization', `Bearer ${AUTH}`).send({ file: 'recovery/r.jsonl' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: 3, merged: { topics: 2, inserted: 3 } });
    const hits = await request(app).get('/topic/search?topic=141469&q=heron').set('Authorization', `Bearer ${AUTH}`).expect(200);
    expect(hits.body.results.map((r: { messageId: number }) => r.messageId)).toEqual([2001]);
    const ctx = await request(app).get('/topic/context/141469?recent=10').set('Authorization', `Bearer ${AUTH}`).expect(200);
    expect(ctx.body.recentMessages.map((m: { messageId: number }) => m.messageId)).toEqual([2000, 2001, 2002, 2003, 2004]);
    await shutdown();
  });

  it('survives a restart and a destructive rebuild, and never writes the live log', async () => {
    const app = await boot();
    const before = await request(app).get('/topic/context/141469?recent=10').set('Authorization', `Bearer ${AUTH}`).expect(200);
    expect(before.body.totalMessages).toBe(5);
    const rebuilt = await request(app).post('/topic/rebuild').set('Authorization', `Bearer ${AUTH}`).expect(200);
    expect(rebuilt.body).toMatchObject({ rebuilt: true, restored: 6 });
    const after = await request(app).get('/topic/context/141469?recent=10').set('Authorization', `Bearer ${AUTH}`).expect(200);
    expect(after.body.recentMessages.map((m: { messageId: number }) => m.messageId)).toEqual([2000, 2001, 2002, 2003, 2004]);
    expect(topicMemory.lastMessageIdByRow(141469)).toBe(2004);
    expect((await request(app).get('/topic/search?topic=141133&q=heron').set('Authorization', `Bearer ${AUTH}`)).body.totalResults).toBe(1);
    expect(fs.readFileSync(liveLog, 'utf-8')).toBe(liveLogBefore);
    await shutdown();
  });
});
