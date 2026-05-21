/**
 * Verifies the framework-prompt decision function used by the bareword
 * `npx instar` flow. The readline interaction itself is exercised by the
 * setup wizard's manual run; here we pin the decision logic: when both
 * runtimes are installed (or neither is), prompt the user; when exactly
 * one is installed, skip the prompt and use that one.
 */

import { describe, it, expect } from 'vitest';
import { resolveFrameworkPromptBehavior } from '../../src/commands/setup.js';

describe('resolveFrameworkPromptBehavior — bareword framework prompt', () => {
  it('prompts when both runtimes are installed', () => {
    expect(resolveFrameworkPromptBehavior(true, true)).toBe('prompt');
  });

  it('returns claude-code without prompting when only Claude is installed', () => {
    expect(resolveFrameworkPromptBehavior(true, false)).toBe('claude-code');
  });

  it('returns codex-cli without prompting when only Codex is installed', () => {
    expect(resolveFrameworkPromptBehavior(false, true)).toBe('codex-cli');
  });

  it('prompts when neither runtime is installed (lets the user pick which one to install)', () => {
    // Rationale: if we silently picked claude-code, the prereq check would
    // exit with a "claude not installed" message — but the user might have
    // intended to install codex. Asking lets the right install message
    // surface from checkFrameworkPrerequisite for the user's actual choice.
    expect(resolveFrameworkPromptBehavior(false, false)).toBe('prompt');
  });
});
