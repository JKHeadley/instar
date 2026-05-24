/**
 * PresenceProxy Codex-blindness regression (2026-05-23 live-test harness).
 *
 * The morning stuck-session incident had TWO blind spots in PresenceProxy's
 * own detection (separate from the StallTriageNurse activity signal):
 *
 *   1. The "agent finished → stop heartbeats" early-exit used detectSessionIdle,
 *      whose IDLE_PROMPT_PATTERNS are Claude-shaped (❯, >, $, "bypass
 *      permissions"). A Codex idle pane (model-name status line + › composer)
 *      matches NONE of them, so the finished-check never fired on Codex and
 *      "still working" heartbeats flooded forever.
 *
 *   2. The tier-3 stall assessment fell back to assessment='working' whenever
 *      the LLM call failed or returned an unparseable class. A stuck Codex
 *      session whose pane the LLM couldn't read was therefore assumed active
 *      forever and never escalated to the user.
 *
 * The fix threads the agent's resolved framework into two framework-aware pure
 * functions: detectSessionFinished (uses !looksActivelyWorking for Codex,
 * because the › composer renders in BOTH idle and working panes so prompt
 * presence is not a valid discriminator) and deterministicStallAssessment
 * (falls back to the deterministic active-work signal instead of "working").
 */

import { describe, it, expect } from 'vitest';
import {
  detectSessionFinished,
  deterministicStallAssessment,
  detectSessionIdle,
} from '../../src/monitoring/PresenceProxy.js';

// ── Realistic captured panes ────────────────────────────────────────────────

// Codex sitting idle, waiting for input. The model-name status line and the
// placeholder prompt are ALWAYS present at idle — they must NOT read as work.
const CODEX_IDLE = `⏺ All set — the scheduler is running with 27 jobs.

› Find and fix a bug in @filename

  gpt-5.3-codex medium · ~/Documents/Projects/instar-codey`;

// Codex actively generating — the canonical working status line.
const CODEX_WORKING = `• Ran sed -n '1,40p' src/commands/server.ts
• Working (12s • esc to interrupt)

  gpt-5.3-codex medium · ~/Documents/Projects/instar-codey`;

// Codex session frozen mid-task: alive, no child processes, no work signal,
// not at a clean idle prompt either — the shape that hung this morning.
const CODEX_STUCK = `⏺ Let me check the scheduler configuration before I make changes.

[no further output for several minutes]`;

// Claude panes for back-compat assertions.
const CLAUDE_IDLE = `⏺ Analysis complete.

❯
  ⏵⏵ bypass permissions on (shift+tab to cycle)`;
const CLAUDE_WORKING = `⏺ Bash(npm test)
  ⎿ Running… esc to interrupt`;

describe('detectSessionFinished — framework-aware idle detection', () => {
  it('codex idle pane reads as finished (the spot detectSessionIdle missed)', () => {
    // Lock the regression: the old Claude-only detector is blind here…
    expect(detectSessionIdle(CODEX_IDLE)).toBe(false);
    // …but the framework-aware detector correctly sees a finished Codex pane.
    expect(detectSessionFinished(CODEX_IDLE, 'codex-cli')).toBe(true);
  });

  it('codex working pane does NOT read as finished', () => {
    expect(detectSessionFinished(CODEX_WORKING, 'codex-cli')).toBe(false);
  });

  it('claude panes keep prompt-pattern behavior (back-compat)', () => {
    expect(detectSessionFinished(CLAUDE_IDLE, 'claude-code')).toBe(true);
    expect(detectSessionFinished(CLAUDE_WORKING, 'claude-code')).toBe(false);
  });

  it('absent framework defaults to claude-code behavior', () => {
    expect(detectSessionFinished(CLAUDE_IDLE, undefined)).toBe(true);
    expect(detectSessionFinished(CODEX_IDLE, undefined)).toBe(false); // claude blindness preserved when framework unknown
  });

  it('empty snapshot is never finished', () => {
    expect(detectSessionFinished('', 'codex-cli')).toBe(false);
    expect(detectSessionFinished('', 'claude-code')).toBe(false);
  });
});

describe('deterministicStallAssessment — LLM-unavailable fallback', () => {
  it('codex working pane → working', () => {
    expect(deterministicStallAssessment(CODEX_WORKING, 'codex-cli')).toBe('working');
  });

  it('codex stuck pane → stalled (was "working" forever before the fix)', () => {
    expect(deterministicStallAssessment(CODEX_STUCK, 'codex-cli')).toBe('stalled');
  });

  it('codex idle pane → stalled (no active-work signal)', () => {
    expect(deterministicStallAssessment(CODEX_IDLE, 'codex-cli')).toBe('stalled');
  });

  it('null snapshot → stalled (cannot prove active work)', () => {
    expect(deterministicStallAssessment(null, 'codex-cli')).toBe('stalled');
  });

  it('claude working pane → working; claude stuck → stalled', () => {
    expect(deterministicStallAssessment(CLAUDE_WORKING, 'claude-code')).toBe('working');
    expect(deterministicStallAssessment('frozen, no spinner', 'claude-code')).toBe('stalled');
  });
});
