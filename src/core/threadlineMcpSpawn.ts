/**
 * Threadline MCP over local HTTP — the spawn-side pieces
 * (docs/specs/threadline-mcp-local-http.md D2, D3, D4, Bounds).
 *
 * Pure helpers shared by the launcher (SessionManager, frameworkSessionLaunch)
 * and the in-server route (ThreadlineMcpHttpService). Nothing here reads live
 * config or talks to the network: the transport DECISION is made by the
 * service, which implements {@link ThreadlineMcpSpawnWiring}; this file only
 * builds the URL, the two client wirings and the deadline constants, so the URL
 * the clients are given and the URL the readiness probe checks come from ONE
 * function and can never differ.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

/** The route path (exact; the middleware rule matches it with `===`). */
export const MCP_THREADLINE_PATH = '/mcp/threadline';
/** Environment variable carrying the per-agent local secret into a session. */
export const LOCAL_MCP_SECRET_ENV = 'INSTAR_LOCAL_MCP_SECRET';
/** stateDir-relative path of the secret file (key material; never synced or served). */
export const LOCAL_MCP_SECRET_RELPATH = path.join('state', 'local-mcp-secret');
/** stateDir-relative path of the one stable Claude Code MCP config file. */
export const CLAUDE_HTTP_MCP_CONFIG_RELPATH = path.join('state', 'session-mcp-config', 'threadline-http.json');
/** Reserved session name the readiness probe uses (excluded from every per-session record). */
export const READINESS_PROBE_SESSION = '__readiness-probe';
/** Codex server name for the HTTP entry (a `-c` override cannot replace the shared stdio table). */
export const CODEX_HTTP_SERVER_NAME = 'threadline_local';

/**
 * The ordered deadline chain (spec "Bounds"), in time order. Each layer has
 * headroom before the next, so every layer gets to say what happened.
 */
export const THREADLINE_MCP_DEADLINES = Object.freeze({
  /** (1) relay-send's own reply-wait cap (waitForThreadlineReply). */
  replyWaitMs: 300_000,
  /** (2) the route answers the client with outcome-unknown at the latest. */
  routeAnswerMs: 320_000,
  /** (3) the undici agent on the inner loopback fetch (headers + body). */
  innerFetchMs: 325_000,
  /** (4) the middleware request-timeout override for both routes. */
  middlewareMs: 340_000,
  /** (5) the clients' tool timeouts. */
  clientToolMs: 360_000,
});
/** Codex `tool_timeout_sec` for both the stdio override and the HTTP entry. */
export const CODEX_TOOL_TIMEOUT_SEC = THREADLINE_MCP_DEADLINES.clientToolMs / 1000;
/** Claude Code reads its MCP tool timeout (ms) from this environment variable. */
export const CLAUDE_MCP_TOOL_TIMEOUT_ENV_FLAGS: readonly string[] = Object.freeze([
  '-e', `MCP_TOOL_TIMEOUT=${THREADLINE_MCP_DEADLINES.clientToolMs}`,
]);

/** In-flight caps on the route (Bounded Blast Radius). */
export const THREADLINE_MCP_CAPS = Object.freeze({ global: 32, waits: 24, perSession: 4 });

/**
 * Per-framework verified client floors (D3). A framework with no entry always
 * gets stdio. Each floor is the version the wiring was verified on with a real
 * spawn; a version below it, or an unreadable one, gets stdio.
 */
export const VERIFIED_CLIENT_FLOORS: Readonly<Record<string, string>> = Object.freeze({
  'claude-code': '2.1.310',
  'codex-cli': '0.156.1',
});

/** Compare dotted numeric versions (`2.1.310` vs `2.1.99`). Null when either is unreadable. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const parse = (v: string | null | undefined): number[] | null => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** True when `version` is at or above the framework's verified floor. */
export function clientVersionAdmitted(framework: string, version: string | null | undefined): boolean {
  const floor = VERIFIED_CLIENT_FLOORS[framework];
  if (!floor) return false;
  const cmp = compareVersions(version, floor);
  return cmp !== null && cmp >= 0;
}

