import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { expect, it } from 'vitest';
import { SessionManager } from '../../src/core/SessionManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createTempProject } from '../helpers/setup.js';

it('keeps the commitment job’s authenticated Telegram history available after restart without a flat log', async () => {
  const project = createTempProject();
  const manager = new SessionManager({
    tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/echo',
    projectDir: project.dir, maxSessions: 2, protectedSessions: [], completionPatterns: [],
  }, project.state);
  const config = {
    projectName: 'commitment-lifecycle', projectDir: project.dir, stateDir: project.stateDir,
    port: 0, authToken: 'fixture', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 2, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const endpoint = '/telegram/search?recent=1&limit=100';
  const headers = { Authorization: 'Bearer fixture', 'X-Instar-AgentId': config.projectName };
  let memory = new TopicMemory(project.stateDir);
  let server: AgentServer | undefined;
  try {
    await memory.open();
    server = new AgentServer({ config, state: project.state, sessionManager: manager, topicMemory: memory });
    memory.insertMessage({ messageId: 701, topicId: 20, text: 'Please send the report tomorrow.',
      fromUser: true, provenance: 'user', timestamp: '2026-11-25T18:00:00Z', sessionName: null });
    expect((await request(server.getApp()).get(endpoint).set(headers)).status).toBe(200);
    await server.stop();
    server = undefined;
    memory.close();
    expect(fs.existsSync(path.join(project.stateDir, 'telegram-messages.jsonl'))).toBe(false);

    memory = new TopicMemory(project.stateDir);
    await memory.open();
    server = new AgentServer({ config, state: project.state, sessionManager: manager, topicMemory: memory });
    const response = await request(server.getApp()).get(endpoint).set(headers);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ count: 1, results: [
      { messageId: 701, topicId: 20, text: 'Please send the report tomorrow.', provenance: 'user' },
    ] });
  } finally {
    await server?.stop();
    memory.close();
    manager.stopMonitoring();
    project.cleanup();
  }
});
