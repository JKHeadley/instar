/**
 * E2E (HTTP) test for the Agent-Health lane at the POST /attention route.
 *
 * Verifies the feature is alive end-to-end over real HTTP:
 *   1. A self-health notice (lane:'agent-health') flows through the route to
 *      createAttentionItem WITH its `lane` + `healthKey` intact (201).
 *   2. Lane notices BYPASS the per-topic tone-gate (they don't spawn a topic;
 *      they go to the calm lane), so a well-formed heads-up can never be
 *      silently 422'd — the gate is NOT invoked for lane items.
 *   3. A non-lane degradation item still runs through the tone-gate (existing
 *      behavior preserved, no regression).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MessagingToneGate, type ToneReviewContext } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

function makeProvider(pass: boolean): IntelligenceProvider {
  return { evaluate: vi.fn(async () => JSON.stringify({ pass, rule: '', issue: '', suggestion: '' })) } as unknown as IntelligenceProvider;
}

describe('POST /attention — Agent-Health lane (E2E over HTTP)', () => {
  let server: TestServer;
  let recordedToneCalls: ToneReviewContext[];
  let createdItems: Array<Record<string, unknown>>;

  function buildApp(toneGate: MessagingToneGate) {
    const orig = toneGate.review.bind(toneGate);
    toneGate.review = async (text: string, context: ToneReviewContext) => { recordedToneCalls.push(context); return orig(text, context); };
    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 'test', stateDir: '/tmp', port: 0 },
      messagingToneGate: toneGate,
      telegram: {
        createAttentionItem: async (item: Record<string, unknown>) => {
          createdItems.push(item);
          return { ...item, status: 'OPEN', createdAt: 'now', updatedAt: 'now', topicId: 999, coalesced: item.lane === 'agent-health' };
        },
      },
    };
    app.use(createRoutes(ctx));
    return app;
  }

  async function api(body: object) {
    const res = await fetch(server.url + '/attention', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  beforeEach(() => { recordedToneCalls = []; createdItems = []; });
  afterEach(async () => { await server?.close(); });

  it('routes a lane notice with lane+healthKey intact, bypassing the tone-gate (201)', async () => {
    server = await listen(buildApp(new MessagingToneGate(makeProvider(true))));
    const r = await api({
      id: 'stale-abc-1',
      healthKey: 'stale-abc',
      lane: 'agent-health',
      title: 'Heads-up on the "EXO 3.0" session',
      summary: 'It hasn\'t shown progress. Reply "check EXO 3.0" and I\'ll look.',
      category: 'degradation',
      priority: 'NORMAL',
    });
    expect(r.status).toBe(201);
    expect(createdItems).toHaveLength(1);
    expect(createdItems[0].lane).toBe('agent-health');
    expect(createdItems[0].healthKey).toBe('stale-abc');
    // Tone-gate NOT invoked for lane items (they don't spawn a per-item topic).
    expect(recordedToneCalls).toHaveLength(0);
  });

  it('a lane notice is delivered even when the gate WOULD have blocked it', async () => {
    // Gate set to block — a non-lane item would 422. The lane item must still 201.
    server = await listen(buildApp(new MessagingToneGate(makeProvider(false))));
    const r = await api({
      id: 'stale-def-1', healthKey: 'stale-def', lane: 'agent-health',
      title: 'Heads-up on the "Worker" session', summary: 'maybe stuck. Reply "check Worker".',
      category: 'degradation', priority: 'NORMAL',
    });
    expect(r.status).toBe(201);
    expect(createdItems).toHaveLength(1);
    expect(recordedToneCalls).toHaveLength(0);
  });

  it('a NON-lane degradation item still runs through the tone-gate (no regression)', async () => {
    server = await listen(buildApp(new MessagingToneGate(makeProvider(true))));
    const r = await api({
      id: 'degr-1', title: 'Degradation: something', summary: 'A thing degraded. Want me to dig in?',
      category: 'degradation', priority: 'NORMAL',
    });
    expect(r.status).toBe(201);
    expect(createdItems).toHaveLength(1);
    expect(createdItems[0].lane).toBeUndefined();
    // The gate WAS consulted for the non-lane path.
    expect(recordedToneCalls.length).toBeGreaterThan(0);
  });
});
