/**
 * SkillLearningAttention — Tier 1 (docs/specs/skill-learning-sentinel.md §3.10 attention items 1–6, the Self-Heal
 * Before Notify standard). Virtual clock, in-memory/tmp episode store, injected heals, no Telegram.
 *
 * Covered: per gated item the heal runs FIRST and no notice goes out while it succeeds; exactly one notice after 3
 * failed attempts (not eligible at 59 min, eligible at 61; then 6 h); the 4th heal of one key in 7 days escalates
 * (flap) and at 8 days it does not; the notice lands inside the 120 s ceiling of exhaustion; a non-holder neither
 * heals nor notifies (`governed: fence-stale`); items 5/6 notify with the numbers and run no heal, item 6 refuses
 * nothing; dedupe (same key twice → one row, different keys → two); cause cleared → `closedBy: 'cause-cleared'` and
 * the gate records healthy; dedupe keys match the gate's regex for hostile procedure keys; the real governor admits.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  SkillLearningAttention, JsonSelfHealEpisodeStore, ATTENTION_BRAKES, SKILL_LEARNING_HEAL_IDS,
  attentionDedupeKey, attentionKeyLabel, attentionConditionKey, deriveRefusalStreaks, deriveIndexCostStrikes, readLogTail,
  type SkillLearningAttentionOptions,
} from '../../src/monitoring/skillLearning/SkillLearningAttention.js';
import type { SkillLearningAttentionObservation, SkillLearningHealOutcome, SkillLearningSignals } from '../../src/monitoring/skillLearning/types.js';
import type { Admission } from '../../src/monitoring/selfaction/types.js';
import { SKILL_LEARNING_DEFAULTS } from '../../src/config/ConfigDefaults.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GATE_RE = /^[a-z0-9][a-z0-9._:-]{0,119}$/i;

const homes: string[] = [];
afterEach(() => { for (const d of homes.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'skill-learning-attention.test.ts' }); });

function sig(over: Partial<SkillLearningSignals> = {}): SkillLearningSignals {
  return {
    at: NOW, holdsLease: true, live: true, epoch: 7, harmRetired: [], indexCostTooHigh: [], refusalStreaks: {}, classifier: { calls24h: 0, failures24h: 0 },
    skills: [], revertBreakers: [], splitBrain: [], createdLast7d: [], ...over,
  };
}

interface Rig {
  ctl: SkillLearningAttention;
  clock: { now: number };
  items: SkillLearningAttentionObservation[];
  cleared: Array<{ conditionKey: string; resolution: string; options: unknown }>;
  heals: Record<'revertFirst' | 'retireLowestUnused' | 'swapDrafterFamily' | 'swapClassifierFamily', ReturnType<typeof vi.fn>>;
  stateDir: string;
  log(): Record<string, unknown>[];
  tick(over?: Partial<SkillLearningSignals>): Promise<Awaited<ReturnType<SkillLearningAttention['tick']>>>;
}

function rig(over: Partial<SkillLearningAttentionOptions> = {}, outcome: SkillLearningHealOutcome = { healed: true }): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-attn-'));
  homes.push(root);
  const stateDir = path.join(root, '.instar');
  const clock = { now: NOW };
  const items: SkillLearningAttentionObservation[] = [];
  const cleared: Rig['cleared'] = [];
  const heal = () => vi.fn(async () => outcome);
  const heals = { revertFirst: heal(), retireLowestUnused: heal(), swapDrafterFamily: heal(), swapClassifierFamily: heal() };
  const ctl = new SkillLearningAttention({
    stateDir, machineId: 'm1',
    config: { growthSignals: { createdPerWeekNotice: 3 }, retire: { ...SKILL_LEARNING_DEFAULTS.retire } },
    heals: heals as unknown as SkillLearningAttentionOptions['heals'],
    createAttentionItem: (obs) => { items.push(obs); },
    clearAttentionCondition: (match, resolution, options) => { cleared.push({ conditionKey: match.conditionKey, resolution, options }); return { closed: 1, refusedSticky: 0 }; },
    admit: async () => ({ outcome: 'allow', token: { id: 't' }, reason: 'allow' } as unknown as Admission),
    consumeToken: () => ({ proceed: true, valid: true }),
    now: () => clock.now,
    ...over,
  });
  const log = () => {
    const f = path.join(stateDir, 'logs', 'skill-learning.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };
  const tick = async (o: Partial<SkillLearningSignals> = {}) => { const s = await ctl.tick(sig({ at: clock.now, ...o })); await ctl.settle(); return s; };
  return { ctl, clock, items, cleared, heals, stateDir, log, tick };
}

const HARM = { harmRetired: [{ skill: 'bad-skill', version: 3, reason: 'harm: deleted the wrong branch' }] };

// ─── Gated items: heal first, notify only on exhaustion ───────────────────

describe('gated items — the heal runs first and the operator hears nothing while it succeeds', () => {
  it('item 1: a harm retirement runs the bounded revert; healed ⇒ no notice, and the same version does not re-run the heal', async () => {
    const r = rig();
    const s = await r.tick(HARM);
    expect(s.verdicts).toEqual([{ item: 1, key: 'bad-skill', outcome: 'attempted', reason: 'source-absent' }]);
    expect(r.heals.revertFirst).toHaveBeenCalledTimes(1);
    expect(r.heals.revertFirst).toHaveBeenCalledWith({ skill: 'bad-skill', version: 3 });
    expect(r.items).toEqual([]);
    const s2 = await r.tick(HARM);
    expect(s2.verdicts[0]).toMatchObject({ outcome: 'waiting' });
    expect(r.heals.revertFirst).toHaveBeenCalledTimes(1);
    expect(r.items).toEqual([]);
    expect(r.log().filter((row) => row.event === 'heal-result')[0]).toMatchObject({ kind: 'attention', item: 1, healed: true });
  });

  it('item 2: an index-cost strike asks the reviewer to retire the lowest unused skill; "nothing retirable" is terminal ⇒ one notice at once', async () => {
    const r = rig({}, { healed: false, reason: 'nothing-retirable', terminal: true });
    const cond = { indexCostTooHigh: [{ key: 'weekly-digest', name: 'weekly-digest', indexBytes: 48_000, claudeHeadroomChars: 1200, at: new Date(NOW - HOUR).toISOString() }] };
    await r.tick(cond);
    expect(r.heals.retireLowestUnused).toHaveBeenCalledWith({ key: 'weekly-digest', indexBytes: 48_000, claudeHeadroomChars: 1200 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: 'skill-learning:2:weekly-digest', conditionKey: 'skill-learning:2:weekly-digest', priority: 'HIGH', needsUser: true, silent: false, category: 'skill-learning', sourceContext: 'skill-learning-sentinel' });
    expect(r.items[0].summary).toContain('48,000 bytes');
    expect(r.items[0].summary).toContain('nothing-retirable');
    const s2 = await r.tick(cond);
    expect(s2.verdicts[0]).toMatchObject({ outcome: 'terminal' });
    expect(r.heals.retireLowestUnused).toHaveBeenCalledTimes(1);
    expect(r.items).toHaveLength(1);
  });

  it('item 1: a revert whose reverted version is judged harmful too notifies immediately (terminal), after exactly one heal', async () => {
    const r = rig({}, { healed: false, reason: 'reverted-version-harmful', terminal: true, detail: 'version 2 also deleted the branch' });
    await r.tick(HARM);
    expect(r.heals.revertFirst).toHaveBeenCalledTimes(1);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].summary).toContain('version 2 also deleted the branch');
  });

  it('item 3: 5 consecutive refusals swap the drafter family ONCE; 4 do not; a refusal after the swap notifies', async () => {
    const r = rig();
    await r.tick({ refusalStreaks: { 'ci-health': 4 } });
    expect(r.heals.swapDrafterFamily).not.toHaveBeenCalled();
    await r.tick({ refusalStreaks: { 'ci-health': 5 } });
    expect(r.heals.swapDrafterFamily).toHaveBeenCalledTimes(1);
    expect(r.heals.swapDrafterFamily).toHaveBeenCalledWith({ key: 'ci-health', streak: 5 });
    expect(r.items).toEqual([]);
    const s = await r.tick({ refusalStreaks: { 'ci-health': 5 } });       // nothing moved: the swap's effect is pending
    expect(s.verdicts[0]).toMatchObject({ outcome: 'waiting' });
    expect(r.heals.swapDrafterFamily).toHaveBeenCalledTimes(1);
    const s2 = await r.tick({ refusalStreaks: { 'ci-health': 6 } });      // refused again after the swap ⇒ the operator
    expect(s2.verdicts[0]).toMatchObject({ outcome: 'terminal', reason: 'swapped-once-still-failing' });
    expect(r.heals.swapDrafterFamily).toHaveBeenCalledTimes(1);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: 'skill-learning:3:ci-health', priority: 'HIGH', needsUser: true });
    expect(r.items[0].summary).toContain('6 consecutive');
  });

  it('item 4: a classifier failure rate strictly above 50 % over 24 h swaps the classifier family once; exactly 50 % does not', async () => {
    const r = rig();
    await r.tick({ classifier: { calls24h: 10, failures24h: 5 } });
    expect(r.heals.swapClassifierFamily).not.toHaveBeenCalled();
    await r.tick({ classifier: { calls24h: null, failures24h: 9 } });      // no denominator yet ⇒ no judgment
    expect(r.heals.swapClassifierFamily).not.toHaveBeenCalled();
    await r.tick({ classifier: { calls24h: 10, failures24h: 6 } });
    expect(r.heals.swapClassifierFamily).toHaveBeenCalledWith({ failures24h: 6, calls24h: 10, rate: 0.6 });
    expect(r.items).toEqual([]);
    await r.tick({ classifier: { calls24h: 12, failures24h: 8 } });       // more failures after the swap ⇒ notice
    expect(r.heals.swapClassifierFamily).toHaveBeenCalledTimes(1);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].summary).toContain('8 of 12');
    expect(r.items[0].summary).toContain('67%');
  });

  it('a missing heal function is a failed heal (not a silent skip): three attempts, then the notice', async () => {
    const r = rig({ heals: {} });
    r.clock.now = NOW; await r.tick(HARM);
    r.clock.now = NOW + 61 * MIN; await r.tick(HARM);
    expect(r.items).toEqual([]);
    r.clock.now = NOW + 61 * MIN + 6 * HOUR + MIN; await r.tick(HARM);
    expect(r.items).toHaveLength(1);                                             // the third failure exhausts in the same turn
    r.clock.now += 10 * MIN; const s = await r.tick(HARM);
    expect(s.verdicts[0]).toMatchObject({ outcome: 'terminal', reason: 'exhausted:max-attempts' });
    expect(r.items).toHaveLength(1);
    expect(r.log().filter((row) => row.event === 'heal-launched').every((row) => row.available === false)).toBe(true);
  });
});

describe('gated items — the brakes', () => {
  it('exactly one notice after 3 failed attempts: not eligible at 59 min, eligible at 61, then 6 h, then exhausted on the next tick', async () => {
    const r = rig({}, { healed: false, reason: 'fence-aborted' });
    expect((await r.tick(HARM)).verdicts[0]).toMatchObject({ outcome: 'attempted' });
    expect(r.heals.revertFirst).toHaveBeenCalledTimes(1);
    expect(r.items).toEqual([]);
    r.clock.now = NOW + 59 * MIN;
    expect((await r.tick(HARM)).verdicts[0]).toMatchObject({ outcome: 'backoff' });
    expect(r.heals.revertFirst).toHaveBeenCalledTimes(1);
    r.clock.now = NOW + 61 * MIN;
    expect((await r.tick(HARM)).verdicts[0]).toMatchObject({ outcome: 'attempted', reason: 'verification-failed' });   // the previous heal's recorded outcome
    expect(r.heals.revertFirst).toHaveBeenCalledTimes(2);
    r.clock.now = NOW + 61 * MIN + 6 * HOUR - MIN;
    expect((await r.tick(HARM)).verdicts[0]).toMatchObject({ outcome: 'backoff' });
    r.clock.now = NOW + 61 * MIN + 6 * HOUR + MIN;
    expect(r.items).toEqual([]);
    const third = await r.tick(HARM);                                            // the 3rd heal fails ⇒ exhausted + notice in THIS turn
    expect(third.verdicts[0]).toMatchObject({ outcome: 'attempted' });
    expect(r.heals.revertFirst).toHaveBeenCalledTimes(3);
    expect(r.items).toHaveLength(1);
    expect(r.log().filter((row) => row.event === 'gate' && row.outcome === 'exhausted')).toMatchObject([{ reason: 'max-attempts', sameTurn: true }]);
    r.clock.now += 10 * MIN;
    const after = await r.tick(HARM);
    expect(after.verdicts[0]).toMatchObject({ outcome: 'terminal', reason: 'exhausted:max-attempts' });
    expect(after.notices).toBe(0);
    expect(r.heals.revertFirst).toHaveBeenCalledTimes(3);                       // no 4th heal, ever
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: 'skill-learning:1:bad-skill', conditionKey: 'skill-learning:1:bad-skill', priority: 'HIGH', needsUser: true, silent: false });
    expect(r.items[0].summary).toContain('three times');
    expect(r.items[0].summary).toContain('Version 3');
    // The interval the spec bounds — last failed heal → notice — is 0 here (same turn), inside the 120 s ceiling.
    const notice = r.log().find((row) => row.event === 'notify');
    expect(notice).toMatchObject({ kind: 'attention', item: 1, withinCeiling: true, latencyMs: 0 });
    r.clock.now += DAY;
    await r.tick(HARM); await r.tick(HARM);
    expect(r.items).toHaveLength(1);                                             // deduped for as long as the condition lasts
    expect(r.heals.revertFirst).toHaveBeenCalledTimes(3);
  });

  it('positive control for the 120 s ceiling: a notice that only lands a tick (10 min) after the last failed heal FAILS the ceiling, is audited so, and reports a degradation', async () => {
    let refuse = true;
    const degradations: Array<{ primary: string; fallback: string }> = [];
    const r = rig({ createAttentionItem: (obs) => { if (refuse) throw new Error('attention store busy'); r.items.push(obs); }, degradation: { report: (e) => { degradations.push(e); } } }, { healed: false, reason: 'no' });
    r.clock.now = NOW; await r.tick(HARM);
    r.clock.now = NOW + 61 * MIN; await r.tick(HARM);
    r.clock.now = NOW + 61 * MIN + 6 * HOUR + MIN; await r.tick(HARM);          // 3rd failure: the same-turn notice is refused by the store
    expect(r.items).toEqual([]);
    expect(r.log().find((row) => row.event === 'notify-failed')).toMatchObject({ item: 1, reason: 'max-attempts' });
    refuse = false;
    r.clock.now += 10 * MIN;                                                     // the next tick retries, 10 minutes after the heal failed
    await r.tick(HARM);
    expect(r.items).toHaveLength(1);
    const notice = r.log().find((row) => row.event === 'notify');
    expect(notice).toMatchObject({ item: 1, reason: 'retry', latencyMs: 10 * MIN, withinCeiling: false });
    expect(Number(notice!.latencyMs)).toBeGreaterThan(ATTENTION_BRAKES.notificationLatencyCeilingMs);
    expect(degradations.map((d) => d.primary)).toContain('notice within 120 s of the last failed heal');
    expect(degradations.find((d) => d.primary.startsWith('notice within'))!.fallback).toBe(`notice sent after ${10 * MIN} ms`);
    await r.tick(HARM);
    expect(r.items).toHaveLength(1);                                             // the retry is consumed; no duplicate
  });

  it('shadow mode (live: false): items 1/2 are governed `shadow` with no heal; items 3–6 are unaffected', async () => {
    const r = rig();
    const s = await r.tick({
      live: false, ...HARM, indexCostTooHigh: [{ key: 'k2', indexBytes: 1, claudeHeadroomChars: null, at: new Date(NOW).toISOString() }],
      refusalStreaks: { k3: 5 }, classifier: { calls24h: 4, failures24h: 3 }, splitBrain: [{ name: 'alpha' }],
    });
    expect(s.verdicts.map((v) => [v.item, v.outcome, v.reason])).toEqual([
      [1, 'governed', 'shadow'], [2, 'governed', 'shadow'], [3, 'attempted', 'source-absent'], [4, 'attempted', 'source-absent'], [5, 'notified', 'notify-only'],
    ]);
    expect(r.heals.revertFirst).not.toHaveBeenCalled();
    expect(r.heals.retireLowestUnused).not.toHaveBeenCalled();
    expect(r.heals.swapDrafterFamily).toHaveBeenCalledTimes(1);
    expect(r.heals.swapClassifierFamily).toHaveBeenCalledTimes(1);
    expect(r.items.map((i) => i.id)).toEqual(['skill-learning:5:split-brain.alpha']);
    expect(r.log().filter((row) => row.event === 'governed' && row.reason === 'shadow').map((row) => row.item)).toEqual([1, 2]);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(r.stateDir, 'skill-learning', 'attention-state.m1.json'), 'utf-8')).episodes)).toHaveLength(2);  // only the live items opened episodes
  });

  it('flap: the 4th heal of one key inside 7 days escalates instead of healing; at 8 days it heals', async () => {
    const run = async (gapDays: number) => {
      const r = rig();
      for (let v = 3; v <= 5; v++) {
        r.clock.now = NOW + (v - 3) * DAY;
        const s = await r.tick({ harmRetired: [{ skill: 'flappy', version: v }] });
        expect(s.verdicts[0]).toMatchObject({ outcome: 'attempted' });
      }
      expect(r.heals.revertFirst).toHaveBeenCalledTimes(3);
      expect(r.items).toEqual([]);
      r.clock.now = NOW + gapDays * DAY;
      const s4 = await r.tick({ harmRetired: [{ skill: 'flappy', version: 6 }] });
      return { r, s4 };
    };
    const seven = await run(3);
    expect(seven.s4.verdicts[0]).toMatchObject({ outcome: 'exhausted', reason: 'flap' });
    expect(seven.r.heals.revertFirst).toHaveBeenCalledTimes(3);
    expect(seven.r.items).toHaveLength(1);
    expect(seven.r.items[0].summary).toContain('keeps coming back');
    const eight = await run(8);
    expect(eight.s4.verdicts[0]).toMatchObject({ outcome: 'attempted' });
    expect(eight.r.heals.revertFirst).toHaveBeenCalledTimes(4);
    expect(eight.r.items).toEqual([]);
  });

  it('not the lease holder ⇒ no heal and no notice: every condition is `governed: fence-stale` and the episode store is untouched', async () => {
    const store = new JsonSelfHealEpisodeStore(path.join(os.tmpdir(), `sl-attn-store-${process.pid}-${Date.now()}.json`));
    const r = rig({ episodeStore: store });
    const s = await r.tick({ holdsLease: false, ...HARM, refusalStreaks: { k: 9 }, skills: [{ name: 'x', measurableRate: 0, uses: 9, corroborated: 0, locked: false }] });
    expect(s.verdicts.every((v) => v.outcome === 'governed' && v.reason === 'fence-stale')).toBe(true);
    expect(s.verdicts).toHaveLength(3);
    expect(r.heals.revertFirst).not.toHaveBeenCalled();
    expect(r.heals.swapDrafterFamily).not.toHaveBeenCalled();
    expect(r.items).toEqual([]);
    expect(store.size()).toBe(0);
    expect(r.log().some((row) => row.event === 'governed' && row.reason === 'fence-stale')).toBe(true);
  });

  it('dedupe keys are `<item>.<24 hex>` and match the gate regex for any hostile procedure key; the gate never throws on them', async () => {
    const hostile = ['../../etc/passwd; DROP TABLE x; --', 'ключ с пробелами и 💥', 'a'.repeat(400), '\u0000\n\r'];
    for (const key of hostile) {
      const d = attentionDedupeKey(1, key);
      expect(d).toMatch(GATE_RE);
      expect(d).toMatch(/^1\.[0-9a-f]{24}$/);
      expect(attentionKeyLabel(key)).toMatch(/^h-[0-9a-f]{16}$/);
    }
    expect(attentionDedupeKey(1, 'a')).not.toBe(attentionDedupeKey(2, 'a'));
    expect(attentionKeyLabel('ci-health.v2')).toBe('ci-health.v2');
    const r = rig({}, { healed: false, reason: 'no' });
    const s = await r.tick({ harmRetired: [{ skill: hostile[0], version: 1 }], refusalStreaks: { [hostile[1]]: 5 } });
    expect(s.verdicts.map((v) => v.outcome)).toEqual(['attempted', 'attempted']);
    for (let i = 0; i < 3; i++) { r.clock.now += DAY; await r.tick({ harmRetired: [{ skill: hostile[0], version: 1 }] }); }
    expect(r.items[0].id).toBe(`skill-learning:1:${attentionKeyLabel(hostile[0])}`);
    expect(r.items[0].id).toMatch(/^skill-learning:1:h-[0-9a-f]{16}$/);
  });

  it('the real governor admits every heal gate (policy rows exist for all four ids)', async () => {
    const r = rig({ admit: undefined, consumeToken: undefined });
    const s = await r.tick({ ...HARM, indexCostTooHigh: [{ key: 'k2', indexBytes: 1, claudeHeadroomChars: null, at: new Date(NOW).toISOString() }], refusalStreaks: { k3: 5 }, classifier: { calls24h: 4, failures24h: 3 } });
    expect(s.verdicts.map((v) => [v.item, v.outcome])).toEqual([[1, 'attempted'], [2, 'attempted'], [3, 'attempted'], [4, 'attempted']]);
    expect(Object.values(SKILL_LEARNING_HEAL_IDS)).toHaveLength(4);
  });
});

// ─── Items 5 and 6: notify-only ───────────────────────────────────────────

describe('items 5 and 6 — notify with the numbers, heal nothing, refuse nothing', () => {
  it('item 5 unmeasured: below the measurable floor at minCorroboratedRuns ⇒ one NORMAL needsUser notice with the counts; one run short ⇒ nothing', async () => {
    const r = rig();
    const min = SKILL_LEARNING_DEFAULTS.retire.minCorroboratedRuns;
    await r.tick({ skills: [{ name: 'quiet-skill', measurableRate: 0.1, uses: min - 1, corroborated: 0, locked: false }] });
    expect(r.items).toEqual([]);
    await r.tick({ skills: [{ name: 'quiet-skill', measurableRate: 0.1, uses: min, corroborated: 0, locked: false }, { name: 'fine-skill', measurableRate: 0.9, uses: 20, corroborated: 18, locked: false }] });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: 'skill-learning:5:unmeasured.quiet-skill', priority: 'NORMAL', needsUser: true, silent: false });
    expect(r.items[0].summary).toContain(`ran ${min} times`);
    expect(r.items[0].summary).toContain('only 0 of those');
    for (const h of Object.values(r.heals)) expect(h).not.toHaveBeenCalled();
  });

  it('item 5 revert breaker and split-brain notify with their key/skill names, no gate (the verdict says notify-only)', async () => {
    const r = rig();
    const s = await r.tick({ revertBreakers: [{ key: 'ci-health', skill: 'ci-health-report', reason: 'revertBreakerPer30d', at: '2026-11-06T11:00:00Z' }], splitBrain: [{ name: 'deploy-notes' }] });
    expect(s.verdicts.map((v) => v.reason)).toEqual(['notify-only', 'notify-only']);
    expect(r.items.map((i) => i.id)).toEqual(['skill-learning:5:revert-breaker.ci-health', 'skill-learning:5:split-brain.deploy-notes']);
    expect(r.items[0].summary).toContain('ci-health-report');
    expect(r.items[1].summary).toContain('deploy-notes');
    expect(r.items.every((i) => i.needsUser && !i.silent)).toBe(true);
  });

  it('item 6 growth: more than createdPerWeekNotice in 7 days ⇒ ONE silent notice naming them, nothing refused; exactly the limit ⇒ nothing', async () => {
    const r = rig();
    const made = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `p-${i}`, kind: i % 2 ? 'proposal' as const : 'skill' as const, arbiterOnly: i === 1, createdAt: new Date(NOW - i * HOUR).toISOString() }));
    const s3 = await r.tick({ createdLast7d: made(3) });
    expect(r.items).toEqual([]);
    expect(s3.verdicts).toEqual([]);
    const s4 = await r.tick({ createdLast7d: made(4) });
    expect(s4.verdicts).toEqual([{ item: 6, key: 'growth', outcome: 'notified', reason: 'notify-only' }]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: 'skill-learning:6:growth', conditionKey: 'skill-learning:6:growth', priority: 'NORMAL', needsUser: false, silent: true });
    expect(r.items[0].title).toContain('4 skills');
    expect(r.items[0].summary).toContain('p-1 (proposal, arbiter-only)');
    expect(r.items[0].summary).toContain('nothing was refused');
    await r.tick({ createdLast7d: made(5) });
    expect(r.items).toHaveLength(1);                                             // one per condition episode
    for (const h of Object.values(r.heals)) expect(h).not.toHaveBeenCalled();
  });
});

// ─── Dedupe and cause-clear ───────────────────────────────────────────────

describe('dedupe and cause-clear', () => {
  it('the same key twice ⇒ one row (also across a restart of the controller); two keys ⇒ two rows', async () => {
    const r = rig();
    const two = { splitBrain: [{ name: 'alpha' }, { name: 'beta' }] };
    await r.tick(two);
    await r.tick(two);
    expect(r.items.map((i) => i.id)).toEqual(['skill-learning:5:split-brain.alpha', 'skill-learning:5:split-brain.beta']);
    // A new controller over the same state dir remembers the open rows.
    const again = new SkillLearningAttention({
      stateDir: r.stateDir, machineId: 'm1', config: { growthSignals: { createdPerWeekNotice: 3 }, retire: { ...SKILL_LEARNING_DEFAULTS.retire } }, heals: {},
      createAttentionItem: (obs) => { r.items.push(obs); }, clearAttentionCondition: () => ({ closed: 0, refusedSticky: 0 }), now: () => r.clock.now,
    });
    await again.tick(sig(two));
    expect(r.items).toHaveLength(2);
  });

  it('cause cleared ⇒ clearAttentionCondition({conditionKey}, …, {reconcile:true}), audited closedBy cause-cleared, and the gate records healthy', async () => {
    const r = rig({}, { healed: false, reason: 'fence-aborted' });
    // A gated episode: one failed attempt, then the harm retirement is gone (the operator restored it).
    await r.tick(HARM);
    // A notify-only item: split-brain resolved by the operator's pick.
    await r.tick({ ...HARM, splitBrain: [{ name: 'alpha' }] });
    expect(r.items.map((i) => i.id)).toEqual(['skill-learning:5:split-brain.alpha']);
    const s = await r.tick({});
    expect(s.cleared).toBe(1);
    expect(r.cleared).toEqual([{ conditionKey: 'skill-learning:5:split-brain.alpha', resolution: 'the condition cleared on its own', options: { reconcile: true } }]);
    const rows = r.log();
    expect(rows.find((row) => row.event === 'cause-cleared')).toMatchObject({ kind: 'attention', item: 5, conditionKey: 'skill-learning:5:split-brain.alpha', closedBy: 'cause-cleared', closed: 1 });
    expect(rows.find((row) => row.event === 'episode-closed')).toMatchObject({ item: 1, key: 'bad-skill', outcome: 'healed', reason: 'recorded-healthy' });
    // The recurrence starts a fresh attempt (the episode is recovered, not exhausted).
    r.clock.now += DAY;
    expect((await r.tick(HARM)).verdicts[0]).toMatchObject({ outcome: 'attempted' });
    expect(r.heals.revertFirst).toHaveBeenCalledTimes(2);
  });

  it('an exhausted episode whose cause clears is dropped from the store, so a later recurrence heals again instead of staying terminal', async () => {
    const r = rig({}, { healed: false, reason: 'no' });
    for (let i = 0; i < 4; i++) { r.clock.now = NOW + i * DAY; await r.tick(HARM); }
    expect(r.items).toHaveLength(1);
    const dedupe = attentionDedupeKey(1, 'bad-skill');
    const storeFile = path.join(r.stateDir, 'skill-learning', 'self-heal-episodes.m1.json');
    expect(fs.readFileSync(storeFile, 'utf-8')).toContain(dedupe);
    r.clock.now += DAY;
    await r.tick({});
    expect(r.cleared.map((c) => c.conditionKey)).toEqual([attentionConditionKey(1, 'bad-skill')]);
    expect(r.log().find((row) => row.event === 'episode-closed')).toMatchObject({ outcome: 'exhausted', removed: true });
    expect(fs.readFileSync(storeFile, 'utf-8')).not.toContain(dedupe);
    r.clock.now += DAY;
    expect((await r.tick(HARM)).verdicts[0]).toMatchObject({ outcome: 'attempted' });
    expect(r.heals.revertFirst).toHaveBeenCalledTimes(4);
  });

  it('a failed createAttentionItem is audited and reported, and retried on the next tick', async () => {
    let fail = true;
    const degradations: unknown[] = [];
    const r = rig({ createAttentionItem: (obs) => { if (fail) throw new Error('telegram down'); r.items.push(obs); }, degradation: { report: (e) => { degradations.push(e); } } });
    await r.tick({ splitBrain: [{ name: 'alpha' }] });
    expect(r.items).toEqual([]);
    expect(degradations).toHaveLength(1);
    expect(r.log().find((row) => row.event === 'notify-failed')).toMatchObject({ item: 5, error: 'telegram down' });
    fail = false;
    await r.tick({ splitBrain: [{ name: 'alpha' }] });
    expect(r.items).toHaveLength(1);
  });
});

// ─── Signals derived from the log tail ────────────────────────────────────

describe('signals from the sentinel log', () => {
  it('refusal streaks count the DRAFTER\'s consecutive refusals per key and reset on a draft; reviewer/evidence/commit refusals are neutral', () => {
    const rows = [
      { kind: 'draft-refused', key: 'a', reason: 'provider-error' },
      { kind: 'draft-refused', key: 'a', reason: 'lint:imperative' },
      { kind: 'draft-refused', key: 'a', reason: 'review' },                    // the reviewer's — neutral
      { kind: 'draft-refused', key: 'a', reason: 'provider-error', stage: 'review' },
      { kind: 'draft-refused', key: 'a', reason: 'evidence-cut' },
      { kind: 'draft-refused', key: 'a', reason: 'commit:aborted' },
      { kind: 'draft-refused', key: 'a', reason: 'unparseable' },
      { kind: 'draft-refused', key: 'b', reason: 'action:bad' },
      { kind: 'would-create', key: 'b', name: 'x' },
      { kind: 'draft-refused', key: 'b', reason: 'invalid-name' },
      { kind: 'draft-refused', key: 'c', reason: 'unrecorded' },
      { kind: 'covered-by', key: 'c', skill: 'y' },
    ];
    expect(deriveRefusalStreaks(rows)).toEqual({ a: 3, b: 1 });
  });

  it('index-cost strikes: the latest per key inside 7 days, with the measurement; older ones drop', () => {
    const at = (h: number) => new Date(NOW - h * HOUR).toISOString();
    const rows = [
      { kind: 'index-cost', verdict: 'strike', key: 'k', name: 'n1', indexBytes: 100, claudeHeadroomChars: 5, ts: at(30) },
      { kind: 'index-cost', verdict: 'strike', key: 'k', name: 'n2', indexBytes: 200, claudeHeadroomChars: null, ts: at(2) },
      { kind: 'index-cost', verdict: 'pass', key: 'k2', ts: at(1) },
      { kind: 'index-cost', verdict: 'strike', key: 'old', ts: at(24 * 8) },
    ];
    expect(deriveIndexCostStrikes(rows, NOW)).toEqual([{ key: 'k', name: 'n2', indexBytes: 200, claudeHeadroomChars: null, at: at(2) }]);
  });

  it('readLogTail returns the last bytes as rows, dropping the torn first line and any corrupt line', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-attn-log-'));
    homes.push(root);
    const f = path.join(root, 'skill-learning.jsonl');
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ kind: 'row', i }));
    lines.splice(40, 0, '{not json');
    fs.writeFileSync(f, `${lines.join('\n')}\n`);
    const rows = readLogTail(f, 300);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((r) => r.kind === 'row')).toBe(true);
    expect(rows[rows.length - 1]).toEqual({ kind: 'row', i: 49 });
    expect(readLogTail(path.join(root, 'absent.jsonl'))).toEqual([]);
  });
});
