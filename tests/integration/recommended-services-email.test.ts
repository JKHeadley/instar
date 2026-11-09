/**
 * Email through the routes (docs/specs/backup-email-sending.md): the confirm page binds the owner-typed address
 * (stored in the vault, hashed on the yes row), the setup session stores the credential through the key route
 * (never a recipient), the proof mail goes out with a code, the owner enters it on the confirm page, the check
 * then passes, a session's one-off goes only to that address with its bind token, a shared conversation is refused,
 * the outbox lists hashes only, and a switch-off drains and removes what setup stored. Shapes A (Resend, over a
 * stand-in fetch through the real transport) and B/C (SMTP, through the real transport with a stand-in client).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import { RECOMMENDED_SERVICE_CATALOG, type CatalogRow } from '../../src/recommended/catalog.js';
import { registerRecommendedServiceRoutes } from '../../src/server/recommendedServiceRoutes.js';
import { registerEmailRoutes } from '../../src/server/emailRoutes.js';
import { buildEmailService } from '../../src/email/wireEmail.js';
import type { EmailService } from '../../src/email/EmailService.js';
import type { EmailRecipeSurface } from '../../src/recommended/recipes.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';
import type { SmtpClient } from '../../src/email/transports.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_a', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_a', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const PROVING: CatalogRow = { ...RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'email')!, setupRecipe: 'email-v1' };
const BASE = '/recommended-services/email';
const OWNER = 'Owner@Example.com';

describe('email through the routes', () => {
  let dir: string;
  let ledger: RecommendedServicesLedger;
  let store: Record<string, string>;
  let start: ReturnType<typeof vi.fn>;
  let resendSends: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }>;
  let resendStatus: string;
  let smtpSent: Array<Record<string, unknown>>;
  let topicSends: Array<{ topicId: number; text: string }>;
  let service: EmailService;
  let readers: Record<number, boolean>;

  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    if (u.endsWith('/domains')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (u.endsWith('/emails') && init.method === 'POST') {
      resendSends.push({ url: u, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ id: `msg_${resendSends.length}` }), { status: 200 });
    }
    if (u.includes('/emails/msg_')) return new Response(JSON.stringify({ last_event: resendStatus }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const smtpClient = (): SmtpClient => ({ sendMail: async (m) => { smtpSent.push(m); return { response: '250 OK' }; }, verify: async () => true });

  const app = () => {
    const built = buildEmailService({
      stateDir: dir, agentName: 'Echo', machineId: 'm_a', recipientKey: 'machine-key',
      ledger: () => ledger, readSecret: (n) => store[n] ?? null, holdsLease: () => true,
      detectCredential: (t) => /sk-ant-[A-Za-z0-9]{20,}/.test(t), config: () => ({}),
      deliverToSessionTopic: async (topicId, text) => { topicSends.push({ topicId, text }); return { ok: true, messageId: topicSends.length }; },
      fetch: fakeFetch, createSmtpClient: smtpClient,
    });
    service = built.service;
    const surface: EmailRecipeSurface = {
      verifyCredential: () => service.verifyCredential(), proven: () => service.proven(), prove: () => service.prove(),
      drain: () => service.drain(), forget: () => service.forget(), recipient: () => service.recipient(),
    };
    const a = express();
    a.use(express.text({ type: 'text/plain' }));
    a.use(express.json());
    const router = express.Router();
    registerRecommendedServiceRoutes(router, {
      ledger: () => ledger, stateDir: dir, owner: () => '42', catalog: [PROVING], port: 4040,
      checkPin: () => true, checkConfirmPin: (req, res) => { if ((req.body as { pin?: string }).pin === '1234') return true; res.status(403).json({ error: 'pin' }); return false; },
      recordApproval: () => undefined, openCommitment: () => 'CMT-1', finishCommitment: () => undefined, withdrawCommitment: () => undefined,
      startSetup: start, stopSetup: () => true, sessionForTopic: () => null, isSetupRunning: () => false,
      notifyStuck: async () => true, clearStuck: () => undefined, tellOwner: () => undefined,
      readSecret: (n) => store[n] ?? null, writeSecret: (n, v) => { store[n] = v; }, deleteSecret: (n) => { delete store[n]; },
      email: surface, emailRecipientHash: (r) => service.recipientHashOf(r), emailTimezone: () => 'America/Los_Angeles',
      onEmailRecipientChanged: () => service.forget(),
    });
    registerEmailRoutes(router, {
      service: () => service,
      originTopics: (raw) => (raw === 'good-token' ? [55] : raw === 'shared-token' ? [66] : null),
      topicHasOtherReaders: (t) => !!readers[t],
      hasGrant: () => ledger.activeGrant('email', 'm_a') !== null,
      checkConfirmPin: (req, res) => { if ((req.body as { pin?: string }).pin === '1234') return true; res.status(403).json({ error: 'pin' }); return false; },
      holdsLease: () => true,
    });
    a.use(router);
    return a;
  };
  const yes = async (a: express.Express, recipient: unknown = OWNER) => {
    const { body } = await request(a).get(`${BASE}/confirm`);
    return request(a).post(`${BASE}/confirm`).set('X-Instar-Request', '1').send({ token: body.token, pin: '1234', answer: 'yes', recipient });
  };
  const storeKey = (a: express.Express, cred: Record<string, unknown>) =>
    request(a).post(`${BASE}/key`).set('X-Instar-Request', '1').type('text/plain').send(JSON.stringify(cred));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-email-'));
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    store = {}; resendSends = []; smtpSent = []; topicSends = []; resendStatus = 'sent'; readers = {};
    start = vi.fn(async () => ({ sessionName: 's-email', topicId: 7 }));
  });
  afterEach(() => {
    service?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/recommended-services-email.test.ts' });
  });

  it('shape A end to end: typed address, key, proof with code, code entered, check passes, one-off delivered only to the owner', async () => {
    const a = app();
    const page = await request(a).get(`${BASE}/confirm`);
    expect(page.body).toMatchObject({ asksRecipient: true, recipientFixed: false });
    expect((await yes(a, 'not an address')).body).toEqual({ error: 'invalid-recipient' });
    expect((await yes(a)).status).toBe(200);
    expect(store.email_recipient).toBe('owner@example.com');
    const grant = ledger.activeGrant('email', 'm_a')!;
    expect(grant.recipientHash).toBe(service.recipientHashOf('owner@example.com'));
    expect(grant.timezone).toBe('America/Los_Angeles');
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]![2]).toContain('/recommended-services/email/key');
    // The session reads the address it opens the account with, and counts the signup mail.
    expect((await request(a).get(`${BASE}/recipient`).set('X-Instar-Request', '1')).body).toEqual({ recipient: 'owner@example.com' });
    expect((await request(a).post(`${BASE}/signup-mail`).set('X-Instar-Request', '1')).status).toBe(200);
    // A recipient in the key is refused; the real key is stored and split.
    expect((await storeKey(a, { shape: 'A', transport: 'resend', secret: 're_k', recipient: 'evil@example.com' })).body).toEqual({ error: 'recipient-not-accepted' });
    expect((await storeKey(a, { shape: 'A', transport: 'resend', secret: 're_k', providerAccountPassword: 'acct-pw' })).status).toBe(200);
    expect(store.email_provider_account).toBe('acct-pw');
    // Before the proof, the check fails (no code yet).
    expect((await request(a).post(`${BASE}/verify`).set('X-Instar-Request', '1').send({})).body.result).toBe('fail');
    const proof = await request(a).post(`${BASE}/prove`).set('X-Instar-Request', '1').send({});
    expect(proof.body).toMatchObject({ result: 'waiting', awaitingCode: true });
    expect(resendSends[0].body.to).toEqual(['owner@example.com']);
    const code = String(resendSends[0].body.text).match(/(\d{6})/)![1];
    resendStatus = 'delivered';
    expect((await request(a).post(`${BASE}/prove`).set('X-Instar-Request', '1').send({})).body.result).toBe('waiting');
    expect((await request(a).get(`${BASE}/confirm`)).body.awaitingCode).toBe(true);
    // The owner enters the code on the confirm page, with their PIN.
    expect((await request(a).post(`${BASE}/code`).set('X-Instar-Request', '1').send({ code, pin: 'wrong' })).status).toBe(403);
    expect((await request(a).post(`${BASE}/code`).set('X-Instar-Request', '1').send({ code: code === '000000' ? '111111' : '000000', pin: '1234' })).body).toEqual({ error: 'code-wrong' });
    expect((await request(a).post(`${BASE}/code`).set('X-Instar-Request', '1').send({ code, pin: '1234' })).body).toEqual({ confirmed: true });
    const verify = await request(a).post(`${BASE}/verify`).set('X-Instar-Request', '1').send({});
    expect(verify.body.result).toBe('pass');
    // A shape A recipient change is refused on the page.
    expect((await yes(a, 'someone.else@example.com')).body).toEqual({ error: 'recipient-is-the-account' });
    // A session's one-off: bind token required, fallback topic from the token, only ever to the owner.
    expect((await request(a).post('/email/send-to-owner').set('X-Instar-Request', '1').send({ subject: 's', text: 't' })).body.error).toBe('no-origin-session');
    readers[66] = true;
    expect((await request(a).post('/email/send-to-owner').set('X-Instar-Request', '1').set('X-Instar-Bind-Token', 'shared-token').send({ subject: 's', text: 't' })).body.error).toBe('topic-not-owner-only');
    const sent = await request(a).post('/email/send-to-owner').set('X-Instar-Request', '1').set('X-Instar-Bind-Token', 'good-token').send({ subject: 'Hello', text: 'Your numbers', to: 'evil@example.com' });
    expect(sent.status).toBe(200);
    await service.idle();
    const last = resendSends[resendSends.length - 1];
    expect(last.body).toEqual({ from: 'onboarding@resend.dev', to: ['owner@example.com'], subject: 'Echo: Hello', text: 'Your numbers' });
    expect(last.headers['Idempotency-Key']).toBe(sent.body.id);
    // The outbox lists hashes only.
    const outbox = await request(a).get('/email/outbox');
    expect(JSON.stringify(outbox.body)).not.toContain('Your numbers');
    expect(outbox.body.rows[0]).toMatchObject({ id: sent.body.id, kind: 'one-off', status: 'sent' });
    expect((await request(a).get(`${BASE}/status`)).body).toMatchObject({ state: 'working', shape: 'A', recipient: 'o***@example.com' });
  });

  it('a live secret in a one-off is refused and nothing is stored', async () => {
    const a = app();
    await yes(a);
    await storeKey(a, { shape: 'A', transport: 'resend', secret: 're_k' });
    const r = await request(a).post('/email/send-to-owner').set('X-Instar-Request', '1').set('X-Instar-Bind-Token', 'good-token').send({ subject: 's', text: `sk-ant-${'x'.repeat(30)}` });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'credential-exposure', blockedBy: 'credential-exposure-guard' });
    expect(service.outboxRows()).toHaveLength(0);
  });

  it('shape B: the login must be the typed address; the server’s acceptance is the proof, no code', async () => {
    const a = app();
    await yes(a);
    expect((await storeKey(a, { shape: 'B', transport: 'smtp', preset: 'gmail', username: 'other@gmail.com', secret: 'pw' })).body).toEqual({ error: 'recipient-mismatch' });
    expect((await storeKey(a, { shape: 'B', transport: 'smtp', preset: 'gmail', username: OWNER, secret: 'abcd efgh' })).status).toBe(200);
    const proof = await request(a).post(`${BASE}/prove`).set('X-Instar-Request', '1').send({});
    expect(proof.body).toMatchObject({ result: 'pass' });
    expect(proof.body.detail).toMatch(/accepted, not proven delivered/);
    expect(smtpSent[0]).toMatchObject({ to: 'owner@example.com', envelope: { to: ['owner@example.com'] } });
    expect((await request(a).post(`${BASE}/verify`).set('X-Instar-Request', '1').send({})).body.result).toBe('pass');
  });

  it('shape C: the agent mailbox sends to the owner, confirmed by the code', async () => {
    const a = app();
    await yes(a);
    expect((await storeKey(a, { shape: 'C', transport: 'smtp', preset: 'icloud', username: 'agent@icloud.com', secret: 'pw' })).status).toBe(200);
    expect((await request(a).post(`${BASE}/prove`).set('X-Instar-Request', '1').send({})).body.result).toBe('waiting');
    expect(smtpSent[0]).toMatchObject({ from: 'agent@icloud.com', to: 'owner@example.com' });
    const code = String(smtpSent[0].text).match(/(\d{6})/)![1];
    expect((await request(a).post(`${BASE}/code`).set('X-Instar-Request', '1').send({ code, pin: '1234' })).body).toEqual({ confirmed: true });
    expect((await request(a).post(`${BASE}/verify`).set('X-Instar-Request', '1').send({})).body.result).toBe('pass');
  });

  it('a no with switch-off drains and removes what setup stored', async () => {
    const a = app();
    await yes(a);
    await storeKey(a, { shape: 'A', transport: 'resend', secret: 're_k', providerAccountPassword: 'p' });
    const { body } = await request(a).get(`${BASE}/confirm`);
    const no = await request(a).post(`${BASE}/confirm`).set('X-Instar-Request', '1').send({ token: body.token, pin: '1234', answer: 'no', shutdown: true });
    expect(no.status).toBe(200);
    await vi.waitFor(() => expect(store.email_sending).toBeUndefined());
    expect(store.email_recipient).toBeUndefined();
    expect(store.email_provider_account).toBeUndefined();
  });

  it('without a grant here the setup routes refuse and nothing sends', async () => {
    const a = app();
    expect((await request(a).get(`${BASE}/recipient`).set('X-Instar-Request', '1')).status).toBe(409);
    expect((await request(a).post(`${BASE}/prove`).set('X-Instar-Request', '1').send({})).status).toBe(409);
    expect((await request(a).post(`${BASE}/code`).set('X-Instar-Request', '1').send({ code: '123456', pin: '1234' })).status).toBe(409);
    expect(resendSends).toHaveLength(0);
  });
});
