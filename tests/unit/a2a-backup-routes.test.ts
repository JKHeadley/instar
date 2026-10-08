/**
 * Unit tier — A2A backup routes (docs/specs/a2a-backup-routes.md).
 *
 *  A. The pure rules (src/threadline/backupRoutes.ts): the marking set, the
 *     fetch-error mapping, the exact-32-hex test, the de-duplicated selection
 *     and the live-health precondition.
 *  B. The REAL /threadline/relay-send route with a capturing relay-client stub
 *     and real loopback target servers: every marking outcome, the relay leg's
 *     thread after a POST (with and without a caller thread), no-POST
 *     fall-throughs, the fingerprint branch (exact, exclusive, de-duplicated,
 *     credential-skipped, health-gated), the gate off / live read, and the
 *     counters on the authed /health.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createRoutes } from '../../src/server/routes.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import {
  backupLogLine,
  checkFingerprintHealth,
  classifyFallthrough,
  fetchErrorCode,
  isExactFingerprintTarget,
  outcomeFromFetchError,
  resolveBackupRoutesEnabled,
  selectFingerprintTarget,
} from '../../src/threadline/backupRoutes.js';

// ── A. pure rules ─────────────────────────────────────────────────

describe('classifyFallthrough — the marking set', () => {
  it('no POST → unmarked, keeps today\'s thread handling', () => {
    expect(classifyFallthrough({ kind: 'no-post' })).toEqual({ postIssued: false, marked: false, outcome: 'no-post' });
  });
  it.each([
    [{ kind: 'error', code: 'ECONNREFUSED' } as const, 'econnrefused'],
    [{ kind: 'status', status: 400 } as const, 'http-400'],
    [{ kind: 'status', status: 401 } as const, 'http-401'],
    [{ kind: 'status', status: 404 } as const, 'http-404'],
    [{ kind: 'status', status: 503, ledgerUnavailable: true } as const, 'http-503-ledger-unavailable'],
  ])('proven non-admission %j → unmarked (%s)', (o, label) => {
    expect(classifyFallthrough(o)).toEqual({ postIssued: true, marked: false, outcome: label });
  });
  it.each([
    [{ kind: 'error', name: 'TimeoutError' } as const, 'timeout'],
    [{ kind: 'error', code: 'ECONNRESET' } as const, 'econnreset'],
    [{ kind: 'error', code: 'EPIPE' } as const, 'epipe'],
    [{ kind: 'error' } as const, 'socket-error'],
    [{ kind: 'status', status: 503 } as const, 'http-503'],
    [{ kind: 'status', status: 500 } as const, 'http-500'],
    [{ kind: 'status', status: 502 } as const, 'http-502'],
    [{ kind: 'status', status: 409 } as const, 'http-409'],
    [{ kind: 'status', status: 418 } as const, 'http-418'],
    [{ kind: 'status', status: 200 } as const, 'throw-after-http-200'],
    [{ kind: 'issued' } as const, 'unknown-after-post'],
  ])('%j → marked (%s)', (o, label) => {
    expect(classifyFallthrough(o)).toEqual({ postIssued: true, marked: true, outcome: label });
  });
});

describe('fetch error mapping', () => {
  it('reads undici\'s cause.code, and an all-refused AggregateError', () => {
    expect(fetchErrorCode(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe('ECONNREFUSED');
    expect(fetchErrorCode(Object.assign(new TypeError('fetch failed'), { cause: { errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] } }))).toBe('ECONNREFUSED');
    expect(fetchErrorCode(Object.assign(new TypeError('fetch failed'), { cause: { errors: [{ code: 'ECONNREFUSED' }, { code: 'ETIMEDOUT' }] } }))).not.toBe('ECONNREFUSED');
    expect(fetchErrorCode(new Error('plain'))).toBeUndefined();
  });
  it('an AbortSignal timeout is a timeout (marked)', () => {
    const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(classifyFallthrough(outcomeFromFetchError(err))).toMatchObject({ marked: true, outcome: 'timeout' });
  });
});

describe('fingerprint target rules', () => {
  const FP = 'ab'.repeat(16);
  it('exactly 32 hex, case-folded', () => {
    expect(isExactFingerprintTarget(FP)).toBe(true);
    expect(isExactFingerprintTarget(FP.toUpperCase())).toBe(true);
    expect(isExactFingerprintTarget(FP.slice(1))).toBe(false);
    expect(isExactFingerprintTarget(`${FP}a`)).toBe(false);
    expect(isExactFingerprintTarget(`${FP.slice(1)}g`)).toBe(false);
    expect(isExactFingerprintTarget(undefined)).toBe(false);
  });
  it('selects by resolved fingerprint (fingerprint, else publicKey[:32]), de-duplicated by (fingerprint, port)', () => {
    const a = { name: 'a', port: 1, fingerprint: FP.toUpperCase() };
    const dup = { name: 'a-alias', port: 1, publicKey: `${FP}zzzz` };
    expect(selectFingerprintTarget([a, dup], FP)).toEqual({ kind: 'one', entry: a });
    expect(selectFingerprintTarget([a, { name: 'b', port: 2, fingerprint: FP }], FP)).toMatchObject({ kind: 'ambiguous', ports: [1, 2] });
    expect(selectFingerprintTarget([{ name: FP, port: 3, fingerprint: 'cd'.repeat(16) }], FP)).toEqual({ kind: 'none' });
  });
  it('health must show the same fingerprint AND a connected relay', () => {
    expect(checkFingerprintHealth(true, { fingerprint: FP.toUpperCase(), relay: { state: 'connected' } }, FP)).toEqual({ ok: true });
    expect(checkFingerprintHealth(false, { fingerprint: FP, relay: { state: 'connected' } }, FP)).toMatchObject({ ok: false, reason: 'not-ok' });
    expect(checkFingerprintHealth(true, { relay: { state: 'connected' } }, FP)).toMatchObject({ reason: 'fingerprint-absent' });
    expect(checkFingerprintHealth(true, { fingerprint: 'cd'.repeat(16), relay: { state: 'connected' } }, FP)).toMatchObject({ reason: 'fingerprint-mismatch' });
    for (const state of ['not-configured', 'displaced', 'disconnected', undefined]) {
      expect(checkFingerprintHealth(true, { fingerprint: FP, relay: { state } }, FP)).toMatchObject({ reason: 'relay-not-connected' });
    }
  });
  it('the gate: omitted ⇒ developmentAgent; an explicit (live) value wins', () => {
    expect(resolveBackupRoutesEnabled(undefined, { developmentAgent: true })).toBe(true);
    expect(resolveBackupRoutesEnabled(undefined, { developmentAgent: false })).toBe(false);
    expect(resolveBackupRoutesEnabled(false, { developmentAgent: true })).toBe(false);
    expect(resolveBackupRoutesEnabled(undefined, { developmentAgent: true, threadline: { backupRoutes: { enabled: false } } })).toBe(false);
    expect(resolveBackupRoutesEnabled(true, { developmentAgent: false })).toBe(true);
  });
  it('the log line shape', () => {
    expect(backupLogLine('marked-fallthrough', 'msg-1', FP, 'timeout')).toBe(`[a2a-backup] id=msg-1 peer=${FP} kind=marked-fallthrough outcome=timeout`);
  });
});

// ── B. the real route ─────────────────────────────────────────────

type Mode =
  | { post: 'ok' }
  | { post: 'status'; status: number; body: unknown }
  | { post: 'reset' }
  | { post: 'refuse' } // health answers, then the server closes before the POST
  | { health: 'fail' };

interface Target {
  name: string;
  fp: string;
  server: Server;
  port: number;
  mode: Mode;
  health: Record<string, unknown>;
  envelopes: Array<{ message: { id: string; threadId: string } }>;
  healthHits: number;
  tokenPath: string;
}

const TOKEN = 'backup-routes-unit-token';
const tokenDir = path.join(os.homedir(), '.instar', 'agent-tokens');
const targets: Target[] = [];

async function startTarget(name: string, fp: string): Promise<Target> {
  const t = { name, fp, mode: { post: 'ok' } as Mode, health: {}, envelopes: [], healthHits: 0 } as unknown as Target;
  const app = express();
  app.use(express.json({ limit: '128kb' }));
  app.get('/threadline/health', (_req, res) => {
    t.healthHits++;
    if ('health' in t.mode) { res.status(500).json({ error: 'down' }); return; }
    if ('post' in t.mode && t.mode.post === 'refuse') {
      // Stop LISTENING now (this connection still answers), and refuse keep-alive
      // reuse, so the POST must open a new connection — which is refused.
      t.server.close();
      res.set('Connection', 'close');
      res.json(t.health);
      return;
    }
    res.json(t.health);
  });
  app.post('/messages/relay-agent', (req, res) => {
    t.envelopes.push(req.body);
    const m = t.mode;
    if ('post' in m && m.post === 'status') { res.status(m.status).json(m.body); return; }
    if ('post' in m && m.post === 'reset') { req.socket.destroy(); return; }
    res.json({ ok: true, accepted: true, delivered: false, threadline: { accepted: true, delivered: false, async: true } });
  });
  await new Promise<void>((resolve) => {
    t.server = app.listen(0, '127.0.0.1', () => { t.port = (t.server.address() as { port: number }).port; resolve(); });
  });
  fs.mkdirSync(tokenDir, { recursive: true });
  t.tokenPath = path.join(tokenDir, `${name}.token`);
  fs.writeFileSync(t.tokenPath, randomBytes(32).toString('hex'));
  targets.push(t);
  return t;
}

/** Restart a target on the SAME port after a 'refuse' run closed it. */
async function restartOnSamePort(t: Target): Promise<void> {
  const app = t.server.listeners('request')[0] as express.Express;
  await new Promise<void>((resolve) => { t.server = app.listen(t.port, '127.0.0.1', () => resolve()); });
}

