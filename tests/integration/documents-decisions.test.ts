/**
 * Document decisions over HTTP (docs/specs/document-decisions.md): the agent asks, the owner's phone
 * answers on its own sheet with Face ID, every refusal, the delivered receipt, the browser's
 * "decide on your phone", and the agent's read of the record.
 */
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf, deviceKeyHashOf, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { DocumentStore } from '../../src/documents/store.js';
import { DocumentService } from '../../src/documents/service.js';
import { blobHash } from '../../src/documents/blobs.js';
import { docpageString } from '../../src/documents/docpageAuth.js';
import { createDocumentRoutes } from '../../src/server/documentRoutes.js';
import { createDocumentPageRoutes, type DocPageDeps } from '../../src/server/documentPageRoutes.js';
import { permissionPresenceMessage } from '../../src/server/mobilePermissionsRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import type { TeamView } from '../../src/documents/access.js';
import { checkRowOrigin, NO_NOTE } from '../../src/documents/originCheck.js';
import { DOC_PAGE_PATH } from '../../src/server/middleware.js';

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/documents-decisions.test.ts' }); });

const OWN = 'telegram:7';
const HOST = 'echo.example.dev';
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
function lowS(der: Buffer): Buffer {
  const rLen = der[3]; const r = der.subarray(4, 4 + rLen); const sLen = der[5 + rLen]; let s = BigInt('0x' + der.subarray(6 + rLen, 6 + rLen + sLen).toString('hex'));
  if (s > N / 2n) s = N - s;
  let sHex = s.toString(16); if (sHex.length % 2) sHex = '0' + sHex; let sb = Buffer.from(sHex, 'hex'); if (sb[0] & 0x80) sb = Buffer.concat([Buffer.from([0]), sb]);
  const body = Buffer.concat([Buffer.from([2, r.length]), r, Buffer.from([2, sb.length]), sb]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
function deviceKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return { raw: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'), privateKey };
}
const signWith = (k: ReturnType<typeof deviceKey>, msg: string) => lowS(crypto.sign('sha256', Buffer.from(msg), { key: k.privateKey, dsaEncoding: 'der' })).toString('base64url');

function setup(opts: { root?: 'telegram' | 'pin' | null; blockedBy?: string | null; delivered?: boolean; peer?: boolean; kp?: ReturnType<typeof generateSigningKeyPair> } = {}) {
  const kp = opts.kp ?? generateSigningKeyPair();
  const signer: MachineSigner = { machineId: () => 'A', signerKeyHash: () => signerKeyHashOf(kp.publicKey), sign: (p) => ({ machineId: 'A', signerKeyHash: signerKeyHashOf(kp.publicKey), sig: edSign(p, kp.privateKey) }) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docdec-int-')); tmp.push(dir);
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'docdec-assets-')); tmp.push(assets);
  fs.writeFileSync(path.join(assets, 'doc-page.js'), 'export {};\n');
  const team: TeamView = { personMay: () => false, ownerOnly: (ref) => ref === OWN, sessionInPlace: () => false, teamRefusal: () => null, sendReachesOwner: () => false };
  const owner = deviceKey(); const presence = deviceKey(); const browser = deviceKey();
  const store = new DocumentStore(dir, {
    signer, keyLookup: () => ({ status: 'ok', publicKeyPem: kp.publicKey }), standing: () => 'ok',
    origin: (row, used) => checkRowOrigin(row,
      (id, kh) => id === 'owner-phone' && kh === deviceKeyHashOf(owner.raw) ? { status: 'ok', publicKey: owner.raw, role: 'owner', personKey: null, client: 'phone', mayWrite: true, approvedVia: 'telegram-dm', ...(opts.peer ? {} : { localPresenceKey: presence.raw }) } : { status: 'unknown' },
      used, () => null),
  });
  const service = new DocumentService(store, team);
  const pushes: string[] = [];
  const chatChecks: Array<[string, string, string, string]> = [];
  const deps: DocPageDeps = {
    config: () => ({ developmentAgent: true }), service: () => service, store: () => store, teamVector: () => ({}),
    grantsOf: () => [], ownsConversation: () => false, ownerConversation: () => OWN, deviceApprovedVia: (id) => id === 'owner-browser' ? 'owner-phone' : 'telegram-dm',
    device: (id) => id === 'owner-phone' ? { person: { ok: true, role: 'owner', userId: null, name: 'Justin', telegramUserId: null } as never, client: 'phone', publicKey: owner.raw, approvedVia: 'telegram-dm' }
      : id === 'owner-browser' ? { person: { ok: true, role: 'owner', userId: null, name: 'Justin', telegramUserId: null } as never, client: 'browser', publicKey: browser.raw, approvedVia: 'owner-phone' } : null,
    isOwnHost: (h) => h === HOST, stableOrigin: () => `https://${HOST}`, assetsDir: assets,
    ownerPresence: (_req, id) => id === 'owner-phone' ? { presenceKey: presence.raw, host: HOST } : null,
    decisionRoot: (id) => id === 'owner-phone' ? (opts.root === undefined ? 'telegram' : opts.root) : null,
    decisionWritesBlockedBy: () => opts.blockedBy ?? null,
    notifyDecisionAsk: (docId, askId) => { pushes.push(`ask:${docId}:${askId}`); },
    notifyDecisionPhone: async (docId, key) => { pushes.push(`press:${docId}:${key}`); return 'sent'; },
    chatDelivered: (deviceId, requestId, sendPath, text) => { chatChecks.push([deviceId, requestId, sendPath, text]); return opts.delivered ?? true; },
    machineCaller: () => ({ principal: { kind: 'bearer' }, actor: { type: 'machine' }, access: {}, reader: { kind: 'owner' } }),
    ownerName: () => 'Justin',
  };
  const a = express();
  a.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(buf); } }));
  a.use((req, _res, next) => {
    if (req.path.startsWith('/mobile/') && req.headers['x-test-device']) {
      (req as unknown as Record<string, unknown>).instarPrincipal = { kind: 'device', deviceId: req.headers['x-test-device'] };
      (req as unknown as Record<string, unknown>).instarDevicePerson = { ok: true, role: 'owner', userId: null, name: 'Justin' };
      req.headers['x-forwarded-proto'] = 'https';
    }
    next();
  });
  a.use(createDocumentRoutes(deps));
  a.use(createDocumentPageRoutes(deps));
  return { a, kp, owner, presence, browser, service, store, pushes, chatChecks };
}

