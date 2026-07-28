import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  resolveRelayScript,
  relayDelivered,
} from '../../skills/spec-converge/scripts/publish-spec-review.mjs';

/**
 * publish-spec-review.mjs spawned `.instar/scripts/telegram-reply.sh` as a bare
 * relative path and then printed "[published] … delivered" without inspecting the
 * result. From a worktree — where instar-dev work is REQUIRED to happen — the spawn
 * failed with ENOENT and the operator's approval ask was silently dropped while the
 * agent was told it had been delivered.
 *
 * Filed three times before it was fixed: ACT-616 (2026-07-13), ACT-1390
 * (2026-07-27), ACT-1517 (2026-07-28).
 */
describe('resolveRelayScript', () => {
  const HOME = '/Users/x/.instar/agents/echo';
  const RELAY = path.join(HOME, '.instar/scripts/telegram-reply.sh');

  it('finds the relay when cwd IS the agent home', () => {
    expect(resolveRelayScript(HOME, (p) => p === RELAY)).toBe(RELAY);
  });

  it('walks UP to the agent home from a worktree — the case that shipped broken', () => {
    const worktree = path.join(HOME, '.worktrees/act1426-tautological');
    expect(resolveRelayScript(worktree, (p) => p === RELAY)).toBe(RELAY);
  });

  it('falls back to the documented older-install .claude path', () => {
    const legacy = path.join(HOME, '.claude/scripts/telegram-reply.sh');
    expect(resolveRelayScript(HOME, (p) => p === legacy)).toBe(legacy);
  });

  it('prefers .instar over .claude when both exist', () => {
    expect(resolveRelayScript(HOME, () => true)).toBe(RELAY);
  });

  it('returns null when no relay exists anywhere above — never a bogus path', () => {
    expect(resolveRelayScript('/tmp/nowhere', () => false)).toBeNull();
  });
});

describe('relayDelivered', () => {
  const SENT = 'Sent 408 chars to topic 29723\n';

  it('is true only when the relay confirms the send', () => {
    expect(relayDelivered({ status: 0, stdout: SENT, stderr: '' })).toBe(true);
  });

  it('accepts the confirmation on stderr too', () => {
    expect(relayDelivered({ status: 0, stdout: '', stderr: SENT })).toBe(true);
  });

  it('is FALSE on ENOENT — the exact production failure', () => {
    expect(relayDelivered({
      error: new Error('spawnSync bash ENOENT'),
      status: null,
      stdout: '',
      stderr: 'bash: .instar/scripts/telegram-reply.sh: No such file or directory\n',
    })).toBe(false);
  });

  it('is FALSE on a nonzero exit', () => {
    expect(relayDelivered({ status: 1, stdout: '', stderr: 'boom' })).toBe(false);
  });

  it('is FALSE on exit 0 with NO confirmation — a silent no-op is not a delivery', () => {
    expect(relayDelivered({ status: 0, stdout: '', stderr: '' })).toBe(false);
  });

  it('is FALSE for a null/undefined result', () => {
    expect(relayDelivered(undefined)).toBe(false);
    expect(relayDelivered(null)).toBe(false);
  });
});
