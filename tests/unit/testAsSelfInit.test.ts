import { describe, it, expect } from 'vitest';
import { buildInitArgs, sanitizedSpawnEnv } from '../../src/commands/test-as-self.js';

describe('buildInitArgs — throwaway home init invocation (the step-3 fix)', () => {
  it('uses `init --dir <target>` — honors --dir, creates a runnable home', () => {
    expect(buildInitArgs('/tmp/throwaway')).toEqual(['init', '--dir', '/tmp/throwaway']);
  });

  it('does NOT use --standalone (which requires a name + routes to ~/.instar/agents/<name>, ignoring --dir — the bug that failed step 3 every run)', () => {
    expect(buildInitArgs('/tmp/x')).not.toContain('--standalone');
  });
});

describe('sanitizedSpawnEnv — strips parent session markers (the teardown fix)', () => {
  it('removes INSTAR_SESSION_ID and INSTAR_JOB_SLUG so the in-session server-management guard does not block the throwaway lifecycle', () => {
    const out = sanitizedSpawnEnv({ INSTAR_SESSION_ID: 'sess', INSTAR_JOB_SLUG: 'job', PATH: '/usr/bin' });
    expect(out.INSTAR_SESSION_ID).toBeUndefined();
    expect(out.INSTAR_JOB_SLUG).toBeUndefined();
  });

  it('preserves every other env var', () => {
    const out = sanitizedSpawnEnv({ PATH: '/usr/bin', HOME: '/home/x', FOO: 'bar' });
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/x');
    expect(out.FOO).toBe('bar');
  });

  it('does not mutate the input env', () => {
    const base = { INSTAR_SESSION_ID: 'sess', KEEP: 'me' };
    sanitizedSpawnEnv(base);
    expect(base.INSTAR_SESSION_ID).toBe('sess'); // original untouched
  });
});
