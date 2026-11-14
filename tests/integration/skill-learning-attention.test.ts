/**
 * Tier-2 integration — Skill Learning Sentinel attention items 1–6 (docs/specs/skill-learning-sentinel.md §3.10)
 * over the REAL TelegramAdapter attention store (its HTTP layer stubbed) and the real `GET /attention` route:
 * a notice fires on exactly the listed conditions AFTER their heals, never on the other side of each threshold,
 * lands as one row per condition, and closes `cause-cleared` when the condition goes away.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SkillLearningAttention } from '../../src/monitoring/skillLearning/SkillLearningAttention.js';
import type { SkillLearningHealOutcome, SkillLearningSignals } from '../../src/monitoring/skillLearning/types.js';
import type { Admission } from '../../src/monitoring/selfaction/types.js';
import { SKILL_LEARNING_DEFAULTS } from '../../src/config/ConfigDefaults.js';

const PROJECT_NAME = 'skill-learning-attention-int';
const HUB = 5252;
const NOW = Date.parse('2026-11-06T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
let AUTH = '';
let tmpDir: string;
let adapter: TelegramAdapter;

function buildCtx(telegram: TelegramAdapter): RouteContext {
  return {
    config: { projectName: PROJECT_NAME, projectDir: tmpDir, stateDir: path.join(tmpDir, '.instar'), port: 0, authToken: AUTH } as never,
    telegram,
    meshSelfId: null, machinePoolRegistry: null, resolvePeerUrls: null,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as never,
    sessionManager: null, scheduler: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(),
  } as unknown as RouteContext;
}

function makeAdapter(): TelegramAdapter {
  const a = new TelegramAdapter(
    { token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, attentionHubFilter: 'all', getAttentionHubTopicId: () => HUB },
    tmpDir,
  );
  vi.spyOn(a as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
    .mockImplementation(async () => ({ ok: true, message_id: 1, message_thread_id: 9999 }));
  return a;
}

function sig(over: Partial<SkillLearningSignals> = {}): SkillLearningSignals {
  return { at: NOW, holdsLease: true, live: true, epoch: 1, harmRetired: [], indexCostTooHigh: [], refusalStreaks: {}, classifier: { calls24h: 0, failures24h: 0 }, skills: [], revertBreakers: [], splitBrain: [], createdLast7d: [], ...over };
}

function controller(clock: { now: number }, heal: SkillLearningHealOutcome) {
  const heals = { revertFirst: vi.fn(async () => heal), retireLowestUnused: vi.fn(async () => heal), swapDrafterFamily: vi.fn(async () => heal), swapClassifierFamily: vi.fn(async () => heal) };
  const ctl = new SkillLearningAttention({
    stateDir: path.join(tmpDir, '.instar'), machineId: 'm1',
    config: { growthSignals: { createdPerWeekNotice: 3 }, retire: { ...SKILL_LEARNING_DEFAULTS.retire } },
    heals,
    createAttentionItem: (obs) => adapter.createAttentionItem(obs),
    clearAttentionCondition: (match, resolution, options) => adapter.clearAttentionCondition(match, resolution, options),
    admit: async () => ({ outcome: 'allow', token: { id: 't' }, reason: 'allow' } as unknown as Admission),
    consumeToken: () => ({ proceed: true, valid: true }),
    now: () => clock.now,
  });
  const tick = async (over: Partial<SkillLearningSignals> = {}) => { const s = await ctl.tick(sig({ at: clock.now, ...over })); await ctl.settle(); return s; };
  return { ctl, heals, tick };
}

const open = () => adapter.getAttentionItems('OPEN').filter((i) => i.category === 'skill-learning');
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

describe('skill-learning attention items through the real attention store', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sl-attn-int-'));
    fs.mkdirSync(path.join(tmpDir, '.instar'), { recursive: true });
    AUTH = generateAgentToken(PROJECT_NAME);
    adapter = makeAdapter();
  });
  afterEach(async () => {
    deleteAgentToken(PROJECT_NAME);
    await adapter?.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  it('item 1: the bounded revert runs three times (1 h, 6 h backoff) before ONE row lands; it reads back from GET /attention; the cause clearing closes it cause-cleared', async () => {
    const clock = { now: NOW };
    const c = controller(clock, { healed: false, reason: 'fence-aborted' });
    const cond = { harmRetired: [{ skill: 'bad-skill', version: 3, reason: 'harm: deleted the wrong branch' }] };
    await c.tick(cond);
    clock.now = NOW + 61 * MIN; await c.tick(cond);
    expect(c.heals.revertFirst).toHaveBeenCalledTimes(2);
    expect(open()).toEqual([]);                                                  // still healing: the operator hears nothing
    clock.now = NOW + 61 * MIN + 6 * HOUR + MIN; await c.tick(cond);          // the 3rd failure exhausts and notifies in the same turn
    expect(c.heals.revertFirst).toHaveBeenCalledTimes(3);
    const rows = open();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'skill-learning:1:bad-skill', conditionKey: 'skill-learning:1:bad-skill', category: 'skill-learning', priority: 'HIGH', needsUser: true, status: 'OPEN', sourceContext: 'skill-learning-sentinel' });
    expect(rows[0].summary).toContain('three times');
    clock.now += 10 * MIN;
    const s = await c.tick(cond);
    expect(s.verdicts[0]).toMatchObject({ outcome: 'terminal', reason: 'exhausted:max-attempts' });
    // Repeats fold onto the same row.
    clock.now += DAY; await c.tick(cond); await c.tick(cond);
    expect(open()).toHaveLength(1);
    expect(c.heals.revertFirst).toHaveBeenCalledTimes(3);
    // The real route serves it.
    const app = express(); app.use(express.json()); app.use('/', createRoutes(buildCtx(adapter)));
    const res = await request(app).get('/attention?status=OPEN').set(auth());
    expect(res.status).toBe(200);
    expect((res.body.items as Array<{ id: string }>).map((i) => i.id)).toContain('skill-learning:1:bad-skill');
    // The operator restores the skill: the condition is gone ⇒ the row closes cause-cleared with the resolution.
    clock.now += HOUR;
    const cleared = await c.tick({});
    expect(cleared.cleared).toBe(1);
    expect(open()).toEqual([]);
    const closed = adapter.getAttentionItem('skill-learning:1:bad-skill');
    expect(closed).toMatchObject({ status: 'DONE', closedBy: 'cause-cleared', resolution: 'the condition cleared on its own' });
  });

  it('each threshold: a row only on the listed side, after the heal; the other side of every threshold leaves the store empty', async () => {
    const min = SKILL_LEARNING_DEFAULTS.retire.minCorroboratedRuns;
    const made = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `p-${i}`, kind: 'proposal' as const, arbiterOnly: false, createdAt: new Date(NOW - i * HOUR).toISOString() }));
    const clock = { now: NOW };
    const c = controller(clock, { healed: true });
    // Below / at every threshold: nothing fires, no heal runs for items 3/4.
    await c.tick({
      refusalStreaks: { 'ci-health': 4 }, classifier: { calls24h: 10, failures24h: 5 },
      skills: [{ name: 'quiet', measurableRate: 0.1, uses: min - 1, corroborated: 0, locked: false }],
      createdLast7d: made(3),
    });
    expect(open()).toEqual([]);
    expect(c.heals.swapDrafterFamily).not.toHaveBeenCalled();
    expect(c.heals.swapClassifierFamily).not.toHaveBeenCalled();
    // Over every threshold: items 3/4 heal (and heal succeeds ⇒ no row); items 5/6 are notify-only ⇒ rows now.
    await c.tick({
      refusalStreaks: { 'ci-health': 5 }, classifier: { calls24h: 10, failures24h: 6 },
      skills: [{ name: 'quiet', measurableRate: 0.1, uses: min, corroborated: 0, locked: false }],
      createdLast7d: made(4), revertBreakers: [{ key: 'deploy', skill: 'deploy-notes', at: '2026-11-06T11:00:00Z' }], splitBrain: [{ name: 'alpha' }],
    });
    expect(c.heals.swapDrafterFamily).toHaveBeenCalledTimes(1);
    expect(c.heals.swapClassifierFamily).toHaveBeenCalledTimes(1);
    expect(open().map((i) => i.id).sort()).toEqual([
      'skill-learning:5:revert-breaker.deploy', 'skill-learning:5:split-brain.alpha', 'skill-learning:5:unmeasured.quiet', 'skill-learning:6:growth',
    ]);
    const growth = adapter.getAttentionItem('skill-learning:6:growth');
    expect(growth).toMatchObject({ priority: 'NORMAL', needsUser: false, silent: true });
    expect(adapter.getAttentionItem('skill-learning:5:unmeasured.quiet')).toMatchObject({ priority: 'NORMAL', needsUser: true });
    // The swaps did not hold: a refusal / more failures after them ⇒ the items 3/4 rows, one each, no second swap.
    await c.tick({ refusalStreaks: { 'ci-health': 6 }, classifier: { calls24h: 20, failures24h: 14 }, skills: [{ name: 'quiet', measurableRate: 0.1, uses: min, corroborated: 0, locked: false }], createdLast7d: made(4), revertBreakers: [{ key: 'deploy', at: '2026-11-06T11:00:00Z' }], splitBrain: [{ name: 'alpha' }] });
    expect(c.heals.swapDrafterFamily).toHaveBeenCalledTimes(1);
    expect(c.heals.swapClassifierFamily).toHaveBeenCalledTimes(1);
    expect(open().map((i) => i.id).sort()).toEqual([
      'skill-learning:3:ci-health', 'skill-learning:4:classifier', 'skill-learning:5:revert-breaker.deploy', 'skill-learning:5:split-brain.alpha', 'skill-learning:5:unmeasured.quiet', 'skill-learning:6:growth',
    ]);
    // Everything clears ⇒ every row closes cause-cleared; nothing is left open.
    await c.tick({});
    expect(open()).toEqual([]);
    expect(adapter.getAttentionItems().filter((i) => i.category === 'skill-learning').every((i) => i.status === 'DONE' && i.closedBy === 'cause-cleared')).toBe(true);
  });

  it('a standby (not the lease holder) writes nothing into the attention store and runs no heal', async () => {
    const clock = { now: NOW };
    const c = controller(clock, { healed: false, reason: 'no' });
    const s = await c.tick({ holdsLease: false, harmRetired: [{ skill: 'bad', version: 1 }], createdLast7d: Array.from({ length: 9 }, (_, i) => ({ name: `p${i}`, kind: 'proposal' as const, arbiterOnly: false, createdAt: new Date(NOW).toISOString() })) });
    expect(s.governed).toBe(2);
    expect(c.heals.revertFirst).not.toHaveBeenCalled();
    expect(adapter.getAttentionItems()).toEqual([]);
  });
});
