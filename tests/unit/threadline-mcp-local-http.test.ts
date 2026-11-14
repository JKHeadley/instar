// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Threadline MCP over local HTTP — unit tier
 * (docs/specs/threadline-mcp-local-http.md): the pure spawn helpers, the
 * deadline chain, the local secret, the admission rule, the middleware's
 * exact-path rule, the outcome-unknown classification, the key-material /
 * credential-name / registry entries, and the service's health counts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  THREADLINE_MCP_DEADLINES,
  THREADLINE_MCP_CAPS,
  VERIFIED_CLIENT_FLOORS,
  buildClaudeThreadlineHttpConfig,
  buildCodexThreadlineHttpArgs,
  clientVersionAdmitted,
  compareVersions,
  detectCodexSharedThreadlineEntry,
  threadlineMcpUrlForListen,
  ensureClaudeThreadlineHttpConfigFile,
} from '../../src/core/threadlineMcpSpawn.js';
import {
  ensureLocalMcpSecret,
  readLocalMcpSecret,
  evaluateLocalMcpAdmission,
  ThreadlineMcpHttpService,
} from '../../src/threadline/ThreadlineMcpHttpService.js';
import { authMiddleware, buildRequestTimeoutOverrides, resolveRequestTimeout } from '../../src/server/middleware.js';
import { isCredentialEnvName, CREDENTIAL_ENV_EXACT } from '../../src/core/credentialEnvNames.js';
import { KEY_MATERIAL_FILES, KEY_MATERIAL_GITIGNORE_STATE } from '../../src/core/keyMaterialPaths.js';
import { sendMessageViaHttp, isOutcomeUnknownFetchError, OUTCOME_UNKNOWN_ERROR } from '../../src/threadline/mcp-http-client.js';
import { buildWriteDomainRegistry } from '../../src/core/WriteDomainRegistry.js';

let tmp: string;
beforeEach(() => {
  const base = process.env.TMPDIR && !process.env.TMPDIR.startsWith('/tmp') ? process.env.TMPDIR : os.tmpdir();
  tmp = fs.mkdtempSync(path.join(base, 'instar-tlmcp-unit-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/threadline-mcp-local-http.test.ts' });
});

describe('the deadline chain (Bounds)', () => {
  it('is ordered with headroom: reply wait < route answer < inner fetch < middleware < client', () => {
    const d = THREADLINE_MCP_DEADLINES;
    expect([d.replyWaitMs, d.routeAnswerMs, d.innerFetchMs, d.middlewareMs, d.clientToolMs]).toEqual([300_000, 320_000, 325_000, 340_000, 360_000]);
  });
  it('the middleware override reaches relay-send and the MCP route; other routes keep the default', () => {
    const map = buildRequestTimeoutOverrides();
    expect(resolveRequestTimeout('/threadline/relay-send', 30_000, map)).toBe(340_000);
    expect(resolveRequestTimeout('/mcp/threadline', 30_000, map)).toBe(340_000);
    expect(resolveRequestTimeout('/threadline/status', 30_000, map)).toBe(30_000);
    expect(resolveRequestTimeout('/mcp/load', 30_000, map)).toBe(30_000);
  });
  it('caps are 32 / 24 waits / 4 per session', () => {
    expect(THREADLINE_MCP_CAPS).toEqual({ global: 32, waits: 24, perSession: 4 });
  });
});

