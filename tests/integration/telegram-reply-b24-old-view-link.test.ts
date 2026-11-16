/**
 * B24_OLD_VIEW_LINK through the real POST /telegram/reply route (instar-document-viewer §3.9b).
 * Only the IntelligenceProvider is mocked: the route, the signal, the gate and the 422 plumbing are real.
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

const NUDGE = { pass: false, rule: 'B24_OLD_VIEW_LINK', issue: 'Old-style page link.', suggestion: 'Make it a document.' };
const PASS = { pass: true, rule: '', issue: '', suggestion: '' };
const ID = '87217124-385f-4047-a28c-8eecfc82d279';
const SIG = '940d7b14165a8275a2e955e6a802d9dd90a92e215fe40d7545ea22e24cb97004';
const HOST = ['https://', 'mini', '.example', '.dev'].join('');
const WITH_LINK = `The full list: ${HOST}/view/${ID}?sig=${SIG}`;

describe('B24_OLD_VIEW_LINK through POST /telegram/reply', () => {
  let close: () => Promise<void> = async () => {};
  afterEach(async () => { await close(); });

  async function start(replacing: boolean, verdict: (prompt: string) => typeof NUDGE | typeof PASS) {
    const sent: string[] = [];
    const prompts: string[] = [];
    const provider = { evaluate: vi.fn(async (prompt: string) => { prompts.push(prompt); return JSON.stringify(verdict(prompt)); }) } as unknown as IntelligenceProvider;
    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 'test', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'b24-route-')), port: 0, projectName: 'test', projectDir: os.tmpdir() },
      messagingToneGate: new MessagingToneGate(provider),
      telegram: { sendToTopic: async (_t: number, text: string) => { sent.push(text); return { messageId: sent.length, topicId: _t }; } },
      sessionManager: { clearInjectionTracker: () => {} },
      documentsReplaceViews: () => replacing,
    };
    app.use(createRoutes(ctx));
    const srv = app.listen(0);
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => srv.close(() => r()));
    const reply = async (text: string, metadata?: Record<string, unknown>) => {
      const res = await fetch(`${url}/telegram/reply/42`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata ? { text, metadata } : { text }) });
      return { status: res.status, body: await res.json().catch(() => ({})) as any };
    };
    return { reply, sent, prompts };
  }

  it('while documents replace pages, an old-style link is signalled and a citation hands the message back unsent', async () => {
    const h = await start(true, () => NUDGE);
    const r = await h.reply(WITH_LINK);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('tone-gate-advisory');
    expect(r.body.notSent).toBe(true);
    expect(h.sent).toEqual([]);
    expect(h.prompts[0]).toContain('old-style-page-link detector (signal-only, anchors B24_OLD_VIEW_LINK)');
    expect(h.prompts[0]).toContain(`/view/${ID}"`);
    expect(h.prompts[0]).toContain('B24_OLD_VIEW_LINK** — JUDGE BY MEANING');
  });

  it('an override with a reason sends unchanged', async () => {
    const h = await start(true, () => NUDGE);
    const r = await h.reply(WITH_LINK, { toneAdvisoryAck: 'B24_OLD_VIEW_LINK', toneAdvisoryAckReason: 'he asked where the old page was' });
    expect(r.status).toBe(200);
    expect(h.sent).toEqual([WITH_LINK]);
  });

  it('when documents do not replace pages, the same message carries no signal and no rule', async () => {
    const h = await start(false, () => PASS);
    expect((await h.reply(WITH_LINK)).status).toBe(200);
    expect(h.prompts[0]).not.toContain('B24_OLD_VIEW_LINK');
  });

  it('a message with no old-style link carries no signal', async () => {
    const h = await start(true, () => PASS);
    await h.reply(`The document: ${HOST}/docs/${ID}`);
    expect(h.prompts[0]).not.toContain('B24_OLD_VIEW_LINK');
  });
});
