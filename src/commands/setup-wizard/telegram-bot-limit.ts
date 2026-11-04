/**
 * Telegram allows one account at most 20 bots. When BotFather refuses a new one, setup
 * continues without Telegram: the agent still works from its dashboard and the Instar app.
 * Found on a fresh cloud agent (Cirrus, 2026-11-02), whose owner already had 20 bots.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';

export const TELEGRAM_BOT_LIMIT_HINT =
  'If BotFather says you can\'t create more bots (Telegram allows 20 per account), type skip.';

export const TELEGRAM_APP_ONLY_NOTE =
  'Continuing without Telegram. Your agent works from its dashboard and the Instar app. '
  + 'To add Telegram later, delete a bot you no longer use in BotFather, then ask your agent to connect Telegram.';

export function isTelegramSkip(input: string): boolean {
  return input.trim().toLowerCase() === 'skip';
}

/** Where the browser-driven setup records that BotFather refused a new bot. */
export function telegramSetupOutcomePath(projectDir: string): string {
  return path.join(projectDir, '.instar', 'state', 'telegram-setup-outcome.json');
}

/** True when the browser-driven setup recorded BotFather's bot-limit refusal. Clears the record. */
export function consumeBotLimitOutcome(projectDir: string): boolean {
  const file = telegramSetupOutcomePath(projectDir);
  try {
    const outcome = JSON.parse(fs.readFileSync(file, 'utf-8')) as { outcome?: unknown };
    SafeFsExecutor.safeRmSync(file, { force: true, operation: 'setup-wizard:telegram-setup-outcome' });
    return outcome?.outcome === 'bot-limit';
  } catch {
    // @silent-fallback-ok: no record (the usual case) or an unreadable one means no limit was seen
    return false;
  }
}
