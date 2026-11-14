/**
 * Arbiter / default rung / shadow comparison — Tier 1.
 * Spec: docs/specs/skill-learning-sentinel.md §3.3 (default rung, arbiter, durable verdicts, both logged) and §3.4.
 */
import { describe, it, expect } from 'vitest';
import {
  buildArbiterPrompt, cachedArbiterVerdict, decideKey, evaluateDefaultRung, parseArbiterOutput, type ArbiterContext,
} from '../../src/monitoring/skillLearning/Arbiter.js';
import type { FloorResult } from '../../src/monitoring/skillLearning/Floor.js';
import type { Identity, RequestRow, VerdictRow } from '../../src/monitoring/skillLearning/types.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const GATE = { minSupport: 3, minDistinctDays: 2, minDistinctSessions: 2, windowDays: 30 };
const SHADOW = { minDisagreementsSampled: 5, verdictReaskDays: 14 };

function req(i: number, daysAgo: number, session = `s${i}`, identity: Identity = 'verified'): RequestRow {
  return {
    kind: 'request', eventId: `e${i}`, source: { channel: 'telegram', chatId: '-100', messageId: String(i) }, topicId: '42',
    sessionName: session, at: new Date(NOW - daysAgo * 86_400_000).toISOString(), channel: 'telegram', identity, state: 'classified',
    procedureKey: 'k', paraphrase: `p${i}`, repeatable: true, runId: `run-${i}`, machineId: 'm1',
  };
}

const floor: FloorResult = {
  passes: true, cleanRunIds: ['run-1'], correctedRunIds: [],
  counts: { occurrences: 3, verifiedOccurrences: 3, acceptedRuns: 1, acceptedInferredRuns: 0, cleanRuns: 1, correctedRuns: 0 },
};
const ctx = { paraphrases: ['p'], cleanRunOutlines: [], libraryDescriptions: [], indexBytes: null, operatorVerdicts: [] };

function verdictRow(verdict: 'draft' | 'wait' | 'never', expiresInDays: number, by: VerdictRow['by'] = 'arbiter'): VerdictRow {
  return { kind: 'verdict', eventId: `v-${verdict}`, procedureKey: 'k', by, verdict, reason: 'r', expiresAt: new Date(NOW + expiresInDays * 86_400_000).toISOString(), at: new Date(NOW - 1000).toISOString(), machineId: 'm1' };
}

describe('default rung (§3.3)', () => {
  it('3 verified occurrences on 2 days across 2 sessions inside the window ⇒ draft', () => {
    const r = evaluateDefaultRung([req(1, 1, 'a'), req(2, 1, 'b'), req(3, 5, 'a')], GATE, NOW);
    expect(r).toMatchObject({ verdict: 'draft', support: 3, distinctDays: 2, distinctSessions: 2 });
  });
  it('the same three in ONE session ⇒ wait', () => {
    expect(evaluateDefaultRung([req(1, 1, 'a'), req(2, 2, 'a'), req(3, 5, 'a')], GATE, NOW).verdict).toBe('wait');
  });
  it('an occurrence outside the window does not count (the recency is the rung\'s, not the floor\'s)', () => {
    const r = evaluateDefaultRung([req(1, 1, 'a'), req(2, 2, 'b'), req(3, 45, 'c')], GATE, NOW);
    expect(r.support).toBe(2);
    expect(r.verdict).toBe('wait');
  });
  it('asserted rows never count toward the rung', () => {
    expect(evaluateDefaultRung([req(1, 1, 'a'), req(2, 2, 'b'), req(3, 3, 'c', 'asserted')], GATE, NOW).support).toBe(2);
  });
});

