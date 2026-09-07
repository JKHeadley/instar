// @ts-nocheck — shipped browser ESM exercised against an actual DOM.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { mountOriginPanel, originGlanceSpec } from '../../dashboard/origin.js';
import { validateGlanceSpec, GLANCE_ADOPTED_TABS } from '../../dashboard/glance.js';
const open = (h, key) => { const tile = h.root.querySelector(`[data-glance-tile="${key}"]`); if (tile.getAttribute('aria-expanded') !== 'true') tile.click(); };
const controllers = [];
afterEach(() => { controllers.splice(0).forEach(item => item.stop()); });
const preferences = () => ({ defaults: { enabled: true, machine: true, harness: true, model: true }, revision: 'agent-revision',
  topics: [{ id: '42', name: 'Project discussion', display: null, revision: 'topic-revision', editable: true }] });
function harness(overrides = {}) {
  const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector('main'), calls = [];
  const request = vi.fn(async (url, options) => {
    calls.push({ url, options });
    if (overrides.request) return overrides.request(url, options);
    const body = url === '/telegram/origin-display' ? options?.method === 'POST' ? { message: 'Saved. Recording continues.' } : preferences()
      : url.includes('/status') ? { activation: { complete: false }, metrics: { stale: true, sampledAt: 1000, counts: null }, notices: [] }
      : { coverage: 'incomplete', records: [{ record: { envelopeJson: JSON.stringify({ originMachineName: '<img src=x onerror=alert(1)>', harnessName: 'Codex',
        model: { value: 'model', status: 'configured' }, createdAt: 1000, operationKind: 'sendMessage', display: { enabled: false } }) }, operation: { state: 'outcome-unknown' } }], cursor: null };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const unlock = vi.fn(), controller = mountOriginPanel(root, { request, unlock }); controllers.push(controller);
  return { dom, root, request, calls, controller, unlock };
}
describe('phone origin panel', () => {
  it('conforms under adversarial, unavailable, stale and large-count inputs without leaking values', () => {
    expect(GLANCE_ADOPTED_TABS).toContain('origins');
    for (const status of [undefined, null, {}, { metrics: { counts: null } },
      { metrics: { stale: true, coverage: 'complete', counts: { 'operation:held': 99999999 } } },
      { metrics: { stale: false, coverage: 'incomplete', counts: {} } },
      { metrics: { stale: false, coverage: 'complete', counts: {} }, notices: [{ notificationOutcome: 'CMT-953 atRisk TTL 1800s' }] }]) {
      const spec = originGlanceSpec({ status, auditAvailable: true });
      expect(validateGlanceSpec(spec).ok).toBe(true);
      expect(JSON.stringify(spec)).not.toMatch(/CMT|TTL|99999999/);
      expect(spec.tiles.find(x => x.key === 'recording').value).toBe(status?.metrics?.stale === false && status?.metrics?.coverage === 'complete' ? 'Current' : 'Unknown');
    }
    expect(originGlanceSpec().tiles.find(x => x.key === 'messages').value).toBe('Unknown');
  });
  it('walks every actual tile into distinct detail and opens a real message record', async () => {
    const h = harness(); await h.controller.refresh();
    expect(h.root.querySelectorAll('[data-glance-tile]')).toHaveLength(3);
    expect(h.root.querySelector('input')).toBeNull();
    expect(h.root.querySelector('[aria-label="Message audit"]')).toBeNull();
    const headline = h.root.querySelector('[data-glance-headline]').textContent;
    for (const key of ['display', 'recording', 'messages']) {
      open(h, key); const body = h.root.querySelector('[data-glance-drill-body]');
      expect(body.textContent.length).toBeGreaterThan(30); expect(body.textContent).not.toBe(headline);
      expect(h.root.querySelector('[data-glance-drilldown]').hidden).toBe(false);
    }
    const record = h.root.querySelector('[aria-label="Message audit"] details');
    expect(record.open).toBe(false); record.querySelector('summary').click(); expect(record.open).toBe(true);
    expect(record.textContent).toContain('Origin details at preparation: hidden');
    expect(record.textContent).toContain('Origin attestation verification: unknown');
  });
  it('preserves an unsaved settings interaction across a background status refresh', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(); h.controller.start(); await vi.advanceTimersByTimeAsync(1); open(h, 'display');
      const field = h.root.querySelector('[aria-label="Show origin details"]'); field.checked = false;
      await vi.advanceTimersByTimeAsync(30000);
      expect(h.root.querySelector('[aria-label="Show origin details"]')).toBe(field); expect(field.checked).toBe(false);
      expect(h.calls.filter(call => call.url.includes('/status'))).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
  it('clears prior healthy status after a failed refresh without inferring audit absence', async () => {
    let fail = false;
    const h = harness({ request: async url => new Response(JSON.stringify(url === '/telegram/origin-display' ? preferences() :
      url.includes('/status') ? { metrics: { counts: {}, stale: false, coverage: 'complete' } } : { coverage: 'incomplete', records: [] }), { status: fail && url.includes('/status') ? 503 : 200 }) });
    await h.controller.refresh(); expect(h.root.querySelector('[data-glance-tile="recording"] [data-glance-count]').textContent).toBe('Current');
    fail = true; await h.controller.refresh();
    expect(h.root.querySelector('[data-glance-tile="recording"] [data-glance-count]').textContent).toBe('Unknown');
    open(h, 'messages'); expect(h.root.textContent).toContain('No records returned'); expect(h.root.textContent).toContain('Coverage incomplete');
  });

  it('renders incomplete coverage, unknown held/notice state and inert untrusted labels', async () => {
    const h = harness(); await h.controller.refresh();
    open(h, 'messages'); expect(h.root.textContent).toContain('Coverage incomplete');
    expect(h.root.querySelector('[aria-label="Message audit"] details summary').textContent).toContain('<img');
    open(h, 'recording'); expect(h.root.textContent).toContain('held work is unknown');
    expect(h.root.textContent).toContain('Outage notification unavailable'); expect(h.root.querySelector('img')).toBeNull();
    open(h, 'display');
    expect(h.root.querySelectorAll('input[type=checkbox]')).toHaveLength(5);
  });
  it('saves four typed checkbox values without credentials or raw JSON entry', async () => {
    const h = harness(); await h.controller.refresh();
    open(h, 'display'); h.root.querySelector('[aria-label="Show origin details"]').checked = false;
    await [...h.root.querySelectorAll('button')].find(x => x.textContent === 'Save display settings').onclick();
    const body = JSON.parse(h.calls.find(call => call.options?.method === 'POST').options.body);
    expect(body).toEqual({ revision: 'agent-revision', display: { enabled: false, machine: true, harness: true, model: true } });
    expect(h.root.querySelector('textarea')).toBeNull();
  });
  it('clears conversation overrides through the inheritance checkbox and scoped revision', async () => {
    const h = harness(); await h.controller.refresh(); open(h, 'display'); const select = h.root.querySelector('select'); select.value = '42'; select.onchange();
    await [...h.root.querySelectorAll('button')].find(x => x.textContent === 'Save display settings').onclick();
    expect(JSON.parse(h.calls.find(call => call.options?.method === 'POST').options.body)).toEqual({ topicId: '42', display: null, revision: 'topic-revision' });
  });
  it('offers PIN unlock when the operator proof is absent or expired', async () => {
    const h = harness({ request: async () => new Response('{}', { status: 403 }) }); await h.controller.refresh();
    expect(h.root.textContent).toContain('Unlock with your PIN'); h.root.querySelector('button').click(); expect(h.unlock).toHaveBeenCalledOnce();
    for (const key of ['display', 'recording', 'messages']) {
      open(h, key); expect(h.root.querySelector('[data-glance-drill-body]').textContent.length).toBeGreaterThan(30);
    }
    expect(h.root.textContent).toContain('Records are unavailable until access is verified');
    open(h, 'display'); expect([...h.root.querySelectorAll('button')].find(x => x.textContent === 'Save display settings').disabled).toBe(true);
  });
  it('ignores a delayed audit response after the conversation changes', async () => {
    let releaseOld; const old = new Promise(resolve => { releaseOld = resolve; });
    const row = name => ({ record: { envelopeJson: JSON.stringify({ originMachineName: name, createdAt: 1000 }) } });
    const h = harness({ request: async url => {
      if (url === '/telegram/origin-display') return new Response(JSON.stringify(preferences()));
      if (url.includes('/status')) return new Response('{}');
      if (!url.includes('topicId=')) return old;
      return new Response(JSON.stringify({ coverage: 'complete', records: [row('Current conversation')], cursor: null }));
    } });
    const initial = h.controller.refresh();
    await vi.waitFor(() => expect(h.calls.some(call => call.url.includes('scope=pool'))).toBe(true));
    open(h, 'display'); const select = h.root.querySelector('select'); select.value = '42'; select.onchange(); open(h, 'messages');
    await vi.waitFor(() => expect(h.root.textContent).toContain('Current conversation'));
    releaseOld(new Response(JSON.stringify({ coverage: 'complete', records: [row('Stale conversation')], cursor: null })));
    await initial; expect(h.root.textContent).not.toContain('Stale conversation'); expect(h.root.textContent).toContain('Current conversation');
  });
  it('keeps local fallback pagination local and never labels it complete pool coverage', async () => {
    const h = harness({ request: async url => new Response(JSON.stringify(url === '/telegram/origin-display' ? preferences() :
      url.includes('/status') ? {} : { coverage: 'complete', records: [], cursor: url.includes('cursor=') ? null : 'page-two' }), { status: url.includes('scope=pool') ? 503 : 200 }) });
    await h.controller.refresh(); open(h, 'messages'); await [...h.root.querySelectorAll('button')].find(x => x.textContent === 'Load more messages').onclick();
    expect(h.calls.at(-1).url).toContain('scope=local'); expect(h.calls.at(-1).url).toContain('cursor=page-two');
    expect(h.root.textContent).toContain('Coverage incomplete');
  });
});
