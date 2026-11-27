/**
 * Conversation groups from the owner's phone over HTTP (docs/specs/conversation-groups-phone.md), through the
 * production authMiddleware and the device authenticator with its route allowlist, a real MobilePairingService
 * and real device signatures:
 *
 *   A. the actual graph surface on the actual replicated runtime (two members, a witness):
 *      - suggestions: owner phone 200, another person's phone 403, the bearer 403;
 *      - Reject persists (never offered again; a later Accept is unknown);
 *      - Accept groups in ONE call: the group is created and named with real committed owner changes on both
 *        members, the suggestion is recorded accepted, and a repeat answers the same result;
 *      - the project draft needs a group with a conversation (plain-words 409), and is owner only.
 *   B. "make this group a project": the draft route returns a binding, and the confirm requires the existing
 *      Face ID proof (challenge + presence signature over `group-project-confirm <draftId> <draftHash>`):
 *      no proof, a wrong signature and a swapped hash are refused; the proven confirm writes ONE binding.
 *
 * Moving conversations into the group needs conversations in the certified source inventory, which this
 * fixture does not produce; the move, skip and front-door steps are covered against the owner-change
 * contract in tests/unit/conversation-graph-suggestion-accept.test.ts.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { setupGraphRuntimeFixture } from '../helpers/conversation-graph-runtime.js';
import { MobilePairingService, deviceAuthenticator } from '../../src/server/mobilePairingRoutes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { createConversationGraphSurface } from '../../src/server/ConversationGraphSurface.js';
import { createConversationGraphViewerResolver } from '../../src/server/conversationGraphViewer.js';
import { createConversationGroupProjectRouter, groupProjectConfirmPort } from '../../src/server/conversationGroupProjectRoutes.js';
import type { GroupProjectConfirmHolder } from '../../src/server/ConversationGroupProjectDrafts.js';
import { SUGGESTIONS_STATE_FILE } from '../../src/server/ConversationGraphSuggestionService.js';
import { mountMobilePermissionsRoutes, permissionPresenceMessage, type MobilePermissionsDeps } from '../../src/server/mobilePermissionsRoutes.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { loadMachineSigner, identityKeyLookup } from '../../src/core/AppRecordSignatures.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { encodeRouteRef, nodeKey, type ConversationRef, type EffortRef } from '../../src/core/conversationGraph.js';
import type { ConversationGraphReadModel } from '../../src/core/conversationGraphRead.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { makeDevice } from '../helpers/mobileDevice.js';
vi.setConfig({ testTimeout: 120_000 });

const HOST = 'graph-groups.example.dev';
const TOKEN = 'test-bearer';
const tg = (topicId: number): ConversationRef => ({ kind: 'conversation', platform: 'telegram', chatId: '-1001', topicId });
const services: MobilePairingService[] = [];
const dirs: string[] = [];
afterAll(() => { for (const s of services) s.stop(); for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/conversation-groups-phone.test.ts' }); });

function pairingFor(stateDir: string) {
  const config = { projectName: 'echo', stateDir, projectDir: stateDir, port: 0, authToken: TOKEN, developmentAgent: true, dashboardPin: '424242',
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Owner' }, users: [{ id: 'support', name: 'Support', permissions: ['user'] }], mobilePairing: { multiRoute: { enabled: false } } };
  const pairing = new MobilePairingService({ config: config as never, stateDir, holdsLease: () => true });
  pairing.nativeOn = true;
  pairing.keyLedger = new MobileDeviceKeyLedger({ stateDir, signer: loadMachineSigner(stateDir)!, keyLookup: identityKeyLookup(stateDir) });
  services.push(pairing);
  const phone = (msp = false) => {
    const dev = makeDevice(); const presence = makeDevice();
    const created = pairing.devices.createPending({ deviceName: 'Test phone', label: null, publicKey: dev.publicKey, host: HOST, ...(msp ? { userId: 'support', role: 'msp' as const } : {}) });
    if (!created.ok) throw new Error('pairing-failed');
    pairing.devices.applyConfirm(created.device.id, { ok: true });
    pairing.devices.setPresenceKey(created.device.id, presence.publicKey);
    return { dev, presence, id: created.device.id };
  };
  return { config, pairing, phone };
}
type Phone = ReturnType<ReturnType<typeof pairingFor>['phone']>;
let tick = 0;
function send(app: express.Express, phone: Phone, method: 'POST' | 'GET', p: string, body?: unknown) {
  const time = String(Date.now() + (tick++ % 1000));
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const r = method === 'POST' ? request(app).post(p).set('Content-Type', 'application/json') : request(app).get(p);
  r.set('X-Instar-Device', phone.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', phone.dev.sign(canonicalString(phone.id, HOST, method, p, time, raw)));
  return method === 'POST' ? r.send(raw.toString()) : r;
}
function appWith(pairing: MobilePairingService, mount: (app: express.Express) => void) {
  const app = express();
  app.use(express.json({ limit: '16kb', verify: (req, _res, buffer) => { (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(buffer); } }));
  app.use(authMiddleware(() => TOKEN, 'echo', undefined, deviceAuthenticator(pairing)));
  mount(app);
  return app;
}
function seedSuggestions(stateDir: string, list: Array<{ id: string; title: string; members: ConversationRef[] }>) {
  fs.writeFileSync(path.join(stateDir, SUGGESTIONS_STATE_FILE), JSON.stringify({ v: 1, builtAt: null, lastAttemptAt: new Date().toISOString(), lastFailure: null, rejected: {}, accepted: {}, accepting: {},
    suggestions: list.map((s) => ({ id: s.id, title: s.title, reason: 'r', memberKeys: s.members.map(nodeKey), members: s.members.map((m) => ({ key: nodeKey(m), ref: m, title: 'x' })) })) }));
}

describe('A. suggestions and Accept on the actual graph surface', () => {
  it('owner phone only; Reject persists; Accept creates and names the group in one call', async () => {
    const f = await setupGraphRuntimeFixture();
    expect(await f.runtime.refreshReadiness()).toBe(true); expect(await f.peer.refreshReadiness()).toBe(true);
    const stateDir = f.managers[0].baseDir;
    const { pairing, phone } = pairingFor(stateDir);
    const confirmHolder: GroupProjectConfirmHolder = { confirm: null };
    const app = appWith(pairing, (a) => a.use(createConversationGraphSurface({ stateDir, agentId: f.f.membership.agentId, runtime: f.runtime, identity: f.managers[0],
      scope: f.options[0].scopeVerifier!, telegramChatId: '-1001', pairing, readEnabled: true, correctionsEnabled: true, verifyDashboardOwner: () => false,
      suggestions: { intelligence: null, evidence: () => ({ project: null, text: '' }) }, groupProjects: { chiefOfStaffOn: () => true, boundProjects: () => new Map(), bindProject: () => ({ ok: false, reason: 'write-refused' }), confirmHolder } })));
    const owner = phone(), other = phone(true);
    seedSuggestions(stateDir, [
      { id: 'sg-0123456789abcdef0001', title: 'Not wanted', members: [tg(1), tg(2)] },
      { id: 'sg-0123456789abcdef0002', title: 'Shop launch', members: [tg(3), tg(4)] },
    ]);
    const base = '/mobile/conversation-graph/suggestions';
    // Owner only.
    const listed = await send(app, owner, 'GET', base);
    expect(listed.status).toBe(200); expect(listed.body).toMatchObject({ items: [] });
    expect((await send(app, other, 'GET', base)).status).toBe(403);
    expect((await request(app).get(base).set('Authorization', `Bearer ${TOKEN}`).set('X-Instar-AgentId', 'echo')).status).toBe(403);
    expect((await send(app, other, 'POST', `${base}/sg-0123456789abcdef0002/accept`, {})).status).toBe(403);
    expect((await send(app, other, 'POST', `${base}/sg-0123456789abcdef0001/reject`, {})).status).toBe(403);
    // Reject persists.
    const rejected = await send(app, owner, 'POST', `${base}/sg-0123456789abcdef0001/reject`, {});
    expect(rejected.status).toBe(200); expect(rejected.body).toEqual({ ok: true, id: 'sg-0123456789abcdef0001', state: 'rejected' });
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, SUGGESTIONS_STATE_FILE), 'utf8')).rejected['sg-0123456789abcdef0001']).toBeTruthy();
    expect((await send(app, owner, 'POST', `${base}/sg-0123456789abcdef0001/accept`, {})).status).toBe(404);
    // Accept: one call.
    const accepted = await send(app, owner, 'POST', `${base}/sg-0123456789abcdef0002/accept`, {});
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ id: 'sg-0123456789abcdef0002', state: 'accepted', moved: 0, skipped: 2, placedElsewhere: false });
    const group = accepted.body.group as EffortRef;
    expect(group.kind).toBe('effort');
    // The group exists and has its name, read back through the phone's own graph read.
    const read = await send(app, owner, 'GET', `/mobile/conversation-graph/nodes/${encodeRouteRef(group)}`);
    expect(read.status).toBe(200); expect(read.body.node.title).toBe('Shop launch');
    // Both members committed the create and the name (real owner changes, owner-device authority).
    const records = f.runtime.projection().records;
    expect(records.length).toBeGreaterThanOrEqual(2);
    expect(records.every((r) => f.peer.source.status(r.packet.eventId).state === 'committed')).toBe(true);
    expect(records.some((r) => r.authorizationProof.receipt.authenticationMethod === 'owner-device')).toBe(true);
    // A repeat answers the same result and makes nothing new; Reject is now refused.
    const again = await send(app, owner, 'POST', `${base}/sg-0123456789abcdef0002/accept`, {});
    expect(again.status).toBe(200); expect(again.body.group).toEqual(group);
    expect(f.runtime.projection().records.length).toBe(records.length);
    // The draft route: owner only, and a group with no conversation says so.
    const draftPath = `/mobile/conversation-graph/nodes/${encodeRouteRef(group)}/project-draft`;
    expect((await send(app, other, 'POST', draftPath, {})).status).toBe(403);
    const noConv = await send(app, owner, 'POST', draftPath, {});
    expect(noConv.status).toBe(409); expect(noConv.body.code).toBe('group-has-no-conversation');
    // The surface filled the phone confirm's graph port (wiring, not a no-op).
    expect(typeof confirmHolder.confirm).toBe('function');
    // The old-page compatibility routes stay owner-only (the bearer is not the owner).
    expect((await request(app).post('/conversation-graph/suggestions/sg-0123456789abcdef0002/start').set('Authorization', `Bearer ${TOKEN}`).set('X-Instar-AgentId', 'echo').send({})).status).toBe(403);
  });
});

describe('B. make this group a project: draft, then the Face ID confirm', () => {
  it('drafts a binding and writes it only on the proven confirm', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groups-phone-')); dirs.push(stateDir);
    const { MachineIdentityManager } = await import('../../src/core/MachineIdentity.js');
    await new MachineIdentityManager(stateDir).generateIdentity({ name: 'groups-test' });
    const { config, pairing, phone } = pairingFor(stateDir);
    const group: EffortRef = { kind: 'effort', id: '012fdaec-70de-4324-9ef3-22b616fc83ce' };
    // A read model answering one group with a front door and a second conversation (the read model's own
    // projection is exercised in A; here the subject is the draft and the confirm proof).
    const model = { node: (_viewer: unknown, ref: { kind: string }) => ref.kind === 'effort'
      ? { status: 200, body: { node: { ref: group, title: 'Shop launch', frontDoor: tg(51) }, path: [], children: { items: [{ ref: tg(51), title: 'a' }, { ref: tg(52), title: 'b' }], nextCursor: null } } }
      : { status: 404, body: { code: 'not-found' } } } as unknown as ConversationGraphReadModel;
    const bound = new Map<string, string>();
    const binds: unknown[] = [];
    const bindProject = (input: { conversationKey: string; goal: string }) => { binds.push(input); bound.set(input.conversationKey, input.goal); return { ok: true as const, conversationKey: input.conversationKey }; };
    const resolveViewer = createConversationGraphViewerResolver({ agentId: 'echo', pairing, verifyDashboardOwner: () => false });
    const projectDeps = { model, resolveViewer, telegramChatId: '-1001', boundProjects: () => new Map([...bound].map(([k, goal]) => [k, { goal, doneDefinition: [], repos: [] }])), chiefOfStaffOn: () => true,
      evidence: (ref: ConversationRef) => (ref as { topicId: number }).topicId === 51 ? 'Ship the shop: see github.com/JKHeadley/instar and #12' : 'Pick a launch date' };
    const confirmPort = groupProjectConfirmPort(projectDeps, bindProject as never);
    let refusal: { status: number; body: Record<string, unknown> } | null = null;
    const app = appWith(pairing, (a) => {
      a.use(createConversationGroupProjectRouter(projectDeps));
      const router = express.Router();
      mountMobilePermissionsRoutes(router, { pairing: () => pairing, config: () => config, stateDir, bearerOk: () => false,
        confirmGroupProject: (id: string, hash: string, _device: string, req: express.Request, carried: unknown) => confirmPort(req, id, hash, carried),
        groupProjectRefusal: () => refusal } as unknown as MobilePermissionsDeps);
      a.use(router);
    });
    const owner = phone(), other = phone(true);
    const draftPath = `/mobile/conversation-graph/nodes/${encodeRouteRef(group)}/project-draft`;
    expect((await send(app, other, 'POST', draftPath, {})).status).toBe(403);
    const drafted = await send(app, owner, 'POST', draftPath, {});
    expect(drafted.status).toBe(201);
    // Conversation text is context to read beside the draft; the goal and repos are the title's and the owner's only.
    expect(drafted.body.draft.binding).toMatchObject({ conversationKey: 'telegram:51', linked: { repos: [], branches: [], domains: [] } });
    expect(drafted.body.draft.binding.goal).toContain('Shop launch');
    expect(drafted.body.draft.binding.goal).not.toContain('Pick a launch date');
    expect(drafted.body.context).toMatchObject({ suggestedRepos: ['JKHeadley/instar'] });
    expect(drafted.body.context.about).toContain('Pick a launch date');
    expect(drafted.body.draft.binding.doneDefinition).toEqual([{ id: 'group-done-1', kind: 'judgment', text: 'The work in the group "Shop launch" is finished, and the owner says so.', certify: 'owner-confirms' }]);
    const { draftId, draftHash, confirm } = drafted.body;
    expect(confirm).toEqual({ action: 'group-project-confirm', target: draftId, proposalHash: draftHash, actionLine: `group-project-confirm ${draftId} ${draftHash}`, route: `/mobile/work/projects/drafts/${draftId}/confirm` });
    // The owner's own words replace the drafted ones.
    const own = await send(app, owner, 'POST', draftPath, { goal: 'Launch the shop by Friday.', done: ['Shop is live'], repos: ['JKHeadley/instar'] });
    expect(own.status).toBe(201); expect(own.body.draft.binding.goal).toBe('Launch the shop by Friday.');
    expect(own.body.draft.binding.doneDefinition[0].text).toBe('Shop is live');
    expect(own.body.draft.binding.linked.repos).toEqual(['JKHeadley/instar']);
    const draft = drafted.body.draft;
    expect(binds).toHaveLength(0); // a draft writes no binding

    const confirmPath = confirm.route as string;
    // No proof at all, another person's phone, a forged presence signature, a swapped hash: all refused.
    expect((await send(app, owner, 'POST', confirmPath, { proposalHash: draftHash, draft })).status).toBe(401);
    expect((await send(app, other, 'POST', confirmPath, { proposalHash: draftHash, draft })).status).toBe(403);
    // A machine that cannot decide (not the lease holder) issues no challenge, so no Face ID is spent.
    refusal = { status: 409, body: { error: 'not-holder', detail: 'This machine is not the one deciding right now. Try again in a moment.' } };
    const noChallenge = await send(app, owner, 'POST', '/mobile/permissions/challenge', { action: 'group-project-confirm', target: draftId, proposalHash: draftHash });
    expect(noChallenge.status).toBe(409); expect(noChallenge.body.error).toBe('not-holder');
    refusal = null;
    const ch1 = await send(app, owner, 'POST', '/mobile/permissions/challenge', { action: 'group-project-confirm', target: draftId, proposalHash: draftHash });
    expect(ch1.status).toBe(200);
    const forged = await send(app, owner, 'POST', confirmPath, { proposalHash: draftHash, draft, challenge: ch1.body.challenge, presenceSig: owner.dev.sign('wrong') });
    expect(forged.status).toBe(401); expect(forged.body.error).toBe('presence-invalid');
    const ch2 = await send(app, owner, 'POST', '/mobile/permissions/challenge', { action: 'group-project-confirm', target: draftId, proposalHash: draftHash });
    const swappedHash = own.body.draftHash as string;
    const swapped = await send(app, owner, 'POST', confirmPath, { proposalHash: swappedHash, draft, challenge: ch2.body.challenge,
      presenceSig: owner.presence.sign(permissionPresenceMessage(owner.id, HOST, ch2.body.challenge, `group-project-confirm ${draftId} ${swappedHash}`)) });
    expect(swapped.status).toBe(401); // the challenge was issued for the other line
    expect(binds).toHaveLength(0);
    // A proven tap whose carried draft is not the one it signed is refused, and writes nothing.
    const chX = await send(app, owner, 'POST', '/mobile/permissions/challenge', { action: 'group-project-confirm', target: draftId, proposalHash: draftHash });
    const otherDraft = await send(app, owner, 'POST', confirmPath, { proposalHash: draftHash, draft: own.body.draft, challenge: chX.body.challenge,
      presenceSig: owner.presence.sign(permissionPresenceMessage(owner.id, HOST, chX.body.challenge, confirm.actionLine)) });
    expect(otherDraft.status).toBe(409); expect(otherDraft.body.error).toBe('draft-changed');
    expect(binds).toHaveLength(0);
    // The proven confirm writes one binding.
    const ch3 = await send(app, owner, 'POST', '/mobile/permissions/challenge', { action: 'group-project-confirm', target: draftId, proposalHash: draftHash });
    const done = await send(app, owner, 'POST', confirmPath, { proposalHash: draftHash, draft, challenge: ch3.body.challenge,
      presenceSig: owner.presence.sign(permissionPresenceMessage(owner.id, HOST, ch3.body.challenge, confirm.actionLine)) });
    expect(done.status).toBe(201); expect(done.body).toMatchObject({ ok: true, conversationKey: 'telegram:51', group: { ref: group, title: 'Shop launch' } });
    expect(binds).toEqual([{ conversationKey: 'telegram:51', goal: draft.binding.goal, doneDefinition: draft.binding.doneDefinition, linked: draft.binding.linked }]);
    // Now the group's conversation is a project: a new draft says so, and the other draft cannot bind it twice.
    expect((await send(app, owner, 'POST', draftPath, {})).body.code).toBe('already-a-project');
    const ch4 = await send(app, owner, 'POST', '/mobile/permissions/challenge', { action: 'group-project-confirm', target: own.body.draftId, proposalHash: own.body.draftHash });
    const twice = await send(app, owner, 'POST', `/mobile/work/projects/drafts/${own.body.draftId}/confirm`, { proposalHash: own.body.draftHash, draft: own.body.draft, challenge: ch4.body.challenge,
      presenceSig: owner.presence.sign(permissionPresenceMessage(owner.id, HOST, ch4.body.challenge, own.body.confirm.actionLine)) });
    expect(twice.status).toBe(409); expect(twice.body.error).toBe('already-a-project');
    expect(binds).toHaveLength(1);
  });
});
