/**
 * Validates the activity-aware kill gate in SessionManager's timeout
 * enforcement. The wall-clock age check must NOT kill a session that is
 * over its age limit but actively producing tool calls / output.
 *
 * Background: pre-fix behavior killed sessions purely on wall-clock age
 * (elapsed > maxDurationMinutes + 20% buffer). Long-running autonomous
 * flows (spec convergence, multi-phase /instar-dev builds, multi-hour
 * driving through several PRs to merge) routinely exceed 240m while
 * producing tool calls every few seconds. The unconditional age-based
 * kill reaped these mid-build, taking their background agents with them.
 *
 * Post-fix behavior: the timeout block re-uses the existing idle-detection
 * helpers (`captureOutput` + `hasActiveProcesses`) as a gate. Only sessions
 * that are over the age limit AND truly idle (at idle prompt + no
 * non-baseline child processes) get killed. Sessions that are over the
 * age limit but still working are deferred until they go idle, at which
 * point the existing idle-detection block catches them.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isAgeGateTrulyIdle } from '../../src/core/SessionManager.js';

const SM_SOURCE = fs.readFileSync(
  path.join(process.cwd(), 'src/core/SessionManager.ts'),
  'utf-8'
);

describe('Activity-aware session-timeout gate', () => {
  it('still references the wall-clock timeout (the kill path itself is preserved)', () => {
    // Wall-clock age is still computed and is still the necessary precondition.
    expect(SM_SOURCE).toContain('maxDurationMinutes');
    expect(SM_SOURCE).toContain('exceeded timeout');
  });

  it('declares the once-per-session "over-age-but-active" log set', () => {
    // Avoids log spam — each session logs the deferred-kill warning once.
    expect(SM_SOURCE).toContain('overAgeButActiveLogged');
    expect(SM_SOURCE).toMatch(/overAgeButActiveLogged\s*=\s*new Set<string>\(\)/);
  });

  it('gates the wall-clock kill on a true-idle check', () => {
    // The kill block must consult both a pane-text idle check (for the
    // idle-prompt) and hasActiveProcesses (for process-tree activity). Either
    // signal of work defers the kill. Since task #77 the text check reads the
    // blank-fill-immune MEANINGFUL tail (captureMeaningfulTail), not raw
    // physical rows — tall-pane trailing blanks no longer blind the gate.
    // The reaper hot-path now awaits the async-aware MaybeAsync dispatchers
    // (tmux Event-Loop Resilience Increment 1) — same capture, never blocks
    // the event loop when the tmux server is slow.
    expect(SM_SOURCE).toMatch(/ageGateOutput\s*=\s*await\s+this\.captureMeaningfulTailMaybeAsync/);
    expect(SM_SOURCE).toMatch(/ageGateHasProcs\s*=\s*await\s+this\.hasActiveProcessesMaybeAsync/);
    expect(SM_SOURCE).toMatch(/IDLE_PROMPT_PATTERNS\.some\(p\s*=>\s*ageGateOutput\.includes\(p\)\)/);
  });

  it('gates the wall-clock kill on transcript activity (MCP/tool blind-spot fix)', () => {
    // 2026-06-13 incident: a session driving the Playwright MCP server was
    // age-killed because between tool calls the pane showed an idle prompt and
    // there was no non-baseline child process (MCP runs out of the pane's
    // process tree). The pane+procs check is blind to that work. The framework
    // transcript (JSONL) grows on every turn/tool event, so a recently-modified
    // transcript is ground-truth liveness. The true-idle determination must
    // therefore ALSO require the transcript to be inactive.
    expect(SM_SOURCE).toMatch(/ageGateTranscriptActive\s*=\s*this\.isTranscriptRecentlyActive/);
    // The idle decision is the extracted pure function fed all three signals
    // (the transcript term is the new one).
    expect(SM_SOURCE).toMatch(/ageGateTrulyIdle\s*=\s*isAgeGateTrulyIdle\(\s*!!ageGateIsIdle,\s*ageGateHasProcs,\s*ageGateTranscriptActive\s*\)/);
    // The probe + window constant must exist (the helper resolves the per-framework
    // transcript and compares its mtime to the activity window).
    expect(SM_SOURCE).toContain('AGE_GATE_TRANSCRIPT_ACTIVE_MS');
    expect(SM_SOURCE).toMatch(/isTranscriptRecentlyActive\s*\(/);
    expect(SM_SOURCE).toContain('resolveFrameworkTranscriptPath');
  });

  it('defers the kill when the session is not truly idle', () => {
    // The deferred-kill branch must log "Deferring kill" (single source of
    // truth for the operator-visible signal) and must NOT enter the
    // kill-session code path.
    expect(SM_SOURCE).toContain('Deferring kill');
    expect(SM_SOURCE).toContain('actively working');
  });

  it('still kills sessions that are over the age limit AND idle', () => {
    // When the activity check confirms idle, the kill path fires. Post
    // UNIFIED-SESSION-LIFECYCLE §P0 the inline kill is replaced by a route
    // through the single ReapAuthority: the warning still names the timeout +
    // idle condition, then funnels through terminateSession('age-limit').
    expect(SM_SOURCE).toContain('exceeded timeout');
    expect(SM_SOURCE).toContain('and is idle');
    expect(SM_SOURCE).toMatch(/terminateSession\(\s*session\.id,\s*'age-limit'/);
  });

  it('does not skip idle-detection when deferring the timeout kill', () => {
    // If the session DOES go idle after the age limit, the idle-detection
    // block below the timeout block must still catch it. The code falls
    // through (no `continue`) on the deferred path.
    const block = SM_SOURCE.match(/Deferring kill[\s\S]*?\}\s*else\s*\{/);
    expect(block).toBeTruthy();
    if (block) {
      // No `continue;` between the defer log and the closing brace.
      expect(block[0]).not.toMatch(/\bcontinue;\s*$/m);
    }
  });
});

/**
 * Decision-boundary tests for isAgeGateTrulyIdle — the pure idle decision the
 * age gate uses. These REPRODUCE the 2026-06-13 failure at the decision level
 * (Bug-Fix Evidence Bar): the inputs that wrongly killed an active session
 * (idle pane + no child proc + a GROWING transcript) must now resolve to
 * "not truly idle" ⇒ the kill is deferred. Covers both sides of all three
 * boundaries (all 8 combinations).
 */
