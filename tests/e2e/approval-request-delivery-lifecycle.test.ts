import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import { ExternalOperationGate, AUTONOMY_PROFILES } from '../../src/core/ExternalOperationGate.js';
import { initializeTrustJourneyRuntime } from '../../src/core/trustJourney/TrustJourneyRuntime.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { NotificationSelectivityGate } from '../../src/messaging/NotificationSelectivityGate.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { EXTERNAL_OPERATION_GATE_TIMEOUT_MS } from '../../src/core/installCodexHooks.js';
import { acceptanceStatement } from '../../src/core/trustJourney/accountPath.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
const AUTH = 'local-approval-test'; const OWNER = 777;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function directory() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-lifecycle-')); cleanup.push(async () => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'approval-request-delivery-lifecycle' })); return dir; }
it('uses actual startup, HTTP route, Telegram gate and authenticated receipt with no quiet approval loss', async () => {
  const dir = directory(); const stateDir = path.join(dir, '.instar'); fs.mkdirSync(stateDir, { recursive: true });
  const config = { projectName: 'local-approval', agentName: 'Test', projectDir: dir, stateDir, port: 0, authToken: AUTH, developmentAgent: true } as InstarConfig;
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const telegram = new TelegramAdapter({ token: '123:fixture', chatId: '-1001', ownerUserId: OWNER }, stateDir, { suppressLifelineAutoCreate: true });
  const gate = new NotificationSelectivityGate(stateDir, 'test', () => ({ enabled: true, dryRun: false })); telegram.selectivity = gate;
  const sent: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => { sent.push(JSON.parse(String(options?.body))); return new Response(JSON.stringify({ ok: true, result: { message_id: 900 + sent.length } })); }));
  const trust = new AdaptiveTrust({ stateDir });
  const { runtime, legacy } = await initializeTrustJourneyRuntime({ stateDir, configPath: path.join(stateDir, 'config.json'), runtimeConfig: {}, installationId: config.projectName, adaptiveTrust: trust, autonomyManager: null, trustRecovery: null, telegram: { getOwnerUserId: () => telegram.getOwnerUserId(), sendOwnerDirect: (text, reply) => telegram.sendOwnerApproval(text, reply) }, slack: null, slackOwnerUserId: () => null, holdsLease: () => true }, r => { telegram.onTrustAccountPathReceipt = receipt => r.ingest(receipt); });
  expect(legacy.fileWritten).toBe(true); expect(telegram.onTrustAccountPathReceipt).toBeTypeOf('function');
  const server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(stateDir), telegram, adaptiveTrust: trust, operationGate: new ExternalOperationGate({ stateDir, autonomyDefaults: AUTONOMY_PROFILES.collaborative, services: {}, readOnlyServices: [] }), trustAccountPath: runtime });
  cleanup.unshift(async () => { await server.stop(); await gate.close(); });
  const evaluate = (tool: string) => request(server.getApp()).post('/operations/evaluate').set('Authorization', 'Bearer '+AUTH).send({ service: 'codex_apps', mutability: 'modify', reversibility: 'reversible', description: 'test call', tool_name: tool, tool_input: { id: 'x' } });
  expect((await evaluate('mcp__codex_apps__github__fetch_pr')).body.action).toBe('proceed'); expect(runtime.store.openRequests()).toHaveLength(0); expect(sent).toHaveLength(0);
  const first = await evaluate('mcp__codex_apps__github__create_pr'); expect(first.body.action).toBe('ask'); expect(first.body.approval.status).toBe('awaiting-acceptance'); expect(sent).toHaveLength(1); expect(sent[0].chat_id).toBe(OWNER);
  let platformMessageId = 8000;
  const receipt = (text: string, id: string, replyToMessageId?: string) => ({ receiptId: id, uniqueKey: id, adapter: 'telegram' as const, senderId: String(OWNER), chatId: String(OWNER), chatType: 'private', messageId: String(++platformMessageId), text, senderIsBot: false, forwarded: false, receivedAt: new Date().toISOString(), receivedBy: 'local', ...(replyToMessageId ? { replyToMessageId } : {}) });
  expect(await telegram.onTrustAccountPathReceipt!(receipt(acceptanceStatement({ adapter: 'telegram', accountId: String(OWNER), installationId: config.projectName }), 'receipt-accept'))).toBe('acceptance-recorded');
  const req = runtime.store.openRequests()[0]; expect(req.cardMessageId).toBeTruthy();
  const waiting = await evaluate('mcp__codex_apps__github__create_pr'); expect(waiting.body.approval.status).toBe('sent'); expect(waiting.body.requestId).toBeUndefined();
  const count = sent.length; expect(await telegram.sendOwnerDirect('Ordinary report')).toBeNull(); expect(sent).toHaveLength(count);
  expect(await telegram.onTrustAccountPathReceipt!(receipt('approve '+req.code, 'receipt-approve', req.cardMessageId))).toBe('approved');
  expect((await evaluate('mcp__codex_apps__github__create_pr')).body.trust.verdict).toBe('proceed-once');
  expect(fs.readFileSync(path.join(stateDir, 'logs/approval-refusals.jsonl'), 'utf8')).not.toContain(req.code);
});

