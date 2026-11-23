/**
 * Tier-2 integration: trust-journey stage 0 part C over HTTP. POST /operations/evaluate with the
 * real tool name: an imported legacy kind keeps today's gate decision; a new kind asks and its card
 * reaches the owner's private chat; the owner's `approve <code>` to that card admits the identical
 * call exactly once; a second call or a changed payload asks again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ensureLifelineIngressSecret, LIFELINE_SECRET_HEADER } from '../../src/core/LifelineIngressSecret.js';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import { ExternalOperationGate, AUTONOMY_PROFILES } from '../../src/core/ExternalOperationGate.js';
import { createTrustJourneyRuntime, type TrustAccountPathRuntime } from '../../src/core/trustJourney/TrustJourneyRuntime.js';
import { acceptanceStatement } from '../../src/core/trustJourney/accountPath.js';

const AUTH = 'tj-governed-token';
const VERSION = '1.3.500';
const OWNER = 555001;
let tmp: string; let stateDir: string; let app: express.Express; let runtime: TrustAccountPathRuntime;
let trust: AdaptiveTrust;
let routeContext: RouteContext;
let sent: Array<{ text: string; replyTo?: number; messageId: number }>; let nextId = 700; let updateId = 1;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-governed-'));
  stateDir = path.join(tmp, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  sent = [];
  ProcessIntegrity.reset(); ProcessIntegrity.initialize(VERSION, null);
  trust = new AdaptiveTrust({ stateDir });
  const gate = new ExternalOperationGate({ stateDir, autonomyDefaults: AUTONOMY_PROFILES.collaborative, services: {}, readOnlyServices: [] });
  let imported = false;
  runtime = createTrustJourneyRuntime({
    stateDir, configPath: path.join(stateDir, 'config.json'), runtimeConfig: {}, installationId: 'tj', machineId: 'm1',
    adaptiveTrust: trust, autonomyManager: null, trustRecovery: null,
    telegram: { getOwnerUserId: () => OWNER, sendOwnerDirect: async (text, replyTo) => { const messageId = nextId++; sent.push({ text, replyTo, messageId }); return { messageId }; } },
    slack: null, slackOwnerUserId: () => null, holdsLease: () => true,
    legacyImport: { gateEnabled: true, gateServices: ['legacysvc'], readOnlyServices: [], logServices: () => [], mcpServers: () => [], alreadyImported: () => imported, markImported: () => { imported = true; return true; } },
  });
  await runtime.importLegacyAndWriteFallback();
  const ctx = {
    config: { projectName: 'tj', projectDir: tmp, stateDir, port: 0, authToken: AUTH, sessions: {} as never, scheduler: {} as never },
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null, queryEvents: () => [] },
    telegram: { isPolling: false, onTopicMessage: () => {}, logInboundMessage: () => {}, dispatchAgentMessageHook: async () => false, isAuthorizedSender: () => true, sendToTopic: async () => ({}), getOwnerUserId: () => OWNER, getChatId: () => '-100', getLifelineTopicId: () => 3 },
    adaptiveTrust: trust, operationGate: gate, trustAccountPath: runtime, startTime: new Date(),
  } as unknown as RouteContext;
  routeContext = ctx;
  app = express(); app.use(express.json()); app.use('/', createRoutes(ctx));
});
afterEach(() => { vi.restoreAllMocks(); ProcessIntegrity.reset(); SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/trust-governed-effects-routes.test.ts' }); });

const evaluate = (tool_name: string, tool_input: Record<string, unknown>) => request(app).post('/operations/evaluate').set('Authorization', `Bearer ${AUTH}`)
  .send({ service: tool_name.split('__')[1], mutability: 'write', reversibility: 'irreversible', description: 'x', itemCount: 1, tool_name, tool_input });
const forward = (text: string, replyTo?: number) => request(app).post('/internal/telegram-forward').set('Authorization', `Bearer ${AUTH}`).set(LIFELINE_SECRET_HEADER, ensureLifelineIngressSecret(stateDir))
  .send({ topicId: 1, text, fromUserId: OWNER, fromFirstName: 'O', messageId: 9000 + updateId, updateId: updateId++, sourceChatType: 'private', sourceChatId: OWNER, senderIsBot: false, ...(replyTo !== undefined ? { replyToMessageId: replyTo } : {}), lifelineVersion: VERSION });

describe('governed effects over HTTP', () => {
  it('the legacy import recorded today\'s kinds and wrote the hook fallback file', () => {
    const file = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'trust-legacy-kinds.json'), 'utf8'));
    expect(file.legacyKinds).toEqual(['legacysvc.delete', 'legacysvc.modify', 'legacysvc.write']);
    expect(file.readToolNames).toContain('mcp__codex_apps__github__fetch_pr');
  });

  it('a legacy kind keeps today\'s gate decision', async () => {
    const r = await evaluate('mcp__legacysvc__send_note', { to: 'a' });
    expect(r.status).toBe(200);
    expect(r.body.trust).toBeUndefined(); // the gate answered, not the trust path
    expect(['proceed', 'show-plan']).toContain(r.body.action);
  });

  it('nested fetch_pr is a read despite old caller mutability, while collisions stay governed', async () => {
    expect((await evaluate('mcp__codex_apps__github__fetch_pr', { url: 'https://github.com/public/repo/pull/1' })).body.action).toBe('proceed');
    expect(runtime.store.openRequests()).toHaveLength(0);
    const write = await evaluate('mcp__codex_apps__github_fetch_pr', {});
    expect(write.body.action).toBe('ask'); expect(write.body.approval.status).toBe('awaiting-acceptance'); expect(write.body.requestId).toBeUndefined();
    const rows = fs.readFileSync(path.join(stateDir, 'logs/approval-refusals.jsonl'), 'utf8'); expect(rows).not.toContain(runtime.store.openRequests()[0].code);
  });

  it('status-only revival uses the real effect: stale modify cannot block a read and a read label cannot free a write', async () => {
    Object.assign(routeContext.telegram!, { getTopicForSession: () => 41 });
    routeContext.commitmentTracker = { getActive: () => [{ id: 'revived', topicId: 41, revivalMode: 'status-only-until-revalidated' }] } as never;
    const call = (tool_name: string, mutability: string) => request(app).post('/operations/evaluate').set('Authorization', `Bearer ${AUTH}`).send({ service: 'codex_apps', mutability, reversibility: 'reversible', description: 'revival effect boundary', sessionName: 'revived-session', tool_name, tool_input: { id: 1 } });
    expect((await call('mcp__codex_apps__github__fetch_pr', 'modify')).body.action).toBe('proceed');
    const write = await call('mcp__codex_apps__github__create_pr', 'read');
    expect(write.body.action).toBe('block'); expect(write.body.revivalModeBlocked).toBe(true); expect(runtime.store.openRequests()).toHaveLength(0);
  });

  it('uncardable calls explain that no request was opened and retain a local refusal trace', async () => {
    const result = await evaluate('mcp__newsvc__send_note', { text: 'x'.repeat(2600) });
    expect(result.body.action).toBe('block'); expect(result.body.reason).toContain('cannot be shown exactly'); expect(runtime.store.openRequests()).toHaveLength(0);
    const trace = JSON.parse(fs.readFileSync(path.join(stateDir, 'logs/approval-refusals.jsonl'), 'utf8'));
    expect(trace.status).toBe('not-opened'); expect(trace.reason).toBe('too-large');
  });

  it('a read is not gated', async () => {
    expect((await evaluate('mcp__newsvc__list_notes', {})).body.action).toBe('proceed');
  });

  it('a new kind asks; the owner approves that exact call once; a second or changed call asks again', async () => {
    const first = await evaluate('mcp__newsvc__send_note', { to: 'a', body: 'hi' });
    expect(first.body.action).toBe('ask');
    expect(first.body.approval).toEqual({ version: 1, status: 'awaiting-acceptance', surface: 'direct-chat' });
    expect(first.body.reason).toContain('current owner received the acceptance message');
    const stmt = acceptanceStatement({ adapter: 'telegram', accountId: String(OWNER), installationId: 'tj' });
    expect((await forward(stmt)).body.trustAccountPath).toBe('acceptance-recorded');
    const card = sent.find((m) => m.text.includes('Do this once'))!;
    expect(card.text).toContain('mcp__newsvc__send_note');
    expect(card.text).toContain('"body":"hi"');
    const code = /approve ([0-9A-Z]{6})/.exec(card.text)![1];
    expect((await forward(`approve ${code}`, card.messageId)).body.trustAccountPath).toBe('approved');

    const retry = await evaluate('mcp__newsvc__send_note', { body: 'hi', to: 'a' }); // same input, any key order
    expect(retry.body.action).toBe('proceed');
    expect(retry.body.trust.verdict).toBe('proceed-once');
    expect((await evaluate('mcp__newsvc__send_note', { to: 'a', body: 'hi' })).body.action).toBe('ask');
    expect((await evaluate('mcp__newsvc__send_note', { to: 'a', body: 'changed' })).body.action).toBe('ask');
  });

  it('an owner-blocked operation remains refused and explains unavailable local trace storage', async () => {
    trust.grantTrust('newsvc', 'write', 'blocked', 'owner restriction');
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('trace disk unavailable'); });
    const result = await evaluate('mcp__newsvc__send_note', {});
    expect(result.body.action).toBe('block'); expect(result.body.reason).toContain('Only the person can change'); expect(result.body.reason).toContain('refusal trace could not be saved');
    expect(runtime.store.openRequests()).toHaveLength(0);
  });

  it('signing in through the browser asks, even on an imported service', async () => {
    const r = await evaluate('mcp__playwright__browser_type', { element: 'Password field', text: 'x' });
    expect(r.body.action).toBe('ask');
    expect(r.body.trust.why).toBe('sign-in');
  });
});

describe('admission on a machine that does not hold the serving lease', () => {
  it('forwards the governed call once to the holder and relays its answer; with no holder it waits', async () => {
    const holderSeen: Array<Record<string, unknown>> = [];
    const holder = express(); holder.use(express.json());
    holder.post('/operations/evaluate', (req, res) => { holderSeen.push({ forwarded: req.get('x-instar-trust-admission-forwarded'), body: req.body }); res.json({ action: 'ask', reason: 'holder asked' }); });
    const srv = await new Promise<import('node:http').Server>((resolve) => { const x = holder.listen(0, '127.0.0.1', () => resolve(x)); });
    const holderUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const nonHolder = createTrustJourneyRuntime({
        stateDir, configPath: path.join(stateDir, 'config.json'), runtimeConfig: {}, installationId: 'tj', machineId: 'm2',
        adaptiveTrust: new AdaptiveTrust({ stateDir }), autonomyManager: null, trustRecovery: null, telegram: null, slack: null, slackOwnerUserId: () => null, holdsLease: () => false,
      });
      const mkApp = (url: string | null) => {
        const ctx = {
          config: { projectName: 'tj', projectDir: tmp, stateDir, port: 0, authToken: AUTH, sessions: {} as never, scheduler: {} as never },
          sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null, queryEvents: () => [] },
          operationGate: new ExternalOperationGate({ stateDir, autonomyDefaults: AUTONOMY_PROFILES.collaborative, services: {}, readOnlyServices: [] }),
          trustAccountPath: nonHolder, resolveRouterUrl: () => url, startTime: new Date(),
        } as unknown as RouteContext;
        const a = express(); a.use(express.json()); a.use('/', createRoutes(ctx)); return a;
      };
      const body = { service: 'newsvc', mutability: 'write', reversibility: 'irreversible', description: 'x', itemCount: 1, tool_name: 'mcp__newsvc__send_note', tool_input: { to: 'a' } };
      const r = await request(mkApp(holderUrl)).post('/operations/evaluate').set('Authorization', `Bearer ${AUTH}`).send(body);
      expect(r.body.handledBy).toBe('holder-proxy');
      expect(r.body.reason).toBe('holder asked');
      expect(holderSeen[0].forwarded).toBe('1');
      const alone = await request(mkApp(null)).post('/operations/evaluate').set('Authorization', `Bearer ${AUTH}`).send(body);
      expect(alone.body.action).toBe('ask');
      expect(alone.body.trust.why).toBe('holder-unreachable');
    } finally { await new Promise<void>((r) => srv.close(() => r())); }
  });
});
