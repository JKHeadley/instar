import { describe, it, expect } from 'vitest';
import {
  evaluateKillFloor,
  matchAllowlistClass,
  EXTERNAL_HOG_ALLOWLIST,
  type ExternalHogFacts,
} from '../../src/monitoring/ExternalHogFloor.js';

/**
 * ExternalHogFloor — the deterministic VETO-ONLY safety floor (CMT-1901, §3-§4).
 * A kill executes iff floor.permitted && classifier==='kill'. These tests exercise the
 * floor's ENVELOPE independently of the model: the floor PERMITS only a confirmed orphaned
 * in-envelope exthost zombie, and VETOES everything else, failing CLOSED on any unknown.
 */

const OWN_EUID = 501;

/** A fully-passing candidate (the 2026-07-03 MongoDB-exthost anchor). All other fixtures
 *  flip exactly one fact to prove that invariant is load-bearing. */
function anchor(overrides: Partial<ExternalHogFacts> = {}): ExternalHogFacts {
  return {
    name: 'Code Helper (Plugin)',
    argv: '/Applications/VS Code.app/.../Code Helper (Plugin) --type=extensionHost --parentPid=9999',
    pid: 5335,
    ownerAppRunning: false,
    sustainedHighCpu: true,
    isInstarProcess: false,
    ownerRootDaemon: false,
    hasLaunchctlLabel: false,
    targetUid: OWN_EUID,
    ownEuid: OWN_EUID,
    ...overrides,
  };
}

describe('ExternalHogFloor — allowlist match (code-defined, name + argv token)', () => {
  it('matches the four v1 editor exthost-wrapper classes WITH an argv token', () => {
    expect(matchAllowlistClass('Code Helper (Plugin)', 'x --type=extensionHost y')).toBe('vscode-exthost');
    expect(matchAllowlistClass('Cursor Helper (Plugin)', 'node .../language-server.js')).toBe('cursor-exthost');
    expect(matchAllowlistClass('Windsurf Helper (Plugin)', 'foo extensionHost bar')).toBe('windsurf-exthost');
    expect(matchAllowlistClass('Code - OSS Helper (Plugin)', 'a extension_host b')).toBe('vscodium-exthost');
  });
  it('requires BOTH the name regex AND an argv token (name alone is not enough)', () => {
    expect(matchAllowlistClass('Code Helper (Plugin)', 'no relevant token here')).toBeNull();
    expect(matchAllowlistClass('Some Other Process', '--type=extensionHost')).toBeNull();
  });
  it('does not match an attacker-named process outside the regex', () => {
    // The name is attacker-controllable; a misleading name cannot forge class membership.
    expect(matchAllowlistClass('kill-me-please Helper', '--type=extensionHost')).toBeNull();
    expect(matchAllowlistClass('Code Helper (Plugin) EVIL', '--type=extensionHost')).toBeNull(); // anchored regex
  });
  it('the allowlist is a non-empty compiled constant (v1 = 4 classes)', () => {
    expect(EXTERNAL_HOG_ALLOWLIST.length).toBe(4);
  });
});

describe('ExternalHogFloor — the anchor case PERMITS (necessary condition for a kill)', () => {
  it('a confirmed orphaned in-envelope exthost zombie clears every invariant', () => {
    const v = evaluateKillFloor(anchor());
    expect(v.permitted).toBe(true);
    if (v.permitted) expect(v.matchedClass).toBe('vscode-exthost');
  });
});