describe('outcome-unknown classification (both transports)', () => {
  it('an undici header/body timeout, an abort and a 408 are outcome-unknown, never "failed to reach"', async () => {
    const timeout = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
    const body = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' }) });
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    expect(isOutcomeUnknownFetchError(timeout)).toBe(true);
    expect(isOutcomeUnknownFetchError(body)).toBe(true);
    expect(isOutcomeUnknownFetchError(abort)).toBe(true);
    expect(isOutcomeUnknownFetchError(refused)).toBe(false);
    for (const err of [timeout, body, abort]) {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(err));
      const r = await sendMessageViaHttp({ targetAgent: 'p', message: 'm', waitForReply: true, timeoutSeconds: 300 }, 4040, 't', 'sess');
      expect(r).toMatchObject({ success: false, outcomeUnknown: true, error: OUTCOME_UNKNOWN_ERROR });
      expect(r.error).toContain('may already have been sent');
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 408, text: async () => '{"error":"Request timeout"}' }));
    const r408 = await sendMessageViaHttp({ targetAgent: 'p', message: 'm', waitForReply: true, timeoutSeconds: 300 }, 4040, 't');
    expect(r408).toMatchObject({ success: false, outcomeUnknown: true });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(refused));
    const rRefused = await sendMessageViaHttp({ targetAgent: 'p', message: 'm', waitForReply: false, timeoutSeconds: 5 }, 4040, 't');
    expect(rRefused.outcomeUnknown).toBeUndefined();
    expect(rRefused.error).toContain('Failed to reach agent server');
  });

  it('originSessionName is the explicit parameter, never the process environment; the inner call carries a 325 s dispatcher', async () => {
    const prev = process.env.INSTAR_SESSION_NAME;
    process.env.INSTAR_SESSION_NAME = 'the-server-itself';
    try {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"success":true,"messageId":"m","threadId":"t"}' });
      vi.stubGlobal('fetch', fetchMock);
      await sendMessageViaHttp({ targetAgent: 'p', message: 'm', waitForReply: false, timeoutSeconds: 5 }, 4040, 't', 'caller-session');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).originSessionName).toBe('caller-session');
      await sendMessageViaHttp({ targetAgent: 'p', message: 'm', waitForReply: false, timeoutSeconds: 5 }, 4040, 't');
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).originSessionName).toBeUndefined();
      const dispatcher = fetchMock.mock.calls[0][1].dispatcher as { [k: symbol]: unknown } | undefined;
      expect(dispatcher).toBeTruthy();
      const opts = Object.getOwnPropertySymbols(dispatcher!).map((s) => dispatcher![s]).find((v) => v && typeof v === 'object' && 'headersTimeout' in (v as object)) as { headersTimeout: number; bodyTimeout: number } | undefined;
      expect(opts).toMatchObject({ headersTimeout: 325_000, bodyTimeout: 325_000 });
    } finally {
      if (prev === undefined) delete process.env.INSTAR_SESSION_NAME; else process.env.INSTAR_SESSION_NAME = prev;
    }
  });
});

describe('client wiring (D3)', () => {
  it('the URL follows the ACTUAL loopback listen address; a non-loopback bind has none', () => {
    expect(threadlineMcpUrlForListen('127.0.0.1', 4040)?.url).toBe('http://127.0.0.1:4040/mcp/threadline');
    expect(threadlineMcpUrlForListen('0.0.0.0', 4040)?.hostHeader).toBe('127.0.0.1:4040');
    expect(threadlineMcpUrlForListen('::1', 4041)?.url).toBe('http://[::1]:4041/mcp/threadline');
    expect(threadlineMcpUrlForListen('100.64.0.7', 4040)).toBeNull();
    expect(threadlineMcpUrlForListen('192.168.1.5', 4040)).toBeNull();
  });
  it('the Claude entry holds ${VAR} references only and is written once per URL', () => {
    const cfg = buildClaudeThreadlineHttpConfig('http://127.0.0.1:4040/mcp/threadline');
    expect(cfg).toEqual({ mcpServers: { threadline: { type: 'http', url: 'http://127.0.0.1:4040/mcp/threadline', headers: {
      Authorization: 'Bearer ${INSTAR_LOCAL_MCP_SECRET}', 'X-Instar-Session': '${INSTAR_SESSION_NAME}', 'X-Instar-AgentId': '${INSTAR_AGENT_ID}',
    } } } });
    const p = ensureClaudeThreadlineHttpConfigFile(tmp, 'http://127.0.0.1:4040/mcp/threadline');
    const m1 = fs.statSync(p).mtimeMs;
    expect(ensureClaudeThreadlineHttpConfigFile(tmp, 'http://127.0.0.1:4040/mcp/threadline')).toBe(p);
    expect(fs.statSync(p).mtimeMs).toBe(m1);
    ensureClaudeThreadlineHttpConfigFile(tmp, 'http://127.0.0.1:4999/mcp/threadline');
    expect(fs.readFileSync(p, 'utf-8')).toContain(':4999/');
  });
  it('the Codex entry is threadline_local with the env-var bearer, both headers and the timeouts', () => {
    const args = buildCodexThreadlineHttpArgs('http://127.0.0.1:4040/mcp/threadline', false);
    expect(args).toEqual(['-c', 'mcp_servers.threadline_local={url="http://127.0.0.1:4040/mcp/threadline",bearer_token_env_var="INSTAR_LOCAL_MCP_SECRET",env_http_headers={"X-Instar-Session"="INSTAR_SESSION_NAME","X-Instar-AgentId"="INSTAR_AGENT_ID"},tool_timeout_sec=360,startup_timeout_sec=20}']);
    expect(buildCodexThreadlineHttpArgs('u', true).slice(-2)).toEqual(['-c', 'mcp_servers.threadline.enabled=false']);
  });
  it('shared-entry detection: present only when smol-toml finds the table; a parse error is never "present"', () => {
    const home = path.join(tmp, 'codex');
    fs.mkdirSync(home);
    expect(detectCodexSharedThreadlineEntry(home)).toBe('absent');
    fs.writeFileSync(path.join(home, 'config.toml'), '[mcp_servers."threadline"]\ncommand = "node"\n');
    expect(detectCodexSharedThreadlineEntry(home)).toBe('present');
    fs.writeFileSync(path.join(home, 'config.toml'), '# [mcp_servers.threadline]\nmodel = "x"\n');
    expect(detectCodexSharedThreadlineEntry(home)).toBe('absent');
    fs.writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.threadline]\ncommand = = broken\n');
    expect(detectCodexSharedThreadlineEntry(home)).toBe('suspect');
  });
  it('version gate: below / unreadable refused, at / above admitted, unknown framework refused', () => {
    expect(VERIFIED_CLIENT_FLOORS).toEqual({ 'claude-code': '2.1.310', 'codex-cli': '0.156.1' });
    expect(clientVersionAdmitted('claude-code', '2.1.309')).toBe(false);
    expect(clientVersionAdmitted('claude-code', '2.1.310')).toBe(true);
    expect(clientVersionAdmitted('claude-code', '2.1.310 (Claude Code)')).toBe(true);
    expect(clientVersionAdmitted('codex-cli', 'codex-cli 0.157.0')).toBe(true);
    expect(clientVersionAdmitted('codex-cli', '0.156.0')).toBe(false);
    expect(clientVersionAdmitted('claude-code', null)).toBe(false);
    expect(clientVersionAdmitted('gemini-cli', '9.9.9')).toBe(false);
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
  });
});