describe('isAgeGateTrulyIdle (age-kill decision boundary)', () => {
  it('REPRODUCES the incident: idle pane + no child proc + ACTIVE transcript ⇒ NOT killed', () => {
    // Pre-fix this exact combination returned true (killed). It must now be false.
    expect(isAgeGateTrulyIdle(true, false, true)).toBe(false);
  });

  it('genuine zombie: idle pane + no child proc + quiet transcript ⇒ still killed (no regression)', () => {
    expect(isAgeGateTrulyIdle(true, false, false)).toBe(true);
  });

  it('a live child process defers the kill regardless of transcript', () => {
    expect(isAgeGateTrulyIdle(true, true, false)).toBe(false);
    expect(isAgeGateTrulyIdle(true, true, true)).toBe(false);
  });

  it('a non-idle pane is never truly-idle regardless of the other signals', () => {
    expect(isAgeGateTrulyIdle(false, false, false)).toBe(false);
    expect(isAgeGateTrulyIdle(false, false, true)).toBe(false);
    expect(isAgeGateTrulyIdle(false, true, false)).toBe(false);
    expect(isAgeGateTrulyIdle(false, true, true)).toBe(false);
  });

  it('is true ONLY when all three say idle (idle pane, no proc, quiet transcript)', () => {
    // Exhaustive: exactly one of the 8 combinations is true.
    let trueCount = 0;
    for (const idle of [true, false]) {
      for (const procs of [true, false]) {
        for (const transcript of [true, false]) {
          if (isAgeGateTrulyIdle(idle, procs, transcript)) trueCount++;
        }
      }
    }
    expect(trueCount).toBe(1);
  });
});
