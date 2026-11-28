/**
 * Tier-2 integration: trust-journey stage 0 part C over HTTP. POST /operations/evaluate with the
 * real tool name: an imported legacy kind keeps today's gate decision; a new kind asks and its card
 * reaches the owner's private chat; the owner's `approve <code>` to that card admits the identical
 * call exactly once; a second call or a changed payload asks again.
 */
import { proposalHashOf } from '../../src/core/TrustRaiseGuard.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
let holdsLease: boolean;
let sent: Array<{ text: string; replyTo?: number; messageId: number }>; let nextId = 700; let updateId = 1;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-governed-'));
  stateDir = path.join(tmp, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  sent = [];
  holdsLease = true;
  ProcessIntegrity.reset(); ProcessIntegrity.initialize(VERSION, null);
  const trust = new AdaptiveTrust({ stateDir });
  const gate = new ExternalOperationGate({ stateDir, autonomyDefaults: AUTONOMY_PROFILES.collaborative, services: {}, readOnlyServices: [] });
  let imported = false;
  runtime = createTrustJourneyRuntime({
    stateDir, configPath: path.join(stateDir, 'config.json'), runtimeConfig: {}, installationId: 'tj', machineId: 'm1',
    adaptiveTrust: trust, autonomyManager: null, trustRecovery: null,
    telegram: { getOwnerUserId: () => OWNER, sendOwnerDirect: async (text, replyTo) => { const messageId = nextId++; sent.push({ text, replyTo, messageId }); return { messageId }; } },
    slack: null, slackOwnerUserId: () => null, holdsLease: () => holdsLease,
    legacyImport: { gateEnabled: true, gateServices: ['legacysvc'], readOnlyServices: [], logServices: () => [], mcpServers: () => [], alreadyImported: () => imported, markImported: () => { imported = true; return true; } },
  });
  await runtime.importLegacyAndWriteFallback();
  const ctx = {
    config: { projectName: 'tj', projectDir: tmp, stateDir, port: 0, authToken: AUTH, sessions: {} as never, scheduler: {} as never },
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null, queryEvents: () => [] },
    telegram: { isPolling: false, onTopicMessage: () => {}, logInboundMessage: () => {}, dispatchAgentMessageHook: async () => false, isAuthorizedSender: () => true, sendToTopic: async () => ({}), getOwnerUserId: () => OWNER, getChatId: () => '-100', getLifelineTopicId: () => 3 },
    adaptiveTrust: trust, operationGate: gate, trustAccountPath: runtime, startTime: new Date(),
  } as unknown as RouteContext;
  app = express(); app.use(express.json()); app.use('/', createRoutes(ctx));
});
afterEach(() => { ProcessIntegrity.reset(); SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/trust-governed-effects-routes.test.ts' }); });

const evaluate = (tool_name: string, tool_input: Record<string, unknown>) => request(app).post('/operations/evaluate').set('Authorization', `Bearer ${AUTH}`)
  .send({ service: tool_name.split('__')[1], mutability: 'write', reversibility: 'irreversible', description: 'x', itemCount: 1, tool_name, tool_input });
const forward = (text: string, replyTo?: number) => request(app).post('/internal/telegram-forward').set('Authorization', `Bearer ${AUTH}`).set(LIFELINE_SECRET_HEADER, ensureLifelineIngressSecret(stateDir))
  .send({ topicId: 1, text, fromUserId: OWNER, fromFirstName: 'O', messageId: 9000 + updateId, updateId: updateId++, sourceChatType: 'private', sourceChatId: OWNER, senderIsBot: false, ...(replyTo !== undefined ? { replyToMessageId: replyTo } : {}), lifelineVersion: VERSION });

describe('governed effects over HTTP', () => {
  it('connector namespace reads use the existing read policy while writes and unknown tools remain governed', async () => {
    for (const service of ['codex_apps', 'other_engine']) {
      for (const suffix of ['github__fetch_pr', 'github_get_pr_info', 'github__list_pull_requests', 'github_search_code', 'github__read_file']) {
        const response = await evaluate(`mcp__${service}__${suffix}`, { repo_full_name: 'owner/repo', pr_number: 1 });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ action: 'proceed', trust: { verdict: 'not-gated', why: 'read' } });
      }
    }
    expect(sent).toEqual([]);
    expect(runtime.store.openRequests()).toEqual([]);
    for (const suffix of ['github__create_pull_request', 'github_push_files', 'github__comment_on_pr', 'github_merge_pull_request',
      'github__update_file', 'github_delete_file', 'github_fetch_and_push', 'github_read_then_comment', 'inspect_read', 'launch_get_status', 'github_opaque']) {
      const response = await evaluate(`mcp__codex_apps__${suffix}`, {});
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ action: 'ask', trust: { verdict: 'ask', why: suffix === 'github_merge_pull_request' ? 'always-ask-item' : 'no-grant' } });
    }
  });

  it('requests owner proof at the default log level and applies it to GitHub PR creation only', async () => {
    const create = 'mcp__codex_apps__github__create_pull_request';
    const input = { repository_full_name: 'JKHeadley/instar', head: 'feature', base: 'main', title: 'Proposed change' };
    const change = { kind: 'trust-grant', service: 'codex_apps', operation: 'write', level: 'log' };
    const setup = await evaluate(create, input);
    expect(setup.body.trust).toEqual({ verdict: 'ask', why: 'no-grant' });
    const direct = await request(app).post('/trust/grant').set('Authorization', `Bearer ${AUTH}`)
      .send({ ...change, statement: 'Unverified statement' });
    expect(direct.status).toBe(403);
    const pending = await request(app).post('/trust/requests').set('Authorization', `Bearer ${AUTH}`).send({ change });
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('awaiting-acceptance');
    const stmt = acceptanceStatement({ adapter: 'telegram', accountId: String(OWNER), installationId: 'tj' });
    expect((await forward(stmt)).body.trustAccountPath).toBe('acceptance-recorded');
    const code = runtime.store.request(pending.body.requestId)!.code;
    const card = sent.find((message) => message.text.includes(`approve ${code}`))!;
    expect(card.text).toContain('jkheadley/instar');
    expect((await forward(`approve ${code}`, card.messageId)).body.trustAccountPath).toBe('approved');
    expect((await evaluate(create, input)).body.trust).toEqual({ verdict: 'proceed', why: 'grant', level: 'log' });
    expect((await evaluate(create, { ...input, repository_full_name: 'owner/repo,other/repo' })).body.trust.why).toBe('unknown-scope');
    for (const action of ['update_pull_request', 'merge_pull_request']) {
      expect((await evaluate(`mcp__codex_apps__github__${action}`, { repository_full_name: 'JKHeadley/instar', pr_number: 1 })).body.action).toBe('ask');
    }
    const other = { ...input, repository_full_name: 'other/repo' };
    expect((await evaluate(create, other)).body.trust.why).toBe('outside-repository');
    const downgrade = await request(app).post('/trust/grant').set('Authorization', `Bearer ${AUTH}`)
      .send({ ...change, operation: 'modify', level: 'blocked', statement: 'Keep connector modifications blocked' });
    expect(downgrade.status).toBe(200);
    expect((await evaluate(create, input)).body.trust).toEqual({ verdict: 'refused', why: 'blocked' });
  });

  it('admits owner-approved edits only in the named repository', async () => {
    const input = { repository_full_name: 'JKHeadley/instar' };
    const other = { repository_full_name: 'other/repo' };
    const edit = 'mcp__codex_apps__github__update_pull_request';
    const editPending = await request(app).post('/trust/requests').set('Authorization', `Bearer ${AUTH}`)
      .send({ change: { kind: 'trust-grant', service: 'codex_apps', operation: 'modify', level: 'log' } });
    expect(editPending.status).toBe(202);
    const stmt = acceptanceStatement({ adapter: 'telegram', accountId: String(OWNER), installationId: 'tj' });
    expect((await forward(stmt)).body.trustAccountPath).toBe('acceptance-recorded');
    const editCode = runtime.store.request(editPending.body.requestId)!.code;
    const editCard = sent.find((message) => message.text.includes(`approve ${editCode}`))!;
    expect(editCard.text).toContain('jkheadley/instar');
    expect((await forward(`approve ${editCode}`, editCard.messageId)).body.trustAccountPath).toBe('approved');
    expect((await evaluate(edit, { ...input, pr_number: 1 })).body.trust.verdict).toBe('proceed');
    expect((await evaluate(edit, { ...other, pr_number: 1 })).body.trust.why).toBe('outside-repository');
    expect((await evaluate('mcp__codex_apps__github_merge_pull_request', { ...input, pr_number: 1 })).body.action).toBe('ask');
  });

  it('tells the owner where to enable app approvals when the PR request is held for setup', async () => {
    const phone = {
      deviceId: 'owner-iphone', name: 'Owner iPhone', active: true, keyFingerprint: 'ABCD-0000-0000-0000',
      presenceKeyHash: 'a'.repeat(64), deviceKind: 'phone' as const, firstPairing: true,
    };
    runtime.bindDevices({ get: (id) => id === phone.deviceId ? phone : null, list: () => [phone], enabled: () => true });
    const response = await evaluate('mcp__codex_apps__github__create_pull_request', {
      repository_full_name: 'JKHeadley/instar', head: 'feature', base: 'main', title: 'Proposed change',
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ action: 'ask', requestId: expect.any(String) });
    expect(response.body.reason).toContain('Open Changes to approve in the Instar iPhone app');
    expect(sent).toEqual([]);
  });

  it('keeps the old modify legacy policy without treating a legacy write row as a PR creation grant', async () => {
    const tool = 'mcp__codex_apps__github__create_pull_request';
    const input = { repository_full_name: 'JKHeadley/instar' };
    await runtime.store.write('legacy-grant', {
      key: 'codex_apps.write', machine: 'm1', behaviour: 'gate', afterChange: null,
    }, 'tj:legacy:m1:codex_apps.write');
    expect((await runtime.admit(tool, input)).decision).toEqual({ verdict: 'ask', why: 'no-grant' });
    await runtime.store.write('legacy-grant', {
      key: 'codex_apps.modify', machine: 'm1', behaviour: 'gate', afterChange: null,
    }, 'tj:legacy:m1:codex_apps.modify');
    expect((await runtime.admit(tool, input)).decision).toEqual({ verdict: 'legacy', why: 'unchanged-legacy-grant' });
    expect((await runtime.admit('mcp__codex_apps__github__merge_pull_request', input)).decision)
      .toEqual({ verdict: 'ask', why: 'always-ask-item' });
    holdsLease = false;
    expect((await runtime.admit(tool, input)).decision).toEqual({ verdict: 'ask', why: 'holder-unreachable' });
    expect((await runtime.admit('mcp__codex_apps__github__update_pull_request', input)).decision)
      .toEqual({ verdict: 'ask', why: 'holder-unreachable' });
  });

  it('does not reuse an owner receipt issued before the repository was identified', async () => {
    const key = 'codex_apps.write';
    const consumptionId = 'old-consumption';
    await runtime.store.write('consumption', {
      consumptionId, requestId: 'old-request', receiptId: 'old-receipt', acceptanceId: 'old-acceptance',
      principal: 'owner',
      proposalHash: proposalHashOf({ kind: 'trust-grant', service: 'codex_apps', operation: 'write', level: 'log' }),
    }, consumptionId);
    await runtime.store.write('change', {
      key, changeId: 'old-change', from: 'log', to: 'log', direction: 'same', source: 'user-explicit', consumptionId,
    }, 'old-change');
    const result = await runtime.admit('mcp__codex_apps__github_create_pull_request', { repository_full_name: 'JKHeadley/instar' });
    expect(result.decision).toEqual({ verdict: 'ask', why: 'no-grant' });
  });

  it('does not turn old audit or narrowing records without owner proof into standing permission', async () => {
    for (const [operation, action, level, direction] of [
      ['write', 'create_pull_request', 'log', 'same'],
      ['modify', 'update_pull_request', 'log', 'lower'],
    ]) {
      const key = `codex_apps.${operation}`;
      await runtime.store.write('change', {
        changeId: `${key}:old`, key, from: direction === 'same' ? level : 'autonomous', to: level, direction, source: 'user-explicit',
      }, `tj:change:${key}:old`);
      const result = await runtime.admit(`mcp__codex_apps__github__${action}`, { repository_full_name: 'JKHeadley/instar' });
      expect(result.decision.verdict).toBe('ask');
    }
  });

  it('the legacy import recorded today\'s kinds and wrote the hook fallback file', () => {
    const file = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'trust-legacy-kinds.json'), 'utf8'));
    expect(file.legacyKinds).toEqual(['legacysvc.delete', 'legacysvc.modify', 'legacysvc.write']);
  });

  it('a legacy kind keeps today\'s gate decision', async () => {
    const r = await evaluate('mcp__legacysvc__send_note', { to: 'a' });
    expect(r.status).toBe(200);
    expect(r.body.trust).toBeUndefined(); // the gate answered, not the trust path
    expect(['proceed', 'show-plan']).toContain(r.body.action);
  });

  it('a read is not gated', async () => {
    expect((await evaluate('mcp__newsvc__list_notes', {})).body.action).toBe('proceed');
  });

  it('a new kind asks; the owner approves that exact call once; a second or changed call asks again', async () => {
    const first = await evaluate('mcp__newsvc__send_note', { to: 'a', body: 'hi' });
    expect(first.body.action).toBe('ask');
    expect(first.body.reason).toMatch(/Waiting for the person/);
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