describe('arbiter output parsing (strict contract)', () => {
  it('accepts the taught vocabulary and clamps the reason', () => {
    expect(parseArbiterOutput('{"verdict":"draft","reason":"strong recurrence"}')).toEqual({ verdict: 'draft', reason: 'strong recurrence' });
    expect(parseArbiterOutput('Sure! {"verdict":"never","reason":"x"}')?.verdict).toBe('never');
    expect(parseArbiterOutput(`{"verdict":"wait","reason":"${'a'.repeat(500)}"}`)?.reason.length).toBe(240);
  });
  it('rejects off-vocabulary and unparseable answers (an outage, never a verdict)', () => {
    expect(parseArbiterOutput('{"verdict":"maybe"}')).toBeNull();
    expect(parseArbiterOutput('draft')).toBeNull();
    expect(parseArbiterOutput('')).toBeNull();
  });
  it('the prompt fences evidence as data and carries the floor + default rung numbers', () => {
    const full: ArbiterContext = { ...ctx, procedureKey: 'k', occurrenceTimes: ['2026-01-01T00:00:00Z'], distinctSessions: 1, defaultRung: evaluateDefaultRung([], GATE, NOW), floor: floor.counts };
    const p = buildArbiterPrompt(full);
    expect(p).toContain('<<<PARAPHRASES (data)>>>');
    expect(p).toContain('Verified occurrences: 3');
    expect(p).toContain('verdict=wait');
    expect(p).toContain('"verdict":"draft"|"wait"|"never"');
  });
});

