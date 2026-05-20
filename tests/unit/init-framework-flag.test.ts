/**
 * Verifies the `--framework` flag wired into `instar init`. PR 1 of the
 * Codex-only install audit's four-PR series.
 *
 * The flag resolves to an `enabledFrameworks` array persisted to
 * `.instar/config.json`. Downstream consumers (migrator, sentinel,
 * runtime spawn) read that single field. Default — flag absent — must
 * remain `['claude-code']` so existing/historical behavior is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { resolveEnabledFrameworks } from '../../src/commands/init.js';

describe('resolveEnabledFrameworks (PR 1 — --framework flag)', () => {
  it('defaults to [claude-code] when the flag is omitted (undefined)', () => {
    expect(resolveEnabledFrameworks(undefined)).toEqual(['claude-code']);
  });

  it('honors --framework claude-code (explicit, identical to default)', () => {
    expect(resolveEnabledFrameworks('claude-code')).toEqual(['claude-code']);
  });

  it('honors --framework codex-cli (Codex-only install)', () => {
    expect(resolveEnabledFrameworks('codex-cli')).toEqual(['codex-cli']);
  });

  it('honors --framework both (dual-runtime install)', () => {
    expect(resolveEnabledFrameworks('both')).toEqual(['claude-code', 'codex-cli']);
  });

  it('returns a fresh array each call (no shared mutable state)', () => {
    const a = resolveEnabledFrameworks('both');
    const b = resolveEnabledFrameworks('both');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