describe('the local secret (D2, criterion 8a)', () => {
  it('is 32 random bytes hex, mode 0600, created once and stable across reads', () => {
    const a = ensureLocalMcpSecret(tmp);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const p = path.join(tmp, 'state', 'local-mcp-secret');
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(ensureLocalMcpSecret(tmp)).toBe(a);
    expect(readLocalMcpSecret(tmp)).toBe(a);
  });
  it('a malformed file is replaced; an absent one reads as null', () => {
    expect(readLocalMcpSecret(tmp)).toBeNull();
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'state', 'local-mcp-secret'), 'not-a-secret');
    expect(ensureLocalMcpSecret(tmp)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is key material (never served / backed up / committed), a credential env name, and machine-local', () => {
    expect(KEY_MATERIAL_FILES).toContain('state/local-mcp-secret');
    expect(KEY_MATERIAL_GITIGNORE_STATE.some((e) => e.includes('state/local-mcp-secret'))).toBe(true);
    expect(CREDENTIAL_ENV_EXACT.has('INSTAR_LOCAL_MCP_SECRET')).toBe(true);
    expect(isCredentialEnvName('INSTAR_LOCAL_MCP_SECRET')).toBe(true);
    const reg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src', 'data', 'state-coherence-registry.json'), 'utf-8')) as { entries: Array<{ paths?: string[]; scope?: string }> };
    const cats = reg.entries;
    expect(cats.find((c) => c.paths?.includes('state/local-mcp-secret'))?.scope).toBe('machine-local');
    const wd = buildWriteDomainRegistry({ machineId: 'm_test' });
    expect(wd.entryForRoute('POST', '/mcp/threadline')).toMatchObject({ domain: 'machine-local' });
  });
});

const fakeReq = (over: Partial<{ path: string; remoteAddress: string; headers: Record<string, unknown>; method: string }> = {}) => ({
  path: over.path ?? '/mcp/threadline',
  method: over.method ?? 'POST',
  socket: { remoteAddress: over.remoteAddress ?? '127.0.0.1' },
  headers: over.headers ?? {},
}) as unknown as Request;
const fakeRes = () => {
  const r = { statusCode: 200, body: undefined as unknown, status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; } };
  return r;
};

