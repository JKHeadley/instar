/**
 * Project apps part 2 — the agent's custom-app routes and the full approval path over HTTP
 * (docs/specs/project-apps-sandbox.md §3.1, §3.4, §3.6-3.7, §8 integration), through the production
 * authMiddleware, the real Work Board routes (with the phone-only card check), the real
 * ProjectAppCustomSource (in-memory journals, real key file and disk store) and the real sandbox:
 *   - create refusals (Bearer only, unbound project, unconverged spec, too many apps);
 *   - a source write opens exactly ONE version card (and one notice);
 *   - a console (PIN) Approve on that card → 403 "Approve this on your phone"; withdraw-approval is taken;
 *   - the agent cannot edit the server-owned card;
 *   - a PIN-proof approve record never serves; an owner phone-presence approve serves the html;
 *   - the narrow key then reads and writes the app's data;
 *   - after "Stop this app" the card says it was stopped, leaves Needs-you, and a phone approve is
 *     refused (turning it back on is stage 2, CMT-1882).
 */
import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { createMandatePinCheck } from '../../src/server/mandatePin.js';
import { registerWorkBoardRoutes, performOwnerTap, type WorkBoardRouteDeps } from '../../src/server/workBoardRoutes.js';
import { mountProjectAppCustomRoutes } from '../../src/server/projectAppCustomRoutes.js';
import { mountProjectAppSandboxRoutes } from '../../src/server/projectAppSandboxRoutes.js';
import { ProjectAppSandbox } from '../../src/server/ProjectAppSandbox.js';
import { ProjectAppsRuntime, customAppRow } from '../../src/server/ProjectAppsRuntime.js';
import { mountProjectsRoutes } from '../../src/server/workProjectsRoutes.js';
import { projectAppRecordStoreSchema, type UnionEntry } from '../../src/core/ProjectAppStore.js';
import { resolveWorkBoardSettings } from '../../src/core/WorkBoardService.js';
import { versionCardId } from '../../src/core/ProjectAppCustomFold.js';
import { sha256Hex } from '../../src/core/WorkCardStore.js';
import { makeHarness, phoneApprove, PROJECT, CONVERGED_SPEC, DRAFT_SPEC, OWNER } from '../helpers/projectAppCustomHarness.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/project-app-custom-routes.test.ts' }); });

const TOKEN = 'pa-custom-token';
const PIN = '135791';
const HTML = '<!doctype html><title>Pipeline</title><p>ten made-up deals</p>';

