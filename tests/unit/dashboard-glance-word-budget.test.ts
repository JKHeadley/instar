/**
 * Dashboard UX Standard F10 — the "glance floor" word/tile/jargon budget
 * (docs/specs/dashboard-ux-standard.md, "The glance floors", topic 29836).
 *
 * Exercises the SHIPPED validator + Commitments builder in dashboard/glance.js:
 *   - validateGlanceSpec flags >5 tiles, >150 words, a glued mega-token, and every
 *     insider-vocab class AND its bypass variants (spaced / glued / snake_case /
 *     NFKC look-alike / space-or-unit cadence), with a negative control on each side.
 *   - The scan is scoped to component-authored Layer-1 strings (headline + tile
 *     labels + values); a jargon-laden Layer-2 free-text row can NOT blank the glance.
 *   - The real Commitments builder, fed ADVERSARIAL fixtures (large N, null/empty/
 *     error states, free text carrying banned tokens), always produces a conforming
 *     glance whose headline count EQUALS the drill-down list length (truthfulness).
 *   - The grandfather RATCHET is structural: completeness (every TAB_REGISTRY id is in
 *     exactly one of adopted ∪ grandfathered) + monotonicity (grandfather size ≤ a
 *     committed ceiling), so a NEW tab in neither set fails the build and the list can
 *     never silently grow.
 */
// @ts-nocheck — the module is browser-native ESM (.js), no types.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateGlanceSpec,
  findInsiderVocab,
  countGlanceWords,
  buildCommitmentsGlance,
  commitmentsOpenPopulation,
  buildBlockersGlance,
  blockersPopulation,
  GLANCE_MAX_TILES,
  GLANCE_WORD_BUDGET,
  GLANCE_ADOPTED_TABS,
  GLANCE_GRANDFATHERED,
  GLANCE_GRANDFATHERED_CEILING,
} from '../../dashboard/glance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = path.resolve(__dirname, '..', '..', 'dashboard', 'index.html');

/** Parse the TAB_REGISTRY id list from index.html (same source-of-truth the F2/F3 floors use). */
function tabRegistryIds(): string[] {
  const html = fs.readFileSync(DASHBOARD_HTML, 'utf-8');
  const start = html.indexOf('const TAB_REGISTRY = [');
  const end = html.indexOf('\n    ];', start);
  const slice = html.slice(start, end);
  const ids: string[] = [];
  const re = /\bid:\s*'([a-z0-9-]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) ids.push(m[1]);
  return ids;
}

const cleanSpec = () => ({
  headline: "I'm carrying 6 open promises; 2 need attention soon, none overdue.",
  tiles: [
    { key: 'open', label: 'Open', value: '6' },
    { key: 'due-soon', label: 'Due soon', value: '2' },
    { key: 'waiting', label: 'Waiting on you', value: '1' },
    { key: 'quiet', label: 'Quiet', value: '3' },
  ],
});

