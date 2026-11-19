/**
 * Feature-is-alive proof for bringing Claude and ChatGPT history into Instar
 * (docs/specs/import-from-claude-chatgpt.md): an AgentServer booted on its production path mounts the
 * imported-history routes (200, not 404/503); the agent previews and applies a ChatGPT export; the
 * owner's dashboard unlock reads the chat raw; the agent's search gets it quoted as history; and the
 * history lives in this agent's own state folder only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { makeZip } from '../helpers/exportZip.js';
import type { InstarConfig } from '../../src/core/types.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/imported-history-alive.test.ts' });
});

function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'imported-history-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const config = {
    projectName: 'imported-history-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', dashboardPin: '246810', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir) } as any);
  servers.push(server);
  return { app: server.getApp(), dir, stateDir };
}

describe('imported history — production wiring', () => {
  it('previews, applies, lists, reads raw for the owner and quoted for the agent', async () => {
    const { app, dir, stateDir } = boot();
    const auth = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'imported-history-e2e');
    const zip = path.join(dir, 'chatgpt-export.zip');
    fs.writeFileSync(zip, makeZip([
      { name: 'chat.html', data: '<html></html>' },
      { name: 'conversations.json', deflate: true, data: JSON.stringify([{
        conversation_id: 'g-1', title: 'Recipe ideas', create_time: 1740823200, current_node: 'a1',
        mapping: {
          root: { id: 'root', parent: null, children: ['u1'], message: null },
          u1: { id: 'u1', parent: 'root', children: ['a1'], message: { id: 'u1', author: { role: 'user' }, content: { parts: ['Something with lentils?'] }, create_time: 1740823260 } },
          a1: { id: 'a1', parent: 'u1', children: [], message: { id: 'a1', author: { role: 'assistant' }, content: { parts: ['Lentil soup.'] }, create_time: 1740823290 } },
        },
      }]) },
    ]));

    const list0 = await auth(request(app).get('/imported-history/conversations'));
    expect(list0.status).toBe(200);
    expect(list0.body.conversations).toEqual([]);

    const pv = await auth(request(app).post('/imported-history/preview')).send({ path: zip });
    expect(pv.status).toBe(200);
    expect(pv.body.preview).toMatchObject({ from: 'chatgpt', chats: 1, messages: 2 });
    const ap = await auth(request(app).post('/imported-history/apply')).send({ previewId: pv.body.previewId });
    expect(ap.status).toBe(200);
    expect(ap.body.result).toMatchObject({ chatsAdded: 1, messagesAdded: 2 });
    expect(fs.existsSync(path.join(stateDir, 'imported-history', 'manifest.json'))).toBe(true);

    const unlock = await request(app).post('/dashboard/unlock').send({ pin: '246810' });
    const session = unlock.body.operatorSessionToken as string;
    expect(typeof session).toBe('string');
    const ref = encodeURIComponent('imported:chatgpt:g-1');
    const raw = await auth(request(app).get(`/imported-history/conversations/${ref}`)).set('x-instar-operator-session', session);
    expect(raw.body.messages.map((m: { text: string }) => m.text)).toEqual(['Something with lentils?', 'Lentil soup.']);

    const found = await auth(request(app).get('/imported-history/search').query({ q: 'lentil' }));
    expect(found.status).toBe(200);
    expect(found.body.results[0].quoted).toMatch(/^<imported-history from="chatgpt" title="Recipe ideas"/);
  });
});
