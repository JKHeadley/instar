/**
 * Unit tests for the v1.2.15 Telegram-native wizard flow.
 *
 * The previous Telegram action spawned `codex exec` and asked it to
 * walk the user through BotFather. But `codex exec` is non-interactive
 * (single-turn), so the spawned session printed instructions and
 * ended, and the wizard moved on with no token captured. The replacement
 * drives the entire flow from instar with readline + the Telegram Bot
 * API (validating tokens via getMe, auto-discovering chat IDs via
 * getUpdates).
 *
 * These tests pin the SHAPE of the new flow without making real
 * Telegram API calls. We import the driver module to verify symbol
 * shapes, and assert via source-level inspection that the code is no
 * longer spawning Codex for Telegram setup.
 *
 * End-to-end verification (a real Telegram bot + chat) is manual,
 * documented in the PR description.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DRIVER_SRC = path.resolve(
  __dirname,
  '../../src/commands/setup-wizard/codex-driver.ts',
);

describe('Telegram-native wizard flow (v1.2.15)', () => {
  const source = fs.readFileSync(DRIVER_SRC, 'utf-8');

  it('no longer spawns codex exec for the Telegram setup action', () => {
    // Pre-v1.2.15: runTelegramSetup built a `codex exec` argv with a
    // BotFather-walkthrough prompt and spawned it. v1.2.15: the
    // function body is instar-native readline + Telegram Bot API. No
    // codex exec, no dangerously-bypass sandbox in the codex-driver.
    expect(source).not.toMatch(/'dangerously-bypass-approvals-and-sandbox'/);
    // The 'spawn(' import was for the codex exec; gone now.
    expect(source).not.toMatch(/^import \{[^}]*\bspawn\b/);
  });

  it('source references the Telegram Bot API + the helper functions', () => {
    expect(source).toMatch(/api\.telegram\.org/);
    expect(source).toMatch(/telegramGetMe/);
    expect(source).toMatch(/telegramGetUpdates/);
    expect(source).toMatch(/writeTelegramConfig/);
    // Validates token via getMe.
    expect(source).toMatch(/\/getMe/);
    // Auto-discovers chat ID via getUpdates.
    expect(source).toMatch(/\/getUpdates/);
  });

  it('telegramGetMe + telegramGetUpdates are defined as async functions', () => {
    expect(source).toMatch(/async function telegramGetMe/);
    expect(source).toMatch(/async function telegramGetUpdates/);
  });

  it('writeTelegramConfig persists a telegram messaging entry', () => {
    expect(source).toMatch(/function writeTelegramConfig/);
    // The writer replaces any existing telegram entry rather than
    // duplicating.
    expect(source).toMatch(/m\.type !== 'telegram'/);
    // Writes the canonical messaging schema (type/enabled/config).
    expect(source).toMatch(/type:\s*'telegram'/);
    expect(source).toMatch(/pollIntervalMs/);
  });
});

describe('user-add action no longer passes -d (v1.2.15 fix)', () => {
  const source = fs.readFileSync(DRIVER_SRC, 'utf-8');

  it('add-user action spawns `npx instar user add` WITHOUT -d/--dir', () => {
    // Lazy regex: stop at the FIRST closing `}` after the inner `]`
    // of execFileSync's argv. We only care that the argv array
    // doesn't contain -d/--dir.
    const userAddArgvMatch = source.match(/case 'add-user'[\s\S]*?execFileSync\(\s*'npx',\s*(\[[\s\S]*?\])/);
    expect(userAddArgvMatch).not.toBeNull();
    const argvBlock = userAddArgvMatch![1];
    expect(argvBlock).toMatch(/'instar',\s*'user',\s*'add'/);
    expect(argvBlock).not.toMatch(/'-d'/);
    expect(argvBlock).not.toMatch(/'--dir'/);
    // The spawn options for user-add MUST set cwd to options.projectDir.
    const cwdMatch = source.match(/case 'add-user'[\s\S]*?cwd:\s*options\.projectDir/);
    expect(cwdMatch).not.toBeNull();
  });
});

describe('choice echo after validation (v1.2.15 fix)', () => {
  const source = fs.readFileSync(DRIVER_SRC, 'utf-8');

  it('defines an echoChoice helper that uses resolveChoice + choice.label', () => {
    expect(source).toMatch(/function echoChoice/);
    expect(source).toMatch(/echoChoice\(state, answer\)/);
    expect(source).toMatch(/resolveChoice\(answer, state\.input\.choices\)/);
    expect(source).toMatch(/choice\.label/);
  });
});
