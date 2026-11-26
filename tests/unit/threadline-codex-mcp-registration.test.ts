/**
 * Codex MCP registration for Threadline — the explicit path.
 *
 * History: portability audit Gap 2 made ThreadlineBootstrap write
 * `[mcp_servers."threadline"]` into ~/.codex/config.toml on every boot. That
 * file is shared by every Codex on the machine, so the write was
 * last-writer-wins across agents AND across tests (2026-10-20: an e2e boot
 * rewrote the operator's real config). The boot-time write is GONE; the
 * entry is written only on request by `instar codex connect <agent>`
 * (src/commands/codex.ts), through the same OpenAiCodexMcpToolRegistry.
 *
 * These tests pin two things: (1) the registry writer's TOML shape +
 * idempotency against a CODEX_HOME override (the empirically-verified Codex
 * config location, Codex CLI 0.78.0), unchanged; (2) bootstrapThreadline()
 * leaves $CODEX_HOME/config.toml alone — even when the Codex home exists.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMcpToolRegistry } from '../../src/providers/adapters/openai-codex/integration/mcpToolRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { bootstrapThreadline } from '../../src/threadline/ThreadlineBootstrap.js';
import { useHermeticHome } from '../setup/hermetic-home.js';

// HOME → temp: bootstrapThreadline() writes the user-scope ~/.claude.json.
useHermeticHome();

describe('Threadline Codex MCP registration (explicit path)', () => {
  let tmpHome: string;
  let prevCodexHome: string | undefined;
  let configFile: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-codex-mcp-'));
    prevCodexHome = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = tmpHome;
    configFile = path.join(tmpHome, 'config.toml');
  });

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = prevCodexHome;
    SafeFsExecutor.safeRmSync(tmpHome, {
      recursive: true,
      force: true,
      operation: 'tests/unit/threadline-codex-mcp-registration.test.ts',
    });
  });

  const threadlineSpec = {
    kind: 'stdio' as const,
    name: 'threadline',
    command: 'node',
    args: ['/abs/path/mcp-stdio-entry.js', '--state-dir', '/p/.instar', '--agent-name', 'echo'],
  };

  it('writes a [mcp_servers."threadline"] stdio table to config.toml', async () => {
    await createMcpToolRegistry().register(threadlineSpec, { scope: 'user' });

    const toml = fs.readFileSync(configFile, 'utf-8');
    expect(toml).toContain('[mcp_servers."threadline"]');
    expect(toml).toContain('kind = "stdio"');
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('mcp-stdio-entry.js');
    expect(toml).toContain('--agent-name');
  });

  it('is idempotent — re-registering replaces, does not duplicate the table', async () => {
    const reg = createMcpToolRegistry();
    await reg.register(threadlineSpec, { scope: 'user' });
    await reg.register(threadlineSpec, { scope: 'user' });

    const toml = fs.readFileSync(configFile, 'utf-8');
    const occurrences = toml.split('[mcp_servers."threadline"]').length - 1;
    expect(occurrences).toBe(1);
  });

  it('preserves unrelated operator content in config.toml', async () => {
    fs.writeFileSync(
      configFile,
      'model = "gpt-5.2-codex"\n\n[mcp_servers."other"]\nkind = "stdio"\ncommand = "foo"\n',
    );
    await createMcpToolRegistry().register(threadlineSpec, { scope: 'user' });

    const toml = fs.readFileSync(configFile, 'utf-8');
    expect(toml).toContain('model = "gpt-5.2-codex"');
    expect(toml).toContain('[mcp_servers."other"]');
    expect(toml).toContain('[mcp_servers."threadline"]');
  });

  it('isRegistered reports the threadline server after registration', async () => {
    const reg = createMcpToolRegistry();
    expect(await reg.isRegistered('threadline')).toBe(false);
    await reg.register(threadlineSpec, { scope: 'user' });
    expect(await reg.isRegistered('threadline')).toBe(true);
  });

  it('bootstrapThreadline() does NOT write the shared Codex config, even when the Codex home exists', async () => {
    // A pre-existing operator config with its own content: the old boot-time
    // write would have appended (or replaced) a threadline table here.
    fs.writeFileSync(configFile, 'model = "gpt-6-astra"\n');
    const before = fs.readFileSync(configFile, 'utf-8');

    const projectDir = path.join(tmpHome, 'project');
    const stateDir = path.join(tmpHome, 'state');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    const result = await bootstrapThreadline({ agentName: 'boot-agent', stateDir, projectDir, port: 4040 });
    await result.shutdown();

    expect(fs.readFileSync(configFile, 'utf-8')).toBe(before);
    expect(await createMcpToolRegistry().isRegistered('threadline')).toBe(false);
    // The Claude-side registrations still happen (project .mcp.json).
    expect(fs.existsSync(path.join(projectDir, '.mcp.json'))).toBe(true);
  });
});
