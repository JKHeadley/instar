/**
 * Codex CLI activity-signal correctness — derived from LIVE gpt-5.3-codex
 * panes captured during the 2026-05-23 live-test harness.
 *
 * The stuck-session incident: the original Codex signal matched the bare
 * word "codex", which is ALWAYS present in the idle status line
 * ("gpt-5.3-codex medium · <dir>"), so every idle Codex session read as
 * "actively working". And its escapeToInterrupt pattern required a
 * "press/hit" prefix that Codex never renders. The net effect: the
 * activity detector could not distinguish idle / working / stuck on Codex,
 * which let the presence proxy default to "still working" forever.
 */

import { describe, it, expect } from 'vitest';
import { looksActivelyWorking } from '../../src/monitoring/sentinelWiring.js';

// ── Real captured panes (verbatim, trimmed) ───────────────────────────

// IDLE: session sitting at its prompt, waiting for the user. The model
// name + placeholder prompt are the only Codex-ish text present.
const CODEX_IDLE = `
────────────────────────────────────────────────────────────────────────
› Find and fix a bug in @filename

  gpt-5.3-codex medium · ~/Documents/Projects/instar-codey
`;

// WORKING: mid-task. The canonical "Working (Ns • esc to interrupt)" line
// is present, along with action bullets. Note the idle composer line is
// ALSO present at the bottom (it always is) — the detector must still
// return true because the work indicators are present.
const CODEX_WORKING = `
› [telegram:51 "Test" from Justin] Please list the files in the project.
• I'll acknowledge on Telegram, then check the directory and send the list back.
• Working (11s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close
› Find and fix a bug in @filename
  gpt-5.3-codex medium · ~/Documents/Projects/instar-codey
`;

const CODEX_WORKING_RAN_BULLET = `
• Ran if [ -d src ]; then ls -1 src; else echo none; fi
  └ none
────────────────────────────────────────────────────────────────────────
• Working (18s • esc to interrupt)
› Find and fix a bug in @filename
  gpt-5.3-codex medium · ~/Documents/Projects/instar-codey
`;

describe('looksActivelyWorking — codex-cli (empirical)', () => {
  it('returns FALSE for an idle Codex pane (model name is NOT a work signal)', () => {
    // The exact false positive that hid stuck sessions: the idle pane
    // contains "gpt-5.3-codex" but the session is NOT working.
    expect(looksActivelyWorking(CODEX_IDLE, 'codex-cli')).toBe(false);
  });

  it('returns TRUE for a working Codex pane (Working (Ns • esc to interrupt))', () => {
    expect(looksActivelyWorking(CODEX_WORKING, 'codex-cli')).toBe(true);
  });

  it('returns TRUE for a working Codex pane with a "• Ran" action bullet', () => {
    expect(looksActivelyWorking(CODEX_WORKING_RAN_BULLET, 'codex-cli')).toBe(true);
  });

  it('matches the bare "esc to interrupt" Codex renders (no press/hit prefix)', () => {
    expect(looksActivelyWorking('• Working (3s • esc to interrupt)', 'codex-cli')).toBe(true);
  });

  it('keeps detecting the live status after Codex switches to minutes', () => {
    expect(looksActivelyWorking('• Working (2m 17s • esc to interrupt)', 'codex-cli')).toBe(true);
  });

  it('does NOT treat the model-name status line alone as working', () => {
    expect(looksActivelyWorking('gpt-5.3-codex medium · ~/proj', 'codex-cli')).toBe(false);
  });

  it('does NOT treat the placeholder prompt as working', () => {
    expect(looksActivelyWorking('› Find and fix a bug in @filename', 'codex-cli')).toBe(false);
  });

  it('returns false for empty output', () => {
    expect(looksActivelyWorking('', 'codex-cli')).toBe(false);
  });

  it('still detects the dot-spinner if present', () => {
    expect(looksActivelyWorking('⠹ thinking', 'codex-cli')).toBe(true);
  });
});

// Guard the Claude path didn't regress.
describe('looksActivelyWorking — claude-code (regression guard)', () => {
  it('detects Claude tool calls + esc to interrupt', () => {
    expect(looksActivelyWorking('● Bash(ls)\n  esc to interrupt', 'claude-code')).toBe(true);
  });
  it('idle Claude prompt is not working', () => {
    expect(looksActivelyWorking('Human: \nAssistant:', 'claude-code')).toBe(false);
  });
});