/** The agent (bearer) creates a document with a question. */
async function docWithAsk(s: ReturnType<typeof setup>) {
  const r = await request(s.a).post('/docs').send({ title: 'Secret Drop hardening', markdown: '# Hardening\n\nShip it?\n', primary: OWN, decision: { question: 'Ship the Secret Drop hardening?' } });
  expect(r.status).toBe(201);
  expect(r.body.askId).toMatch(/^[0-9a-f-]{36}$/);
  return r.body as { id: string; versionId: string; askId: string };
}

/** The phone's flow: read the ask itself, get a challenge, sign it with the presence key, then the device-signed decision. */
async function decide(s: ReturnType<typeof setup>, id: string, over: Partial<{ verdict: string; onVersion: string; supersedes: string | null; note: string; presenceKey: ReturnType<typeof deviceKey>; device: string }> = {}) {
  const device = over.device ?? 'owner-phone';
  const view = (await request(s.a).get(`/mobile/docs/${id}/decision`).set('x-test-device', device)).body;
  const salt = crypto.randomBytes(16).toString('hex');
  const noteHash = over.note ? blobHash(salt, over.note) : NO_NOTE;
  const body = { askId: view.ask?.askId, onVersion: over.onVersion ?? view.version?.id, verdict: over.verdict ?? 'approve', questionHash: view.ask?.questionHash, noteHash, supersedes: over.supersedes === undefined ? (view.decision?.rowKey ?? null) : over.supersedes };
  const ch = await request(s.a).post(`/mobile/docs/${id}/decision/challenge`).set('x-test-device', device).send({ ...body, ...(over.note ? { note: { salt, text: over.note } } : {}) });
  if (ch.status !== 200) return ch;
  const line = `docs-decision ${id} ${body.askId} ${body.onVersion} ${body.verdict} ${body.questionHash} ${body.noteHash} ${body.supersedes ?? '-'}`;
  const presenceSig = signWith(over.presenceKey ?? s.presence, permissionPresenceMessage(device, HOST, ch.body.challenge, line));
  const raw = JSON.stringify({ ...body, challenge: ch.body.challenge, presenceSig });
  const timeMs = String(Date.now());
  const deviceSig = signWith(s.owner, canonicalString(device, HOST, 'POST', `/mobile/docs/${id}/decision`, timeMs, Buffer.from(raw)));
  return request(s.a).post(`/mobile/docs/${id}/decision`).set('x-test-device', device).set('x-instar-device-time', timeMs).set('x-instar-device-sig', deviceSig).set('Content-Type', 'application/json').send(raw);
}

