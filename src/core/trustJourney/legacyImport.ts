/**
 * Legacy import (trust-journey decision 9): existing agents keep exactly what they have today.
 *
 * Once per machine, for each concrete kind (a service named in the gate config, seen in the
 * operation log, or configured as an MCP server for this agent, times write/modify/delete), a legacy
 * grant is recorded whose behaviour is today's gate decision for that kind on this machine. A
 * machine that joins later imports only kinds that already hold a legacy grant somewhere. Sign-in is
 * never imported (decision 15); a wildcard is never imported; system services are not person kinds.
 * No LLM call, no operation-log write, no gate evaluation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SYSTEM_SERVICES } from '../../data/effect-kinds.js';

export const LEGACY_OPERATIONS = ['write', 'modify', 'delete'] as const;

/** MCP server names configured for this agent (project, user Claude config, Codex config). */
export function configuredMcpServers(projectDir: string, homeDir: string = os.homedir()): string[] {
  const names = new Set<string>();
  const readJson = (p: string): Record<string, unknown> | null => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } // @silent-fallback-ok: a missing or unreadable config contributes no servers
  };
  const addKeys = (o: unknown) => { if (o && typeof o === 'object') for (const k of Object.keys(o)) names.add(k); };
  addKeys(readJson(path.join(projectDir, '.mcp.json'))?.mcpServers);
  addKeys((readJson(path.join(projectDir, '.claude', 'settings.json')) as { mcpServers?: unknown } | null)?.mcpServers);
  const claudeHomes = [homeDir, ...(process.env.CLAUDE_CONFIG_DIR ? [process.env.CLAUDE_CONFIG_DIR] : [])];
  for (const h of claudeHomes) {
    const cj = readJson(path.join(h, '.claude.json'));
    addKeys(cj?.mcpServers);
    const projects = cj?.projects as Record<string, { mcpServers?: unknown }> | undefined;
    addKeys(projects?.[projectDir]?.mcpServers);
  }
  for (const toml of [path.join(process.env.CODEX_HOME || path.join(homeDir, '.codex'), 'config.toml'), path.join(projectDir, '.codex', 'config.toml')]) {
    let text = '';
    try { text = fs.readFileSync(toml, 'utf8'); } catch { continue; } // @silent-fallback-ok: no Codex config contributes no servers
    for (const m of text.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]/gm)) names.add(m[1] ?? m[2]);
  }
  return [...names].filter((n) => n && n !== '*');
}

/** Services seen in this machine's operation log. */
export function operationLogServices(stateDir: string): string[] {
  const out = new Set<string>();
  let text = '';
  try { text = fs.readFileSync(path.join(stateDir, 'state', 'operation-log.jsonl'), 'utf8'); } catch { return []; } // @silent-fallback-ok: no log yet
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const s = JSON.parse(line)?.classification?.service; if (typeof s === 'string' && s) out.add(s); } catch { /* @silent-fallback-ok: torn line */ }
  }
  return [...out];
}

export interface LegacyImportPlan {
  /** Kind keys to record, with this machine's behaviour. */
  grants: Array<{ key: string; behaviour: 'gate' | 'blocked' }>;
}

/**
 * The kinds to import on this machine. `existingKeys` are kinds already holding a legacy grant on
 * some machine: when any exist (another machine imported first), only those kinds are imported here.
 */
export function planLegacyImport(p: {
  gateEnabled: boolean;
  gateServices: string[];
  readOnlyServices: string[];
  logServices: string[];
  mcpServers: string[];
  existingKeys: string[];
  /** True when any machine imported before (even if every kind it imported has since been changed). */
  othersImported?: boolean;
}): LegacyImportPlan {
  const services = new Set([...p.gateServices, ...p.readOnlyServices, ...p.logServices, ...p.mcpServers]
    .filter((s) => s && s !== '*' && !SYSTEM_SERVICES.includes(s)));
  let keys = [...services].flatMap((s) => LEGACY_OPERATIONS.map((op) => `${s}.${op}`));
  if (p.othersImported || p.existingKeys.length > 0) {
    const existing = new Set(p.existingKeys);
    keys = keys.filter((k) => existing.has(k));
  }
  // With the gate switched off, today every non-read MCP effect is refused (decision 9).
  const behaviour = p.gateEnabled ? 'gate' : 'blocked';
  return { grants: [...new Set(keys)].sort().map((key) => ({ key, behaviour })) };
}

/** The hook's fallback file (spec 6a): exact tool names it may pass when the server is unreachable. */
export interface LegacyKindsFile {
  generatedAt: string;
  /**
   * Kind keys with an unchanged legacy grant on this machine (`service.operation`). When the server
   * is unreachable, a non-read call passes only if its kind is listed here or its exact tool name is
   * a listed read; a service with all three operations listed keeps the hook's name-based read path.
   */
  legacyKinds: string[];
  /** Exact tool names the table marks as reads. */
  readToolNames: string[];
}

export function writeLegacyKindsFile(stateDir: string, file: LegacyKindsFile): boolean {
  try {
    const p = path.join(stateDir, 'state', 'trust-legacy-kinds.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(file, null, 2));
    fs.renameSync(`${p}.tmp`, p);
    return true;
  } catch { return false; } // @silent-fallback-ok: the caller reports it; the hook then refuses non-read calls (the marker is set)
}