function boot(opts: { maxApps?: number; enabled?: boolean } = {}) {
  const h = makeHarness({ dirs, ...(opts.maxApps ? { limits: { maxApps: opts.maxApps } } : {}) });
  const sandbox = new ProjectAppSandbox({ source: h.source, hmacSecret: () => h.source.hmacSecret() });
  const requirePin = createMandatePinCheck({ dashboardPin: () => PIN });
  const settings = resolveWorkBoardSettings({});
  const wbDeps: WorkBoardRouteDeps = {
    enabled: () => true, svc: () => h.svc, controller: () => null, settings: () => settings,
    caller: () => ({ kind: 'bearer' }), ownerPersonKey: () => OWNER,
    requirePin: (req, res, message) => requirePin(req, res, { message }),
    displayName: (k) => k, appendLine: async () => {}, ensureConversation: async () => {}, removeConversation: async () => {},
    behind: () => null, lastWrittenOn: () => null, repliedAfterQuestion: () => false, brokenAttachments: () => [], when: (iso) => iso,
    saveSettings: () => true,
    phoneOnlyCard: (cardId) => h.source.isVersionCard(cardId),
    exposeBoardRead: (read) => { boardRead = read; },
  };
  let boardRead: Parameters<NonNullable<WorkBoardRouteDeps['exposeBoardRead']>>[0] | null = null;
  // The Work projects read with a REAL ProjectAppsRuntime whose custom apps come from the real source,
  // through the same customAppRow server.ts uses.
  const paUnion: UnionEntry[] = [];
  let t = 1_700_000_000_000;
  const runtime = new ProjectAppsRuntime({
    emit: (_k, build) => {
      const data = build({ physical: t++, logical: 0, node: 'm_self' }, 'm_self');
      if (!data || !projectAppRecordStoreSchema.validate(data, { countDroppedField() {}, countJailReject() {} } as never)) return { outcome: 'dropped:invalid' };
      paUnion.push({ data, origin: 'm_self' });
      return { outcome: 'emitted' };
    },
    loadUnion: () => paUnion, now: () => t, machineId: 'm_self',
    isActingMachine: () => false, holdsLease: () => true, projectKeys: () => [PROJECT], publicBase: () => null, platformFor: () => null,
    builtinSummary: () => ({ state: 'pending' }), builtinAvailable: () => true,
    customApp: (appRef) => customAppRow(h.source, appRef),
  });
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(authMiddleware(() => TOKEN, 'pa-int'));
  const router = express.Router();
  registerWorkBoardRoutes(router, wbDeps);
  const projectsRoute = mountProjectsRoutes(router, {
    projects: () => [{ conversationKey: PROJECT, title: 'Example: sales pipeline', goal: 'Sell', lastVerdict: null, lastCheckAt: null, parked: false, doneDefinition: [], doneItems: null }],
    boardFor: (req) => (boardRead ? boardRead(req, { full: true }) : null),
    bearerOk: (req) => req.headers.authorization === `Bearer ${TOKEN}`,
    appsFor: (key) => runtime.view(key),
  });
  mountProjectAppCustomRoutes(router, { source: () => h.source, enabled: () => opts.enabled !== false, bearerOk: (req) => req.headers.authorization === `Bearer ${TOKEN}` });
  mountProjectAppSandboxRoutes(router, { sandbox: () => sandbox, enabled: () => opts.enabled !== false, origin: { knownHttpsHosts: () => [] } });
  app.use(router);
  return { app, h, sandbox, wbDeps, runtime, projectsRoute };
}

const agent = (r: request.Test) => r.set('Authorization', `Bearer ${TOKEN}`).set('X-Instar-AgentId', 'pa-int');

async function createApp(app: express.Express) {
  const r = await agent(request(app).post('/project-apps')).send({ conversationKey: PROJECT, title: 'Sales pipeline', specPath: CONVERGED_SPEC });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.appId as string;
}

describe('POST /project-apps — create refusals', () => {
  it('needs the Bearer; refuses an unbound project, an unconverged spec and an eleventh app', async () => {
    const { app } = boot({ maxApps: 1 });
    expect((await request(app).post('/project-apps').send({})).status).toBe(401);
    expect((await agent(request(app).post('/project-apps')).send({ conversationKey: 'telegram:9', title: 'x', specPath: CONVERGED_SPEC })).body).toMatchObject({ error: 'unknown-project' });
    const spec = await agent(request(app).post('/project-apps')).send({ conversationKey: PROJECT, title: 'x', specPath: DRAFT_SPEC });
    expect(spec.status).toBe(409);
    expect(spec.body.error).toBe('app-spec-not-converged');
    const appId = await createApp(app);
    expect(appId).toMatch(/^pa_[0-9a-f]{16}$/);
    const more = await agent(request(app).post('/project-apps')).send({ conversationKey: PROJECT, title: 'Second', specPath: CONVERGED_SPEC });
    expect(more.status).toBe(409);
    expect(more.body.error).toBe('too-many-apps');
  });

  it('answers 503 when custom apps are off', async () => {
    const { app } = boot({ enabled: false });
    expect((await agent(request(app).post('/project-apps')).send({})).status).toBe(503);
    expect((await agent(request(app).put('/project-apps/pa_0123456789abcdef/source')).send({ html: '<p>x</p>' })).status).toBe(503);
  });
});

