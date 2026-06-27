/**
 * Wiring-integrity test for SessionManager.buildSessionMcpFlags (Dynamic MCP
 * Lifecycle, baseline-at-spawn). Exercises the real private method against a
 * real temp projectDir + .mcp.json + loaded-set state files. Verifies the
 * fail-safe (dark ⇒ [] no-op), the trim + seed, the committed-state-file
 * precedence, the framework gate, and the never-strand fallback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

type Pmcp = { buildSessionMcpFlags(topicId: number | undefined, framework: string): string[] };
const priv = (m: SessionManager): Pmcp => m as unknown as Pmcp;

const MCP_JSON = {
  mcpServers: {
    playwright: { command: 'npx', args: ['@playwright/mcp'] },
    threadline: { command: 'node', args: ['threadline.js'] },
  },
};

describe('SessionManager.buildSessionMcpFlags (baseline-at-spawn)', () => {
  let tmpDir: string;
  let state: StateManager;

  const makeManager = (dynamicMcp?: unknown): SessionManager => {
    const config = {
      projectName: 'test-agent',
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 5,
      protectedSessions: [],
      completionPatterns: ['Session complete'],
      ...(dynamicMcp !== undefined ? { dynamicMcp } : {}),
    } as unknown as SessionManagerConfig;
    return new SessionManager(config, state);
  };

  const mcpConfigOf = (flags: string[]): unknown => {
    const i = flags.indexOf('--mcp-config');
    return JSON.parse(fs.readFileSync(flags[i + 1], 'utf-8'));
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dynmcp-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(MCP_JSON));
    state = new StateManager(path.join(tmpDir, 'state'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-manager-dynamic-mcp-flags.test.ts' });
  });

  it('DARK (no dynamicMcp / disabled) ⇒ [] (full .mcp.json — strict no-op)', () => {
    expect(priv(makeManager()).buildSessionMcpFlags(42, 'claude-code')).toEqual([]);
    expect(priv(makeManager({ enabled: false, keepWarm: ['threadline'] })).buildSessionMcpFlags(42, 'claude-code')).toEqual([]);
  });

  it('non-claude-code framework ⇒ [] even when enabled', () => {
    const m = makeManager({ enabled: true, keepWarm: ['threadline'] });
    expect(priv(m).buildSessionMcpFlags(42, 'codex-cli')).toEqual([]);
  });

  it('enabled + no keepWarm ⇒ [] (no trim configured ⇒ full .mcp.json)', () => {
    const m = makeManager({ enabled: true });
    expect(priv(m).buildSessionMcpFlags(42, 'claude-code')).toEqual([]);
  });

  it('enabled + lean keepWarm ⇒ trimmed --mcp-config AND seeds the committed state file', () => {
    const m = makeManager({ enabled: true, keepWarm: ['threadline'] });
    const flags = priv(m).buildSessionMcpFlags(42, 'claude-code');
    expect(flags[0]).toBe('--strict-mcp-config');
    expect(flags).toContain('--mcp-config');
    const cfg = mcpConfigOf(flags) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(cfg.mcpServers)).toEqual(['threadline']); // playwright trimmed out

    const seeded = JSON.parse(fs.readFileSync(path.join(tmpDir, '.instar', 'state', 'mcp-loaded', '42.json'), 'utf-8'));
    expect(seeded).toMatchObject({ servers: ['threadline'], committed: true, reason: 'baseline' });
  });

  it('a COMMITTED state file wins over baseline (the loaded set is the source of truth)', () => {
    fs.mkdirSync(path.join(tmpDir, '.instar', 'state', 'mcp-loaded'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.instar', 'state', 'mcp-loaded', '7.json'),
      JSON.stringify({ servers: ['playwright', 'threadline'], committed: true, updatedAt: 'x', reason: 'load' }),
    );
    const m = makeManager({ enabled: true, keepWarm: ['threadline'] });
    const flags = priv(m).buildSessionMcpFlags(7, 'claude-code');
    const cfg = mcpConfigOf(flags) as { mcpServers: Record<string, unknown> };
    expect(new Set(Object.keys(cfg.mcpServers))).toEqual(new Set(['playwright', 'threadline']));
  });

  it('an UN-committed (in-flight) state file is ignored — falls through to baseline', () => {
    fs.mkdirSync(path.join(tmpDir, '.instar', 'state', 'mcp-loaded'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.instar', 'state', 'mcp-loaded', '9.json'),
      JSON.stringify({ servers: ['playwright', 'threadline'], committed: false, reason: 'load' }),
    );
    const m = makeManager({ enabled: true, keepWarm: ['threadline'] });
    const cfg = mcpConfigOf(priv(m).buildSessionMcpFlags(9, 'claude-code')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(cfg.mcpServers)).toEqual(['threadline']); // baseline, not the un-committed set
  });

  it('FAIL-SAFE: an unreadable .mcp.json ⇒ [] (full config, never strands the launch)', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), '{ this is not json');
    const m = makeManager({ enabled: true, keepWarm: ['threadline'] });
    expect(priv(m).buildSessionMcpFlags(42, 'claude-code')).toEqual([]);
  });

  it('undefined topicId ⇒ [] (no per-topic loaded set to resolve)', () => {
    const m = makeManager({ enabled: true, keepWarm: ['threadline'] });
    expect(priv(m).buildSessionMcpFlags(undefined, 'claude-code')).toEqual([]);
  });
});