async function hookFixture(respond: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const dir = directory(); const stateDir = path.join(dir, '.instar'); fs.mkdirSync(stateDir, { recursive: true });
  const server = http.createServer(respond); server.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  cleanup.unshift(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port, authToken: AUTH, trustJourney: { legacyImportedAt: 'fixture' } }));
  const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir, port, projectName: 'local', hasTelegram: true });
  const hook = path.join(stateDir, 'hooks/instar/external-operation-gate.js'); fs.mkdirSync(path.dirname(hook), { recursive: true }); fs.writeFileSync(hook, 'stale');
  const result = migrator.repairCompactionRecoveryHooks(); expect(result.errors.filter(e => e.startsWith('external-operation-gate.js:'))).toEqual([]); expect(fs.readFileSync(hook, 'utf8')).not.toBe('stale');
  return (tool = 'mcp__codex_apps__github__create_pr') => new Promise<{ code: number | null; stderr: string; elapsed: number }>((resolve, reject) => {
    const start = Date.now(); const child = spawn(process.execPath, [hook], { cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PROJECT_DIR: dir, INSTAR_AUTH_TOKEN: AUTH } });
    let stderr = ''; child.stderr.on('data', x => stderr += x); child.on('error', reject); child.on('exit', code => resolve({ code, stderr, elapsed: Date.now()-start })); child.stdin.end(JSON.stringify({ tool_name: tool, tool_input: { id: 1 } }));
  });
}
describe('installed approval hook', () => {
  it.each([
    [{ action: 'ask', approval: { version: 1, status: 'sent', surface: 'direct-chat' }, reason: 'actual card' }, 'WAITING FOR APPROVAL'],
    [{ action: 'ask', reason: 'old unsupported ask' }, 'APPROVAL REQUEST UNCONFIRMED'],
    [{ action: 'block', reason: 'Owner was not asked: request storage failed.' }, 'Owner was not asked'],
  ])('preserves refusal and shows only supported waits', async (body, text) => { const run = await hookFixture((_q, s) => { s.setHeader('Content-Type','application/json'); s.end(JSON.stringify(body)); }); const r = await run(); expect(r.code).toBe(2); expect(r.stderr).toContain(text); });
  it('refuses a permanently pending adapter response before the actual handler kill, including stalled JSON body', async () => {
    const run = await hookFixture((_q, s) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.write('{'); });
    const r = await run(); expect(r.code).toBe(2); expect(r.elapsed).toBeLessThan(EXTERNAL_OPERATION_GATE_TIMEOUT_MS); expect(r.stderr).toContain('BLOCKED');
  }, 15000);
  it('exact verified read works offline while a protected write remains refused', async () => {
    const run = await hookFixture((_q, s) => { s.destroy(); }); expect((await run('mcp__codex_apps__github__fetch_pr')).code).toBe(0); expect((await run()).code).toBe(2);
  });
});
