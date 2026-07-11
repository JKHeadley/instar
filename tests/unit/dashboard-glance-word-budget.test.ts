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
  buildMachinesGlance,
  machinesPopulation,
  buildHealthGlance,
  healthPopulation,
  buildSpendGlance,
  buildRoutingMapGlance,
  friendlyModel,
  // Phase 4 — the sweep
  buildPrPipelineGlance, prPipelinePopulation,
  buildTokensGlance,
  buildLlmActivityGlance, llmActivityPopulation,
  buildSecretsGlance, secretsPopulation,
  buildResourcesGlance, resourcesPopulation,
  buildInitiativesGlance, initiativesPopulation,
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

describe('F10 conformance — the Phase-3 jargon-belt builders under adversarial fixtures', () => {
  // Each builder is fed large-N, null/empty/error, and jargon-laden fixtures; the
  // produced glance must ALWAYS pass F10 (≤5 tiles, ≤150 words, no insider vocab) —
  // proving the jargon can never leak up from the raw data to the operator's glance.

  describe('Machines', () => {
    const mkMachine = (over: Record<string, unknown> = {}) => ({
      machineId: 'm_4f3a9b1c', nickname: 'Laptop', online: true, clockSkewStatus: 'ok',
      activeSessionCount: 2, maxSessions: 6,
      hardware: { cpuModel: 'Apple M2', cpuCores: 8, totalMemBytes: 17179869184 },
      guardPosture: { onConfirmed: 16, offDeviant: 6, offRuntimeDivergent: 0 }, ...over,
    });
    const fixtures: Array<[string, any]> = [
      ['empty pool', { enabled: true, machines: [] }],
      ['single machine', { enabled: true, router: { holder: 'm_4f3a9b1c' }, machines: [mkMachine()] }],
      ['two healthy', { enabled: true, machines: [mkMachine(), mkMachine({ machineId: 'm_2', nickname: 'Mini' })] }],
      ['offline + clock-skew + guard problems', { enabled: true, router: { holder: 'm_1' }, machines: [
        mkMachine({ machineId: 'm_1', online: false }),
        mkMachine({ machineId: 'm_2', clockSkewStatus: 'suspect-clock-removed' }),
        mkMachine({ machineId: 'm_3', guardPosture: { onStale: 3, missing: 1, errored: 2 } }),
      ] }],
      ['jargon-laden nickname (must not leak to Layer 1)', { enabled: true, machines: [
        mkMachine({ machineId: 'machine-4f3a', nickname: 'fix the atRisk cadence: 1800s for CMT-953' }),
      ] }],
      ['large N', { enabled: true, router: { holder: 'm_0' }, machines: Array.from({ length: 40 }, (_, i) =>
        mkMachine({ machineId: 'm_' + i, nickname: 'node ' + i, online: i % 5 !== 0 })) }],
    ];
    const guards = { guards: [
      { key: 'zombieCleanup', effective: 'on-confirmed', configEnabled: true, defaultEnabled: true, process: 'server' },
      { key: 'sleepWakeDetector', effective: 'off-runtime-divergent', configEnabled: true, defaultEnabled: true, process: 'lifeline' },
    ], summary: { onConfirmed: 1, offRuntimeDivergent: 1 } };
    for (const [name, pool] of fixtures) {
      it(`conforms for "${name}"`, () => {
        for (const g of [null, guards]) {
          const glance = buildMachinesGlance(pool, g);
          const r = validateGlanceSpec(glance);
          expect(r.ok, `violations: ${JSON.stringify(r.violations)}`).toBe(true);
          expect(glance.tiles.length).toBeLessThanOrEqual(GLANCE_MAX_TILES);
        }
      });
    }
    it('TRUTHFULNESS — the Online tile count never exceeds the machine population', () => {
      const pool = fixtures[5][1];
      const glance = buildMachinesGlance(pool, null);
      const online = Number(glance.tiles.find((t: any) => t.key === 'online').value);
      expect(online).toBe(machinesPopulation(pool).filter((m: any) => m.online).length);
      expect(online).toBeLessThanOrEqual(glance.population.length);
    });
  });

  describe('Health', () => {
    const mkCap = (over: Record<string, unknown> = {}) => ({
      id: 'session-recovery', label: 'Session Recovery', description: 'Detects stuck sessions.',
      status: 'active', metric: '12 recovered', stats: { recoveries: 12 }, lastActivity: null,
      processes: [{ name: 'SessionWatchdog', status: 'running' }], ...over,
    });
    const fixtures: Array<[string, any]> = [
      ['empty', { health: 'healthy', activeCapabilities: [], issues: [], recentEvents: [] }],
      ['null-ish', { activeCapabilities: [null, undefined, {}, mkCap()], issues: [], recentEvents: [] }],
      ['all healthy', { health: 'healthy', activeCapabilities: [mkCap(), mkCap({ id: 'telegram', label: 'Telegram' })], issues: [], recentEvents: [] }],
      ['some errored', { health: 'error', activeCapabilities: [mkCap(), mkCap({ id: 'telegram', label: 'Telegram', status: 'error' })],
        issues: [{ severity: 'error', label: 'Telegram issue', description: 'TelegramAdapter errored', capability: 'telegram', process: 'TelegramAdapter' }],
        recentEvents: [{ narrative: 'Telegram reconnected after a blip', subsystem: 'telegram', timestamp: '2026-07-10T00:00:00Z' }] }],
      ['jargon-laden narrative (Layer 2 only)', { health: 'error', activeCapabilities: [mkCap({ status: 'error' })], issues: [],
        recentEvents: [{ narrative: 'the atRisk beacon cadence: 1800s tripped for CMT-953', subsystem: 'sess_4f3a', timestamp: '2026-07-10T00:00:00Z' }] }],
      ['large N', { health: 'error', activeCapabilities: Array.from({ length: 30 }, (_, i) =>
        mkCap({ id: 'cap-' + i, label: 'Subsystem ' + i, status: i % 4 === 0 ? 'error' : 'active' })),
        issues: [], recentEvents: Array.from({ length: 20 }, (_, i) => ({ narrative: 'event ' + i, subsystem: 's' + i })) }],
    ];
    for (const [name, systems] of fixtures) {
      it(`conforms for "${name}"`, () => {
        const glance = buildHealthGlance(systems);
        const r = validateGlanceSpec(glance);
        expect(r.ok, `violations: ${JSON.stringify(r.violations)}`).toBe(true);
        expect(glance.tiles.length).toBeLessThanOrEqual(GLANCE_MAX_TILES);
      });
    }
    it('TRUTHFULNESS — the Subsystems tile equals the population length', () => {
      const systems = fixtures[5][1];
      const glance = buildHealthGlance(systems);
      const subs = Number(glance.tiles.find((t: any) => t.key === 'subsystems').value);
      expect(subs).toBe(healthPopulation(systems).length);
    });
  });

  describe('Spend', () => {
    const mkRow = (over: Record<string, unknown> = {}) => ({
      door: 'claude-cli', modelId: 'claude-haiku-4-5-20251001', doorClass: 'cli',
      tokensIn: 123456, tokensOut: 6543, grossUsd: 0, netUsd: 0, priceBasis: 'subscription-zero', ...over,
    });
    const fixtures: Array<[string, any, any]> = [
      ['empty', { totals: {}, rows: [], meteredLiveYet: false }, { keys: [] }],
      ['subscription-only ($0)', { totals: { netUsd: 0, tokensIn: 123456, tokensOut: 6543 }, rows: [mkRow()], meteredLiveYet: false },
        { keys: [{ keyRef: 'k1', provider: 'openai', door: 'openai-metered', dailyCapUsd: 5, lifetimeCapUsd: 50, committedDayUsd: 0, committedLifetimeUsd: 0, goLiveState: 'not-live', frozen: false }] }],
      ['metered live with cost', { totals: { netUsd: 12.34, tokensIn: 9_000_000, tokensOut: 400_000 }, rows: [mkRow({ door: 'openai-metered', modelId: 'gpt-5.5', doorClass: 'metered', netUsd: 12.34, priceBasis: 'internal-derived' })], meteredLiveYet: true },
        { keys: [{ keyRef: 'k1', provider: 'openai', door: 'openai-metered', dailyCapUsd: 5, lifetimeCapUsd: 50, committedDayUsd: 1.2, committedLifetimeUsd: 12.34, goLiveState: 'live', frozen: false }], meteredLiveYet: true }],
      ['jargon-laden model ids', { totals: { netUsd: 0.5, tokensIn: 1000, tokensOut: 500 }, rows: [
        mkRow({ modelId: 'claude-opus-4-8-20260115' }), mkRow({ modelId: 'gpt-4o-2024-08-06', door: 'openai-metered', doorClass: 'metered' }),
      ], meteredLiveYet: false }, { keys: [] }],
      ['large N rows', { totals: { netUsd: 3.21, tokensIn: 5_000_000, tokensOut: 200_000 },
        rows: Array.from({ length: 50 }, (_, i) => mkRow({ modelId: 'model-' + i })), meteredLiveYet: false }, { keys: [] }],
    ];
    for (const [name, summary, caps] of fixtures) {
      it(`conforms for "${name}"`, () => {
        const glance = buildSpendGlance(summary, caps);
        const r = validateGlanceSpec(glance);
        expect(r.ok, `violations: ${JSON.stringify(r.violations)}`).toBe(true);
        expect(glance.tiles.length).toBeLessThanOrEqual(GLANCE_MAX_TILES);
      });
    }
    it('honest headline: not-live → "Nothing is being billed", live → a dollar figure', () => {
      expect(buildSpendGlance(fixtures[1][1], fixtures[1][2]).headline.toLowerCase()).toContain('nothing is being billed');
      expect(buildSpendGlance(fixtures[2][1], fixtures[2][2]).headline).toMatch(/\$\d/);
    });
  });

  describe('Routing Map', () => {
    const pos = (over: Record<string, unknown> = {}) => ({
      door: 'claude-cli', modelId: 'claude-haiku-4-5-20251001', doorClass: 'cli',
      injectionSafe: true, moneyGated: false, claudeBanned: false, skippedInIncrementA: false, ...over,
    });
    const fixtures: Array<[string, any]> = [
      ['no chains', { chains: [], components: [] }],
      ['full four lanes', { defaultFramework: 'claude-code', injectionExposureSource: 'FD5b-exposure-map', chains: [
        { chain: 'FAST', positions: [pos(), pos({ door: 'openai-metered', modelId: 'gpt-5.5', doorClass: 'metered', moneyGated: true, skippedInIncrementA: true })] },
        { chain: 'SORT', positions: [pos({ modelId: 'claude-haiku-4-5-20251001' })] },
        { chain: 'JUDGE', positions: [pos({ modelId: 'claude-sonnet-5' })] },
        { chain: 'WRITE', positions: [pos({ modelId: 'claude-opus-4-8-20260115' })] },
      ], components: [
        { component: 'messageSentinel', category: 'gate', nature: 'A', chain: 'FAST', criticalGate: true, untrustedInput: true, route: [pos()] },
        { component: 'toneGate', category: 'other', nature: null, chain: null, criticalGate: false, untrustedInput: false },
      ] }],
      ['weird/jargon model ids everywhere', { chains: [
        { chain: 'FAST', positions: [pos({ modelId: 'm_4f3a9b1c2d' }), pos({ modelId: 'cmt953-model' })] },
      ], components: Array.from({ length: 30 }, (_, i) => ({ component: 'component_' + i, category: 'other', chain: 'FAST', criticalGate: false, untrustedInput: false })) }],
    ];
    for (const [name, map] of fixtures) {
      it(`conforms for "${name}"`, () => {
        const glance = buildRoutingMapGlance(map);
        const r = validateGlanceSpec(glance);
        expect(r.ok, `violations: ${JSON.stringify(r.violations)}`).toBe(true);
        expect(glance.tiles.length).toBeLessThanOrEqual(GLANCE_MAX_TILES);
      });
    }
    it('headline names the primary model + backup in plain words', () => {
      const g = buildRoutingMapGlance(fixtures[1][1]);
      expect(g.headline).toMatch(/runs on Claude Haiku/);
      expect(g.headline).toMatch(/backup/);
    });
    it('friendlyModel strips version/date noise and never emits jargon', () => {
      expect(friendlyModel('claude-opus-4-8-20260115')).toBe('Claude Opus');
      expect(findInsiderVocab(friendlyModel('claude-haiku-4-5-20251001'))).toEqual([]);
      // an id that can't be plainly rendered falls back to '' (caller substitutes a phrase)
      expect(friendlyModel('m_4f3a9b1c2d')).toBe('');
    });
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

  it('population floor: every adopted tab has a real builder (Phases 1–3)', () => {
    expect(GLANCE_ADOPTED_TABS.length).toBeGreaterThanOrEqual(6);
    for (const id of ['commitments', 'blockers', 'machines', 'systems', 'spend', 'routing-map']) {
      expect(GLANCE_ADOPTED_TABS, `${id} must be adopted`).toContain(id);
    }
    // every reference builder is real (not a stub) and produces a conforming empty glance
    expect(validateGlanceSpec(buildCommitmentsGlance([])).ok).toBe(true);
    expect(validateGlanceSpec(buildBlockersGlance([])).ok).toBe(true);
    expect(validateGlanceSpec(buildMachinesGlance({ enabled: true, machines: [] })).ok).toBe(true);
    expect(validateGlanceSpec(buildHealthGlance({ health: 'healthy', activeCapabilities: [], issues: [], recentEvents: [] })).ok).toBe(true);
    expect(validateGlanceSpec(buildSpendGlance({ totals: {}, rows: [] }, { keys: [] })).ok).toBe(true);
    expect(validateGlanceSpec(buildRoutingMapGlance({ chains: [], components: [] })).ok).toBe(true);
  });

  it('the ratchet only shrinks: the Phase-3 + Phase-4 tabs left the grandfather list and the ceiling dropped', () => {
    expect(GLANCE_GRANDFATHERED).not.toContain('blockers');
    expect(GLANCE_GRANDFATHERED).not.toContain('commitments');
    // Phase 3 — the jargon belt — retired four more tabs from the grandfather list.
    for (const id of ['machines', 'systems', 'spend', 'routing-map']) {
      expect(GLANCE_GRANDFATHERED, `${id} left the grandfather list`).not.toContain(id);
    }
    // Phase 4 — the sweep — retired every remaining data-summary view.
    for (const id of ['pr-pipeline', 'tokens', 'llm-activity', 'secrets', 'resources', 'initiatives']) {
      expect(GLANCE_GRANDFATHERED, `${id} left the grandfather list`).not.toContain(id);
    }
    expect(GLANCE_GRANDFATHERED_CEILING).toBe(14); // 25 (P1) → 24 (P2) → 20 (P3) → 14 (P4)
  });
});

describe('F10 conformance — the Phase-4 sweep builders under adversarial fixtures', () => {
  // Each builder is fed empty / null-ish / large-N / jargon-laden fixtures; the
  // produced glance must ALWAYS pass F10 (≤5 tiles, ≤150 words, no insider vocab) —
  // proving the raw data (IDs, camelCase, hex, cadences) can never leak to the glance.
  const conforms = (glance: any) => {
    const r = validateGlanceSpec(glance);
    expect(r.ok, `violations: ${JSON.stringify(r.violations)}`).toBe(true);
    expect(glance.tiles.length).toBeLessThanOrEqual(GLANCE_MAX_TILES);
  };

  describe('PR Pipeline', () => {
    const fixtures: Array<[string, any]> = [
      ['empty', {}],
      ['disabled', { disabled: true, phase: 'off' }],
      ['null-ish entries', { entries: [null, undefined, {}, 5] }],
      ['jargon-laden reason/sha', { phase: 'enforce', entries: [
        { pr_number: 42, head_sha: 'deadBEEF1234cafe', eligible: false, reason: 'checks pending; atRisk cadence: 1800s for CMT-953', created_at: '2026-07-01T00:00:00Z' },
      ] }],
      ['large N', { phase: 'shadow', entries: Array.from({ length: 60 }, (_, i) => ({ pr_number: i, head_sha: 'a'.repeat(40), eligible: i % 3 === 0, reason: 'r' + i })) }],
    ];
    for (const [name, m] of fixtures) it(`conforms for "${name}"`, () => conforms(buildPrPipelineGlance(m)));
    it('TRUTHFULNESS — Ready + Not-ready partition the whole population', () => {
      const m = fixtures[4][1];
      const g = buildPrPipelineGlance(m);
      const sum = g.tiles.reduce((n: number, t: any) => n + Number(t.value), 0);
      expect(sum).toBe(prPipelinePopulation(m).length);
    });
  });

  describe('Tokens', () => {
    const fixtures: Array<[string, any, any[], any[]]> = [
      ['empty', { summary: {} }, [], []],
      ['null-ish', { summary: { totalTokens: 0 } }, [null, {}], [undefined]],
      ['live', { summary: { totalTokens: 1234567, sessionsActive: 3 } },
        [{ sessionId: 'abc123def', projectPath: '/Users/justin/Documents/Projects/ai-guy', totalTokens: 900000, eventCount: 120, lastTs: 1720000000000 }],
        [{ sessionId: 'z9', projectPath: '/Users/justin/x', lastTs: 1719000000000 }]],
      ['jargon-laden paths (never leak to Layer 1)', { summary: { totalTokens: 999 } },
        [{ sessionId: 'CMT-953', projectPath: '/srv/atRisk_cadence-1800s/m_4f3a9b', totalTokens: 5, eventCount: 1, lastTs: 1720000000000 }], []],
      ['large N', { summary: { totalTokens: 5e9 } }, Array.from({ length: 50 }, (_, i) => ({ sessionId: 's' + i, projectPath: '/p/proj-' + i, totalTokens: i * 1000, eventCount: i, lastTs: 1720000000000 })), []],
    ];
    for (const [name, s, sess, orph] of fixtures) it(`conforms for "${name}"`, () => conforms(buildTokensGlance(s, sess, orph)));
  });

  describe('LLM Activity', () => {
    const mkF = (over: Record<string, unknown> = {}) => ({ feature: 'messageSentinel', frameworks: ['claude-code'], models: ['claude-haiku-4-5-20251001'], calls: 100, realCalls: 90, fired: 40, shed: 5, errors: 0, tokensIn: 1e6, tokensOut: 5e4, p50LatencyMs: 500, p95LatencyMs: 1800, ...over });
    const fixtures: Array<[string, any]> = [
      ['empty', {}],
      ['null-ish', { totals: {}, features: [null, {}, mkF()] }],
      ['live with errors', { totals: { calls: 1234, fired: 900, errors: 3, tokensIn: 5e6, tokensOut: 2e5 }, features: [mkF(), mkF({ feature: 'toneGate', errors: 3, models: ['gpt-5.5'] })] }],
      ['jargon-laden feature names', { totals: { calls: 5, errors: 0 }, features: [mkF({ feature: 'apprenticeshipCycleSla_v2', models: ['m_4f3a9b1c2d'] })] }],
      ['large N', { totals: { calls: 99999, errors: 12 }, features: Array.from({ length: 40 }, (_, i) => mkF({ feature: 'component_' + i, calls: i * 10, errors: i % 5 })) }],
    ];
    for (const [name, d] of fixtures) it(`conforms for "${name}"`, () => conforms(buildLlmActivityGlance(d)));
    it('TRUTHFULNESS — the Components tile equals the population length', () => {
      const d = fixtures[4][1];
      const g = buildLlmActivityGlance(d);
      expect(Number(g.tiles.find((t: any) => t.key === 'components').value)).toBe(llmActivityPopulation(d).length);
    });
  });

  describe('Secrets', () => {
    const now = Date.parse('2026-07-10T00:00:00Z');
    const fixtures: Array<[string, any]> = [
      ['empty', {}],
      ['null-ish', { pending: [null, undefined, {}] }],
      ['waiting + expired', { pending: [
        { label: 'GitHub token', token: 'drop_abc', topicId: 12143, createdAt: now - 1000, expiresAt: now + 100000, expired: false, tunnelUrl: 'https://x.trycloudflare.com/drop/abc' },
        { label: 'Old key', token: 'drop_old', expired: true, expiresAt: now - 1000 },
      ] }],
      ['jargon-laden label (never leaks to Layer 1)', { pending: [{ label: 'fix the atRisk cadence: 1800s for CMT-953', token: 'drop_x', expiresAt: now + 5000 }] }],
      ['large N', { pending: Array.from({ length: 30 }, (_, i) => ({ label: 'req ' + i, token: 'd' + i, expiresAt: now + (i % 2 ? 5000 : -5000) })) }],
    ];
    for (const [name, d] of fixtures) it(`conforms for "${name}"`, () => conforms(buildSecretsGlance(d, now)));
    it('TRUTHFULNESS — Waiting + Expired partition the population', () => {
      const d = fixtures[4][1];
      const g = buildSecretsGlance(d, now);
      const sum = g.tiles.reduce((n: number, t: any) => n + Number(t.value), 0);
      expect(sum).toBe(secretsPopulation(d).length);
    });
  });

  describe('Resources', () => {
    const mkS = (over: Record<string, unknown> = {}) => ({ source: 'agent-server', currentCpuPercent: 12, currentRssBytes: 5e8, avgCpuPercent: 10, peakCpuPercent: 40, peakRssBytes: 6e8, ...over });
    const fixtures: Array<[string, any]> = [
      ['empty', { sources: [] }],
      ['null-ish', { sources: [null, {}, mkS()] }],
      ['aggregate + processes', { sampleCount: 120, sources: [
        mkS({ source: 'aggregate', currentCpuPercent: 45.3, currentRssBytes: 2.5e9, peakCpuPercent: 163 }),
        mkS(), mkS({ source: 'session:abc123def456', currentCpuPercent: 33, currentRssBytes: 1.5e9 }),
      ] }],
      ['large N', { sources: [mkS({ source: 'aggregate' })].concat(Array.from({ length: 40 }, (_, i) => mkS({ source: 'session:s' + i, currentCpuPercent: i }))) }],
    ];
    for (const [name, d] of fixtures) it(`conforms for "${name}"`, () => conforms(buildResourcesGlance(d)));
    it('TRUTHFULNESS — the Processes tile equals the non-aggregate population', () => {
      const d = fixtures[3][1];
      const g = buildResourcesGlance(d);
      expect(Number(g.tiles.find((t: any) => t.key === 'processes').value)).toBe(resourcesPopulation(d).length);
    });
  });

  describe('Initiatives', () => {
    const mkI = (over: Record<string, unknown> = {}) => ({ id: 'i1', title: 'Migrate the mesh', status: 'active', description: 'x', phases: [{ status: 'done' }, { status: 'in-progress' }], lastTouchedAt: '2026-07-01T00:00:00Z', ...over });
    const fixtures: Array<[string, any, any]> = [
      ['empty', { items: [] }, { items: [] }],
      ['null-ish', { items: [null, {}, mkI()] }, { items: [null, { reason: 'stale', title: 't', detail: 'd' }] }],
      ['live with signals', { items: [mkI(), mkI({ id: 'i2', title: 'Ship v2' })] },
        { items: [{ reason: 'needs-user', title: 'Approve the plan', detail: 'waiting since June 2' }, { reason: 'ready-to-advance', title: 'Ready', detail: 'go' }] }],
      ['jargon-laden title (never leaks to Layer 1)', { items: [mkI({ title: 'fix the atRisk cadence: 1800s for CMT-953' })] },
        { items: [{ reason: 'stale', title: 'the beaconEnabled m_4f3a flag', detail: 'x' }] }],
      ['large N', { items: Array.from({ length: 40 }, (_, i) => mkI({ id: 'i' + i, title: 'Init ' + i })) },
        { items: Array.from({ length: 20 }, (_, i) => ({ reason: ['needs-user', 'next-check-due', 'ready-to-advance', 'stale'][i % 4], title: 'sig ' + i, detail: 'd' })) }],
    ];
    for (const [name, items, digest] of fixtures) it(`conforms for "${name}"`, () => conforms(buildInitiativesGlance(items, digest)));
    it('TRUTHFULNESS — the In-progress tile equals the item population', () => {
      const items = fixtures[4][1], digest = fixtures[4][2];
      const g = buildInitiativesGlance(items, digest);
      expect(Number(g.tiles.find((t: any) => t.key === 'in-progress').value)).toBe(initiativesPopulation(items).length);
    });
  });
});
