// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * E2E (HTTP) lifecycle test for the duplicate-session stand-down.
 *
 * Spec: docs/specs/duplicate-session-standdown.md
 *
 * Tier 3 — boots a REAL Express server on a real port and makes REAL HTTP
 * calls. The single most important assertion is the Phase-1 one: the feature is
 * ALIVE (200, not 404/503) and the whole muzzle runs end-to-end over HTTP —
 * register → tool call blocked → send refused → drained → released.
 *
 * It also pins the two things a reviewer would most want proven at the wire:
 *  - a 409 `standing-down` on the CONVERSATIONAL send funnel, not a 500 and not
 *    a silent drop;
 *  - the FIRE-TIME ownership re-check: when ownership has returned to this
 *    machine, the muzzle lifts at the moment of the send rather than making the
 *    rightful speaker wait out the release hysteresis.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { StandDownRegistry } from '../../src/core/StandDownRegistry.js';
import { StandDownAudit } from '../../src/core/StandDownAudit.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

const SESSION = 'topic-46473';
const TOPIC = 46473;

describe('duplicate-session stand-down — (E2E over HTTP)', () => {
  let server: TestServer;
  let tmpDir: string;
  let registry: StandDownRegistry;
  let audit: StandDownAudit;
  let sentTexts: string[];
  let currentOwner: string | null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standdown-e2e-'));
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      authToken: 'test', port: 0, dashboardPin: '123456',
      monitoring: { standDown: { enabled: true, dryRun: false } },
    }));
    const liveConfig = new LiveConfig(tmpDir);
    registry = new StandDownRegistry({ stateDir: tmpDir });
    audit = new StandDownAudit({ stateDir: tmpDir });
    sentTexts = [];
    currentOwner = 'laptop-a'; // owned ELSEWHERE by default

    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 'test', stateDir: tmpDir, port: 0, dashboardPin: '123456' },
      liveConfig,
      standDownRegistry: registry,
      standDownAudit: audit,
      meshSelfId: 'mini-b',
      sessionOwnershipRegistry: { ownerOf: () => currentOwner },
      telegram: {
        sendToTopic: async (_t: number, text: string) => { sentTexts.push(text); return true; },
        getTopicHistory: () => [],
      },
      startTime: new Date(),
    };
    app.use(createRoutes(ctx));
    server = await listen(app);
  });
  afterEach(async () => { await server?.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const authed = { 'Content-Type': 'application/json', Authorization: 'Bearer test' };
  const evaluate = async (body: object) => {
    const res = await fetch(`${server.url}/standdown/evaluate`, { method: 'POST', headers: authed, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const reply = async (text: string) => {
    const res = await fetch(`${server.url}/telegram/reply/${TOPIC}`, { method: 'POST', headers: authed, body: JSON.stringify({ text }) });
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
  };
  const standdown = async () => {
    const res = await fetch(`${server.url}/standdown`, { headers: authed });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  const register = (dryRun = false) => registry.register({
    sessionName: SESSION, topicId: TOPIC, ownerMachineId: 'laptop-a', ownershipEpoch: 3,
    reason: 'duplicate', dryRun,
  }, 'mini-b');

  it('FEATURE IS ALIVE: GET /standdown answers 200 with the live entry', async () => {
    register();
    const r = await standdown();
    expect(r.status).toBe(200); // not 404/503 — the route exists and is wired
    expect((r.body.entries as unknown[])).toHaveLength(1);
    expect(r.body).toMatchObject({ enabled: true, machineId: 'mini-b' });
  });

  it('blocks a mutating tool call and allows an observation-local one', async () => {
    register();
    expect((await evaluate({ sessionName: SESSION, tool: 'Bash' })).body)
      .toMatchObject({ verdict: 'block', ownerMachineId: 'laptop-a' });
    // The hook never asks about allowlisted tools, but if it did, the server's
    // verdict must not depend on the tool: the ALLOWLIST lives in the hook, and
    // the server's job is the authoritative "is this session muzzled".
    expect((await evaluate({ sessionName: 'some-other-session', tool: 'Bash' })).body)
      .toMatchObject({ verdict: 'allow', reason: 'no-entry' });
  });

  it('refuses the conversational send with 409 standing-down, naming the owner machine', async () => {
    register();
    const r = await reply('here is my answer');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'standing-down', ownerMachineId: 'laptop-a', retryable: false });
    expect(sentTexts).toHaveLength(0); // nothing reached the user from this copy
  });

  it('FIRE-TIME OWNERSHIP RE-CHECK: a returned owner lifts the muzzle at the send', async () => {
    register();
    // Ownership comes back to THIS machine — a topic-keyed muzzle must not
    // outlive the ownership fact it mirrors, and the rightful speaker must not
    // wait out the release hysteresis.
    currentOwner = 'mini-b';
    const r = await reply('I can answer again');
    expect(r.status).not.toBe(409);
    expect(registry.getBySession(SESSION)).toBeNull(); // released on the spot
  });

  it('an UNRESOLVABLE ownership read releases rather than refuses (fail toward reachability)', async () => {
    register();
    // The registry being unwired says nothing about who owns the conversation.
    // Refusing on a null read would make an infrastructure gap look like a
    // duplicate and silence a legitimate reply.
    currentOwner = null;
    const r = await reply('ownership is unreadable right now');
    expect(r.status).not.toBe(409);
    expect(registry.getBySession(SESSION)).toBeNull();
  });

  it('dryRun records the would-block/would-refuse and blocks NOTHING', async () => {
    register(true);
    expect((await evaluate({ sessionName: SESSION, tool: 'Bash' })).body)
      .toMatchObject({ verdict: 'allow', wouldBlock: true, reason: 'dry-run' });
    expect((await reply('a dry-run reply')).status).not.toBe(409);
    // The soak's evidence is on disk, per-call and un-coalesced.
    const rows = fs.readFileSync(path.join(tmpDir, 'logs', 'standdown.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.some((r) => r.transition === 'blocked-call' && r.dryRun === true)).toBe(true);
    expect(rows.some((r) => r.transition === 'refused-send' && r.dryRun === true)).toBe(true);
  });

  it('every uncertainty at the evaluate route answers ALLOW (fail-open)', async () => {
    expect((await evaluate({ sessionName: SESSION, tool: 'Bash' })).body).toMatchObject({ verdict: 'allow', reason: 'no-entry' });
    expect((await evaluate({ tool: 'Bash' })).body).toMatchObject({ verdict: 'allow', reason: 'bad-request-failopen' });
  });

  it('an expired episode stays enforced and only the operator ack releases it', async () => {
    register();
    registry.expire(SESSION);
    // BOTH halves persist past expiry — a frozen session, zero destruction.
    expect((await evaluate({ sessionName: SESSION, tool: 'Bash' })).body).toMatchObject({ verdict: 'block' });
    expect((await reply('still muzzled')).status).toBe(409);
    // The agent's own Bearer token is structurally insufficient here: a
    // Bearer-only exit would let another live session of THIS agent clear a
    // decision the human was asked to make.
    const bearerOnly = await fetch(`${server.url}/standdown/${SESSION}/operator-release`, {
      method: 'POST', headers: authed, body: JSON.stringify({}),
    });
    expect(bearerOnly.status).toBe(403);
    expect((await evaluate({ sessionName: SESSION, tool: 'Bash' })).body).toMatchObject({ verdict: 'block' });

    const rel = await fetch(`${server.url}/standdown/${SESSION}/operator-release`, {
      method: 'POST', headers: authed, body: JSON.stringify({ pin: '123456' }),
    });
    expect(rel.status).toBe(200);
    expect((await evaluate({ sessionName: SESSION, tool: 'Bash' })).body).toMatchObject({ verdict: 'allow', reason: 'no-entry' });
    expect((await reply('answering again')).status).not.toBe(409);
  });

  it('503s honestly when the feature is dark on this agent', async () => {
    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config: { authToken: 'test', stateDir: tmpDir, port: 0 }, startTime: new Date() } as any));
    const dark = await listen(app);
    try {
      const r = await fetch(`${dark.url}/standdown`, { headers: authed });
      expect(r.status).toBe(503);
      // …but the hook's evaluate still fails OPEN rather than 503ing, so a dark
      // feature can never block a tool call.
      const ev = await fetch(`${dark.url}/standdown/evaluate`, { method: 'POST', headers: authed, body: JSON.stringify({ sessionName: SESSION, tool: 'Bash' }) });
      expect(ev.status).toBe(200);
      expect(await ev.json()).toMatchObject({ verdict: 'allow', reason: 'feature-disabled' });
    } finally { await dark.close(); }
  });
});
