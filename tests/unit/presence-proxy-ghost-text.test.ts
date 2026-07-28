/**
 * Input-box ghost-text stripping (the 2026-06-06 presence-confabulation
 * incident): codex renders rotating placeholder suggestions inside its empty
 * input box; ANSI-stripping erases the dim styling, and the assessment LLM
 * reported "preparing to write tests for the referenced file" for a session
 * that was IDLE at a fresh prompt (topic 2271, 00:35:28Z presence message vs
 * the idle pane). Ledger finding d0fd5483 / dedupKey
 * presence-proxy-codex-input-placeholder-as-activity.
 *
 * Tested through the public sanitizeTmuxOutput surface — the chokepoint every
 * presence snapshot passes through before reaching the assessment LLM.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeTmuxOutput } from '../../src/monitoring/PresenceProxy.js';

/** The REAL pane capture from the incident (ANSI already stripped by tmux -p). */
const INCIDENT_PANE = [
  '⚠ Heads up, you have less than 25% of your weekly limit left. Run /status for a breakdown.',
  '',
  '› Write tests for @filename',
  '  gpt-5.5 default · ~/Documents/Projects/instar-codey',
].join('\n');

describe('input-box ghost-text stripping (presence confabulation fix)', () => {
  it('strips the real incident ghost line — the pane reads as idle, not "writing tests"', () => {
    const out = sanitizeTmuxOutput(INCIDENT_PANE);
    expect(out).not.toContain('Write tests for @filename');
    // Non-ghost context is preserved untouched.
    expect(out).toContain('weekly limit');
    expect(out).toContain('gpt-5.5 default');
  });

  it('strips template-token ghosts regardless of suggestion wording', () => {
    expect(sanitizeTmuxOutput('› Implement {feature}')).toBe('');
    expect(sanitizeTmuxOutput('› Refactor {module} for clarity')).toBe(''); // unseen wording, {token} marks it
    expect(sanitizeTmuxOutput('❯ Write tests for @filename')).toBe(''); // claude-style prompt char
  });

  it('strips known codex suggestions case-insensitively even without a template token', () => {
    expect(sanitizeTmuxOutput('› Explain this codebase')).toBe('');
    expect(sanitizeTmuxOutput('›   summarize recent commits  ')).toBe('');
  });

  it('KEEPS a real typed-but-unsubmitted command — only text the user never wrote is stripped', () => {
    const typed = '› fix the login bug in src/auth.ts and add a regression test';
    expect(sanitizeTmuxOutput(typed)).toBe(typed.trim());
  });

  it('KEEPS prose mentioning @filename when it is not an input-box line', () => {
    const prose = 'The auditor accepts @filename arguments in its config {feature} flags too.';
    expect(sanitizeTmuxOutput(prose)).toBe(prose);
  });

  it('KEEPS real agent output lines that begin with a quote-style chevron', () => {
    const output = '  › step 3 completed: wrote 14 tests, all green';
    expect(sanitizeTmuxOutput(output)).toBe(output.trim());
  });
});
