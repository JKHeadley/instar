/** Band rules and the class floor (docs/specs/ecosystem-idea-pipeline.md §7, §10), both sides of each. */
import { describe, it, expect } from 'vitest';
import { bandOf, compareWithinBand, floorClass, funnelOf, higherClass, isDeclined, reconcileVerdict } from '../../../src/ecosystem/ideaBands.js';
import { recordHash } from '../../../src/ecosystem/EcosystemLedger.js';
import type { GapRead, GoalReview, Idea } from '../../../src/ecosystem/types.js';

const read = (over: Partial<GapRead> = {}): GapRead => ({ framework: 'a', verdict: 'gap', detail: '', citations: [], terms: [], effectClass: 'additive-dark', searchMode: 'hybrid', truncated: false, sourceCommits: {}, singleFamily: false, ...over });
const goal = (over: Partial<GoalReview> = {}): GoalReview => ({
  framework: 'a', purposeCommit: 'c', coherence: { effect: 'helps', why: '' }, trust: { effect: 'neutral', why: '' }, unhindered: { addsLimit: false, namedRule: null, why: '' },
  instar2: { status: 'absent', doc: null, workThrownAway: false }, costOfNotAdopting: 'x', goalFit: 'clear', gapSize: 'medium', effort: 'm', evidenceCost: 'cheap', ...over,
});
const idea = (over: Partial<Idea> = {}): Idea => ({
  id: 'idea-1', project: 'o/p', stage: 'done', firstRead: read(), secondRead: read({ framework: 'b' }), verdict: 'gap', effectClass: 'behaviour-changing', classLoweredTo: null, goal: goal(), decisions: [],
  sightings: [{ sightingId: 's1', project: 'o/p', commit: 'c1', claim: 'a thing', evidence: [{ path: 'a.ts', startLine: 1, endLine: 2 }], excerpts: [], maturity: 'tested-in-their-code', ageDays: 90, at: '2026-01-01T00:00:00Z' }],
  launchIntent: null, adoption: null, outcome: null, audit: null, firstSeenAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
});

describe('bandOf', () => {
  it('Now needs two families, search by meaning, clear fit and cheap evidence', () => {
    expect(bandOf(idea()).band).toBe('now');
    expect(bandOf(idea({ firstRead: read({ singleFamily: true }), secondRead: read({ singleFamily: true }) })).band).toBe('plan');
    expect(bandOf(idea({ secondRead: read({ searchMode: 'word-only' }) })).band).toBe('plan');
    expect(bandOf(idea({ goal: goal({ goalFit: 'some' }) })).band).toBe('plan');
    expect(bandOf(idea({ goal: goal({ evidenceCost: 'costly' }) })).band).toBe('plan');
  });
  it('a reduction can never be Now, unless the operator lowered the class on this revision', () => {
    expect(bandOf(idea({ effectClass: 'reduces-capability' })).band).toBe('plan');
    const base = idea({ effectClass: 'reduces-capability', classLoweredTo: 'behaviour-changing' });
    expect(bandOf(base).band).toBe('plan'); // no decision on record
    const lowered = { ...base, decisions: [{ action: 'lower-class' as const, recordHash: recordHash(base), at: 'x', by: 'operator' as const, ref: 'r', effectClass: 'behaviour-changing' as const }] };
    expect(bandOf(lowered).band).toBe('now');
    const newer = { ...lowered, sightings: [...lowered.sightings, { ...lowered.sightings[0], sightingId: 's2', commit: 'c2' }] };
    expect(bandOf(newer).band).toBe('plan');
  });
  it('unverified cannot rank, and an idea in review is not ranked', () => {
    expect(bandOf(idea({ verdict: 'unverified' })).band).toBe('unranked');
    expect(bandOf(idea({ stage: 'goal', verdict: null })).band).toBe('unranked');
  });
  it('a harm, a conflict or a limit naming no rule stops it; a limit naming a rule does not', () => {
    expect(bandOf(idea({ goal: goal({ coherence: { effect: 'harms', why: '' } }) })).band).toBe('stopped');
    expect(bandOf(idea({ goal: goal({ trust: { effect: 'harms', why: '' } }) })).band).toBe('stopped');
    expect(bandOf(idea({ goal: goal({ instar2: { status: 'conflict', doc: null, workThrownAway: false } }) })).band).toBe('stopped');
    expect(bandOf(idea({ goal: goal({ unhindered: { addsLimit: true, namedRule: null, why: '' } }) })).band).toBe('stopped');
    expect(bandOf(idea({ goal: goal({ unhindered: { addsLimit: true, namedRule: 'Rule 18', why: '' } }) })).band).toBe('now');
  });
  it('have-it and not-for-us are stopped, and keep their record', () => {
    expect(bandOf(idea({ verdict: 'have-it' })).band).toBe('stopped');
    expect(bandOf(idea({ verdict: 'not-for-us' })).band).toBe('stopped');
  });
  it('young or prose-only work waits in Watch, and newness earns nothing', () => {
    const s = idea().sightings[0];
    expect(bandOf(idea({ sightings: [{ ...s, ageDays: 3 }] })).band).toBe('watch');
    expect(bandOf(idea({ sightings: [{ ...s, maturity: 'prose-only' }] })).band).toBe('watch');
  });
});

