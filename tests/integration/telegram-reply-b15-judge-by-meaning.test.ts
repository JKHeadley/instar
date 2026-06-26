/**
 * Integration test — gate-prompts-judge-by-meaning through the real
 * POST /telegram/reply route (Tier 2 of the Testing Integrity Standard).
 *
 * Proves end-to-end (real route + real gate + real 422/suppress plumbing; only
 * the IntelligenceProvider is mocked to drive the verdict deterministically):
 *   1. A B15 self-stop block (the paraphrased incident) → 422 tone-gate-blocked,
 *      rule=B15, and the message is SUPPRESSED (not sent).
 *   2. The §Design 1 structured-intermediate flows end-to-end: a model that
 *      returns pass:true but structured fields flagging an agent-state stop is
 *      DERIVED to a B15 block at the route (suppressed).
 *   3. F4 graceful degradation: when the provider throws (LLM-backend outage)
 *      with failClosedOnExhaustion unset, the route DEGRADES to the deterministic
 *      leak floor end-to-end — a clean message SENDS (200), a leak HOLDS (422),
 *      and the operator strict override restores pure-hold. (Replaces the prior
 *      pure-fail-closed assertion; tone-gate-graceful-degradation, postmortem F4.)
 *   4. The happy path still delivers (200) — the rule does not over-block.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
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

function providerReturning(json: object): IntelligenceProvider {
  return { evaluate: vi.fn(async () => JSON.stringify(json)) } as unknown as IntelligenceProvider;
}
function providerThrowing(): IntelligenceProvider {
  return { evaluate: vi.fn(async () => { throw new Error('provider down'); }) } as unknown as IntelligenceProvider;
}

function buildApp(toneGate: MessagingToneGate, sent: Array<{ topicId: number; text: string }>): express.Express {
  const app = express();
  app.use(express.json());
  const ctx: any = {
    config: { authToken: 'test', stateDir: '/tmp', port: 0, projectName: 'echo' },
    messagingToneGate: toneGate,
    telegram: { sendToTopic: async (topicId: number, text: string) => { sent.push({ topicId, text }); } },
    sessionManager: { clearInjectionTracker: () => {} },
  };
  app.use(createRoutes(ctx));
  return app;
}

describe('gate-prompts-judge-by-meaning — POST /telegram/reply integration', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  async function reply(topicId: number, text: string) {
    const res = await fetch(`${server.url}/telegram/reply/${topicId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('suppresses a B15 self-stop (paraphrased incident) — 422, not sent', async () => {
    const provider = providerReturning({
      pass: false,
      rule: 'B15_CONTEXT_DEATH_STOP',
      issue: 'proposes stopping for an agent-state (fresh/tired) reason',
      suggestion: 'continue the work; reserve a stop for a genuine external blocker or completion',
    });
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp(new MessagingToneGate(provider), sent));
    const r = await reply(28130, 'Fresh focus would serve this better — picking it up at the tail of a long run isn\'t ideal.');
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('tone-gate-blocked');
    expect(r.body.rule).toBe('B15_CONTEXT_DEATH_STOP');
    expect(sent.length).toBe(0);
  });

  it('DERIVES a B15 block from the structured intermediate even when the model set pass:true — 422, not sent', async () => {
    const provider = providerReturning({
      pass: true,
      rule: '',
      issue: '',
      suggestion: '',
      structured: { proposed_stop: true, deferred_items: ['the auto-recovery layer'], stop_reason_kind: 'agent-state', agent_state_reason_present: true, external_blocker_present: false },
    });
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp(new MessagingToneGate(provider), sent));
    const r = await reply(28130, 'Shipped the detector. Giving the auto-recovery layer fresh focus rather than starting it tired.');
    expect(r.status).toBe(422);
    expect(r.body.rule).toBe('B15_CONTEXT_DEATH_STOP');
    expect(sent.length).toBe(0);
  });

  // tone-gate-graceful-degradation F4: when the provider throws (LLM-backend
  // outage) with failClosedOnExhaustion UNSET (the default), the route DEGRADES
  // to the in-process deterministic leak floor end-to-end — a CLEAN message
  // SENDS (200; the user is never silently cut off) while a real leak still
  // HOLDS (422). Operators restore pure-hold with failClosedOnExhaustion:true.
  it('F4: provider throws + CLEAN message → DEGRADE-SEND end-to-end (200, delivered)', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp(new MessagingToneGate(providerThrowing()), sent));
    const r = await reply(28130, 'any outbound message');
    expect(r.status).toBe(200); // degrade-send — the floor passed a clean message
    expect(sent).toEqual([{ topicId: 28130, text: 'any outbound message' }]);
  });

  it('F4: provider throws + LEAK → still HELD end-to-end (422), degrade is not a blanket pass', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp(new MessagingToneGate(providerThrowing()), sent));
    const r = await reply(28130, 'see .instar/config.json');
    expect(r.status).toBe(422); // a real leak is held even on the degrade path
    expect(sent.length).toBe(0);
  });

  it('F4 operator override: failClosedOnExhaustion:true + provider throws → pure-HOLD even for clean (422)', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp(new MessagingToneGate(providerThrowing(), { failClosedOnExhaustion: true }), sent));
    const r = await reply(28130, 'any outbound message');
    expect(r.status).toBe(422); // strict mode restores the legacy fail-closed hold
    expect(sent.length).toBe(0);
  });

  it('delivers a genuine completion report (200) — does not over-block', async () => {
    const provider = providerReturning({ pass: true, rule: '', issue: '', suggestion: '' });
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp(new MessagingToneGate(provider), sent));
    const r = await reply(28130, 'Done — the new rule is merged to main and live.');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(sent).toEqual([{ topicId: 28130, text: 'Done — the new rule is merged to main and live.' }]);
  });
});
