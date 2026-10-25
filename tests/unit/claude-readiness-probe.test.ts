/**
 * Readiness probe: neither a booting pane nor a selection menu is a ready pane.
 *
 * INCIDENT 1 — THE BANNER (2026-07-26, topic 29723). A user message arrived at
 * 17:44:49Z, a session was spawned, and the pointer prompt was injected at
 * 17:45:00Z. That session's own start hook did not finish until 17:45:15Z — the
 * pane was still painting its startup banner and had no input box. The paste was
 * swallowed and the injector logged SUCCESS. The message reached the agent only
 * via an unrelated start-hook backstop.
 *
 * The probe accepted `/\/(effort|model|fast)/` anywhere in the tail, and the
 * banner said "Run /model and select Fable to use it."
 *
 * The first fix kept those clauses and required "status-bar shape". Second-pass
 * review falsified that: BANNER_TAIL itself carries `· /memory to free up context`
 * and `+1 more · /status` — banner lines in exactly that shape — so the
 * discrimination was still vocabulary, and `· /model to opt in` matched outright.
 * The clauses are therefore DELETED. The tests below pin that: no slash-command
 * mention, in any shape, is a readiness signal.
 *
 * INCIDENT 2 — THE MENU (found by the operator, same day). Claude Code paints the
 * same `❯` on a menu's focused option as it uses for the input box, so a session
 * sitting on a startup question read as READY. Strictly worse than the banner:
 * text typed at a banner is lost, but Enter at a menu SELECTS AN OPTION — an
 * arriving message can answer a permission question on the operator's behalf.
 */

import { describe, it, expect } from 'vitest';
import {
  isReadyPromptTail,
  classifyPaneReadiness,
  tailShowsMenu,
} from '../../src/core/claudeReadinessProbe.js';

/**
 * Verbatim from the pane that caused incident 1 (Claude Code v2.1.220 boot banner,
 * wide terminal). Do not "tidy" this string — its value is that it is real. Note
 * it contains `/model`, `/status`, `/config`, `/memory` and `/tui`, every one of
 * them in prose, and two of them in interpunct shape.
 */
const BANNER_TAIL = [
  '✓ Using flicker-free rendering · if you want to go back, use /tui default',
  '  · Click to move your cursor in the text input',
  "  · Hold Shift (Option in iTerm2, Fn in Terminal.app) while selecting to use your terminal's native copy instead",
  '⚠ CLAUDE.md is over the 150.0k-char limit (259.3k chars) · /memory to free up context',
  'Fable 5 is now a standard part of your Max plan',
  'You can use up to 50% of your weekly usage limit on Fable 5. If you hit your limit, you can continue on Fable 5 with usage credits. Fable 5 draws down usage faster than Opus 4.8. Run /model and',
  'select Fable to use it. Learn more: https://support.claude.com/en/articles/15424964-claude-fable-5-promotional-access',
  '+1 more · /status',
].join('\n');

/** A real input box, the signal that actually means "accepting input". */
const PROMPT_TAIL = '╭──────────────────────────────╮\n│ ❯                            │\n╰──────────────────────────────╯';

/** Codex renders its prompt with › rather than ❯. */
const CODEX_PROMPT_TAIL = '  › ';

/** Startup / approval menus. Each carries the SAME glyph as the input box. */
const PROCEED_MENU = 'Do you want to proceed?\n❯ 1. Yes\n  2. No';
const PERMISSION_MENU =
  'Claude Code needs permission to run this command\n❯ 1. Yes\n  2. Yes, and bypass permissions\n  3. No';
const TRUST_FOLDER_MENU = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit';

/**
 * Verbatim from the pane that caused the 2026-08-22 codex incident — captured from a
 * live `codex 0.147.0` interactive launch, tmux 200x50. Do not "tidy" this string.
 *
 * It carries codex's `›` selector on the focused option and NOT Claude's `❯`, which
 * is the whole point: the menu test used to require `❯`, so this fell through to the
 * ready test, which already accepted `›`. The spawn path then injected the user's
 * first message plus Enter onto `1. Update now`, codex ran `npm install -g
 * @openai/codex` and exited, and the pane died ~18s after spawn.
 */