describe('decideKey — both verdicts logged, durable arbiter verdicts (§3.3/§3.4)', () => {
  const drafting = [req(1, 1, 'a'), req(2, 1, 'b'), req(3, 5, 'a')];
  const waiting = [req(1, 1, 'a'), req(2, 2, 'a')];

  it('agreement: default draft + arbiter draft ⇒ draft, arbiterOnly false, logged agree:true, verdict row persisted with the re-ask horizon', async () => {
    const d = await decideKey({ procedureKey: 'k', requests: drafting, verdicts: [], floor, cfg: { defaultGate: GATE, shadow: SHADOW }, nowMs: NOW, askArbiter: async () => ({ verdict: 'draft', reason: 'yes' }), context: ctx });
    expect(d.action).toBe('draft');
    expect(d.arbiterOnly).toBe(false);
    expect(d.disagreement).toBeNull();
    expect(d.logRow).toMatchObject({ kind: 'arbiter-vs-default', key: 'k', default: 'draft', arbiter: 'draft', agree: true, cached: false });
    expect(d.verdictRow).toMatchObject({ by: 'arbiter', verdict: 'draft', expiresAt: new Date(NOW + 14 * 86_400_000).toISOString() });
  });

  it('disagreement: default wait + arbiter draft ⇒ arbiter-only draft (surfaced as a proposal), logged agree:false', async () => {
    const d = await decideKey({ procedureKey: 'k', requests: waiting, verdicts: [], floor, cfg: { defaultGate: GATE, shadow: SHADOW }, nowMs: NOW, askArbiter: async () => ({ verdict: 'draft', reason: 'two strong occurrences' }), context: ctx });
    expect(d.action).toBe('draft');
    expect(d.arbiterOnly).toBe(true);
    expect(d.disagreement).toBe('arbiter-only');
    expect(d.logRow.agree).toBe(false);
  });

  it('disagreement: default draft + arbiter wait ⇒ the default rung acts in slice 1 (draft, not arbiter-only), logged agree:false', async () => {
    const d = await decideKey({ procedureKey: 'k', requests: drafting, verdicts: [], floor, cfg: { defaultGate: GATE, shadow: SHADOW }, nowMs: NOW, askArbiter: async () => ({ verdict: 'wait', reason: 'varied' }), context: ctx });
    expect(d.action).toBe('draft');
    expect(d.arbiterOnly).toBe(false);
    expect(d.disagreement).toBe('default-only');
    expect(d.logRow).toMatchObject({ default: 'draft', arbiter: 'wait', agree: false });
  });

  it('default draft + arbiter `never` ⇒ the proposal is still written, labelled default-only (both directions reach the operator); the never is persisted for its own re-ask', async () => {
    const d = await decideKey({ procedureKey: 'k', requests: drafting, verdicts: [], floor, cfg: { defaultGate: GATE, shadow: SHADOW }, nowMs: NOW, askArbiter: async () => ({ verdict: 'never', reason: 'one-off' }), context: ctx });
    expect(d.action).toBe('draft');
    expect(d.disagreement).toBe('default-only');
    expect(d.arbiterOnly).toBe(false);
    expect(d.verdictRow?.verdict).toBe('never');
  });

  it('an UNEXPIRED `never` survives an arbiter outage: the cached row is reused, the arbiter is not re-asked; it suppresses only its own re-ask, never the default\'s draft', async () => {
    let asked = 0;
    const d = await decideKey({ procedureKey: 'k', requests: drafting, verdicts: [verdictRow('never', 5)], floor, cfg: { defaultGate: GATE, shadow: SHADOW }, nowMs: NOW, askArbiter: async () => { asked++; return null; }, context: ctx });
    expect(asked).toBe(0);
    expect(d.action).toBe('draft');
    expect(d.disagreement).toBe('default-only');
    expect(d.arbiter).toBe('never');
    expect(d.arbiterCached).toBe(true);
    expect(d.logRow.cached).toBe(true);
    expect(d.verdictRow).toBeUndefined();
    // With a waiting default the cached never means: nothing to draft and no call.
    const w = await decideKey({ procedureKey: 'k', requests: waiting, verdicts: [verdictRow('never', 5)], floor, cfg: { defaultGate: GATE, shadow: SHADOW }, nowMs: NOW, askArbiter: async () => { asked++; return null; }, context: ctx });
    expect(asked).toBe(0);
    expect(w.action).toBe('wait');
    expect(w.disagreement).toBeNull();
  });

  it('an EXPIRED `never` no longer holds: the arbiter is re-asked; on outage the default rung alone acts, logged unavailable', async () => {
    let asked = 0;
    const d = await decideKey({ procedureKey: 'k', requests: drafting, verdicts: [verdictRow('never', -1)], floor, cfg: { defaultGate: GATE, shadow: SHADOW }, nowMs: NOW, askArbiter: async () => { asked++; return null; }, context: ctx });
    expect(asked).toBe(1);
    expect(d.arbiter).toBe('unavailable');
    expect(d.action).toBe('draft');
    expect(d.disagreement).toBeNull();
    expect(d.logRow).toMatchObject({ arbiter: 'unavailable', agree: null });
  });

  it('arbiter outage with no cached verdict and a waiting default ⇒ wait (never a draft from absence)', async () => {
    const d = await decideKey({ procedureKey: 'k', requests: waiting, verdicts: [], floor, cfg: { defaultGate: GATE, shadow: SHADOW }, nowMs: NOW, askArbiter: async () => { throw new Error('provider down'); }, context: ctx });
    expect(d.action).toBe('wait');
    expect(d.arbiter).toBe('unavailable');
  });

  it('no arbiter wired at all ⇒ default rung alone', async () => {
    const d = await decideKey({ procedureKey: 'k', requests: drafting, verdicts: [], floor, cfg: { defaultGate: GATE, shadow: SHADOW }, nowMs: NOW, askArbiter: null, context: ctx });
    expect(d.action).toBe('draft');
    expect(d.arbiter).toBe('unavailable');
  });

  it('cachedArbiterVerdict ignores operator/default rows, expired rows, and picks the latest', () => {
    const rows = [verdictRow('wait', 3), { ...verdictRow('never', 3), at: new Date(NOW - 10).toISOString() }, verdictRow('draft', -2), verdictRow('never', 9, 'operator')];
    expect(cachedArbiterVerdict(rows, NOW)?.verdict).toBe('never');
    expect(cachedArbiterVerdict([verdictRow('draft', -2)], NOW)).toBeNull();
  });
});
