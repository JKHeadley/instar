/**
 * Linux auto-start lingering — the difference between "installed" and "starts
 * at boot".
 *
 * THE DEFECT (2026-08-25, first headless Linux host). `instar autostart
 * install` wrote a correct systemd USER service, enabled it, started it, and
 * reported "your agent will start automatically when you log in." On Linux a
 * per-user service only runs while that user holds a login session and does NOT
 * start at boot unless LINGERING is enabled for the account. It was not. On a
 * machine nobody logs into, the message was true in a way that meant NEVER —
 * the agent came up on SSH and died on disconnect.
 *
 * These tests pin the three things that matter: the outcome is VERIFIED rather
 * than inferred from an exit code, a refusal is reported rather than swallowed,
 * and the message the operator reads matches which of those actually happened.
 */
import { describe, it, expect } from 'vitest';
import {
  readLingerState,
  ensureLinuxLingering,
  describeLingerOutcome,
  currentSystemdUser,
  type LingerOutcome,
} from '../../src/commands/setup.js';

describe('Linux auto-start lingering', () => {
  // ── readLingerState ────────────────────────────────────────────────────
  it('parses loginctl output in both directions', () => {
    expect(readLingerState('echo', () => 'Linger=yes\n')).toBe(true);
    expect(readLingerState('echo', () => 'Linger=no\n')).toBe(false);
  });

  it('reports UNANSWERABLE rather than false when loginctl is absent or mute', () => {
    // The distinction is the whole point: "no linger" is a fixable finding,
    // "could not ask" is not — and conflating them would make a container
    // without loginctl print a fix instruction that cannot work there.
    expect(
      readLingerState('echo', () => {
        throw new Error('ENOENT loginctl');
      }),
    ).toBeNull();
    expect(readLingerState('echo', () => 'some unrelated output\n')).toBeNull();
  });

  // ── ensureLinuxLingering ───────────────────────────────────────────────
  it('is a no-op when lingering is already on', () => {
    let enableCalls = 0;
    const out = ensureLinuxLingering('echo', {
      read: () => true,
      enable: () => {
        enableCalls++;
      },
    });
    expect(out).toBe('enabled-already');
    expect(enableCalls).toBe(0); // never re-runs a privileged command needlessly
  });

  it('enables lingering and VERIFIES the effect rather than trusting the exit code', () => {
    let enabled = false;
    const out = ensureLinuxLingering('echo', {
      read: () => enabled,
      enable: () => {
        enabled = true;
      },
    });
    expect(out).toBe('enabled-now');
  });

  it('reports needs-privilege when the command SUCCEEDS but the effect did not happen', () => {
    // This is the exact defect class being fixed: a step that returns success
    // while the effect it exists to produce never occurred. A silent exit 0
    // must not be read as "lingering is on".
    const out = ensureLinuxLingering('echo', {
      read: () => false, // still off after the "successful" enable
      enable: () => {
        /* exits 0, changes nothing */
      },
    });
    expect(out).toBe('needs-privilege');
  });

  it('reports needs-privilege when loginctl refuses', () => {
    const out = ensureLinuxLingering('echo', {
      read: () => false,
      enable: () => {
        throw new Error('Interactive authentication required');
      },
    });
    expect(out).toBe('needs-privilege');
  });

  it('reports unavailable — never needs-privilege — when the state cannot be read at all', () => {
    let enableCalls = 0;
    const out = ensureLinuxLingering('echo', {
      read: () => null,
      enable: () => {
        enableCalls++;
      },
    });
    expect(out).toBe('unavailable');
    expect(enableCalls).toBe(0); // don't run a privileged command blind
  });

  // ── describeLingerOutcome ──────────────────────────────────────────────
  it('only promises boot start when boot start is actually true', () => {
    const boots: LingerOutcome[] = ['enabled-already', 'enabled-now'];
    for (const o of boots) {
      const msg = describeLingerOutcome(o, 'echo');
      expect(msg).toMatch(/boots/);
      expect(msg).not.toMatch(/NOT at boot/);
    }
  });

  it('says plainly that a login-only service means never on an unattended machine, and names the fix', () => {
    const msg = describeLingerOutcome('needs-privilege', 'echo');
    expect(msg).toMatch(/NOT at boot/);
    expect(msg).toMatch(/means never/);
    expect(msg).toContain('loginctl enable-linger echo'); // the exact command, with the real user
  });

  it('does not claim boot start when the answer is unknown', () => {
    const msg = describeLingerOutcome('unavailable', 'echo');
    expect(msg).toMatch(/could not be determined/);
    expect(msg).not.toMatch(/when this machine boots/);
  });

  it('never renders the old unconditional promise for a non-booting outcome', () => {
    // The regression guard: the string the defect shipped was
    // "will start automatically when you log in", said unconditionally.
    for (const o of ['needs-privilege', 'unavailable'] as LingerOutcome[]) {
      expect(describeLingerOutcome(o, 'echo')).not.toBe(
        'Your agent will start automatically when you log in.',
      );
    }
  });

  // ── currentSystemdUser ─────────────────────────────────────────────────
  it('resolves a non-empty system user for the fix instruction', () => {
    // The instruction is useless without the right account name in it.
    expect(currentSystemdUser().length).toBeGreaterThan(0);
  });
});