describe('ExternalHogFloor — every hard invariant is load-bearing (VETO on failure)', () => {
  const cases: Array<[string, Partial<ExternalHogFacts>, string]> = [
    ['instar-owned process',        { isInstarProcess: true },                'instar-owned'],
    ['different uid',               { targetUid: OWN_EUID + 1 },              'other-uid'],
    ['refuse to arm as root',       { ownEuid: 0, targetUid: 0 },             'refuse-to-arm-as-root'],
    ['unknown uid (fail closed)',   { targetUid: undefined },                 'uid-unknown'],
    ['system/root daemon',          { ownerRootDaemon: true },                'system-root-daemon'],
    ['launchctl-labeled job',       { hasLaunchctlLabel: true },              'launchctl-labeled'],
    ['owner app still running',     { ownerAppRunning: true },                'owner-app-running'],
    ['not a sustained hog (idle)',  { sustainedHighCpu: false },              'not-sustained-hog'],
    ['outside the allowlist (name)',{ name: 'python3', argv: 'python3 x' },   'outside-allowlist'],
    ['outside the allowlist (token)', { argv: 'Code Helper no-token' },       'outside-allowlist'],
  ];
  for (const [label, override, expectedReason] of cases) {
    it(`VETOES: ${label}`, () => {
      const v = evaluateKillFloor(anchor(override));
      expect(v.permitted).toBe(false);
      if (!v.permitted) expect(v.vetoReason).toBe(expectedReason);
    });
  }

  it('an attacker-named "safe to kill me" process with a live parent is VETOED (name is inert)', () => {
    // The name says kill; the floor ignores it — a live owner app (parent) vetoes regardless.
    const v = evaluateKillFloor(anchor({ name: 'Code Helper (Plugin)', ownerAppRunning: true }));
    expect(v.permitted).toBe(false);
    if (!v.permitted) expect(v.vetoReason).toBe('owner-app-running');
  });
});

describe('ExternalHogFloor — STRICT fail-closed on a missing required boolean (round-11)', () => {
  // A sampler that times out under load could DROP a required field. The floor must VETO on
  // any non-boolean value, not fail open via truthiness. Cast through unknown to simulate a
  // dropped field (the TS type marks these required; the runtime guard is defense-in-depth).
  const drop = (field: keyof ExternalHogFacts): ExternalHogFacts =>
    ({ ...anchor(), [field]: undefined } as unknown as ExternalHogFacts);

  for (const field of ['isInstarProcess', 'ownerRootDaemon', 'hasLaunchctlLabel', 'ownerAppRunning', 'sustainedHighCpu'] as const) {
    it(`VETOES when ${field} is undefined (fail closed, not open)`, () => {
      const v = evaluateKillFloor(drop(field));
      expect(v.permitted).toBe(false);
      if (!v.permitted) expect(v.vetoReason).toBe(`field-unknown:${field}`);
    });
  }

  it('VETOES when a required boolean is a non-boolean type (e.g. a string leaked from a fact source)', () => {
    const v = evaluateKillFloor({ ...anchor(), ownerAppRunning: 'false' as unknown as boolean });
    expect(v.permitted).toBe(false);
    if (!v.permitted) expect(v.vetoReason).toBe('field-unknown:ownerAppRunning');
  });
});

describe('ExternalHogFloor — the 8 zombie-classify cases as floor fixtures', () => {
  // The floor evaluates the SAME facts the classifier sees, as HARD invariants. Independent
  // of the model's verdict, the floor PERMITS only the one confirmed orphaned in-envelope
  // exthost zombie; it VETOES the 7 others (root daemon, live parent, instar-own, name-spoof
  // + live parent, root-daemon-claims-safe, missing-field, momentary-spike).
  it('canon-orphaned-exthost-kill → PERMITTED', () => {
    expect(evaluateKillFloor(anchor()).permitted).toBe(true);
  });
  it('canon-fseventsd-leave (root daemon) → VETOED', () => {
    expect(evaluateKillFloor(anchor({ name: 'fseventsd', argv: 'fseventsd', ownerRootDaemon: true, targetUid: 0 })).permitted).toBe(false);
  });
  it('canon-live-build-alert (live parent) → VETOED', () => {
    expect(evaluateKillFloor(anchor({ ownerAppRunning: true })).permitted).toBe(false);
  });
  it('canon-instar-own-leave → VETOED', () => {
    expect(evaluateKillFloor(anchor({ isInstarProcess: true })).permitted).toBe(false);
  });
  it('adv-zombie-name-but-live-parent → VETOED', () => {
    expect(evaluateKillFloor(anchor({ ownerAppRunning: true })).permitted).toBe(false);
  });
  it('adv-root-daemon-claims-safe → VETOED (name inert; root-daemon fact vetoes)', () => {
    expect(evaluateKillFloor(anchor({ name: 'Code Helper (Plugin)', ownerRootDaemon: true })).permitted).toBe(false);
  });
  it('adv-missing-field-uncertain (unknown uid) → VETOED (fail closed)', () => {
    expect(evaluateKillFloor(anchor({ targetUid: undefined })).permitted).toBe(false);
  });
  it('adv-momentary-spike-not-sustained → VETOED', () => {
    expect(evaluateKillFloor(anchor({ sustainedHighCpu: false })).permitted).toBe(false);
  });
});
