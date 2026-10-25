import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';

type StubItem = {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'DONE' | 'WONT_DO';
  sourceContext?: string;
  createdAt: string;
  updatedAt: string;
};

function makeApp() {
  const items = new Map<string, StubItem>();
  const capturedCreates: any[] = [];
  const app = express();
  app.use(express.json());
  app.use(createRoutes({
    config: { authToken: '', stateDir: '/tmp', port: 0 },
    messagingToneGate: null,
    outboundDedupGate: null,
    topicIntentArcCheck: null,
    topicMemory: null,
    telegram: {
      createAttentionItem: async (item: Omit<StubItem, 'createdAt' | 'updatedAt' | 'status'>) => {
        capturedCreates.push(item);
        const now = new Date().toISOString();
        const stored: StubItem = { ...item, status: 'OPEN', createdAt: now, updatedAt: now };
        items.set(stored.id, stored);
        return stored;
      },
      getAttentionItems: (status?: string) => {
        const values = [...items.values()];
        return status ? values.filter(i => i.status === status) : values;
      },
      getAttentionItem: (id: string) => items.get(id),
      updateAttentionStatus: async (id: string, status: StubItem['status']) => {
        const item = items.get(id);
        if (!item) return false;
        item.status = status;
        item.updatedAt = new Date().toISOString();
        return true;
      },
    },
  } as any));
  return { app, items, capturedCreates };
}

describe('Attention route vocabulary compatibility', () => {
  it('applies every documented bound alias while an unbounded read returns the full population', async () => {
    const { app } = makeApp();
    for (const id of ['a', 'b', 'c']) {
      await request(app).post('/attention').send({ id, title: id, summary: id, category: 'general', priority: 'NORMAL' }).expect(201);
    }

    for (const key of ['limit', 'count', 'take', 'pageSize']) {
      const bounded = await request(app).get('/attention').query({ [key]: 2 }).expect(200);
      expect(bounded.body.count).toBe(2);
      expect(bounded.body.items.map((x: StubItem) => x.id)).toEqual(['a', 'b']);
    }
    const unbounded = await request(app).get('/attention').expect(200);
    expect(unbounded.body.count).toBe(3);
  });

  it('accepts documented POST aliases and stores canonical priority/source fields', async () => {
    const { app, capturedCreates } = makeApp();

    const res = await request(app)
      .post('/attention')
      .send({
        id: 'att-alias-create',
        title: 'Alias create',
        body: 'Created with the documented body field.',
        category: 'general',
        priority: 'medium',
        source: 'route-test',
      });

    expect(res.status).toBe(201);
    expect(capturedCreates[0]).toMatchObject({
      id: 'att-alias-create',
      summary: 'Created with the documented body field.',
      priority: 'NORMAL',
      sourceContext: 'route-test',
    });
  });

  it('accepts documented resolved status and exposes canonical DONE on readback', async () => {
    const { app } = makeApp();
    await request(app)
      .post('/attention')
      .send({
        id: 'att-resolve',
        title: 'Resolve me',
        summary: 'Needs resolving.',
        category: 'general',
        priority: 'NORMAL',
      })
      .expect(201);

    const patched = await request(app)
      .patch('/attention/att-resolve')
      .send({ status: 'resolved' })
      .expect(200);

    expect(patched.body.status).toBe('DONE');

    const filtered = await request(app)
      .get('/attention?status=resolved')
      .expect(200);

    expect(filtered.body.count).toBe(1);
    expect(filtered.body.items[0].id).toBe('att-resolve');
    expect(filtered.body.items[0].status).toBe('DONE');
  });
});
