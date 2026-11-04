import { describe, expect, it } from 'vitest';
import {
  computeLadderState, contractForRung, crossedRung, deriveLadderRung, isEvidenceFileAllowed, nextRung,
  parseLadderRegistry, projectionRef, soakDays, subjectFromId,
  type LadderEntry, type LadderMetric, type MetricReading,
} from '../../src/monitoring/MaturationLadder.js';

const DAY = 86_400_000;
const ranMetric: LadderMetric = { id: 'ran', role: 'ran', source: 'jsonl-log', ref: { file: 'logs/x.jsonl', value: 'count' }, direction: 'at-least', threshold: 5, minSamples: 1, windowDays: 14 };
const harmMetric: LadderMetric = { id: 'harm', role: 'harm', source: 'jsonl-log', ref: { file: 'logs/x.jsonl', where: { kind: 'error' }, of: { kind: 'fired' }, value: 'ratio' }, direction: 'at-most', threshold: 0.05, minSamples: 5, windowDays: 14 };
const rung = { soakDays: 7, advance: { kind: 'code' as const }, metrics: [ranMetric, harmMetric] };

function raw(over: Record<string, unknown> = {}) {
  return { id: 'monitoring.x', title: 'X', flag: { path: 'monitoring.x' }, disposition: 'ladder', final: 'default-on', risk: 'standard',
    tracking: { state: 'measured', plan: 'its own log' }, rungs: { fleet: rung }, ...over };
}
const parse = (...entries: unknown[]) => parseLadderRegistry(JSON.stringify({ schema: 'feature-ladders/1', entries }));
function entry(over: Record<string, unknown> = {}): LadderEntry {
  const r = parse(raw(over));
  if (!r.ok) throw new Error(r.reason);
  return r.registry.entries[0];
}

