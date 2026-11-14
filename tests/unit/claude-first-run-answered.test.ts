/**
 * Claude Code first-run screens pre-answered (install-experience, topic 135786).
 *
 * A fresh Linux server (Cirrus, 2026-11-02) killed every first session at
 * Claude Code's first-run screens: the welcome flow, folder trust, the project
 * MCP picker, and the bypass-permissions warning whose default is "No, exit".
 * These tests cover both sides of each answer with a real filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureBypassPromptSkipped,
  ensureClaudeFirstRunAnswered,
  ensureInteractiveReady,
} from '../../src/core/ensureInteractiveReady.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Claude Code first-run answers', () => {
  let dir: string;
  let realHome: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-'));
    realHome = process.env.HOME;
  });
  afterEach(() => {
    process.env.HOME = realHome;
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/claude-first-run-answered.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));

  it('answers the project MCP picker alongside folder trust', () => {
    const home = path.join(dir, 'acct');
    const r = ensureInteractiveReady(home, { projectDir: '/agents/cirrus' });
    expect(r.patched).toBe(true);
    const entry = read(path.join(home, '.claude.json')).projects['/agents/cirrus'];
    expect(entry.hasTrustDialogAccepted).toBe(true);
    expect(entry.enableAllProjectMcpServers).toBe(true);
  });

  it('patches a home whose folder trust is set but whose MCP picker is unanswered', () => {
    const home = path.join(dir, 'acct');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, hasTrustDialogAccepted: true,
      projects: { '/agents/cirrus': { hasTrustDialogAccepted: true, mcpServers: { x: { command: 'y' } } } },
    }));
    const r = ensureInteractiveReady(home, { projectDir: '/agents/cirrus' });
    expect(r.patched).toBe(true);
    const entry = read(path.join(home, '.claude.json')).projects['/agents/cirrus'];
    expect(entry.enableAllProjectMcpServers).toBe(true);
    expect(entry.mcpServers).toEqual({ x: { command: 'y' } });
  });

  it('sets only skipDangerousModePermissionPrompt and keeps every other setting', () => {
    const settingsDir = path.join(dir, 'settings');
    fs.mkdirSync(settingsDir);
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [] } }));
    expect(ensureBypassPromptSkipped(settingsDir).patched).toBe(true);
    expect(read(path.join(settingsDir, 'settings.json'))).toEqual({
      model: 'opus', hooks: { Stop: [] }, skipDangerousModePermissionPrompt: true,
    });
    expect(ensureBypassPromptSkipped(settingsDir)).toEqual({ patched: false, reason: 'already interactive-ready' });
  });

  it('refuses to rewrite an unparseable settings.json', () => {
    const settingsDir = path.join(dir, 'settings');
    fs.mkdirSync(settingsDir);
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), '{ not json');
    const r = ensureBypassPromptSkipped(settingsDir);
    expect(r.patched).toBe(false);
    expect(r.reason).toMatch(/refusing to rewrite/);
    expect(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf-8')).toBe('{ not json');
  });

  it('default login: .claude.json in HOME, settings in ~/.claude, on a machine that never ran Claude Code', () => {
    process.env.HOME = dir;
    const r = ensureClaudeFirstRunAnswered(null, '/agents/cirrus');
    expect(r.patched).toBe(true);
    const json = read(path.join(dir, '.claude.json'));
    expect(json.hasCompletedOnboarding).toBe(true);
    expect(json.projects['/agents/cirrus'].hasTrustDialogAccepted).toBe(true);
    expect(json.projects['/agents/cirrus'].enableAllProjectMcpServers).toBe(true);
    expect(read(path.join(dir, '.claude', 'settings.json')).skipDangerousModePermissionPrompt).toBe(true);
    expect(fs.existsSync(path.join(dir, '.claude', '.claude.json'))).toBe(false);
    expect(ensureClaudeFirstRunAnswered(null, '/agents/cirrus')).toEqual({ patched: false, reason: 'already interactive-ready' });
  });

  it('a CLAUDE_CONFIG_DIR home keeps both files inside it', () => {
    const home = path.join(dir, '.claude-acct');
    expect(ensureClaudeFirstRunAnswered(home, '/agents/cirrus').patched).toBe(true);
    expect(read(path.join(home, '.claude.json')).hasCompletedOnboarding).toBe(true);
    expect(read(path.join(home, 'settings.json')).skipDangerousModePermissionPrompt).toBe(true);
  });
});