describe('PUT /project-apps/:appId/source → the version card → the owner\'s phone', () => {
  it('opens exactly one card, refuses console approval, serves only after a phone-presence approve, and the key then reaches the data', async () => {
    const { app, h } = boot();
    const appId = await createApp(app);
    const cardId = versionCardId(appId, 'serve');

    const w = await agent(request(app).put(`/project-apps/${appId}/source`)).send({ html: HTML, note: 'First version' });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body.card).toEqual({ state: 'opened', cardId });
    expect(h.svc.cardIds()).toEqual([cardId]);
    expect(h.notices).toHaveLength(1);
    // A second save of the same content opens nothing more.
    const again = await agent(request(app).put(`/project-apps/${appId}/source`)).send({ html: HTML, note: 'again' });
    expect(again.body.card.state).toBe('none');
    expect(h.svc.cardIds()).toEqual([cardId]);
    expect(h.notices).toHaveLength(1);

    // The card as the routes show it: phone-only, the phone's words, nothing outward.
    const shown = await agent(request(app).get(`/work-board/cards/${cardId}`));
    expect(shown.status).toBe(200);
    expect(shown.body.card).toMatchObject({ phoneOnly: true, status: 'needs-approval', lane: 'waiting-on-you', needLine: 'Approve this version on your phone to run it', outward: false, outwardWords: null });

    // Not served yet: no ticket.
    expect((await agent(request(app).post(`/project-apps/${appId}/ticket`)).send({})).body).toMatchObject({ error: 'not-served', state: 'none' });

    // A console (PIN) Approve on the server-owned card → 403, even with the right PIN.
    const card = h.svc.view(cardId)!.card;
    const consoleTap = await agent(request(app).post(`/work-board/cards/${cardId}/tap`)).send({ action: 'approve', materialHash: card.materialHash, titleHash: sha256Hex(card.title), pin: PIN });
    expect(consoleTap.status).toBe(403);
    expect(consoleTap.body).toMatchObject({ error: 'phone-only-card', message: 'Approve this on your phone' });
    // The agent cannot edit the server-owned card.
    const edit = await agent(request(app).post(`/work-board/cards/${cardId}/records`)).send({ kind: 'edited', fields: { title: 'Run it anyway' } });
    expect(edit.status).toBe(403);
    expect(edit.body.error).toBe('server-owned-card');

    // A PIN-proof approve record (written past the route) never serves.
    phoneApprove(h, cardId, 'pin');
    expect((await agent(request(app).post(`/project-apps/${appId}/ticket`)).send({})).body).toMatchObject({ error: 'not-served' });

    // The owner's phone-presence approve (the Work Board phone route's principal) serves the html.
    expect(phoneApprove(h, cardId, 'presence')).toMatchObject({ ok: true });
    const t = await agent(request(app).post(`/project-apps/${appId}/ticket`)).send({});
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(t.body.meta).toMatchObject({ title: 'Sales pipeline', project: 'Example: sales pipeline' });
    const frame = await request(app).get(t.body.frameUrl).set('Sec-Fetch-Dest', 'iframe');
    expect(frame.status).toBe(200);
    expect(frame.text).toBe(HTML);
    expect(frame.headers['content-security-policy']).toContain('sandbox allow-scripts allow-forms');

    // The holder finishes the card (the commit observer's settle): done, off the owner's waiting lane.
    expect(h.source.settleApprovedCards()).toEqual({ closed: [cardId], refused: [] });
    const done = await agent(request(app).get(`/work-board/cards/${cardId}`));
    expect(done.body.card).toMatchObject({ status: 'done', lane: 'done', needLine: 'Approved on your phone; this version is running', done: true });
    const board = await agent(request(app).get('/work-board'));
    const waiting = (board.body.lanes as Array<{ lane: string; cards: Array<{ id: string }> }>).find((l) => l.lane === 'waiting-on-you')!;
    expect(waiting.cards.map((c) => c.id)).not.toContain(cardId);

    // The narrow key reads and writes the app's data (and is no Bearer anywhere else).
    const k = await agent(request(app).post(`/project-apps/${appId}/key`)).send({ contentSha: t.body.contentSha });
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    const key = k.body.key as string;
    const r0 = await request(app).get(`/project-apps/${appId}/api/data`).set('X-Project-App-Key', key);
    expect(r0.body).toEqual({ body: null, revision: null });
    const put = await request(app).put(`/project-apps/${appId}/api/data`).set('X-Project-App-Key', key).send({ body: { deals: 10 }, base: null });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const r1 = await request(app).get(`/project-apps/${appId}/api/data`).set('X-Project-App-Key', key);
    expect(r1.body).toEqual({ body: { deals: 10 }, revision: put.body.revision });
    const stale = await request(app).put(`/project-apps/${appId}/api/data`).set('X-Project-App-Key', key).send({ body: { deals: 0 }, base: null });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('conflict');
    const sum = await request(app).put(`/project-apps/${appId}/api/summary`).set('X-Project-App-Key', key).send({ headline: 'Ten deals open', counts: [{ label: 'Open', value: 10 }] });
    expect(sum.status, JSON.stringify(sum.body)).toBe(200);
    expect((await request(app).get(`/project-apps/${appId}/api/summary`).set('X-Project-App-Key', key)).body.summary).toMatchObject({ headline: 'Ten deals open' });
    expect((await request(app).get('/project-apps').set('Authorization', `Bearer ${key}`)).status).toBe(401);

    // Withdraw-approval is accepted from the console (it only stops the app), and revokes the key.
    const card2 = h.svc.view(cardId)!.card;
    const withdraw = await agent(request(app).post(`/work-board/cards/${cardId}/tap`)).send({ action: 'withdraw-approval', titleHash: sha256Hex(card2.title), pin: PIN });
    expect(withdraw.status, JSON.stringify(withdraw.body)).toBe(200);
    h.source.invalidate();
    expect((await request(app).get(`/project-apps/${appId}/api/data`).set('X-Project-App-Key', key)).status).toBe(401);
    expect((await agent(request(app).post(`/project-apps/${appId}/ticket`)).send({})).body).toMatchObject({ state: 'disabled' });
  });

  it('GET /project-apps lists the apps for the agent only', async () => {
    const { app } = boot();
    const appId = await createApp(app);
    const r = await agent(request(app).get('/project-apps'));
    expect(r.body.apps).toEqual([expect.objectContaining({ appId, appRef: `custom:${appId}`, title: 'Sales pipeline', served: 'none' })]);
  });
});

