/**
 * SEC-135 (docs/specs/sec135-approval-link-guess-bound.md, Tests): the recommended-services confirm
 * page answers through sign-in's own public PIN limits (ctx.publicPin.verify), over the real
 * AgentServer wiring. Strangers use the tunnel's own name with a cf-connecting-ip, or a Host that is
 * not one of the agent's names; the machine itself is Host 127.0.0.1:<port>.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import {
  bootSec135, drainAggregate, localGet, localPost, localUnlock, markerCookie, namesBody, strangerGet, strangerPost, strangerToken, strangerUnlock,
  SEC135_AUTH, SEC135_PIN, SEC135_SERVICE, type Sec135Boot,
} from '../helpers/sec135Server.js';
import { OWN_PAUSED_MESSAGE, PUBLIC_PAUSED_MESSAGE } from '../../src/server/recommendedServiceRoutes.js';

let b: Sec135Boot;
afterEach(() => { b?.project.cleanup(); });
const stats = async () => (await request(b.app).get('/recommended-services').set('Authorization', `Bearer ${SEC135_AUTH}`)).body.confirmStats;
const attempts = (): Record<string, { count: number }> => {
  const f = path.join(b.project.stateDir, 'state', 'pin-attempts.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
};
const tokenRows = (): Array<{ protected?: boolean }> => JSON.parse(fs.readFileSync(path.join(b.project.stateDir, 'state', 'recommended-service-tokens', 'tokens.json'), 'utf8'));
const WRONG = '000000';

describe('SEC-135 stranger path', () => {
  it('once the public aggregate is full, an unmarked non-local answer is refused with the fixed wording, nothing compared or charged', async () => {
    b = bootSec135({ throttle: { globalFailureBudget: 6, coarseFailureBudget: 100 } });
    const token = await strangerToken(b.app);
    await drainAggregate(b.app, 6);
    const before = JSON.stringify(attempts());
    const res = await strangerPost(b.app, '192.0.2.50').send(namesBody(token, SEC135_PIN));
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'pin-paused', message: PUBLIC_PAUSED_MESSAGE, retryAfterSeconds: expect.any(Number) });
    expect(JSON.stringify(attempts())).toBe(before);
    expect((await stats()).publicPathRefused).toBe(1);
  });

  it('sign-in and confirm guesses share the aggregate and the per-source backoff', async () => {
    b = bootSec135({ throttle: { globalFailureBudget: 6, coarseFailureBudget: 100 } });
    const token = await strangerToken(b.app);
    for (let i = 0; i < 3; i++) expect((await strangerUnlock(b.app, `198.18.${i}.1`).send({ pin: WRONG })).status).toBe(403);
    for (let i = 0; i < 3; i++) expect((await strangerPost(b.app, `198.19.${i}.1`).send(namesBody(token, WRONG))).status).toBe(403);
    expect((await strangerUnlock(b.app, '198.20.0.1').send({ pin: SEC135_PIN })).status).toBe(429);

    b.project.cleanup();
    b = bootSec135();
    const t2 = await strangerToken(b.app);
    expect((await strangerUnlock(b.app, '198.51.100.9').send({ pin: WRONG })).status).toBe(403);
    expect((await strangerUnlock(b.app, '198.51.100.9').send({ pin: WRONG })).status).toBe(403);
    expect((await strangerPost(b.app, '198.51.100.9').send(namesBody(t2, WRONG))).status).toBe(403);
    // Three misses from one source start its backoff, wherever they were typed.
    const paused = await strangerPost(b.app, '198.51.100.9').send(namesBody(t2, SEC135_PIN));
    expect(paused.status).toBe(429);
    expect(paused.body.message).toBe(PUBLIC_PAUSED_MESSAGE);
    expect((await strangerUnlock(b.app, '198.51.100.9').send({ pin: SEC135_PIN })).status).toBe(429);
  });

  it('a stranger gets no more guesses across any number of tokens', async () => {
    b = bootSec135({ throttle: { globalFailureBudget: 6, coarseFailureBudget: 100 } });
    const tokens: string[] = [];
    for (let i = 0; i < 10; i++) tokens.push(await strangerToken(b.app, `192.0.2.${i + 10}`));
    const statuses: number[] = [];
    for (let i = 0; i < tokens.length; i++) statuses.push((await strangerPost(b.app, `198.${30 + i}.0.1`).send(namesBody(tokens[i], WRONG))).status);
    expect(statuses.filter((s) => s === 403)).toHaveLength(6);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
  });
});

describe('SEC-135 one verifier', () => {
  it('an exhausted per-request key refuses while public admission still allows the caller', async () => {
    b = bootSec135();
    const token = await strangerToken(b.app);
    for (let i = 0; i < 5; i++) expect((await strangerPost(b.app, `198.40.${i}.1`).send(namesBody(token, WRONG))).status).toBe(403);
    const paused = await strangerPost(b.app, '198.41.0.1').send(namesBody(token, SEC135_PIN));
    expect(paused.status).toBe(429);
    expect(paused.body.error).toBe('pin-paused');
    // The same caller, on a fresh token, is still admitted.
    const other = await strangerToken(b.app);
    expect((await strangerPost(b.app, '198.41.0.1').send(namesBody(other, SEC135_PIN))).status).toBe(200);
  });

  it('with one aggregate attempt left, two parallel wrong candidates (sign-in and confirm) compare exactly one', async () => {
    b = bootSec135({ throttle: { globalFailureBudget: 6, coarseFailureBudget: 100 } });
    const token = await strangerToken(b.app);
    await drainAggregate(b.app, 5);
    const [a, c] = await Promise.all([
      strangerUnlock(b.app, '198.50.0.1').send({ pin: WRONG }),
      strangerPost(b.app, '198.51.0.1').send(namesBody(token, WRONG)),
    ]);
    expect([a.status, c.status].sort()).toEqual([403, 429]);
  });

  it('a right PIN processed first leaves that last attempt available for the other request', async () => {
    b = bootSec135({ throttle: { globalFailureBudget: 6, coarseFailureBudget: 100 } });
    const token = await strangerToken(b.app);
    await drainAggregate(b.app, 5);
    expect((await strangerPost(b.app, '198.52.0.1').send(namesBody(token, SEC135_PIN))).status).toBe(200);
    expect((await strangerUnlock(b.app, '198.53.0.1').send({ pin: WRONG })).status).toBe(403);
    expect((await strangerUnlock(b.app, '198.54.0.1').send({ pin: SEC135_PIN })).status).toBe(429);
  });

  it('an insecure connection is refused before any compare and is not counted in publicPathRefused', async () => {
    b = bootSec135();
    const token = await strangerToken(b.app);
    // The verifier itself, with a connection that may not carry a PIN (desktop access on, plain http
    // from another address): refused first, nothing compared or counted.
    const hook = (b.server as unknown as { publicPinHook: import('../../src/server/publicPinHook.js').PublicPinHook }).publicPinHook;
    (b.server as unknown as { directDesktopAccess: unknown }).directDesktopAccess = { targetInfo: () => ({ label: 'x' }) };
    const before = JSON.stringify(attempts());
    const fakeReq = { headers: { host: 'evil.example' }, secure: false, socket: { remoteAddress: '192.0.2.77' }, body: {} } as unknown as import('express').Request;
    expect(hook.verify(fakeReq, WRONG, { requestKey: 'req:test' })).toEqual({ ok: false, reason: 'insecure-connection' });
    expect(JSON.stringify(attempts())).toBe(before);
    (b.server as unknown as { directDesktopAccess: unknown }).directDesktopAccess = null;
    // The route renders it as today's insecure-connection answer and does not count it as a public refusal.
    const real = hook.verify;
    hook.verify = () => ({ ok: false, reason: 'insecure-connection' });
    try {
      const res = await strangerPost(b.app, '192.0.2.78').send(namesBody(token, WRONG));
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'insecure-connection' });
    } finally { hook.verify = real; }
    expect((await stats()).publicPathRefused).toBe(0);
  });
});

describe('SEC-135 owner paths', () => {
  it('with the aggregate full, a marked answer and a local-direct answer pass with the right PIN', async () => {
    b = bootSec135({ throttle: { globalFailureBudget: 6, coarseFailureBudget: 100 } });
    const cookie = await markerCookie(b.app);
    const token = await strangerToken(b.app);
    await drainAggregate(b.app, 6);
    expect((await strangerPost(b.app, '198.60.0.1').send(namesBody(token, SEC135_PIN))).status).toBe(429);
    expect((await strangerPost(b.app, '198.60.0.2').set('Cookie', cookie).send(namesBody(token, SEC135_PIN))).status).toBe(200);
    expect((await localPost(b.app).send(namesBody(token, SEC135_PIN))).status).toBe(200);
    const s = await stats();
    expect(s.answersByPath).toEqual({ marker: 1, local: 1, public: 0 });
    expect(s.exemptPathAnswersWhileAggregateFull).toEqual({ marker: 1, local: 1 });
    expect(s.events.map((e: { path: string }) => e.path)).toEqual(['marker', 'local']);
  });

  it('marked wrong guesses use the marker path (not the public aggregate); local ones use the local budget', async () => {
    b = bootSec135({ throttle: { globalFailureBudget: 6, coarseFailureBudget: 100 } });
    const cookie = await markerCookie(b.app);
    const token = await strangerToken(b.app);
    await drainAggregate(b.app, 4);
    for (let i = 0; i < 3; i++) expect((await strangerPost(b.app, '198.61.0.1').set('Cookie', cookie).send(namesBody(token, WRONG))).status).toBe(403);
    // The strangers' aggregate still has its two attempts.
    const t2 = await strangerToken(b.app);
    expect((await strangerPost(b.app, '198.62.0.1').send(namesBody(t2, SEC135_PIN))).status).toBe(200);

    b.project.cleanup();
    b = bootSec135();
    const tokens = [await strangerToken(b.app), await strangerToken(b.app)];
    // Ten local wrong PINs across two tokens (the per-token key allows five each).
    for (let i = 0; i < 10; i++) expect((await localPost(b.app).send(namesBody(tokens[i % 2], WRONG))).status).toBe(403);
    const t3 = await strangerToken(b.app);
    const paused = await localPost(b.app).send(namesBody(t3, SEC135_PIN));
    expect(paused.status).toBe(429);
    expect(paused.body).toEqual({ error: 'pin-paused', message: OWN_PAUSED_MESSAGE, retryAfterSeconds: 300 });
    // The local budget is shared with sign-in, and strangers are unaffected.
    expect((await localUnlock(b.app).send({ pin: SEC135_PIN })).status).toBe(429);
    expect((await strangerPost(b.app, '198.63.0.1').send(namesBody(t3, SEC135_PIN))).status).toBe(200);
  });

  it('a marked or local GET with X-Instar-Request loads with the strangers\' mint cap full, as a protected row', async () => {
    b = bootSec135();
    const cookie = await markerCookie(b.app);
    for (let i = 0; i < 30; i++) expect((await strangerGet(b.app, `192.0.2.${i + 1}`)).status).toBe(200);
    const refused = await strangerGet(b.app, '192.0.2.200');
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: 'too-many-pages', retryAfterSeconds: expect.any(Number) });
    expect((await strangerGet(b.app, '192.0.2.201').set('Cookie', cookie).set('X-Instar-Request', '1')).status).toBe(200);
    expect((await localGet(b.app).set('X-Instar-Request', '1')).status).toBe(200);
    const rows = tokenRows();
    expect(rows.filter((r) => r.protected === true)).toHaveLength(2);
    expect(rows.slice(-2).every((r) => r.protected === true)).toBe(true);
    expect((await stats()).exemptPathOpens).toBe(2);
  });

  it('a marked GET without the header is a stranger open: the strangers\' cap and an unprotected row', async () => {
    b = bootSec135();
    const cookie = await markerCookie(b.app);
    expect((await strangerGet(b.app, '192.0.2.1').set('Cookie', cookie)).status).toBe(200);
    expect(tokenRows()[0].protected).toBeUndefined();
    for (let i = 0; i < 29; i++) await strangerGet(b.app, `192.0.2.${i + 2}`);
    expect((await strangerGet(b.app, '192.0.2.100').set('Cookie', cookie)).status).toBe(429);
    expect((await localGet(b.app)).status).toBe(429); // the machine itself without the header, too
  });

  it('with all 50 of a service\'s live pages protected, an owner open is told why and a stranger open gets the plain refusal, no row changed', async () => {
    b = bootSec135();
    const cookie = await markerCookie(b.app);
    await strangerGet(b.app, '192.0.2.1'); // writes the file and its directory
    const file = path.join(b.project.stateDir, 'state', 'recommended-service-tokens', 'tokens.json');
    const [row] = JSON.parse(fs.readFileSync(file, 'utf8'));
    const full = Array.from({ length: 50 }, (_, i) => ({ ...row, hash: `h${i}`, expiresAt: Date.now() + 20 * 60_000, protected: true }));
    fs.writeFileSync(file, JSON.stringify(full));
    const owner = await strangerGet(b.app, '192.0.2.2').set('Cookie', cookie).set('X-Instar-Request', '1');
    expect([owner.status, owner.body]).toEqual([429, { error: 'too-many-pages', allProtected: true }]);
    const stranger = await strangerGet(b.app, '192.0.2.3');
    expect([stranger.status, stranger.body]).toEqual([429, { error: 'too-many-pages' }]);
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(full));
  });

  it('a CORS preflight for the confirm path does not allow X-Instar-Request', async () => {
    b = bootSec135();
    const res = await request(b.app).options(`/recommended-services/${SEC135_SERVICE}/confirm`)
      .set('Origin', 'http://localhost:3000').set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'x-instar-request');
    const allowed = String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    expect(allowed).not.toContain('x-instar-request');
  });
});

describe('SEC-135 no wrong exemptions', () => {
  it('a bearer or an mps_ token gives no exemption, and a forged cf-connecting-ip sent straight to the port is ignored', async () => {
    b = bootSec135({ throttle: { globalFailureBudget: 6, coarseFailureBudget: 100 } });
    const token = await strangerToken(b.app);
    // A forged client address to a Host that is not one of the agent's names: unattributable, so the
    // forged address is never charged.
    const forged = () => request(b.app).post(`/recommended-services/${SEC135_SERVICE}/confirm`).set('Host', 'evil.example').set('cf-connecting-ip', '9.9.9.1').set('X-Instar-Request', '1');
    for (let i = 0; i < 3; i++) expect((await forged().send(namesBody(token, WRONG))).status).toBe(403);
    const t2 = await strangerToken(b.app);
    expect((await strangerPost(b.app, '9.9.9.1').send(namesBody(t2, SEC135_PIN))).status).toBe(200);
    await drainAggregate(b.app, 6);
    expect((await strangerPost(b.app, '198.80.0.1').set('Authorization', `Bearer ${SEC135_AUTH}`).send(namesBody(t2, SEC135_PIN))).status).toBe(429);
    expect((await strangerPost(b.app, '198.80.0.2').set('Authorization', 'Bearer mps_0123456789abcdef').send(namesBody(t2, SEC135_PIN))).status).toBe(429);
  });
});

describe('SEC-135 sign-in unchanged', () => {
  it('sign-in answers and wording are identical after the hook refactor', async () => {
    b = bootSec135({ throttle: { globalFailureBudget: 100, coarseFailureBudget: 100 } });
    expect((await strangerUnlock(b.app, '198.90.0.1').send({})).body).toEqual({ error: 'Missing PIN' });
    const wrong = await strangerUnlock(b.app, '198.90.0.1').send({ pin: WRONG });
    expect([wrong.status, wrong.body]).toEqual([403, { error: 'Incorrect PIN' }]);
    await strangerUnlock(b.app, '198.90.0.1').send({ pin: WRONG });
    await strangerUnlock(b.app, '198.90.0.1').send({ pin: WRONG });
    const backoff = await strangerUnlock(b.app, '198.90.0.1').send({ pin: SEC135_PIN });
    expect(backoff.status).toBe(429);
    expect(backoff.body).toEqual({ error: 'Too many PIN attempts. Try again later.', retryAfterSeconds: expect.any(Number) });
    // The durable shared budget (20) survives a restart that resets the throttle: its own body.
    for (let i = 0; i < 17; i++) await strangerUnlock(b.app, `198.${100 + i}.0.1`).send({ pin: WRONG });
    b = bootSec135({ project: b.project, throttle: { globalFailureBudget: 100, coarseFailureBudget: 100 } });
    const durable = await strangerUnlock(b.app, '198.200.0.1').send({ pin: SEC135_PIN });
    expect(durable.status).toBe(429);
    expect(durable.text).toBe(JSON.stringify({ error: 'Too many attempts. Try again later.' }));
    for (let i = 0; i < 10; i++) await localUnlock(b.app).send({ pin: WRONG });
    const local = await localUnlock(b.app).send({ pin: SEC135_PIN });
    expect(local.status).toBe(429);
    expect(local.body).toEqual({ error: 'Too many wrong PINs from this machine. Use a browser you have unlocked before or the paired phone app, or try again in a few minutes.', retryAfterSeconds: 300 });
    // A right PIN on a fresh agent unlocks with today's answer shape.
    b.project.cleanup();
    b = bootSec135();
    const ok = await strangerUnlock(b.app, '198.202.0.1').send({ pin: SEC135_PIN });
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body).sort()).toEqual(['operatorSessionExpiresAt', 'operatorSessionToken', 'token']);
  });
});

describe('SEC-135 store outage', () => {
  it('with the store unavailable, five wrong answers on one token refuse its next answer before comparison, for a stranger and a marked caller', async () => {
    b = bootSec135();
    const cookie = await markerCookie(b.app);
    (b.server as unknown as { pinAttemptStore: unknown }).pinAttemptStore = null;
    const t1 = await strangerToken(b.app);
    for (let i = 0; i < 5; i++) expect((await strangerPost(b.app, `198.210.${i}.1`).send(namesBody(t1, WRONG))).status).toBe(403);
    expect((await strangerPost(b.app, '198.211.0.1').send(namesBody(t1, SEC135_PIN))).status).toBe(429);
    const t2 = await strangerToken(b.app);
    for (let i = 0; i < 5; i++) expect((await strangerPost(b.app, '198.212.0.1').set('Cookie', cookie).send(namesBody(t2, WRONG))).status).toBe(403);
    const paused = await strangerPost(b.app, '198.212.0.1').set('Cookie', cookie).send(namesBody(t2, SEC135_PIN));
    expect(paused.status).toBe(429);
    expect(paused.body.message).toBe(OWN_PAUSED_MESSAGE);
  });
});

describe('SEC-135 switch off', () => {
  it('security.approvalLinks.enabled: false keeps piece 1c exactly: per-token budget only, no confirmStats, no protected rows', async () => {
    b = bootSec135({ approvalLinks: false, throttle: { globalFailureBudget: 6, coarseFailureBudget: 100 } });
    const cookie = await markerCookie(b.app);
    const token = await strangerToken(b.app);
    await drainAggregate(b.app, 6);
    expect((await strangerPost(b.app, '198.220.0.1').send(namesBody(token, SEC135_PIN))).status).toBe(200);
    const list = await request(b.app).get('/recommended-services').set('Authorization', `Bearer ${SEC135_AUTH}`);
    expect(list.body.confirmStats).toBeUndefined();
    expect((await strangerGet(b.app, '192.0.2.9').set('Cookie', cookie).set('X-Instar-Request', '1')).status).toBe(200);
    expect(tokenRows().some((r) => r.protected === true)).toBe(false);
    for (let i = 0; i < 30; i++) await strangerGet(b.app, `192.0.3.${i}`);
    expect((await strangerGet(b.app, '192.0.4.1')).body).toEqual({ error: 'too-many-pages' });
  });

  it('a fleet agent (not a development agent) with no setting is off', async () => {
    b = bootSec135({ developmentAgent: false });
    const list = await request(b.app).get('/recommended-services').set('Authorization', `Bearer ${SEC135_AUTH}`);
    expect(list.body.confirmStats).toBeUndefined();
  });
});