export interface ThreadlineMcpUrl {
  /** The URL both client configs carry and the probe calls. */
  url: string;
  /** The exact `Host` header value the clients send (the transport's allowedHosts). */
  hostHeader: string;
}

/**
 * The loopback URL for the server's ACTUAL listen address, or null when the
 * server has no listener on a loopback interface (an explicit non-loopback
 * `config.host` or mesh bind override). `0.0.0.0` covers 127.0.0.1.
 */
export function threadlineMcpUrlForListen(listenHost: string | undefined, port: number): ThreadlineMcpUrl | null {
  if (!Number.isInteger(port) || port <= 0) return null;
  const h = (listenHost ?? '').trim();
  if (h === '127.0.0.1' || h === '0.0.0.0' || h === 'localhost' || h === '') {
    return { url: `http://127.0.0.1:${port}${MCP_THREADLINE_PATH}`, hostHeader: `127.0.0.1:${port}` };
  }
  if (h === '::1' || h === '::') {
    return { url: `http://[::1]:${port}${MCP_THREADLINE_PATH}`, hostHeader: `[::1]:${port}` };
  }
  return null;
}

/** The Claude Code `--mcp-config` entry: `${VAR}` references only, never a literal token. */
export function buildClaudeThreadlineHttpEntry(url: string): Record<string, unknown> {
  return {
    type: 'http',
    url,
    headers: {
      Authorization: `Bearer \${${LOCAL_MCP_SECRET_ENV}}`,
      'X-Instar-Session': '${INSTAR_SESSION_NAME}',
      'X-Instar-AgentId': '${INSTAR_AGENT_ID}',
    },
  };
}

/** The whole stable per-agent config file content. */
export function buildClaudeThreadlineHttpConfig(url: string): { mcpServers: Record<string, unknown> } {
  return { mcpServers: { threadline: buildClaudeThreadlineHttpEntry(url) } };
}

/**
 * Write the stable config file only when its content changed (the URL is the
 * only variable). Returns the path. Throws on a write failure — the caller
 * treats that as a readiness failure for this spawn (stdio).
 */
export function ensureClaudeThreadlineHttpConfigFile(stateDir: string, url: string): string {
  const outPath = path.join(stateDir, CLAUDE_HTTP_MCP_CONFIG_RELPATH);
  const content = `${JSON.stringify(buildClaudeThreadlineHttpConfig(url), null, 2)}\n`;
  let existing: string | null = null;
  try { existing = fs.readFileSync(outPath, 'utf-8'); } catch { existing = null; /* @silent-fallback-ok — absent ⇒ write it */ }
  if (existing === content) return outPath;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, outPath);
  return outPath;
}

/**
 * The Codex `-c` overrides for the HTTP entry. `disableShared` adds
 * `mcp_servers.threadline.enabled=false`, which must ONLY be passed when the
 * shared config really has that table (disabling a missing entry makes Codex
 * refuse to start).
 */
export function buildCodexThreadlineHttpArgs(url: string, disableShared: boolean): string[] {
  const entry =
    `mcp_servers.${CODEX_HTTP_SERVER_NAME}={url=${JSON.stringify(url)},` +
    `bearer_token_env_var=${JSON.stringify(LOCAL_MCP_SECRET_ENV)},` +
    `env_http_headers={"X-Instar-Session"="INSTAR_SESSION_NAME","X-Instar-AgentId"="INSTAR_AGENT_ID"},` +
    `tool_timeout_sec=${CODEX_TOOL_TIMEOUT_SEC},startup_timeout_sec=20}`;
  return [
    '-c', entry,
    ...(disableShared ? ['-c', 'mcp_servers.threadline.enabled=false'] : []),
  ];
}