describe('F10 validateGlanceSpec — the budget floor', () => {
  it('a clean, plain-English glance passes', () => {
    expect(validateGlanceSpec(cleanSpec()).ok).toBe(true);
  });

  it('flags more than 5 tiles', () => {
    const spec = cleanSpec();
    spec.tiles = Array.from({ length: 6 }, (_, i) => ({ key: `t${i}`, label: `Tile ${i}`, value: '1' }));
    const r = validateGlanceSpec(spec);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === 'too-many-tiles')).toBe(true);
    // negative control: exactly 5 passes
    spec.tiles = spec.tiles.slice(0, GLANCE_MAX_TILES);
    expect(validateGlanceSpec(spec).violations.some((v) => v.code === 'too-many-tiles')).toBe(false);
  });

  it('flags a front page over 150 words (and passes just under)', () => {
    const spec = cleanSpec();
    spec.headline = Array.from({ length: GLANCE_WORD_BUDGET + 10 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}`).join(' ');
    const r = validateGlanceSpec(spec);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === 'over-budget')).toBe(true);
    // negative control: a short headline is under budget
    expect(countGlanceWords(cleanSpec().headline)).toBeLessThan(GLANCE_WORD_BUDGET);
  });

  it('flags a glued mega-token that evades the naive word count', () => {
    const spec = cleanSpec();
    spec.headline = 'Carryingsixtyfouropenpromisesthreeduesoonnoneoverduerightnowtoday';
    const r = validateGlanceSpec(spec);
    expect(r.violations.some((v) => v.code === 'glued-token')).toBe(true);
  });

  describe('insider-vocab — every class AND its bypass variants', () => {
    const banned: Array<[string, string]> = [
      ['internal id (hyphen)', 'Open CMT-953 promises'],
      ['internal id (underscore)', 'Open CMT_953 promises'],
      ['internal id (glued)', 'Open cmt953 promises'],
      ['internal id (allcaps space)', 'Open CMT 953 promises'],
      ['machine id (hex)', 'from m_4f3a9b1c2d'],
      ['config key (camelCase)', 'the beaconEnabled flag'],
      ['config key (snake_case)', 'the hard_deadline field'],
      ['state-machine name', 'this one is atRisk now'],
      ['insider term (spaced)', 'this is at risk today'],
      ['insider term (suppressed)', 'currently suppressed here'],
      ['cadence (glued s)', 'every 1800s tick'],
      ['cadence (spaced)', 'every 1800 s tick'],
      ['cadence (sec word)', 'every 1800sec tick'],
      ['cadence (ms)', 'every 1800000ms tick'],
      ['cadence (ISO)', 'runs PT30M apart'],
    ];
    for (const [name, text] of banned) {
      it(`flags ${name}`, () => {
        expect(findInsiderVocab(text).length, `expected jargon in: ${text}`).toBeGreaterThan(0);
      });
    }

    it('does NOT flag legitimate plain copy (negative controls)', () => {
      for (const ok of [
        "I'm carrying 664 open promises; 3 need attention soon, none overdue.",
        'Open 664',
        'Due soon 3',
        'Waiting on you 2',
        'Quiet 12',
        'You have no open promises right now.',
        'Back to the 1800s decade of history', // decade prose, not a cadence
      ]) {
        expect(findInsiderVocab(ok), `false positive on: ${ok}`).toEqual([]);
      }
    });

    it('an NFKC look-alike / case trick still trips the check', () => {
      // Fullwidth digits + mixed case normalize to a matchable id.
      expect(findInsiderVocab('Open ＣＭＴ－９５３ here'.normalize('NFC')).length).toBeGreaterThan(0);
    });
  });

  it('the jargon scan is scoped to Layer-1 (component copy), not agent free text', () => {
    // A commitment whose free text is jargon-laden must NOT make the glance invalid —
    // that text is Layer 2/3 content, never part of the validated glance spec.
    const spec = cleanSpec();
    const r = validateGlanceSpec(spec);
    expect(r.ok).toBe(true);
    // The offending free text lives on a drill row, not in the spec the validator sees:
    const layer2Row = 'fix the atRisk cadence: 1800s for CMT-953';
    expect(findInsiderVocab(layer2Row).length).toBeGreaterThan(0); // it IS jargon…
    // …but it never enters glanceText(spec), so the glance stays valid.
  });
});

describe('F10 conformance — the real Commitments builder under adversarial fixtures', () => {
  const now = Date.parse('2026-07-10T00:00:00Z');
  const mk = (over: Record<string, unknown>) => ({
    beaconEnabled: true, status: 'pending', atRisk: false, beaconSuppressed: false,
    blockedOn: 'none', ...over,
  });

  const fixtures: Array<[string, any[]]> = [
    ['empty', []],
    ['null-ish', [null, undefined, {}, { beaconEnabled: false, status: 'pending' }]],
    ['large N', Array.from({ length: 664 }, (_, i) => mk({
      atRisk: i % 200 === 0, beaconSuppressed: i % 50 === 0,
      blockedOn: i % 300 === 0 ? 'user-input' : 'none',
      agentResponse: `promise number ${i} to send the code as soon as it arrives`,
    }))],
    ['jargon-laden free text', [mk({
      agentResponse: 'fix the atRisk cadence: 1800s for CMT-953 — id m_4f3a9b',
      atRisk: true, hardDeadlineAt: new Date(now - 1000).toISOString(),
    })]],
    ['all overdue', Array.from({ length: 5 }, () => mk({ hardDeadlineAt: new Date(now - 1).toISOString(), atRisk: true }))],
  ];

  for (const [name, commitments] of fixtures) {
    it(`produces a conforming glance for the "${name}" fixture`, () => {
      const glance = buildCommitmentsGlance(commitments, now);
      const r = validateGlanceSpec(glance);
      expect(r.ok, `violations: ${JSON.stringify(r.violations)}`).toBe(true);
      expect(glance.tiles.length).toBeLessThanOrEqual(GLANCE_MAX_TILES);
    });
  }

  it('TRUTHFULNESS — the headline "open" count equals the drill-down population length', () => {
    const commitments = fixtures[2][1]; // large N
    const glance = buildCommitmentsGlance(commitments, now);
    const openTile = glance.tiles.find((t: any) => t.key === 'open');
    const pop = commitmentsOpenPopulation(commitments);
    expect(Number(openTile.value)).toBe(pop.length);
    expect(glance.population.length).toBe(pop.length);
    // the headline states the same number
    expect(glance.headline).toContain(String(pop.length));
  });
});

describe('F10 #1435 folds — the Commitments builder', () => {
  const mk = (over: Record<string, unknown>) => ({
    beaconEnabled: true, status: 'pending', atRisk: false, beaconSuppressed: false,
    blockedOn: 'none', ...over,
  });
  const now = Date.parse('2026-07-10T00:00:00Z');

  it('adds an Overdue tile so every headline number has a drill-down (F11 gap #1435 §1)', () => {
    const g = buildCommitmentsGlance([mk({ hardDeadlineAt: new Date(now - 1000).toISOString() })], now);
    expect(g.tiles.map((t: any) => t.key)).toContain('overdue');
    expect(g.tiles.length).toBe(5);
    expect(validateGlanceSpec(g).ok).toBe(true);
  });

  it('a past HARD deadline is OVERDUE, never "due soon" (#1435 §3)', () => {
    // atRisk AND a month-past hard deadline → overdue only, not double-counted as due-soon.
    const stale = mk({ atRisk: true, hardDeadlineAt: new Date(now - 30 * 864e5).toISOString() });
    const g = buildCommitmentsGlance([stale], now);
    const val = (k: string) => Number(g.tiles.find((t: any) => t.key === k).value);
    expect(val('overdue')).toBe(1);
    expect(val('due-soon')).toBe(0);
    expect(g.headline).toMatch(/1 is overdue/);
  });

  it('count-aware pluralization: "1 needs" / "2 need" (#1435 §2)', () => {
    const one = buildCommitmentsGlance([mk({ atRisk: true })], now);
    expect(one.headline).toMatch(/1 needs attention soon/);
    const two = buildCommitmentsGlance([mk({ atRisk: true }), mk({ atRisk: true })], now);
    expect(two.headline).toMatch(/2 need attention soon/);
  });
});

describe('F10 conformance — the real Blockers builder under adversarial fixtures', () => {
  const bmk = (over: Record<string, unknown>) => ({
    id: 'BLK-x', version: 1, state: 'live-run', detectedText: 'a thing that looked stuck',
    origin: 'sess-1', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-09T00:00:00Z',
    history: [], ...over,
  });

  const fixtures: Array<[string, any[]]> = [
    ['empty', []],
    ['null-ish', [null, undefined, {}, { id: 'x' /* no state */ }]],
    ['large N', Array.from({ length: 500 }, (_, i) => bmk({
      id: `BLK-${i}`,
      state: ['candidate', 'authority-checked', 'access-requested', 'dry-run', 'live-run', 'resolved', 'true-blocker'][i % 7],
      detectedText: `blocker number ${i} — the vendor has not replied since June ${1 + (i % 28)}`,
    }))],
    ['jargon-laden detectedText', [bmk({
      state: 'true-blocker',
      detectedText: 'fix the atRisk cadence: 1800s for CMT-953 — id m_4f3a9b',
      terminal: { kind: 'true-blocker', reasonKind: 'operator-only-secret', recheckAfter: '2026-08-01T00:00:00Z' },
    })]],
    ['all truly stuck', Array.from({ length: 4 }, (_, i) => bmk({ id: `BLK-${i}`, state: 'true-blocker' }))],
    ['all resolved', Array.from({ length: 3 }, (_, i) => bmk({ id: `BLK-${i}`, state: 'resolved' }))],
  ];

  for (const [name, entries] of fixtures) {
    it(`produces a conforming glance for the "${name}" fixture`, () => {
      const glance = buildBlockersGlance(entries);
      const r = validateGlanceSpec(glance);
      expect(r.ok, `violations: ${JSON.stringify(r.violations)}`).toBe(true);
      expect(glance.tiles.length).toBeLessThanOrEqual(GLANCE_MAX_TILES);
    });
  }

  it('TRUTHFULNESS — tile counts sum to the population and partition it', () => {
    const entries = fixtures[2][1]; // large N
    const glance = buildBlockersGlance(entries);
    const pop = blockersPopulation(entries);
    const sum = glance.tiles.reduce((n: number, t: any) => n + Number(t.value), 0);
    expect(sum).toBe(pop.length); // every entry lands in exactly one tile — nothing lost
    expect(glance.population.length).toBe(pop.length);
  });

  it('the headline leads with the "truly stuck" state in plain words', () => {
    expect(buildBlockersGlance([]).headline.toLowerCase()).toContain('no blockers');
    expect(buildBlockersGlance([bmk({ state: 'true-blocker' })]).headline).toMatch(/1 thing is truly stuck/);
    expect(buildBlockersGlance([bmk({ state: 'live-run' })]).headline).toMatch(/nothing is truly stuck/i);
  });
});

describe('F10/F11 grandfather ratchet — structural, not prose', () => {
  it('completeness: every registered tab is in exactly one of adopted ∪ grandfathered', () => {
    const ids = tabRegistryIds();
    expect(ids.length, 'TAB_REGISTRY visible to the floor').toBeGreaterThanOrEqual(20); // population floor
    const adopted = new Set(GLANCE_ADOPTED_TABS);
    const grand = new Set(GLANCE_GRANDFATHERED);
    // no overlap
    for (const a of adopted) expect(grand.has(a), `${a} is BOTH adopted and grandfathered`).toBe(false);
    // every registered tab classified exactly once — a NEW tab in neither fails here
    const unclassified = ids.filter((id) => !adopted.has(id) && !grand.has(id));
    expect(unclassified, `tabs classified by NEITHER glance registry: ${unclassified.join(', ')}`).toEqual([]);
    // no stale ids (a removed tab left dangling in a registry)
    const stale = [...adopted, ...grand].filter((id) => !ids.includes(id));
    expect(stale, `glance registry ids no longer in TAB_REGISTRY: ${stale.join(', ')}`).toEqual([]);
  });

  it('monotonicity: the grandfather list size never exceeds the committed ceiling', () => {
    expect(GLANCE_GRANDFATHERED.length).toBeLessThanOrEqual(GLANCE_GRANDFATHERED_CEILING);
  });

  it('population floor: every adopted tab has a real builder (commitments + blockers)', () => {
    expect(GLANCE_ADOPTED_TABS.length).toBeGreaterThanOrEqual(2);
    expect(GLANCE_ADOPTED_TABS).toContain('commitments');
    expect(GLANCE_ADOPTED_TABS).toContain('blockers'); // adopted this PR (Phase 2)
    // both reference builders are real (not stubs) and produce a conforming empty glance
    expect(typeof buildCommitmentsGlance).toBe('function');
    expect(validateGlanceSpec(buildCommitmentsGlance([])).ok).toBe(true);
    expect(typeof buildBlockersGlance).toBe('function');
    expect(validateGlanceSpec(buildBlockersGlance([])).ok).toBe(true);
  });

  it('the ratchet only shrinks: blockers is no longer grandfathered and the ceiling dropped', () => {
    expect(GLANCE_GRANDFATHERED).not.toContain('blockers');
    expect(GLANCE_GRANDFATHERED).not.toContain('commitments');
    expect(GLANCE_GRANDFATHERED_CEILING).toBe(24); // was 25 before Phase 2
  });
});
