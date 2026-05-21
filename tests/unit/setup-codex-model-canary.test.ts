/**
 * Canary tests for the setup-wizard spawn discipline.
 *
 * Three historical bugs are pinned here. Each fix changed how
 * setup.ts dispatches the wizard for Codex-runtime users.
 *
 * 1. **v1.2.10 model-pin gap**: setup.ts used to spawn `codex exec`
 *    for the wizard without `-m`. Codex CLI's default `gpt-5.2-codex`
 *    was retired from ChatGPT-subscription accounts on 2026-04-14.
 *    v1.2.10 added `-m WIZARD_CODEX_MODEL`.
 *
 * 2. **v1.2.11 model-fix exposed deeper problem**: Codex spawned with
 *    the right model but ignored the wizard skill's conversational
 *    contract — executed setup non-interactively, generic identity.
 *    Adding more PAUSE-HERE markers wouldn't fix it.
 *
 * 3. **v1.2.12 hybrid wizard**: instar's own state machine drives the
 *    conversation flow when framework === 'codex-cli'. Codex is
 *    invoked per-turn ONLY to generate narrative intro text (one
 *    paragraph, no tools, read-only sandbox). Structural prompts and
 *    side effects (init, user add, server start) are owned by instar.
 *    setup.ts dispatches to `runCodexWizard` from
 *    src/commands/setup-wizard/codex-driver.ts; the legacy `codex exec
 *    ... /setup-wizard ...` shape is gone from setup.ts entirely.
 *
 * The canary asserts the v1.2.12 contract:
 *   - WIZARD_CODEX_MODEL remains pinned to a subscription-supported
 *     model.
 *   - setup.ts contains no `codex exec` argv with the wizard skill
 *     prompt (those moved into the codex-driver).
 *   - setup.ts dispatches to `runCodexWizard` for codex-cli installs.
 *   - The codex driver's narrative spawns pass -m WIZARD_CODEX_MODEL.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIZARD_CODEX_MODEL } from '../../src/commands/setup-wizard/model-constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETUP_SRC = path.resolve(__dirname, '../../src/commands/setup.ts');
const CODEX_DRIVER_SRC = path.resolve(
  __dirname,
  '../../src/commands/setup-wizard/codex-driver.ts',
);

describe('setup.ts wizard dispatch canary', () => {
  const setupSrc = fs.readFileSync(SETUP_SRC, 'utf-8');
  const driverSrc = fs.readFileSync(CODEX_DRIVER_SRC, 'utf-8');

  it('WIZARD_CODEX_MODEL stays pinned to a ChatGPT-subscription-supported model', () => {
    expect(WIZARD_CODEX_MODEL).not.toBe('gpt-5.2-codex');
    expect(WIZARD_CODEX_MODEL).toMatch(/^gpt-5\.(2|3-codex|4)$/);
  });

  it('setup.ts dispatches codex-cli installs to runCodexWizard', () => {
    expect(setupSrc).toMatch(/import\(.*setup-wizard\/codex-driver/);
    expect(setupSrc).toMatch(/runCodexWizard\s*\(/);
    expect(setupSrc).toMatch(
      /if\s*\(\s*framework\s*===\s*'codex-cli'\s*\)/,
    );
  });

  it('setup.ts no longer carries a `codex exec` argv with the wizard skill prompt', () => {
    // Pre-v1.2.12, setup.ts built `[ 'exec', ..., 'Read … SKILL.md … wizard' ]`.
    // The hybrid wizard moved all codex spawns into codex-driver.ts.
    expect(setupSrc).not.toMatch(/'exec'[\s\S]{0,300}setup-wizard\/SKILL\.md/);
  });

  it('the codex driver passes -m WIZARD_CODEX_MODEL on every codex exec spawn', () => {
    const execBlocks = driverSrc.match(/'exec'[\s\S]*?\]/g) ?? [];
    expect(execBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of execBlocks) {
      expect(block).toMatch(/'-m'\s*,\s*WIZARD_CODEX_MODEL/);
    }
  });

  it('no string literal in setup.ts or the driver hardcodes the retired gpt-5.2-codex name', () => {
    expect(setupSrc).not.toMatch(/['"]gpt-5\.2-codex['"]/);
    expect(driverSrc).not.toMatch(/['"]gpt-5\.2-codex['"]/);
  });
});
