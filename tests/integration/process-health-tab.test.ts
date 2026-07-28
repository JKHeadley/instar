/**
 * Integration tests for the Process Health tab POLLING CONTROLLER (jsdom).
 * Spec: docs/specs/PROCESS-HEALTH-DASHBOARD-TAB-SPEC.md (v4) §4.3 / §6.2.
 *
 * Drives the SHIPPED createController() against a real jsdom DOM with injected
 * fetch + manual timers + a controllable clock, so every §4.3 invariant is
 * exercised deterministically (no wall-clock, no real network):
 *   - all 3 fixtures render into the real tab DOM
 *   - XSS / layout-bomb safety holds through the full controller path
 *   - out-of-order conflicting fetches → one consistent paint, never a hybrid
 *   - visibility-gating: hidden clears timer + aborts in-flight; visible re-arms
 *   - staleness escalation: 5xx hard-fail AND the 304-pinned headline endpoint
 *   - 304 backoff (→300_000) then recovery (→60_000)
 *   - diff-aware: identical ticks produce 0 further DOM mutations
 *   - detail.full-class data never reaches the DOM
 *
 * Timing: createController()'s tick() is async (fetch → json → render → reschedule).
 * Manual ticks are `await c.tick()` (settles fully). The start()-initiated first
 * tick is drained with flush() (a real macrotask — the controller's own timers are
 * the injected fakes, so the real setTimeout is free to drain microtasks).
 */
// @ts-nocheck — exercises the browser-native ESM module.
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { createController } from '../../dashboard/process-health.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeEls(doc: Document) {
  const mk = () => doc.createElement('div');
  const els = { headline: mk(), patterns: mk(), captured: mk(), maturation: mk(), detail: mk(), stamp: mk() };
  const root = doc.createElement('div');
  for (const k of Object.keys(els)) root.appendChild(els[k]);
  doc.body.appendChild(root);
  return { els, root };
}

/** A controllable fetch: scripts a status/body/etag per endpoint URL, records signals. */
function makeFetch() {
  const script: Record<string, { status: number; body?: unknown; etag?: string }> = {
    analysis: { status: 200, body: { total: 0, attributed: 0, rollout: { stage: 'capture-only' } }, etag: 'a1' },
    insights: { status: 200, body: { insights: [] }, etag: 'i1' },
    failures: { status: 200, body: { failures: [] }, etag: 'f1' },
  };
  const signals: AbortSignal[] = [];
  const fetchImpl = async (url: string, opts: { headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
    if (opts.signal) signals.push(opts.signal);
    const key = url.includes('analysis') ? 'analysis' : url.includes('insights') ? 'insights' : 'failures';
    const d = script[key];
    return {
      status: d.status,
      ok: d.status >= 200 && d.status < 300,
      headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? d.etag ?? null : null) },
      json: async () => d.body,
    };
  };
  return { fetchImpl, script, signals };
}

/** Manual timer harness — captures (fn, ms); never auto-fires (we drive ticks). */
function makeTimers() {
  const calls: Array<{ fn: () => void; ms: number; id: number; cancelled: boolean }> = [];
  let seq = 0;
  const schedule = (fn: () => void, ms: number) => {
    const entry = { fn, ms, id: ++seq, cancelled: false };
    calls.push(entry);
    return entry.id;
  };
  const cancel = (id: number) => {
    const e = calls.find((c) => c.id === id);
    if (e) e.cancelled = true;
  };
  const lastDelay = () => (calls.length ? calls[calls.length - 1].ms : null);
  return { schedule, cancel, lastDelay, calls };
}

let doc: Document;
beforeEach(() => {
  doc = new JSDOM('<!doctype html><body></body>').window.document;
});

