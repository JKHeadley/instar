/**
 * Tier-2 integration: trust-journey stage 0 part B over the real HTTP pipeline. The agent opens a
 * request; the server sends the acceptance statement and the card to the owner's private chat; only
 * a lifeline-verified private-chat reply `approve <code>` to that card raises the setting. The
 * agent's token, the server's own re-forward, a group chat and a replayed update approve nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ensureLifelineIngressSecret, LIFELINE_SECRET_HEADER, LIFELINE_INGRESS_CALLER_HEADER, LIFELINE_INGRESS_CALLER_SERVER_SELF } from '../../src/core/LifelineIngressSecret.js';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import { createTrustJourneyRuntime } from '../../src/core/trustJourney/TrustJourneyRuntime.js';
import { acceptanceStatement } from '../../src/core/trustJourney/accountPath.js';

const AUTH = 'test-auth-trust-account-path';
const VERSION = '1.3.500';
const OWNER = 777001;

let tmp: string;
let stateDir: string;
let trust: AdaptiveTrust;
let sent: Array<{ text: string; replyTo?: number; messageId: number }>;
let app: express.Express;
let nextId: number;

function boot() {
  const runtime = createTrustJourneyRuntime({
    stateDir, configPath: path.join(stateDir, 'config.json'), runtimeConfig: {}, installationId: 'test-project',
    adaptiveTrust: trust, autonomyManager: null, trustRecovery: null,
    telegram: {
      getOwnerUserId: () => OWNER,
      sendOwnerDirect: async (text: string, replyTo?: number) => { const messageId = nextId++; sent.push({ text, replyTo, messageId }); return { messageId }; },
    },
    slack: null, slackOwnerUserId: () => null, holdsLease: () => true,
  });
  const ctx = {
    config: { projectName: 'test-project', projectDir: tmp, stateDir, port: 0, authToken: AUTH, sessions: {} as never, scheduler: {} as never },
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null, queryEvents: () => [] },
    telegram: {
      isPolling: false, onTopicMessage: () => {}, logInboundMessage: () => {}, dispatchAgentMessageHook: async () => false,
      isAuthorizedSender: () => true, sendToTopic: async () => ({}), getOwnerUserId: () => OWNER, getChatId: () => '-100', getLifelineTopicId: () => 3,
    },
    adaptiveTrust: trust, trustAccountPath: runtime, startTime: new Date(),
  } as unknown as RouteContext;
  app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return runtime;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-account-path-'));
  stateDir = path.join(tmp, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  trust = new AdaptiveTrust({ stateDir });
  sent = [];
  nextId = 500;
  ProcessIntegrity.reset();
  ProcessIntegrity.initialize(VERSION, null);
  boot();
});
afterEach(() => {
  ProcessIntegrity.reset();
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/trust-account-path-routes.test.ts' });
});

const secret = () => ensureLifelineIngressSecret(stateDir);
let updateId = 1;
function forward(text: string, o: { secret?: boolean; serverSelf?: boolean; chatType?: string; chatId?: number; replyTo?: number; updateId?: number } = {}) {
  let r = request(app).post('/internal/telegram-forward').set('Authorization', `Bearer ${AUTH}`);
  if (o.secret !== false) r = r.set(LIFELINE_SECRET_HEADER, secret());
  if (o.serverSelf) r = r.set(LIFELINE_INGRESS_CALLER_HEADER, LIFELINE_INGRESS_CALLER_SERVER_SELF);
  return r.send({
    topicId: 1, text, fromUserId: OWNER, fromFirstName: 'Owner', messageId: 9000 + updateId, updateId: o.updateId ?? updateId++,
    sourceChatType: o.chatType ?? 'private', sourceChatId: o.chatId ?? OWNER, senderIsBot: false,
    ...(o.replyTo !== undefined ? { replyToMessageId: o.replyTo } : {}), lifelineVersion: VERSION,
  });
}

const statement = acceptanceStatement({ adapter: 'telegram', accountId: String(OWNER), installationId: 'test-project' });
const change = { kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'autonomous' };

async function openAndAccept(): Promise<{ code: string; cardId: number }> {
  const r = await request(app).post('/trust/requests').set('Authorization', `Bearer ${AUTH}`).send({ change });
  expect(r.status).toBe(202);
  expect(r.body.status).toBe('awaiting-acceptance');
  expect(sent[0].text).toContain(statement);
  const a = await forward(statement);
  expect(a.body.trustAccountPath).toBe('acceptance-recorded');
  const card = sent.find((m) => m.text.includes('reply to this message with: approve'))!;
  expect(card).toBeTruthy();
  // The code is on the person's card only; the agent's response never carries it.
  expect(r.body.code).toBeUndefined();
  const code = /approve ([0-9A-Z]{6})/.exec(card.text)![1];
  return { code, cardId: card.messageId };
}

describe('trust account path over HTTP', () => {
  it('the token alone cannot raise; the request lands as a card; approve <code> from the owner\'s private chat raises', async () => {
    const direct = await request(app).post('/trust/grant').set('Authorization', `Bearer ${AUTH}`).send({ ...change, statement: 'self' });
    expect(direct.status).toBe(403);
    expect(direct.body.message).toContain('POST /trust/requests');
    const { code, cardId } = await openAndAccept();
    const ok = await forward(`approve ${code}`, { replyTo: cardId });
    expect(ok.body.trustAccountPath).toBe('approved');
    expect(trust.getTrustLevel('gmail', 'write').level).toBe('autonomous');
    expect(sent.at(-1)!.text).toContain('this does not prove who approved');
    expect(sent.at(-1)!.replyTo).toBeDefined();
  });

  it('without the lifeline secret, from the server\'s own re-forward, or in a group, nothing is approved', async () => {
    const { code, cardId } = await openAndAccept();
    const noSecret = await forward(`approve ${code}`, { replyTo: cardId, secret: false });
    expect(noSecret.body.trustAccountPath).toBeUndefined();
    const self = await forward(`approve ${code}`, { replyTo: cardId, serverSelf: true });
    expect(self.body.trustAccountPath).toBeUndefined();
    const group = await forward(`approve ${code}`, { replyTo: cardId, chatType: 'supergroup', chatId: -100123 });
    expect(group.body.trustAccountPath).toBeUndefined();
    expect(trust.getTrustLevel('gmail', 'write').level).not.toBe('autonomous');
  });

  it('a yes in words approves nothing and is answered; a replayed update is a duplicate', async () => {
    const { code, cardId } = await openAndAccept();
    expect((await forward('yes do it', { replyTo: cardId })).body.trustAccountPath).toBe('instruction-sent');
    const r = await forward(`approve ${code}`, { replyTo: cardId, updateId: 4242 });
    expect(r.body.trustAccountPath).toBe('approved');
    expect((await forward(`approve ${code}`, { replyTo: cardId, updateId: 4242 })).body.trustAccountPath).toBe('duplicate');
  });

  it('a narrowing request is refused as not needing approval; GET lists requests', async () => {
    const n = await request(app).post('/trust/requests').set('Authorization', `Bearer ${AUTH}`).send({ change: { ...change, level: 'blocked' } });
    expect(n.status).toBe(409);
    expect(n.body.status).toBe('not-a-raise');
    expect(n.body.code).toBeUndefined();
    await request(app).post('/trust/requests').set('Authorization', `Bearer ${AUTH}`).send({ change });
    const list = await request(app).get('/trust/requests').set('Authorization', `Bearer ${AUTH}`);
    expect(list.status).toBe(200);
    expect(list.body.requests).toHaveLength(1);
    expect(list.body.requests[0].status).toBe('open');
  });

  it('a malformed change is a 400', async () => {
    const r = await request(app).post('/trust/requests').set('Authorization', `Bearer ${AUTH}`).send({ change: { kind: 'trust-grant', service: 'x', operation: 'write', level: 'god-mode' } });
    expect(r.status).toBe(400);
  });
});
