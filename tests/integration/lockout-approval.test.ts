import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mountLockoutRoutes } from '../../src/server/lockoutRoutes.js';
const digest = 'a'.repeat(64);
describe('operator-only one-action approval HTTP pipeline', () => {
  function fixture() {
    let clock = 1000; let pinCalls = 0;
    const app = express(); app.use(express.json());
    mountLockoutRoutes(app, (req, res) => { pinCalls++; if (req.body?.pin === '123456') return true; res.status(403).json({ error: 'operator PIN required' }); return false; }, p => `http://localhost${p}`, () => clock);
    return { app, pinCalls: () => pinCalls, expire: () => { clock += 300_000; } };
  }
  it('rejects Bearer-only self-approval, approves once, rejects a different action and replay', async () => {
    const { app } = fixture();
    const { body: r } = await request(app).post('/lockout/request').send({ action: digest });
    await request(app).post('/lockout/consume').send({ id: r.id, action: digest }).expect(403);
    await request(app).post(`/lockout/approve/${r.id}`).set('Authorization', 'Bearer agent').send({ approved: true }).expect(403);
    const page = await request(app).get(`/lockout/approve/${r.id}`).expect(200);
    expect(page.text).toContain('Approve one action');
    await request(app).post(`/lockout/approve/${r.id}`).send({ pin: '123456' }).expect(200);
    await request(app).post('/lockout/consume').send({ id: r.id, action: 'b'.repeat(64) }).expect(403);
    await request(app).post('/lockout/consume').send({ id: r.id, action: digest }).expect(200);
    await request(app).post('/lockout/consume').send({ id: r.id, action: digest }).expect(403);
  });
  it('unknown ids cannot consume the operator PIN attempt budget', async () => {
    const { app, pinCalls } = fixture();
    await request(app).post('/lockout/approve/11111111-1111-1111-1111-111111111111').send({ pin: 'wrong' }).expect(404);
    expect(pinCalls()).toBe(0);
  });
  it('rejects an expired approval', async () => {
    const { app, expire } = fixture();
    const { body: r } = await request(app).post('/lockout/request').send({ action: digest });
    await request(app).post(`/lockout/approve/${r.id}`).send({ pin: '123456' }).expect(200);
    expire();
    await request(app).post('/lockout/consume').send({ id: r.id, action: digest }).expect(403);
  });
});
