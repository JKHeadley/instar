/** Production AgentServer wiring: HTTP (app) and WebSocket (dashboard) must
 * name the same persisted conversation with no live messaging adapter.
 * No Claude/Codex/tmux process is launched. */
import { it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig, Session } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

it('app HTTP and dashboard WebSocket retain the durable title across a server restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-presentation-e2e-'));
  const stateDir = path.join(dir, '.instar');
  const authToken = 'session-presentation-test';
  const state = new StateManager(stateDir);
  const session: Session = { id: 'persisted', name: 'echo-topic-42', tmuxSession: 'original', telegramTopicId: 42, status: 'running', startedAt: new Date().toISOString() };
  state.saveSession(session);
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'presentation', agentName: 'Presentation' }));
  // The durable name belongs to the TOPIC, not its current/replacement session.
  fs.writeFileSync(path.join(stateDir, 'topic-session-registry.json'), JSON.stringify({ topicToSession: { 42: 'replacement' }, topicToName: { 42: 'Build the app' } }));
  const config = {
    projectName: 'presentation', projectDir: dir, stateDir, port: 0, authToken,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
  let server: AgentServer | null = null;
  let socket: WebSocket | null = null;
  try {
    for (const title of ['Build the app', 'Renamed conversation']) {
      fs.writeFileSync(path.join(stateDir, 'topic-session-registry.json'), JSON.stringify({ topicToName: { 42: title } }));
      server = new AgentServer({ config, state: new StateManager(stateDir), sessionManager: {
        listRunningSessions: () => [session], getSession: () => null, captureOutput: () => '',
      } as never });
      await server.start();
      const http = await request(server.getApp()).get('/sessions').set('Authorization', `Bearer ${authToken}`);
      expect(http.status).toBe(200);
      expect(http.body[0]).toMatchObject({ name: title, platformName: title, platform: 'telegram' });
      const address = (server as unknown as { server: { address: () => { port: number } } }).server.address();
      const rows = await new Promise<Array<{ name: string; platformName: string; platform: string }>>((resolve, reject) => {
        socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=${authToken}`);
        socket.on('error', reject);
        socket.on('message', raw => {
          const message = JSON.parse(String(raw));
          if (message.type === 'sessions') resolve(message.sessions);
        });
      });
      expect(rows[0]).toMatchObject({ name: title, platformName: title, platform: 'telegram' });
      socket!.terminate(); socket = null;
      await server.stop(); server = null;
    }
  } finally {
    socket?.terminate();
    await server?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'session-presentation-e2e-cleanup' });
  }
});