describe('"Stop this app" on a running custom app (no restart in this build)', () => {
  it('the card says it was stopped, leaves the waiting lane, and an approve on it is refused on the console and the phone', async () => {
    const { app, h, wbDeps } = boot();
    const appId = await createApp(app);
    const cardId = versionCardId(appId, 'serve');
    expect((await agent(request(app).put(`/project-apps/${appId}/source`)).send({ html: HTML, note: 'First version' })).status).toBe(200);
    expect(phoneApprove(h, cardId, 'presence')).toMatchObject({ ok: true });
    expect(h.source.settleApprovedCards().closed).toEqual([cardId]);

    const before = h.svc.view(cardId)!.card;
    const stop = await agent(request(app).post(`/work-board/cards/${cardId}/tap`)).send({ action: 'withdraw-approval', titleHash: sha256Hex(before.title), pin: PIN });
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    h.source.invalidate();
    expect((await agent(request(app).post(`/project-apps/${appId}/ticket`)).send({})).body).toMatchObject({ state: 'disabled' });

    // The card tells the truth and is not waiting on anyone.
    const shown = await agent(request(app).get(`/work-board/cards/${cardId}`));
    expect(shown.body.card).toMatchObject({ phoneOnly: true, appStopped: true, lane: 'done', needLine: 'Stopped by you. Turning it back on comes in a later update.' });
    const board = await agent(request(app).get('/work-board'));
    const waiting = (board.body.lanes as Array<{ lane: string; cards: Array<{ id: string }> }>).find((l) => l.lane === 'waiting-on-you')!;
    expect(waiting.cards.map((c) => c.id)).not.toContain(cardId);
    expect(board.body.waitingOnYou).toBe(0);
    expect(h.svc.waitingOnOwnerCount()).toBe(0);

    // A console Approve: refused as before (phone-only).
    const card = h.svc.view(cardId)!.card;
    const tapBody = { action: 'approve', materialHash: card.materialHash, titleHash: sha256Hex(card.title) };
    const consoleTap = await agent(request(app).post(`/work-board/cards/${cardId}/tap`)).send({ ...tapBody, pin: PIN });
    expect(consoleTap.status).toBe(403);
    // The phone's approve (the same shared tap path the phone route calls): refused in plain words, nothing recorded.
    const recordsBefore = h.svc.recordsOf(cardId).length;
    const phone = await performOwnerTap(wbDeps, h.svc, cardId, tapBody, { kind: 'person', personKey: OWNER, proof: 'presence', isOwner: true });
    expect(phone.status).toBe(409);
    expect(phone.body).toMatchObject({ error: 'app-stopped' });
    expect(String(phone.body.message)).toContain('turning it back on comes in a later update');
    expect(h.svc.recordsOf(cardId).length).toBe(recordsBefore);
    h.source.invalidate();
    // Still off, and the closer writes nothing that says "running".
    expect(h.source.settleApprovedCards()).toEqual({ closed: [], refused: [] });
    expect((await agent(request(app).post(`/project-apps/${appId}/ticket`)).send({})).body).toMatchObject({ state: 'disabled' });
    expect((await agent(request(app).get(`/work-board/cards/${cardId}`))).body.card.needLine).toBe('Stopped by you. Turning it back on comes in a later update.');
  });
});