describe('Process Health controller (§4.3 — happy path + rendering)', () => {
  it('renders all three fixtures into the real tab DOM on the first tick', async () => {
    const { els } = makeEls(doc);
    const { fetchImpl, script } = makeFetch();
    script.analysis.body = { total: 2, attributed: 1, noFeatureLink: 1, byCategory: { concurrency: 2 }, rollout: { stage: 'capture-only' } };
    script.insights.body = { insights: [{ summary: 'repeated races', recommendation: 'add a lock', distinctSessions: 4 }] };
    script.failures.body = { failures: [{ category: 'concurrency', summary: 'a data race', initiativeId: 'failure-learning-loop', detectedAt: new Date().toISOString(), status: 'open' }] };
    const t = makeTimers();
    const c = createController({ doc, els, fetchImpl, now: () => 1_000_000, schedule: t.schedule, cancel: t.cancel });
    c.start();
    await flush();

    expect(els.headline.textContent).toContain('Keeping an eye out — 1 thing noticed');
    expect(els.patterns.textContent).toContain('repeated races');
    // v7: per-card framing line dropped (was the third echo of the section title +
    // subtitle saying the same thing). The pattern card now shows just its own
    // headline + the labeled rows in the expanded body.
    expect(els.patterns.textContent).not.toContain('Same kind of problem has come up more than once');
    expect(els.captured.textContent).toContain('A timing problem');
    expect(els.maturation.querySelector('.ph-stage-here')?.textContent).toContain('Quietly watching');
    expect(els.detail.textContent).toContain('Total noticed: 2');
    c.stop();
  });

  it('feature OFF (503) → pinned disabled copy, not the "connection paused" path', async () => {
    const { els } = makeEls(doc);
    const { fetchImpl, script } = makeFetch();
    script.analysis.status = 503; script.insights.status = 503; script.failures.status = 503;
    const t = makeTimers();
    const c = createController({ doc, els, fetchImpl, schedule: t.schedule, cancel: t.cancel });
    c.start();
    await flush();
    expect(els.headline.textContent).toContain('isn’t turned on');
    expect(els.headline.textContent).not.toContain('Connection paused');
    c.stop();
  });
});

describe('Process Health controller (§4.6 safety through the full path)', () => {
  it('XSS: malicious summary never becomes a live element', async () => {
    const { els, root } = makeEls(doc);
    const { fetchImpl, script } = makeFetch();
    (doc.defaultView as any).__xssCanary = undefined;
    script.insights.body = { insights: [{ summary: '<img src=x onerror="document.defaultView.__xssCanary=1">', recommendation: '<script>document.defaultView.__xssCanary=1</script>', distinctSessions: 2 }] };
    script.failures.body = { failures: [{ category: 'logic', summary: '<svg onload="document.defaultView.__xssCanary=1">', initiativeId: 'x', detectedAt: new Date().toISOString(), status: 'open' }] };
    const t = makeTimers();
    const c = createController({ doc, els, fetchImpl, schedule: t.schedule, cancel: t.cancel });
    c.start();
    await flush();
    expect(root.querySelectorAll('img,script,svg,math,iframe,object,embed').length).toBe(0);
    expect((doc.defaultView as any).__xssCanary).toBeUndefined();
    c.stop();
  });

  it('layout-bomb: a 100k-char summary stays bounded (serialized DOM < 8× empty baseline)', async () => {
    const { els, root } = makeEls(doc);
    const emptyBaseline = root.innerHTML.length;
    const { fetchImpl, script } = makeFetch();
    script.failures.body = { failures: [{ category: 'logic', summary: 'x'.repeat(100_000), initiativeId: 'x', detectedAt: new Date().toISOString(), status: 'open' }] };
    script.insights.body = { insights: [{ summary: 'y'.repeat(100_000), recommendation: 'z'.repeat(100_000), distinctSessions: 1 }] };
    const t = makeTimers();
    const c = createController({ doc, els, fetchImpl, schedule: t.schedule, cancel: t.cancel });
    c.start();
    await flush();
    expect(root.innerHTML.length).toBeLessThan(emptyBaseline + 8 * 1024);
    c.stop();
  });

  it('detail.full-class data never reaches the DOM', async () => {
    const { els, root } = makeEls(doc);
    const { fetchImpl, script } = makeFetch();
    // Even if a body erroneously carried a full path, the renderers never read it.
    script.failures.body = { failures: [{ category: 'logic', summary: 'boom', initiativeId: 'x', detectedAt: new Date().toISOString(), status: 'open', detail: { full: 'src/secret/Path.ts:42' } }] };
    const t = makeTimers();
    const c = createController({ doc, els, fetchImpl, schedule: t.schedule, cancel: t.cancel });
    c.start();
    await flush();
    expect(root.textContent).not.toContain('secret/Path');
    c.stop();
  });
});

