/**
 * Tests for SessionCredentialManager — session-scoped credential isolation.
 *
 * Tests the actual SessionCredentialManager class with real method calls.
 * Verifies that sessions get isolated credentials and that env injection works.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionCredentialManager } from '../../src/monitoring/SessionCredentialManager.js';
import type { ClaudeCredentials } from '../../src/monitoring/CredentialProvider.js';

describe('SessionCredentialManager', () => {
  let manager: SessionCredentialManager;

  const credsA: ClaudeCredentials = {
    accessToken: 'token-account-a',
    expiresAt: Date.now() + 3600000,
    email: 'a@example.com',
  };

  const credsB: ClaudeCredentials = {
    accessToken: 'token-account-b',
    expiresAt: Date.now() + 3600000,
    email: 'b@example.com',
  };

  beforeEach(() => {
    manager = new SessionCredentialManager();
  });

  // ── Assignment ──────────────────────────────────────────────────

  it('assigns credentials to a session', () => {
    manager.assignAccount('session-1', 'a@example.com', credsA);

    const assignment = manager.getAssignment('session-1');
    expect(assignment).toBeDefined();
    expect(assignment!.email).toBe('a@example.com');
    expect(assignment!.sessionId).toBe('session-1');
    expect(assignment!.credentials.accessToken).toBe('token-account-a');
    expect(assignment!.assignedAt).toBeTruthy();
  });

  it('returns undefined for unassigned session', () => {
    expect(manager.getAssignment('nonexistent')).toBeUndefined();
  });

  it('overwrites previous assignment for same session', () => {
    manager.assignAccount('session-1', 'a@example.com', credsA);
    manager.assignAccount('session-1', 'b@example.com', credsB);

    const assignment = manager.getAssignment('session-1');
    expect(assignment!.email).toBe('b@example.com');
    expect(assignment!.credentials.accessToken).toBe('token-account-b');
  });

  // ── Env Injection ─────────────────────────────────────────────

  it('returns env variables for assigned session', () => {
    manager.assignAccount('session-1', 'a@example.com', credsA);

    const env = manager.getSessionEnv('session-1');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('token-account-a');
    expect(env.CLAUDE_ACCOUNT_EMAIL).toBe('a@example.com');
  });

  it('returns empty object for unassigned session', () => {
    const env = manager.getSessionEnv('nonexistent');
    expect(env).toEqual({});
  });

  it('different sessions get different env', () => {
    manager.assignAccount('session-1', 'a@example.com', credsA);
    manager.assignAccount('session-2', 'b@example.com', credsB);

    const env1 = manager.getSessionEnv('session-1');
    const env2 = manager.getSessionEnv('session-2');

    expect(env1.ANTHROPIC_AUTH_TOKEN).toBe('token-account-a');
    expect(env2.ANTHROPIC_AUTH_TOKEN).toBe('token-account-b');
    expect(env1.CLAUDE_ACCOUNT_EMAIL).toBe('a@example.com');
    expect(env2.CLAUDE_ACCOUNT_EMAIL).toBe('b@example.com');
  });

  // ── Release ───────────────────────────────────────────────────

  it('releases session credentials', () => {
    manager.assignAccount('session-1', 'a@example.com', credsA);
    expect(manager.activeCount).toBe(1);

    const released = manager.releaseSession('session-1');
    expect(released).toBe(true);
    expect(manager.activeCount).toBe(0);
    expect(manager.getAssignment('session-1')).toBeUndefined();
    expect(manager.getSessionEnv('session-1')).toEqual({});
  });

  it('returns false when releasing unassigned session', () => {
    const released = manager.releaseSession('nonexistent');
    expect(released).toBe(false);
  });

  // ── Account Lookup ────────────────────────────────────────────

  it('finds sessions using a given account', () => {
    manager.assignAccount('session-1', 'a@example.com', credsA);
    manager.assignAccount('session-2', 'a@example.com', credsA);
    manager.assignAccount('session-3', 'b@example.com', credsB);

    const sessionsA = manager.getSessionsForAccount('a@example.com');
    expect(sessionsA).toHaveLength(2);
    expect(sessionsA).toContain('session-1');
    expect(sessionsA).toContain('session-2');

    const sessionsB = manager.getSessionsForAccount('b@example.com');
    expect(sessionsB).toHaveLength(1);
    expect(sessionsB).toContain('session-3');
  });

  it('returns empty array for unused account', () => {
    expect(manager.getSessionsForAccount('nobody@example.com')).toEqual([]);
  });

  // ── Bulk Operations ───────────────────────────────────────────

  it('getAllAssignments returns all current assignments', () => {
    manager.assignAccount('s1', 'a@example.com', credsA);
    manager.assignAccount('s2', 'b@example.com', credsB);

    const all = manager.getAllAssignments();
    expect(all).toHaveLength(2);
    expect(all.map(a => a.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('activeCount tracks assignments correctly', () => {
    expect(manager.activeCount).toBe(0);

    manager.assignAccount('s1', 'a@example.com', credsA);
    expect(manager.activeCount).toBe(1);

    manager.assignAccount('s2', 'b@example.com', credsB);
    expect(manager.activeCount).toBe(2);

    manager.releaseSession('s1');
    expect(manager.activeCount).toBe(1);
  });

  it('clear removes all assignments', () => {
    manager.assignAccount('s1', 'a@example.com', credsA);
    manager.assignAccount('s2', 'b@example.com', credsB);
    expect(manager.activeCount).toBe(2);

    manager.clear();
    expect(manager.activeCount).toBe(0);
    expect(manager.getAllAssignments()).toEqual([]);
  });

  // ── Session Isolation ─────────────────────────────────────────

  it('releasing one session does not affect others', () => {
    manager.assignAccount('s1', 'a@example.com', credsA);
    manager.assignAccount('s2', 'b@example.com', credsB);

    manager.releaseSession('s1');

    expect(manager.getAssignment('s2')).toBeDefined();
    expect(manager.getSessionEnv('s2').ANTHROPIC_AUTH_TOKEN).toBe('token-account-b');
  });

  it('reassigning one session does not affect others', () => {
    manager.assignAccount('s1', 'a@example.com', credsA);
    manager.assignAccount('s2', 'b@example.com', credsB);

    // Reassign s1 to account B
    manager.assignAccount('s1', 'b@example.com', credsB);

    // s2 should be unaffected
    expect(manager.getSessionEnv('s2').ANTHROPIC_AUTH_TOKEN).toBe('token-account-b');
    expect(manager.getSessionEnv('s1').ANTHROPIC_AUTH_TOKEN).toBe('token-account-b');

    // Both now on account B
    expect(manager.getSessionsForAccount('b@example.com')).toHaveLength(2);
    expect(manager.getSessionsForAccount('a@example.com')).toHaveLength(0);
  });
});
