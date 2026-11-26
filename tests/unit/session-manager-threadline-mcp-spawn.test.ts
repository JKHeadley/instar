// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Threadline MCP over local HTTP — the spawn side, on EVERY SessionManager
 * spawn path (docs/specs/threadline-mcp-local-http.md D2/D3, acceptance
 * criteria 1, 5, 8a, 10):
 *  - flag off: the launch is the same as with no wiring at all; the only live
 *    changes are `MCP_TOOL_TIMEOUT=360000` on claude-code spawns and
 *    `tool_timeout_sec=360` on Codex's stdio override; no secret, no HTTP entry;
 *  - flag on + ready + verified client: claude-code gets one non-strict
 *    `--mcp-config` naming the stable file, Codex gets `threadline_local`
 *    instead of the stdio override, and the secret rides `-e`;
 *  - stripped spawns (omitAuthEnv, confined, empty strict MCP config) get no
 *    HTTP entry, the same launch as flag off, and the secret blanked;
 *  - a client below its verified floor (or unreadable) gets stdio.
 * tmux is mocked at node:child_process, as in the other SessionManager spawn tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const mockTmuxSessions = new Set<string>();
const newSessionArgvs: string[][] = [];

vi.mock('node:child_process', () => {
  const handle = (args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'new-session') {
      newSessionArgvs.push([...args]);
      const sIdx = args.indexOf('-s');
      if (sIdx >= 0 && args[sIdx + 1]) mockTmuxSessions.add(args[sIdx + 1]);
      return '';
    }
    if (args[0] === 'kill-session') {
      const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
      if (target) mockTmuxSessions.delete(target);
      return '';
    }
    if (args[0] === 'has-session') {
      const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
      if (target && !mockTmuxSessions.has(target)) throw new Error('no session');
      return '';
    }
    if (args[0] === 'display-message') return 'claude||claude';
    return '';
  };
  return {
    execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => handle(args)),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
        if (typeof _opts === 'function') cb = _opts as typeof cb;
        try { const out = handle(args); if (cb) cb(null, { stdout: String(out) }); }
        catch (e) { if (cb) cb(e as Error, { stdout: '' }); }
      },
    ),
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ThreadlineMcpHttpService } from '../../src/threadline/ThreadlineMcpHttpService.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

const SECRET_RE = /^INSTAR_LOCAL_MCP_SECRET=/;
const CODEX_STDIO = { command: 'node', args: ['/x/mcp-stdio-entry.js', '--state-dir', '/x/.instar', '--agent-name', 'proj'] };

interface Built {
  manager: SessionManager;
  state: StateManager;
  svc: ThreadlineMcpHttpService | null;
  enabled: { value: boolean };
  reports: string[];
  claude: string;
  codex: string;
}

async function build(tmpDir: string, opts: {
  wiring?: boolean; mode?: 'off' | 'force'; version?: string | null; ready?: boolean;
  codexHome?: string;
} = {}): Promise<Built> {
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  // Real files so the triage lane's binary-exists check passes.
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const claude = path.join(binDir, 'claude');
  const codex = path.join(binDir, 'codex');
  for (const b of [claude, codex]) { fs.writeFileSync(b, '#!/bin/sh\n'); fs.chmodSync(b, 0o755); }
  const state = new StateManager(stateDir);
  const config: SessionManagerConfig = {
    tmuxPath: '/usr/bin/tmux', claudePath: claude,
    frameworkBinaryPaths: { 'claude-code': claude, 'codex-cli': codex },
    projectName: 'proj', projectDir: tmpDir, maxSessions: 20, protectedSessions: [], completionPatterns: [],
    authToken: 'agent-token',
    subscriptionPathMode: opts.mode ?? 'off',
    codexThreadlineMcp: CODEX_STDIO,
    retainedClaudeBinary: { enabled: false },
  } as SessionManagerConfig;
  const manager = new SessionManager(config, state, { bindMaintenanceTickForTesting: () => {} });
  (manager as unknown as { currentMemoryPressure: () => string }).currentMemoryPressure = () => 'normal';
  (manager as unknown as { waitForClaudeReadyWithRetry: () => Promise<boolean> }).waitForClaudeReadyWithRetry = async () => true;
  const enabled = { value: true };
  const reports: string[] = [];
  let svc: ThreadlineMcpHttpService | null = null;
  if (opts.wiring !== false) {
    svc = new ThreadlineMcpHttpService({
      agentName: 'proj', stateDir, projectDir: tmpDir, port: 4040,
      agentToken: () => 'agent-token',
      enabled: () => enabled.value,
      discovery: {} as never, trustManager: {} as never, threadResumeMap: {} as never,
      listSessions: () => state.listSessions(),
      // 'below' = one patch under each framework's verified floor.
      clientVersion: (fw) => (opts.version === undefined ? (fw === 'codex-cli' ? '0.156.1' : '2.1.310')
        : opts.version === 'below' ? (fw === 'codex-cli' ? '0.156.0' : '2.1.309') : opts.version),
      probe: async () => { if (opts.ready === false) throw new Error('stalled'); },
      report: (e) => reports.push(`${e.feature}|${e.reason}`),
    });
    svc.onListening('127.0.0.1', 4040);
    await svc.runProbe();
    manager.setThreadlineMcpWiring(svc);
  }
  if (opts.codexHome) process.env.CODEX_HOME = opts.codexHome;
  return { manager, state, svc, enabled, reports, claude, codex };
}

