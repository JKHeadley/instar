/**
 * McpToolRegistry: write to ~/.claude.json (user scope) or
 * .claude/settings.json (project scope) to register MCP servers.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  McpToolRegistry,
  McpServerSpec,
  McpRegistryOptions,
} from '../../../primitives/integration/mcpToolRegistry.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { assertManagedTelegramMcpRegistration } from '../../../primitives/integration/mcpToolRegistry.js';

function configPath(scope: 'user' | 'project'): string {
  if (scope === 'user') {
    return path.join(homedir(), '.claude.json');
  }
  return path.join(process.cwd(), '.claude', 'settings.json');
}

async function readConfig(scope: 'user' | 'project'): Promise<Record<string, unknown>> {
  const p = configPath(scope);
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeConfig(scope: 'user' | 'project', config: Record<string, unknown>): Promise<void> {
  const p = configPath(scope);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(config, null, 2));
}

function specToClaudeShape(spec: McpServerSpec): Record<string, unknown> {
  if (spec.kind === 'stdio') {
    return { type: 'stdio', command: spec.command, args: spec.args ?? [], env: spec.env ?? {} };
  }
  return { type: 'http', url: spec.url, headers: spec.headers ?? {} };
}

class AnthropicHeadlessMcpToolRegistry implements McpToolRegistry {
  readonly capability = CapabilityFlag.McpToolRegistry;

  async register(spec: McpServerSpec, options?: McpRegistryOptions): Promise<void> {
    assertManagedTelegramMcpRegistration(spec);
    const scope = options?.scope ?? 'user';
    const config = await readConfig(scope);
    const servers = (config['mcpServers'] as Record<string, unknown>) ?? {};
    servers[spec.name] = specToClaudeShape(spec);
    config['mcpServers'] = servers;
    await writeConfig(scope, config);
  }

  async unregister(name: string, options?: McpRegistryOptions): Promise<void> {
    const scope = options?.scope ?? 'user';
    const config = await readConfig(scope);
    const servers = (config['mcpServers'] as Record<string, unknown>) ?? {};
    delete servers[name];
    config['mcpServers'] = servers;
    await writeConfig(scope, config);
  }

  async list(): Promise<ReadonlyArray<McpServerSpec>> {
    const config = await readConfig('user');
    const servers = (config['mcpServers'] as Record<string, Record<string, unknown>>) ?? {};
    const out: McpServerSpec[] = [];
    for (const [name, raw] of Object.entries(servers)) {
      if (raw['type'] === 'stdio') {
        out.push({
          kind: 'stdio',
          name,
          command: String(raw['command'] ?? ''),
          args: (raw['args'] as string[]) ?? [],
          env: (raw['env'] as Record<string, string>) ?? {},
        });
      } else if (raw['type'] === 'http') {
        out.push({
          kind: 'http',
          name,
          url: String(raw['url'] ?? ''),
          headers: (raw['headers'] as Record<string, string>) ?? {},
        });
      }
    }
    return out;
  }

  async isRegistered(name: string): Promise<boolean> {
    const config = await readConfig('user');
    const servers = (config['mcpServers'] as Record<string, unknown>) ?? {};
    return name in servers;
  }
}

export function createMcpToolRegistry(): McpToolRegistry {
  return new AnthropicHeadlessMcpToolRegistry();
}