export type CodexSharedEntryState =
  /** The parsed shared config has an `mcp_servers.threadline` table: disable it. */
  | 'present'
  /** No table (or no file): nothing to disable. */
  | 'absent'
  /**
   * No table found by the parser, but the raw text names one (a parse error, or a
   * project-scope `.codex/config.toml` entry): the shared stdio helper may run beside
   * the HTTP server. Fails safe (duplicate tools), reported once.
   */
  | 'suspect';

const THREADLINE_TABLE_TEXT = /\[\s*mcp_servers\s*\.\s*"?threadline"?\s*\]|mcp_servers\s*\.\s*"?threadline"?\s*[.=]/;

/** Resolve the Codex home a spawn will read (`CODEX_HOME`, default `~/.codex`). */
export function resolveCodexHome(envCodexHome?: string): string {
  return envCodexHome && envCodexHome.trim() ? envCodexHome : path.join(os.homedir(), '.codex');
}

/**
 * Detect whether `$CODEX_HOME/config.toml` carries an `mcp_servers.threadline`
 * table, by parsing it with smol-toml. A parse error counts as ABSENT for the
 * disable decision (a commented-out header can never produce the
 * startup-breaking disable); it is reported as `suspect` when the raw text
 * mentions the table. `projectDir` is checked only for the `suspect` signal.
 */
export function detectCodexSharedThreadlineEntry(codexHome: string, projectDir?: string): CodexSharedEntryState {
  let raw: string | null = null;
  try { raw = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf-8'); } catch { raw = null; /* @silent-fallback-ok — no file ⇒ no table */ }
  let state: CodexSharedEntryState = 'absent';
  if (raw !== null) {
    try {
      const parsed = parseToml(raw) as { mcp_servers?: Record<string, unknown> };
      const table = parsed?.mcp_servers?.threadline;
      if (table && typeof table === 'object') return 'present';
    } catch {
      // @silent-fallback-ok — a parse error counts as absent (never a startup-breaking disable).
    }
    if (THREADLINE_TABLE_TEXT.test(raw.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'))) state = 'suspect';
  }
  if (state === 'absent' && projectDir) {
    try {
      const projRaw = fs.readFileSync(path.join(projectDir, '.codex', 'config.toml'), 'utf-8');
      if (THREADLINE_TABLE_TEXT.test(projRaw)) state = 'suspect';
    } catch { /* @silent-fallback-ok — no project-scope file */ }
  }
  return state;
}

/** What the launcher asks the wiring for, per spawn. */
export interface ThreadlineSpawnRequest {
  framework: string;
  /** The binary the spawn will launch (for the version gate). */
  binaryPath: string;
  /** A version the launcher already resolved (Claude's retained-binary copy), if any. */
  knownVersion?: string | null;
  /** omitAuthEnv / confined / empty strict MCP config: never offered the HTTP entry. */
  stripped: boolean;
  /** The CODEX_HOME this spawn will read (Codex only). */
  codexHome?: string;
}

/** The launcher-facing plan for one spawn. */
export type ThreadlineSpawnPlan =
  | {
      transport: 'http';
      url: string;
      /** Claude Code: the stable config file path. */
      claudeConfigPath?: string;
      /** Claude Code: the entry to put into a dynamic-MCP strict config instead. */
      claudeEntry?: Record<string, unknown>;
      /** Codex: the `-c` overrides that REPLACE the stdio override. */
      codexArgs?: string[];
      /** `-e INSTAR_LOCAL_MCP_SECRET=…` (flag on). */
      secretEnvFlags: string[];
    }
  | {
      transport: 'stdio';
      /** Why (flag-off, stripped, unverified-client-version, not-ready, …). */
      reason: string;
      /** `-e INSTAR_LOCAL_MCP_SECRET=…` when the flag is on (blank for stripped); [] when off. */
      secretEnvFlags: string[];
    };

/** Implemented by the in-server service; injected into SessionManager late. */
export interface ThreadlineMcpSpawnWiring {
  /** Synchronous, never waits on the network: reads the cached readiness. */
  planSpawn(req: ThreadlineSpawnRequest): ThreadlineSpawnPlan;
}