interface RelayCall { recipient: string; message: string; threadId: string | undefined; messageId: string | undefined; resend: unknown; argc: number }

describe('/threadline/relay-send — A2A backup routes (route behaviour)', () => {
  let projectDir: string;
  let stateDir: string;
  let server: Server;
  let port: number;
  let relayCalls: RelayCall[];
  let A: Target;
  let B: Target; // second port, same fingerprint as A2 (ambiguity)
  let C: Target;
  let D: Target;
  let config: Record<string, unknown>;
  let liveEnabled: boolean | undefined;
  let telegramBridge: { mirrorOutbound: (...a: unknown[]) => Promise<void> } | null;
  let logs: string[];
  const FP_A = 'a1'.repeat(16);
  const FP_SHARED = 'b2'.repeat(16);
  const FP_C = 'c3'.repeat(16);
  const RELAY_FP = 'e4'.repeat(16);

  const writeKnown = (agents: unknown[]) => fs.writeFileSync(
    path.join(stateDir, 'threadline', 'known-agents.json'), JSON.stringify({ agents }),
  );

  const send = async (body: Record<string, unknown>) => {
    const r = await fetch(`http://127.0.0.1:${port}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-backup-routes-unit-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo-backup-unit' }));
    const suffix = randomBytes(3).toString('hex');
    A = await startTarget(`backup-a-${suffix}`, FP_A);
    B = await startTarget(`backup-b-${suffix}`, FP_SHARED);
    C = await startTarget(`backup-c-${suffix}`, FP_C);
    D = await startTarget(`backup-d-${suffix}`, FP_SHARED);

    relayCalls = [];
    const relayStub = {
      connectionState: 'connected',
      resolveAgent: async () => RELAY_FP,
      sendAutoWithThread(recipient: string, message: string, threadId?: string, messageId?: string, resend?: boolean) {
        // eslint-disable-next-line prefer-rest-params
        relayCalls.push({ recipient, message, threadId, messageId, resend, argc: arguments.length });
        return { messageId: messageId ?? 'msg-stub', threadId: threadId ?? 'thread-minted-by-client' };
      },
      awaitRelayAck: async () => null,
      banSuspected: false,
      noteUnconfirmedSettled() {},
      sendAuto: () => 'msg-stub',
    };
    config = { projectDir, stateDir, projectName: 'echo-backup-unit', port: 4042, authToken: TOKEN, developmentAgent: true };
    const router = createRoutes({
      config: config as unknown as InstarConfig,
      state: new StateManager(stateDir),
      sessionManager: { getCachedRunningSessions: () => [], listRunningSessions: () => [] },
      threadlineRelayClient: relayStub as never,
      liveConfig: { get: <T,>(p: string, def: T): T => (p === 'threadline.backupRoutes.enabled' ? (liveEnabled as T) : def) },
      get telegramBridge() { return telegramBridge; },
      startTime: new Date(),
    } as never);
    const app = express();
    app.use(express.json());
    app.use(router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    for (const t of targets) {
      await new Promise<void>((r) => { t.server.close(() => r()); t.server.closeAllConnections(); });
      SafeFsExecutor.safeRmSync(t.tokenPath, { force: true, operation: 'tests/unit/a2a-backup-routes.test.ts:token' });
    }
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/a2a-backup-routes.test.ts' });
  });

  beforeEach(() => {
    relayCalls.length = 0;
    liveEnabled = undefined;
    telegramBridge = null;
    config.developmentAgent = true;
    for (const t of targets) {
      t.mode = { post: 'ok' };
      t.envelopes.length = 0;
      t.healthHits = 0;
      t.health = { fingerprint: t.fp, relay: { state: 'connected' } };
    }
    writeKnown([
      { name: A.name, port: A.port, fingerprint: FP_A },
      { name: B.name, port: B.port, fingerprint: FP_SHARED },
      { name: C.name, port: C.port, publicKey: `${FP_C}restofkey` },
    ]);
    logs = [];
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // ── §1 marking + thread ─────────────────────────────────────────

  const markedCases: Array<[string, Mode]> = [
    ['the no-router 503 (prose body)', { post: 'status', status: 503, body: { error: 'Messaging not available' } }],
    ['a 500', { post: 'status', status: 500, body: { error: 'boom' } }],
    ['a 502', { post: 'status', status: 502, body: {} }],
    ['the in-flight 409', { post: 'status', status: 409, body: { deduped: true, disposition: 'admitted', retryable: true } }],
    ['an unknown 4xx (418)', { post: 'status', status: 418, body: {} }],
    ['a reset connection', { post: 'reset' }],
  ];
  for (const [label, mode] of markedCases) {
    it(`${label} → the relay leg is marked, same id, on the local attempt's thread`, async () => {
      A.mode = mode;
      const r = await send({ targetAgent: A.name, message: `m ${label}` });
      expect(r.status).toBe(200);
      expect(A.envelopes).toHaveLength(1);
      expect(relayCalls).toHaveLength(1);
      const local = A.envelopes[0].message;
      expect(relayCalls[0]).toMatchObject({ messageId: local.id, threadId: local.threadId, resend: true, argc: 5 });
      expect(r.body.threadId).toBe(local.threadId);
      expect(logs.some((l) => l.startsWith(`[a2a-backup] id=${local.id} peer=${FP_A} kind=marked-fallthrough outcome=`))).toBe(true);
    });
  }

  const unmarkedCases: Array<[string, Mode]> = [
    ['400', { post: 'status', status: 400, body: { error: 'Invalid envelope' } }],
    ['401', { post: 'status', status: 401, body: { error: 'Invalid or missing agent token' } }],
    ['404', { post: 'status', status: 404, body: {} }],
    ['the ledger-unavailable 503', { post: 'status', status: 503, body: { error: 'ledger-unavailable', retryable: true } }],
  ];
  for (const [label, mode] of unmarkedCases) {
    it(`${label} → unmarked, but still on the local attempt's thread`, async () => {
      A.mode = mode;
      await send({ targetAgent: A.name, message: `m ${label}` });
      const local = A.envelopes[0].message;
      expect(relayCalls[0]).toMatchObject({ messageId: local.id, threadId: local.threadId, argc: 4 });
      expect(relayCalls[0].resend).toBeUndefined();
      expect(logs.some((l) => l.includes('kind=marked-fallthrough'))).toBe(false);
    });
  }

  it('ECONNREFUSED on the POST\'s own connection → unmarked, local thread', async () => {
    A.mode = { post: 'refuse' };
    try {
      await send({ targetAgent: A.name, message: 'refused' });
      expect(A.healthHits).toBe(1);
      expect(A.envelopes).toHaveLength(0); // never reached the handler
      expect(relayCalls).toHaveLength(1);
      expect(logs.filter((l) => l.startsWith('[a2a-backup]'))).toEqual([]);
      expect(relayCalls[0].argc).toBe(4);
      expect(typeof relayCalls[0].threadId).toBe('string'); // the minted local thread, not undefined
    } finally {
      await restartOnSamePort(A);
    }
  });

  it('an ECONNREFUSED thrown after a 2xx (outside the POST fetch) does not unmark', async () => {
    telegramBridge = { mirrorOutbound: () => { throw Object.assign(new Error('bridge'), { code: 'ECONNREFUSED' }); } };
    await send({ targetAgent: A.name, message: 'throw after 2xx' });
    const local = A.envelopes[0].message;
    expect(relayCalls[0]).toMatchObject({ messageId: local.id, threadId: local.threadId, resend: true });
    expect(logs.some((l) => l.includes('outcome=throw-after-http-200'))).toBe(true);
  });

  it('with a caller thread, the relay leg carries the local attempt\'s thread (the caller\'s)', async () => {
    A.mode = { post: 'status', status: 500, body: {} };
    await send({ targetAgent: A.name, message: 'with thread', threadId: 'caller-thread-1' });
    expect(A.envelopes[0].message.threadId).toBe('caller-thread-1');
    expect(relayCalls[0]).toMatchObject({ threadId: 'caller-thread-1', resend: true });
  });

  it('no POST (failed health probe) → unmarked and the caller\'s raw thread (undefined) as today', async () => {
    A.mode = { health: 'fail' };
    await send({ targetAgent: A.name, message: 'no post' });
    expect(A.envelopes).toHaveLength(0);
    expect(relayCalls[0]).toMatchObject({ threadId: undefined, argc: 4 });
  });

  it('no POST (missing token) → unmarked, raw thread', async () => {
    writeKnown([{ name: `no-token-${randomBytes(3).toString('hex')}`, port: A.port, fingerprint: FP_A }]);
    const name = JSON.parse(fs.readFileSync(path.join(stateDir, 'threadline', 'known-agents.json'), 'utf-8')).agents[0].name;
    await send({ targetAgent: name, message: 'no token' });
    expect(A.envelopes).toHaveLength(0);
    expect(relayCalls[0]).toMatchObject({ threadId: undefined, argc: 4 });
  });

  it('gate off (explicit live false) → today\'s path: raw thread, no mark', async () => {
    liveEnabled = false;
    A.mode = { post: 'status', status: 500, body: {} };
    await send({ targetAgent: A.name, message: 'gate off' });
    expect(A.envelopes).toHaveLength(1);
    expect(relayCalls[0]).toMatchObject({ threadId: undefined, argc: 4 });
    expect(logs.some((l) => l.startsWith('[a2a-backup]'))).toBe(false);
  });

  it('gate off (fleet: no developmentAgent) → today\'s path', async () => {
    config.developmentAgent = false;
    A.mode = { post: 'status', status: 500, body: {} };
    await send({ targetAgent: A.name, message: 'fleet' });
    expect(relayCalls[0]).toMatchObject({ threadId: undefined, argc: 4 });
  });

  // ── §2 fingerprint branch ───────────────────────────────────────

  it('an exact fingerprint (any case) to a connected co-located agent goes local and logs it', async () => {
    const r = await send({ targetAgent: FP_A.toUpperCase(), message: 'by fp' });
    expect(r.body).toMatchObject({ success: true, deliveryPath: 'local', resolvedAgent: A.name });
    expect(A.envelopes).toHaveLength(1);
    expect(relayCalls).toHaveLength(0);
    expect(logs.some((l) => l === `[a2a-backup] id=${A.envelopes[0].message.id} peer=${FP_A} kind=fingerprint-local outcome=accepted for async processing`)).toBe(true);
  });

  it('a publicKey-only entry resolves by publicKey[:32]', async () => {
    const r = await send({ targetAgent: FP_C, message: 'pk' });
    expect(r.body).toMatchObject({ deliveryPath: 'local', resolvedAgent: C.name });
  });

  it('duplicate entries for one (fingerprint, port) collapse to one match', async () => {
    writeKnown([
      { name: A.name, port: A.port, fingerprint: FP_A },
      { name: `${A.name}-alias`, port: A.port, publicKey: `${FP_A}tail` },
    ]);
    const r = await send({ targetAgent: FP_A, message: 'dup' });
    expect(r.body).toMatchObject({ deliveryPath: 'local' });
  });

  it('two ports for one fingerprint → the relay, never the ambiguity 409', async () => {
    writeKnown([
      { name: B.name, port: B.port, fingerprint: FP_SHARED },
      { name: B.name, port: D.port, fingerprint: FP_SHARED },
    ]);
    const r = await send({ targetAgent: FP_SHARED, message: 'two ports' });
    expect(r.status).toBe(200);
    expect(B.healthHits + D.healthHits).toBe(0);
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]).toMatchObject({ threadId: undefined, argc: 4 });
  });

  it('a 32-hex string that is also a known agent\'s NAME → fingerprint branch only (no name match)', async () => {
    writeKnown([{ name: FP_SHARED, port: B.port, fingerprint: FP_A }]);
    const r = await send({ targetAgent: FP_SHARED, message: 'name collision' });
    expect(B.envelopes).toHaveLength(0);
    expect(B.healthHits).toBe(0);
    expect(r.body).not.toMatchObject({ deliveryPath: 'local' });
    expect(relayCalls).toHaveLength(1);
  });

  it('a shorter / longer hex string takes today\'s path (name match, res.ok-only probe)', async () => {
    const longer = `${FP_A}a`;
    writeKnown([{ name: longer, port: A.port }]);
    // token for that name
    const tp = path.join(tokenDir, `${longer}.token`);
    fs.writeFileSync(tp, 'x'.repeat(64));
    try {
      A.health = { ok: true }; // no fingerprint: today's probe ignores it
      const r = await send({ targetAgent: longer, message: 'longer' });
      expect(r.body).toMatchObject({ deliveryPath: 'local' });
      const r2 = await send({ targetAgent: FP_A.slice(1), message: 'shorter' });
      expect(r2.body).not.toMatchObject({ deliveryPath: 'local' });
    } finally {
      SafeFsExecutor.safeRmSync(tp, { force: true, operation: 'tests/unit/a2a-backup-routes.test.ts:longer-token' });
    }
  });

  it('a credential addressed by fingerprint skips the branch → the relay (its credential chokepoint answers)', async () => {
    const r = await send({ targetAgent: FP_A, message: 'secret', credentialShare: true });
    expect(A.healthHits).toBe(0);
    expect(A.envelopes).toHaveLength(0); // never plaintext loopback
    // Verified pairing is dev-gated on here with no trust manager wired: the
    // RELAY-path chokepoint refuses fail-closed — proving the send reached the relay path.
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ refused: true, reason: 'peer-not-mutually-verified' });
  });

  const healthCases: Array<[string, Record<string, unknown>]> = [
    ['fingerprint absent', { relay: { state: 'connected' } }],
    ['a different fingerprint (stale port)', { fingerprint: FP_C, relay: { state: 'connected' } }],
    ['relay not-configured (standby)', { fingerprint: FP_A, relay: { state: 'not-configured' } }],
    ['relay displaced', { fingerprint: FP_A, relay: { state: 'displaced' } }],
    ['relay disconnected', { fingerprint: FP_A, relay: { state: 'disconnected' } }],
  ];
  for (const [label, health] of healthCases) {
    it(`health with ${label} → the relay, unmarked, no POST`, async () => {
      A.health = health;
      await send({ targetAgent: FP_A, message: label });
      expect(A.healthHits).toBe(1);
      expect(A.envelopes).toHaveLength(0);
      expect(relayCalls[0]).toMatchObject({ threadId: undefined, argc: 4 });
    });
  }

  it('a fingerprint-addressed POST that fails falls through marked (§1 applies)', async () => {
    A.mode = { post: 'status', status: 500, body: {} };
    await send({ targetAgent: FP_A, message: 'fp then 500' });
    const local = A.envelopes[0].message;
    expect(relayCalls[0]).toMatchObject({ messageId: local.id, threadId: local.threadId, resend: true });
  });

  it('gate off → a fingerprint target never goes local (today\'s path)', async () => {
    liveEnabled = false;
    await send({ targetAgent: FP_A, message: 'gate off fp' });
    expect(A.healthHits).toBe(0);
    expect(relayCalls).toHaveLength(1);
  });

  it('the counters ride the authed /health only', async () => {
    A.mode = { post: 'status', status: 500, body: {} };
    await send({ targetAgent: A.name, message: 'count me' });
    await send({ targetAgent: FP_A, message: 'count me too' }); // marked again (500), via fingerprint
    A.mode = { post: 'ok' };
    await send({ targetAgent: FP_A, message: 'local' });
    const authed = await (await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as { threadline?: { backupRoutes?: Record<string, number> } };
    expect(authed.threadline?.backupRoutes?.markedFallthrough).toBeGreaterThanOrEqual(2);
    expect(authed.threadline?.backupRoutes?.fingerprintLocal).toBeGreaterThanOrEqual(1);
    const anon = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { threadline?: unknown };
    expect(JSON.stringify(anon)).not.toContain('backupRoutes');
  });
});
