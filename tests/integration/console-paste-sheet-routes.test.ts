// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration — the console paste sheet against the real /pastes routes.
 * The exact body paste-model.js builds (pasteBody) is POSTed through the real
 * createRoutes() behind the real authMiddleware with a real PasteManager; the server's
 * answer is read back through pasteResultWords / buildRecent / deleteResultWords, so the
 * page and the routes cannot drift apart:
 *   - a named running session → delivered, and the notification reaches that session
 *   - a named session that is not running (or "the next session") → waiting
 *   - GET /pastes → the Recent list in words; DELETE once → Deleted, twice → Already gone
 *   - 401 without the bearer token; 503 with no paste system → "switched off" words
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { PasteManager } from '../../src/paste/PasteManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  pasteTargets, pasteBody, pasteResultWords, buildRecent, deleteResultWords,
} from '../../dashboard/console/paste-model.js';

const AUTH = 'test-console-paste';

describe('console paste sheet → /pastes (integration)', () => {
  let tmp: string;
  let injected: Array<{ session: string; text: string }>;
  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  function appWith(pasteManager: PasteManager | null, running: Array<{ name: string; jobSlug?: string }>) {
    const stateDir = path.join(tmp, '.instar');
    const ctx = {
      config: { projectName: 'paste-test', projectDir: tmp, stateDir, port: 0, authToken: AUTH, sessions: {} as any, scheduler: {} as any, monitoring: {} } as any,
      sessionManager: {
        listRunningSessions: () => running,
        getCachedRunningSessions: () => ({ sessions: running }),
        injectPasteNotification: (session: string, text: string) => { injected.push({ session, text }); },
      } as any,
      pasteManager,
      state: { getJobState: () => null, getSession: () => null } as any,
      scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null, updateChecker: null, autoUpdater: null,
      autoDispatcher: null, quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null, startTime: new Date(),
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json({ limit: '12mb' }));
    app.use(authMiddleware(AUTH));
    app.use('/', createRoutes(ctx));
    return app;
  }
  const pm = () => {
    const stateDir = path.join(tmp, '.instar');
    return new PasteManager({ pasteDir: path.join(stateDir, 'paste'), stateDir, projectDir: tmp });
  };
  const row = (name: string, title: string, remote = false) => ({ key: name, title, session: { tmuxSession: name, name, remote, type: 'interactive', machineNickname: remote ? 'Mac Mini' : 'Mac Studio', telemetry: { lastActivity: new Date().toISOString() } } });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-paste-'));
    fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true });
    injected = [];
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/console-paste-sheet-routes.test.ts' }); });

  it('401 without the bearer token', async () => {
    const res = await request(appWith(pm(), [])).post('/pastes').send({ content: 'x' });
    expect(res.status).toBe(401);
  });

  it('a send to a running session is delivered to that session, and the words name it', async () => {
    const app = appWith(pm(), [{ name: 'echo-fix' }, { name: 'other' }]);
    const t = pasteTargets([row('echo-fix', 'Bug: login loop'), row('other', 'Release notes')]);
    const req = pasteBody({ text: 'x'.repeat(400), label: 'build log', choice: t.choices.find((c: { value: string }) => c.value === 'echo-fix') });
    expect(req.ok).toBe(true);
    const res = await request(app).post('/pastes').set(auth()).send(req.body);
    expect(res.status).toBe(201);
    const w = pasteResultWords(res.status, res.body, { titleOf: (n: string) => (n === 'echo-fix' ? 'Bug: login loop' : null) });
    expect(w).toMatchObject({ state: 'delivered', text: 'Delivered 400 characters to Bug: login loop.' });
    expect(injected.map((i) => i.session)).toEqual(['echo-fix']);
  });

  it('a session that stopped, or "the next session" with nothing running, waits', async () => {
    const gone = appWith(pm(), [{ name: 'someone-else' }]);
    const t = pasteTargets([row('echo-fix', 'Bug: login loop')]);
    const res = await request(gone).post('/pastes').set(auth()).send(pasteBody({ text: 'abc', label: '', choice: t.choices[0] }).body);
    expect(res.status).toBe(201);
    expect(pasteResultWords(res.status, res.body).state).toBe('waiting');
    expect(injected).toEqual([]);
    const none = appWith(pm(), []);
    const next = pasteTargets([row('r', 'Remote', true)]);
    expect(next.choices[0].kind).toBe('next');
    const body = pasteBody({ text: 'abc', label: '', choice: next.choices[0] }).body;
    expect(body).toEqual({ content: 'abc' });
    const res2 = await request(none).post('/pastes').set(auth()).send(body);
    expect(pasteResultWords(res2.status, res2.body).state).toBe('waiting');
  });

  it('Recent lists what was sent; delete once is Deleted, twice Already gone', async () => {
    const app = appWith(pm(), [{ name: 'echo-fix' }]);
    const sent = await request(app).post('/pastes').set(auth()).send({ content: 'hello', label: 'note', targetSession: 'echo-fix' });
    const list = await request(app).get('/pastes').set(auth());
    const m = buildRecent({ ok: list.status === 200, data: list.body });
    expect(m.ok).toBe(true);
    expect(m.rows[0]).toMatchObject({ id: sent.body.pasteId, title: 'note', status: 'delivered' });
    const del = await request(app).delete(`/pastes/${encodeURIComponent(sent.body.pasteId)}`).set(auth());
    expect(deleteResultWords(del.status, del.body)).toEqual({ ok: true, text: 'Deleted.' });
    const again = await request(app).delete(`/pastes/${encodeURIComponent(sent.body.pasteId)}`).set(auth());
    expect(deleteResultWords(again.status, again.body)).toMatchObject({ ok: true, gone: true });
  });

  it('no paste system: 503, said as switched off', async () => {
    const res = await request(appWith(null, [])).post('/pastes').set(auth()).send({ content: 'x' });
    expect(res.status).toBe(503);
    expect(pasteResultWords(res.status, res.body).text).toMatch(/switched off on this agent/);
  });
});
