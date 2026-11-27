/**
 * Done and Ignore for a Needs-you item (docs/specs/mobile-attention-choices.md): the route runs the
 * dashboard's own PATCH /attention/:id and words its answer for a person.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { choiceAnswer, mountMobileAttentionChoiceRoutes } from '../../src/server/mobileAttentionChoiceRoutes.js';
import { DEVICE_ALLOWLIST } from '../../src/server/mobilePairingRoutes.js';

function app(answer: { status: number; body: unknown } | 'throw') {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const a = express();
  a.use(express.json());
  const router = express.Router();
  mountMobileAttentionChoiceRoutes(router, {
    call: async (method, path, body) => { calls.push({ method, path, body }); if (answer === 'throw') throw new Error('x'); return answer; },
    bearerOk: (req) => req.headers.authorization === 'Bearer t',
  });
  a.use(router);
  return { a, calls };
}

describe('Done and Ignore for a Needs-you item', () => {
  it('runs the dashboard route with the exact status and a resolution naming the phone', async () => {
    const { a, calls } = app({ status: 200, body: {} });
    const r = await request(a).post('/mobile/attention/telegram-ingress:x:2026-11-06/choice').set('Authorization', 'Bearer t').send({ choice: 'ignore' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, message: 'Ignored. It won\'t ask again.' });
    expect(calls).toEqual([{ method: 'PATCH', path: '/attention/telegram-ingress%3Ax%3A2026-11-06', body: { status: 'WONT_DO', resolution: 'Ignored from the owner\'s phone.' } }]);
    const done = app({ status: 200, body: {} });
    await request(done.a).post('/mobile/attention/tg-1/choice').set('Authorization', 'Bearer t').send({ choice: 'done' });
    expect(done.calls[0].body).toEqual({ status: 'DONE', resolution: 'Marked done from the owner\'s phone.' });
  });
  it('refuses a bad choice, a bad id and a caller who is not the owner, before calling anything', async () => {
    const { a, calls } = app({ status: 200, body: {} });
    expect((await request(a).post('/mobile/attention/tg-1/choice').set('Authorization', 'Bearer t').send({ choice: 'snooze' })).status).toBe(400);
    expect((await request(a).post('/mobile/attention/a%20b/choice').set('Authorization', 'Bearer t').send({ choice: 'done' })).status).toBe(400);
    // A dot-only id would be read as a path step by the loopback URL.
    expect((await request(a).post('/mobile/attention/..%2E/choice').set('Authorization', 'Bearer t').send({ choice: 'done' })).status).toBe(400);
    expect((await request(a).post('/mobile/attention/tg-1/choice').send({ choice: 'done' })).status).toBe(403);
    expect(calls).toEqual([]);
  });
  it('words what the route answered, never a raw code', () => {
    expect(choiceAnswer('done', { status: 200, body: {} }).body).toMatchObject({ ok: true, message: 'Marked done.' });
    expect(choiceAnswer('done', { status: 404, body: {} })).toMatchObject({ status: 404, body: { error: 'not-found', message: 'This is already gone. Pull to refresh.' } });
    expect(choiceAnswer('done', { status: 409, body: {} }).body.message).toContain('can\'t change it right now');
    expect(choiceAnswer('done', { status: 0, body: null }).body.message).toContain('couldn\'t be reached');
    expect(choiceAnswer('done', { status: 500, body: null }).body.message).toContain('answered 500');
  });
  it('a call that throws is said as not reached', async () => {
    const { a } = app('throw');
    const r = await request(a).post('/mobile/attention/tg-1/choice').set('Authorization', 'Bearer t').send({ choice: 'done' });
    expect(r.status).toBe(502);
  });
  it('is on the device allowlist for owner phones, in the health choices bucket', () => {
    const rule = DEVICE_ALLOWLIST.filter((x) => x.method === 'POST' && x.re.test('/mobile/attention/telegram-ingress:x:2026-11-06/choice'));
    expect(rule).toHaveLength(1);
    expect(rule[0]).toMatchObject({ ownerOnly: true, bucket: 'health-choices', ownBucket: 12, body: 'json' });
    expect(DEVICE_ALLOWLIST.some((x) => x.method === 'PATCH' && x.re.test('/attention/tg-1'))).toBe(false);
    for (const p of ['/mobile/attention/../choice', '/mobile/attention/./choice', '/mobile/attention/.../choice']) expect(DEVICE_ALLOWLIST.some((x) => x.re.test(p)), p).toBe(false);
  });
});
