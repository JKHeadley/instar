/**
 * B22_SURFACE_REFERRAL through the real POST /telegram/reply route
 * (docs/specs/operator-needs-first-screen.md §6). Only the IntelligenceProvider is mocked:
 * the route, the signal, the gate, the disposition map and the 422 plumbing are real.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const NUDGE = { pass: false, rule: 'B22_SURFACE_REFERRAL', issue: 'No link.', suggestion: 'Add the link and load the page.' };
const PASS = { pass: true, rule: '', issue: '', suggestion: '' };
const REDRIVE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const REFERRAL = 'Open the Development page and turn it back on.';

describe('B22_SURFACE_REFERRAL through POST /telegram/reply', () => {
  let close: () => Promise<void> = async () => {};
  afterEach(async () => { await close(); });

  async function start(verdict: (prompt: string) => typeof NUDGE | typeof PASS) {
    const sent: string[] = [];
    const prompts: string[] = [];
    const provider = { evaluate: vi.fn(async (prompt: string) => { prompts.push(prompt); return JSON.stringify(verdict(prompt)); }) } as unknown as IntelligenceProvider;
    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 'test', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'b22-route-')), port: 0, projectName: 'test', projectDir: os.tmpdir() },
      messagingToneGate: new MessagingToneGate(provider),
      telegram: { sendToTopic: async (_t: number, text: string) => { sent.push(text); } },
      sessionManager: { clearInjectionTracker: () => {} },
      pendingRelayLookup: (id: string) => id === REDRIVE_ID,
    };
    app.use(createRoutes(ctx));
    const srv = app.listen(0);
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => srv.close(() => r()));
    const reply = async (text: string, metadata?: Record<string, unknown>, headers: Record<string, string> = {}) => {
      const res = await fetch(`${url}/telegram/reply/42`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(metadata ? { text, metadata } : { text }) });
      return { status: res.status, body: await res.json().catch(() => ({})) as any };
    };
    return { reply, sent, prompts };
  }

  it('the signal reaches the authority, and a citation is handed back as a nudge, unsent', async () => {
    const h = await start(() => NUDGE);
    const r = await h.reply(REFERRAL);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('tone-gate-advisory');
    expect(r.body.notSent).toBe(true);
    expect(h.sent).toEqual([]);
    expect(h.prompts[0]).toContain('hasLink=false hasOnScreenWords=false renderConfirmed=false');
  });

  it('a resend declaring it complied tells the authority rendering was confirmed, and sends', async () => {
    const h = await start((p) => (p.includes('renderConfirmed=true') ? PASS : NUDGE));
    expect((await h.reply(REFERRAL)).status).toBe(422);
    const r = await h.reply(REFERRAL, { toneAdvisoryComplied: 'B22_SURFACE_REFERRAL' });
    expect(r.status).toBe(200);
    expect(h.sent).toEqual([REFERRAL]);
  });

  it('an override with a reason sends unchanged', async () => {
    const h = await start(() => NUDGE);
    const r = await h.reply(REFERRAL, { toneAdvisoryAck: 'B22_SURFACE_REFERRAL', toneAdvisoryAckReason: 'no browser on this machine' });
    expect(r.status).toBe(200);
    expect(h.sent).toEqual([REFERRAL]);
  });

  it('a message that sends nobody anywhere carries no signal', async () => {
    const h = await start(() => PASS);
    await h.reply('The merge finished at 6pm.');
    expect(h.prompts[0]).not.toContain('surface-referral detector (signal-only');
  });

  it('a sentinel redrive has nobody to react, so the signal is withheld and it is not held', async () => {
    const h = await start((p) => (p.includes('surface-referral detector (signal-only') ? NUDGE : PASS));
    const r = await h.reply(REFERRAL, undefined, { 'X-Instar-DeliveryId': REDRIVE_ID });
    expect(r.status).toBe(200);
    expect(h.sent).toEqual([REFERRAL]);
  });

  it('a made-up delivery id buys nothing', async () => {
    const h = await start((p) => (p.includes('surface-referral detector (signal-only') ? NUDGE : PASS));
    const r = await h.reply(REFERRAL, undefined, { 'X-Instar-DeliveryId': 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee' });
    expect(r.status).toBe(422);
  });
});
