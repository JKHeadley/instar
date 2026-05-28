import { describe, it, expect } from 'vitest';
import { buildJoinedConfig } from '../../src/commands/machine.js';

/**
 * Regression test for the join-no-config bug (verified live on a real
 * two-machine mesh, 2026-05-28): config.json is gitignored, so a cloned mesh
 * repo never carries it, and `instar join` left the standby with NO authToken
 * (unauthenticated API) on loadConfig defaults. buildJoinedConfig produces a
 * complete machine-local config the join writes when the home lacks one.
 */
describe('buildJoinedConfig — machine-local config scaffold for a joined home', () => {
  const loaded = {
    projectName: 'mmtest2',
    projectDir: '/home/u/mmtest2',
    port: 4060,
    sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', maxSessions: 8 },
  };

  it('always sets a non-empty authToken (the core bug: unauthenticated standby)', () => {
    const a = buildJoinedConfig(loaded, undefined, 'tok-aaa');
    expect(a.authToken).toBe('tok-aaa');
    expect(typeof a.authToken).toBe('string');
    expect((a.authToken as string).length).toBeGreaterThan(0);
  });

  it('honors an explicit --port over the inherited port', () => {
    expect(buildJoinedConfig(loaded, 4061, 't').port).toBe(4061);
  });

  it('inherits the loaded port when no --port is given', () => {
    expect(buildJoinedConfig(loaded, undefined, 't').port).toBe(4060);
  });

  it('falls back to 4040 when neither --port nor a loaded port exists', () => {
    expect(buildJoinedConfig({ projectName: 'x' }, undefined, 't').port).toBe(4040);
  });

  it('protects the server tmux session and carries sane session defaults', () => {
    const c = buildJoinedConfig(loaded, undefined, 't') as any;
    expect(c.sessions.protectedSessions).toContain('mmtest2-server');
    expect(c.sessions.tmuxPath).toBe('/usr/bin/tmux');
    expect(c.sessions.maxSessions).toBe(8);
    expect(c.agentType).toBe('standalone');
    expect(Array.isArray(c.messaging)).toBe(true);
    expect(c.monitoring.quotaTracking).toBe(true);
  });

  it('defaults maxSessions when the loaded config omits it', () => {
    const c = buildJoinedConfig({ projectName: 'x', port: 4070 }, undefined, 't') as any;
    expect(c.sessions.maxSessions).toBe(10);
  });
});
