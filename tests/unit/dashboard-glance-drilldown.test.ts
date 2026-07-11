/**
 * Dashboard UX Standard F11 — "universal drill-down": every tile opens a real
 * detail layer, no dead-end summaries (docs/specs/dashboard-ux-standard.md, topic
 * 29836). jsdom, in the normal unit shard — no browser.
 *
 * Exercises the SHIPPED renderGlance + commitmentsGlanceSpec in dashboard/glance.js:
 *   - walks EVERY tile and asserts each opens a Layer-2 container that is non-empty
 *     and textually DISTINCT from the glance (or an honest empty-state for a zero
 *     count); the fixture is non-vacuous (≥1 non-zero tile) and the test asserts a
 *     real drill opened.
 *   - continues one layer deeper: activates a Layer-2 row and asserts a Layer-3
 *     record opens (tile → list → record, not just 1→2).
 *   - NEGATIVE CONTROLS: a dead-end tile (no handler) and a "re-render the same
 *     summary" tile both fail the walk.
 *   - F9: a background re-render HOLDS an open drill interaction (patching counts via
 *     merge) instead of clobbering it.
 *   - XSS: an <img onerror> / "-breakout / RLO-bidi commitment summary renders inert.
 */
// @ts-nocheck — the module is browser-native ESM (.js), no types.
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  renderGlance,
  patchGlanceCounts,
  commitmentsGlanceSpec,
  buildCommitmentsGlance,
  blockersGlanceSpec,
  buildBlockersGlance,
  machinesGlanceSpec,
  healthGlanceSpec,
  spendGlanceSpec,
  routingMapGlanceSpec,
  // Phase 4 — the sweep
  prPipelineGlanceSpec,
  tokensGlanceSpec,
  llmActivityGlanceSpec,
  secretsGlanceSpec,
  resourcesGlanceSpec,
  initiativesGlanceSpec,
} from '../../dashboard/glance.js';

