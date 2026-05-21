/**
 * Canary test for the codex `--model` flag on setup.ts spawns.
 *
 * Background: v1.2.1 added a runtime prompt that lets the user pick the
 * codex-cli framework at install time, and v1.0.x had already wired
 * `instar setup --framework codex-cli` to spawn the wizard inside a
 * Codex session. Both code paths called `codex exec ...` without a
 * `-m`/`--model` flag, so Codex used its default model
 * `gpt-5.2-codex` — which OpenAI retired from ChatGPT-subscription
 * accounts on 2026-04-14. The first real end-to-end install attempt by
 * a ChatGPT-subscription user (the primary audience) hit
 * `The 'gpt-5.2-codex' model is not supported when using Codex with a
 * ChatGPT account.` and aborted before the wizard could render.
 *
 * The fix: define a `WIZARD_CODEX_MODEL` constant (gpt-5.3-codex) and
 * pass `-m WIZARD_CODEX_MODEL` to every `codex exec` spawn in
 * setup.ts.
 *
 * This test pins the fix as a structural contract: if any future PR
 * removes the `-m` flag from a codex spawn in setup.ts, the test
 * fails, surfacing the regression in CI instead of on a user's
 * machine.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIZARD_CODEX_MODEL } from '../../src/commands/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETUP_SRC = path.resolve(__dirname, '../../src/commands/setup.ts');

describe('setup.ts codex spawn canary', () => {
  const source = fs.readFileSync(SETUP_SRC, 'utf-8');

  it('exports WIZARD_CODEX_MODEL pinned to a ChatGPT-subscription-supported model', () => {
    // gpt-5.2-codex was Codex CLI's default and is API-only since 2026-04-14
    // (rejected on ChatGPT accounts).
    expect(WIZARD_CODEX_MODEL).not.toBe('gpt-5.2-codex');
    // Empirically confirmed-working on ChatGPT auth per
    // src/providers/adapters/openai-codex/models.ts (probed 2026-05-15).
    expect(WIZARD_CODEX_MODEL).toMatch(/^gpt-5\.(2|3-codex|4)$/);
  });

  it('every codex exec spawn in setup.ts passes -m WIZARD_CODEX_MODEL', () => {
    // Match each `framework === 'codex-cli'` branch in setup.ts that
    // builds a `codex exec` argv. There are two as of this fix: the
    // wizard launch and the secret-setup micro-session. Both must
    // include `-m` followed by WIZARD_CODEX_MODEL (or its literal
    // value) before the freeform prompt.
    const execBlocks = source.match(
      /framework === 'codex-cli'[\s\S]*?\[[\s\S]*?'exec',[\s\S]*?\]/g,
    ) ?? [];
    expect(execBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of execBlocks) {
      expect(block).toMatch(/'-m'\s*,\s*WIZARD_CODEX_MODEL/);
    }
  });

  it('no string literal in setup.ts hardcodes the retired gpt-5.2-codex model name', () => {
    // Comments referencing the retired model are fine (this file has them
    // to explain the fix). What's NOT fine is the literal name appearing
    // inside a single- or double-quoted string, which would be a code
    // path passing it to codex.
    expect(source).not.toMatch(/['"]gpt-5\.2-codex['"]/);
  });
});
