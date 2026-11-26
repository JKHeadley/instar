/**
 * E2E lifecycle — the shared Codex config is written ONLY on request, and the
 * two Codex paths coexist:
 *
 *   1. The production boot path (bootstrapThreadline, exactly as server.ts calls
 *      it) registers Claude's MCP entries and leaves $CODEX_HOME/config.toml
 *      alone even when a Codex home with operator content exists.
 *   2. `instar codex connect <agent>` (the command) then writes the hand-started
 *      entry for ONE agent, keeping the operator's content.
 *   3. An Instar-launched Codex session for a DIFFERENT agent still carries its
 *      OWN `-c mcp_servers.threadline.*` override (the server.ts →
 *      SessionManager → launch-builder path), so the shared entry naming agent A
 *      cannot misaddress agent B's sessions — which is why the boot-time write
 *      was never needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapThreadline } from '../../src/threadline/ThreadlineBootstrap.js';
import { resolveThreadlineMcpEntry } from '../../src/threadline/mcpEntry.js';
import { connectCodex } from '../../src/commands/codex.js';
import { buildInteractiveLaunch, buildHeadlessLaunch } from '../../src/core/frameworkSessionLaunch.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { useHermeticHome } from '../setup/hermetic-home.js';

// HOME → temp: bootstrapThreadline() writes the user-scope ~/.claude.json.
const home = useHermeticHome();

describe('Codex connect lifecycle — boot never writes, connect writes once, sessions keep their own override', () => {
  let codexHome: string;
  let prevCodexHome: string | undefined;

  beforeEach(() => {
    codexHome = path.join(home.dir, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-6-astra"\n\n[mcp_servers."operator-tool"]\nkind = "stdio"\ncommand = "op"\n');
    prevCodexHome = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = codexHome;
  });

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = prevCodexHome;
  });

  it('runs the whole lifecycle', async () => {
    const instarHome = path.join(home.dir, '.instar');
    const agentA = path.join(instarHome, 'agents', 'agent-a');
    const agentB = path.join(instarHome, 'agents', 'agent-b');
    fs.mkdirSync(path.join(agentA, '.instar'), { recursive: true });
    fs.mkdirSync(path.join(agentB, '.instar'), { recursive: true });
    const configFile = path.join(codexHome, 'config.toml');
    const original = fs.readFileSync(configFile, 'utf-8');

    // 1. Production boot path for agent A: Claude-side registration only.
    const boot = await bootstrapThreadline({ agentName: 'agent-a', stateDir: path.join(agentA, '.instar'), projectDir: agentA, port: 4040 });
    await boot.shutdown();
    expect(fs.readFileSync(configFile, 'utf-8')).toBe(original);
    expect(fs.existsSync(path.join(agentA, '.mcp.json'))).toBe(true);
    const claudeJson = JSON.parse(fs.readFileSync(path.join(home.dir, '.claude.json'), 'utf-8'));
    expect(claudeJson.projects[agentA].mcpServers.threadline.args).toContain('agent-a');

    // 2. Explicit connect for agent A writes the shared entry, keeps operator content.
    const r = await connectCodex({ agent: 'agent-a', instarHome, registryLookup: () => [] });
    expect(r.wrote).toBe(true);
    const toml = fs.readFileSync(configFile, 'utf-8');
    expect(toml).toContain('model = "gpt-6-astra"');
    expect(toml).toContain('[mcp_servers."operator-tool"]');
    expect(toml).toContain('[mcp_servers."threadline"]');
    expect(toml).toContain('"--agent-name", "agent-a"');

    // 3. Agent B's Instar-launched sessions carry B's own override regardless.
    const entryB = resolveThreadlineMcpEntry(agentB, path.join(agentB, '.instar'), 'agent-b');
    const interactive = buildInteractiveLaunch('codex-cli', { binaryPath: '/usr/local/bin/codex', codexThreadlineMcp: entryB });
    const headless = buildHeadlessLaunch('codex-cli', { binaryPath: '/usr/local/bin/codex', prompt: 'hi', codexThreadlineMcp: entryB });
    for (const spec of [interactive, headless]) {
      const joined = spec.argv.join(' ');
      expect(joined).toContain('mcp_servers.threadline.args=');
      expect(joined).toContain('agent-b');
      expect(joined).not.toContain('"--agent-name","agent-a"');
    }
    // and the shared file still names agent A — the two paths do not interfere.
    expect(fs.readFileSync(configFile, 'utf-8')).toContain('"--agent-name", "agent-a"');
  });
});
