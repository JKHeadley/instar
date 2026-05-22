/**
 * Canary test for the framework-aware welcome banner in setup.ts.
 *
 * Pre-v1.2.16: the banner always printed "Instar runs Claude Code
 * with --dangerously-skip-permissions" regardless of which runtime
 * the user picked at the v1.2.1 bareword prompt. Justin caught this
 * on the v1.2.15 install — picked Codex, saw a "Claude Code" warning.
 *
 * v1.2.16: the banner branches on the resolved `framework` value and
 * shows the correct runtime name + sandbox flag. This canary pins
 * both branches.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETUP_SRC = path.resolve(__dirname, '../../src/commands/setup.ts');

describe('welcome banner is framework-aware', () => {
  const src = fs.readFileSync(SETUP_SRC, 'utf-8');

  it('no longer hardcodes "Claude Code" in the banner string literal', () => {
    // The pre-fix banner was:
    //   console.log(pc.yellow('  Note: Instar runs Claude Code with --dangerously-skip-permissions.'));
    // After the fix, the runtime name + sandbox flag come from
    // variables, not a single hardcoded string literal.
    expect(src).not.toMatch(
      /pc\.yellow\(\s*['"`]\s*Note: Instar runs Claude Code with --dangerously-skip-permissions/,
    );
  });

  it('derives the runtime label from the resolved framework', () => {
    expect(src).toMatch(/runtimeLabel.*framework\s*===\s*'codex-cli'/);
    expect(src).toMatch(/'Codex CLI'/);
    expect(src).toMatch(/'Claude Code'/);
  });

  it('derives the sandbox flag string from the resolved framework', () => {
    expect(src).toMatch(/sandboxFlag.*framework\s*===\s*'codex-cli'/);
    expect(src).toMatch(/'--dangerously-bypass-approvals-and-sandbox'/);
    expect(src).toMatch(/'--dangerously-skip-permissions'/);
  });

  it('banner line uses template interpolation with both derived values', () => {
    // The actual log line should reference both variables.
    expect(src).toMatch(/runs \$\{runtimeLabel\} with \$\{sandboxFlag\}/);
  });
});
