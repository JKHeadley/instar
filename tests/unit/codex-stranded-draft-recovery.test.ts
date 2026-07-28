/**
 * Behavioral tests for codex stranded-draft recovery.
 *
 * Bug (live repro 2026-05-31): a user message sent to a BUSY codex autonomous
 * session was typed into codex's input but never submitted — codex holds a
 * mid-turn delivery as an unsubmitted DRAFT and (unlike Claude Code) does NOT
 * auto-submit it when the turn ends. The message sat stranded at the `›` prompt
 * for 3h. The stuck-input recovery surfaces were codex-blind:
 *   - isMarkerStuckAtPrompt only recognised Claude's `❯` prompt char.
 *   - StuckInputSentinel's generic prompt-text reader can't distinguish a real
 *     codex draft from the dim placeholder hint codex renders at an empty `›`.
 *
 * The fix:
 *   - isMarkerStuckAtPrompt recognises BOTH `❯` and codex's `›` (U+203A).
 *   - SessionManager records a per-session stranded-draft MARKER (the injected
 *     text) for codex injections; the sentinel matches that marker (immune to
 *     the placeholder, which never equals what we injected) and fires Enter once
 *     codex goes idle.
 *
 * These tests construct a real SessionManager and exercise the pure-ish helpers
 * + the marker map directly (no tmux required).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

const CODEX_PROMPT = '›'; // ›
const CLAUDE_PROMPT = '❯'; // ❯

function codexDraftPane(text: string): string {
  // Mirrors a live codex idle pane with a real draft in the input box.
  return [
    '─ Worked for 1m 20s ────────',
    '',
    `${CODEX_PROMPT} ${text}`,
    '',
    '  gpt-5.5 medium · ~/Documents/Projects/instar-codey                 Goal achieved (20m)',
  ].join('\n');
}

// A live codex EMPTY input pane: the placeholder hint "Explain this codebase"
// is rendered after `›` and is byte-identical to real input once color is
// stripped. The marker-based check MUST NOT treat this as stuck input.
const CODEX_EMPTY_PANE = codexDraftPane('Explain this codebase');

// A busy codex pane shares Claude's "esc to interrupt" footer hint.
function codexWorkingPane(text: string): string {
  return [
    `${CODEX_PROMPT} ${text}`,
    '',
    '  Working (37m 24s • esc to interrupt)',
  ].join('\n');
}

// Mirrors a live Gemini CLI idle pane: the input is rendered INSIDE a rounded
// border and the active input line is "│ * <text>" — there is NO ❯/› prompt char.
function geminiBoxPane(text: string): string {
  return [
    '✦ I have completed the task and reported back. I am awaiting the next task.',
    ' 2 GEMINI.md files                                              YOLO mode',
    '╭─────────────────────────────────────────────────────────────╮',
    `│ * ${text}`,
    '╰─────────────────────────────────────────────────────────────╯',
    ' ~/.instar/agents/gemini      no sandbox      gemini-2.5-flash-lite /model',
  ].join('\n');
}

// Gemini's EMPTY input box renders the placeholder "Type your message or @path…".
// A real injected marker never equals it, so an idle empty box is never "stuck".
const GEMINI_EMPTY_PANE = geminiBoxPane('  Type your message or @path/to/file');

describe('SessionManager.extractInjectionMarker', () => {
  it('returns the first 40 chars of the (left-trimmed) text', () => {
    const text = 'hello there this is a reasonably long user message that exceeds forty chars';
    expect(SessionManager.extractInjectionMarker(text)).toBe(text.slice(0, 40).trim());
  });

  it('strips leading whitespace/newlines before slicing', () => {
    expect(SessionManager.extractInjectionMarker('   \n  hello from the user about the build')).toBe(
      'hello from the user about the build',
    );
  });

  it('returns null when the marker would be shorter than 8 chars', () => {
    expect(SessionManager.extractInjectionMarker('hi')).toBeNull();
    expect(SessionManager.extractInjectionMarker('   ')).toBeNull();
  });
});

describe('SessionManager.isMarkerStuckAtPrompt — codex awareness', () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-codex-draft-'));
    const state = new StateManager(path.join(tmpDir, 'state'));
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
    };
    manager = new SessionManager(config, state);
  });

  it('matches a marker stuck at the codex `›` prompt', () => {
    const text = '[telegram:1052] If we continue to run into version issues';
    const marker = SessionManager.extractInjectionMarker(text)!;
    expect(manager.isMarkerStuckAtPrompt(codexDraftPane(text), marker)).toBe(true);
  });

  it('still matches a marker stuck at the Claude `❯` prompt (no regression)', () => {
    const text = '[telegram:7195] hello there friend about the build';
    const marker = SessionManager.extractInjectionMarker(text)!;
    const pane = `${CLAUDE_PROMPT} ${text}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`;
    expect(manager.isMarkerStuckAtPrompt(pane, marker)).toBe(true);
  });

  it('does NOT match the dim codex placeholder at an EMPTY prompt (placeholder immunity)', () => {
    // This is the core safety property: a real injected message's marker never
    // equals codex's "Explain this codebase" placeholder, so an idle EMPTY codex
    // session is never seen as stuck → no false Enter, no log spam.
    const injected = '[telegram:1052] If we continue to run into version issues';
    const marker = SessionManager.extractInjectionMarker(injected)!;
    expect(manager.isMarkerStuckAtPrompt(CODEX_EMPTY_PANE, marker)).toBe(false);
  });

  it('does not match when the marker is simply absent from the pane', () => {
    const marker = SessionManager.extractInjectionMarker('some message that was already submitted')!;
    expect(manager.isMarkerStuckAtPrompt(codexDraftPane('a totally different draft now'), marker)).toBe(false);
  });
});

describe('SessionManager.isMarkerStuckAtPrompt — Gemini awareness', () => {
  // Gemini CLI has no ❯/› prompt char — its input sits in a "│ * <text>" box line.
  // Without recognizing that, a Telegram message injected into a Gemini session
  // was never detected as stuck, so verifyInjection's Enter-recovery never fired
  // and forwarded prompts stalled in the input box (the recurring mentee-layer
  // auto-submit friction). The marker-in-line gate keeps it from false-firing.
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-gemini-draft-'));
    const state = new StateManager(path.join(tmpDir, 'state'));
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
    };
    manager = new SessionManager(config, state);
  });

  it('matches a marker stuck in the Gemini "│ *" input box', () => {
    const text = '[telegram:1] [Long message saved to /Users/justin/.instar/agents/gemini/.instar/telegram-inbound/msg-1.txt — read it]';
    const marker = SessionManager.extractInjectionMarker(text)!;
    expect(manager.isMarkerStuckAtPrompt(geminiBoxPane(text), marker)).toBe(true);
  });

  it('does NOT match the empty Gemini box placeholder (placeholder immunity)', () => {
    const injected = '[telegram:1] [Long message saved to /Users/justin/.instar/agents/gemini/.instar/telegram-inbound/msg-1.txt — read it]';
    const marker = SessionManager.extractInjectionMarker(injected)!;
    expect(manager.isMarkerStuckAtPrompt(GEMINI_EMPTY_PANE, marker)).toBe(false);
  });

  it('still matches Claude `❯` and codex `›` prompts (no regression)', () => {
    const text = '[telegram:7195] hello there friend about the build today';
    const marker = SessionManager.extractInjectionMarker(text)!;
    expect(manager.isMarkerStuckAtPrompt(`${CLAUDE_PROMPT} ${text}`, marker)).toBe(true);
    expect(manager.isMarkerStuckAtPrompt(`${CODEX_PROMPT} ${text}`, marker)).toBe(true);
  });

  it('does not false-fire on a "│ *" line that lacks the injected marker', () => {
    const pane = GEMINI_EMPTY_PANE + '\n│ * an unrelated bulleted output line from the agent';
    const marker = SessionManager.extractInjectionMarker('[telegram:99] a message that was already submitted and is gone')!;
    expect(manager.isMarkerStuckAtPrompt(pane, marker)).toBe(false);
  });
});

describe('SessionManager — stranded-draft marker map', () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-codex-draft-map-'));
    const state = new StateManager(path.join(tmpDir, 'state'));
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
    };
    manager = new SessionManager(config, state);
  });

  it('records and reads back a marker for a codex session', () => {
    manager.recordStrandedDraftMarker('codey-A', '[telegram:1052] hello about the build', 'codex-cli');
    const rec = manager.getStrandedDraftMarker('codey-A');
    expect(rec?.framework).toBe('codex-cli');
    expect(rec?.marker).toBe('[telegram:1052] hello about the build'.slice(0, 40).trim());
    expect(manager.strandedDraftMarkerSessions()).toEqual(['codey-A']);
  });

  it('no-ops when the text is too short to be a reliable marker', () => {
    manager.recordStrandedDraftMarker('codey-A', 'hi', 'codex-cli');
    expect(manager.getStrandedDraftMarker('codey-A')).toBeUndefined();
    expect(manager.strandedDraftMarkerSessions()).toEqual([]);
  });

  it('a newer injection supersedes an older stuck marker for the same session', () => {
    manager.recordStrandedDraftMarker('codey-A', 'first message that stranded here', 'codex-cli');
    manager.recordStrandedDraftMarker('codey-A', 'second newer message replacing it', 'codex-cli');
    expect(manager.getStrandedDraftMarker('codey-A')?.marker).toBe('second newer message replacing it'.slice(0, 40).trim());
  });

  it('clears a marker on confirmed submit', () => {
    manager.recordStrandedDraftMarker('codey-A', 'a stranded codex message here', 'codex-cli');
    manager.clearStrandedDraftMarker('codey-A');
    expect(manager.getStrandedDraftMarker('codey-A')).toBeUndefined();
    expect(manager.strandedDraftMarkerSessions()).toEqual([]);
  });
});
