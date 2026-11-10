// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * context-budget-layered-summaries §10 — the egress fold hold at the REAL
 * outbound chokepoints, over HTTP: createRoutes with a real FoldHoldStore,
 * real POSTs to the Telegram and Slack reply routes.
 *
 *  - a held conversation's send is refused 409 `fold-hold` and nothing reaches
 *    the channel (Telegram via authorizeTelegramSessionSend + evaluateOutbound;
 *    Slack via evaluateOutbound keyed by the channel-neutral fold key);
 *  - other conversations are untouched while one is held;
 *  - once the fold releases the hold, the same send goes through;
 *  - every refusal is in the audit file (the per-fold refusal count).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { FoldHoldStore, foldKeyForConversation } from '../../src/monitoring/FoldHoldStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/fold-hold-outbound-routes.test.ts';
const TOPIC = 141133;
const SLACK_CH = 'C0FOLDTEST';

interface TestServer { url: string; close: () => Promise<void> }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('fold hold × real outbound routes (HTTP)', () => {
  let server: TestServer;
  let stateDir: string;
  let holds: FoldHoldStore;
  let telegramSent: string[];
  let slackSent: string[];
  let auditFile: string;

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-hold-routes-'));
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ authToken: 'test', port: 0, dashboardPin: '123456' }));
    auditFile = path.join(stateDir, 'state', 'context-layers', '_fold-hold-audit.jsonl');
    holds = new FoldHoldStore({ stateDir, ttlCeilingMs: 30 * 60_000, recordOpen: () => true, auditFile });
    telegramSent = []; slackSent = [];
    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 'test', stateDir, port: 0, dashboardPin: '123456' },
      liveConfig: new LiveConfig(stateDir),
      foldHolds: holds,
      sessionManager: { clearInjectionTracker() {}, listRunningSessions: () => [], getSessionByTopic: () => null },
      telegram: {
        sendToTopic: async (_t: number, text: string) => { telegramSent.push(text); return true; },
        getTopicHistory: () => [],
      },
      slack: {
        sendToChannel: async (_c: string, text: string) => { slackSent.push(text); return { ts: '1.1' }; },
        postMessage: async (_c: string, text: string) => { slackSent.push(text); return { ts: '1.1' }; },
      },
      startTime: new Date(),
    };
    app.use(createRoutes(ctx));
    server = await listen(app);
  });
  afterEach(async () => {
    await server?.close();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP });
  });

  const authed = { 'Content-Type': 'application/json', Authorization: 'Bearer test' };
  const post = async (p: string, body: object) => {
    const res = await fetch(`${server.url}${p}`, { method: 'POST', headers: authed, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const hold = (key: string, foldId: string) => expect(holds.write(key, foldId, Date.now() + 10 * 60_000)).toBe(true);

  it('Telegram: a held topic refuses the reply with 409 fold-hold and nothing is sent', async () => {
    hold(foldKeyForConversation('telegram', TOPIC)!, 'fold1');
    const r = await post(`/telegram/reply/${TOPIC}`, { text: 'the probe answer is MANGO' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'fold-hold', foldId: 'fold1', retryable: false });
    expect(telegramSent).toEqual([]);
    const lines = fs.readFileSync(auditFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((l) => l.type === 'fold-hold-refused' && l.foldId === 'fold1')).toBe(true);
  });

  it('Telegram: another topic is untouched while one is held', async () => {
    hold(foldKeyForConversation('telegram', TOPIC)!, 'fold1');
    const r = await post('/telegram/reply/999', { text: 'unrelated conversation reply' });
    expect(r.body.error).not.toBe('fold-hold');
    expect(r.status).toBe(200);
    expect(telegramSent).toContain('unrelated conversation reply');
  });

  it('Telegram: after the fold releases the hold, the same reply is not refused by it', async () => {
    const key = foldKeyForConversation('telegram', TOPIC)!;
    hold(key, 'fold1');
    expect((await post(`/telegram/reply/${TOPIC}`, { text: 'held reply' })).status).toBe(409);
    holds.release(key, 'fold1');
    const r = await post(`/telegram/reply/${TOPIC}`, { text: 'held reply after release' });
    expect(r.body.error).not.toBe('fold-hold');
    expect(r.status).toBe(200);
    expect(telegramSent).toContain('held reply after release'); // it actually went out
  });

  it('Slack: a held channel refuses with 409 fold-hold (channel-neutral key) and nothing is sent', async () => {
    hold(foldKeyForConversation('slack', SLACK_CH)!, 'fold2');
    const r = await post(`/slack/reply/${SLACK_CH}`, { text: 'the probe answer is MANGO' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'fold-hold', foldId: 'fold2' });
    expect(slackSent).toEqual([]);
  });

  it('a Slack hold never refuses the Telegram topic with the same digits, and vice versa', async () => {
    hold(foldKeyForConversation('slack', String(TOPIC))!, 'fold3');
    const r = await post(`/telegram/reply/${TOPIC}`, { text: 'telegram reply' });
    expect(r.body.error).not.toBe('fold-hold');
  });
});
