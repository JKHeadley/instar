/**
 * Tier-1 tests for floor gating on GitHub's real settings (spec
 * local-verify-merge-authority.md §4 "The floor follows what GitHub actually
 * enforces", §3 floor selection, Rollback: the mirror stays on when unreadable).
 */

import { describe, expect, it } from 'vitest';
import { FloorGate, evaluateFloorSettings, floorSettingsState, type FloorGateSeams } from '../../../src/localVerify/floorGate.js';

const REPO = 'JKHeadley/instar';

const rulesWith = (checks: Array<{ context: string; integration_id?: number }>, strict = false) => [
  { type: 'pull_request', parameters: { required_approving_review_count: 0 } },
  { type: 'required_status_checks', parameters: { required_status_checks: checks, strict_required_status_checks_policy: strict } },
];
const branchWith = (contexts: string[]) => ({ name: 'main', protected: true, protection: { enabled: true, required_status_checks: { contexts, checks: contexts.map((c) => ({ context: c })) } } });
const LV = { context: 'instar/local-verify' };

describe('evaluateFloorSettings / floorSettingsState', () => {
  it('effective only when edit A (ruleset requires the check, no integration_id, strict off) AND edit B (no classic contexts) AND bypass never', () => {
    expect(floorSettingsState(evaluateFloorSettings(rulesWith([LV]), branchWith([]), 'never'), 'local')).toBe('effective');
  });

  it('edit A missing ⇒ awaiting-edit-a (even if B is done)', () => {
    expect(floorSettingsState(evaluateFloorSettings(rulesWith([]), branchWith([]), 'never'), 'local')).toBe('awaiting-edit-a');
    expect(floorSettingsState(evaluateFloorSettings(rulesWith([{ ...LV, integration_id: 15368 }]), branchWith([]), 'never'), 'local')).toBe('awaiting-edit-a');
    expect(floorSettingsState(evaluateFloorSettings(rulesWith([LV], true), branchWith([]), 'never'), 'local')).toBe('awaiting-edit-a');
  });

  it('edit A done, classic contexts still required ⇒ awaiting-edit-b', () => {
    expect(floorSettingsState(evaluateFloorSettings(rulesWith([LV]), branchWith(['Build']), 'never'), 'local')).toBe('awaiting-edit-b');
  });

  it('bypass other than never ⇒ not effective', () => {
    expect(floorSettingsState(evaluateFloorSettings(rulesWith([LV]), branchWith([]), 'always'), 'local')).toBe('bypass-not-never');
  });

  it('any unreadable endpoint ⇒ settings-unreadable; config floor actions ⇒ config-actions', () => {
    expect(floorSettingsState(evaluateFloorSettings(null, branchWith([]), 'never'), 'local')).toBe('settings-unreadable');
    expect(floorSettingsState(evaluateFloorSettings(rulesWith([LV]), null, 'never'), 'local')).toBe('settings-unreadable');
    expect(floorSettingsState(evaluateFloorSettings(rulesWith([LV]), branchWith([]), null), 'local')).toBe('settings-unreadable');
    expect(floorSettingsState(evaluateFloorSettings(rulesWith([LV]), branchWith([]), 'never'), 'actions')).toBe('config-actions');
  });

  it('no protection block = no classic contexts; neither requiring any check is flagged', () => {
    const s = evaluateFloorSettings([{ type: 'pull_request', parameters: {} }], { name: 'main', protected: false }, 'never');
    expect(s.classicContexts).toEqual([]);
    expect(s.noRequiredChecksAnywhere).toBe(true);
    expect(evaluateFloorSettings(rulesWith([LV]), branchWith([]), 'never').noRequiredChecksAnywhere).toBe(false);
  });
});

