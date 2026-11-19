/**
 * The owner-only clear of a helper machine's main quarantine (SEC-113 D2.5): the dashboard operator
 * session is required, the Bearer token alone is refused, a missing session check answers 503, and a
 * standby answers 409 naming the lease holder.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { registerLocalVerifyRoutes } from '../../../src/localVerify/localVerifyRoutes.js';
import type { LocalVerifyService } from '../../../src/localVerify/LocalVerifyService.js';

function app(o: { verify?: ((t: string | undefined) => boolean) | null; holds?: boolean } = {}) {
  const cleared: string[] = [];
  const svc = { clearMainQuarantine: (id: string) => { cleared.push(id); return { cleared: true }; } } as unknown as LocalVerifyService;
  const a = express();
  a.use(express.json());
  const router = express.Router();
  registerLocalVerifyRoutes(router, {
    service: () => svc,
    lease: { holdsLease: () => o.holds ?? true, holderMachineId: () => 'm_studio' },
    ...(o.verify === null ? {} : { verifyOperatorSession: o.verify ?? ((t) => t === 'good-session') }),
  });
  a.use(router);
  return { a, cleared };
}

const PATH = '/local-verify/peers/m_peer/main-quarantine/clear';

describe('POST /local-verify/peers/:machineId/main-quarantine/clear', () => {
  it('clears with a verified operator session', async () => {
    const { a, cleared } = app();
    const r = await request(a).post(PATH).set('X-Instar-Operator-Session', 'good-session').send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ cleared: true });
    expect(cleared).toEqual(['m_peer']);
  });

  it('refuses without a session or with a bad one (the Bearer token alone is never enough)', async () => {
    const { a, cleared } = app();
    expect((await request(a).post(PATH).set('Authorization', 'Bearer t').send({})).status).toBe(401);
    expect((await request(a).post(PATH).set('X-Instar-Operator-Session', 'forged').send({})).status).toBe(401);
    expect(cleared).toEqual([]);
  });

  it('answers 503 when the session check is not wired, and never falls back', async () => {
    const { a, cleared } = app({ verify: null });
    const r = await request(a).post(PATH).set('X-Instar-Operator-Session', 'good-session').send({});
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'operator-session-unavailable' });
    expect(cleared).toEqual([]);
  });

  it('a throwing session check refuses', async () => {
    const { a } = app({ verify: () => { throw new Error('boom'); } });
    expect((await request(a).post(PATH).set('X-Instar-Operator-Session', 'good-session').send({})).status).toBe(401);
  });

  it('a standby answers 409 naming the holder', async () => {
    const { a, cleared } = app({ holds: false });
    const r = await request(a).post(PATH).set('X-Instar-Operator-Session', 'good-session').send({});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'not-lease-holder', holderMachineId: 'm_studio' });
    expect(cleared).toEqual([]);
  });

  it('refuses a malformed machine id', async () => {
    const { a } = app();
    expect((await request(a).post('/local-verify/peers/a%20b/main-quarantine/clear').set('X-Instar-Operator-Session', 'good-session').send({})).status).toBe(400);
  });
});
