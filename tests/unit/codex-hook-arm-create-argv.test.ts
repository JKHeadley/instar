/**
 * The PRODUCTION argv builder — `armSessionCreateArgv` — not the deprecated standalone helper.
 * One request creates the session and schedules its death; the job is silent and guarded.
 */
import { describe, it, expect } from 'vitest';
import { armSessionCreateArgv, ARM_SESSION_TTL_MS } from '../../src/core/codexHookArm.js';

const ctx = { projectDir: '/tmp/p', codexHome: '/tmp/h' };

describe('armSessionCreateArgv', () => {
  it('creates the session and schedules its timer in ONE tmux request', () => {
    const argv = armSessionCreateArgv('/opt/homebrew/bin/tmux', 'instar-codex-arm-mvm43in2', ctx)!;
    expect(argv[0]).toBe('new-session');
    expect(argv).toContain('-s'); expect(argv[argv.indexOf('-s') + 1]).toBe('instar-codex-arm-mvm43in2');
    const sep = argv.indexOf(';');
    expect(sep).toBeGreaterThan(0);
    expect(argv.slice(sep + 1, sep + 3)).toEqual(['run-shell', '-b']);
  });

  it('the job is guarded by has-session, silent, and always exits 0 — it must never render an error into another pane', () => {
    const argv = armSessionCreateArgv('/opt/homebrew/bin/tmux', 'instar-codex-arm-x', ctx)!;
    const job = argv[argv.length - 1];
    expect(job).toMatch(new RegExp(`^sleep ${Math.ceil(ARM_SESSION_TTL_MS / 1000)}; if '/opt/homebrew/bin/tmux' has-session -t '=instar-codex-arm-x' >/dev/null 2>&1; then '/opt/homebrew/bin/tmux' kill-session -t '=instar-codex-arm-x' >/dev/null 2>&1; fi; exit 0$`));
  });

  it('the TTL clears the ~150 s modeled worst-case arming budget with real margin', () => {
    expect(ARM_SESSION_TTL_MS).toBeGreaterThanOrEqual(150_000 * 4);
  });

  it('honours an injected ttl', () => {
    const argv = armSessionCreateArgv('/usr/bin/tmux', 'instar-codex-arm-x', { ...ctx, ttlMs: 4_000 })!;
    expect(argv[argv.length - 1]).toMatch(/^sleep 4;/);
  });

  it('refuses a tmux path that is relative, or carries a quote or a tmux format character', () => {
    expect(armSessionCreateArgv('tmux', 'instar-codex-arm-x', ctx)).toBeNull();                 // relative: resolves in the SERVER's PATH
    expect(armSessionCreateArgv("/opt/weird'path/tmux", 'instar-codex-arm-x', ctx)).toBeNull(); // sh quote boundary
    expect(armSessionCreateArgv('/opt/#{session_name}/tmux', 'instar-codex-arm-x', ctx)).toBeNull(); // tmux format expansion
    expect(armSessionCreateArgv('/opt/#(id)/tmux', 'instar-codex-arm-x', ctx)).toBeNull();
  });

  it('refuses a session name outside the generated shape', () => {
    expect(armSessionCreateArgv('/usr/bin/tmux', 'instar-codex-arm-x; id', ctx)).toBeNull();
    expect(armSessionCreateArgv('/usr/bin/tmux', "instar-codex-arm-'x", ctx)).toBeNull();
    expect(armSessionCreateArgv('/usr/bin/tmux', 'instar-codex-arm-$(id)', ctx)).toBeNull();
  });
});
