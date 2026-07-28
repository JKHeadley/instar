import { describe, it, expect } from 'vitest';
import {
  classContentHash,
  isMarkerValid,
  classIsArmed,
  canKillLive,
  type ArmMarker,
} from '../../src/monitoring/ExternalHogArmMarker.js';

/**
 * ExternalHogArmMarker — the armed-marker gate (CMT-1901, §7-§8). Going live is doubly-held:
 * enabled && !dryRun AND a valid PIN-written marker. Two load-bearing properties: the
 * arm-epoch lifecycle (a disarm can never be silently un-done) and the per-class content-hash
 * arm-scope (an armed grant never silently widens).
 */

const H_VSCODE = classContentHash(['^Code Helper \\(Plugin\\)$', 'extension.host', 'language.server']);
const H_CURSOR = classContentHash(['^Cursor Helper \\(Plugin\\)$', 'extension.host', 'language.server']);

function marker(over: Partial<ArmMarker> = {}): ArmMarker {
  return {
    armEpoch: 5,
    armedBy: 'operator-pin',
    armedAt: '2026-07-03T00:00:00Z',
    allowlistSnapshot: { 'vscode-exthost': H_VSCODE },
    ...over,
  };
}
const LIVE = { enabled: true, dryRun: false };

describe('classContentHash — deterministic, change-sensitive', () => {
  it('is stable for identical rule sources', () => {
    expect(classContentHash(['a', 'b'])).toBe(classContentHash(['a', 'b']));
  });
  it('changes when a match rule is broadened/altered (forces a re-arm)', () => {
    expect(classContentHash(['^Code Helper \\(Plugin\\)$'])).not.toBe(classContentHash(['Code Helper']));
  });
  it('is order-sensitive (a reordering is a distinct hash)', () => {
    expect(classContentHash(['a', 'b'])).not.toBe(classContentHash(['b', 'a']));
  });
});

describe('isMarkerValid — arm-epoch lifecycle (a disarm can never be silently un-done)', () => {
  it('VALID while armEpoch > lastDisarmEpoch', () => {
    expect(isMarkerValid(marker({ armEpoch: 5 }), 4)).toBe(true);
  });
  it('INVALID once a disarm bumps lastDisarmEpoch >= armEpoch', () => {
    expect(isMarkerValid(marker({ armEpoch: 5 }), 5)).toBe(false); // disarm at the same epoch
    expect(isMarkerValid(marker({ armEpoch: 5 }), 6)).toBe(false); // disarm after
  });
  it('the disarm→config→restart bypass is closed: an old marker boots UNARMED', () => {
    // After a disarm, lastDisarmEpoch=5. A stale marker (armEpoch=5) persisted on disk +
    // config flipped dryRun:false → on boot the marker is INVALID; re-arming needs a fresh
    // (higher) armEpoch from the PIN route.
    const stale = marker({ armEpoch: 5 });
    expect(isMarkerValid(stale, 5)).toBe(false);
    const freshPinArm = marker({ armEpoch: 6 });
    expect(isMarkerValid(freshPinArm, 5)).toBe(true);
  });
  it('a missing marker or non-finite epoch is INVALID (fail closed)', () => {
    expect(isMarkerValid(null, 0)).toBe(false);
    expect(isMarkerValid(undefined, 0)).toBe(false);
    expect(isMarkerValid(marker({ armEpoch: NaN }), 0)).toBe(false);
    expect(isMarkerValid(marker({ armEpoch: 5 }), NaN)).toBe(false);
  });
});

describe('classIsArmed — per-class content-hash (an armed grant never silently widens)', () => {
  it('a class with a matching current hash is armed', () => {
    expect(classIsArmed(marker(), 'vscode-exthost', H_VSCODE)).toBe(true);
  });
  it('a NEW class absent from the snapshot is NOT armed (grow → alert-only)', () => {
    expect(classIsArmed(marker(), 'cursor-exthost', H_CURSOR)).toBe(false);
  });
  it('a BROADENED existing class (hash mismatch) is NOT armed (never-widen → alert-only)', () => {
    const broadened = classContentHash(['Code Helper', 'extension.host']); // loosened regex
    expect(classIsArmed(marker(), 'vscode-exthost', broadened)).toBe(false);
  });
  it('an unrelated class addition leaves existing entries armed (availability)', () => {
    const m = marker({ allowlistSnapshot: { 'vscode-exthost': H_VSCODE, 'cursor-exthost': H_CURSOR } });
    expect(classIsArmed(m, 'vscode-exthost', H_VSCODE)).toBe(true);
    expect(classIsArmed(m, 'cursor-exthost', H_CURSOR)).toBe(true);
  });
});

describe('canKillLive — the full doubly-held authorization', () => {
  it('permits a live kill only when enabled && !dryRun && valid marker && class armed', () => {
    expect(canKillLive(LIVE, marker(), 4, 'vscode-exthost', H_VSCODE)).toBe(true);
  });
  it('dryRun:true (the watch-only soak) NEVER permits a live kill even with a valid marker', () => {
    expect(canKillLive({ enabled: true, dryRun: true }, marker(), 4, 'vscode-exthost', H_VSCODE)).toBe(false);
  });
  it('config.dryRun:false alone (no valid marker) is NEVER a positive arm signal', () => {
    // The exact security bypass round-9 closed: a bare config flip cannot arm.
    expect(canKillLive(LIVE, null, 0, 'vscode-exthost', H_VSCODE)).toBe(false);
    expect(canKillLive(LIVE, marker({ armEpoch: 5 }), 5 /* disarmed */, 'vscode-exthost', H_VSCODE)).toBe(false);
  });
  it('enabled:false never permits a kill', () => {
    expect(canKillLive({ enabled: false, dryRun: false }, marker(), 4, 'vscode-exthost', H_VSCODE)).toBe(false);
  });
  it('a class not in the armed snapshot (new/broadened) is never live-killed', () => {
    expect(canKillLive(LIVE, marker(), 4, 'cursor-exthost', H_CURSOR)).toBe(false);
    const broadened = classContentHash(['Code Helper']);
    expect(canKillLive(LIVE, marker(), 4, 'vscode-exthost', broadened)).toBe(false);
  });
});
