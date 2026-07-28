import { describe, it, expect } from 'vitest';
import { runTestAsSelf } from '../../src/commands/test-as-self.js';

/**
 * Integration: runTestAsSelf's pre-flight guards reject BEFORE any I/O (no
 * dirs created, no processes spawned), so these are safe to run in CI. They
 * verify the orchestrator wires the pure guards (testAsSelfValidation) to the
 * documented exit codes (11 = bad target, 12 = raw token on CLI).
 */
describe('test-as-self orchestrator — pre-flight guards (no I/O)', () => {
  it('exits 12 on a raw bot token (refuses secret on argv)', async () => {
    const { exitCode, report } = await runTestAsSelf({
      target: '/tmp/instar-test-as-self-should-not-be-created',
      botToken: '123456789:AAH8sQ3l2kZ_xQ9pZ0mNvW1rT5uY7iO3pLk', // raw token
    });
    expect(exitCode).toBe(12);
    expect((report as { error?: string }).error).toBe('raw-token-on-cli');
  });

  it('exits 11 when target is a protected agent name (bob)', async () => {
    const { exitCode, report } = await runTestAsSelf({
      target: '/Users/whoever/.instar/agents/bob',
      noRoundtrip: true,
      protectedNames: ['bob'],
    });
    expect(exitCode).toBe(11);
    expect((report as { error?: string }).error).toBe('target-is-protected');
  });

  it('exits 11 when target is the canonical home', async () => {
    const canonical = process.env.INSTAR_PROJECT_DIR || process.cwd();
    const { exitCode, report } = await runTestAsSelf({
      target: canonical,
      noRoundtrip: true,
    });
    expect(exitCode).toBe(11);
    expect((report as { error?: string }).error).toBe('target-is-canonical');
  });
});