describe('declined ideas', () => {
  it('stay declined until a sighting at a new commit changes the record', () => {
    const base = idea();
    const declined = idea({ decisions: [{ action: 'decline', recordHash: recordHash(base), at: 'x', by: 'operator', ref: 'r' }] });
    expect(isDeclined(declined)).toBe(true);
    expect(bandOf(declined).band).toBe('stopped');
    const newer = { ...declined, sightings: [...declined.sightings, { ...declined.sightings[0], sightingId: 's2', commit: 'c2' }] };
    expect(isDeclined(newer)).toBe(false);
    expect(bandOf(newer).band).toBe('now');
  });
});

describe('effect class floor', () => {
  it('the higher of two blind reads wins', () => {
    expect(floorClass(['additive-dark', 'reduces-capability'], 'x')).toBe('reduces-capability');
    expect(higherClass('behaviour-changing', 'additive-dark')).toBe('behaviour-changing');
  });
  it('a claim about what agents load cannot be classed below behaviour-changing by models alone', () => {
    expect(floorClass(['additive-dark', 'additive-dark'], 'cap the session-start context budget')).toBe('behaviour-changing');
    expect(floorClass(['additive-dark', 'additive-dark'], 'a new read-only report')).toBe('additive-dark');
  });
  it('no read at all is not additive', () => { expect(floorClass([], 'x')).toBe('behaviour-changing'); });
});

describe('reconcileVerdict', () => {
  it('agreement stands; disagreement or a missing read is unverified', () => {
    expect(reconcileVerdict(read(), read())).toBe('gap');
    expect(reconcileVerdict(read(), read({ verdict: 'have-it' }))).toBe('unverified');
    expect(reconcileVerdict(read(), null)).toBe('unverified');
    expect(reconcileVerdict(read({ verdict: 'unverified' }), read({ verdict: 'unverified' }))).toBe('unverified');
  });
});

describe('ordering and funnel', () => {
  it('sorts by goal fit, then gap size, then effort', () => {
    const a = idea({ id: 'a', goal: goal({ goalFit: 'some', gapSize: 'large' }) });
    const b = idea({ id: 'b', goal: goal({ goalFit: 'clear', gapSize: 'small' }) });
    const c = idea({ id: 'c', goal: goal({ goalFit: 'clear', gapSize: 'large' }) });
    expect([a, b, c].sort(compareWithinBand).map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });
  it('counts what it saw, even when nothing is adopted', () => {
    const f = funnelOf([idea(), idea({ id: 'x', verdict: 'have-it' }), idea({ id: 'y', verdict: 'unverified' })]);
    expect(f).toMatchObject({ seen: 3, verified: 2, adopted: 0, lastAdoptionAt: null });
    expect(f.bands).toMatchObject({ now: 1, stopped: 1, unranked: 1 });
  });
});
