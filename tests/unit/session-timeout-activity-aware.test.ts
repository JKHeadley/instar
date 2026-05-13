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
    // The kill block must consult both captureOutput (for idle-prompt) and
    // hasActiveProcesses (for process-tree activity). Either signal of work
    // defers the kill.
    expect(SM_SOURCE).toMatch(/ageGateOutput\s*=\s*this\.captureOutput/);
    expect(SM_SOURCE).toMatch(/ageGateHasProcs\s*=\s*this\.hasActiveProcesses/);
    expect(SM_SOURCE).toMatch(/IDLE_PROMPT_PATTERNS\.some\(p\s*=>\s*ageGateOutput\.includes\(p\)\)/);
  });

  it('defers the kill when the session is not truly idle', () => {
    // The deferred-kill branch must log "Deferring kill" (single source of
    // truth for the operator-visible signal) and must NOT enter the
    // kill-session code path.
    expect(SM_SOURCE).toContain('Deferring kill');
    expect(SM_SOURCE).toContain('actively working');
  });

  it('still kills sessions that are over the age limit AND idle', () => {
    // When the activity check confirms idle, the original kill path fires.
    // The "and is idle" suffix on the warning message is the contract.
    expect(SM_SOURCE).toContain('exceeded timeout');
    expect(SM_SOURCE).toContain('and is idle. Killing');
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