const CODEX_UPDATE_MENU = [
  '  ✨ Update available! 0.147.0 -> 0.149.0',
  '',
  '  Release notes: https://github.com/openai/codex/releases/latest',
  '',
  '› 1. Update now (runs `npm install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  '',
  '  Press enter to continue',
].join('\n');

/**
 * Verbatim from a live `codex 0.149.0` pane launched with the update prompt
 * suppressed — the state the same session reaches once it is genuinely ready. Its
 * job here is to prove the widened menu test did not over-block: this pane also
 * leads a line with `›`, and it must still read as ready.
 */
const CODEX_READY_PANE = [
  '╭──────────────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.149.0)                       │',
  '│ model:       gpt-5.6-sol high   /model to change │',
  '│ directory:   ~/.instar/agents/echo               │',
  '│ permissions: YOLO mode                           │',
  '╰──────────────────────────────────────────────────╯',
  '• You have 1 usage limit reset available. Run /usage to use one.',
  '› Ask Codex to do anything',
  '  gpt-5.6-sol high · ~/.instar/agents/echo',
].join('\n');

describe('classifyPaneReadiness — a booting pane is not a ready pane', () => {
  it('REGRESSION: the 2026-07-26 startup banner does NOT read as ready', () => {
    expect(classifyPaneReadiness(BANNER_TAIL)).toBe('not-ready');
  });

  it('the specific prose line that fooled the original probe does NOT read as ready', () => {
    const prose = 'Fable 5 draws down usage faster than Opus 4.8. Run /model and select Fable to use it.';
    expect(prose).toContain('/model');
    expect(isReadyPromptTail(prose)).toBe(false);
  });

  it('REGRESSION: a banner line in interpunct "status-bar shape" does NOT read as ready', () => {
    // These falsified the first fix attempt. A slash command in interpunct shape is
    // a Claude Code BANNER idiom, so shape cannot carry the discrimination.
    expect(isReadyPromptTail('⚠ Fable 5 promotional access ends soon · /model to opt in')).toBe(false);
    expect(isReadyPromptTail('  · /model to switch between Opus and Fable')).toBe(false);
    expect(isReadyPromptTail('⚠ CLAUDE.md is over the limit · /memory to free up context')).toBe(false);
    expect(isReadyPromptTail('+1 more · /status')).toBe(false);
  });

  it('REGRESSION: a soft-wrapped banner putting /model at line start does NOT read as ready', () => {
    // At a fixed pane width an Anthropic copy edit can shift the wrap. The
    // line-start branch that made this match is gone.
    expect(isReadyPromptTail('usage faster than Opus 4.8. Run\n/model and select Fable to use it.')).toBe(false);
  });

  it('an agent echoing a slash command in its own output does NOT read as ready', () => {
    expect(isReadyPromptTail('    /model claude-opus-5')).toBe(false);
    expect(isReadyPromptTail('Run /fast to enable faster output on this plan.')).toBe(false);
  });

  it('empty or whitespace input does NOT read as ready', () => {
    expect(classifyPaneReadiness('')).toBe('not-ready');
    expect(classifyPaneReadiness('   \n  \n')).toBe('not-ready');
  });
});

