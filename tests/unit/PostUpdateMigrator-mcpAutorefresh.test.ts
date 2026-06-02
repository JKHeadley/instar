/**
 * mcp-health-autorefresh.sh — auto-restart-on-MCP-inaccessible.
 *
 * Justin's ask (2026-06-02, topic 13481): make "an MCP failed to register ->
 * restart the session so it re-registers" AUTOMATIC, never a manual blocker.
 *
 * This is HIGH blast radius (it restarts a session), so the safety properties
 * are the heart of the test: DARK by default (inert unless explicitly enabled),
 * allowlist-scoped, and a hard loop-guard. The enabled "actually refresh" path
 * stays dark in production until turned on + proven live, so here we lock down
 * syntax validity + the inert-by-default guarantee + the safety invariants, and
 * migration parity (always-overwrite install).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function createMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: true,
    projectName: 'test-agent',
  });
}
function hookScript(m: PostUpdateMigrator): string {
  return (m as unknown as { getMcpHealthAutorefreshHook(): string }).getMcpHealthAutorefreshHook();
}
function markerExists(projectDir: string): boolean {
  return fs.existsSync(path.join(projectDir, '.instar', 'state', 'mcp-autorefresh-marker.json'));
}

describe('PostUpdateMigrator — mcp-health-autorefresh.sh (auto-restart-on-MCP-inaccessible)', () => {
  let projectDir: string;
  let scriptPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mcp-autorefresh-'));
    fs.mkdirSync(path.join(projectDir, '.instar', 'state'), { recursive: true });
    scriptPath = path.join(projectDir, '.instar', 'mcp-health-autorefresh.sh');
    fs.writeFileSync(scriptPath, hookScript(createMigrator(projectDir)), { mode: 0o755 });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-mcpAutorefresh.test.ts',
    });
  });

  it('generates syntactically-valid bash (bash -n)', () => {
    expect(() => execFileSync('bash', ['-n', scriptPath])).not.toThrow();
  });

  it('embeds the safety invariants: dark-default + allowlist + hard loop-guard + the action', () => {
    const s = hookScript(createMigrator(projectDir));
    expect(s).toContain('mcpAutoRefresh');               // config-gated
    expect(s).toContain('is True');                      // DARK by default (must be ===true)
    expect(s).toContain('mcp-autorefresh-marker.json');  // loop-guard marker
    expect(s).toMatch(/NOT re-refreshing/i);             // loop-guard refusal branch
    expect(s).toContain('/sessions/refresh');            // the action
    expect(s).toContain('playwright');                   // default allowlist (not arbitrary MCPs)
  });

  it('is INERT by default — config WITHOUT mcpAutoRefresh exits 0 and does NOTHING', () => {
    fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), JSON.stringify({ port: 4042 }));
    const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_CODE_SESSION_ID: 'test-sid' };
    // Exits at the dark-default gate, before any `claude` / curl / marker write.
    execFileSync('bash', [scriptPath], { env, encoding: 'utf-8' });
    expect(markerExists(projectDir)).toBe(false);
  });

  it('is INERT when explicitly disabled (enabled:false)', () => {
    fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), JSON.stringify({ port: 4042, mcpAutoRefresh: { enabled: false } }));
    const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_CODE_SESSION_ID: 'test-sid' };
    execFileSync('bash', [scriptPath], { env, encoding: 'utf-8' });
    expect(markerExists(projectDir)).toBe(false);
  });

  it('does nothing dangerous when enabled but the allowlist is empty (no claude call, no refresh)', () => {
    fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), JSON.stringify({ port: 4042, mcpAutoRefresh: { enabled: true, servers: [] } }));
    const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_CODE_SESSION_ID: 'test-sid' };
    execFileSync('bash', [scriptPath], { env, encoding: 'utf-8' });
    expect(markerExists(projectDir)).toBe(false);
  });

  it('migration parity: migrateHooks always-overwrites the hook into hooks/instar/', () => {
    fs.mkdirSync(path.join(projectDir, '.instar', 'hooks', 'instar'), { recursive: true });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (createMigrator(projectDir) as unknown as { migrateHooks(r: MigrationResult): void }).migrateHooks(result);
    const installed = path.join(projectDir, '.instar', 'hooks', 'instar', 'mcp-health-autorefresh.sh');
    expect(fs.existsSync(installed)).toBe(true);
    // and it is wired into session-start.sh (the invocation)
    const sessionStart = fs.readFileSync(path.join(projectDir, '.instar', 'hooks', 'instar', 'session-start.sh'), 'utf-8');
    expect(sessionStart).toContain('mcp-health-autorefresh.sh');
  });

  // ── developmentAgent gate: dev agents auto-enable; production stays dark ──
  // A mock `claude` reports playwright as "Failed to connect"; config uses a DEAD
  // port so the session-name-resolution curl always fails — the script then exits
  // with "could not resolve own session name" IFF it passed the dark gate. That
  // stderr line is our observable proxy for "enabled". Never touches a real server;
  // never writes the refresh marker (session resolution fails first).
  function runWithMockClaude(cfg: Record<string, unknown>): string {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-claude-bin-'));
    fs.writeFileSync(
      path.join(binDir, 'claude'),
      '#!/bin/bash\necho "playwright: npx -y @playwright/mcp@latest - x Failed to connect"\necho "threadline: node entry - Connected"\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), JSON.stringify({ port: 59999, ...cfg }));
    const env = {
      ...process.env,
      PATH: binDir + path.delimiter + (process.env.PATH || ''),
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_CODE_SESSION_ID: 'test-sid',
    };
    const r = spawnSync('bash', [scriptPath], { env, encoding: 'utf-8' });
    SafeFsExecutor.safeRmSync(binDir, { recursive: true, force: true, operation: 'test mock-claude bin' });
    return (r.stderr || '') + (r.stdout || '');
  }
  const PASSED_GATE = /could not resolve own session name/i;

  it('DEV agent auto-enables when mcpAutoRefresh is unset (developmentAgent:true)', () => {
    const out = runWithMockClaude({ developmentAgent: true });
    expect(out).toMatch(PASSED_GATE);                // passed the dark gate -> would have refreshed
    expect(markerExists(projectDir)).toBe(false);    // but never reached a real refresh (dead port)
  });

  it('PRODUCTION agent stays dark when mcpAutoRefresh is unset (no developmentAgent)', () => {
    const out = runWithMockClaude({});
    expect(out).not.toMatch(PASSED_GATE);            // exited at the dark gate
    expect(markerExists(projectDir)).toBe(false);
  });

  it('explicit mcpAutoRefresh.enabled:false overrides developmentAgent (stays dark)', () => {
    const out = runWithMockClaude({ developmentAgent: true, mcpAutoRefresh: { enabled: false } });
    expect(out).not.toMatch(PASSED_GATE);
    expect(markerExists(projectDir)).toBe(false);
  });
});
