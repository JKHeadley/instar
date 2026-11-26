/**
 * `instar codex ...` — operator tools for a HAND-STARTED Codex CLI.
 *
 * `connect <agent>` writes this agent's Threadline MCP server entry into the
 * shared Codex user config (`$CODEX_HOME/config.toml`, default
 * `~/.codex/config.toml`) so a Codex the operator starts by hand in a terminal
 * gets `threadline_*` tools addressed to THAT agent.
 *
 * Why this is a command and not a boot-time side effect: the Codex user
 * config is ONE file for every Codex on the machine, so its
 * `[mcp_servers."threadline"]` table is last-writer-wins. ThreadlineBootstrap
 * used to rewrite it on every server boot — across agents AND across tests
 * (2026-10-20 an e2e run pointed the operator's real config at a worktree, a
 * /var/folders temp state dir and `--agent-name no-id-agent`). Instar-launched
 * Codex sessions never needed the shared entry: the launch builders pin the
 * owning agent's entry per spawn with `-c mcp_servers.threadline.*`
 * (frameworkSessionLaunch.ts). So the shared write is now an explicit,
 * operator-requested action, and this module is its only writer.
 *
 * The TOML writer is the existing OpenAiCodexMcpToolRegistry (idempotent
 * remove-then-append of the one table; unrelated operator content is kept),
 * so there is still exactly one Codex config writer in the codebase.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, validateAgentName } from '../core/AgentRegistry.js';
import { resolveThreadlineMcpEntry, type ThreadlineMcpEntry } from '../threadline/mcpEntry.js';
import { createMcpToolRegistry } from '../providers/adapters/openai-codex/integration/mcpToolRegistry.js';

/** Where Codex reads its user-scope config. Mirrors the registry's own resolution. */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['CODEX_HOME'];
  return override && override.trim() ? override.trim() : path.join(os.homedir(), '.codex');
}

export interface ConnectCodexOptions {
  /** Agent name — the agent home directory name under `<instarHome>/agents/`. */
  agent: string;
  /** Print the entry that WOULD be written; write nothing. */
  dryRun?: boolean;
  /** Override `~/.instar` (tests). */
  instarHome?: string;
  /** Override the registry read (tests). Defaults to the machine registry. */
  registryLookup?: () => ReadonlyArray<{ name: string; path: string }>;
  /** Override the environment used to resolve CODEX_HOME (tests). */
  env?: NodeJS.ProcessEnv;
}

export interface ConnectCodexResult {
  agentName: string;
  agentHome: string;
  stateDir: string;
  /** The config.toml the entry was (or would be) written to. */
  configPath: string;
  entry: ThreadlineMcpEntry;
  /** False when `dryRun` — nothing was written. */
  wrote: boolean;
}

/**
 * Resolve an agent name to its home directory. The registry's recorded path
 * wins (it is the canonical key and covers legacy homes outside the agents
 * root); otherwise the convention location `<instarHome>/agents/<agent>`.
 * Either way the home must carry a `.instar/` state dir — that is what the
 * MCP entry's `--state-dir` points at, so a home without one cannot be
 * connected to anything.
 */
export function resolveCodexConnectAgentHome(opts: ConnectCodexOptions): { agentHome: string; stateDir: string } {
  const name = opts.agent.trim();
  if (!name || !validateAgentName(name)) {
    throw new Error(
      `codex connect: "${opts.agent}" is not a valid agent name (letters, digits, "-" and "_"; no path separators)`,
    );
  }
  const instarHome = opts.instarHome ?? path.join(os.homedir(), '.instar');
  const candidates: string[] = [];
  const registryEntries = opts.registryLookup ? opts.registryLookup() : loadRegistry().entries;
  for (const entry of registryEntries) {
    if (entry.name === name && typeof entry.path === 'string' && entry.path) {
      candidates.push(entry.path);
    }
  }
  candidates.push(path.join(instarHome, 'agents', name));

  for (const candidate of candidates) {
    const stateDir = path.join(candidate, '.instar');
    let isDir = false;
    try {
      isDir = fs.statSync(stateDir).isDirectory();
    } catch {
      // @silent-fallback-ok — probe; a missing candidate is reported below once
      //   every candidate has been tried.
      isDir = false;
    }
    if (isDir) return { agentHome: path.resolve(candidate), stateDir: path.resolve(stateDir) };
  }
  throw new Error(
    `codex connect: no agent home with a .instar/ state dir found for "${name}" ` +
      `(looked at: ${candidates.join(', ')}). Is the agent installed on this machine?`,
  );
}

/**
 * Write (or, with dryRun, only compute) the shared Codex `[mcp_servers."threadline"]`
 * entry for ONE agent. Returns what was written and where.
 */
export async function connectCodex(opts: ConnectCodexOptions): Promise<ConnectCodexResult> {
  const { agentHome, stateDir } = resolveCodexConnectAgentHome(opts);
  const agentName = opts.agent.trim();
  const entry = resolveThreadlineMcpEntry(agentHome, stateDir, agentName);
  const configPath = path.join(resolveCodexHome(opts.env), 'config.toml');

  if (!opts.dryRun) {
    await createMcpToolRegistry().register(
      { kind: 'stdio', name: 'threadline', command: entry.command, args: entry.args },
      { scope: 'user' },
    );
  }
  return { agentName, agentHome, stateDir, configPath, entry, wrote: !opts.dryRun };
}

/** Human-readable report for the CLI. */
export function formatConnectCodexReport(r: ConnectCodexResult): string {
  const lines: string[] = [];
  if (r.wrote) {
    lines.push(`Connected hand-started Codex to agent "${r.agentName}".`);
    lines.push(`  wrote [mcp_servers."threadline"] → ${r.configPath}`);
  } else {
    lines.push(`Dry run — would connect hand-started Codex to agent "${r.agentName}".`);
    lines.push(`  would write [mcp_servers."threadline"] → ${r.configPath}`);
  }
  lines.push(`  command: ${r.entry.command} ${r.entry.args.join(' ')}`);
  lines.push('');
  lines.push('Note: that config file is shared by every Codex on this machine, so the entry');
  lines.push('points at ONE agent at a time (the one you connected last). Codex sessions that');
  lines.push("Instar launches do not read it — each gets its own agent's entry per session.");
  return lines.join('\n');
}
