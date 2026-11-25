/**
 * SEC-135, the page side (docs/specs/sec135-approval-link-guess-bound.md §2-3): service-yes.js sends
 * X-Instar-Request on its page open, shows the server's paused wording, retries a refused open with
 * brakes (three tries, then a message; one tab at a time via a shared lock), shows the all-protected
 * message, and says when a page timed out while the owner was away. Loads the real script into jsdom.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../dashboard-pair/service-yes.js'), 'utf-8');
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const PAGE = { service: 'jev', name: 'Jev', benefit: 'b', dataLeaves: 'd', cost: 'c', account: 'a', canSetUp: true, token: 'tok-1', expiresAt: Date.now() + 30 * 60_000 };

function boot(gets: Array<ReturnType<typeof json>>, post?: ReturnType<typeof json>, page: Record<string, unknown> = PAGE) {
  const dom = new JSDOM('<!doctype html><body><div id="pair-root"></div></body>', { url: 'https://echo.example.dev/dashboard/service-yes?service=jev', runScripts: 'outside-only' });
  const getHeaders: Array<Record<string, string>> = [];
  (dom.window as unknown as { fetch: unknown }).fetch = async (_url: string, o: { method?: string; headers?: Record<string, string> } = {}) => {
    if ((o.method ?? 'GET') === 'GET') { getHeaders.push(o.headers ?? {}); return gets.shift() ?? json(200, page); }
    return post ?? json(200, {});
  };
  (dom.window as unknown as { Math: Math }).Math.random = () => 0;
  dom.window.eval(SCRIPT);
  return { doc: dom.window.document, win: dom.window, getHeaders };
}
const text = (doc: Document) => doc.body.textContent ?? '';
const yesButton = (doc: Document) => [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Yes, set up Jev') as HTMLButtonElement;

describe('SEC-135 confirm page', () => {
  it('sends X-Instar-Request on the page open', async () => {
    const { doc, getHeaders } = boot([]);
    await flush();
    expect(getHeaders[0]).toEqual({ 'X-Instar-Request': '1' });
    expect(text(doc)).toContain('Set up Jev?');
  });

  it('shows the server\'s own paused wording on pin-paused', async () => {
    const message = 'Too many wrong PINs have been tried, so this page is paused for a few minutes.';
    const { doc } = boot([], json(429, { error: 'pin-paused', message, retryAfterSeconds: 120 }));
    await flush();
    yesButton(doc).click();
    await flush();
    expect(doc.querySelector('.pair-error')?.textContent).toBe(message);
  });

  it('retries a refused open with brakes and opens when the allowance has room', async () => {
    const { doc, getHeaders } = boot([json(429, { error: 'too-many-pages', retryAfterSeconds: 0 }), json(429, { error: 'too-many-pages', retryAfterSeconds: 0 })]);
    await flush(200);
    expect(getHeaders).toHaveLength(3);
    expect(text(doc)).toContain('Set up Jev?');
  });

  it('gives up after three tries with a message, and releases the shared lock', async () => {
    const refused = () => json(429, { error: 'too-many-pages', retryAfterSeconds: 0 });
    const { doc, getHeaders, win } = boot([refused(), refused(), refused(), refused(), refused()]);
    await flush(300);
    expect(getHeaders).toHaveLength(4); // the first open plus three tries
    expect(text(doc)).toContain('Too many of these pages opened at once. Reload this one when you need it.');
    expect(win.localStorage.getItem('instar-confirm-open-retry')).toBeNull();
  });

  it('shows the all-protected message without retrying', async () => {
    const { doc, getHeaders } = boot([json(429, { error: 'too-many-pages', allProtected: true })]);
    await flush();
    expect(getHeaders).toHaveLength(1);
    expect(text(doc)).toContain('Too many approval pages for this service are still active');
  });

  it('with the switch off (no retry time in the refusal) shows today\'s message', async () => {
    const { doc, getHeaders } = boot([json(429, { error: 'too-many-pages' })]);
    await flush();
    expect(getHeaders).toHaveLength(1);
    expect(text(doc)).toContain('This page has been opened too many times in a short while.');
  });

  it('a page whose token expired while the owner was away says so', async () => {
    const { doc } = boot([], json(409, { error: 'token-refused' }), { ...PAGE, expiresAt: Date.now() - 1 });
    await flush();
    yesButton(doc).click();
    await flush();
    expect(text(doc)).toContain('This page timed out while you were away. Reload to continue.');
  });
});
