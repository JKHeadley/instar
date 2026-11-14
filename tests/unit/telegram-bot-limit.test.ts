/**
 * Telegram's 20-bot limit (install-experience, topic 135786): setup continues app-only
 * instead of looping on a token BotFather will never issue.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { consumeBotLimitOutcome, isTelegramSkip, telegramSetupOutcomePath } from '../../src/commands/setup-wizard/telegram-bot-limit.js';
import { buildTelegramAgenticPrompt } from '../../src/commands/setup-wizard/codex-driver.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Telegram bot limit', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-limit-')); });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/telegram-bot-limit.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('treats only the word skip as skipping', () => {
    expect(isTelegramSkip(' Skip ')).toBe(true);
    expect(isTelegramSkip('')).toBe(false);
    expect(isTelegramSkip('123:abc')).toBe(false);
  });

  it('reads and clears a recorded bot-limit refusal', () => {
    const file = telegramSetupOutcomePath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"outcome":"bot-limit"}');
    expect(consumeBotLimitOutcome(dir)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(consumeBotLimitOutcome(dir)).toBe(false);
  });

  it('ignores a missing, unreadable, or different outcome', () => {
    expect(consumeBotLimitOutcome(dir)).toBe(false);
    const file = telegramSetupOutcomePath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"outcome":"login-timeout"}');
    expect(consumeBotLimitOutcome(dir)).toBe(false);
    fs.writeFileSync(file, 'not json');
    expect(consumeBotLimitOutcome(dir)).toBe(false);
  });

  it('tells the browser-driven setup where to record the refusal', () => {
    const prompt = buildTelegramAgenticPrompt(dir, { agentName: 'cirrus' });
    expect(prompt).toContain(telegramSetupOutcomePath(dir));
    expect(prompt).toContain('AGENTIC_FAILED: bot-limit');
  });
});
