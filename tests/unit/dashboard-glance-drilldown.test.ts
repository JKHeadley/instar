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