describe('the Work row of a custom app says whether it runs', () => {
  it('not approved → "not-approved"; approved → "served" with counts folded past three; stopped → "off"', async () => {
    const { app, h, runtime, projectsRoute } = boot();
    const appId = await createApp(app);
    const ref = `custom:${appId}`;
    const cardId = versionCardId(appId, 'serve');
    expect(runtime.offer(PROJECT, ref, 'The pipeline reads better as a board.')).toEqual({ ok: true });
    expect(runtime.answer(PROJECT, ref, 'attach', { by: 'owner', via: 'console', principal: 'owner' })).toMatchObject({ ok: true });
    const row = async () => {
      projectsRoute.invalidate();
      const r = await agent(request(app).get('/work/projects'));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return (r.body.projects[0].apps as Array<Record<string, any>>).find((a) => a.appRef === ref)!;
    };

    expect((await agent(request(app).put(`/project-apps/${appId}/source`)).send({ html: HTML, note: 'v1' })).status).toBe(200);
    expect(await row()).toMatchObject({ state: 'not-approved', title: 'Sales pipeline' });

    expect(phoneApprove(h, cardId, 'presence')).toMatchObject({ ok: true });
    const t = await agent(request(app).post(`/project-apps/${appId}/ticket`)).send({});
    const key = (await agent(request(app).post(`/project-apps/${appId}/key`)).send({ contentSha: t.body.contentSha })).body.key as string;
    const counts = ['Lead', 'Qualified', 'Proposal', 'Won'].map((label, i) => ({ label, value: i + 1 }));
    expect((await request(app).put(`/project-apps/${appId}/api/summary`).set('X-Project-App-Key', key).send({ headline: '3 open deals worth $34,500', counts })).status).toBe(200);
    const served = await row();
    expect(served).toMatchObject({ state: 'served', openHref: `/dashboard/project-app/?app=${appId}`, summaryState: 'ok' });
    expect(served.summary).toMatchObject({ headline: '3 open deals worth $34,500', counts: counts.slice(0, 3), moreCounts: [{ label: 'Won', value: 4 }] });

    const card = h.svc.view(cardId)!.card;
    expect((await agent(request(app).post(`/work-board/cards/${cardId}/tap`)).send({ action: 'withdraw-approval', titleHash: sha256Hex(card.title), pin: PIN })).status).toBe(200);
    h.source.invalidate();
    expect(await row()).toMatchObject({ state: 'off' });
  });
});
