/**
 * Feature-is-alive proof for custom project apps (docs/specs/project-apps-sandbox.md §8 E2E): an
 * AgentServer booted on its production path with custom apps on, a REAL ProjectAppCustomSource (the
 * shared harness: real record/blob schemas, a real WorkBoardService, a real key file and disk store)
 * and the real ProjectAppSandbox, injected the way `src/commands/server.ts` injects them:
 *   POST /project-apps → PUT source → the version card is on the Work Board, marked phone-only, and a
 *   console (PIN) Approve is refused → GET /project-apps/<id>/frame without a ticket is refused;
 * then "Stop this app" leaves the card saying it was stopped, out of Needs you;
 * and with custom apps off every custom route answers 503.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ProjectAppSandbox } from '../../src/server/ProjectAppSandbox.js';
import { resolveWorkBoardSettings } from '../../src/core/WorkBoardService.js';
import { makeHarness, phoneApprove, PROJECT, CONVERGED_SPEC } from '../helpers/projectAppCustomHarness.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { WorkBoardRuntime } from '../../src/core/WorkBoardRuntime.js';
import type { InstarConfig } from '../../src/core/types.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/project-apps-custom-alive.test.ts' });
});

const TOKEN = 'e2e-custom-token';
const PIN = '246810';
const HTML = '<!doctype html><title>Pipeline</title><p>ten made-up deals</p>';

function boot(customOn: boolean) {
  const h = makeHarness({ dirs });
  const sandbox = new ProjectAppSandbox({ source: h.source, hmacSecret: () => h.source.hmacSecret() });
  const stateDir = h.stateDir;
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const config = {
    projectName: 'project-apps-custom-e2e', projectDir: h.dir, stateDir, port: 0, authToken: TOKEN, dashboardPin: PIN, developmentAgent: true,
    projectApps: { enabled: true, custom: { enabled: customOn } }, workBoard: { enabled: true },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  // The Work Board runtime's route-facing surface over the harness's REAL WorkBoardService (the
  // conversation and pickup plumbing is not part of this proof).
  const workBoard = {
    svc: h.svc, controller: null, settings: () => resolveWorkBoardSettings({}),
    appendLine: () => {}, ensureConversation: () => {}, removeConversation: () => {},
    conversationAvailable: () => false,
    hiddenConversationKeys: () => h.svc.hiddenConversationKeys(),
    behind: () => null, lastWrittenOn: () => null, repliedAfterQuestion: () => false, brokenAttachments: () => [],
    when: (iso: string) => iso, notePolicyChange: async () => {}, holdsLease: () => true, saveSettingsPatch: () => false,
  } satisfies Omit<Partial<WorkBoardRuntime>, 'controller'>
    & Pick<WorkBoardRuntime, 'svc' | 'conversationAvailable' | 'hiddenConversationKeys'>
    & { controller: null };
  const sessionManager = createMockSessionManager();
  const server = new AgentServer({
    config, sessionManager: sessionManager as unknown as SessionManager, state: new StateManager(stateDir),
    projectAppCustom: () => h.source, projectAppSandbox: () => sandbox,
    workBoard: () => workBoard as unknown as WorkBoardRuntime,
  });
  servers.push(server);
  return { app: server.getApp(), h };
}

const agent = (r: request.Test) => r.set('Authorization', `Bearer ${TOKEN}`).set('X-Instar-AgentId', 'project-apps-custom-e2e');

describe('custom project apps — production wiring', () => {
  it('create → write source → a phone-only version card; a console Approve is refused; the frame needs a ticket', async () => {
    const { app, h } = boot(true);

    expect((await request(app).post('/project-apps').send({})).status).toBe(401);
    const created = await agent(request(app).post('/project-apps')).send({ conversationKey: PROJECT, title: 'Sales pipeline', specPath: CONVERGED_SPEC });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const appId = created.body.appId as string;
    expect(appId).toMatch(/^pa_[0-9a-f]{16}$/);

    const wrote = await agent(request(app).put(`/project-apps/${appId}/source`)).send({ html: HTML, note: 'First version: ten made-up deals.' });
    expect(wrote.status, JSON.stringify(wrote.body)).toBe(200);

    const ids = h.svc.cardIds().filter((id) => h.source.isVersionCard(id));
    expect(ids.length).toBe(1);
    const card = await agent(request(app).get(`/work-board/cards/${encodeURIComponent(ids[0])}`));
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    expect(card.body.card).toMatchObject({ phoneOnly: true, agentInternal: false, conversationAvailable: false });
    expect(card.body.card.status).toBe('needs-approval');

    const pinTap = await agent(request(app).post(`/work-board/cards/${encodeURIComponent(ids[0])}/tap`)).send({ action: 'approve', materialHash: card.body.card.materialHash, titleHash: card.body.card.titleHash, pin: PIN });
    expect(pinTap.status).toBe(403);
    expect(pinTap.body.error).toBe('phone-only-card');
    expect(card.body.card.needLine).toBe('Approve this version on your phone to run it');
    expect(card.body.card.outward).toBe(false);

    // The owner's phone approve serves it; the holder's settle finishes the card.
    expect(phoneApprove(h, ids[0])).toMatchObject({ ok: true });
    expect(h.source.settleApprovedCards()).toEqual({ closed: [ids[0]], refused: [] });
    const done = await agent(request(app).get(`/work-board/cards/${encodeURIComponent(ids[0])}`));
    expect(done.body.card).toMatchObject({ status: 'done', lane: 'done', needLine: 'Approved on your phone; this version is running' });

    // "Stop this app" (console withdraw): the card says it was stopped, leaves Needs you, and nothing
    // on it can run the app again in this build (turning it back on is stage 2, CMT-1882).
    const stop = await agent(request(app).post(`/work-board/cards/${encodeURIComponent(ids[0])}/tap`)).send({ action: 'withdraw-approval', titleHash: done.body.card.titleHash, pin: PIN });
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    h.source.invalidate();
    const stopped = await agent(request(app).get(`/work-board/cards/${encodeURIComponent(ids[0])}`));
    expect(stopped.body.card).toMatchObject({ appStopped: true, lane: 'done', needLine: 'Stopped by you. Turning it back on comes in a later update.' });
    const board = await agent(request(app).get('/work-board'));
    expect(board.status, JSON.stringify(board.body).slice(0, 400)).toBe(200);
    expect(board.body.waitingOnYou).toBe(0);
    expect((await agent(request(app).post(`/project-apps/${appId}/ticket`)).send({})).body).toMatchObject({ state: 'disabled' });

    const list = await agent(request(app).get('/project-apps'));
    expect(list.status).toBe(200);
    expect(list.body.apps.map((a: { appId: string }) => a.appId)).toEqual([appId]);

    const frame = await request(app).get(`/project-apps/${appId}/frame`).set('Sec-Fetch-Dest', 'iframe');
    expect(frame.status).toBeGreaterThanOrEqual(400);
    expect(frame.text).not.toContain('ten made-up deals');
    const withBearer = await agent(request(app).get(`/project-apps/${appId}/frame`)).set('Sec-Fetch-Dest', 'iframe');
    expect(withBearer.status).toBeGreaterThanOrEqual(400);
    expect(withBearer.text).not.toContain('ten made-up deals');
  });

  it('answers 503 on every custom route when custom apps are off', async () => {
    const { app } = boot(false);
    const id = 'pa_0123456789abcdef';
    expect((await agent(request(app).get('/project-apps'))).status).toBe(503);
    expect((await agent(request(app).post('/project-apps')).send({ conversationKey: PROJECT, title: 'x', specPath: CONVERGED_SPEC })).status).toBe(503);
    expect((await agent(request(app).put(`/project-apps/${id}/source`)).send({ html: HTML })).status).toBe(503);
    expect((await agent(request(app).post(`/project-apps/${id}/ticket`)).send({})).status).toBe(503);
    expect((await request(app).get(`/project-apps/${id}/frame?t=x`).set('Sec-Fetch-Dest', 'iframe')).status).toBe(503);
    expect((await request(app).get(`/project-apps/${id}/api/data`)).status).toBe(503);
  });
});
