// safe-fs-allow: test file — temp dirs only.
/**
 * sibling-machine-reach — the integration tier (docs/specs/sibling-machine-reach.md §6).
 *
 * A real HTTP stub PEER serves /subscription-pool and /playwright-profiles?view=accounts;
 * the real createRoutes is wired with resolvePeerUrls pointing at it and a real
 * MessagingToneGate over a stub provider. Covered:
 *  - after a refresh, a B21 that cites a sibling profile returns 422 with otherMachine
 *    and the hint in `suggestion` (what the reply scripts print);
 *  - a B17 whose local-only re-review passes is NOT a hard block (sibling data alone
 *    never walls a message); a local B17 still blocks; a re-review B17 after a B21 wins;
 *  - model-quoted sibling emails are redacted in the 422;
 *  - peer down → no hint; switch off → nothing fetched;
 *  - GET /playwright-profiles?view=accounts answers the agent bearer without the dev
 *    gate, reads no vault, creates no registry file, and refuses other credentials;
 *  - the plain /subscription-pool names the answering machine.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import { installDecisionQualityRecorder } from '../../src/core/DecisionQualityRecorderImpl.js';

const MINI = 'm-mini';
const SELF = 'm-studio';
const FOUR = ['gearfinity@example.com', 'justin@example.com', 'appyhapi@example.com', 'dawn@example.com'];
const ASK_1120 =
  'Four accounts are missing on the Studio after the rebuild. To fix it: open the dashboard, enter your PIN, then sign in gearfinity, justin, appyhapi and dawn on the Studio (Accounts → Set up → follow the browser prompts).';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  installDecisionQualityRecorder(null);
  for (const c of closers.splice(0)) await c();
});

async function listen(handler: http.RequestListener): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, server };
}

async function stubPeer(opts: { up?: () => boolean; machineId?: string } = {}) {
  const hits: string[] = [];
  const peer = await listen((req, res) => {
    hits.push(req.url ?? '');
    if (opts.up && !opts.up()) { res.statusCode = 500; res.end('{}'); return; }
    if (req.headers.authorization !== 'Bearer test') { res.statusCode = 401; res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/subscription-pool') {
      res.end(JSON.stringify({ enabled: true, machineId: opts.machineId ?? MINI, count: 4, accounts: FOUR.map((e, i) => ({ id: `acct-${i}`, nickname: `acct-${i}`, email: e, provider: 'anthropic', status: 'active', loginCheck: 'ok' })) }));
      return;
    }
    if (req.url === '/playwright-profiles?view=accounts') {
      res.end(JSON.stringify({ machineId: opts.machineId ?? MINI, view: 'accounts', profiles: [{ id: 'p', accounts: FOUR.map((e) => ({ service: 'google', identity: e, owner: 'operator', lastAsserted: true, lastVerifiedAt: new Date().toISOString() })) }] }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  return { ...peer, hits };
}

/** A gate whose stub model answers per prompt: `judge(prompt)` → JSON verdict. */
function gateWith(judge: (prompt: string) => Record<string, unknown>) {
  const prompts: string[] = [];
  const provider = { evaluate: vi.fn(async (p: string) => { prompts.push(p); return JSON.stringify(judge(p)); }) } as unknown as IntelligenceProvider;
  return { gate: new MessagingToneGate(provider), prompts };
}