describe('parseLadderRegistry', () => {
  it('accepts a complete entry and derives a D7-safe subject', () => {
    const e = entry();
    expect(e.subject).toBe('monitoring-x');
    expect(e.aliases).toEqual([]);
  });

  it('refuses a bad file whole, naming the field', () => {
    expect(parseLadderRegistry('{')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(parseLadderRegistry('{"schema":"other","entries":[]}')).toEqual({ ok: false, reason: 'schema' });
    const r = parse(raw(), raw());
    expect(r.ok === false && r.reason).toBe('entries[1].id');
  });

  it('holds enough-to-judge on both sides', () => {
    const noJudge = parse(raw({ rungs: { fleet: { ...rung, metrics: [ranMetric] } } }));
    expect(noJudge.ok === false && noJudge.reason).toContain('needs-a-quality-or-harm-metric');
    const noRan = parse(raw({ rungs: { fleet: { ...rung, metrics: [harmMetric] } } }));
    expect(noRan.ok === false && noRan.reason).toContain('needs-a-ran-metric');
    const guardQuality = parse(raw({ rungs: { fleet: { ...rung, metrics: [ranMetric, { ...harmMetric, source: 'guard-posture', ref: { key: 'x' } }] } } }));
    expect(guardQuality.ok === false && guardQuality.reason).toContain('guard-posture-may-only-show-ran');
    const guardRan = parse(raw({ rungs: { fleet: { ...rung, metrics: [{ ...ranMetric, source: 'guard-posture', ref: { key: 'x' } }, harmMetric] } } }));
    expect(guardRan.ok).toBe(true);
  });

  it('requires a full preference record for a preference final', () => {
    const bare = parse(raw({ final: 'default-off-by-preference', rungs: { 'dev-agent-live': rung } }));
    expect(bare.ok === false && bare.reason).toContain('preference');
    const full = parse(raw({ final: 'default-off-by-preference', rungs: { 'dev-agent-live': rung },
      preference: { decidedBy: 'operator', reason: 'costs money', decidedAt: '2026-11-03', ref: 'topic 1' } }));
    expect(full.ok).toBe(true);
  });

  it('keeps a default-on entry from having no fleet rung', () => {
    const r = parse(raw({ rungs: { 'dev-agent-live': rung } }));
    expect(r.ok === false && r.reason).toContain('default-on-needs-a-fleet-rung');
  });

  it('keeps config moves inside the flag, away from the stage, and off the fleet rung', () => {
    const cfg = (set: Record<string, unknown>) => ({ ...rung, advance: { kind: 'config', set } });
    const outside = parse(raw({ rungs: { fleet: rung, 'dev-agent-live': cfg({ 'monitoring.other.dryRun': false }) } }));
    expect(outside.ok === false && outside.reason).toContain('set-outside-the-flag');
    const inside = parse(raw({ rungs: { fleet: rung, 'dev-agent-live': cfg({ 'monitoring.x.dryRun': false }) } }));
    expect(inside.ok).toBe(true);
    const stage = parse(raw({ flag: { path: 'multiMachine.sessionPool', on: 'live' }, rungs: { fleet: rung, 'dev-agent-live': cfg({ 'multiMachine.sessionPool.stage': 'x' }) } }));
    expect(stage.ok === false && stage.reason).toContain('stage-has-its-own-writer');
    const fleet = parse(raw({ rungs: { fleet: cfg({ 'monitoring.x.dryRun': false }) } }));
    expect(fleet.ok === false && fleet.reason).toContain('config-cannot-reach-fleet');
  });

  it('checks composed parents and colliding subjects', () => {
    const orphan = parse(raw({ id: 'a.b', disposition: 'composed', composedInto: 'missing', rungs: {} }));
    expect(orphan.ok === false && orphan.reason).toBe('composedInto:a.b');
    const ok = parse(raw(), raw({ id: 'a.b', disposition: 'composed', composedInto: 'monitoring.x', rungs: {} }));
    expect(ok.ok).toBe(true);
    const collide = parse(raw({ id: 'a.b' }), raw({ id: 'a-b' }));
    expect(collide.ok === false && collide.reason).toContain('subject-collides');
  });

  it('makes shared-log metrics name the feature on both sides', () => {
    const shared = { file: 'logs/feature-evidence.jsonl', value: 'count' };
    const bad = parse(raw({ rungs: { fleet: { ...rung, metrics: [{ ...ranMetric, ref: shared }, harmMetric] } } }));
    expect(bad.ok === false && bad.reason).toContain('shared-log-needs-featureId');
    const good = parse(raw({ rungs: { fleet: { ...rung, metrics: [{ ...ranMetric, ref: { ...shared, where: { featureId: 'x' }, of: { featureId: 'x' } } }, harmMetric] } } }));
    expect(good.ok).toBe(true);
  });
});

describe('evidence file confinement', () => {
  it.each([
    ['logs/x.jsonl', true], ['.instar/logs/x.jsonl', true], ['.instar/state/a/b.jsonl', true],
    ['logs/../x.jsonl', false], ['/etc/x.jsonl', false], ['logs/x.json', false], ['src/x.jsonl', false],
    ['.instar/logs/credential-swaps.jsonl', false], ['.instar/state/peers/x.jsonl', false], ['logs/subscription-account-meta.jsonl', false],
  ])('%s → %s', (file, ok) => { expect(isEvidenceFileAllowed(file)).toBe(ok); });
});

describe('subjectFromId', () => {
  it('passes D7 id rule for long dotted paths', () => {
    const long = `multiMachine.${'x'.repeat(100)}.enabled`;
    expect(subjectFromId(long)).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
    expect(subjectFromId('jobs.scriptRunners')).toBe('jobs-scriptrunners');
  });
});

describe('deriveLadderRung', () => {
  const e = entry();
  it('fleet only when the shipped default is fully on', () => {
    expect(deriveLadderRung(e, {}, { monitoring: { x: { enabled: true } } }).rung).toBe('fleet');
    expect(deriveLadderRung(e, {}, { monitoring: { x: { enabled: true, dryRun: true } } }).rung).toBe('dark');
  });
  it('dev gate: omitted enabled is live on a development agent, dark on the fleet', () => {
    expect(deriveLadderRung(e, { developmentAgent: true }, {}).rung).toBe('dev-agent-live');
    expect(deriveLadderRung(e, { developmentAgent: false }, {}).rung).toBe('dark');
  });
  it('an explicit value wins over the gate', () => {
    expect(deriveLadderRung(e, { developmentAgent: true, monitoring: { x: { enabled: false } } }, {}).rung).toBe('dark');
    expect(deriveLadderRung(e, { developmentAgent: false, monitoring: { x: { enabled: true } } }, {}).rung).toBe('dev-agent-live');
  });
  it('dry-run reads as dry-run, including when shipped dry-run', () => {
    expect(deriveLadderRung(e, { developmentAgent: true, monitoring: { x: { dryRun: true } } }, {}).rung).toBe('dry-run');
    expect(deriveLadderRung(e, { monitoring: { x: { enabled: true, dryRun: true } } }, { monitoring: { x: { enabled: true, dryRun: true } } }).rung).toBe('dry-run');
  });
  it('a stage-style flag compares the exact value', () => {
    const s = entry({ flag: { path: 'multiMachine.sessionPool.stage', on: 'live-transfer' } });
    expect(deriveLadderRung(s, { multiMachine: { sessionPool: { stage: 'live-transfer' } } }, {}).rung).toBe('dev-agent-live');
    expect(deriveLadderRung(s, { multiMachine: { sessionPool: { stage: 'shadow' } } }, {}).rung).toBe('dark');
    expect(deriveLadderRung(s, {}, { multiMachine: { sessionPool: { stage: 'live-transfer' } } }).rung).toBe('fleet');
  });
});

describe('nextRung and crossedRung', () => {
  it('walks to fleet, and stops at dev for a preference final', () => {
    const both = entry({ rungs: { 'dev-agent-live': rung, fleet: rung } });
    expect(nextRung(both, 'dark')).toBe('dev-agent-live');
    expect(nextRung(both, 'dry-run')).toBe('dev-agent-live');
    expect(nextRung(both, 'dev-agent-live')).toBe('fleet');
    expect(nextRung(both, 'fleet')).toBeNull();
    const pref = entry({ final: 'default-off-by-preference', rungs: { 'dev-agent-live': rung }, preference: { decidedBy: 'o', reason: 'r', decidedAt: '2026-11-03', ref: 't' } });
    expect(nextRung(pref, 'dev-agent-live')).toBeNull();
    expect(crossedRung(both, 'dev-agent-live')).toBe(both.rungs['dev-agent-live']);
    expect(crossedRung(both, 'dark')).toBeNull();
  });
});

describe('contractForRung', () => {
  it('produces a D7 contract, and a changed bar changes the source ref', () => {
    const c = contractForRung(rung);
    expect(c.cadenceHours).toBe(6);
    expect(c.metrics[0].source).toBe('feature-summary');
    const other = projectionRef({ ...ranMetric, ref: { file: 'logs/y.jsonl', value: 'count' } });
    expect(other).not.toBe(c.metrics[0].sourceRef);
    expect(projectionRef({ ...ranMetric, windowDays: 3 })).not.toBe(c.metrics[0].sourceRef);
    expect(projectionRef({ ...ranMetric, source: 'feature-summary', ref: { ref: 'a.b' } })).toBe('a.b');
  });
});

describe('soakDays', () => {
  const now = 100 * DAY;
  it('counts unbroken ready rows under the contract, and any other row restarts it', () => {
    const rows = [
      { status: 'ready', dueSlotMs: now - 3 * DAY, contractHash: 'h' },
      { status: 'ready', dueSlotMs: now - DAY, contractHash: 'h' },
      { status: 'ready', dueSlotMs: now, contractHash: 'h' },
    ];
    expect(soakDays(rows, 'h', now)).toBe(3);
    expect(soakDays([...rows, { status: 'hold', dueSlotMs: now - 2 * DAY, contractHash: 'h' }], 'h', now)).toBe(1);
    expect(soakDays([...rows, { status: 'missed-cadence', dueSlotMs: now - 2 * DAY, contractHash: 'h' }], 'h', now)).toBe(1);
    expect(soakDays(rows, 'other', now)).toBe(0);
    expect(soakDays(rows, null, now)).toBe(0);
  });
});

describe('computeLadderState', () => {
  const now = 100 * DAY;
  const read = (metric: LadderMetric, value: number | null, samples: number, extra: Partial<MetricReading> = {}): MetricReading => ({ metric, value, samples, newestAt: null, ...extra });
  const good = [read(ranMetric, 10, 10), read(harmMetric, 0, 10)];
  const ready = (days: number) => Array.from({ length: days * 4 + 1 }, (_, i) => ({ status: 'ready', dueSlotMs: now - i * DAY / 4, contractHash: 'h' }));
  const base = { entry: entry(), rung: 'dev-agent-live' as const, target: 'fleet' as const, readings: good, afterMove: [], evaluations: ready(8), contractHash: 'h', now, lastMoveAt: null, heldReason: null };

  it('ready-to-advance only after the soak', () => {
    expect(computeLadderState(base).state).toBe('ready-to-advance');
    expect(computeLadderState({ ...base, evaluations: ready(2) }).state).toBe('soaking');
  });
  it('collecting until D7 agrees under this contract', () => {
    expect(computeLadderState({ ...base, evaluations: [] }).state).toBe('collecting');
    expect(computeLadderState({ ...base, contractHash: 'new' }).state).toBe('collecting');
  });
  it('no-data when the ran metric has nothing; no-opportunity when rare', () => {
    const none = [read(ranMetric, 0, 0), read(harmMetric, 0, 0)];
    expect(computeLadderState({ ...base, readings: none }).state).toBe('no-data');
    expect(computeLadderState({ ...base, readings: none, entry: entry({ rare: true }) }).state).toBe('no-opportunity');
    // A failed read cannot tell silence from a problem, so it does not claim silence.
    expect(computeLadderState({ ...base, readings: [read(ranMetric, null, 0, { reason: 'read-failed' }), read(harmMetric, 0, 10)] }).state).toBe('collecting');
  });
  it('hold when a bar fails; collecting when samples are short or evidence absent', () => {
    expect(computeLadderState({ ...base, readings: [read(ranMetric, 10, 10), read(harmMetric, 0.5, 10)] }).state).toBe('hold');
    expect(computeLadderState({ ...base, readings: [read(ranMetric, 10, 10), read(harmMetric, 0, 2)] }).state).toBe('collecting');
    expect(computeLadderState({ ...base, readings: [read(ranMetric, 10, 10), read(harmMetric, null, 0, { reason: 'evidence-cut' })] }).state).toBe('collecting');
  });
  it('not-started when nothing runs it, whatever old evidence says', () => {
    expect(computeLadderState({ ...base, rung: 'dark' }).state).toBe('not-started');
  });
  it('at-final with no next rung', () => {
    expect(computeLadderState({ ...base, rung: 'fleet', target: null, readings: [] }).state).toBe('at-final');
  });
  it('precedence: retire, composed and held come first', () => {
    const retire = entry({ disposition: 'retire', retire: { reason: 'no consumer', ref: 'x' }, rungs: {} });
    expect(computeLadderState({ ...base, entry: retire }).state).toBe('retire-pending');
    expect(computeLadderState({ ...base, heldReason: 'operator said no' })).toMatchObject({ state: 'held', because: 'operator said no' });
  });
  describe('after a move', () => {
    const moved = { ...base, lastMoveAt: now - 5 * DAY };
    it('a failed harm bar of the crossed rung reads harmed, even at the final rung', () => {
      const r = computeLadderState({ ...moved, rung: 'fleet', target: null, readings: [], afterMove: [read(harmMetric, 0.5, 10)] });
      expect(r).toMatchObject({ state: 'harmed', because: 'harm' });
    });
    it('silence reads harmed after 3 days, not before, and never for a rare feature', () => {
      const silent = [read(ranMetric, 0, 0)];
      expect(computeLadderState({ ...moved, afterMove: silent })).toMatchObject({ state: 'harmed', because: 'silent-after-move' });
      expect(computeLadderState({ ...moved, afterMove: silent, lastMoveAt: now - DAY }).state).toBe('ready-to-advance');
      expect(computeLadderState({ ...moved, afterMove: silent, entry: entry({ rare: true }) }).state).toBe('ready-to-advance');
    });
    it('a failed read is not silence', () => {
      expect(computeLadderState({ ...moved, afterMove: [read(ranMetric, null, 0, { reason: 'read-failed' })] }).state).toBe('ready-to-advance');
    });
    it('the watch ends after 14 days', () => {
      expect(computeLadderState({ ...base, lastMoveAt: now - 15 * DAY, afterMove: [read(harmMetric, 0.5, 10)] }).state).toBe('ready-to-advance');
    });
  });
});

describe('dry-run the code knows about but the defaults do not', () => {
  it('reads a dry-run default and a differently named path', () => {
    const d = entry({ flag: { path: 'monitoring.x', dryRunDefault: true } });
    expect(deriveLadderRung(d, { developmentAgent: true }, {}).rung).toBe('dry-run');
    expect(deriveLadderRung(d, { developmentAgent: true, monitoring: { x: { dryRun: false } } }, {}).rung).toBe('dev-agent-live');
    // Shipped on, but the code keeps it in dry-run: that is not fleet.
    expect(deriveLadderRung(d, {}, { monitoring: { x: { enabled: true } } }).rung).not.toBe('fleet');
    const p = entry({ flag: { path: 'monitoring.x', dryRunPath: 'monitoring.xDryRun' } });
    expect(deriveLadderRung(p, { developmentAgent: true, monitoring: { xDryRun: true } }, {}).rung).toBe('dry-run');
    expect(deriveLadderRung(p, { developmentAgent: true, monitoring: { xDryRun: false } }, {}).rung).toBe('dev-agent-live');
  });
});
