import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authMiddleware } from '../../src/server/middleware.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('installed commitment job history request', () => {
  const url = '/telegram/search?recent=1&limit=100';
  const headers = { authorization: 'Bearer fixture', 'x-instar-agentid': 'test' };
  let stateDir: string;
  let memory: TopicMemory;
  let app: express.Express;

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-read-'));
    memory = new TopicMemory(stateDir);
    await memory.open();
    app = express();
    app.use(authMiddleware('fixture', 'test'));
    app.use(createRoutes({
      config: { projectName: 'test', stateDir, projectDir: stateDir, sessions: {}, scheduler: {} },
      state: {}, sessionManager: {}, topicMemory: memory, startTime: new Date(),
    } as unknown as RouteContext));
  });

  afterEach(() => {
    memory.close();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'commitment history fixture' });
  });

  it('serves the latest 100 local Telegram rows across topics without a JSONL', async () => {
    for (let id = 1; id <= 102; id++) {
      memory.insertMessage({ messageId: id, topicId: id % 2 + 1, text: 'request', fromUser: true,
        timestamp: '2026-11-25T12:00:00Z', sessionName: null });
    }
    memory.insertMessage({ messageId: 999, topicId: -42, text: 'Slack', fromUser: true,
      timestamp: '2026-11-25T12:00:00Z', sessionName: null });
    expect((await request(app).get(url)).status).toBe(401);
    const res = await request(app).get(url).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(100);
    expect(res.body.results.map((row: { messageId: number }) => row.messageId))
      .toEqual(Array.from({ length: 100 }, (_, i) => i + 3));
  });

  it('distinguishes idle, unavailable, and readable legacy history', async () => {
    expect(await request(app).get(url).set(headers)).toMatchObject({ status: 200, body: { results: [], count: 0 } });
    memory.close();
    const failed = await request(app).get(url).set(headers);
    expect(failed.status).toBe(503);
    expect(failed.body.reason).toContain('TopicMemory is closed');
    const row = { messageId: 7, topicId: 2, text: 'status', fromUser: false, provenance: 'automation' };
    fs.writeFileSync(path.join(stateDir, 'telegram-messages.jsonl'), JSON.stringify(row));
    expect(await request(app).get(url).set(headers)).toMatchObject({ status: 200, body: { results: [row], count: 1 } });
  });
});
