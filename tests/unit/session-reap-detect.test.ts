/**
 * Session reaping and completion detection — validates that
 * SessionManager properly detects, reaps, and cleans up sessions.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Session reaping and detection', () => {
  const SOURCE_PATH = path.join(process.cwd(), 'src/core/SessionManager.ts');
  let source: string;

  it('source file exists', () => {
    source = fs.readFileSync(SOURCE_PATH, 'utf-8');
    expect(source).toBeTruthy();
  });

  describe('reapCompletedSessions', () => {
    it('skips protected sessions', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      // Protected sessions should be explicitly skipped in reap loop
      expect(source).toContain('protectedSessions.includes(session.tmuxSession)');
    });

    it('marks reaped sessions as completed with endedAt', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      // reapCompletedSessions should set status and endedAt
      expect(source).toContain("session.status = 'completed'");
      expect(source).toContain('session.endedAt');
    });

    it('returns list of reaped session IDs', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      expect(source).toContain('reaped.push(session.id)');
      expect(source).toContain('return reaped');
    });

    it('kills tmux session if still alive after completion detection', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      const reapSection = source.match(/reapCompletedSessions[\s\S]*?(?=\n\s{2}\/\*\*|\n\s{2}async)/);
      const body = reapSection![0];
      // Should check isSessionAlive AND detectCompletion
      expect(body).toContain('isSessionAlive');
      expect(body).toContain('detectCompletion');
      // Should kill if still alive after detection
      expect(body).toContain('kill-session');
    });
  });

  describe('detectCompletion', () => {
    it('checks output for completion patterns', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      // detectCompletion now delegates to the shared matchesAnyPattern helper
      // (DRY for the sync/async twins). The helper scans the session's
      // completion patterns with output.includes — same matching, never drifts.
      expect(source).toContain('this.matchesAnyPattern(output, this.config.completionPatterns)');
      expect(source).toContain('patterns.some((pattern) => output.includes(pattern))');
    });

    it('returns false if no output captured', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      // detectCompletion should handle null output
      expect(source).toContain('if (!output) return false');
    });
  });

  describe('listRunningSessions', () => {
    it('filters sessions by alive status without side effects', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      // listRunningSessions should be a pure filter — no state mutation
      // The monitor tick handles lifecycle transitions
      expect(source).toContain('isSessionAlive');
      expect(source).toContain('sessions.filter');
    });
  });

  describe('startMonitoring', () => {
    it('is idempotent (no double-monitoring)', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      expect(source).toContain('if (this.monitorInterval) return');
    });

    it('stopMonitoring clears interval', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      expect(source).toContain('clearInterval(this.monitorInterval)');
      expect(source).toContain('this.monitorInterval = null');
    });

    it('emits sessionComplete event', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      expect(source).toContain("this.emit('sessionComplete', session)");
    });

    it('session timeout uses capped 20% buffer', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      // Buffer is 20% of duration but capped at 60 minutes
      expect(source).toContain('maxMinutes * 0.2');
      expect(source).toContain('Math.min');
    });

    it('does not kill protected sessions on timeout', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      // The timeout check should exclude protected sessions
      const monitorSection = source.match(/startMonitoring[\s\S]*?stopMonitoring/);
      expect(monitorSection).toBeTruthy();
      const body = monitorSection![0];
      expect(body).toContain('protectedSessions.includes');
    });
  });

  describe('zombie cleanup — process-tree activity check', () => {
    it('checks for active processes before killing', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      // The zombie cleanup must check active processes to determine true idleness
      // before killing. The reaper hot-path now dispatches through the async-aware
      // hasActiveProcessesMaybeAsync (tmux Event-Loop Resilience Increment 1) which
      // routes to the sync hasActiveProcesses or its async twin — behavior identical.
      expect(source).toContain('hasActiveProcessesMaybeAsync(session.tmuxSession)');
    });

    it('only kills when both idle prompt AND no active processes', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      // The idle check combines prompt pattern match with process tree check
      const monitorSection = source.match(/Idle detection[\s\S]*?Session is active/);
      expect(monitorSection).toBeTruthy();
      const body = monitorSection![0];
      expect(body).toContain('hasActiveProcesses');
      expect(body).toContain('idlePromptSince.delete');
    });
  });

  describe('spawnSession', () => {
    it('enforces max sessions limit', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      expect(source).toContain('maxSessions');
      expect(source).toContain('throw new Error');
    });

    it('checks for duplicate tmux sessions', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      expect(source).toContain('tmuxSessionExists');
      expect(source).toContain('already exists');
    });

    it('passes prompt as CLI argument and unsets CLAUDECODE env var', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      // spawnSession routes through buildHeadlessLaunch (provider-portability
      // v1.0.0) which composes the args + env-overrides per framework. The
      // CLAUDECODE clear lives there now, not inline in SessionManager.
      const spawnSection = source.match(/async spawnSession[\s\S]*?this\.state\.saveSession\(session\)/);
      expect(spawnSection).toBeTruthy();
      const body = spawnSection![0];
      expect(body).toContain('buildHeadlessLaunch');
      // The helper itself must set CLAUDECODE='' as an env override.
      const helperSrc = fs.readFileSync(
        path.join(process.cwd(), 'src/core/frameworkSessionLaunch.ts'),
        'utf-8',
      );
      expect(helperSrc).toContain("CLAUDECODE: ''");
    });
  });

  describe('spawnInteractiveSession', () => {
    it('reuses existing tmux session if present', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      // spawnInteractiveSession should check if session exists and reuse
      expect(source).toContain('tmuxSessionExists(tmuxSession)');
      // If session exists, it reuses (returns) instead of creating
      expect(source).toContain('return tmuxSession');
    });

    it('waits for Claude readiness before injecting message', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      expect(source).toContain('waitForClaudeReady');
    });

    it('waitForClaudeReady checks for Claude-specific prompt character only', () => {
      source = fs.readFileSync(SOURCE_PATH, 'utf-8');
      // Should ONLY check for Claude Code's specific prompt character (❯)
      // NOT generic shell prompts (> or $) which cause false positives
      expect(source).toContain("'❯'");
      // Verify it does NOT match generic shell prompts
      const readySection = source.match(/waitForClaudeReady[\s\S]*?return false;\s*\}/);
      expect(readySection).toBeTruthy();
      const body = readySection![0];
      expect(body).not.toContain("'>'");
      expect(body).not.toContain("'$'");
    });
  });
});
