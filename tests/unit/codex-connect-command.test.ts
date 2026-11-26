/**
 * `instar codex connect <agent>` — the explicit, operator-requested writer of
 * the shared Codex `[mcp_servers."threadline"]` entry (src/commands/codex.ts).
 *
 * Pins: agent-home resolution (registry path first, then the convention
 * location, both requiring a .instar/ state dir), the TOML that lands in
 * $CODEX_HOME/config.toml, idempotency, preservation of unrelated operator
 * content, last-writer-wins being VISIBLE (connecting agent B replaces A),
 * dry-run writing nothing, and refusal of unknown / malformed agent names.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  connectCodex,
  formatConnectCodexReport,
  resolveCodexConnectAgentHome,
  resolveCodexHome,
} from '../../src/commands/codex.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('instar codex connect <agent>', () => {
  let tmp: string;
  let instarHome: string;
  let codexHome: string;
  let env: NodeJS.ProcessEnv;
  let prevCodexHome: string | undefined;

  function makeAgentHome(name: string, root = path.join(instarHome, 'agents')): string {
    const home = path.join(root, name);
    fs.mkdirSync(path.join(home, '.instar'), { recursive: true });
    return home;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-codex-connect-'));
    instarHome = path.join(tmp, '.instar');
    codexHome = path.join(tmp, '.codex');
    fs.mkdirSync(path.join(instarHome, 'agents'), { recursive: true });
    env = { CODEX_HOME: codexHome };
    // The registry writer reads process.env directly; point it at the same dir.
    prevCodexHome = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = codexHome;
  });

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = prevCodexHome;
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/codex-connect-command.test.ts' });
  });

  it('writes a [mcp_servers."threadline"] stdio table naming the agent home state dir and agent name', async () => {
    const home = makeAgentHome('alpha');
    const r = await connectCodex({ agent: 'alpha', instarHome, registryLookup: () => [], env });

    expect(r.wrote).toBe(true);
    expect(r.agentHome).toBe(home);
    expect(r.stateDir).toBe(path.join(home, '.instar'));
    expect(r.configPath).toBe(path.join(codexHome, 'config.toml'));

    const toml = fs.readFileSync(r.configPath, 'utf-8');
    expect(toml).toContain('[mcp_servers."threadline"]');
    expect(toml).toContain('kind = "stdio"');
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('mcp-stdio-entry.js');
    expect(toml).toContain(`"--state-dir", "${path.join(home, '.instar')}"`);
    expect(toml).toContain('"--agent-name", "alpha"');
  });

  it('prefers the registry-recorded home (a legacy home outside the agents root) over the convention path', async () => {
    const legacyHome = makeAgentHome('legacy', path.join(tmp, 'Projects'));
    // The convention location does NOT exist for this agent.
    const r = await connectCodex({
      agent: 'legacy',
      instarHome,
      registryLookup: () => [{ name: 'legacy', path: legacyHome }],
      env,
    });
    expect(r.agentHome).toBe(legacyHome);
    expect(fs.readFileSync(r.configPath, 'utf-8')).toContain(`"--state-dir", "${path.join(legacyHome, '.instar')}"`);
  });

  it('falls back to the convention location when the registry entry has no .instar/ state dir', () => {
    const conventionHome = makeAgentHome('beta');
    const bogus = path.join(tmp, 'gone');
    const { agentHome } = resolveCodexConnectAgentHome({
      agent: 'beta',
      instarHome,
      registryLookup: () => [{ name: 'beta', path: bogus }],
    });
    expect(agentHome).toBe(conventionHome);
  });

  it('is idempotent and makes last-writer-wins visible: connecting a second agent replaces the first', async () => {
    makeAgentHome('alpha');
    makeAgentHome('beta');
    await connectCodex({ agent: 'alpha', instarHome, registryLookup: () => [], env });
    await connectCodex({ agent: 'alpha', instarHome, registryLookup: () => [], env });
    let toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf-8');
    expect(toml.split('[mcp_servers."threadline"]').length - 1).toBe(1);

    await connectCodex({ agent: 'beta', instarHome, registryLookup: () => [], env });
    toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf-8');
    expect(toml.split('[mcp_servers."threadline"]').length - 1).toBe(1);
    expect(toml).toContain('"--agent-name", "beta"');
    expect(toml).not.toContain('"--agent-name", "alpha"');
  });

  it('preserves the operator\'s unrelated Codex settings', async () => {
    makeAgentHome('alpha');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n\n[mcp_servers."other"]\nkind = "stdio"\ncommand = "foo"\n',
    );
    await connectCodex({ agent: 'alpha', instarHome, registryLookup: () => [], env });
    const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf-8');
    expect(toml).toContain('model = "gpt-6-astra"');
    expect(toml).toContain('model_reasoning_effort = "high"');
    expect(toml).toContain('[mcp_servers."other"]');
    expect(toml).toContain('[mcp_servers."threadline"]');
  });

  it('--dry-run computes the entry and the target path but writes nothing', async () => {
    makeAgentHome('alpha');
    const r = await connectCodex({ agent: 'alpha', instarHome, registryLookup: () => [], env, dryRun: true });
    expect(r.wrote).toBe(false);
    expect(r.configPath).toBe(path.join(codexHome, 'config.toml'));
    expect(fs.existsSync(codexHome)).toBe(false);
    const report = formatConnectCodexReport(r);
    expect(report).toContain('Dry run');
    expect(report).toContain('would write');
    expect(report).toContain('shared by every Codex on this machine');
  });

  it('refuses an agent with no home on this machine, naming where it looked', async () => {
    await expect(connectCodex({ agent: 'nobody', instarHome, registryLookup: () => [], env })).rejects.toThrow(
      /no agent home with a \.instar\/ state dir found for "nobody"/,
    );
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(false);
  });

  it('refuses malformed agent names before touching the filesystem', async () => {
    for (const bad of ['../echo', 'a/b', '', '   ', 'x\0y']) {
      await expect(connectCodex({ agent: bad, instarHome, registryLookup: () => [], env })).rejects.toThrow(
        /not a valid agent name/,
      );
    }
    expect(fs.existsSync(codexHome)).toBe(false);
  });

  it('resolveCodexHome honors CODEX_HOME and defaults to ~/.codex', () => {
    expect(resolveCodexHome({ CODEX_HOME: '/x/codex' })).toBe('/x/codex');
    expect(resolveCodexHome({ CODEX_HOME: '   ' })).toBe(path.join(os.homedir(), '.codex'));
    expect(resolveCodexHome({})).toBe(path.join(os.homedir(), '.codex'));
  });

  it('the written report names the file and warns that the entry points at one agent at a time', async () => {
    makeAgentHome('alpha');
    const r = await connectCodex({ agent: 'alpha', instarHome, registryLookup: () => [], env });
    const report = formatConnectCodexReport(r);
    expect(report).toContain('Connected hand-started Codex to agent "alpha"');
    expect(report).toContain(r.configPath);
    expect(report).toContain('ONE agent at a time');
  });
});