function gate(opts: { rules?: unknown; branch?: unknown; bypass?: string | null; floor?: 'local' | 'actions'; watcherRepo?: string }) {
  const signals: string[] = [];
  const st = { ...opts };
  const seams: FloorGateSeams = {
    readRulesBranches: async () => ('rules' in st ? st.rules : rulesWith([LV])) as unknown,
    readBranch: async () => ('branch' in st ? st.branch : branchWith([])) as unknown,
    readRulesetBypass: async () => ('bypass' in st ? st.bypass! : 'never'),
    now: () => 0,
    signal: (k) => { signals.push(k); },
    audit: () => {},
  };
  const g = new FloorGate({ repo: REPO, configFloor: () => st.floor ?? 'local', watcherRepo: () => st.watcherRepo ?? REPO }, seams);
  return { g, st, signals };
}

describe('FloorGate', () => {
  it('floorFor: local only when configured local, same repo as the watcher, eligible, and settings effective', async () => {
    const { g, st } = gate({});
    await g.refresh();
    expect(g.floorFor({ repo: REPO, eligible: true })).toBe('local');
    expect(g.floorFor({ repo: REPO, eligible: false })).toBe('actions');
    expect(g.floorFor({ repo: 'other/repo', eligible: true })).toBe('actions');
    st.watcherRepo = 'other/repo';
    expect(g.floorFor({ repo: REPO, eligible: true })).toBe('actions');
    st.watcherRepo = REPO;
    st.floor = 'actions';
    expect(g.floorFor({ repo: REPO, eligible: true })).toBe('actions');
  });

  it('before any read, and on unreadable settings, the floor is actions and the check counts as required (mirror stays on)', async () => {
    const { g } = gate({ rules: null });
    expect(g.floorFor({ repo: REPO, eligible: true })).toBe('actions');
    expect(g.checkRequired()).toBe(true);
    await g.refresh();
    expect(g.state()).toBe('settings-unreadable');
    expect(g.checkRequired()).toBe(true);
    expect(g.floorFor({ repo: REPO, eligible: true })).toBe('actions');
  });

  it('a readable ruleset without the check ⇒ not required', async () => {
    const { g } = gate({ rules: rulesWith([]) });
    await g.refresh();
    expect(g.checkRequired()).toBe(false);
  });

  it('neither endpoint requiring any status check ⇒ ONE HIGH signal (deduped across passes)', async () => {
    const { g, signals } = gate({ rules: [], branch: { name: 'main', protected: false } });
    await g.refresh();
    await g.refresh();
    expect(signals).toEqual(['local-verify:no-required-checks']);
  });

  it('bypass not never under the local floor ⇒ one signal', async () => {
    const { g, signals } = gate({ bypass: 'pull_requests_only' });
    await g.refresh();
    await g.refresh();
    expect(signals).toEqual(['local-verify:bypass-not-never']);
    expect(g.state()).toBe('bypass-not-never');
  });

  it('exposes the ruleset and classic contexts for the mirror union', async () => {
    const { g } = gate({ rules: rulesWith([LV, { context: 'Build' }]), branch: branchWith(['Unit Tests (shard 1/4)']) });
    await g.refresh();
    expect(g.contexts()).toEqual({ protectionContexts: ['Unit Tests (shard 1/4)'], rulesetContexts: ['instar/local-verify', 'Build'] });
  });

  it('/branches/main protected:true without a protection block is unreadable (not "classic requires nothing")', async () => {
    expect(evaluateFloorSettings(rulesWith([LV]), { name: 'main', protected: true }, 'never').classicContexts).toBeNull();
    expect(evaluateFloorSettings(rulesWith([LV]), { name: 'main' }, 'never').classicContexts).toBeNull();
    expect(evaluateFloorSettings(rulesWith([LV]), { name: 'main', protected: false }, 'never').classicContexts).toEqual([]);
    const { g } = gate({ branch: { name: 'main', protected: true } });
    await g.refresh();
    expect(g.state()).toBe('settings-unreadable');
    expect(g.floorFor({ repo: REPO, eligible: true })).toBe('actions');
    expect(g.settingsReadable()).toBe(false);
  });

  it('classic protection requiring instar/local-verify counts as "check required" for the mirror', async () => {
    const { g } = gate({ rules: rulesWith([]), branch: branchWith(['instar/local-verify']) });
    await g.refresh();
    expect(g.checkRequired()).toBe(true);
    expect(g.checkRequiredKnown()).toBe(true);
  });
});
