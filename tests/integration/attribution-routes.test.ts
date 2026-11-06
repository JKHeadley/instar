// safe-fs-allow: test file — tmpdir cleanup only.
/**
 * Attribution paper trail through the real createRoutes (docs/specs/attribution-paper-trail.md).
 * Only the IntelligenceProvider and the other machines are stand-ins: the routes, the runtime, the
 * resolver, the tone gate, the disposition map and the 422 plumbing are real.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRoutes } from '../../src/server/routes.js';
import { AttributionRuntime, type AttributionRuntimeDeps } from '../../src/core/attribution/attributionRuntime.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const AUTH_OWNER = 42;
const row = { messageId: 123160, topicId: 102965, text: 'at least every hour and a half', fromUser: true, telegramUserId: AUTH_OWNER, forwarded: false, provenance: 'user', timestamp: '2026-10-08T04:34:33.000Z' };
const claims = (list: unknown[]) => JSON.stringify({ claims: list });
const credit = (over = {}) => ({ span: 'Justin told me', person: 'Justin', kind: 'rule', markerIndex: null, labelled: false, stillCredits: false, ...over });
const PASS = { pass: true, rule: '', issue: '', suggestion: '' };
const NUDGE = { pass: false, rule: 'B23_UNSOURCED_ATTRIBUTION', issue: 'A rule with no source.', suggestion: 'Say it is your own.' };

type Stop = () => Promise<void>;
const stops: Stop[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/attribution-routes.test.ts:cleanup' });
});

function makeAgent() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'attr-int-')));
  dirs.push(project);
  const stateDir = path.join(project, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'x', threadline: { ownerName: 'Justin' } }));
  return { project, stateDir };
}

function listen(app: express.Express): Promise<{ url: string; port: number; close: Stop }> {
  return new Promise((resolve) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      let closed = false;
      const close: Stop = () => new Promise((done) => {
        if (closed) { done(); return; }
        closed = true;
        server.closeAllConnections?.();
        server.close(() => done());
      });
      stops.push(close);
      resolve({ url: `http://127.0.0.1:${port}`, port, close });
    });
  });
}

function runtimeFor(agent: { project: string; stateDir: string }, evaluate: IntelligenceProvider['evaluate'], extra: Partial<AttributionRuntimeDeps> = {}, mode: 'record' | 'enforce' = 'enforce') {
  return new AttributionRuntime({
    stateDir: agent.stateDir, projectDir: agent.project, machineId: 'm1', machineName: 'studio', intelligence: { evaluate },
    config: () => ({ mode }), isEnabled: () => true, configuredOwnerUid: () => AUTH_OWNER, ...extra,
  });
}

async function serve(agent: { project: string; stateDir: string }, ctxExtra: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use(createRoutes({
    config: { authToken: 'test', stateDir: agent.stateDir, port: 0, projectName: 'x', projectDir: agent.project },
    state: new StateManager(agent.stateDir),
    sessionManager: { clearInjectionTracker: () => {}, getSession: () => null },
    startTime: new Date(),
    ...ctxExtra,
  } as never));
  return listen(app);
}

const getJson = async (url: string) => { const res = await fetch(url); return { status: res.status, body: await res.json().catch(() => ({})) as any }; };
const postJson = async (url: string, body: unknown) => {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
};
const MARKER = encodeURIComponent('[source: telegram 102965/123160 2026-10-08]');

describe('attribution routes', () => {
  it('every route is 503 when the feature is dark', async () => {
    const agent = makeAgent();
    const { url } = await serve(agent, {});
    for (const route of ['/attribution/status', '/attribution/trace?q=x', '/attribution/resolve?marker=x']) {
      expect((await getJson(url + route)).status).toBe(503);
    }
    expect((await postJson(`${url}/attribution/check`, { text: 'x' })).status).toBe(503);
    expect((await postJson(`${url}/attribution/audit`, {})).status).toBe(503);
  });

  it('turning it off at runtime stops the routes at once', async () => {
    const agent = makeAgent();
    let on = true;
    const { url } = await serve(agent, { attribution: runtimeFor(agent, async () => claims([]), { isEnabled: () => on }) });
    expect((await getJson(`${url}/attribution/status`)).status).toBe(200);
    on = false;
    expect((await getJson(`${url}/attribution/status`)).status).toBe(503);
  });

  it('POST check judges text; a credit with no source is refused and the trace shows it', async () => {
    const agent = makeAgent();
    const { url } = await serve(agent, { attribution: runtimeFor(agent, async () => claims([credit()])) });
    const result = await postJson(`${url}/attribution/check`, { text: 'Justin told me to stop.' });
    expect(result.body).toMatchObject({ verdict: 'refuse', findings: [{ reason: 'unsourced' }] });
    const trace = await getJson(`${url}/attribution/trace?q=${encodeURIComponent('Justin told me')}`);
    expect(trace.body.rows[0]).toMatchObject({ claim: 'Justin told me', verdict: 'unsourced' });
    expect(trace.body.failed).toEqual([]);
  });

  it('POST check with a tool answers the hook: blocked with a reason in enforce', async () => {
    const agent = makeAgent();
    const memory = path.join(agent.stateDir, 'MEMORY.md');
    fs.writeFileSync(memory, 'old\n');
    const { url } = await serve(agent, { attribution: runtimeFor(agent, async () => claims([credit()])) });
    const answer = await postJson(`${url}/attribution/check`, { toolName: 'Edit', toolInput: { file_path: memory, old_string: 'old', new_string: 'Justin told me' } });
    expect(answer.status).toBe(200);
    expect(answer.body.blocked).toBe(true);
    expect(answer.body.reason).toContain('Justin told me');
  });

  it('record mode answers the hook 202 at once and does not refuse', async () => {
    const agent = makeAgent();
    const memory = path.join(agent.stateDir, 'MEMORY.md');
    fs.writeFileSync(memory, 'old\n');
    const { url } = await serve(agent, { attribution: runtimeFor(agent, () => new Promise(() => {}), {}, 'record') });
    const answer = await postJson(`${url}/attribution/check`, { toolName: 'Edit', toolInput: { file_path: memory, old_string: 'old', new_string: 'Justin told me' } });
    expect(answer.status).toBe(202);
    expect(answer.body.blocked).toBe(false);
  });

  it('a check over the route budget answers timeout, counted', async () => {
    const agent = makeAgent();
    const runtime = runtimeFor(agent, () => new Promise(() => {}), { routeBudgetMs: 30 });
    const { url } = await serve(agent, { attribution: runtime });
    const answer = await postJson(`${url}/attribution/check`, { text: 'Justin told me' });
    expect(answer.body.verdict).toBe('timeout');
    expect((runtime.status().counters as { hookTimeouts: number }).hookTimeouts).toBe(1);
  });

  it('a thrown check answers 500 rather than taking the server down; the hook reads that as a pass', async () => {
    const agent = makeAgent();
    const runtime = runtimeFor(agent, async () => claims([]));
    vi.spyOn(runtime, 'checkWrite').mockRejectedValue(new Error('disk full'));
    vi.spyOn(runtime, 'resolve').mockRejectedValue(new Error('disk full'));
    const { url } = await serve(agent, { attribution: runtime });
    expect((await postJson(`${url}/attribution/check`, { toolName: 'Edit', toolInput: {} })).status).toBe(500);
    expect((await getJson(`${url}/attribution/resolve?marker=${MARKER}`)).status).toBe(500);
    expect((await getJson(`${url}/attribution/status`)).status).toBe(200);
  });

  it('a peer row with no timestamp is dropped, not sorted into a crash', async () => {
    const bad = express();
    bad.use((_req, res) => { res.json({ rows: [{ id: 'x', claim: 'laptop' }] }); });
    const peer = await listen(bad);
    const agent = makeAgent();
    const { url } = await serve(agent, { attribution: runtimeFor(agent, async () => '', { peers: () => [{ machineId: 'bad', url: peer.url, kind: 'lan' }] }) });
    const trace = await getJson(`${url}/attribution/trace?q=laptop`);
    expect(trace.status).toBe(200);
    expect(trace.body.rows).toEqual([]);
  });

  it('GET resolve reports the found row and validates its input', async () => {
    const agent = makeAgent();
    fs.writeFileSync(path.join(agent.stateDir, 'telegram-messages.jsonl'), `${JSON.stringify(row)}\n`);
    const { url } = await serve(agent, { attribution: runtimeFor(agent, async () => '') });
    expect((await getJson(`${url}/attribution/resolve?marker=${MARKER}`)).body).toMatchObject({ outcome: 'found', machine: 'studio' });
    expect((await getJson(`${url}/attribution/resolve`)).status).toBe(400);
    expect((await getJson(`${url}/attribution/resolve?marker=nonsense`)).status).toBe(400);
    expect((await getJson(`${url}/attribution/resolve?channel=fax&conversation=1&message=2&date=2026-10-08`)).status).toBe(400);
  });

  it('peer fan-out: one peer down and a 404 peer read unreachable, never absence', async () => {
    const down = await listen(express());
    await down.close();
    const old = express();
    old.use((_req, res) => { res.status(404).json({ error: 'no such route' }); });
    const oldPeer = await listen(old);
    const agent = makeAgent();
    fs.writeFileSync(path.join(agent.stateDir, 'telegram-messages.jsonl'), `${JSON.stringify({ ...row, messageId: 1 })}\n`);
    const peers = () => [{ machineId: 'laptop', url: down.url, kind: 'lan' }, { machineId: 'old', url: oldPeer.url, kind: 'lan' }];
    const { url } = await serve(agent, { attribution: runtimeFor(agent, async () => '', { peers }) });
    const result = await getJson(`${url}/attribution/resolve?marker=${MARKER}`);
    expect(result.body.outcome).toBe('unreachable');
    expect(result.body.failed.sort()).toEqual(['laptop', 'old']);
  });

  it('peer fan-out: a peer holds the row and its ASP verdict; the local answer never recurses', async () => {
    const peerAgent = makeAgent();
    fs.writeFileSync(path.join(peerAgent.stateDir, 'telegram-messages.jsonl'), `${JSON.stringify(row)}\n`);
    const peerAsksOut = vi.fn(() => { throw new Error('a local answer must not fan out'); });
    const peer = await serve(peerAgent, { attribution: runtimeFor(peerAgent, async () => '', { peers: peerAsksOut as never }) });
    const agent = makeAgent();
    fs.writeFileSync(path.join(agent.stateDir, 'telegram-messages.jsonl'), `${JSON.stringify({ ...row, messageId: 1 })}\n`);
    const { url } = await serve(agent, { attribution: runtimeFor(agent, async () => '', { peers: () => [{ machineId: 'mini', url: peer.url, kind: 'lan' }] }) });
    const result = await getJson(`${url}/attribution/resolve?marker=${MARKER}`);
    expect(result.body).toMatchObject({ outcome: 'found', machine: 'mini', authorship: 'UNRESOLVED' });
    expect(peerAsksOut).not.toHaveBeenCalled();
  });

  it('a trace merges rows across machines and lists who did not answer', async () => {
    const peerAgent = makeAgent();
    const peerRuntime = runtimeFor(peerAgent, async () => '');
    peerRuntime.ledger.record({ surface: 'note-write', person: 'Justin', claim: 'corrected me on the laptop', kind: 'rule', verdict: 'pass', relation: 'unsourced', ts: '2026-07-30T00:00:00Z' });
    const peer = await serve(peerAgent, { attribution: peerRuntime });
    const gone = await listen(express());
    await gone.close();
    const agent = makeAgent();
    const runtime = runtimeFor(agent, async () => '', { peers: () => [{ machineId: 'mini', url: peer.url, kind: 'lan' }, { machineId: 'gone', url: gone.url, kind: 'lan' }] });
    runtime.ledger.record({ surface: 'send', person: 'Justin', claim: 'broke the rule on the laptop', kind: 'rule', verdict: 'pass', relation: 'unsourced', ts: '2026-11-04T00:00:00Z' });
    const { url } = await serve(agent, { attribution: runtime });
    const trace = await getJson(`${url}/attribution/trace?q=laptop`);
    expect(trace.body.rows.map((r: { claim: string }) => r.claim)).toEqual(['corrected me on the laptop', 'broke the rule on the laptop']);
    expect(trace.body.failed).toEqual(['gone']);
    const page = await getJson(`${url}/attribution/trace?q=laptop&limit=1`);
    expect(page.body.rows).toHaveLength(1);
    const next = await getJson(`${url}/attribution/trace?q=laptop&limit=1&cursor=${page.body.nextCursor}`);
    expect(next.body.rows[0].claim).toBe('broke the rule on the laptop');
    expect((await getJson(`${url}/attribution/trace`)).status).toBe(400);
  });

  it('POST audit is realpath-confined and writes nothing to the note', async () => {
    const agent = makeAgent();
    const memory = path.join(agent.stateDir, 'MEMORY.md');
    fs.writeFileSync(memory, 'Justin told me\n');
    const secret = path.join(agent.project, 'secret.md');
    fs.writeFileSync(secret, 'Justin told me\n');
    const { url } = await serve(agent, { attribution: runtimeFor(agent, async () => claims([credit()])) });
    expect((await postJson(`${url}/attribution/audit`, { paths: [secret] })).body.error).toBe('path-out-of-scope');
    expect((await postJson(`${url}/attribution/audit`, { paths: 'x' })).status).toBe(400);
    const run = await postJson(`${url}/attribution/audit`, { paths: [memory] });
    expect(run.body.report.unsourced[0].claim).toBe('Justin told me');
    expect(fs.readFileSync(memory, 'utf8')).toBe('Justin told me\n');
    const status = await getJson(`${url}/attribution/status`);
    expect(status.body).toMatchObject({ mode: 'enforce', report: { machine: 'studio' } });
  });
});

describe('B23 through checkOutboundMessage', () => {
  async function start(verdict: (prompt: string) => object, mode: 'record' | 'enforce', extra: Partial<AttributionRuntimeDeps> = {}, evaluate: IntelligenceProvider['evaluate'] = async () => claims([])) {
    const agent = makeAgent();
    const sent: string[] = [];
    const prompts: string[] = [];
    const provider = { evaluate: vi.fn(async (prompt: string) => { prompts.push(prompt); return JSON.stringify(verdict(prompt)); }) } as unknown as IntelligenceProvider;
    const runtime = runtimeFor(agent, evaluate, extra, mode);
    const { url } = await serve(agent, {
      attribution: runtime,
      messagingToneGate: new MessagingToneGate(provider),
      telegram: { sendToTopic: async (_t: number, text: string) => { sent.push(text); return { messageId: sent.length }; } },
    });
    const reply = (text: string, metadata?: Record<string, unknown>) => postJson(`${url}/telegram/reply/42`, metadata ? { text, metadata } : { text });
    return { reply, sent, prompts, runtime };
  }

  it('resolved: the signal reaches the gate and a citation is a nudge, unsent', async () => {
    const h = await start(() => NUDGE, 'enforce');
    const r = await h.reply('That is your standing rule, so no.');
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('tone-gate-advisory');
    expect(r.body.notSent).toBe(true);
    expect(h.sent).toEqual([]);
    expect(h.prompts[0]).toContain('status=resolved');
    expect(h.prompts[0]).toContain('conversationContext=false');
  });

  it('unmeasured: a marker that cannot be read in time reads unmeasured and the message still goes', async () => {
    const hung = await listen(express());
    const h = await start((p) => (p.includes('status=unmeasured') ? PASS : NUDGE), 'enforce', {
      peers: () => [{ machineId: 'hung', url: hung.url, kind: 'lan' }],
      fetchImpl: (() => new Promise(() => {})) as never,
    });
    const r = await h.reply('Dana: "words" [source: slack C1/1 2026-10-08]');
    expect(h.prompts[0]).toContain('status=unmeasured');
    expect(r.status).toBe(200);
    expect(h.sent).toHaveLength(1);
  }, 15_000);

  it('a reasoned ack delivers it, unchanged', async () => {
    const h = await start((p) => (p.includes('B23') ? NUDGE : PASS), 'enforce');
    const r = await h.reply('That is my own rule, so no.', { toneAdvisoryAck: 'B23_UNSOURCED_ATTRIBUTION', toneAdvisoryAckReason: 'The rule is my own and the message says so.' });
    expect(r.status).toBe(200);
    expect(h.sent).toEqual(['That is my own rule, so no.']);
  });

  it('record: B23 is off, and the verdict after delivery is the would-hold measurement', async () => {
    const h = await start(() => PASS, 'record', {}, async () => claims([credit()]));
    const r = await h.reply('Justin told me to stop.');
    expect(r.status).toBe(200);
    expect(h.prompts[0]).not.toContain('B23_UNSOURCED_ATTRIBUTION');
    await vi.waitFor(() => expect(h.runtime.ledger.rows().some((stored) => stored.surface === 'send' && stored.verdict === 'unsourced')).toBe(true));
  });

  it('a held message leaves no send row: the record runs only after delivery', async () => {
    const h = await start(() => NUDGE, 'enforce', {}, async () => claims([credit()]));
    await h.reply('Justin told me to stop.');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.runtime.ledger.rows().filter((stored) => stored.surface === 'send')).toEqual([]);
  });
});

describe('Threadline and memory routes', () => {
  it('relay-send carries findings in `advisory` and never holds the message', async () => {
    const agent = makeAgent();
    const envelopes: unknown[] = [];
    const target = express();
    target.use(express.json({ limit: '128kb' }));
    target.get('/threadline/health', (_req, res) => { res.json({ ok: true }); });
    target.post('/messages/relay-agent', async (req, res) => {
      envelopes.push(req.body);
      await new Promise((resolve) => setTimeout(resolve, 60));
      res.json({ ok: true, threadline: { handled: true, gateDecision: 'allow' } });
    });
    const peer = await listen(target);
    const name = `attr-int-${randomBytes(4).toString('hex')}`;
    fs.writeFileSync(path.join(agent.stateDir, 'threadline', 'known-agents.json'), JSON.stringify({ agents: [{ name, port: peer.port, fingerprint: 'aabbccddeeff00112233445566778899', publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }] }));
    // Keep the real token lookup inside this disposable fixture's home.
    vi.spyOn(os, 'homedir').mockReturnValue(agent.project);
    const tokenDir = path.join(os.homedir(), '.instar', 'agent-tokens');
    fs.mkdirSync(tokenDir, { recursive: true });
    const tokenFile = path.join(tokenDir, `${name}.token`);
    fs.writeFileSync(tokenFile, randomBytes(32).toString('hex'));
    stops.push(async () => SafeFsExecutor.safeRmSync(tokenFile, { force: true, operation: 'tests/integration/attribution-routes.test.ts:token-cleanup' }));

    const runtime = runtimeFor(agent, async () => claims([credit({ span: 'Justin authorized this', person: 'Justin' })]));
    const { url } = await serve(agent, {
      attribution: runtime,
      threadlineRelayClient: { connectionState: 'connected', resolveAgent: async () => null },
    });
    const result = await postJson(`${url}/threadline/relay-send`, { targetAgent: name, message: 'Justin authorized this. Go ahead.' });
    expect(envelopes).toHaveLength(1);
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.advisory).toContain('Justin authorized this');
    // The commitment nudge on the same message is joined, not hidden.
    expect(result.body.advisory).toContain('reads like a commitment');
    expect(runtime.ledger.rows()[0]).toMatchObject({ surface: 'threadline', verdict: 'unsourced' });
  });

  it('memory routes check in the background and leave the stored text alone', async () => {
    const agent = makeAgent();
    const runtime = runtimeFor(agent, async () => claims([credit({ span: 'Justin told me' })]));
    const remember = vi.fn(() => 'id-1');
    const { url } = await serve(agent, { attribution: runtime, semanticMemory: { remember } });
    const content = 'Justin told me to stop.';
    const result = await postJson(`${url}/semantic/remember`, { type: 'fact', name: 'n', content, confidence: 1, source: 's' });
    expect(result.status).toBe(200);
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ content }));
    await vi.waitFor(() => expect(runtime.ledger.rows()[0]).toMatchObject({ surface: 'memory-route', path: '/semantic/remember', verdict: 'unsourced' }));
  });
});