describe('Process Health controller (§4.3 — race / visibility / staleness / backoff / diff)', () => {
  it('out-of-order conflicting fetches → one consistent paint, never a hybrid', async () => {
    const { els } = makeEls(doc);
    const queue: Array<{ key: string; signal: AbortSignal; resolve: (r: unknown) => void }> = [];
    const fetchImpl = (url: string, opts: any = {}) =>
      new Promise((resolve) => {
        const key = url.includes('analysis') ? 'analysis' : url.includes('insights') ? 'insights' : 'failures';
        queue.push({ key, signal: opts.signal, resolve });
      });
    const t = makeTimers();
    const c = createController({ doc, els, fetchImpl, schedule: t.schedule, cancel: t.cancel });
    c.start(); // tick1 → 3 pending
    await flush();
    const tick1 = queue.splice(0, 3);
    c.tick(); // tick2 → aborts tick1's controller, 3 new pending
    await flush();
    const tick2 = queue.splice(0, 3);
    const resp = (status: number, body: unknown, etag: string) => ({ status, ok: true, headers: { get: () => etag }, json: async () => body });
    // Resolve tick2 (the newer one) with "B" data.
    for (const q of tick2) {
      const body = q.key === 'failures' ? { failures: [{ category: 'logic', summary: 'B-data', initiativeId: 'x', detectedAt: new Date().toISOString(), status: 'open' }] } : q.key === 'insights' ? { insights: [] } : { total: 1, rollout: { stage: 'capture-only' } };
      q.resolve(resp(200, body, 'B'));
    }
    await flush();
    // Now resolve tick1 (the older, aborted one) with "A" data — must be ignored.
    for (const q of tick1) {
      const body = q.key === 'failures' ? { failures: [{ category: 'logic', summary: 'A-STALE', initiativeId: 'x', detectedAt: new Date().toISOString(), status: 'open' }] } : q.key === 'insights' ? { insights: [] } : { total: 99, rollout: { stage: 'dark' } };
      q.resolve(resp(200, body, 'A'));
    }
    await flush();
    expect(els.captured.textContent).toContain('B-data');
    expect(els.captured.textContent).not.toContain('A-STALE');
    c.stop();
  });

  it('visibility-gating: hidden clears the timer + aborts in-flight; visible re-arms with one fetch', async () => {
    const { els } = makeEls(doc);
    const { fetchImpl } = makeFetch();
    const t = makeTimers();
    const c = createController({ doc, els, fetchImpl, schedule: t.schedule, cancel: t.cancel });
    c.start();
    await flush();
    expect(c._state.active).toBe(true);
    const timersBefore = t.calls.length;
    c.onHidden();
    expect(c._state.active).toBe(false);
    expect(c._state.inFlight).toBeNull();
    expect(t.calls[t.calls.length - 1].cancelled).toBe(true);
    c.onVisible();
    expect(c._state.active).toBe(true);
    await flush();
    expect(t.calls.length).toBeGreaterThan(timersBefore); // re-armed
    c.stop();
  });

  it('staleness — hard-fail: 3 consecutive 5xx → headline "Connection paused", not a stale count', async () => {
    const { els } = makeEls(doc);
    const { fetchImpl, script } = makeFetch();
    script.failures.body = { failures: [{ category: 'logic', summary: 'x', initiativeId: 'x', detectedAt: new Date().toISOString(), status: 'open' }] };
    const t = makeTimers();
    const c = createController({ doc, els, fetchImpl, now: () => 1000, schedule: t.schedule, cancel: t.cancel });
    c.start();
    await flush();
    expect(els.headline.textContent).toContain('Keeping an eye out');
    script.analysis.status = 500; script.insights.status = 500; script.failures.status = 500;
    for (let i = 0; i < 3; i++) { await c.tick(); }
    expect(els.headline.textContent).toContain("Can't refresh right now");
    expect(els.headline.textContent).not.toContain('Keeping an eye out — 1 thing');
    c.stop();
  });

  it('staleness — 304-pinned headline endpoint (NEW-3): /failures 304 while siblings 200 still escalates', async () => {
    const { els } = makeEls(doc);
    const { fetchImpl, script } = makeFetch();
    let clock = 1_000_000; // realistic non-zero epoch (0 is the "never loaded" sentinel)
    script.failures.body = { failures: [{ category: 'logic', summary: 'x', initiativeId: 'x', detectedAt: new Date().toISOString(), status: 'open' }] };
    const t = makeTimers();
    const c = createController({ doc, els, fetchImpl, now: () => clock, cadenceMs: 60_000, staleMs: 180_000, schedule: t.schedule, cancel: t.cancel });
    c.start();
    await flush();
    expect(els.headline.textContent).toContain('Keeping an eye out');
    // /failures now pins to 304 forever; siblings keep returning fresh 200s.
    script.failures.status = 304;
    script.analysis.body = { total: 1, rollout: { stage: 'capture-only' } };
    clock = 1_200_000; // +200s elapsed, past the 180s (3× cadence) staleness ceiling
    await c.tick();
    expect(els.headline.textContent).toContain("Can't refresh right now");
    // The corner stamp reflects /failures' own last-200 age, not the freshest sibling.
    expect(els.stamp.textContent).toMatch(/updated \d+m ago/);
    c.stop();
  });

  it('304 backoff: 5 all-304 ticks → next delay 300_000; then a 200 → 60_000', async () => {
    const { els } = makeEls(doc);
    const { fetchImpl, script } = makeFetch();
    script.analysis.status = 304; script.insights.status = 304; script.failures.status = 304;
    const t = makeTimers();
    const c = createController({ doc, els, fetchImpl, cadenceMs: 60_000, schedule: t.schedule, cancel: t.cancel });
    c.start();
    await flush(); // tick #1 (all-304)
    for (let i = 0; i < 4; i++) { await c.tick(); } // ticks #2–5
    expect(c._state.consecutive304Ticks).toBeGreaterThanOrEqual(5);
    expect(t.lastDelay()).toBe(300_000);
    // A fresh 200 resets the backoff.
    script.failures.status = 200;
    await c.tick();
    expect(c._state.consecutive304Ticks).toBe(0);
    expect(t.lastDelay()).toBe(60_000);
    c.stop();
  });

  // §6.4 glance test — deterministic half: the VISIBLE text of every fixture must
  // read like plain English, never a debug log. (The soft LLM smoke is gated by
  // INSTAR_RUN_LLM_SMOKE and lives outside CI.)
  const DEBUG_WORDS = ['log', 'json', 'table', 'raw', 'stack', 'console', 'endpoint', 'api'];
  const hasDebugWord = (text: string) => {
    const lc = text.toLowerCase();
    return DEBUG_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(lc));
  };

  it('glance test: populated / empty / disabled fixtures carry no debug-log vocabulary', async () => {
    const fixtures: Array<{ name: string; setup: (s: any) => void; expectState: RegExp }> = [
      {
        name: 'populated',
        setup: (s) => {
          s.analysis.body = { total: 1, attributed: 1, rollout: { stage: 'capture-only' } };
          s.insights.body = { insights: [{ summary: 'repeated races', recommendation: 'add a lock', distinctSessions: 4 }] };
          s.failures.body = { failures: [{ category: 'concurrency', summary: 'a data race', initiativeId: 'failure-learning-loop', detectedAt: new Date().toISOString(), status: 'open' }] };
        },
        expectState: /keeping an eye out/i,
      },
      { name: 'empty', setup: () => {}, expectState: /nothing has come up yet/i },
      { name: 'disabled', setup: (s) => { s.analysis.status = 503; s.insights.status = 503; s.failures.status = 503; }, expectState: /isn’t turned on/i },
    ];
    for (const fx of fixtures) {
      const localDoc = new JSDOM('<!doctype html><body></body>').window.document;
      const { els, root } = makeEls(localDoc);
      const { fetchImpl, script } = makeFetch();
      fx.setup(script);
      const t = makeTimers();
      const c = createController({ doc: localDoc, els, fetchImpl, now: () => 1_000_000, schedule: t.schedule, cancel: t.cancel });
      c.start();
      await flush();
      const visible = root.textContent || '';
      const offenders = hasDebugWord(visible);
      expect(offenders, `fixture "${fx.name}" leaked debug vocabulary: ${offenders.join(', ')}`).toEqual([]);
      expect(visible, `fixture "${fx.name}" must state a plain state`).toMatch(fx.expectState);
      c.stop();
    }
  });

  it('diff-aware: identical ticks produce 0 further DOM mutations after the first paint', async () => {
    const { els } = makeEls(doc);
    const { fetchImpl, script } = makeFetch();
    script.failures.body = { failures: [{ category: 'logic', summary: 'steady', initiativeId: 'x', detectedAt: '2026-05-27T00:00:00.000Z', status: 'open' }] };
    const t = makeTimers();
    const c = createController({ doc, els, fetchImpl, now: () => 0, schedule: t.schedule, cancel: t.cancel });
    c.start();
    await flush();
    const firstCapturedChild = els.captured.firstChild;
    const firstHeadlineChild = els.headline.firstChild;
    // Two more identical ticks (same etags/snapshot → diff-aware skip).
    await c.tick();
    await c.tick();
    // replaceChildren was NOT called → same node objects persist.
    expect(els.captured.firstChild).toBe(firstCapturedChild);
    expect(els.headline.firstChild).toBe(firstHeadlineChild);
    c.stop();
  });
});
