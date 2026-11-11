/**
 * The document page over HTTP (spec §3.6, app contract): the open code, the read cookie, page data,
 * the strict CSP, and writes signed by the person's device under instar-docpage-v1.
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
import { signerKeyHashOf, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { DocumentStore } from '../../src/documents/store.js';
import { DocumentService, type Caller } from '../../src/documents/service.js';
import { blobHash } from '../../src/documents/blobs.js';
import { docpageString } from '../../src/documents/docpageAuth.js';
import { createDocumentRoutes } from '../../src/server/documentRoutes.js';
import { createDocumentPageRoutes, DOC_PAGE_CSP, type DocPageDeps } from '../../src/server/documentPageRoutes.js';
import { DOC_PAGE_PATH } from '../../src/server/middleware.js';
import { permissionPresenceMessage } from '../../src/server/mobilePermissionsRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import type { TeamView } from '../../src/documents/access.js';
import { checkRowOrigin } from '../../src/documents/originCheck.js';
import { deviceKeyHashOf } from '../../src/core/AppRecordSignatures.js';

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/documents-page.test.ts' }); });

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

function setup() {
  const kp = generateSigningKeyPair();
  const signer: MachineSigner = { machineId: () => 'A', signerKeyHash: () => signerKeyHashOf(kp.publicKey), sign: (p) => ({ machineId: 'A', signerKeyHash: signerKeyHashOf(kp.publicKey), sig: edSign(p, kp.privateKey) }) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpage-')); tmp.push(dir);
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'docpage-assets-')); tmp.push(assets);
  fs.writeFileSync(path.join(assets, 'doc-page.js'), 'export {};\n');
  const team: TeamView = { personMay: () => false, ownerOnly: (ref) => ref === OWN, sessionInPlace: () => false, teamRefusal: () => null, sendReachesOwner: () => false };
  const owner = deviceKey();
  const stranger = deviceKey();
  const presence = deviceKey();
  // The same re-check every machine runs on ingest (originCheck.ts), so these tests prove it end to end.
  const store = new DocumentStore(dir, {
    signer, keyLookup: () => ({ status: 'ok', publicKeyPem: kp.publicKey }), standing: () => 'ok',
    origin: (row, used) => checkRowOrigin(row,
      (id, kh) => id === 'owner-phone' && kh === deviceKeyHashOf(owner.raw) ? { status: 'ok', publicKey: owner.raw, role: 'owner', personKey: null, client: 'phone', mayWrite: true } : { status: 'unknown' },
      used, (docId, hash) => { const b = store.getBlob(docId, hash); return b ? JSON.parse(b.text) as string[] : null; }),
  });
  const service = new DocumentService(store, team);
  let origin: string | null = `https://${HOST}`;
  const deps: DocPageDeps = {
    config: () => ({ developmentAgent: true }), service: () => service, store: () => store, teamVector: () => ({}),
    grantsOf: () => [], ownsConversation: () => false, ownerConversation: () => OWN, deviceApprovedVia: () => 'phone',
    device: (id) => id === 'owner-phone' ? { person: { ok: true, role: 'owner', userId: null, name: 'Justin', telegramUserId: null } as never, client: 'phone', publicKey: owner.raw, approvedVia: 'phone' }
      : id === 'stranger' ? { person: null, client: 'phone', publicKey: stranger.raw, approvedVia: null } : null,
    isOwnHost: (h) => h === HOST, stableOrigin: () => origin, assetsDir: assets,
    ownerPresence: (_req, id) => id === 'owner-phone' ? { presenceKey: presence.raw, host: HOST } : null,
  };
  const a = express();
  a.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(buf); } }));
  // The device middleware's result for the phone route (mobilePairingRoutes deviceAuthenticator).
  a.use((req, _res, next) => {
    if (req.path.startsWith('/mobile/') && req.headers['x-test-device']) {
      (req as unknown as Record<string, unknown>).instarPrincipal = { kind: 'device', deviceId: req.headers['x-test-device'] };
      (req as unknown as Record<string, unknown>).instarDevicePerson = { ok: true, role: 'owner', userId: null, name: 'Justin' };
      // The tunnel's TLS ends at cloudflared on loopback.
      req.headers['x-forwarded-proto'] = 'https';
    }
    next();
  });
  a.use(createDocumentRoutes(deps));
  a.use(createDocumentPageRoutes(deps));
  const bearer: Caller = { principal: { kind: 'bearer' }, actor: { type: 'agent', placeKey: 'owner-reach' }, access: {}, reader: { kind: 'owner' } };
  const { id } = service.create(bearer, { title: 'Plan', markdown: '# Plan\n\nWe ship the viewer on Friday.\n', primary: OWN });
  return { a, id, owner, stranger, presence, store, service, setOrigin: (o: string | null) => { origin = o; } };
}

function signedHeaders(key: ReturnType<typeof deviceKey>, deviceId: string, docId: string, op: string, payload: Record<string, unknown>) {
  const requestId = `${Date.now()}-${crypto.randomUUID()}`;
  const timeMs = String(Date.now());
  const msg = docpageString(deviceId, HOST, docId, op as never, requestId, timeMs, payload);
  const sig = lowS(crypto.sign('sha256', Buffer.from(msg), { key: key.privateKey, dsaEncoding: 'der' })).toString('base64url');
  return {
    'X-Instar-Device': deviceId, 'X-Instar-Device-Time': timeMs, 'X-Instar-Docpage-Sig': sig, 'X-Instar-Request-Id': requestId,
    'X-Instar-Docpage-Payload': Buffer.from(JSON.stringify(payload)).toString('base64url'), 'X-Instar-Request': '1', Host: HOST,
  };
}

async function openCookie(s: ReturnType<typeof setup>): Promise<string> {
  const open = await request(s.a).post(`/mobile/docs/${s.id}/open`).set('x-test-device', 'owner-phone').send({});
  expect(open.status).toBe(200);
  expect(open.body.url).toBe(`https://${HOST}/docs/${s.id}`);
  const sess = await request(s.a).post(`/docs/${s.id}/session`).set('X-Instar-Request', '1').send({ code: open.body.code });
  expect(sess.status).toBe(200);
  const cookie = String(sess.headers['set-cookie'][0]);
  expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Strict; Path=\/docs\//);
  return cookie.split(';')[0];
}

describe('document page', () => {
  it('serves the shell with a strict CSP and no document content', async () => {
    const s = setup();
    const r = await request(s.a).get(`/docs/${s.id}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toBe(DOC_PAGE_CSP);
    expect(r.text).not.toContain('Friday');
    expect((await request(s.a).get('/docs/_assets/doc-page.js')).status).toBe(200);
    expect((await request(s.a).get('/docs/_assets/..%2Fsecret.js')).status).toBe(404);
  });

  it('a single-use code opens a read cookie; page data carries the render tree and its offsets', async () => {
    const s = setup();
    const cookie = await openCookie(s);
    const d = await request(s.a).get(`/docs/${s.id}/page-data`).set('Cookie', cookie);
    expect(d.status).toBe(200);
    expect(d.body.title).toBe('Plan');
    expect(d.body.blocks.map((b: { kind: string }) => b.kind)).toEqual(['heading', 'paragraph']);
    expect(d.body.me).toMatchObject({ key: 'owner', canComment: true });
    // The cookie is for this document only, and nothing reads without it.
    expect((await request(s.a).get(`/docs/${s.id}/page-data`)).status).toBe(401);
  });

  it('a code works once and only for its document', async () => {
    const s = setup();
    const open = await request(s.a).post(`/mobile/docs/${s.id}/open`).set('x-test-device', 'owner-phone').send({});
    const other = crypto.randomUUID();
    expect((await request(s.a).post(`/docs/${other}/session`).set('X-Instar-Request', '1').send({ code: open.body.code })).status).toBe(401);
    expect((await request(s.a).post(`/docs/${s.id}/session`).set('X-Instar-Request', '1').send({ code: open.body.code })).status).toBe(401);
  });

  it('without a stable address the app gets a plain 409', async () => {
    const s = setup();
    s.setOrigin(null);
    const r = await request(s.a).post(`/mobile/docs/${s.id}/open`).set('x-test-device', 'owner-phone').send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('documents-need-a-named-tunnel');
  });

  it('a device-signed comment is stored; a changed body, a replay, or an unknown person is refused', async () => {
    const s = setup();
    const cookie = await openCookie(s);
    const page = (await request(s.a).get(`/docs/${s.id}/page-data`).set('Cookie', cookie)).body;
    const para = page.blocks[1];
    const salt = crypto.randomBytes(16).toString('hex');
    const text = 'Can we make it Thursday?';
    const payload = { docId: s.id, commentId: crypto.randomUUID(), onVersion: page.version.id, start: para.start + 3, end: para.start + 13, bodyHash: blobHash(salt, text) };
    const h = signedHeaders(s.owner, 'owner-phone', s.id, 'comment', payload);
    const ok = await request(s.a).post(`/docs/${s.id}/w/comment`).set(h).send({ blobs: [{ salt, text }] });
    expect(ok.status).toBe(201);
    expect((await request(s.a).post(`/docs/${s.id}/w/comment`).set(h).send({ blobs: [{ salt, text }] })).status).toBe(401);
    const h2 = signedHeaders(s.owner, 'owner-phone', s.id, 'comment', { ...payload, commentId: crypto.randomUUID() });
    const tampered = await request(s.a).post(`/docs/${s.id}/w/comment`).set(h2).send({ blobs: [{ salt, text: 'Something else' }] });
    expect(tampered.status).toBe(400);
    const h3 = signedHeaders(s.stranger, 'stranger', s.id, 'comment', { ...payload, commentId: crypto.randomUUID() });
    expect((await request(s.a).post(`/docs/${s.id}/w/comment`).set(h3).send({ blobs: [{ salt, text }] })).status).toBe(404);
    const after = (await request(s.a).get(`/docs/${s.id}/page-data`).set('Cookie', cookie)).body;
    expect(after, JSON.stringify(after)).toHaveProperty("comments");
    expect(after.comments).toHaveLength(1);
    expect(after.comments[0]).toMatchObject({ quote: 'ship the v' });
  });

  it('exempts exactly the page shapes from the bearer gate', () => {
    const id = crypto.randomUUID();
    expect(DOC_PAGE_PATH('GET', `/docs/${id}`)).toBe(true);
    expect(DOC_PAGE_PATH('GET', `/docs/${id}/page-data`)).toBe(true);
    expect(DOC_PAGE_PATH('POST', `/docs/${id}/w/comment`)).toBe(true);
    expect(DOC_PAGE_PATH('GET', `/docs/${id}/data`)).toBe(false);
    expect(DOC_PAGE_PATH('POST', '/docs')).toBe(false);
    expect(DOC_PAGE_PATH('GET', '/docs/health')).toBe(false);
    expect(DOC_PAGE_PATH('POST', `/docs/${id}/versions`)).toBe(false);
  });

  it('the owner moves a document with Face ID over exactly the history shown, never back to owner-only once shared', async () => {
    const s = setup();
    const heads = (await request(s.a).get(`/mobile/docs/${s.id}/summary`).set('x-test-device', 'owner-phone')).body.heads;
    const move = async (primary: string, docDeps: Record<string, number>, sigKey = s.presence) => {
      const ch = await request(s.a).post(`/mobile/docs/${s.id}/primary/challenge`).set('x-test-device', 'owner-phone').send({ primary, docDeps });
      expect(ch.status).toBe(200);
      const line = `docs-primary-set ${s.id} ${primary} ${crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(docDeps).sort()))).digest('hex')}`;
      const sig = lowS(crypto.sign('sha256', Buffer.from(permissionPresenceMessage('owner-phone', HOST, ch.body.challenge, line)), { key: sigKey.privateKey, dsaEncoding: 'der' })).toString('base64url');
      // The phone's own device signature over the whole request (what peers re-check).
      const raw = JSON.stringify({ primary, docDeps, challenge: ch.body.challenge, presenceSig: sig });
      const timeMs = String(Date.now());
      const deviceSig = lowS(crypto.sign('sha256', Buffer.from(canonicalString('owner-phone', HOST, 'POST', `/mobile/docs/${s.id}/primary`, timeMs, Buffer.from(raw))), { key: s.owner.privateKey, dsaEncoding: 'der' })).toString('base64url');
      return request(s.a).post(`/mobile/docs/${s.id}/primary`).set('x-test-device', 'owner-phone').set('x-instar-device-time', timeMs).set('x-instar-device-sig', deviceSig).set('Content-Type', 'application/json').send(raw);
    };
    // A signature from another key is refused; a history that leaves rows out is refused.
    expect((await move('telegram:500', heads, s.owner)).status).toBe(401);
    expect((await move('telegram:500', {})).body.error).toBe('document-changed');
    const ok = await move('telegram:500', heads);
    expect(ok.status).toBe(200);
    const after = (await request(s.a).get(`/mobile/docs/${s.id}/summary`).set('x-test-device', 'owner-phone')).body;
    expect(after.primary.ref).toBe('telegram:500');
    expect((await move(OWN, after.heads)).body.error).toBe('once-shared-stays-shared');
    // Another phone gets nothing.
    expect((await request(s.a).post(`/mobile/docs/${s.id}/primary/challenge`).set('x-test-device', 'stranger').send({ primary: OWN, docDeps: {} })).status).toBe(403);
  });
});
