/**
 * Unit canaries for the Gemini hybrid setup driver.
 *
 * Gemini setup must use the same deterministic state-machine spine as Codex,
 * but with a stricter side-effect boundary: Gemini is only asked for bounded
 * narrative prose. Instar owns init, user/config writes, server startup, and
 * Telegram setup.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEMINI_WIZARD_MODEL } from '../../src/commands/setup-wizard/model-constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GEMINI_DRIVER_SRC = path.resolve(
  __dirname,
  '../../src/commands/setup-wizard/gemini-driver.ts',
);

describe('Gemini setup driver boundary', () => {
  const source = fs.readFileSync(GEMINI_DRIVER_SRC, 'utf-8');

  it('uses the shared wizard state machine', () => {
    expect(source).toMatch(/buildFreshProjectInstall/);
    expect(source).toMatch(/INITIAL_STATE/);
    expect(source).toMatch(/resolveChoice/);
    expect(source).toMatch(/export async function runGeminiWizard/);
  });

  it('pins Gemini narrative to the canonical one-shot argv and model', () => {
    expect(GEMINI_WIZARD_MODEL).toBe('gemini-2.5-flash');
    expect(source).toMatch(/buildGeminiOneShotArgv\(GEMINI_WIZARD_MODEL, prompt\)/);
    expect(source).toMatch(/buildGeminiChildEnv\(parentEnv\)/);
    expect(source).toMatch(/GEMINI_CLI_TRUST_WORKSPACE/);
  });

  it('never hands Gemini the Claude setup skill or a shell/tool contract', () => {
    expect(source).not.toMatch(/setup-wizard\/SKILL\.md/);
    expect(source).not.toMatch(/run_shell_command/);
    expect(source).not.toMatch(/dangerously-bypass-approvals-and-sandbox/);
    expect(source).not.toMatch(/mcp__playwright/);
    expect(source).not.toMatch(/runTelegramAgentic/);
  });

  it('owns side effects in Instar code and initializes a gemini-cli agent', () => {
    expect(source).toMatch(/execFileSync\(\s*'npx'/);
    expect(source).toMatch(/'instar',\s*'init'/);
    expect(source).toMatch(/'--framework',\s*'gemini-cli'/);
    expect(source).toMatch(/async function runTelegramSetup/);
    expect(source).toMatch(/function writeTelegramConfig/);
  });
});