describe('classifyPaneReadiness — a selection menu is its own state', () => {
  it('REGRESSION: a startup question does NOT read as ready', () => {
    expect(classifyPaneReadiness(PROCEED_MENU)).toBe('menu');
    expect(classifyPaneReadiness(PERMISSION_MENU)).toBe('menu');
    expect(classifyPaneReadiness(TRUST_FOLDER_MENU)).toBe('menu');
  });

  it('a menu is not ready to be typed into', () => {
    // The load-bearing assertion: Enter at a menu SELECTS an option.
    expect(isReadyPromptTail(PROCEED_MENU)).toBe(false);
    expect(isReadyPromptTail(PERMISSION_MENU)).toBe(false);
    expect(isReadyPromptTail(TRUST_FOLDER_MENU)).toBe(false);
  });

  it('`menu` is distinct from `not-ready` — the destructive caller depends on it', () => {
    // The Slack stuck-session path kills on not-ready. If a menu collapsed into
    // not-ready it would destroy a live session for waiting on an answer.
    expect(classifyPaneReadiness(PROCEED_MENU)).not.toBe('not-ready');
    expect(classifyPaneReadiness(BANNER_TAIL)).not.toBe('menu');
  });

  it('ordinary numbered output above the input box is NOT a menu', () => {
    // The other side of the boundary, and the over-block that matters: assistant
    // output routinely lists "1." / "2.", and the input box renders ❯ on its OWN
    // line. Reading that as a menu would stall a genuinely ready session.
    const numberedOutput = 'Here is the plan:\n1. Read the file\n2. Fix the probe\n❯ ';
    expect(tailShowsMenu(numberedOutput)).toBe(false);
    expect(classifyPaneReadiness(numberedOutput)).toBe('ready');
  });

  it('numbered output with no prompt at all is not a menu and not ready', () => {
    const withoutGlyph = 'Here is the plan:\n1. Read the file\n2. Fix the probe';
    expect(tailShowsMenu(withoutGlyph)).toBe(false);
    expect(classifyPaneReadiness(withoutGlyph)).toBe('not-ready');
  });

  it('a single numbered line beside the prompt is NOT a menu', () => {
    expect(tailShowsMenu('❯ 1. only one option')).toBe(false);
    expect(classifyPaneReadiness('❯ 1. only one option')).toBe('ready');
  });
});

describe('classifyPaneReadiness — real ready states still read as ready', () => {
  it('a drawn input box DOES read as ready', () => {
    expect(classifyPaneReadiness(PROMPT_TAIL)).toBe('ready');
  });

  it("codex's prompt character DOES read as ready", () => {
    expect(classifyPaneReadiness(CODEX_PROMPT_TAIL)).toBe('ready');
  });

  it('every permission-mode footer DOES read as ready, not just bypass', () => {
    // `bypass permissions` alone covered ONE of three footers, which is why the
    // "a ready pane always shows ❯" assumption used to be load-bearing.
    expect(classifyPaneReadiness('  ⏵⏵ bypass permissions on (shift+tab to cycle)')).toBe('ready');
    expect(classifyPaneReadiness('  ? for shortcuts')).toBe('ready');
    expect(classifyPaneReadiness('  ⏵⏵ auto-accept edits on')).toBe('ready');
    expect(classifyPaneReadiness('  shift+tab to cycle')).toBe('ready');
  });

  it('none of the footers appear in the boot banner — no false ready', () => {
    for (const marker of ['bypass permissions', '? for shortcuts', 'shift+tab to cycle', 'auto-accept edits']) {
      expect(BANNER_TAIL).not.toContain(marker);
    }
  });

  it('a banner that has since grown an input box DOES read as ready', () => {
    // The banner does not disappear when the box appears — it scrolls above it.
    // Readiness is decided by the positive signal, not by banner absence.
    expect(classifyPaneReadiness(`${BANNER_TAIL}\n${PROMPT_TAIL}`)).toBe('ready');
  });
});

/**
 * Dead-check guard. A probe hardwired to one verdict would satisfy every
 * assertion of that verdict above. Assert the probe actually discriminates across
 * all three states, so this file cannot silently degrade into a test that checks
 * nothing.
 */