async function app(opts: { gate: MessagingToneGate; peerUrl?: string; config?: Record<string, unknown>; stateDir?: string }) {
  installDecisionQualityRecorder({ isRecordingLive: () => true } as never);
  const express = (await import('express')).default;
  const { createRoutes } = await import('../../src/server/routes.js');
  const stateDir = opts.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-reach-int-'));
  const sent: string[] = [];
  const router = createRoutes({
    config: { authToken: 'test', stateDir, projectDir: path.dirname(stateDir), port: 0, projectName: 'echo', developmentAgent: true, ...(opts.config ?? {}) },
    messagingToneGate: opts.gate,
    meshSelfId: SELF,
    resolvePeerUrls: () => (opts.peerUrl ? [{ machineId: MINI, url: opts.peerUrl, kind: 'lan' }] : []),
    listPoolMachines: () => [{ machineId: SELF }, { machineId: MINI, nickname: 'Mac Mini' }],
    machinePoolRegistry: { getCapacity: (id: string) => (id === MINI ? { nickname: 'Mac Mini', online: true } : null) },
    topicOperatorStore: { asVerifiedOperator: () => ({ uid: 'u', displayName: 'Op' }), all: () => ({}) },
    telegram: { sendToTopic: async (t: number, text: string) => { sent.push(text); return { messageId: sent.length, topicId: t }; } },
    sessionManager: { clearInjectionTracker: () => {} },
  } as never);
  const cache = (router as unknown as { siblingHoldings?: { refresh(): Promise<void>; stop(): void } }).siblingHoldings;
  closers.push(async () => cache?.stop());
  const e = express();
  e.use(express.json());
  e.use(router);
  const srv = await listen(e as unknown as http.RequestListener);
  const send = async (text: string, topic = 146512) => {
    const r = await fetch(`${srv.url}/telegram/reply/${topic}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify({ text }) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  return { cache, send, sent, url: srv.url, stateDir };
}

describe('sibling-machine-reach — through the real outbound route', () => {
  it('a B21 citing the Mini profile returns 422 with the route hint (in suggestion, which the reply scripts print)', async () => {
    const peer = await stubPeer();
    const { gate, prompts } = gateWith((p) => (p.includes('=== OTHER MACHINES')
      ? { pass: false, rule: 'B21_USER_TASK_SUBSTITUTION', issue: 'Hands gearfinity@example.com sign-in to the operator.', suggestion: 'Do it from the Mini instead.', siblingProfileRef: 'S1' }
      : { pass: false, rule: 'B21_USER_TASK_SUBSTITUTION', issue: 'procedure', suggestion: 'do it yourself' }));
    const a = await app({ gate, peerUrl: peer.url });
    await a.cache!.refresh();
    const r = await a.send(ASK_1120);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('tone-gate-advisory');
    const om = r.body.otherMachine as Record<string, unknown>;
    expect(om.machineId).toBe(MINI);
    expect(om.machine).toBe('Mac Mini');
    expect(om.address).toBe(peer.url);
    expect(String(r.body.suggestion)).toContain('approve it on Mac Mini through a helper session there');
    expect(String(r.body.howToProceed)).toContain('Mac Mini');
    // No identity or email anywhere in the 422 (model text redacted, server hint templated).
    for (const e of FOUR) expect(JSON.stringify(r.body)).not.toContain(e);
    // Two reviews: sibling-aware, then the local-only re-check (no OTHER MACHINES section).
    expect(prompts.filter((p) => p.includes('=== OTHER MACHINES'))).toHaveLength(1);
    expect(prompts.filter((p) => !p.includes('=== OTHER MACHINES'))).toHaveLength(1);
    expect(a.sent).toHaveLength(0);
    // What the reply script prints from this body:
    const printed = execFileSync('python3', ['-c', 'import sys,json; print(json.load(sys.stdin).get("suggestion",""))'], { input: JSON.stringify(r.body) }).toString();
    expect(printed).toContain('Mac Mini');
  });

  it('a B17 that only the sibling-aware prompt returns is NOT a hard block: the local re-review decides', async () => {
    const peer = await stubPeer();
    const { gate } = gateWith((p) => (p.includes('=== OTHER MACHINES')
      ? { pass: false, rule: 'B17_FALSE_BLOCKER', issue: 'held access', suggestion: 'x' }
      : { pass: true, rule: '', issue: '', suggestion: '' }));
    const a = await app({ gate, peerUrl: peer.url });
    await a.cache!.refresh();
    const r = await a.send(ASK_1120);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(a.sent).toHaveLength(1);
  });

  it('a sibling-sourced B17 whose local re-review gives no verdict is never a confirmed B17', async () => {
    const peer = await stubPeer();
    const prompts: string[] = [];
    const provider = { evaluate: vi.fn(async (p: string) => {
      prompts.push(p);
      if (p.includes('=== OTHER MACHINES')) return JSON.stringify({ pass: false, rule: 'B17_FALSE_BLOCKER', issue: 'held', suggestion: 'x' });
      throw new Error('provider down');
    }) } as unknown as IntelligenceProvider;
    const a = await app({ gate: new MessagingToneGate(provider), peerUrl: peer.url });
    await a.cache!.refresh();
    const r = await a.send(ASK_1120);
    expect(r.body.rule === 'B17_FALSE_BLOCKER' && r.body.error === 'tone-gate-blocked' && !r.body.failedClosed && !r.body.degradedToDeterministic).toBe(false);
  });

  it('a local B17 still blocks with other machines present', async () => {
    const peer = await stubPeer();
    const { gate } = gateWith(() => ({ pass: false, rule: 'B17_FALSE_BLOCKER', issue: 'held access', suggestion: 'use your vault' }));
    const a = await app({ gate, peerUrl: peer.url });
    await a.cache!.refresh();
    const r = await a.send(ASK_1120);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('tone-gate-blocked');
    expect(r.body.otherMachine).toBeUndefined();
  });

  it('a local-only B17 wins over a sibling-aware B21', async () => {
    const peer = await stubPeer();
    const { gate } = gateWith((p) => (p.includes('=== OTHER MACHINES')
      ? { pass: false, rule: 'B21_USER_TASK_SUBSTITUTION', issue: 'x', suggestion: 'y' }
      : { pass: false, rule: 'B17_FALSE_BLOCKER', issue: 'held access locally', suggestion: 'use your vault' }));
    const a = await app({ gate, peerUrl: peer.url });
    await a.cache!.refresh();
    const r = await a.send(ASK_1120);
    expect(r.body.rule).toBe('B17_FALSE_BLOCKER');
    expect(r.body.error).toBe('tone-gate-blocked');
  });

  it('an invalid or unknown siblingProfileRef attaches nothing', async () => {
    const peer = await stubPeer();
    const { gate } = gateWith(() => ({ pass: false, rule: 'B21_USER_TASK_SUBSTITUTION', issue: 'x', suggestion: 'y', siblingProfileRef: 'S99' }));
    const a = await app({ gate, peerUrl: peer.url });
    await a.cache!.refresh();
    const r = await a.send(ASK_1120);
    expect(r.status).toBe(422);
    expect(r.body.otherMachine).toBeUndefined();
  });

  it('peer down → the Mini is UNKNOWN: no OTHER MACHINES evidence, no hint', async () => {
    const peer = await stubPeer({ up: () => false });
    const { gate, prompts } = gateWith(() => ({ pass: true, rule: '', issue: '', suggestion: '' }));
    const a = await app({ gate, peerUrl: peer.url });
    await a.cache!.refresh();
    const r = await a.send(ASK_1120);
    expect(r.status).toBe(200);
    const p = prompts[0];
    expect(p).toContain('UNKNOWN right now');
    expect(p).not.toContain('[S1]');
  });

  it('switch off → nothing fetched and the prompt has no OTHER MACHINES section', async () => {
    const peer = await stubPeer();
    const { gate, prompts } = gateWith(() => ({ pass: true, rule: '', issue: '', suggestion: '' }));
    const a = await app({ gate, peerUrl: peer.url, config: { toneGate: { siblingReach: { enabled: false } } } });
    await (a.cache as unknown as { tick(): Promise<void> }).tick();
    expect(peer.hits).toHaveLength(0);
    await a.send(ASK_1120);
    expect(prompts[0]).not.toContain('OTHER MACHINES');
  });
});

describe('sibling-machine-reach — the peer-facing routes', () => {
  it('GET /playwright-profiles?view=accounts: agent bearer only, no dev gate, no vault, no file created', async () => {
    const { gate } = gateWith(() => ({ pass: true, rule: '', issue: '', suggestion: '' }));
    const a = await app({ gate, config: { developmentAgent: false } });
    const r = await fetch(`${a.url}/playwright-profiles?view=accounts`, { headers: { Authorization: 'Bearer test' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ machineId: SELF, view: 'accounts', profiles: [] });
    expect(fs.existsSync(path.join(a.stateDir, 'playwright-profiles.json'))).toBe(false);
    const full = await fetch(`${a.url}/playwright-profiles`, { headers: { Authorization: 'Bearer test' } });
    expect(full.status).toBe(503); // the full view stays dev-gated
  });

  it('GET /subscription-pool names the answering machine', async () => {
    const { gate } = gateWith(() => ({ pass: true, rule: '', issue: '', suggestion: '' }));
    const a = await app({ gate });
    const r = await fetch(`${a.url}/subscription-pool`, { headers: { Authorization: 'Bearer test' } });
    expect(await r.json()).toMatchObject({ machineId: SELF });
  });

  it('GET /subscription-pool?scope=pool carries siblingReach with identities for the agent bearer', async () => {
    const peer = await stubPeer();
    const { gate } = gateWith(() => ({ pass: true, rule: '', issue: '', suggestion: '' }));
    const a = await app({ gate, peerUrl: peer.url });
    await a.cache!.refresh();
    const r = await fetch(`${a.url}/subscription-pool?scope=pool`, { headers: { Authorization: 'Bearer test' } });
    const body = (await r.json()) as { siblingReach: { armed: boolean; machines: Array<Record<string, unknown>> } };
    expect(body.siblingReach.armed).toBe(true);
    const mini = body.siblingReach.machines.find((m) => m.machineId === MINI)!;
    expect((mini.browserAccounts as unknown[]).length).toBe(4);
  });
});
