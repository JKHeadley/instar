import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateManager } from '../../src/core/StateManager.js';

/**
 * Security tests for Instar infrastructure.
 * Validates defenses against command injection, path traversal,
 * and other common attack vectors.
 */
describe('Security', () => {
  let tmpDir: string;
  let state: StateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-security-'));
    // Create required directory structure
    fs.mkdirSync(path.join(tmpDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    state = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Path traversal prevention', () => {
    it('rejects session IDs with path separators', () => {
      expect(() => state.getSession('../../../etc/passwd')).toThrow('Invalid sessionId');
    });

    it('rejects session IDs with dots', () => {
      expect(() => state.getSession('..hack')).toThrow('Invalid sessionId');
    });

    it('rejects job slugs with path separators', () => {
      expect(() => state.getJobState('../../evil')).toThrow('Invalid job slug');
    });

    it('rejects state keys with traversal characters', () => {
      expect(() => state.get('../../../etc/shadow')).toThrow('Invalid state key');
    });

    it('rejects state set with traversal characters', () => {
      expect(() => state.set('../../../tmp/hack', { evil: true })).toThrow('Invalid state key');
    });

    it('allows valid session IDs', () => {
      // Should not throw — valid characters
      expect(state.getSession('abc123-def456')).toBeNull();
    });

    it('allows valid job slugs with hyphens and underscores', () => {
      expect(state.getJobState('health-check')).toBeNull();
      expect(state.getJobState('reflection_trigger')).toBeNull();
    });

    it('allows valid state keys', () => {
      state.set('job-topic-mappings', { test: true });
      expect(state.get('job-topic-mappings')).toEqual({ test: true });
    });
  });

  describe('Session name sanitization', () => {
    it('source file sanitizes session names', () => {
      // Verify the sanitizeSessionName function exists and is used
      const smSource = fs.readFileSync(
        path.join(process.cwd(), 'src/core/SessionManager.ts'),
        'utf-8'
      );
      expect(smSource).toContain('sanitizeSessionName');
      expect(smSource).toContain('replace(/[^a-zA-Z0-9_-]/g');
    });
  });

  describe('Command injection prevention', () => {
    it('uses execFileSync instead of execSync for tmux commands', () => {
      const smSource = fs.readFileSync(
        path.join(process.cwd(), 'src/core/SessionManager.ts'),
        'utf-8'
      );
      // All tmux calls should use execFileSync (argument arrays)
      // not execSync with string concatenation
      expect(smSource).toContain('execFileSync');

      // Count occurrences of unsafe execSync (should only appear in import)
      const execSyncCalls = (smSource.match(/\bexecSync\(/g) || []).length;
      // execSync should NOT be called anywhere (only imported but unused or in import line)
      expect(execSyncCalls).toBe(0);
    });
  });

  describe('Timing-safe auth', () => {
    it('uses timingSafeEqual for token comparison', () => {
      const mwSource = fs.readFileSync(
        path.join(process.cwd(), 'src/server/middleware.ts'),
        'utf-8'
      );
      expect(mwSource).toContain('timingSafeEqual');
      // Should NOT have direct string comparison for auth
      expect(mwSource).not.toContain('token !== authToken');
    });
  });

  describe('Corrupted file handling', () => {
    it('handles corrupted session JSON gracefully', () => {
      const sessionFile = path.join(tmpDir, 'state', 'sessions', 'corrupt-session.json');
      fs.writeFileSync(sessionFile, '{invalid json!!!');
      expect(state.getSession('corrupt-session')).toBeNull();
    });

    it('handles corrupted job state JSON gracefully', () => {
      const jobFile = path.join(tmpDir, 'state', 'jobs', 'broken-job.json');
      fs.writeFileSync(jobFile, 'not json at all');
      expect(state.getJobState('broken-job')).toBeNull();
    });

    it('handles corrupted generic state JSON gracefully', () => {
      const stateFile = path.join(tmpDir, 'state', 'bad-state.json');
      fs.writeFileSync(stateFile, '');
      expect(state.get('bad-state')).toBeNull();
    });

    it('skips corrupted files in session listing', () => {
      // Write one valid and one corrupt file
      fs.writeFileSync(
        path.join(tmpDir, 'state', 'sessions', 'good-session.json'),
        JSON.stringify({ id: 'good-session', name: 'test', status: 'running', tmuxSession: 'test' })
      );
      fs.writeFileSync(
        path.join(tmpDir, 'state', 'sessions', 'bad-session.json'),
        'corrupted'
      );

      const sessions = state.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('good-session');
    });
  });

  describe('Async route handler', () => {
    it('spawn route uses async/await', () => {
      const routesSource = fs.readFileSync(
        path.join(process.cwd(), 'src/server/routes.ts'),
        'utf-8'
      );
      // The spawn route should be async
      expect(routesSource).toContain("router.post('/sessions/spawn', async");
      // Should use await, not .then/.catch
      expect(routesSource).toContain('await ctx.sessionManager.spawnSession');
    });
  });
});
