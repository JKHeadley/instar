import { describe, expect, it } from 'vitest';
import { buildQuotaForecast } from '../../dashboard/console/quota-forecast-model.js';
const NOW = Date.parse('2026-11-23T06:00:00Z');
const response = (account = {}) => ({ ok: true, data: { schema: 'quota-pacing/1', generatedAt: new Date(NOW).toISOString(), providers: [{ label: 'Codex', plain: 'Room remains at the current pace.', accounts: [{ accountId: 'a', fresh: true, weekly: { used: 20, central: 60, low: 50, high: 75, resetsAt: new Date(NOW + 86400000).toISOString(), verdict: 'will-leave-unused' }, ...account }] }], calibration: { scored: 2, censored: 1, inside: 1, meanAbsError: 2.4, outcomes: [{ status: 'scored' }, { status: 'scored' }, { status: 'censored' }, { status: 'no-forecast' }] }, sources: [{ status: 'ok' }] } });
describe('quota forecast presentation', () => {
  it('shows a weekly estimate and measured calibration without claiming reliability', () => {
    const page = buildQuotaForecast(response(), [{ id: 'a', name: 'Justin Gmail' }], NOW);
    expect(page.providers[0].accounts[0].name).toBe('Justin Gmail');
    expect(page.providers[0].accounts[0].lines.join(' ')).toContain('60%');
    expect(page.providers[0].accounts[0].lines.join(' ')).toContain('50% to 75%');
    expect(page.calibration).toContain('2 forecasts');
    expect(page.calibration).toContain('2.4 percentage points');
    expect(page.calibration).toContain('1 reset lacked a recent final reading');
    expect(page.calibration).toContain('1 reset had no usable forecast');
    expect(page.calibration).not.toContain('reliable');
  });
  it.each([{ fresh: false }, { disagree: true }, { identityUnknown: true }])('does not present an uncertain account as forecast capacity: %j', (uncertain) => {
    const lines = buildQuotaForecast(response(uncertain), [], NOW).providers[0].accounts[0].lines.join(' ');
    expect(lines).toContain('Cannot estimate');
    expect(lines).not.toContain('60%');
  });
  it('keeps missing projections unknown rather than converting null to zero', () => {
    const page = buildQuotaForecast(response({ weekly: { used: 20, central: null, low: null, high: null } }), [], NOW);
    expect(page.providers[0].accounts[0].lines.join(' ')).toContain('Not enough history');
    expect(page.providers[0].accounts[0].lines.join(' ')).not.toContain('0%');
  });
  it('names missing calibration and partial machine coverage', () => {
    const r = response(); r.data.calibration = { scored: 0, outcomes: [] } as never; r.data.sources.push({ status: 'failed' });
    const page = buildQuotaForecast(r, [], NOW);
    expect(page.calibration).toContain('No forecasts have been checked');
    expect(page.coverage).toContain('1 machine');
  });
  it('rejects old or malformed responses and distinguishes switched off from failure', () => {
    expect(buildQuotaForecast({ ok: false, status: 503, data: { error: 'quota-pacing-off' } }, [], NOW).state).toBe('off');
    expect(buildQuotaForecast({ ok: false, reason: 'switched off on this agent' }, [], NOW).state).toBe('off');
    expect(buildQuotaForecast({ ok: false }, [], NOW).state).toBe('unavailable');
    expect(buildQuotaForecast({ ok: true, data: {} }, [], NOW).state).toBe('unavailable');
    expect(buildQuotaForecast(response(), [], NOW + 3600000).state).toBe('stale');
  });
});

describe('quota forecast card DOM', () => {
  it('renders untrusted account names as text and stays independent of a slow request', async () => {
    const { JSDOM } = await import('jsdom');
    const { quotaForecastCard } = await import('../../dashboard/console/quota-forecast.js');
    const dom = new JSDOM('<!doctype html><body></body>');
    const previous = globalThis.document;
    Object.assign(globalThis, { document: dom.window.document });
    try {
      let resolve!: (value: unknown) => void;
      const pending = new Promise((done) => { resolve = done; });
      const card = quotaForecastCard(() => pending, [{ id: 'a', name: '<img src=x onerror=alert(1)>' }]);
      dom.window.document.body.append(card);
      expect(card.dataset.state).toBe('loading');
      const r = response(); r.data.generatedAt = new Date().toISOString();
      r.data.providers[0].accounts[0].weekly.resetsAt = new Date(Date.now() + 86400000).toISOString();
      resolve(r);
      await new Promise((done) => setTimeout(done, 0));
      expect(card.dataset.state).toBe('ready');
      expect(card.textContent).toContain('<img src=x onerror=alert(1)>');
      expect(card.querySelector('img')).toBeNull();
      expect(card.querySelector('details summary')).not.toBeNull();
    } finally { Object.assign(globalThis, { document: previous }); dom.window.close(); }
  });
  it('turns a rejected read into a visible explanation without hiding account controls', async () => {
    const { JSDOM } = await import('jsdom');
    const { quotaForecastCard } = await import('../../dashboard/console/quota-forecast.js');
    const dom = new JSDOM('<!doctype html><body><button>Sign in</button></body>');
    const previous = globalThis.document;
    Object.assign(globalThis, { document: dom.window.document });
    try {
      const card = quotaForecastCard(() => Promise.reject(new Error('offline')));
      dom.window.document.body.append(card);
      await new Promise((done) => setTimeout(done, 0));
      expect(card.dataset.state).toBe('unavailable');
      expect(card.textContent).toContain('could not be read');
      expect(dom.window.document.querySelector('button')?.textContent).toBe('Sign in');
    } finally { Object.assign(globalThis, { document: previous }); dom.window.close(); }
  });
});

describe('Accounts page forecast wiring', () => {
  it('mounts the card through the actual page renderer and honors its request-wrapper off shape', async () => {
    const { JSDOM } = await import('jsdom');
    const { renderAccounts } = await import('../../dashboard/console/accounts.js');
    const dom = new JSDOM('<!doctype html><main></main>', { url: 'http://localhost/dashboard/console/#/capacity/accounts' });
    const keys = ['window', 'document', 'location', 'history', 'localStorage', 'requestAnimationFrame'];
    const saved = Object.fromEntries(keys.map((key) => [key, (globalThis as any)[key]]));
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    const calls: string[] = [];
    const table: Record<string, unknown> = {
      '/subscription-pool?scope=pool': { enabled: true, accounts: [], pool: { failed: [] } },
      '/subscription-relogin?scope=pool': { enabled: true, episodes: [] },
      '/subscription-pool/in-use': { enabled: true }, '/pool': { machines: [] },
    };
    try {
      await renderAccounts(dom.window.document.querySelector('main'), { get: async (url: string) => {
        calls.push(url);
        return url === '/quota-pacing' ? { ok: false, reason: 'switched off on this agent' } : { ok: true, data: table[url] };
      } });
      await new Promise((done) => setTimeout(done, 0));
      expect(calls).toContain('/quota-pacing');
      const card = dom.window.document.querySelector('#sec-quota-forecast') as HTMLElement;
      expect(card).not.toBeNull();
      expect(card.dataset.state).toBe('off');
      expect(card.hidden).toBe(true);
      expect(dom.window.document.querySelector('h1')?.textContent).toBeTruthy();
    } finally { Object.assign(globalThis, saved); dom.window.close(); }
  });
});