const envOf = (argv: string[]) => argv.filter((_a, i) => argv[i - 1] === '-e');
const launchOf = (argv: string[], bin: string) => argv.slice(argv.indexOf(bin));
/** Normalise the per-spawn values (session ids, names, origin tokens) so two launches compare. */
const norm = (argv: string[]) => argv.map((a) => a
  .replace(/^(INSTAR_SESSION_ID|INSTAR_ORIGIN_TOKEN|INSTAR_BIND_TOKEN|INSTAR_JOB_FAILURE_FILE)=.*/, '$1=*')
  .replace(/INSTAR_JOB_COMPLETE_[a-z0-9]+|piece 3: [a-z0-9]+/g, 'X'));

describe('Threadline MCP spawn wiring — every SessionManager spawn path', () => {
  let tmpDir: string;
  let savedCodexHome: string | undefined;
  beforeEach(() => {
    const base = process.env.TMPDIR && !process.env.TMPDIR.startsWith('/tmp') ? process.env.TMPDIR : os.tmpdir();
    tmpDir = fs.mkdtempSync(path.join(base, 'instar-tlmcp-spawn-'));
    mockTmuxSessions.clear();
    newSessionArgvs.length = 0;
    savedCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(tmpDir, 'codex-home'); // never the real ~/.codex
  });
  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodexHome;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-manager-threadline-mcp-spawn.test.ts' });
  });

  // Each path spawns one session and returns its tmux new-session argv.
  const paths: Record<string, (b: Built, n: number) => Promise<{ argv: string[]; bin: string; framework: string; tmux: string }>> = {
    'claude headless': async (b, n) => {
      const s = await b.manager.spawnSession({ name: `job-h${n}`, prompt: 'do it', jobSlug: 'j' });
      return { argv: newSessionArgvs.at(-1)!, bin: b.claude, framework: 'claude-code', tmux: s.tmuxSession };
    },
    'codex headless': async (b, n) => {
      const s = await b.manager.spawnSession({ name: `job-c${n}`, prompt: 'do it', framework: 'codex-cli', codexAllowMcpTools: true });
      return { argv: newSessionArgvs.at(-1)!, bin: b.codex, framework: 'codex-cli', tmux: s.tmuxSession };
    },
    'claude interactive': async (b, n) => {
      const t = await b.manager.spawnInteractiveSession(undefined, `topic-i${n}`, { telegramTopicId: 100 + n });
      return { argv: newSessionArgvs.at(-1)!, bin: b.claude, framework: 'claude-code', tmux: t };
    },
    'codex interactive': async (b, n) => {
      const t = await b.manager.spawnInteractiveSession(undefined, `topic-x${n}`, { telegramTopicId: 200 + n, framework: 'codex-cli' });
      return { argv: newSessionArgvs.at(-1)!, bin: b.codex, framework: 'codex-cli', tmux: t };
    },
    'claude triage': async (b, n) => {
      const t = await b.manager.spawnTriageSession(`triage-${n}`, { allowedTools: ['Read'], permissionMode: 'dontAsk' });
      return { argv: newSessionArgvs.at(-1)!, bin: b.claude, framework: 'claude-code', tmux: t };
    },
  };

  for (const [label, spawn] of Object.entries(paths)) {
    it(`${label}: flag off is the same launch as no wiring, plus only the live long-wait fix`, async () => {
      const off = await build(tmpDir);
      off.enabled.value = false;
      const a = await spawn(off, 1);
      mockTmuxSessions.clear();
      const none = await build(tmpDir, { wiring: false });
      const b = await spawn(none, 1);
      expect(norm(a.argv).map((x) => x.replace(/-1\b/, ''))).toEqual(norm(b.argv).map((x) => x.replace(/-1\b/, '')));
      expect(envOf(a.argv).some((e) => SECRET_RE.test(e))).toBe(false);
      expect(a.argv.join(' ')).not.toContain('threadline-http.json');
      expect(a.argv.join(' ')).not.toContain('threadline_local');
      if (a.framework === 'claude-code') {
        expect(envOf(a.argv).filter((e) => e === 'MCP_TOOL_TIMEOUT=360000')).toHaveLength(1);
      } else {
        expect(envOf(a.argv)).not.toContain('MCP_TOOL_TIMEOUT=360000');
        expect(a.argv).toContain('mcp_servers.threadline.tool_timeout_sec=360');
        expect(a.argv).toContain(`mcp_servers.threadline.command=${JSON.stringify(CODEX_STDIO.command)}`);
      }
    });

    it(`${label}: flag on + ready + verified client ⇒ the HTTP entry and the secret`, async () => {
      const on = await build(tmpDir);
      const r = await spawn(on, 2);
      const secret = fs.readFileSync(path.join(tmpDir, '.instar', 'state', 'local-mcp-secret'), 'utf-8').trim();
      expect(envOf(r.argv)).toContain(`INSTAR_LOCAL_MCP_SECRET=${secret}`);
      const launch = launchOf(r.argv, r.bin);
      if (r.framework === 'claude-code') {
        const at = launch.indexOf('--mcp-config');
        expect(at).toBeGreaterThan(0);
        expect(launch[at + 1]).toBe(path.join(tmpDir, '.instar', 'state', 'session-mcp-config', 'threadline-http.json'));
        expect(launch).not.toContain('--strict-mcp-config');
        const file = fs.readFileSync(launch[at + 1], 'utf-8');
        expect(file).not.toContain(secret); // ${VAR} references only, never a literal token
        expect(JSON.parse(file).mcpServers.threadline.headers.Authorization).toBe('Bearer ${INSTAR_LOCAL_MCP_SECRET}');
        if (launch.includes('-p')) expect(at).toBeLessThan(launch.indexOf('-p'));
      } else {
        expect(launch.some((a) => a.startsWith('mcp_servers.threadline_local={url="http://127.0.0.1:4040/mcp/threadline"'))).toBe(true);
        expect(launch.join(' ')).not.toContain('mcp_servers.threadline.command');
        // No shared ~/.codex entry exists ⇒ the disable must NOT be passed (it would break startup).
        expect(launch).not.toContain('mcp_servers.threadline.enabled=false');
      }
      expect(on.state.listSessions().find((s) => s.tmuxSession === r.tmux)).toMatchObject({ threadlineMcpTransport: 'http' });
    });

    it(`${label}: a client below the verified floor (or unreadable) gets stdio + one unverified-client-version report`, async () => {
      for (const version of ['below', null] as const) {
        newSessionArgvs.length = 0;
        const below = await build(tmpDir, { version: version === 'below' ? 'below' : null });
        const res = await spawn(below, version === null ? 4 : 3);
        expect(res.argv.join(' ')).not.toContain('threadline-http.json');
        expect(res.argv.join(' ')).not.toContain('threadline_local');
        expect(below.reports.filter((x) => x.includes('unverified-client-version'))).toHaveLength(1);
        expect((below.svc!.health().fallbacks as Record<string, Record<string, number>>)[res.framework]).toEqual({ 'unverified-client-version': 1 });
        expect(below.state.listSessions().find((s) => s.tmuxSession === res.tmux)).toMatchObject({ threadlineMcpTransport: 'stdio' });
      }
    });
  }

  it('version gate, both sides of the boundary: at and above the floor are admitted', async () => {
    for (const version of ['2.1.310', '2.2.0']) {
      newSessionArgvs.length = 0;
      const b = await build(tmpDir, { version });
      const res = await paths['claude headless'](b, version === '2.1.310' ? 5 : 6);
      expect(res.argv.join(' ')).toContain('threadline-http.json');
    }
  });

  it('readiness failure ⇒ stdio, one fallback report per (framework, reason), counted', async () => {
    const b = await build(tmpDir, { ready: false });
    await paths['claude headless'](b, 7);
    await paths['claude headless'](b, 8);
    expect(newSessionArgvs.at(-1)!.join(' ')).not.toContain('threadline-http.json');
    const fallbackReports = b.reports.filter((x) => x.startsWith('ThreadlineMcpHttp.fallback'));
    expect(fallbackReports).toHaveLength(1);
    expect(fallbackReports[0]).toContain('probe-failed');
    const fb = b.svc!.health().fallbacks as Record<string, Record<string, number>>;
    expect(Object.values(fb['claude-code'])[0]).toBe(2);
  });

  it('Codex: the shared ~/.codex threadline table is disabled ONLY when smol-toml finds it', async () => {
    const home = path.join(tmpDir, 'codex-home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.threadline]\ncommand = "node"\nargs = ["x"]\n');
    const b = await build(tmpDir);
    const r1 = await paths['codex interactive'](b, 9);
    expect(r1.argv).toContain('mcp_servers.threadline.enabled=false');
    // A commented-out header is not a table: no disable.
    fs.writeFileSync(path.join(home, 'config.toml'), '# [mcp_servers.threadline]\n# command = "node"\n');
    const r2 = await paths['codex interactive'](b, 10);
    expect(r2.argv).not.toContain('mcp_servers.threadline.enabled=false');
    expect(r2.argv.some((a) => a.startsWith('mcp_servers.threadline_local='))).toBe(true);
  });

  // ── Stripped spawns (criteria 5 and 8a) ──
  const strippedCases: Array<[string, (b: Built, n: number) => Promise<string[]>, 'blank' | 'none']> = [
    ['headless omitAuthEnv', async (b, n) => { await b.manager.spawnSession({ name: `strip-a${n}`, prompt: 'p', omitAuthEnv: true }); return newSessionArgvs.at(-1)!; }, 'blank'],
    ['headless empty strict MCP config', async (b, n) => { await b.manager.spawnSession({ name: `strip-b${n}`, prompt: 'p', disableProjectMcp: true }); return newSessionArgvs.at(-1)!; }, 'blank'],
    ['headless confinedTools', async (b, n) => { await b.manager.spawnSession({ name: `strip-c${n}`, prompt: 'p', omitAuthEnv: true, confinedTools: ['Read'] }); return newSessionArgvs.at(-1)!; }, 'blank'],
    ['rerouted omitAuthEnv', async (b, n) => { await b.manager.spawnSession({ name: `strip-d${n}`, prompt: 'p', omitAuthEnv: true }); return newSessionArgvs.at(-1)!; }, 'blank'],
    ['rerouted empty strict MCP config', async (b, n) => { await b.manager.spawnSession({ name: `strip-e${n}`, prompt: 'p', disableProjectMcp: true }); return newSessionArgvs.at(-1)!; }, 'blank'],
  ];
  for (const [label, spawn] of strippedCases) {
    it(`stripped (${label}): no HTTP entry, same launch as flag off, secret blanked`, async () => {
      const mode = label.startsWith('rerouted') ? 'force' : 'off';
      const on = await build(tmpDir, { mode });
      const a = await spawn(on, 1);
      mockTmuxSessions.clear();
      const off = await build(tmpDir, { mode });
      off.enabled.value = false;
      const b = await spawn(off, 1);
      expect(a.join(' ')).not.toContain('threadline-http.json');
      expect(envOf(a)).toContain('INSTAR_LOCAL_MCP_SECRET=');
      expect(envOf(a).filter((e) => SECRET_RE.test(e))).toEqual(['INSTAR_LOCAL_MCP_SECRET=']);
      // The launch arguments (everything from the binary on) are unchanged.
      expect(norm(launchOf(a, on.claude))).toEqual(norm(launchOf(b, off.claude)));
      expect(on.reports.filter((x) => x.startsWith('ThreadlineMcpHttp.fallback'))).toEqual([]);
    });
  }

  it('the rerouted (subscription) lane: flag on ⇒ HTTP entry; flag off ⇒ none', async () => {
    const on = await build(tmpDir, { mode: 'force' });
    await on.manager.spawnSession({ name: 'job-r1', prompt: 'p', jobSlug: 'j' });
    const a = newSessionArgvs.at(-1)!;
    expect(a).not.toContain('-p');
    expect(a.join(' ')).toContain('threadline-http.json');
    expect(envOf(a)).toContain('MCP_TOOL_TIMEOUT=360000');
    on.enabled.value = false;
    await on.manager.spawnSession({ name: 'job-r2', prompt: 'p', jobSlug: 'j' });
    expect(newSessionArgvs.at(-1)!.join(' ')).not.toContain('threadline-http.json');
    expect(envOf(newSessionArgvs.at(-1)!).some((e) => SECRET_RE.test(e))).toBe(false);
  });
});

