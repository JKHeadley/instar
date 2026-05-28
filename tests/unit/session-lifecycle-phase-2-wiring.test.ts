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
});
