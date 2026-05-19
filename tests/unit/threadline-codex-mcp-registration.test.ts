/**
 * Verifies the Codex MCP registration path used by ThreadlineBootstrap
 * (portability audit Gap 2). Before this, a Codex agent that joined the
 * Threadline network had the relay running but no MCP tools advertised to
 * its runtime, because registration only wrote Claude Code's
 * ~/.claude.json / .mcp.json.
 *
 * ThreadlineBootstrap now also registers `[mcp_servers."threadline"]` into
 * ~/.codex/config.toml by reusing the existing OpenAiCodexMcpToolRegistry.
 * These tests exercise that exact registry against a CODEX_HOME override
 * (the empirically-verified Codex config location, Codex CLI 0.78.0) so the
 * TOML shape and idempotency are pinned.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMcpToolRegistry } from '../../src/providers/adapters/openai-codex/integration/mcpToolRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Threadline Codex MCP registration (Gap 2)', () => {
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
});