describe('admission rule (criteria 3, 8a)', () => {
  const secret = 'a'.repeat(64);
  it('requires the secret; the agent token alone is refused', () => {
    expect(evaluateLocalMcpAdmission(fakeReq(), secret)).toMatchObject({ ok: false, status: 401 });
    expect(evaluateLocalMcpAdmission(fakeReq({ headers: { authorization: 'Bearer agent-token' } }), secret)).toMatchObject({ ok: false, status: 401 });
    expect(evaluateLocalMcpAdmission(fakeReq({ headers: { authorization: `Bearer ${secret}` } }), secret)).toEqual({ ok: true });
    expect(evaluateLocalMcpAdmission(fakeReq({ headers: { authorization: `Bearer ${secret}` } }), null)).toMatchObject({ ok: false, status: 401 });
  });
  it('non-loopback peers, Origin and forwarding headers are 403 even with the secret', () => {
    const auth = { authorization: `Bearer ${secret}` };
    for (const remoteAddress of ['10.0.0.5', '100.64.1.2', '::ffff:192.168.1.2']) {
      expect(evaluateLocalMcpAdmission(fakeReq({ remoteAddress, headers: auth }), secret)).toMatchObject({ ok: false, status: 403 });
    }
    for (const h of [{ origin: 'http://localhost:4040' }, { 'cf-connecting-ip': '1.2.3.4' }, { 'x-forwarded-for': '1.2.3.4' }]) {
      expect(evaluateLocalMcpAdmission(fakeReq({ headers: { ...auth, ...h } }), secret)).toMatchObject({ ok: false, status: 403 });
    }
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(evaluateLocalMcpAdmission(fakeReq({ remoteAddress, headers: auth }), secret)).toEqual({ ok: true });
    }
  });
});

describe('authMiddleware: one exact-path rule, placed first (criterion 8a)', () => {
  const secret = 'b'.repeat(64);
  const gate = (req: Request, res: Response) => {
    const v = evaluateLocalMcpAdmission(req, secret);
    if (!v.ok) { res.status(v.status).json({ error: v.error }); return false; }
    return true;
  };
  const run = (mw: ReturnType<typeof authMiddleware>, req: Request) => {
    const res = fakeRes();
    let nexted = false;
    mw(req, res as unknown as Response, () => { nexted = true; });
    return { status: nexted ? 'next' : res.statusCode };
  };
  it('protects the route on an install with NO agent token configured', () => {
    const mw = authMiddleware(undefined, 'agent', gate);
    expect(run(mw, fakeReq()).status).toBe(401);
    expect(run(mw, fakeReq({ headers: { authorization: `Bearer ${secret}` } })).status).toBe('next');
    // Everything else keeps the no-token skip.
    expect(run(mw, fakeReq({ path: '/sessions' })).status).toBe('next');
  });
  it('the agent token alone is refused on the route; the secret is refused everywhere else', () => {
    const mw = authMiddleware('agent-token', 'agent', gate);
    expect(run(mw, fakeReq({ headers: { authorization: 'Bearer agent-token' } })).status).toBe(401);
    // Elsewhere the secret is just a wrong bearer: refused (the middleware's invalid-token 403).
    expect(run(mw, fakeReq({ path: '/sessions', method: 'GET', headers: { authorization: `Bearer ${secret}` } })).status).toBe(403);
    expect(run(mw, fakeReq({ path: '/mcp/load', headers: { authorization: `Bearer ${secret}` } })).status).toBe(403);
    expect(run(mw, fakeReq({ path: '/mcp/load', headers: { authorization: 'Bearer agent-token' } })).status).toBe('next');
  });
  it('a mismatched X-Instar-AgentId cannot change the outcome on the route', () => {
    const mw = authMiddleware('agent-token', 'agent', gate);
    expect(run(mw, fakeReq({ headers: { authorization: `Bearer ${secret}`, 'x-instar-agentid': 'someone-else' } })).status).toBe('next');
    expect(run(mw, fakeReq({ headers: { 'x-instar-agentid': 'someone-else' } })).status).toBe(401);
  });
  it('without a gate the route fails closed (401), never falls back to the agent token', () => {
    const mw = authMiddleware('agent-token', 'agent');
    expect(run(mw, fakeReq({ headers: { authorization: 'Bearer agent-token' } })).status).toBe(401);
  });
});