describe('document decisions over HTTP', () => {
  it('the agent asks (the owner phone is notified), the owner approves with Face ID, the agent reads the record', async () => {
    const s = setup();
    const { id, askId } = await docWithAsk(s);
    expect(s.pushes).toEqual([`ask:${id}:${askId}`]);
    expect((await request(s.a).get('/docs/decisions/waiting')).body.documents.map((d: { id: string }) => d.id)).toEqual([id]);
    const r = await decide(s, id);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ sendPath: '/mobile/chat/7', decision: { verdict: 'approve', versionLabel: 1, latest: true, proof: 'telegram', delivered: false } });
    expect(r.body.decision.messageRequestId).toMatch(/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const agentView = (await request(s.a).get(`/docs/${id}/decision`)).body;
    expect(agentView).toMatchObject({ ask: { askId, question: 'Ship the Secret Drop hardening?' }, decision: { verdict: 'approve', versionLabel: 1, by: 'owner' }, waitingOnOwner: false, crossed: false });
    expect((await request(s.a).get('/docs/decisions/waiting')).body.documents).toEqual([]);
  });

  it('a Decline with a note, then a new version asks again (and pushes again)', async () => {
    const s = setup();
    const { id } = await docWithAsk(s);
    const r = await decide(s, id, { verdict: 'decline', note: 'Add the rollback test first.' });
    expect(r.status).toBe(201);
    expect(r.body.decision).toMatchObject({ verdict: 'decline', note: 'Add the rollback test first.' });
    const rev = await request(s.a).post(`/docs/${id}/versions`).send({ markdown: '# Hardening\n\nRollback test added.\n' });
    expect(rev.status).toBe(201);
    expect(s.pushes.length).toBe(2);
    expect((await request(s.a).get(`/docs/${id}/decision`)).body).toMatchObject({ waitingOnOwner: true, decision: { verdict: 'decline', latest: false } });
  });

  it('refuses a stale version, a wrong presence signature, a device that may not decide, and a peer that has not updated', async () => {
    const s = setup();
    const { id, versionId } = await docWithAsk(s);
    await request(s.a).post(`/docs/${id}/versions`).send({ markdown: '# Hardening\n\nv2\n' });
    expect((await decide(s, id, { onVersion: versionId })).body.error).toBe('version-changed');
    expect((await decide(s, id, { presenceKey: s.owner })).status).toBe(401);
    expect((await decide(s, id, { device: 'owner-browser' })).status).toBe(403);
    const pin = setup({ root: null });
    const d2 = await docWithAsk(pin);
    expect((await decide(pin, d2.id)).body.error).toBe('cannot-decide-here');
    const blocked = setup({ blockedBy: 'Mac Mini' });
    const b = await request(blocked.a).post('/docs').send({ title: 'x', markdown: '# x\n', primary: OWN, decision: { question: 'Ship?' } });
    expect(b.status).toBe(409);
    expect(b.body).toMatchObject({ error: 'peers-updating', machine: 'Mac Mini' });
  });

  it('records delivery only when this machine holds a delivered chat record for that message', async () => {
    const s = setup();
    const { id } = await docWithAsk(s);
    const d = await decide(s, id);
    const rid = d.body.decision.messageRequestId as string;
    const text = `Approved version 1 of "Secret Drop hardening": https://${HOST}/docs/${id}`;
    const ok = await request(s.a).post(`/mobile/docs/${id}/decision/delivered`).set('x-test-device', 'owner-phone').send({ rowKey: d.body.rowKey, requestId: rid, text, sendPath: '/mobile/chat/7' });
    expect(ok.status).toBe(200);
    expect(s.chatChecks[0]).toEqual(['owner-phone', rid, '/mobile/chat/7', text]);
    expect((await request(s.a).get(`/docs/${id}/decision`)).body.decision.delivered).toBe(true);
    // A path that is not the document's conversation is refused.
    expect((await request(s.a).post(`/mobile/docs/${id}/decision/delivered`).set('x-test-device', 'owner-phone').send({ rowKey: d.body.rowKey, requestId: rid, text, sendPath: '/mobile/chat/99' })).status).toBe(409);
    const no = setup({ delivered: false });
    const d2 = await docWithAsk(no);
    const dd = await decide(no, d2.id);
    expect((await request(no.a).post(`/mobile/docs/${d2.id}/decision/delivered`).set('x-test-device', 'owner-phone').send({ rowKey: dd.body.rowKey, requestId: dd.body.decision.messageRequestId, text: `Approved version 1: https://${HOST}/docs/${d2.id}`, sendPath: '/mobile/chat/7' })).body.error).toBe('not-delivered-here');
    // A receipt for a message that is not about this decision is refused.
    expect((await request(s.a).post(`/mobile/docs/${id}/decision/delivered`).set('x-test-device', 'owner-phone').send({ rowKey: d.body.rowKey, requestId: `${Date.now()}-${crypto.randomUUID()}`, text: 'hi', sendPath: '/mobile/chat/7' })).body.error).toBe('not-this-decision');
  });

  it('the page write for decide-on-phone passes the bearer-exempt page path (it carries its own device signature)', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(DOC_PAGE_PATH('POST', `/docs/${id}/w/decide-on-phone`)).toBe(true);
    expect(DOC_PAGE_PATH('POST', `/docs/${id}/w/comment`)).toBe(true);
    expect(DOC_PAGE_PATH('POST', `/docs/${id}/w/decide-on-phone/x`)).toBe(false);
    expect(DOC_PAGE_PATH('POST', `/docs/${id}/w/-bad`)).toBe(false);
  });

  it('a browser asks the phone (a signed decide-on-phone) and the page data carries the decision panel', async () => {
    const s = setup();
    const { id, askId } = await docWithAsk(s);
    const payload = { docId: id, askId, verdict: 'approve' };
    const requestId = `${Date.now()}-${crypto.randomUUID()}`;
    const timeMs = String(Date.now());
    const sig = signWith(s.browser, docpageString('owner-browser', HOST, id, 'decide-on-phone', requestId, timeMs, payload));
    const r = await request(s.a).post(`/docs/${id}/w/decide-on-phone`).set({
      'X-Instar-Device': 'owner-browser', 'X-Instar-Device-Time': timeMs, 'X-Instar-Docpage-Sig': sig, 'X-Instar-Request-Id': requestId,
      'X-Instar-Docpage-Payload': Buffer.from(JSON.stringify(payload)).toString('base64url'), 'X-Instar-Request': '1', Host: HOST,
    }).send({});
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('sent');
    expect(s.pushes.at(-1)).toBe(`press:${id}:doc-decide-press:${id}:${requestId}`);
  });

  it('SEC-088 interim: a machine without the phone\'s own enrollment shows waiting, keeps Needs-you, and applies nothing', async () => {
    const host = setup();
    const { id } = await docWithAsk(host);
    expect((await decide(host, id)).status).toBe(201);
    // The peer holds the same rows (synced), but knows the phone only from replicated fields.
    const peer = setup({ peer: true, kp: host.kp });
    const results = host.store.allRowsOf(id).map((r) => peer.store.ingest(r));
    expect(results).toContain('pending');
    const view = (await request(peer.a).get(`/docs/${id}/decision`)).body;
    expect(view).toMatchObject({ decision: null, waitingOnOwner: true, confirmingElsewhere: true });
    // Needs-you is not cleared on the peer.
    expect((await request(peer.a).get('/docs/decisions/waiting')).body.documents.map((d: { id: string }) => d.id)).toEqual([id]);
    expect(peer.service.decisionWords(id)).toMatch(/waiting for the machine that phone is paired with/);
    // The phone's own machine shows Approved and clears it.
    expect((await request(host.a).get(`/docs/${id}/decision`)).body).toMatchObject({ decision: { verdict: 'approve' }, waitingOnOwner: false, confirmingElsewhere: false });
    expect((await request(host.a).get('/docs/decisions/waiting')).body.documents).toEqual([]);
  });

  it('the agent withdraws the question; nothing waits on the owner', async () => {
    const s = setup();
    const { id } = await docWithAsk(s);
    expect((await request(s.a).post(`/docs/${id}/decision-ask/close`)).status).toBe(200);
    expect((await request(s.a).get(`/docs/${id}/decision`)).body.ask).toBeNull();
    expect((await decide(s, id)).status).not.toBe(201);
  });
});