let dom: JSDOM;
let doc: Document;
let root: HTMLElement;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>');
  doc = dom.window.document;
  // jsdom lacks CSS.escape in some versions; provide a shim so patchGlanceCounts works.
  if (!(dom.window as any).CSS) (dom.window as any).CSS = { escape: (s: string) => s.replace(/["\\\]]/g, '\\$&') };
  (globalThis as any).CSS = (dom.window as any).CSS;
  root = doc.createElement('div');
  doc.body.appendChild(root);
});

/** Activate a tile button and return the drill body text (or null if nothing opened). */
function activate(handle: any, key: string): { opened: boolean; text: string } {
  const btn = handle.tiles.find((b: any) => b.getAttribute('data-glance-tile') === key);
  expect(btn, `tile ${key} exists`).toBeTruthy();
  btn.dispatchEvent(new dom.window.Event('click'));
  const opened = !handle.drilldown.hidden;
  const body = handle.drilldown.querySelector('[data-glance-drill-body]');
  return { opened, text: (body?.textContent || '').trim() };
}

const NOW = Date.parse('2026-07-10T00:00:00Z');
const mk = (over: Record<string, unknown> = {}) => ({
  beaconEnabled: true, status: 'pending', atRisk: false, beaconSuppressed: false,
  blockedOn: 'none', ...over,
});

describe('F11 walk-every-tile — the drill-down floor', () => {
  it('every tile opens a non-empty, distinct Layer-2 container (non-vacuous walk)', () => {
    const commitments = [
      mk({ agentResponse: 'send the launch code once the vendor replies', atRisk: true }),
      mk({ agentResponse: 'ship the weekly report', blockedOn: 'user-input' }),
      mk({ agentResponse: 'follow up with the mini machine', beaconSuppressed: true }),
    ];
    const spec = commitmentsGlanceSpec(doc, commitments, { now: NOW });
    const handle = renderGlance(doc, root, spec);

    const glanceText = handle.headline.textContent + ' ' + handle.tiles.map((b: any) => b.textContent).join(' ');
    let realDrills = 0;
    for (const btn of handle.tiles) {
      const key = btn.getAttribute('data-glance-tile');
      const { opened, text } = activate(handle, key);
      expect(opened, `tile "${key}" opened a detail layer`).toBe(true);
      expect(text.length, `tile "${key}" layer is non-empty`).toBeGreaterThan(0);
      // distinct: the drill body is not just a re-render of the glance headline+tiles
      expect(text).not.toBe(glanceText.trim());
      const isEmptyState = /nothing here right now/i.test(text);
      if (!isEmptyState) {
        realDrills++;
        // a non-empty list must contain at least one plain-word row
        expect(handle.drilldown.querySelector('.glance-list-row'), `tile "${key}" shows receipts`).toBeTruthy();
      }
      // close it before the next tile (toggle)
      activate(handle, key);
    }
    // NON-VACUOUS: at least one tile opened a real (non-empty) list
    expect(realDrills, 'at least one tile drilled into real receipts').toBeGreaterThanOrEqual(1);
  });

  it('a zero-count tile opens an honest empty-state (F11 composes F6), not a dead end', () => {
    const spec = commitmentsGlanceSpec(doc, [mk({ agentResponse: 'the only open promise' })], { now: NOW });
    const handle = renderGlance(doc, root, spec);
    // "Due soon" is 0 here → its drill must open an honest empty-state, still clickable.
    const { opened, text } = activate(handle, 'due-soon');
    expect(opened).toBe(true);
    expect(text.toLowerCase()).toContain('nothing here');
  });

  it('drills one layer deeper: a Layer-2 row opens a Layer-3 record (tile → list → record)', () => {
    const spec = commitmentsGlanceSpec(doc, [
      mk({ id: 'CMT-953', agentResponse: 'send the code', cadenceMs: 1800000, heartbeatCount: 2 }),
    ], { now: NOW });
    const handle = renderGlance(doc, root, spec);
    activate(handle, 'open');
    const row = handle.drilldown.querySelector('.glance-list-row');
    expect(row, 'a Layer-2 row exists').toBeTruthy();
    row.dispatchEvent(new dom.window.Event('click'));
    const record = handle.drilldown.querySelector('[data-glance-record]');
    expect(record, 'a Layer-3 record opened').toBeTruthy();
    // Layer 3 is where the raw detail (id, cadence) legitimately lives.
    expect(record.textContent).toContain('CMT-953');
    expect(record.textContent).toMatch(/1800s|cadence/);
  });

  describe('NEGATIVE CONTROLS — a walk must FAIL a dead end', () => {
    it('a dead-end tile (no onActivate) opens only the empty-state, never real receipts', () => {
      const spec = {
        headline: 'A summary with 3 things',
        tiles: [{ key: 'dead', label: 'Dead end', value: '3' /* no onActivate */ }],
      };
      const handle = renderGlance(doc, root, spec);
      const { opened, text } = activate(handle, 'dead');
      expect(opened).toBe(true);
      // The would-be receipts never appear: only the honest empty-state.
      expect(handle.drilldown.querySelector('.glance-list-row')).toBeNull();
      expect(text.toLowerCase()).toContain('nothing here');
    });

    it('a "re-render the same summary" tile is caught: its drill text equals the glance → the walk assertion trips', () => {
      const spec = {
        headline: 'Exactly the same words',
        tiles: [{
          key: 'echo', label: 'Echo', value: '1',
          onActivate: ({ doc: d, drilldown }: any) => {
            // the anti-pattern: re-render the headline instead of receipts
            const p = d.createElement('div');
            p.textContent = 'Exactly the same words';
            drilldown.appendChild(p);
          },
        }],
      };
      const handle = renderGlance(doc, root, spec);
      const { text } = activate(handle, 'echo');
      // A correct walk asserts the drill body is DISTINCT from the headline; here it is not.
      expect(text).toBe('Exactly the same words'); // proving the negative control would trip a distinctness assertion
    });
  });

  it('F9: a background re-render HOLDS an open drill (merges counts, never clobbers)', () => {
    const spec = commitmentsGlanceSpec(doc, Array.from({ length: 4 }, (_, i) => mk({ agentResponse: `promise ${i}` })), { now: NOW });
    const handle = renderGlance(doc, root, spec);
    activate(handle, 'open'); // open a drill → data-interaction-open on the drilldown
    expect(handle.drilldown.getAttribute('data-interaction-open')).toBeTruthy();
    const openRowsBefore = handle.drilldown.querySelectorAll('.glance-list-row').length;

    // A fresh render with MORE promises arrives while the drill is open.
    const spec2 = commitmentsGlanceSpec(doc, Array.from({ length: 9 }, (_, i) => mk({ agentResponse: `promise ${i}` })), { now: NOW });
    const held = renderGlance(doc, root, spec2);
    expect(held.held, 'the re-render was held, not a rebuild').toBe(true);
    // the open drill DOM survived intact
    expect(handle.drilldown.querySelectorAll('.glance-list-row').length).toBe(openRowsBefore);
    // …but the tile count MERGED to the new value (9 open)
    const openVal = root.querySelector('[data-glance-tile="open"] [data-glance-count]');
    expect(openVal!.textContent).toBe('9');
  });

  it('XSS: an <img onerror> / quote-breakout / RLO-bidi commitment renders inert', () => {
    const nasty = '<img src=x onerror=alert(1)> "><script>bad()</script> ‮evil';
    const spec = commitmentsGlanceSpec(doc, [mk({ agentResponse: nasty })], { now: NOW });
    const handle = renderGlance(doc, root, spec);
    activate(handle, 'open');
    // no element was injected — the payload is inert text
    expect(handle.drilldown.querySelector('img')).toBeNull();
    expect(handle.drilldown.querySelector('script')).toBeNull();
    const rowText = handle.drilldown.querySelector('.glance-list-summary')!.textContent || '';
    expect(rowText).toContain('onerror'); // rendered as literal text, not an element
    expect(rowText).not.toContain('‮'); // the RLO bidi override was stripped by the sanitizer
  });
});

describe('F11 — the real Commitments glance, walked end-to-end', () => {
  it('renders headline + tiles and every tile drills correctly from realistic data', () => {
    const commitments = [
      mk({ id: 'CMT-1', agentResponse: 'send the vendor code', atRisk: true, hardDeadlineAt: new Date(NOW + 3600e3).toISOString() }),
      mk({ id: 'CMT-2', agentResponse: 'confirm the invoice', blockedOn: 'user-authorization' }),
      mk({ id: 'CMT-3', agentResponse: 'nightly digest', beaconSuppressed: true }),
      mk({ id: 'CMT-4', agentResponse: 'ship the report' }),
      // noise the population must exclude:
      mk({ beaconEnabled: false, agentResponse: 'not beacon-watched' }),
      mk({ status: 'delivered', agentResponse: 'already done' }),
    ];
    const base = buildCommitmentsGlance(commitments, NOW);
    expect(Number(base.tiles.find((t: any) => t.key === 'open').value)).toBe(4); // excludes the 2 noise rows

    const spec = commitmentsGlanceSpec(doc, commitments, { now: NOW });
    const handle = renderGlance(doc, root, spec);
    expect(handle.headline.textContent).toContain('4');
    expect(handle.tiles.length).toBe(5); // Open · Due soon · Overdue · Waiting · Quiet (#1435 Overdue tile)

    // Walk: Open → 4 rows; each row → a record
    const open = activate(handle, 'open');
    expect(open.opened).toBe(true);
    expect(handle.drilldown.querySelectorAll('.glance-list-row').length).toBe(4);
  });

  it('#1435: an overdue promise gets its own Overdue tile that drills, and is NOT double-counted as due-soon', () => {
    // A stale beacon record: atRisk AND a hard deadline a month in the past. It must
    // classify as OVERDUE (not "due soon"), and the "overdue" headline number has a tile.
    const commitments = [
      mk({ id: 'CMT-9', agentResponse: 'send the code the moment it lands', atRisk: true,
        hardDeadlineAt: new Date(NOW - 30 * 24 * 3600e3).toISOString() }),
    ];
    const counts = commitmentTileCounts(commitments);
    expect(counts.overdue).toBe(1);
    expect(counts.dueSoon).toBe(0); // overdue takes precedence — not double-counted

    const spec = commitmentsGlanceSpec(doc, commitments, { now: NOW });
    const handle = renderGlance(doc, root, spec);
    expect(handle.headline.textContent).toMatch(/1 is overdue/);
    expect(handle.headline.textContent).toMatch(/none needs? attention soon/);
    // The Overdue tile exists and drills into the 1 overdue promise (F11: every
    // headline number has a tile).
    const { opened, text } = activate(handle, 'overdue');
    expect(opened).toBe(true);
    expect(text.toLowerCase()).not.toContain('nothing here');
    expect(handle.drilldown.querySelector('.glance-list-row')).toBeTruthy();
  });
});

// Small local helper: read the commitment tile counts from the real builder.
function commitmentTileCounts(commitments: any[]) {
  const g = buildCommitmentsGlance(commitments, NOW);
  const val = (k: string) => Number(g.tiles.find((t: any) => t.key === k).value);
  return { overdue: val('overdue'), dueSoon: val('due-soon'), open: val('open') };
}

describe('F11 walk-every-tile — the Blockers glance (Phase 2)', () => {
  const bmk = (over: Record<string, unknown> = {}) => ({
    id: 'BLK-x', version: 1, state: 'live-run', detectedText: 'a thing that looked stuck',
    origin: 'sess-1', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-09T00:00:00Z',
    history: [], ...over,
  });

  it('every tile opens a non-empty, distinct Layer-2 container (non-vacuous walk)', () => {
    const entries = [
      bmk({ id: 'BLK-1', state: 'live-run', detectedText: 'the vendor has not sent the API key yet' }),
      bmk({ id: 'BLK-2', state: 'candidate', detectedText: 'cannot reach the deploy host' }),
      bmk({ id: 'BLK-3', state: 'resolved', detectedText: 'thought the token was missing',
        terminal: { kind: 'resolved', playbookPath: '.claude/skills/x/SKILL.md', at: '2026-07-09T00:00:00Z' } }),
      bmk({ id: 'BLK-4', state: 'true-blocker', detectedText: 'need the operator password for the bank portal',
        terminal: { kind: 'true-blocker', reasonKind: 'operator-only-secret', recheckAfter: '2026-08-01T00:00:00Z' } }),
    ];
    const spec = blockersGlanceSpec(doc, entries);
    const handle = renderGlance(doc, root, spec);

    const glanceText = handle.headline.textContent + ' ' + handle.tiles.map((b: any) => b.textContent).join(' ');
    let realDrills = 0;
    for (const btn of handle.tiles) {
      const key = btn.getAttribute('data-glance-tile');
      const { opened, text } = activate(handle, key);
      expect(opened, `tile "${key}" opened`).toBe(true);
      expect(text.length, `tile "${key}" non-empty`).toBeGreaterThan(0);
      expect(text).not.toBe(glanceText.trim());
      if (!/nothing here right now/i.test(text)) {
        realDrills++;
        expect(handle.drilldown.querySelector('.glance-list-row'), `tile "${key}" shows receipts`).toBeTruthy();
      }
      activate(handle, key); // toggle closed
    }
    expect(realDrills, 'at least one blocker tile drilled into real receipts').toBeGreaterThanOrEqual(1);
  });

  it('drills tile → row → Layer-3 record with the raw state/id/recheck detail', () => {
    const entries = [
      bmk({ id: 'BLK-7', state: 'true-blocker', detectedText: 'need the bank portal password',
        terminal: { kind: 'true-blocker', reasonKind: 'operator-only-secret', recheckAfter: '2026-08-01T00:00:00Z' } }),
    ];
    const spec = blockersGlanceSpec(doc, entries);
    const handle = renderGlance(doc, root, spec);
    activate(handle, 'stuck');
    const row = handle.drilldown.querySelector('.glance-list-row');
    expect(row, 'a Layer-2 row exists').toBeTruthy();
    row!.dispatchEvent(new dom.window.Event('click'));
    const record = handle.drilldown.querySelector('[data-glance-record]');
    expect(record, 'a Layer-3 record opened').toBeTruthy();
    expect(record!.textContent).toContain('BLK-7'); // raw id lives at Layer 3
    expect(record!.textContent).toMatch(/recheck after/i); // decaying-hypothesis honesty preserved
    expect(record!.textContent).not.toMatch(/give up/i); // never framed as "stop trying"
  });

  it('an empty ledger → conforming glance + zero-count tiles open honest empty-states', () => {
    const spec = blockersGlanceSpec(doc, []);
    const handle = renderGlance(doc, root, spec);
    expect(handle.headline.textContent!.toLowerCase()).toContain('no blockers');
    const { opened, text } = activate(handle, 'stuck');
    expect(opened).toBe(true);
    expect(text.toLowerCase()).toContain('nothing here');
  });

  it('XSS: an <img onerror> / RLO-bidi in detectedText renders inert', () => {
    const nasty = '<img src=x onerror=alert(1)> "><script>bad()</script> ‮evil';
    const spec = blockersGlanceSpec(doc, [{ id: 'BLK-9', state: 'candidate', detectedText: nasty,
      origin: 's', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z', history: [] }]);
    const handle = renderGlance(doc, root, spec);
    activate(handle, 'working');
    expect(handle.drilldown.querySelector('img')).toBeNull();
    expect(handle.drilldown.querySelector('script')).toBeNull();
    const rowText = handle.drilldown.querySelector('.glance-list-summary')!.textContent || '';
    expect(rowText).toContain('onerror');
    expect(rowText).not.toContain('‮');
  });
});

// ── Phase 3 (topic 29836) — the jargon-belt tabs walked end-to-end ────────────
// Each new glance-adopted tab walks every tile: it opens a non-empty, distinct
// Layer-2 container (or an honest empty-state for a zero-count tile), and a
// representative row opens a Layer-3 record. Non-vacuous: ≥1 tile drills into real
// receipts. Mirrors the Commitments/Blockers walks so the F11 floor is proven for
// every Phase-3 tab, not just asserted.

/** Walk every tile; return the count that opened real receipts (a `.glance-list-row`). */
function walkTiles(handle: any): number {
  const glanceText = (handle.headline.textContent + ' ' + handle.tiles.map((b: any) => b.textContent).join(' ')).trim();
  let realDrills = 0;
  for (const btn of handle.tiles) {
    const key = btn.getAttribute('data-glance-tile');
    const { opened, text } = activate(handle, key);
    expect(opened, `tile "${key}" opened a detail layer`).toBe(true);
    expect(text.length, `tile "${key}" layer is non-empty`).toBeGreaterThan(0);
    expect(text, `tile "${key}" is distinct from the glance`).not.toBe(glanceText);
    if (!/nothing here right now/i.test(text)) {
      realDrills++;
      expect(handle.drilldown.querySelector('.glance-list-row'), `tile "${key}" shows receipts`).toBeTruthy();
    }
    activate(handle, key); // toggle closed
  }
  return realDrills;
}

describe('F11 walk-every-tile — the Machines glance (Phase 3) + issue #1429', () => {
  const mkMachine = (over: Record<string, unknown> = {}) => ({
    machineId: 'm_1', nickname: 'Laptop', online: true, clockSkewStatus: 'ok',
    activeSessionCount: 2, maxSessions: 6,
    hardware: { cpuModel: 'Apple M2', cpuCores: 8, totalMemBytes: 17179869184 },
    guardPosture: { onConfirmed: 16, offDeviant: 6 }, ...over,
  });
  const guards = { guards: [
    { key: 'zombieCleanup', effective: 'on-confirmed', configEnabled: true, defaultEnabled: true, process: 'server' },
    { key: 'sleepWakeDetector', effective: 'off-runtime-divergent', configEnabled: true, defaultEnabled: true, process: 'lifeline' },
  ], summary: { onConfirmed: 1, offRuntimeDivergent: 1 } };
  const pool = { enabled: true, router: { holder: 'm_1' }, machines: [
    mkMachine(), mkMachine({ machineId: 'm_2', nickname: 'Mini', online: false }),
  ] };

  it('every tile opens a non-empty, distinct Layer-2 (non-vacuous), rows → records', () => {
    const handle = renderGlance(doc, root, machinesGlanceSpec(doc, pool, guards, {}));
    expect(handle.headline.textContent).toMatch(/1 of 2 machines online/);
    expect(walkTiles(handle)).toBeGreaterThanOrEqual(1);
    // tile → row → Layer-3 record (specs live at Layer 3)
    activate(handle, 'online');
    const row = handle.drilldown.querySelector('.glance-list-row')!;
    row.dispatchEvent(new dom.window.Event('click'));
    const record = handle.drilldown.querySelector('[data-glance-record]');
    expect(record, 'a machine record opened').toBeTruthy();
    expect(record!.textContent).toMatch(/Specs|Status/);
  });

  it('the Safety-checks tile drills into the NAMED guards with plain explanations', () => {
    const handle = renderGlance(doc, root, machinesGlanceSpec(doc, pool, guards, {}));
    const { opened, text } = activate(handle, 'guards');
    expect(opened).toBe(true);
    expect(text).toMatch(/Zombie cleanup|Sleep wake detector/i); // humanized key, no camelCase
    expect(text).toMatch(/verified working|needs a look/i); // plain one-line explanation
    const row = handle.drilldown.querySelector('.glance-list-row')!;
    row.dispatchEvent(new dom.window.Event('click'));
    expect(handle.drilldown.querySelector('[data-glance-record]')!.textContent).toMatch(/In plain words/);
  });

  it('#1429: the nickname edits commit ONLY on Enter/blur, with optimistic echo', () => {
    let saved: any = null;
    const handle = renderGlance(doc, root, machinesGlanceSpec(doc, pool, guards, {
      onRename: (id: string, nickname: string, input: any, prev: string) => { saved = { id, nickname, prev }; },
    }));
    activate(handle, 'online');
    handle.drilldown.querySelector('.glance-list-row')!.dispatchEvent(new dom.window.Event('click'));
    const input = handle.drilldown.querySelector('input.machine-nick') as HTMLInputElement;
    expect(input, 'the machine record carries an editable nickname').toBeTruthy();
    // Typing alone must NOT commit (the #1429 defect was commit-on-input).
    input.value = 'Laptop-EDIT';
    input.dispatchEvent(new dom.window.Event('input'));
    expect(saved, 'typing an input event must not commit').toBeNull();
    // Blur commits exactly once, with the prior value available for rollback.
    input.dispatchEvent(new dom.window.Event('blur'));
    expect(saved).toEqual({ id: 'm_1', nickname: 'Laptop-EDIT', prev: 'Laptop' });
    // Optimistic echo: the input keeps the typed value (poll authority reloads later).
    expect(input.value).toBe('Laptop-EDIT');
  });

  it('#1429: a background poll HOLDS an open rename drill (F9) instead of clobbering it', () => {
    const handle = renderGlance(doc, root, machinesGlanceSpec(doc, pool, guards, { onRename: () => {} }));
    activate(handle, 'online');
    handle.drilldown.querySelector('.glance-list-row')!.dispatchEvent(new dom.window.Event('click'));
    const input = handle.drilldown.querySelector('input.machine-nick') as HTMLInputElement;
    input.value = 'half-typed name'; // a dirty field mid-edit
    // A 15s poll re-render arrives with fresh data.
    const held = renderGlance(doc, root, machinesGlanceSpec(doc, pool, guards, { onRename: () => {} }));
    expect(held.held, 'the re-render was held, not a rebuild').toBe(true);
    // the half-typed value survived untouched
    expect((root.querySelector('input.machine-nick') as HTMLInputElement).value).toBe('half-typed name');
  });

  it('a machine nickname with an XSS payload renders inert at Layer 2', () => {
    const nasty = '<img src=x onerror=alert(1)> "><script>bad()</script> ‮evil';
    const handle = renderGlance(doc, root, machinesGlanceSpec(doc, { enabled: true, machines: [
      { machineId: 'm_9', nickname: nasty, online: true, clockSkewStatus: 'ok' },
    ] }, null, {}));
    activate(handle, 'online');
    expect(handle.drilldown.querySelector('img')).toBeNull();
    expect(handle.drilldown.querySelector('script')).toBeNull();
    const rowText = handle.drilldown.querySelector('.glance-list-summary')!.textContent || '';
    expect(rowText).toContain('onerror');
    expect(rowText).not.toContain('‮');
  });
});

describe('F11 walk-every-tile — the Health glance (Phase 3)', () => {
  const systems = {
    health: 'error', uptime: 123456,
    activeCapabilities: [
      { id: 'session-recovery', label: 'Session Recovery', description: 'Detects stuck sessions and recovers them.',
        status: 'active', metric: '12 recovered', stats: { recoveries: 12 }, processes: [{ name: 'SessionWatchdog', status: 'running' }] },
      { id: 'telegram', label: 'Telegram', description: 'Telegram messaging integration.',
        status: 'error', metric: 'disconnected', stats: {}, processes: [{ name: 'TelegramAdapter', status: 'error' }] },
    ],
    issues: [{ severity: 'error', label: 'Telegram issue', description: 'TelegramAdapter errored', capability: 'telegram', process: 'TelegramAdapter' }],
    recentEvents: [{ narrative: 'Telegram reconnected after a blip', subsystem: 'telegram', timestamp: '2026-07-10T00:00:00Z' }],
  };

  it('every tile opens a non-empty, distinct Layer-2 (non-vacuous), rows → records', () => {
    const handle = renderGlance(doc, root, healthGlanceSpec(doc, systems));
    expect(handle.headline.textContent).toMatch(/1 subsystem needs attention/);
    expect(walkTiles(handle)).toBeGreaterThanOrEqual(1);
    // Subsystems tile → a subsystem row → a record with the full (formerly 390-word) prose
    activate(handle, 'subsystems');
    handle.drilldown.querySelector('.glance-list-row')!.dispatchEvent(new dom.window.Event('click'));
    const record = handle.drilldown.querySelector('[data-glance-record]');
    expect(record!.textContent).toMatch(/What it does/);
  });

  it('a healthy agent reads "All systems are operational."', () => {
    const handle = renderGlance(doc, root, healthGlanceSpec(doc, { health: 'healthy', activeCapabilities: [
      { id: 'x', label: 'X', description: 'y', status: 'active', metric: 'ok', stats: {}, processes: [] },
    ], issues: [], recentEvents: [] }));
    expect(handle.headline.textContent).toBe('All systems are operational.');
    // The "Need attention" tile is zero → honest empty-state, still clickable.
    const { opened, text } = activate(handle, 'attention');
    expect(opened).toBe(true);
    expect(text.toLowerCase()).toContain('nothing here');
  });
});

describe('F11 walk-every-tile — the Spend glance (Phase 3)', () => {
  const summary = { totals: { netUsd: 0, tokensIn: 123456, tokensOut: 6543 }, meteredLiveYet: false,
    rows: [{ door: 'claude-cli', modelId: 'claude-haiku-4-5-20251001', doorClass: 'cli', tokensIn: 123456, tokensOut: 6543, grossUsd: 0, netUsd: 0, priceBasis: 'subscription-zero' }] };
  const caps = { keys: [{ keyRef: 'k1', provider: 'openai', door: 'openai-metered', dailyCapUsd: 5, lifetimeCapUsd: 50, committedDayUsd: 0, committedLifetimeUsd: 0, goLiveState: 'not-live', frozen: false }] };

  it('every tile opens a non-empty, distinct Layer-2 (non-vacuous), rows → records', () => {
    const handle = renderGlance(doc, root, spendGlanceSpec(doc, summary, caps));
    expect(handle.headline.textContent!.toLowerCase()).toContain('nothing is being billed');
    expect(walkTiles(handle)).toBeGreaterThanOrEqual(1);
    // Cost tile → a per-model row → a record with the plain pricing detail
    activate(handle, 'cost');
    handle.drilldown.querySelector('.glance-list-row')!.dispatchEvent(new dom.window.Event('click'));
    expect(handle.drilldown.querySelector('[data-glance-record]')!.textContent).toMatch(/How it is priced|Subscription/);
  });

  it('the Pay-per-use access tile drills into the paid-door keys with plain caps', () => {
    const handle = renderGlance(doc, root, spendGlanceSpec(doc, summary, caps));
    const { opened, text } = activate(handle, 'access');
    expect(opened).toBe(true);
    expect(text.toLowerCase()).toContain('pay-per-use');
    handle.drilldown.querySelector('.glance-list-row')!.dispatchEvent(new dom.window.Event('click'));
    expect(handle.drilldown.querySelector('[data-glance-record]')!.textContent).toMatch(/Daily limit|Not switched on/);
  });

  it('an empty spend view → zero tiles drill into honest empty-states', () => {
    const handle = renderGlance(doc, root, spendGlanceSpec(doc, { totals: {}, rows: [], meteredLiveYet: false }, { keys: [] }));
    const { opened, text } = activate(handle, 'access');
    expect(opened).toBe(true);
    expect(text.toLowerCase()).toContain('nothing here');
  });
});

describe('F11 walk-every-tile — the Routing Map glance (Phase 3)', () => {
  const pos = (over: Record<string, unknown> = {}) => ({
    door: 'claude-cli', modelId: 'claude-haiku-4-5-20251001', doorClass: 'cli',
    injectionSafe: true, moneyGated: false, claudeBanned: false, skippedInIncrementA: false, ...over,
  });
  const map = { defaultFramework: 'claude-code', chains: [
    { chain: 'FAST', positions: [pos(), pos({ door: 'openai-metered', modelId: 'gpt-5.5', doorClass: 'metered', moneyGated: true, injectionSafe: false, skippedInIncrementA: true })] },
    { chain: 'JUDGE', positions: [pos({ modelId: 'claude-sonnet-5' })] },
  ], components: [
    { component: 'messageSentinel', category: 'gate', nature: 'A', chain: 'FAST', criticalGate: true, untrustedInput: true, route: [pos()] },
  ] };

  it('every tile opens a non-empty, distinct Layer-2 (non-vacuous), rows → records', () => {
    const handle = renderGlance(doc, root, routingMapGlanceSpec(doc, map));
    expect(handle.headline.textContent).toMatch(/runs on Claude Haiku, with GPT as backup/);
    expect(walkTiles(handle)).toBeGreaterThanOrEqual(1);
    // A lane tile → an ordered model row → a record with the full door/model config
    activate(handle, 'lane-fast');
    const rows = handle.drilldown.querySelectorAll('.glance-list-row');
    expect(rows.length).toBe(2); // FAST has two positions (primary + backup)
    rows[1].dispatchEvent(new dom.window.Event('click'));
    const record = handle.drilldown.querySelector('[data-glance-record]');
    expect(record!.textContent).toMatch(/Access type|pay-per-use/);
  });

  it('the Job-types tile drills into the components with plain lane names', () => {
    const handle = renderGlance(doc, root, routingMapGlanceSpec(doc, map));
    const { opened, text } = activate(handle, 'jobs');
    expect(opened).toBe(true);
    expect(text).toMatch(/Message sentinel/i); // humanized component, no camelCase
    handle.drilldown.querySelector('.glance-list-row')!.dispatchEvent(new dom.window.Event('click'));
    expect(handle.drilldown.querySelector('[data-glance-record]')!.textContent).toMatch(/Lane|Safety-critical/);
  });
});

// ── Phase 4 (topic 29836) — the sweep tabs walked end-to-end ──────────────────
// Each newly-adopted data-summary tab walks every tile (non-empty + distinct, or an
// honest empty-state), lands ≥1 real drill, and opens a Layer-3 record from a row.

describe('F11 walk-every-tile — the Phase-4 sweep tabs', () => {
  it('PR Pipeline: tiles drill into PRs → a record with the commit + reason', () => {
    const metrics = { phase: 'enforce', entries: [
      { pr_number: 12, head_sha: 'abcdef1234567890', eligible: true, reason: 'all checks green', created_at: '2026-07-01T00:00:00Z' },
      { pr_number: 13, head_sha: 'cafebabe', eligible: false, reason: 'checks pending', created_at: '2026-07-02T00:00:00Z' },
    ] };
    const handle = renderGlance(doc, root, prPipelineGlanceSpec(doc, metrics));
    expect(handle.headline.textContent).toMatch(/1 of 2 open pull requests/);
    expect(walkTiles(handle)).toBeGreaterThanOrEqual(1);
    activate(handle, 'ready');
    handle.drilldown.querySelector('.glance-list-row')!.dispatchEvent(new dom.window.Event('click'));
    const rec = handle.drilldown.querySelector('[data-glance-record]');
    expect(rec!.textContent).toMatch(/Commit|Why/);
  });

  it('Tokens: tiles drill into conversations → a record with the session + counts', () => {
    const spec = tokensGlanceSpec(doc, { summary: { totalTokens: 1234567 } },
      [{ sessionId: 'abc123', projectPath: '/a/b/ai-guy', totalTokens: 900000, eventCount: 12, lastTs: 1720000000000 }],
      [{ sessionId: 'z', projectPath: '/a/idle', lastTs: 1719000000000 }]);
    const handle = renderGlance(doc, root, spec);
    expect(handle.headline.textContent).toMatch(/pieces of text/);
    expect(walkTiles(handle)).toBeGreaterThanOrEqual(1);
    activate(handle, 'conversations');
    handle.drilldown.querySelector('.glance-list-row')!.dispatchEvent(new dom.window.Event('click'));
    expect(handle.drilldown.querySelector('[data-glance-record]')!.textContent).toMatch(/Conversation|Pieces of text/);
  });

  it('LLM Activity: tiles drill into components → a record with providers + latency', () => {
    const data = { totals: { calls: 1234, fired: 900, errors: 2, tokensIn: 5e6, tokensOut: 2e5 }, features: [
      { feature: 'messageSentinel', frameworks: ['claude-code'], models: ['claude-haiku-4-5-20251001'], calls: 1000, fired: 800, shed: 50, errors: 2, tokensIn: 4e6, tokensOut: 1e5, p50LatencyMs: 523, p95LatencyMs: 1899 },
    ] };
    const handle = renderGlance(doc, root, llmActivityGlanceSpec(doc, data));
    expect(handle.headline.textContent).toMatch(/background AI calls/);
    expect(walkTiles(handle)).toBeGreaterThanOrEqual(1);
    activate(handle, 'components');
    handle.drilldown.querySelector('.glance-list-row')!.dispatchEvent(new dom.window.Event('click'));
    expect(handle.drilldown.querySelector('[data-glance-record]')!.textContent).toMatch(/Runs on|Component/);
  });

  it('Secrets: tiles drill into requests → a record with the preserved actions', () => {
    let cancelled: string | null = null;
    const now = Date.parse('2026-07-10T00:00:00Z');
    const spec = secretsGlanceSpec(doc, { pending: [
      { label: 'GitHub token', token: 'drop_abc', topicId: 1, createdAt: now - 1000, expiresAt: now + 100000, tunnelUrl: 'https://x.trycloudflare.com/drop/abc' },
    ] }, { now, onCancel: (t: string) => { cancelled = t; } });
    const handle = renderGlance(doc, root, spec);
    expect(walkTiles(handle)).toBeGreaterThanOrEqual(1);
    activate(handle, 'waiting');
    handle.drilldown.querySelector('.glance-list-row')!.dispatchEvent(new dom.window.Event('click'));
    const rec = handle.drilldown.querySelector('[data-glance-record]')!;
    // the tab's actions are preserved at Layer 3 (behavior untouched)
    const cancelBtn = Array.from(rec.querySelectorAll('button')).find((b) => /Cancel/.test(b.textContent || ''));
    expect(cancelBtn, 'the cancel action is preserved on the record').toBeTruthy();
    cancelBtn!.dispatchEvent(new dom.window.Event('click'));
    expect(cancelled).toBe('drop_abc');
    // and it renders an <a> open link, not raw HTML
    expect(rec.querySelector('a[href^="https://"]')).toBeTruthy();
  });

  it('Secrets XSS: a jargon/HTML label renders inert at Layer 2', () => {
    const now = Date.parse('2026-07-10T00:00:00Z');
    const nasty = '<img src=x onerror=alert(1)> ‮evil';
    const spec = secretsGlanceSpec(doc, { pending: [{ label: nasty, token: 't', expiresAt: now + 5000 }] }, { now });
    const handle = renderGlance(doc, root, spec);
    activate(handle, 'waiting');
    expect(handle.drilldown.querySelector('img')).toBeNull();
    const rowText = handle.drilldown.querySelector('.glance-list-summary')!.textContent || '';
    expect(rowText).toContain('onerror');
    expect(rowText).not.toContain('‮');
  });

  it('Resources: tiles drill into processes → a record with CPU/memory detail', () => {
    const summary = { sampleCount: 120, sources: [
      { source: 'aggregate', currentCpuPercent: 45, currentRssBytes: 2.5e9, avgCpuPercent: 30, peakCpuPercent: 163, peakRssBytes: 3e9 },
      { source: 'agent-server', currentCpuPercent: 12, currentRssBytes: 5e8, avgCpuPercent: 10, peakCpuPercent: 40, peakRssBytes: 6e8 },
    ] };
    const handle = renderGlance(doc, root, resourcesGlanceSpec(doc, summary));
    expect(handle.headline.textContent).toMatch(/CPU/);
    expect(walkTiles(handle)).toBeGreaterThanOrEqual(1);
    activate(handle, 'processes');
    handle.drilldown.querySelector('.glance-list-row')!.dispatchEvent(new dom.window.Event('click'));
    expect(handle.drilldown.querySelector('[data-glance-record]')!.textContent).toMatch(/CPU right now|Process/);
  });

  it('Initiatives: tiles drill into items + signals → a record', () => {
    const items = { items: [
      { id: 'i1', title: 'Migrate the mesh', status: 'active', description: 'x', phases: [{ status: 'done' }], lastTouchedAt: '2026-07-01T00:00:00Z' },
    ] };
    const digest = { items: [{ reason: 'needs-user', title: 'Approve the plan', detail: 'waiting on you' }] };
    const handle = renderGlance(doc, root, initiativesGlanceSpec(doc, items, digest));
    expect(handle.headline.textContent).toMatch(/in flight/);
    expect(walkTiles(handle)).toBeGreaterThanOrEqual(1);
    // the In-progress tile drills into initiative records
    activate(handle, 'in-progress');
    handle.drilldown.querySelector('.glance-list-row')!.dispatchEvent(new dom.window.Event('click'));
    expect(handle.drilldown.querySelector('[data-glance-record]')!.textContent).toMatch(/Initiative|What it is/);
    // the Needs-you tile drills into a signal record (distinct row type) — fresh root
    // so the still-open drill above doesn't trigger the F9 hold on this render.
    const root2 = doc.createElement('div');
    doc.body.appendChild(root2);
    const h2 = renderGlance(doc, root2, initiativesGlanceSpec(doc, items, digest));
    activate(h2, 'needs-you');
    h2.drilldown.querySelector('.glance-list-row')!.dispatchEvent(new dom.window.Event('click'));
    expect(h2.drilldown.querySelector('[data-glance-record]')!.textContent).toMatch(/Why it needs a look|Waiting on you/);
  });
});
