// @ts-nocheck — shipped browser modules exercised against a real DOM.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { displayModel } from '../../dashboard/console/messages-model.js';

const ok = (data: unknown) => ({ ok: true, data });

describe('message settings model', () => {
  it('requires a complete settings response and preserves the unlock state', () => {
    expect(displayModel({ ok: false, reason: 'needs your PIN', needsUnlock: true })).toMatchObject({ ok: false, needsUnlock: true });
    expect(displayModel(ok({ defaults: { enabled: true } })).ok).toBe(false);
    expect(displayModel(ok({ defaults: { enabled: true }, revision: 'r1', topics: [{ id: '1', name: 'Project' }] })).ok).toBe(true);
  });
});

describe('message settings page', () => {
  let dom: JSDOM;
  afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });

  async function setup(reply: (url: string, opts?: Record<string, unknown>) => Promise<unknown>) {
    dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'http://localhost:4040/dashboard/console/#/people/messages' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('localStorage', dom.window.localStorage);
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
    vi.stubGlobal('fetch', reply);
    dom.window.localStorage.setItem('instar_token', 't');
    vi.resetModules();
    const { renderMessages } = await import('../../dashboard/console/messages.js');
    const main = dom.window.document.querySelector('main');
    const render = () => renderMessages(main, {});
    await render();
    return { main, render };
  }

  const response = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

  it('shows no held-reply status or editable control when settings fail', async () => {
    const calls: string[] = [];
    const { main } = await setup(async (url) => { calls.push(url); return response(500, { error: 'internal-held-queue-failed' }); });
    expect(calls).toEqual(['/telegram/origin-display']);
    expect(main.textContent).toContain('Settings are unavailable right now.');
    expect(main.textContent).not.toMatch(/held|expired|internal-held-queue-failed/i);
    expect(main.querySelector('.acct-row, input, select')).toBeNull();
    expect(main.querySelector('button').textContent).toBe('Retry');
  });

  it('unlocks once, then shows and saves only the message footer setting', async () => {
    let session = '';
    const posts: Array<{ body: string; headers: Record<string, string> }> = [];
    const { main } = await setup(async (url, opts = {}) => {
      if (url === '/dashboard/unlock') { session = 'S1'; return response(200, { operatorSessionToken: session, operatorSessionExpiresAt: new Date(Date.now() + 600_000).toISOString() }); }
      if (url === '/telegram/origin-display' && opts.method === 'POST') { posts.push({ body: opts.body, headers: opts.headers }); return response(200, { ok: true }); }
      if (url === '/telegram/origin-display') return opts.headers?.['X-Instar-Operator-Session'] === session && session
        ? response(200, { defaults: { enabled: true, machine: true, harness: true, model: true }, revision: 'r1', topics: [] })
        : response(403, { error: 'operator session required' });
      throw new Error(`Unexpected request: ${url}`);
    });
    expect(main.textContent).toContain('Unlock message settings');
    expect(main.querySelector('.acct-row')).toBeNull();
    main.querySelector('.need-card button').click();
    const pin = dom.window.document.querySelector('.pin-input');
    expect(dom.window.document.querySelector('.unlock-error').textContent).toBe('');
    pin.value = '123456';
    dom.window.document.querySelector('.pin-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(main.querySelector('.acct-row')).not.toBeNull());
    expect(main.textContent).not.toMatch(/held|expired/i);
    main.querySelector('.acct-row').click();
    dom.window.document.querySelector('#od-model').checked = false;
    [...dom.window.document.querySelectorAll('.sheet button')].find((b) => b.textContent === 'Save').click();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(posts[0].body)).toEqual({ display: { enabled: true, machine: true, harness: true, model: false }, revision: 'r1' });
    expect(posts[0].headers['X-Instar-Operator-Session']).toBe('S1');
  });
});
