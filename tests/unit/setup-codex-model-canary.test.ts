/**
 * Canary tests for the setup-wizard spawn discipline in setup.ts.
 *
 * Two historical bugs are pinned here:
 *
 * 1. **v1.2.10 model-pin gap** (now obsolete after v1.2.12): setup.ts
 *    used to spawn `codex exec` for the wizard, but did not pass a
 *    `-m`/`--model` flag. Codex CLI's default model (`gpt-5.2-codex`)
 *    was retired from ChatGPT-subscription accounts on 2026-04-14, so
 *    the spawn returned a 400 before the wizard could render. v1.2.10
 *    added `-m WIZARD_CODEX_MODEL`.
 *
 * 2. **v1.2.12 wizard-via-claude pin**: the first end-to-end test of
 *    the Codex install path showed that even with the correct model,
 *    Codex ignores the wizard skill's conversational instructions —
 *    it executes the setup non-interactively instead of leading the
 *    user through identity, autonomy, and messaging questions. v1.2.12
 *    routes the wizard ALWAYS through Claude, regardless of which
 *    framework the user picked at the runtime prompt. The host
 *    framework still gates the agent's runtime (enabledFrameworks); it
 *    just no longer gates the conversational onboarding tool.
 *
 * The canary asserts the v1.2.12 contract: no codex spawns remain in
 * setup.ts for the interactive wizard or secret-setup phases. The
 * WIZARD_CODEX_MODEL constant remains exported as a deprecated public
 * symbol so any future codex spawn that DOES land in setup.ts uses the
 * subscription-supported model.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIZARD_CODEX_MODEL } from '../../src/commands/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETUP_SRC = path.resolve(__dirname, '../../src/commands/setup.ts');

describe('setup.ts wizard spawn canary', () => {
  const source = fs.readFileSync(SETUP_SRC, 'utf-8');

  it('keeps WIZARD_CODEX_MODEL pinned to a ChatGPT-subscription-supported model', () => {
    // gpt-5.2-codex was Codex CLI's default and is API-only since
    // 2026-04-14 (rejected on ChatGPT accounts). Even though setup.ts
    // no longer spawns codex directly, the constant remains exported
    // as the canonical name in case a future code path needs it.
    expect(WIZARD_CODEX_MODEL).not.toBe('gpt-5.2-codex');
    // Empirically confirmed-working on ChatGPT auth per
    // src/providers/adapters/openai-codex/models.ts (probed 2026-05-15).
    expect(WIZARD_CODEX_MODEL).toMatch(/^gpt-5\.(2|3-codex|4)$/);
  });

  it('setup.ts has no `codex exec` spawn — wizard always runs on Claude', () => {
    // The v1.2.12 contract: every interactive micro-session in setup.ts
    // (the main wizard launch and the secret-setup micro-session) goes
    // through Claude, not Codex. Codex's training pulls toward execution
    // and it routinely ignores the wizard skill's conversational
    // contract. If a future PR adds a `codex exec` argv string back
    // into setup.ts, this test fails — surfacing the regression to the
    // author before it ships.
    expect(source).not.toMatch(/'exec'\s*,\s*[\s\S]{0,200}'-m'/);
    expect(source).not.toMatch(/'-m'\s*,\s*WIZARD_CODEX_MODEL/);
  });

  it('the wizard binary is the detected Claude path, not a framework conditional', () => {
    // The wizardBinary assignment must not be ternary on `framework`.
    // It should resolve to claudePath unconditionally (with a hard
    // refusal upstream if claudePath is null).
    const wizardBinaryAssign = source.match(/const wizardBinary = [^;]+;/);
    expect(wizardBinaryAssign).not.toBeNull();
    expect(wizardBinaryAssign![0]).not.toMatch(/framework\s*===\s*'codex-cli'/);
    expect(wizardBinaryAssign![0]).toContain('claudePath');
  });

  it('no string literal in setup.ts hardcodes the retired gpt-5.2-codex model name', () => {
    expect(source).not.toMatch(/['"]gpt-5\.2-codex['"]/);
  });
});
