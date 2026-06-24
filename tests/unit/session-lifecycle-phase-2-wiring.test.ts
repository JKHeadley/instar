/**
 * Phase-2 routing contracts — UNIFIED-SESSION-LIFECYCLE per-killer guarantees.
 *
 * Each killer in Phase 2 (#5 watchdog, #6 orphan, #8 SessionRecovery, #9 wake-
 * reaper) must funnel its kill through `SessionManager.terminateSession` so the
 * single ReapAuthority enforces protected/lease/KEEP-guard + emits the
 * sessionReaped event used by the reap-log + notice. These source assertions are
 * the structural ratchet — a future commit cannot quietly drop the funnel.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const watchdogSource = fs.readFileSync(
  path.join(process.cwd(), 'src/monitoring/SessionWatchdog.ts'),
  'utf-8',
);
const orphanSource = fs.readFileSync(
  path.join(process.cwd(), 'src/monitoring/OrphanProcessReaper.ts'),
  'utf-8',
);
const sessionManagerSource = fs.readFileSync(
  path.join(process.cwd(), 'src/core/SessionManager.ts'),
  'utf-8',
);
const recoverySource = fs.readFileSync(
  path.join(process.cwd(), 'src/monitoring/SessionRecovery.ts'),
  'utf-8',
);
const serverSource = fs.readFileSync(
  path.join(process.cwd(), 'src/commands/server.ts'),
  'utf-8',
);
const schedulerSource = fs.readFileSync(
  path.join(process.cwd(), 'src/scheduler/JobScheduler.ts'),
  'utf-8',
);
const sleepWakeSource = fs.readFileSync(
  path.join(process.cwd(), 'src/core/SleepWakeDetector.ts'),
  'utf-8',
);

describe('Phase 2 — per-killer routing contracts', () => {
  describe('#5 SessionWatchdog → ReapAuthority', () => {
    it('the final escalation level routes through terminateSession with terminal disposition', () => {
      // Find the KillSession case body (closing brace marks the end).
      const block = watchdogSource.match(/case EscalationLevel\.KillSession:\s*\{[\s\S]*?\n\s{6}\}/);
      expect(block, 'KillSession case must be a block').toBeTruthy();
      const body = block![0];
      expect(body).toMatch(/this\.sessionManager\.terminateSession\(\s*sess\.id\s*,\s*'watchdog-stuck'/);
      expect(body).toContain("disposition: 'terminal'");
      expect(body).toContain("finalStatus: 'killed'");
    });

    it('does NOT call the raw tmux kill-session directly from the watchdog', () => {
      expect(watchdogSource).not.toMatch(/tmuxPath.*kill-session/);
    });

    it('a KEEP-refused kill stands down (no re-escalation against a guarded session)', () => {
      // The skipped-branch must clear escalationState (don't keep hammering a
      // guarded session every tick — the §P5 backstop owns that escalation).
      const block = watchdogSource.match(/case EscalationLevel\.KillSession:\s*\{[\s\S]*?\n\s{6}\}/);
      expect(block).toBeTruthy();
      const body = block![0];
      expect(body).toMatch(/!result\.terminated|else \{/);
      expect(body).toMatch(/escalationState\.delete\(tmuxSession\)/);
      // And the log line names the skipped reason explicitly so an operator can
      // see which guard kept the session.
      expect(body).toContain('kill refused');
    });
  });

  describe('#6 OrphanProcessReaper → exact-id + work-check + ReapAuthority', () => {
    it('classifies by EXACT-id membership in instar-known sessions (no project-prefix substring match)', () => {
      // The legacy prefix-startsWith match is gone.
      expect(orphanSource).not.toMatch(/tmuxSession\.startsWith\(this\.projectPrefix\)/);
      // The new gate is exact-id membership in SessionManager.listKnownTmuxSessions().
      expect(orphanSource).toContain('knownInstarSessions.has(tmuxSession)');
      // And SessionManager exposes the corresponding lookup.
      expect(sessionManagerSource).toContain('listKnownTmuxSessions()');
    });

    it('60-min age gate is NECESSARY but NOT SUFFICIENT — defers when the process has active children', () => {
      // The work-check (pgrep -P → non-empty) must veto the reap before any kill.
      expect(orphanSource).toContain('processHasActiveChildren(orphan.pid)');
      expect(orphanSource).toMatch(/pgrep\s+-P\s+\$\{pid\}/);
      // And the deferred path logs a Kept-not-Killed action so it surfaces.
      expect(orphanSource).toContain('Kept orphan PID');
      expect(orphanSource).toContain('work check vetoed reap');
    });

    it('routes through terminateSession when the orphan tmuxSession matches a currently-tracked session', () => {
      expect(orphanSource).toMatch(/terminateSession\(\s*trackedNow\.id\s*,\s*'orphan-reap'/);
      expect(orphanSource).toContain("disposition: 'terminal'");
      expect(orphanSource).toContain("finalStatus: 'killed'");
    });
  });

  describe('#8 SessionRecovery → P1/P2 cross-check + recovery-bounce disposition', () => {
    it('all kill-to-respawn paths go through killForRecovery (single shared chokepoint)', () => {
      // Direct deps.killSession calls must only appear inside the helper itself.
      const directCalls = recoverySource.match(/this\.deps\.killSession\(/g) ?? [];
      // Exactly one — the helper.
      expect(directCalls.length).toBe(1);
      // And the helper performs the P1/P2 cross-check first.
      const helper = recoverySource.match(/private async killForRecovery[\s\S]*?\n {2}\}/);
      expect(helper).toBeTruthy();
      expect(helper![0]).toContain('hasActiveProcesses');
      expect(helper![0]).toContain('deferred-still-working');
    });

    it('the work-check vetoes the kill (the JSONL reading is unreliable while the process produces work)', () => {
      // Every recovery method bails with a deferred-still-working result when
      // the cross-check fires.
      const deferredReturns = recoverySource.match(/deferred-still-working/g) ?? [];
      // The helper returns it; each of the 4 recovery methods checks it.
      expect(deferredReturns.length).toBeGreaterThanOrEqual(5);
    });

    it('the wiring routes the kill through terminateSession with recovery-bounce disposition + bypassRecoveryFlag', () => {
      // server.ts wires the dep.killSession to terminateSession with the right opts.
      expect(serverSource).toMatch(/terminateSession\([^)]*'session-recovery'/);
      expect(serverSource).toContain("disposition: 'recovery-bounce'");
      expect(serverSource).toContain('bypassRecoveryFlag: true');
    });

    it('terminateSession respects bypassRecoveryFlag for the recovery-in-flight guard ONLY', () => {
      // The bypass is scoped to the recovery-in-flight reason, not the whole guard.
      // It is now applied INSIDE ReapGuard.blockedReason via a `bypassedReasons`
      // list (the post-transfer-closeout-correctness refactor), so the guard keeps
      // evaluating DOWN to the next non-bypassed keep-reason instead of a single-eval
      // `blocked?.reason === 'recovery-in-flight'` short-circuit that masked
      // lower-priority guards.
      expect(sessionManagerSource).toContain('bypassRecoveryFlag');
      expect(sessionManagerSource).toMatch(/bypassedReasons\.push\(\s*'recovery-in-flight'\s*\)/);
    });
  });

  describe('#9 wake-reaper → P1/P2 + cumulative sleep + ReapAuthority', () => {
    it('reapStuckRuns is async and uses CUMULATIVE sleep (SE-8), not the single last event', () => {
      expect(schedulerSource).toMatch(/async reapStuckRuns/);
      // The cumulative-sleep provider is consulted with [runStartMs, now).
      expect(schedulerSource).toMatch(/cumulativeSleepProvider\?\.\(runStartMs, now\)/);
      // Effective elapsed = elapsed − cumulative sleep.
      expect(schedulerSource).toMatch(/effectiveElapsed\s*=\s*elapsedMs\s*-\s*cumulativeSleepMs/);
    });

    it('the P1/P2 gate keeps a session whose process is still producing work — regardless of clock', () => {
      // Before any kill, hasActiveProcesses is consulted; on true the reaper
      // keeps the session (the spec: "a progressing process is KEEP regardless
      // of clock").
      expect(schedulerSource).toMatch(/sessionManager\.hasActiveProcesses\?\.\(sessionName\)/);
      expect(schedulerSource).toMatch(/P1\/P2 work-check found active children/);
    });

    it('routes the kill through terminateSession with disposition:terminal when tracked', () => {
      expect(schedulerSource).toMatch(/terminateSession\?\.\(\s*tracked\.id\s*,\s*'wake-reaper'/);
      expect(schedulerSource).toContain("disposition: 'terminal'");
      expect(schedulerSource).toContain("finalStatus: 'killed'");
    });

    it('SleepWakeDetector exposes the cumulative-sleep accessor + server wires it', () => {
      expect(sleepWakeSource).toMatch(/getCumulativeSleepMsBetween\(/);
      expect(serverSource).toMatch(/setCumulativeSleepProvider/);
    });
  });
});
