// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" — Threadline MCP over local HTTP
 * (docs/specs/threadline-mcp-local-http.md, acceptance criterion 9).
 *
 * Boots the REAL AgentServer the way server.ts wires it — the service built
 * over the server's own AgentDiscovery / AgentTrustManager / ThreadResumeMap,
 * the flag read live from `.instar/config.json` (`threadline.mcpHttp.enabled:
 * true`), the service handed to the SessionManager and the AgentServer — and
 * proves:
 *   - the boot probe (run by AgentServer once the listener is up) fills the
 *     readiness cache with ready=true against the real listen address;
 *   - a flagged spawn's tmux arguments carry the HTTP entry and the secret;
 *   - the SDK's streamable-HTTP client gets a working tools/list and a real
 *     threadline_send answer from POST /mcp/threadline (not 404, not 503);
 *   - the authenticated /health carries threadline.mcpHttp with the session
 *     counted on HTTP;
 *   - the local secret file exists at first boot, 0600.
 * tmux is the only thing faked (a fake tmux path the child_process shim intercepts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FAKE_TMUX = '/fake/bin/tmux-for-threadline-mcp-e2e';
const newSessionArgvs: string[][] = [];
const tmuxSessions = new Set<string>();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const handle = (args: string[] = []) => {
    if (args[0] === 'new-session') {
      newSessionArgvs.push([...args]);
      tmuxSessions.add(args[args.indexOf('-s') + 1]);
      return '';
    }
    if (args[0] === 'has-session') {
      const t = args[2]?.replace(/^=/, '').replace(/:$/, '');
      if (!t || !tmuxSessions.has(t)) throw new Error('no session');
      return '';
    }
    return '';
  };
  return {
    ...actual,
    execFileSync: ((cmd: string, args?: string[], opts?: unknown) =>
      cmd === FAKE_TMUX ? handle(args) : (actual.execFileSync as (...a: unknown[]) => unknown)(cmd, args, opts)) as typeof actual.execFileSync,
  };
});

import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { AgentDiscovery } from '../../src/threadline/AgentDiscovery.js';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import { ThreadResumeMap } from '../../src/threadline/ThreadResumeMap.js';
import { ThreadlineMcpHttpService } from '../../src/threadline/ThreadlineMcpHttpService.js';
import type { InstarConfig, SessionManagerConfig } from '../../src/core/types.js';

const AUTH = 'e2e-threadline-mcp-http-token';

