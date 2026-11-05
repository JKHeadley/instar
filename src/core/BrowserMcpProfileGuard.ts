import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { assertMcpDoesNotExposeManagedTelegram, readManagedTelegramUserDataDirs } from './dynamicMcpConfig.js';

/** Mandatory preflight outside optional/fail-open MCP trimming. A persistent MCP
 * browser can touch cookies at startup, before its first guarded tool call. */
export function assertBrowserMcpProfilesSafe(projectDir: string, framework: string, configHome?: string, agentHome = projectDir): void {
  const protectedDirs = [...new Set([projectDir, agentHome])].flatMap(readManagedTelegramUserDataDirs);
  if (!protectedDirs.length) return;
  const inspect = (file: string, toml = false): void => {
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const parsed = (toml ? parseToml(raw) : JSON.parse(raw)) as Record<string, any>;
    for (const definition of Object.values(parsed.mcpServers ?? parsed.mcp_servers ?? {})) {
      assertMcpDoesNotExposeManagedTelegram(definition, protectedDirs);
    }
    // Claude's user file can carry project-scoped MCP entries too.
    for (const key of [projectDir, path.resolve(projectDir)]) {
      for (const definition of Object.values(parsed.projects?.[key]?.mcpServers ?? {})) {
        assertMcpDoesNotExposeManagedTelegram(definition, protectedDirs);
      }
    }
  };
  inspect(path.join(projectDir, '.mcp.json'));
  inspect(path.join(projectDir, '.claude/settings.json'));
  if (framework === 'claude-code') {
    inspect(path.join(os.homedir(), '.claude.json'));
    const home = configHome || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    inspect(path.join(home, '.claude.json'));
    inspect(path.join(home, 'settings.json'));
  } else if (framework === 'codex-cli') {
    inspect(path.join(configHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), true);
    inspect(path.join(projectDir, '.codex/config.toml'), true);
  }
}
