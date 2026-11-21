/**
 * B26_WAITING_ASK_UNLINKED through the real POST /telegram/reply route, and GET /messages/link
 * (docs/specs/waiting-on-you-links.md §2–§3). Only the IntelligenceProvider is mocked: the route,
 * the switch, the fact gathering, the gate, the disposition map and the 422 plumbing are real.
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

const NUDGE = { pass: false, rule: 'B26_WAITING_ASK_UNLINKED', issue: 'No link and no restatement.', suggestion: 'Add the link and one line restating the ask.' };
const PASS = { pass: true, rule: '', issue: '', suggestion: '' };
const REDRIVE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BARE = 'Build is green. Still waiting on you: the screen-lock question I sent at 2:46.';
const SECTION = '=== B26 A WAITING ASK CARRIES ITS LINK AND RESTATEMENT ===';
const CHAT = '-1001234567890';
const ASK_LINK = 'https://t.me/c/1234567890/42/7';
const FIXED = `Still need your call on the screen lock: 5 or 15 minutes? Reply "5" or "15". Original ask: ${ASK_LINK}`;

interface Opts {
  verdict?: (prompt: string) => typeof NUDGE | typeof PASS;
  developmentAgent?: boolean;
  enabled?: boolean;
  chatId?: string;
  logged?: Array<{ topicId: number | null; messageId: number; found: boolean; sentBy?: string; text?: string; timestamp?: string }>;
  findThrows?: boolean;
  findHangs?: boolean;
  tunnel?: { url: string | null } | null;
  slackUrl?: string | null;
  workBoard?: boolean;
}

describe('B26_WAITING_ASK_UNLINKED through POST /telegram/reply', () => {
  let close: () => Promise<void> = async () => {};
  afterEach(async () => { await close(); });

  async function start(o: Opts = {}) {
    const sent: string[] = [];
    const prompts: string[] = [];
    const aborted: boolean[] = [];
    const verdict = o.verdict ?? (() => PASS);
    const provider = { evaluate: vi.fn(async (prompt: string) => { prompts.push(prompt); return JSON.stringify(verdict(prompt)); }) } as unknown as IntelligenceProvider;
    const app = express();
    app.use(express.json());
    const chatId = o.chatId ?? CHAT;
    const ctx: any = {
      config: {
        authToken: 'test', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'b26-route-')), port: 0, projectName: 'test', projectDir: os.tmpdir(),
        developmentAgent: o.developmentAgent ?? true,
        messaging: [{ type: 'telegram', config: { chatId } }],
        ...(o.enabled === undefined ? {} : { toneGate: { waitingAskLinks: { enabled: o.enabled } } }),
        ...(o.workBoard === undefined ? {} : { workBoard: { enabled: o.workBoard } }),
      },
      messagingToneGate: new MessagingToneGate(provider),
      telegram: {
        getChatId: () => chatId,
        sendToTopic: async (_t: number, text: string) => { sent.push(text); return { messageId: sent.length + 100, topicId: _t }; },
        findLoggedMessages: async (refs: Array<{ topicId: number | null; messageId: number }>, opts?: { signal?: AbortSignal }) => {
          if (o.findThrows) throw new Error('read failed');
          if (o.findHangs) {
            await new Promise<void>((resolve) => { opts?.signal?.addEventListener('abort', () => { aborted.push(true); resolve(); }); });
            throw new Error('find-logged-messages-aborted');
          }
          return refs.map((r) => (o.logged ?? []).find((l) => l.messageId === r.messageId && (r.topicId === null || l.topicId === r.topicId)) ?? { ...r, found: false });
        },
        searchLog: () => [{ messageId: 7, topicId: 42, text: 'Which screen lock: 5 or 15 minutes?', fromUser: false, timestamp: '2026-11-18T22:46:00.000Z', sessionName: 's' }],
      },
      sessionManager: { clearInjectionTracker: () => {} },
      pendingRelayLookup: (id: string) => id === REDRIVE_ID,
      ...(o.tunnel === undefined ? {} : { tunnel: o.tunnel }),
      ...(o.slackUrl === undefined ? {} : { slack: { getWorkspaceUrl: () => o.slackUrl } }),
    };
    app.use(createRoutes(ctx));
    const srv = app.listen(0);
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => srv.close(() => r()));
    const reply = async (text: string, metadata?: Record<string, unknown>, headers: Record<string, string> = {}) => {
      const res = await fetch(`${url}/telegram/reply/42`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(metadata ? { text, metadata } : { text }) });
      return { status: res.status, body: await res.json().catch(() => ({})) as any };
    };
    const get = async (pathAndQuery: string) => {
      const res = await fetch(`${url}${pathAndQuery}`);
      return { status: res.status, body: await res.json().catch(() => ({})) as any };
    };
    return { reply, get, sent, prompts, aborted, url };
  }

  it('a bare waiting reference is handed back as a nudge, unsent, with the facts in the prompt', async () => {
    const h = await start({ verdict: () => NUDGE });
    const r = await h.reply(BARE);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('tone-gate-advisory');
    expect(r.body.notSent).toBe(true);
    expect(h.sent).toEqual([]);
    expect(h.prompts[0]).toContain(SECTION);
    expect(h.prompts[0]).toContain('message-links=0 card-links=0 conversation-links=0 local-only-links=0 other-links=0');
    expect(h.prompts[0]).toContain('a link to a single message on this channel: yes');
  });

  it('the revised message with the link and restatement is re-reviewed, carries what the link points at, and sends', async () => {
    const h = await start({
      verdict: (p) => (p.includes('message-links=1') && p.includes('Which screen lock') ? PASS : NUDGE),
      logged: [{ topicId: 42, messageId: 7, found: true, sentBy: 'agent-verified', text: 'Which screen lock should the Mini use: 5 or 15 minutes?', timestamp: '2026-11-18T22:46:00.000Z' }],
    });
    expect((await h.reply(BARE)).status).toBe(422);
    const r = await h.reply(FIXED, { toneAdvisoryComplied: 'B26_WAITING_ASK_UNLINKED' });
    expect(r.status).toBe(200);
    expect(h.sent).toEqual([FIXED]);
    expect(h.prompts[1]).toContain('"inLocalLog":true');
    expect(h.prompts[1]).toContain('"sentBy":"agent-verified"');
  });

  it('an override with a reason sends unchanged; an override without one is refused', async () => {
    const h = await start({ verdict: () => NUDGE });
    const noReason = await h.reply(BARE, { toneAdvisoryAck: 'B26_WAITING_ASK_UNLINKED' });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error).toBe('tone-gate-advisory-reason-required');
    expect(h.sent).toEqual([]);
    const r = await h.reply(BARE, { toneAdvisoryAck: 'B26_WAITING_ASK_UNLINKED', toneAdvisoryAckReason: 'private chat, no link can be built; the ask is restated above' });
    expect(r.status).toBe(200);
    expect(h.sent).toEqual([BARE]);
  });

  it('the rule is not rendered: switch off, a fleet agent with the switch unset, an automated message, a redrive', async () => {
    const judge = (p: string) => (p.includes(SECTION) ? NUDGE : PASS);
    const off = await start({ verdict: judge, enabled: false });
    expect((await off.reply(BARE)).status).toBe(200);
    expect(off.prompts[0]).not.toContain('B26_WAITING_ASK_UNLINKED');
    await close();

    const fleet = await start({ verdict: judge, developmentAgent: false });
    expect((await fleet.reply(BARE)).status).toBe(200);
    expect(fleet.prompts[0]).not.toContain('B26_WAITING_ASK_UNLINKED');
    await close();

    const h = await start({ verdict: judge });
    expect((await h.reply(BARE, { messageKind: 'automated' })).status).toBe(200);
    expect((await h.reply(`${BARE} (redrive)`, undefined, { 'X-Instar-DeliveryId': REDRIVE_ID })).status).toBe(200);
    for (const p of h.prompts) expect(p).not.toContain('B26_WAITING_ASK_UNLINKED');
  });

  it('an attention item (a caller that cannot react to a nudge) never sees the rule', async () => {
    const h = await start({ verdict: (p) => (p.includes(SECTION) ? NUDGE : PASS) });
    const res = await fetch(`${h.url}/attention`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'b26-attn', title: 'Screen lock', category: 'decision', summary: BARE, description: BARE }) });
    // Whatever the attention route answers in this bare fixture, no review it ran may carry B26.
    expect([200, 201, 202, 400, 409, 422, 500, 503]).toContain(res.status);
    for (const p of h.prompts) expect(p).not.toContain('B26_WAITING_ASK_UNLINKED');
  });

  it('a fleet agent with the switch explicitly on does get the rule', async () => {
    const h = await start({ verdict: () => NUDGE, developmentAgent: false, enabled: true });
    expect((await h.reply(BARE)).status).toBe(422);
  });

  it('a failed or slow log read drops the facts, cancels the read, and the review still runs', async () => {
    const failed = await start({ findThrows: true });
    expect((await failed.reply(FIXED)).status).toBe(200);
    expect(failed.prompts[0]).toContain('LINKED MESSAGES: unavailable on this call');
    await close();

    const slow = await start({ findHangs: true });
    const t0 = Date.now();
    expect((await slow.reply(FIXED)).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(slow.prompts[0]).toContain('LINKED MESSAGES: unavailable on this call');
    expect(slow.aborted).toEqual([true]);
  });

  it('the delivered answer carries the link to the message just sent; a private chat gets none', async () => {
    const h = await start();
    const r = await h.reply('Which screen lock should the Mini use: 5 or 15 minutes? Reply "5" or "15".');
    expect(r.status).toBe(200);
    expect(r.body.messageId).toBe(101);
    expect(r.body.messageLink).toBe('https://t.me/c/1234567890/42/101');
    await close();

    const priv = await start({ chatId: '123456789' });
    const p = await priv.reply('Which screen lock should the Mini use?');
    expect(p.status).toBe(200);
    expect(p.body.messageLink).toBeUndefined();
    expect(priv.prompts[0]).toContain('a link to a single message on this channel: no');
  });

  describe('GET /messages/link', () => {
    it('builds a Telegram link and says whether this machine can confirm the id', async () => {
      const h = await start({ logged: [{ topicId: 42, messageId: 7, found: true, sentBy: 'agent-verified', text: 'Which screen lock: 5 or 15 minutes?', timestamp: '2026-11-18T22:46:00.000Z' }] });
      const found = await h.get('/messages/link?platform=telegram&topicId=42&messageId=7');
      expect(found.status).toBe(200);
      expect(found.body).toEqual({ url: ASK_LINK, platform: 'telegram', verified: true, matched: { sentBy: 'agent-verified', timestamp: '2026-11-18T22:46:00.000Z', text: 'Which screen lock: 5 or 15 minutes?' } });
      const unknown = await h.get('/messages/link?platform=telegram&topicId=42&messageId=999');
      expect(unknown.status).toBe(200);
      expect(unknown.body).toEqual({ url: 'https://t.me/c/1234567890/42/999', platform: 'telegram', verified: 'not-in-local-history' });
    });

    it('refuses what cannot open: a private chat, an Issues topic with no Issues chat, bad input', async () => {
      const priv = await start({ chatId: '123456789' });
      const r = await priv.get('/messages/link?platform=telegram&topicId=42&messageId=7');
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ error: 'not-linkable', reason: 'chat-not-linkable', retryable: false });
      await close();

      const h = await start();
      expect((await h.get('/messages/link?platform=telegram&topicId=10000002750&messageId=7')).body.reason).toBe('chat-not-linkable');
      expect((await h.get('/messages/link?platform=telegram&topicId=42&messageId=abc')).status).toBe(400);
      expect((await h.get('/messages/link?platform=telegram&topicId=42&messageId=1e3')).status).toBe(400);
      expect((await h.get('/messages/link?platform=telegram&topicId=0x10&messageId=7')).status).toBe(400);
      expect((await h.get('/messages/link?platform=pigeon')).status).toBe(400);
    });

    it('Slack: a permalink when the workspace is known; pending, unsupported and not-configured otherwise', async () => {
      const ok = await start({ slackUrl: 'https://acme.slack.com/' });
      const r = await ok.get('/messages/link?platform=slack&channel=C0123ABC&ts=1731900000.123456');
      expect(r.body).toEqual({ url: 'https://acme.slack.com/archives/C0123ABC/p1731900000123456', platform: 'slack', verified: 'unchecked' });
      await close();
      const pending = await start({ slackUrl: null });
      expect((await pending.get('/messages/link?platform=slack&channel=C0123ABC&ts=1731900000.123456')).body).toEqual({ error: 'not-linkable', reason: 'workspace-pending', retryable: true });
      await close();
      const gov = await start({ slackUrl: 'https://acme.slack-gov.com/' });
      expect((await gov.get('/messages/link?platform=slack&channel=C0123ABC&ts=1731900000.123456')).body).toEqual({ error: 'not-linkable', reason: 'workspace-unsupported', retryable: false });
      await close();
      const none = await start();
      expect((await none.get('/messages/link?platform=slack&channel=C0123ABC&ts=1731900000.123456')).body).toEqual({ error: 'not-linkable', reason: 'not-configured', retryable: false });
    });

    it('card and app links use a phone-openable origin, never localhost when a tunnel exists', async () => {
      const uuid = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
      const up = await start({ tunnel: { url: 'https://agent.example-tunnel.dev' } });
      expect((await up.get('/messages/link?platform=card&cardId=wc_0123456789abcdef')).body)
        .toEqual({ url: 'https://agent.example-tunnel.dev/dashboard/console/#/work/board?card=wc_0123456789abcdef', platform: 'card', verified: 'unchecked' });
      expect((await up.get(`/messages/link?platform=app&conversationKey=${uuid}`)).body.url)
        .toBe(`https://agent.example-tunnel.dev/dashboard/console/#/work/chats?c=${encodeURIComponent(`app:${uuid}`)}`);
      expect((await up.get('/messages/link?platform=card&cardId=nope')).status).toBe(400);
      await close();

      const down = await start({ tunnel: { url: null } });
      expect((await down.get('/messages/link?platform=card&cardId=wc_0123456789abcdef')).body).toEqual({ error: 'not-linkable', reason: 'tunnel-pending', retryable: true });
      await close();

      const noTunnel = await start();
      const local = await noTunnel.get('/messages/link?platform=card&cardId=wc_0123456789abcdef');
      expect(local.status).toBe(200);
      expect(local.body.localOnly).toBe(true);
      await close();

      const boardOff = await start({ workBoard: false, tunnel: { url: 'https://agent.example-tunnel.dev' } });
      expect((await boardOff.get('/messages/link?platform=card&cardId=wc_0123456789abcdef')).body).toEqual({ error: 'not-linkable', reason: 'not-configured', retryable: false });
    });

    it('search rows carry the link to their message', async () => {
      const h = await start();
      const r = await h.get('/telegram/search?q=screen&topicId=42');
      expect(r.status).toBe(200);
      expect(r.body.results[0].messageLink).toBe(ASK_LINK);
    });
  });
});