describe('the probe discriminates', () => {
  it('produces all three verdicts and is not stuck on one', () => {
    const notReady = [BANNER_TAIL, '', 'Run /model and select Fable to use it.'];
    const menus = [PROCEED_MENU, PERMISSION_MENU, TRUST_FOLDER_MENU];
    const ready = [PROMPT_TAIL, CODEX_PROMPT_TAIL, '  ? for shortcuts', '  ⏵⏵ bypass permissions on'];

    expect(notReady.every(t => classifyPaneReadiness(t) === 'not-ready')).toBe(true);
    expect(menus.every(t => classifyPaneReadiness(t) === 'menu')).toBe(true);
    expect(ready.every(t => classifyPaneReadiness(t) === 'ready')).toBe(true);

    // Every branch non-empty, so none can be vacuously satisfied.
    expect(notReady.length).toBeGreaterThan(0);
    expect(menus.length).toBeGreaterThan(0);
    expect(ready.length).toBeGreaterThan(0);
    expect(new Set([...notReady, ...menus, ...ready].map(classifyPaneReadiness)).size).toBe(3);
  });
});

describe("classifyPaneReadiness — codex's selector is read by BOTH tests", () => {
  it("REGRESSION (2026-08-22): codex's startup update menu is a menu, NOT ready", () => {
    // The defect verbatim: this returned 'ready', instar typed into it, Enter
    // selected `Update now`, codex exited, the session died ~18s after spawn.
    expect(classifyPaneReadiness(CODEX_UPDATE_MENU)).toBe('menu');
    expect(tailShowsMenu(CODEX_UPDATE_MENU)).toBe(true);
  });

  it('the inject path refuses that pane — a menu is never typeable', () => {
    // isReadyPromptTail is what the spawn/inject path consults. `false` here is
    // the property that actually keeps the session alive.
    expect(isReadyPromptTail(CODEX_UPDATE_MENU)).toBe(false);
  });

  it("a codex menu with Claude's glyph is ALSO a menu — neither glyph is special", () => {
    const claudeGlyphVariant = CODEX_UPDATE_MENU.replace('› 1.', '❯ 1.');
    expect(classifyPaneReadiness(claudeGlyphVariant)).toBe('menu');
  });

  it('NOT over-blocked: a genuinely ready codex pane still reads as ready', () => {
    // The widened menu test must not swallow the ready state it sits next to.
    // This pane leads a line with › too — the discriminator is the numbered
    // option lines, not the glyph.
    expect(classifyPaneReadiness(CODEX_READY_PANE)).toBe('ready');
    expect(tailShowsMenu(CODEX_READY_PANE)).toBe(false);
  });

  it("NOT over-blocked: codex's bare prompt is still ready", () => {
    expect(classifyPaneReadiness(CODEX_PROMPT_TAIL)).toBe('ready');
  });

  it("REGRESSION: codex's trust-directory prompt is a menu, not ready", () => {
    // A SECOND real codex startup menu, captured live from codex 0.149 launched
    // in an untrusted directory. Same shape, different prose — which is the
    // point: the discriminator is structure (glyph on a numbered option line,
    // two options), not wording, so a menu nobody characterised in advance is
    // still caught.
    //
    // This one carries the harm the module header names outright. Before the
    // fix it read as ready, so an arriving user message plus Enter would have
    // selected `1. Yes, continue` — answering a TRUST decision on the
    // operator's behalf. Classifying it as a menu is what stops that.
    const trustPrompt = [
      '> You are in /private/tmp',
      '  Do you trust the contents of this directory? Working with untrusted',
      '  contents comes with higher risk of prompt injection.',
      '› 1. Yes, continue',
      '  2. No, quit',
      '  Press enter to continue',
    ].join('\n');
    expect(classifyPaneReadiness(trustPrompt)).toBe('menu');
    expect(isReadyPromptTail(trustPrompt)).toBe(false);
  });

  it('a single ›-led numbered line is not enough to call it a menu', () => {
    // Same guard the ❯ path has: one numbered line is ordinary output.
    expect(tailShowsMenu('› 1. Some output line\n  more prose')).toBe(false);
  });
});
