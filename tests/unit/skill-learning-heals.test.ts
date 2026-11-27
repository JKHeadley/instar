// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
/**
 * Slice 3 integration of the heals (docs/specs/skill-learning-sentinel.md §3.10 items 1–4, "Self-Heal Before
 * Notify"): `SkillLearningSentinel.create()` constructs the attention controller over the sentinel's own heals —
 * (1) the bounded revert (Reverter.revertOne), (2) the Retirer's lowest-unused retirement (late-bound), (3) the
 * per-key drafter family rotation, (4) the classifier's bounded failure swap — and each heal is bounded, persisted
 * and honest about `terminal` (Testing Integrity: wiring integrity).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SkillLearningSentinel, type SkillLearningSentinelDeps, type ClassifierDoor } from '../../src/monitoring/SkillLearningSentinel.js';
import { installSkillLearningSeamFilter } from '../../src/monitoring/skillLearning/SeamFilter.js';
import { parseSkillDoc } from '../../src/monitoring/skillLearning/Drafter.js';
import type { SkillLearningHealOutcome } from '../../src/monitoring/skillLearning/types.js';
import { DAY, FakeLedger, KEY, NOW, SKILL_NAME, canonicalPath, cfg, cleanupHomes, fam, harness, mkHome, readLog, sha256, type Home } from '../helpers/skillLearningLiveFixtures.js';

afterEach(() => { cleanupHomes(); installSkillLearningSeamFilter(null); });

type CreateInput = Parameters<typeof SkillLearningSentinel.create>[0];
type Deps = SkillLearningSentinelDeps;
const depsOf = (s: SkillLearningSentinel): Deps => (s as unknown as { deps: Deps }).deps;
const statePath = (home: Home) => path.join(home.stateDir, 'skill-learning', 'sentinel-state.m1.json');
const readState = (home: Home) => JSON.parse(fs.readFileSync(statePath(home), 'utf-8')) as Record<string, unknown>;

function created(home: Home, over: Partial<CreateInput> = {}) {
  const built: string[] = [];
  const shared = { calls: [] as string[], evaluate: async (p: string) => { shared.calls.push(p); return `shared:${p}`; } };
  const sentinel = SkillLearningSentinel.create({
    projectDir: home.root, stateDir: home.stateDir, machineId: 'm1', config: cfg({ mode: 'live' }), readMode: () => 'live',
    frameworks: { enabled: ['claude-code', 'codex-cli'], default: 'claude-code' },
    sharedIntelligence: shared,
    topicMemory: { getMessagesSince: () => ({ messages: [], complete: true }) },
    topicOperatorStore: { asVerifiedOperator: () => ({ uid: '1' }) },
    provenanceLog: { recordDecision: () => 'jp', status: () => ({ counters: { writeErrors: 0 } }) },
    buildProvider: (fw) => { built.push(fw); return { evaluate: async (p) => `${fw}:${p}` }; },
    now: () => NOW,
    ...over,
  });
  return { sentinel, built, shared };
}

describe('create() builds the attention controller over the sentinel\'s heals', () => {
  it('a SkillLearningAttention is constructed by default (its episode store lands under stateDir), an injected one wins, null disables', () => {
    const home = mkHome();
    const a = created(home);
    expect(a.sentinel.attention()).not.toBeNull();
    expect(typeof a.sentinel.attention()!.tick).toBe('function');
    const fake = { tick: async () => 'fake' };
    expect(created(mkHome(), { attention: fake }).sentinel.attention()).toBe(fake);
    expect(created(mkHome(), { attention: null }).sentinel.attention()).toBeNull();
    // The controller's cause-clear goes through the injected adapter seam (clearAttentionCondition) — present on the create input.
    const clears: unknown[] = [];
    const b = created(mkHome(), { clearAttentionCondition: (sel, reason, opts) => { clears.push([sel, reason, opts]); return { closed: 1, refusedSticky: 0 }; } });
    expect(b.sentinel.attention()).not.toBeNull();
  });

  it('the attention phase runs inside the tick on the holder without a phase failure (real controller, no conditions)', async () => {
    const home = mkHome();
    const { sentinel } = created(home);
    const s = await sentinel.tick();
    expect(s.phaseFailures).toEqual([]);
  });
});

describe('item 3 — healSwapDrafterFamily rotates the drafter for ONE key, persisted; one family ⇒ terminal', () => {
  it('two families: healed, the swap is in the state file, families(key) puts the other framework first, other keys and the base order are untouched; a restart keeps it', async () => {
    const home = mkHome();
    const { sentinel } = created(home);
    const deps = depsOf(sentinel);
    expect(deps.families(KEY).map((f) => f.framework)).toEqual(['claude-code', 'codex-cli']);
    const out = await sentinel.healSwapDrafterFamily({ key: KEY, streak: 5 });
    expect(out).toEqual({ healed: true, detail: expect.stringContaining('anthropic → openai (codex-cli)') });
    expect(deps.families(KEY).map((f) => f.framework)).toEqual(['codex-cli', 'claude-code']);
    expect(deps.families().map((f) => f.framework)).toEqual(['claude-code', 'codex-cli']);
    expect(deps.families('another-key').map((f) => f.framework)).toEqual(['claude-code', 'codex-cli']);
    expect(readState(home).drafterSwaps).toEqual({ [KEY]: { from: 'anthropic', to: 'codex-cli', family: 'openai', at: new Date(NOW).toISOString() } });
    expect(readLog(home).find((r) => r.kind === 'drafter-family-swap')).toMatchObject({ key: KEY, streak: 5, from: 'anthropic', to: 'openai', framework: 'codex-cli' });
    // A fresh sentinel over the same state reads the swap; a second heal rotates back (the controller bounds the attempts, not this).
    const again = created(home);
    expect(depsOf(again.sentinel).families(KEY).map((f) => f.framework)).toEqual(['codex-cli', 'claude-code']);
    const back = await again.sentinel.healSwapDrafterFamily({ key: KEY, streak: 6 });
    expect(back).toMatchObject({ healed: true, detail: expect.stringContaining('openai → anthropic') });
    expect(depsOf(again.sentinel).families(KEY).map((f) => f.framework)).toEqual(['claude-code', 'codex-cli']);
  });

  it('one family reachable ⇒ {healed:false, reason:one-family, terminal:true}; nothing persisted', async () => {
    const home = mkHome();
    const { sentinel } = created(home, { frameworks: { enabled: ['claude-code'], default: 'claude-code' } });
    expect(await sentinel.healSwapDrafterFamily({ key: KEY, streak: 5 })).toMatchObject({ healed: false, reason: 'one-family', terminal: true });
    expect(fs.existsSync(statePath(home))).toBe(false);
    const none = created(mkHome(), { buildProvider: () => null });
    expect(await none.sentinel.healSwapDrafterFamily({ key: KEY, streak: 5 })).toMatchObject({ healed: false, reason: 'no-family', terminal: true });
  });
});

describe('item 4 — healSwapClassifierFamily points the classifier door at another family once, persisted and restored on boot', () => {
  const classifierDoorOf = (s: SkillLearningSentinel): { door: ClassifierDoor; evaluate: (p: string) => Promise<string> } => {
    const deps = depsOf(s);
    const classifier = deps.classifier as unknown as { deps: { intelligence: { evaluate(p: string): Promise<string> } | null } };
    return { door: deps.classifierDoor!, evaluate: (p) => classifier.deps.intelligence!.evaluate(p) };
  };

  it('before the swap the shared router answers the classifier; after it the codex provider does; the swap is in the state file and a restart restores the door', async () => {
    const home = mkHome();
    const a = created(home);
    const { door, evaluate } = classifierDoorOf(a.sentinel);
    expect(door.current()).toBe('claude-code');
    expect(await evaluate('q1')).toBe('shared:q1');
    expect(a.shared.calls).toEqual(['q1']);
    const out = await a.sentinel.healSwapClassifierFamily({ failures24h: 6, calls24h: 10, rate: 0.6 });
    expect(out).toEqual({ healed: true, detail: expect.stringContaining('claude-code → codex-cli (openai)') });
    expect(door.current()).toBe('codex-cli');
    expect(await evaluate('q2')).toBe('codex-cli:q2');
    expect(a.shared.calls).toEqual(['q1']);
    expect(a.built).toContain('codex-cli');
    expect(readState(home).classifierDoor).toEqual({ framework: 'codex-cli', family: 'openai', at: new Date(NOW).toISOString() });
    expect(readLog(home).find((r) => r.kind === 'classifier-family-swap')).toMatchObject({ from: 'claude-code', to: 'codex-cli', failures24h: 6, calls24h: 10, rate: 0.6 });
    const b = created(home);
    const restored = classifierDoorOf(b.sentinel);
    expect(restored.door.current()).toBe('codex-cli');
    expect(await restored.evaluate('q3')).toBe('codex-cli:q3');
    expect(b.shared.calls).toEqual([]);
  });

  it('no alternate family ⇒ terminal no-alternate-family; an unbuildable alternate ⇒ swap-failed (not terminal); no shared router ⇒ the door still swaps for the per-framework providers', async () => {
    const one = created(mkHome(), { frameworks: { enabled: ['claude-code'], default: 'claude-code' } });
    expect(await one.sentinel.healSwapClassifierFamily({ failures24h: 6, calls24h: 10, rate: 0.6 })).toMatchObject({ healed: false, reason: 'no-alternate-family', terminal: true });
    const broken = created(mkHome(), { buildProvider: (fw) => (fw === 'codex-cli' ? null : { evaluate: async () => 'x' }) });
    expect(await broken.sentinel.healSwapClassifierFamily({ failures24h: 6, calls24h: 10, rate: 0.6 })).toMatchObject({ healed: false, reason: 'swap-failed' });
    expect((await broken.sentinel.healSwapClassifierFamily({ failures24h: 6, calls24h: 10, rate: 0.6 })).healed).toBe(false);
  });
});

describe('item 2 — healRetireLowestUnused delegates to the Retirer late-bound', () => {
  it('no retirer ⇒ retirer-unavailable (not terminal); a retirer with the method gets the input and its answer is returned and logged', async () => {
    const home = mkHome();
    const none = created(home, { retirer: null });
    expect(await none.sentinel.healRetireLowestUnused({ key: KEY, indexBytes: 9000, claudeHeadroomChars: 100 })).toEqual({ healed: false, reason: 'retirer-unavailable', detail: expect.any(String) });
    const calls: unknown[] = [];
    const answer: SkillLearningHealOutcome = { healed: false, reason: 'nothing-retirable', terminal: true };
    const fakeRetirer = { bind: () => undefined, retireLowestUnused: async (i: unknown) => { calls.push(i); return answer; } };
    const some = created(mkHome(), { retirer: fakeRetirer as never });
    expect(await some.sentinel.healRetireLowestUnused({ key: KEY, indexBytes: 9000, claudeHeadroomChars: 100 })).toBe(answer);
    expect(calls).toEqual([{ key: KEY, indexBytes: 9000, claudeHeadroomChars: 100 }]);
    const legacy = created(mkHome(), { retirer: { bind: () => undefined } as never });
    expect(await legacy.sentinel.healRetireLowestUnused({ key: KEY, indexBytes: null, claudeHeadroomChars: null })).toMatchObject({ reason: 'retirer-unavailable' });
  });
});

describe('item 1 — healRevertFirst runs the Reverter\'s bounded revert for one skill/version through the protocol', () => {
  const BODY1 = '# CI health report\n\n1. Read the CI health route at /ci/health.\n2. Summarise failing jobs and the slowest runs in plain language.\n';
  const BODY2 = '# CI health report\n\n1. Read the CI health route at /ci/health.\n2. Summarise failing jobs, the slowest runs and the flaky tests in plain language.\n';
  const rawOf = (body: string, version: number) => [
    '---', `name: ${SKILL_NAME}`, 'description: "Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status."',
    'metadata:', '  instar-learned-origin: "skill-learning-sentinel"', `  instar-learned-key: "${KEY}"`, `  instar-learned-version: "${version}"`,
    `  instar-learned-created: "${new Date(NOW - 30 * DAY).toISOString()}"`, '  instar-learned-locked: "false"', '  instar-learned-state: "active"', '---', body,
  ].join('\n');

  it('a live v2 whose v1 body is kept ⇒ healed, v3 = v1\'s body lands with revertOf/rejectedBodyHash, logged heal-revert-first; a wrong version ⇒ healed:false (retryable); no review-capable store ⇒ terminal no-reverter', async () => {
    const home = mkHome();
    const h = harness(home, new FakeLedger(), [fam('anthropic', 'claude-code', () => { throw new Error('no model call'); })], { rungTwoProven: () => true }, cfg({ mode: 'live' }));
    const v1raw = rawOf(BODY1, 1); const v2raw = rawOf(BODY2, 2);
    h.protocol.versions.append(SKILL_NAME, { txId: 'tx-v1', fileHash: sha256(v1raw), bodyHash: sha256(BODY1), epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'create', state: 'active', at: new Date(NOW - 20 * DAY).toISOString() });
    h.protocol.versions.append(SKILL_NAME, { txId: 'tx-v2', fileHash: sha256(v2raw), bodyHash: sha256(BODY2), epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'patch', state: 'active', citedCorrections: ['c-a'], at: new Date(NOW - 10 * DAY).toISOString() });
    h.protocol.versions.storeBody(SKILL_NAME, sha256(v1raw), v1raw);
    fs.mkdirSync(path.dirname(canonicalPath(home)), { recursive: true });
    fs.writeFileSync(canonicalPath(home), v2raw);
    expect(await h.sentinel.healRevertFirst({ skill: SKILL_NAME, version: 1 })).toMatchObject({ healed: false, reason: 'version-mismatch' });
    expect(h.protocol.calls).toEqual([]);
    const out = await h.sentinel.healRevertFirst({ skill: SKILL_NAME, version: 2 });
    expect(out).toEqual({ healed: true, detail: "reverted to v1's body" });
    expect(h.protocol.calls.map((c) => c.op)).toEqual(['revert']);
    expect(parseSkillDoc(fs.readFileSync(canonicalPath(home), 'utf-8'))!.body).toBe(BODY1);
    expect(h.protocol.versions.rows(SKILL_NAME)[2]).toMatchObject({ version: 3, op: 'revert', revertOf: 'tx-v2', rejectedBodyHash: sha256(BODY2) });
    expect(readLog(home).filter((r) => r.kind === 'heal-revert-first').map((r) => [r.version, r.healed, r.reason ?? null])).toEqual([[1, false, 'version-mismatch'], [2, true, null]]);
    // Asked again for the same version: already reverted ⇒ healed (idempotent), no second write.
    expect(await h.sentinel.healRevertFirst({ skill: SKILL_NAME, version: 2 })).toMatchObject({ healed: true, detail: expect.stringContaining('already reverted') });
    expect(h.protocol.calls).toHaveLength(1);
    expect(await h.sentinel.healRevertFirst({ skill: 'Not Valid', version: 2 })).toMatchObject({ healed: false, reason: 'invalid-name', terminal: true });

    const minimal = harness(mkHome(), new FakeLedger(), [], { versionStore: { rows: () => [], expectedPrevHash: () => null, reconcileAfterSync: () => ({ kind: 'no-rows' }) } }, cfg({ mode: 'live' }));
    expect(await minimal.sentinel.healRevertFirst({ skill: SKILL_NAME, version: 2 })).toMatchObject({ healed: false, reason: 'no-reverter', terminal: true });
    // In shadow the write-heals never write: they answer `shadow` (retryable once live).
    // The live body is now v3 and the body before it is the rejected v2: a heal naming v3 is terminal (never revert to a rejected body).
    expect(await h.sentinel.healRevertFirst({ skill: SKILL_NAME, version: 3 })).toMatchObject({ healed: false, reason: 'reverted-to-rejected', terminal: true });
    const shadow = harness(mkHome(), new FakeLedger(), [], {}, cfg({ mode: 'shadow' }));
    expect(await shadow.sentinel.healRevertFirst({ skill: SKILL_NAME, version: 2 })).toMatchObject({ healed: false, reason: 'shadow' });
    expect(await shadow.sentinel.healRetireLowestUnused({ key: KEY, indexBytes: null, claudeHeadroomChars: null })).toMatchObject({ healed: false, reason: 'shadow' });
  });
});
