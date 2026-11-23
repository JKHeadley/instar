import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import { mountNeedsRoutes, type NeedsSelfRead } from '../../src/server/needsRoutes.js';

const view = { enabled: true, show: true, heldBack: false, evidenceComplete: true, fingerprint: '0123456789abcdef', dismissed: false,
  rows: [{ machineId: 'm_0123456789abcdef', name: 'Old Laptop', silentSince: '2026-11-01T00:00:00Z', confirmedGone: false },
    { machineId: 'm_fedcba9876543210', name: 'Old Mini', silentSince: '2026-11-02T00:00:00Z', confirmedGone: true }] };
function appFor(answer: NeedsSelfRead) {
  const app = express();
  mountNeedsRoutes(app, {
    read: async p => p === '/pin-budget/silent-machines' ? answer : { status: 503, body: { error: 'off' } },
    bearerOk: req => req.get('Authorization') === 'Bearer test-owner',
    boardFor: () => { throw new Error('unexpected member read'); },
    consoleDir: path.resolve('dashboard/console'), agentName: () => 'Echo', machineId: () => 'm_self',
  });
  return app;
}
describe('silent computer source through the Needs HTTP pipeline', () => {
  it('returns one pooled item pointing at the actual review panel, without displaying ids', async () => {
    const app = appFor({ status: 200, body: view });
    expect((await request(app).get('/needs')).status).toBe(403);
    const res = await request(app).get('/needs').set('Authorization', 'Bearer test-owner');
    expect(res.status).toBe(200);
    const rows = res.body.items.filter((r: { source: string }) => r.source === 'machine-retirement');
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toEqual({ kind: 'href', href: '#/capacity/machines?review=silent' });
    expect(rows[0].why).toContain('Old Laptop, Old Mini');
    expect(JSON.stringify(rows)).not.toContain('m_0123456789abcdef');
  });
  it.each([{ enabled: false }, { ...view, show: false, dismissed: true }])('does not count an off or dismissed reminder', async body => {
    const res = await request(appFor({ status: 200, body })).get('/needs').set('Authorization', 'Bearer test-owner');
    expect(res.status).toBe(200);
    expect(res.body.items.filter((r: { source: string }) => r.source === 'machine-retirement')).toEqual([]);
  });
  it.each([true, false])('reports incomplete pooled evidence while preserving known rows (show=%s)', async show => {
    const res = await request(appFor({ status: 200, body: { ...view, show, evidenceComplete: false } })).get('/needs').set('Authorization', 'Bearer test-owner');
    expect(res.status).toBe(200);
    expect(res.body.complete).toBe(false);
    expect(res.body.couldNotCheck).toContain('computers that have been silent');
    expect(res.body.items.filter((r: { source: string }) => r.source === 'machine-retirement')).toHaveLength(show ? 1 : 0);
  });
  it('names an unreadable source rather than claiming it is clear', async () => {
    const res = await request(appFor({ status: 500, body: {} })).get('/needs').set('Authorization', 'Bearer test-owner');
    expect(res.status).toBe(200);
    expect(res.body.complete).toBe(false);
    expect(res.body.couldNotCheck).toContain('computers that have been silent');
  });
});