describe('Threadline MCP over local HTTP — E2E (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let svc: ThreadlineMcpHttpService;
  let sessionManager: SessionManager;
  let state: StateManager;
  let port = 0;
  let claudeBin: string;

  beforeAll(async () => {
    const base = process.env.TMPDIR && !process.env.TMPDIR.startsWith('/tmp') ? process.env.TMPDIR : os.tmpdir();
    tmpDir = fs.mkdtempSync(path.join(base, 'tl-mcp-http-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e-tlmcp', threadline: { mcpHttp: { enabled: true } } }));
    // A claude "binary" whose package.json the version reader finds (the verified floor).
    const pkgDir = path.join(tmpDir, 'claude-code');
    fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.310' }));
    claudeBin = path.join(pkgDir, 'bin', 'claude');
    fs.writeFileSync(claudeBin, '#!/bin/sh\n');
    fs.chmodSync(claudeBin, 0o755);

    const config: InstarConfig = {
      projectName: 'e2e-tlmcp', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: claudeBin, maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
      threadline: { mcpHttp: { enabled: true } },
    } as InstarConfig;
    state = new StateManager(stateDir);
    const liveConfig = new LiveConfig(stateDir);
    sessionManager = new SessionManager({
      tmuxPath: FAKE_TMUX, claudePath: claudeBin, frameworkBinaryPaths: { 'claude-code': claudeBin },
      projectName: 'e2e-tlmcp', projectDir: tmpDir, maxSessions: 5, protectedSessions: [], completionPatterns: [],
      authToken: AUTH, retainedClaudeBinary: { enabled: false },
    } as SessionManagerConfig, state, { bindMaintenanceTickForTesting: () => {} });
    (sessionManager as unknown as { currentMemoryPressure: () => string }).currentMemoryPressure = () => 'normal';

    // server.ts wiring (src/commands/server.ts, after bootstrapThreadline).
    svc = new ThreadlineMcpHttpService({
      agentName: config.projectName,
      stateDir,
      projectDir: tmpDir,
      get port() { return port; },
      agentToken: () => config.authToken ?? '',
      enabled: () => liveConfig.get<boolean>('threadline.mcpHttp.enabled', false) === true,
      discovery: new AgentDiscovery({ stateDir, selfPath: tmpDir, selfName: config.projectName, selfPort: 0 }),
      trustManager: new AgentTrustManager({ stateDir }),
      threadResumeMap: new ThreadResumeMap(stateDir, stateDir),
      listSessions: () => state.listSessions(),
    } as ConstructorParameters<typeof ThreadlineMcpHttpService>[0]);
    sessionManager.setThreadlineMcpWiring(svc);

    server = new AgentServer({
      config,
      sessionManager,
      state,
      threadlineMcpHttp: svc,
    });
    await server.start();
    const addr = (server as unknown as { server: { address(): { port: number } } }).server.address();
    port = addr.port;
    // AgentServer started the boot probe in its listen callback; wait for it to land.
    const start = Date.now();
    while (!svc.readinessSnapshot().checkedAt && Date.now() - start < 15_000) await new Promise((r) => setTimeout(r, 25));
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    svc?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/threadline-mcp-http-alive.test.ts' });
  });

  it('the local secret exists at first boot (0600)', () => {
    const p = path.join(stateDir, 'state', 'local-mcp-secret');
    expect(fs.readFileSync(p, 'utf-8').trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it('the boot probe filled the readiness cache: ready against the real listen address', () => {
    expect(svc.readinessSnapshot()).toMatchObject({ ready: true, reason: null, url: `http://127.0.0.1:${port}/mcp/threadline` });
  });

  it('a flagged spawn carries the HTTP entry and the secret', async () => {
    const tmux = await sessionManager.spawnInteractiveSession(undefined, 'e2e-topic', { telegramTopicId: 4242 });
    const argv = newSessionArgvs.at(-1)!;
    const secret = fs.readFileSync(path.join(stateDir, 'state', 'local-mcp-secret'), 'utf-8').trim();
    expect(argv).toContain(`INSTAR_LOCAL_MCP_SECRET=${secret}`);
    expect(argv).toContain('MCP_TOOL_TIMEOUT=360000');
    const at = argv.indexOf('--mcp-config');
    expect(at).toBeGreaterThan(0);
    const cfg = JSON.parse(fs.readFileSync(argv[at + 1], 'utf-8'));
    expect(cfg.mcpServers.threadline.url).toBe(`http://127.0.0.1:${port}/mcp/threadline`);
    expect(state.listSessions().find((s) => s.tmuxSession === tmux)).toMatchObject({ threadlineMcpTransport: 'http' });
  });

  it('the SDK streamable-HTTP client gets a working tools/list and a real threadline_send answer (not 404, not 503)', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const secret = fs.readFileSync(path.join(stateDir, 'state', 'local-mcp-secret'), 'utf-8').trim();
    // Exactly the headers the client config carries, ${VAR}s expanded the way Claude Code does.
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/threadline`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}`, 'X-Instar-Session': 'e2e-tlmcp-e2e-topic', 'X-Instar-AgentId': 'e2e-tlmcp' } },
    });
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['threadline_send', 'threadline_history', 'threadline_agents', 'threadline_discover', 'threadline_trust']));
    expect(names.some((n) => n.startsWith('threadline_registry_'))).toBe(false);
    const r = await client.callTool({ name: 'threadline_send', arguments: { agentId: 'nobody-here', message: 'hello' } }) as { content: Array<{ text: string }> };
    // No relay in this server: the answer is relay-send's own honest refusal,
    // proving the call reached the real route through the real inner loopback call.
    expect(r.content[0].text).toMatch(/Relay not connected|not found|unavailable/i);
    expect(r.content[0].text).not.toContain('Failed to reach agent server');
    await client.close();
    const raw = await fetch(`http://127.0.0.1:${port}/mcp/threadline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(raw.status).toBe(401); // alive and guarded — never 404
  });

  it('authenticated /health carries threadline.mcpHttp', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${AUTH}` } });
    const body = await res.json() as { threadline?: { mcpHttp?: Record<string, unknown> } };
    expect(body.threadline?.mcpHttp).toMatchObject({ enabled: true, sessionsOnHttp: 1, stuckOperations: 0, readiness: { ready: true } });
    expect(body.threadline?.mcpHttp?.fallbacks).toEqual({});
  });
});
