/**
 * Tests for the v1.2.17 Codex+Playwright Telegram setup primary path.
 *
 * v1.2.15 removed the codex-exec Telegram action because Playwright
 * wasn't registered for Codex (ensurePlaywrightMcp only wrote to
 * ~/.claude.json and .mcp.json, never ~/.codex/config.toml), so
 * Codex couldn't drive the browser. v1.2.17 restores it as the
 * primary path:
 *
 *   1. ensureCodexPlaywrightMcp now writes [mcp_servers."playwright"]
 *      to ~/.codex/config.toml when not already present.
 *   2. runTelegramAgentic spawns Codex with Playwright available,
 *      lets it drive Telegram Web → BotFather → token + chatId
 *      capture → config write.
 *   3. verifyTelegramConfig checks the config write actually
 *      happened; if not, the dispatch falls through to
 *      runTelegramSetup (the v1.2.15 instar-native readline
 *      backstop).
 *
 * These tests pin the SHAPE of the new primary path without making
 * real Codex/Telegram calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTelegramAgenticPrompt,
  verifyTelegramConfig,
} from '../../src/commands/setup-wizard/codex-driver.js';
import { ensureCodexPlaywrightMcp } from '../../src/commands/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tmpRm(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/codex-playwright-telegram.test.ts:tmpRm',
  });
}

describe('buildTelegramAgenticPrompt', () => {
  const prompt = buildTelegramAgenticPrompt('/tmp/fake-project');

  it('names the project dir for the agent', () => {
    expect(prompt).toContain('/tmp/fake-project');
  });

  it('lists the Playwright tool surface the agent should reach for', () => {
    expect(prompt).toMatch(/mcp__playwright__browser_navigate/);
    expect(prompt).toMatch(/browser_snapshot/);
    expect(prompt).toMatch(/browser_click/);
    expect(prompt).toMatch(/browser_type/);
  });

  it('declares the structural success criterion (config-write shape)', () => {
    expect(prompt).toMatch(/SUCCESS CRITERION/);
    expect(prompt).toMatch(/type:\s*"telegram"/);
    expect(prompt).toMatch(/token/);
    expect(prompt).toMatch(/chatId/);
    expect(prompt).toMatch(/pollIntervalMs/);
  });

  it('demands a PLAYWRIGHT_UNAVAILABLE sentinel on missing tools', () => {
    expect(prompt).toMatch(/PLAYWRIGHT_UNAVAILABLE/);
  });

  it('demands an AGENTIC_FAILED sentinel on recoverable failures', () => {
    expect(prompt).toMatch(/AGENTIC_FAILED/);
  });

  it('uses Telegram Bot API for token validation + chat ID discovery', () => {
    expect(prompt).toMatch(/api\.telegram\.org/);
    expect(prompt).toMatch(/getMe/);
    expect(prompt).toMatch(/getUpdates/);
  });
});

describe('verifyTelegramConfig', () => {
  let tmp: string;
  beforeEach(() => { tmp = mktmp('verifytg-'); });
  afterEach(() => { tmpRm(tmp); });

  function writeConfig(messaging: unknown[]): void {
    fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.instar', 'config.json'),
      JSON.stringify({ messaging }),
    );
  }

  it('returns false when .instar/config.json is missing', () => {
    expect(verifyTelegramConfig(tmp)).toBe(false);
  });

  it('returns false when messaging array is empty', () => {
    writeConfig([]);
    expect(verifyTelegramConfig(tmp)).toBe(false);
  });

  it('returns false when telegram entry has empty token', () => {
    writeConfig([{ type: 'telegram', enabled: true, config: { token: '', chatId: '-100123' } }]);
    expect(verifyTelegramConfig(tmp)).toBe(false);
  });

  it('returns false when telegram entry has empty chatId', () => {
    writeConfig([{ type: 'telegram', enabled: true, config: { token: 'abc:def', chatId: '' } }]);
    expect(verifyTelegramConfig(tmp)).toBe(false);
  });

  it('returns true when telegram entry has both token and chatId populated', () => {
    writeConfig([
      { type: 'telegram', enabled: true, config: { token: '123:abc', chatId: '-100456' } },
    ]);
    expect(verifyTelegramConfig(tmp)).toBe(true);
  });

  it('ignores non-telegram messaging entries', () => {
    writeConfig([
      { type: 'whatsapp', enabled: true, config: { backend: 'baileys' } },
      { type: 'telegram', enabled: true, config: { token: '123:abc', chatId: '-100456' } },
    ]);
    expect(verifyTelegramConfig(tmp)).toBe(true);
  });
});

describe('ensureCodexPlaywrightMcp', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mktmp('codexmcp-');
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Re-import os to pick up new HOME — but os.homedir() reads HOME
    // at call time on POSIX, so the next call inside the function
    // will see our override.
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    tmpRm(tmpHome);
  });

  it('skips silently when ~/.codex/ does not exist (Codex not installed)', () => {
    // No .codex dir created. Should no-op without throwing.
    expect(() => ensureCodexPlaywrightMcp()).not.toThrow();
    expect(fs.existsSync(path.join(tmpHome, '.codex'))).toBe(false);
  });

  it('appends the playwright MCP block when ~/.codex/config.toml exists without it', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const cfgPath = path.join(tmpHome, '.codex', 'config.toml');
    fs.writeFileSync(cfgPath, 'model = "gpt-5.2-codex"\n\n[mcp_servers."other"]\nkind = "stdio"\ncommand = "/bin/true"\nargs = []\n');
    ensureCodexPlaywrightMcp();
    const after = fs.readFileSync(cfgPath, 'utf-8');
    expect(after).toContain('[mcp_servers."playwright"]');
    expect(after).toContain('command = "npx"');
    expect(after).toContain('@playwright/mcp@latest');
    // Original sections preserved.
    expect(after).toContain('model = "gpt-5.2-codex"');
    expect(after).toContain('[mcp_servers."other"]');
  });

  it('is idempotent — re-running does NOT duplicate the block', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const cfgPath = path.join(tmpHome, '.codex', 'config.toml');
    fs.writeFileSync(cfgPath, 'model = "gpt-5.2-codex"\n');
    ensureCodexPlaywrightMcp();
    ensureCodexPlaywrightMcp();
    ensureCodexPlaywrightMcp();
    const after = fs.readFileSync(cfgPath, 'utf-8');
    const matches = after.match(/\[mcp_servers\."playwright"\]/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('matches BOTH quoted and unquoted TOML section forms', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const cfgPath = path.join(tmpHome, '.codex', 'config.toml');
    // Pre-existing unquoted form.
    fs.writeFileSync(cfgPath, '[mcp_servers.playwright]\nkind = "stdio"\ncommand = "npx"\nargs = []\n');
    ensureCodexPlaywrightMcp();
    const after = fs.readFileSync(cfgPath, 'utf-8');
    // Should NOT have added a duplicate quoted form.
    expect(after).not.toMatch(/\[mcp_servers\."playwright"\]/);
    expect(after).toMatch(/\[mcp_servers\.playwright\]/);
  });
});

describe('codex driver dispatches telegram-agentic before native fallback', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/commands/setup-wizard/codex-driver.ts'),
    'utf-8',
  );

  it('setup-telegram-agentic action tries runTelegramAgentic first', () => {
    expect(src).toMatch(/case 'setup-telegram-agentic':[\s\S]*?runTelegramAgentic/);
  });

  it('falls through to runTelegramSetup when the agentic path reports not configured', () => {
    expect(src).toMatch(
      /case 'setup-telegram-agentic':[\s\S]*?if \(agentic\.telegramConfigured\) return agentic;[\s\S]*?runTelegramSetup\(options\)/,
    );
  });
});
