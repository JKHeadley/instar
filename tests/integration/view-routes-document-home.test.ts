/**
 * The old-link guarantee's per-caller rule through the real /view routes (instar-document-viewer
 * §3.9b item 3): with documents replacing pages, a session whose place can hold a document is
 * refused a page, a session whose place can't (Slack) still gets one, and system sessions count as
 * the agent itself. The session record is set the way the memory-session middleware sets it.
 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoutes } from '../../src/server/routes.js';
import { PrivateViewer } from '../../src/publishing/PrivateViewer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/view-routes-document-home.test.ts' }); });

function app(session: { placeKey: string | null; audience: string } | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'view-home-')); dirs.push(dir);
  const viewer = new PrivateViewer({ viewsDir: path.join(dir, 'views') });
  const old = viewer.create('Old', '# old');
  viewer.setNewViewGuard(() => true);
  const a = express();
  a.use(express.json());
  if (session) a.use((_req, res, next) => { res.locals.memorySession = { sessionId: 's', placeKey: session.placeKey, audience: { kind: session.audience } }; next(); });
  const ctx: any = {
    config: { authToken: 'test', stateDir: dir, port: 0, projectName: 'test', projectDir: dir },
    viewer, documentsReplaceViews: () => true,
  };
  a.use(createRoutes(ctx));
  return { a, viewer, old };
}

describe('/view while documents replace pages, by caller', () => {
  it('the bearer token (the agent itself) is refused a page', async () => {
    const { a } = app(null);
    expect((await request(a).post('/view').send({ title: 'T', markdown: 'M' })).status).toBe(409);
  });

  it('a session in a confined Telegram topic, a Telegram group, or an app conversation is refused', async () => {
    for (const placeKey of ['telegram:topic:500', 'telegram:-1001234567890', 'app:11111111-1111-4111-8111-111111111111']) {
      for (const audience of ['place', 'person']) {
        const { a } = app({ placeKey, audience });
        const r = await request(a).post('/view').send({ title: 'T', markdown: 'M' });
        expect(r.status, `${placeKey} ${audience}`).toBe(409);
      }
    }
  });

  it('a system session (scheduler, lifeline, agent-to-agent) counts as the agent itself and is refused', async () => {
    const { a } = app({ placeKey: null, audience: 'system' });
    expect((await request(a).post('/view').send({ title: 'T', markdown: 'M' })).status).toBe(409);
  });

  it('a session in a Slack channel keeps pages: POST makes one, PUT rewrites its own', async () => {
    const { a, old } = app({ placeKey: 'slack:C123', audience: 'place' });
    const made = await request(a).post('/view').send({ title: 'Slack page', markdown: '# s' });
    expect(made.status).toBe(201);
    expect((await request(a).put(`/view/${old.id}`).send({ title: 'Edited', markdown: '# e' })).status).toBe(200);
  });

  it('PUT on an unknown page answers 404 before the guarantee', async () => {
    const { a } = app(null);
    expect((await request(a).put('/view/11111111-1111-4111-8111-111111111111').send({ title: 'T', markdown: 'M' })).status).toBe(404);
  });
});