describe('service health (D4)', () => {
  it('counts transports from the persisted records, never-called after 10 min, and nulls when unmeasurable', () => {
    let now = Date.parse('2026-10-27T12:00:00Z');
    const sessions = [
      { tmuxSession: 'a', framework: 'claude-code', startedAt: '2026-10-27T11:00:00Z', status: 'running', threadlineMcpTransport: 'http' as const },
      { tmuxSession: 'b', framework: 'codex-cli', startedAt: '2026-10-27T11:58:00Z', status: 'running', threadlineMcpTransport: 'http' as const },
      { tmuxSession: 'c', framework: 'claude-code', startedAt: '2026-10-27T11:00:00Z', status: 'running', threadlineMcpTransport: 'stdio' as const },
      { tmuxSession: 'd', framework: 'claude-code', startedAt: '2026-10-27T11:00:00Z', status: 'running' }, // predates the feature
      { tmuxSession: 'e', framework: 'claude-code', startedAt: '2026-10-27T11:00:00Z', status: 'completed', threadlineMcpTransport: 'http' as const },
    ];
    const svc = new ThreadlineMcpHttpService({
      agentName: 'x', stateDir: tmp, projectDir: tmp, port: 1, agentToken: () => '', enabled: () => false,
      discovery: {} as never, trustManager: {} as never, threadResumeMap: {} as never,
      listSessions: () => sessions, now: () => now, report: () => {},
    });
    expect(svc.health()).toMatchObject({ enabled: false, sessionsOnHttp: 2, sessionsOnStdio: 1, sessionsOnHttpNeverCalled: 1, stuckOperations: 0 });
    now += 60 * 60_000;
    expect(svc.health()).toMatchObject({ sessionsOnHttpNeverCalled: 2 });
    const blind = new ThreadlineMcpHttpService({
      agentName: 'x', stateDir: tmp, projectDir: tmp, port: 1, agentToken: () => '', enabled: () => true,
      discovery: {} as never, trustManager: {} as never, threadResumeMap: {} as never, report: () => {},
    });
    expect(blind.health()).toMatchObject({ sessionsOnHttp: null, sessionsOnStdio: null, sessionsOnHttpNeverCalled: null });
  });

  it('an unreadable client version is not cached: the next spawn reads it again', async () => {
    const reads: string[] = [];
    let answer: string | null = null;
    const svc = new ThreadlineMcpHttpService({
      agentName: 'x', stateDir: tmp, projectDir: tmp, port: 1, agentToken: () => '', enabled: () => true,
      discovery: {} as never, trustManager: {} as never, threadResumeMap: {} as never,
      clientVersion: (_fw, bin) => { reads.push(bin); return answer; }, probe: async () => {}, report: () => {},
    });
    svc.onListening('127.0.0.1', 4040);
    await svc.runProbe();
    expect(svc.planSpawn({ framework: 'claude-code', binaryPath: 'c', stripped: false })).toMatchObject({ transport: 'stdio', reason: 'unverified-client-version' });
    answer = '2.1.310';
    expect(svc.planSpawn({ framework: 'claude-code', binaryPath: 'c', stripped: false })).toMatchObject({ transport: 'http' });
    expect(svc.planSpawn({ framework: 'claude-code', binaryPath: 'c', stripped: false })).toMatchObject({ transport: 'http' });
    expect(reads).toEqual(['c', 'c']); // read again after the failure, then cached
    svc.stop();
  });

  it('flag off ⇒ stdio with NO secret flag; stripped ⇒ blank secret; no listener on loopback ⇒ not ready', async () => {
    let enabled = false;
    const reports: string[] = [];
    const svc = new ThreadlineMcpHttpService({
      agentName: 'x', stateDir: tmp, projectDir: tmp, port: 1, agentToken: () => '', enabled: () => enabled,
      discovery: {} as never, trustManager: {} as never, threadResumeMap: {} as never,
      clientVersion: () => '9.9.9', probe: async () => {}, report: (e) => reports.push(e.reason),
    });
    expect(svc.planSpawn({ framework: 'claude-code', binaryPath: 'c', stripped: false })).toEqual({ transport: 'stdio', reason: 'flag-off', secretEnvFlags: [] });
    enabled = true;
    expect(svc.planSpawn({ framework: 'claude-code', binaryPath: 'c', stripped: true })).toEqual({ transport: 'stdio', reason: 'stripped', secretEnvFlags: ['-e', 'INSTAR_LOCAL_MCP_SECRET='] });
    svc.onListening('192.168.1.9', 4040);
    await svc.runProbe();
    expect(svc.readinessSnapshot()).toMatchObject({ ready: false, reason: 'not-listening-on-loopback' });
    expect(svc.planSpawn({ framework: 'claude-code', binaryPath: 'c', stripped: false })).toMatchObject({ transport: 'stdio', reason: 'not-listening-on-loopback' });
    expect(reports).toEqual(['Why: claude-code not-listening-on-loopback']);
    svc.stop();
  });
});
