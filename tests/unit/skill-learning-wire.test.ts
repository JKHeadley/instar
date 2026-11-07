/**
 * Skill Learning Sentinel — production wiring (spec docs/specs/skill-learning-sentinel.md, slice 1).
 *
 * The second-pass reviewer's blocking finding was "no production wiring": the links counted messages but nothing
 * constructed the sentinel. These tests pin the wiring helper's behaviour on both sides of every boundary and a
 * source-level integrity check that server.ts really calls it and hands the result to AgentServer (the
 * Testing-Integrity "wiring integrity" tier — deps not null, not no-ops).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_LEARNING_DEFAULTS } from '../../src/config/ConfigDefaults.js';
import os from 'node:os';
import { resolveSkillLearningConfig, startSkillLearning, skillLearningEnv, type StartSkillLearningInput } from '../../src/monitoring/skillLearning/wire.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

const baseInput = (over: Partial<StartSkillLearningInput> = {}): StartSkillLearningInput => ({
  reconciler: { start: () => {} },
  rawConfig: { monitoring: { skillLearning: { ...SKILL_LEARNING_DEFAULTS, enabled: true } } },
  projectDir: '/nonexistent/project',
  stateDir: '/nonexistent/state',
  machineId: 'm_test',
  sharedIntelligence: null,
  topicMemory: null,
  operatorStore: () => null,
  provenance: () => null,
  ...over,
});

describe('resolveSkillLearningConfig', () => {
  it('is dark and shadow when the block is absent', () => {
    const c = resolveSkillLearningConfig({});
    expect(c.enabled).toBe(false);
    expect(c.mode).toBe('shadow');
    expect(c.tickMinutes).toBe(SKILL_LEARNING_DEFAULTS.tickMinutes);
    expect(c.defaultGate).toEqual(SKILL_LEARNING_DEFAULTS.defaultGate);
  });

  it('honours enabled + mode and merges a partial sub-block over the defaults', () => {
    const c = resolveSkillLearningConfig({ monitoring: { skillLearning: { enabled: true, mode: 'live', llm: { maxDailyCents: 5 } } } });
    expect(c.enabled).toBe(true);
    expect(c.mode).toBe('live');
    expect(c.llm).toEqual({ ...SKILL_LEARNING_DEFAULTS.llm, maxDailyCents: 5 });
  });

  it('treats any mode other than live as shadow and a non-boolean enabled as off', () => {
    const c = resolveSkillLearningConfig({ monitoring: { skillLearning: { enabled: 'yes', mode: 'LIVE' } } });
    expect(c.enabled).toBe(false);
    expect(c.mode).toBe('shadow');
  });
});

describe('startSkillLearning', () => {
  it('always starts the reconciler and returns null while the feature is dark', () => {
    let started = 0;
    const created: unknown[] = [];
    const out = startSkillLearning(
      baseInput({ reconciler: { start: () => { started++; } }, rawConfig: {} }),
      (deps) => { created.push(deps); throw new Error('must not be called'); },
    );
    expect(started).toBe(1);
    expect(out).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('builds, starts and returns the sentinel when enabled, with resolved config and lazy seams', () => {
    let startCalls = 0;
    const fake = { start: () => { startCalls++; }, stop: () => {} };
    let seen: Parameters<Parameters<typeof startSkillLearning>[1]>[0] | null = null;
    const out = startSkillLearning(baseInput(), (deps) => { seen = deps; return fake as never; });
    expect(out).toBe(fake);
    expect(startCalls).toBe(1);
    expect(seen).not.toBeNull();
    expect(seen!.config.enabled).toBe(true);
    expect(seen!.config.mode).toBe('shadow');
    expect(seen!.machineId).toBe('m_test');
  });

  it('fails CLOSED on provenance while the log is not constructed: null id, empty counters', () => {
    let seen: Parameters<Parameters<typeof startSkillLearning>[1]>[0] | null = null;
    startSkillLearning(baseInput({ provenance: () => null }), (deps) => { seen = deps; return { start() {}, stop() {} } as never; });
    expect(seen!.provenanceLog).not.toBeNull();
    expect(seen!.provenanceLog!.recordDecision({} as never)).toBeNull();
    expect(seen!.provenanceLog!.status()).toEqual({ counters: {} });
  });

  it('delegates to the real provenance log once it exists (not a no-op)', () => {
    const calls: unknown[] = [];
    let log: { recordDecision(i: unknown): string | null; status(): { counters: Record<string, number> } } | null = null;
    let seen: Parameters<Parameters<typeof startSkillLearning>[1]>[0] | null = null;
    startSkillLearning(baseInput({ provenance: () => log }), (deps) => { seen = deps; return { start() {}, stop() {} } as never; });
    log = { recordDecision: (i) => { calls.push(i); return 'dec-1'; }, status: () => ({ counters: { writeErrors: 2 } }) };
    expect(seen!.provenanceLog!.recordDecision({ decisionPoint: 'x' } as never)).toBe('dec-1');
    expect(calls).toHaveLength(1);
    expect(seen!.provenanceLog!.status().counters.writeErrors).toBe(2);
  });

  it('answers "not operator" while the topic-operator store is absent, and delegates once present', () => {
    let store: { asVerifiedOperator(t: number | string): { uid: string } | null } | null = null;
    let seen: Parameters<Parameters<typeof startSkillLearning>[1]>[0] | null = null;
    startSkillLearning(baseInput({ operatorStore: () => store }), (deps) => { seen = deps; return { start() {}, stop() {} } as never; });
    expect(seen!.topicOperatorStore.asVerifiedOperator('139880')).toBeNull();
    store = { asVerifiedOperator: (t) => (String(t) === '139880' ? { uid: '42' } : null) };
    expect(seen!.topicOperatorStore.asVerifiedOperator('139880')).toEqual({ uid: '42' });
    expect(seen!.topicOperatorStore.asVerifiedOperator('1')).toBeNull();
  });

  it('never throws: a failing create() leaves the feature dark and reports a degradation', () => {
    const reports: Array<{ feature: string; reason: string }> = [];
    const logs: string[] = [];
    const out = startSkillLearning(
      baseInput({ degradationReporter: { report: (e) => reports.push(e) }, logger: (m) => logs.push(m) }),
      () => { throw new Error('boom'); },
    );
    expect(out).toBeNull();
    expect(reports).toHaveLength(1);
    expect(reports[0].feature).toBe('monitoring.skillLearning');
    expect(reports[0].reason).toBe('boom');
    expect(logs.some((l) => l.includes('NOT started'))).toBe(true);
  });

  it('a failing sentinel.start() is also contained', () => {
    const out = startSkillLearning(baseInput(), () => ({ start() { throw new Error('cache open failed'); }, stop() {} }) as never);
    expect(out).toBeNull();
  });
});

describe('server.ts production wiring (source-level integrity)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/commands/server.ts'), 'utf-8');

  it('calls startSkillLearning exactly once, after the reconciler, with the real seams', () => {
    const calls = src.match(/startSkillLearning\(\{/g) ?? [];
    expect(calls).toHaveLength(1);
    const at = src.indexOf('startSkillLearning({');
    const stmt = src.slice(at, src.indexOf('\n', at));
    for (const seam of ['reconciler: learnedSkillReconciler', 'provenance: () => _judgmentProvenance', 'operatorStore: () => _agentServerRef?.getTopicOperatorStore()', 'skillLearningEnv({ config, identity: coordinator.identity, telegram, slack: slackAdapter, sharedIntelligence, topicMemory })', 'holdsLease:', 'featureEvidence', 'ladder: () => _agentServerRef?.getMaturationLadder() ?? null']) {
      expect(stmt, seam).toContain(seam);
    }
    expect(stmt).toContain('SkillLearningSentinel.create(deps)');
  });

  it('binds the sentinel to AgentServer on its own line after the server reference is stored, before start()', () => {
    const ctor = src.indexOf('const server = new AgentServer({');
    const ref = src.indexOf('_agentServerRef = server;');
    const bind = src.indexOf('server.setSkillLearningSentinel(skillLearningSentinel);');
    const start = src.indexOf('await server.start();');
    expect(ctor).toBeGreaterThan(0);
    expect(ref).toBeGreaterThan(ctor);
    expect(bind).toBeGreaterThan(ref);
    expect(start).toBeGreaterThan(bind);
    // Not an argument on the constructor line every PR extends.
    expect(src.slice(ctor, src.indexOf('\n', ctor))).not.toContain('skillLearningSentinel');
    expect(src).not.toContain('learnedSkillReconciler.start();');
  });

  it('keeps the conditional wiring out of startServer (TS2563): the env helper owns the branches', () => {
    const at = src.indexOf('startSkillLearning({');
    const stmt = src.slice(at, src.indexOf('\n', at));
    for (const forbidden of ['os.hostname()', 'telegram ?', 'slackAdapter ??', 'sharedIntelligence ??', 'topicMemory ??', 'new UserManager(', 'DegradationReporter.getInstance()']) {
      expect(stmt, forbidden).not.toContain(forbidden);
    }
  });
});

describe('skillLearningEnv', () => {
  const config = { stateDir: '/tmp/x', users: [] } as unknown as Parameters<typeof skillLearningEnv>[0]['config'];
  it('falls back to the hostname and null collaborators when nothing is wired', () => {
    const env = skillLearningEnv({ config, identity: null, telegram: null, slack: undefined, sharedIntelligence: undefined, topicMemory: undefined });
    expect(env.machineId).toBe(os.hostname());
    expect(env.sharedIntelligence).toBeNull();
    expect(env.topicMemory).toBeNull();
    expect(env.slack).toBeNull();
    expect(env.createAttentionItem).toBeUndefined();
    expect(env.clearAttentionCondition).toBeUndefined();
    expect(env.degradationReporter).toBe(DegradationReporter.getInstance());
    expect(typeof env.userManager?.listUsers).toBe('function');
  });
  it('uses the mesh machine id and forwards attention calls to the adapter', () => {
    const calls: string[] = [];
    const telegram = { createAttentionItem: (item: never) => { calls.push('create:' + JSON.stringify(item)); return 1; }, clearAttentionCondition: (sel: { conditionKey: string }) => { calls.push('clear:' + sel.conditionKey); return 2; } };
    const env = skillLearningEnv({ config, identity: { machineId: 'm_mesh' }, telegram, slack: { onMessageLogged: null }, sharedIntelligence: null, topicMemory: null });
    expect(env.machineId).toBe('m_mesh');
    expect(env.createAttentionItem!({ title: 't' } as never)).toBe(1);
    expect(env.clearAttentionCondition!({ conditionKey: 'k' }, 'r', { reconcile: true })).toBe(2);
    expect(calls).toEqual(['create:{"title":"t"}', 'clear:k']);
    expect(env.slack).toEqual({ onMessageLogged: null });
  });
});
