/**
 * Every Ask Is Actionable — GET /attention stamps each item with the one tap the
 * operator has for it (src/messaging/attentionAction.ts), or null when there is none.
 * The console's shared count reads that field: a null-action item is the agent's, not
 * an ask. Full HTTP pipeline through createRoutes with a stub attention store.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';

function makeApp(seed: Array<Record<string, unknown>>) {
  const now = new Date().toISOString();
  const items = seed.map((s) => ({ summary: '', status: 'OPEN', createdAt: now, updatedAt: now, ...s }));
  const app = express();
  app.use(express.json());
  app.use(createRoutes({
    config: { authToken: '', stateDir: '/tmp', port: 0 },
    messagingToneGate: null, outboundDedupGate: null, topicIntentArcCheck: null, topicMemory: null,
    telegram: {
      createAttentionItem: async (item: Record<string, unknown>) => { const row = { ...item, status: 'OPEN', createdAt: now, updatedAt: now }; items.push(row as never); return row; },
      getAttentionItems: (status?: string) => (status ? items.filter((i) => i.status === status) : items),
      getAttentionItem: (id: string) => items.find((i) => i.id === id),
    },
  } as any));
  return app;
}

describe('GET /attention carries each item’s one tap', () => {
  it('an item with a console place gets an open action to the exact place; one without gets null', async () => {
    const app = makeApp([
      { id: 'telegram-origin-held:57692', title: 'Reply to topic 57692 is held', category: 'telegram-origin', priority: 'HIGH' },
      { id: 'agent:kmem-1', title: 'Kernel memory is high', category: 'general', priority: 'HIGH' },
    ]);
    const res = await request(app).get('/attention').expect(200);
    const byId = Object.fromEntries(res.body.items.map((i: { id: string }) => [i.id, i]));
    expect(byId['telegram-origin-held:57692'].action).toEqual({ kind: 'open', label: 'Review held replies', href: '#/people/messages?s=held&item=telegram-origin-held%3A57692' });
    expect(byId['agent:kmem-1']).toHaveProperty('action', null);
  });

  it('a producer-supplied action is kept when valid and refused when it points off the console', async () => {
    const app = makeApp([
      { id: 'p1', title: 'Approve the slip', category: 'general', priority: 'HIGH', action: { kind: 'open', href: '#/people/mandates?s=waiting', label: 'Approve the slip' } },
      { id: 'p2', title: 'Phish', category: 'general', priority: 'HIGH', action: { kind: 'open', href: 'https://evil.example', label: 'Go' } },
    ]);
    const res = await request(app).get('/attention').expect(200);
    const byId = Object.fromEntries(res.body.items.map((i: { id: string }) => [i.id, i]));
    expect(byId.p1.action.href).toBe('#/people/mandates?s=waiting');
    expect(byId.p2.action).toBeNull();
  });

  it('POST /attention keeps a valid producer action and refuses one that points off the console', async () => {
    const app = makeApp([]);
    await request(app).post('/attention').send({ id: 'slip-1', title: 'Approve the slip', summary: 's', category: 'general', priority: 'HIGH',
      action: { kind: 'open', href: '#/people/mandates?s=waiting', label: 'Approve the slip' } }).expect(201);
    const bad = await request(app).post('/attention').send({ id: 'slip-2', title: 'x', summary: 's', category: 'general', priority: 'HIGH',
      action: { kind: 'open', href: 'https://evil.example', label: 'Go' } });
    expect(bad.status).toBe(400);
    const res = await request(app).get('/attention').expect(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual(['slip-1']);
    expect(res.body.items[0].action).toEqual({ kind: 'open', href: '#/people/mandates?s=waiting', label: 'Approve the slip' });
  });
});
