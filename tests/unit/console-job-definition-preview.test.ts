// @ts-nocheck: exercise browser-native modules and the production Jobs page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createLifecycle } from '../../dashboard/console/page-lifecycle.js';
import { renderSchedule } from '../../dashboard/console/schedule.js';
import { forgetOperatorSession, rememberOperatorSession } from '../../dashboard/console/ui.js';

let dom, lifecycle, main;
beforeEach(() => {
  dom = new JSDOM('<main></main>', { url: 'http://localhost/dashboard/console/#/work/schedule' });
  for (const key of ['window', 'document', 'localStorage', 'location']) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  vi.stubGlobal('requestAnimationFrame', callback => { callback(); return 1; });
  localStorage.setItem('instar_token', 'fixture-dashboard-bearer');
  lifecycle = createLifecycle();
  main = document.querySelector('main');
  unlock('operator-first');
});
afterEach(() => {
  lifecycle.dispose();
  forgetOperatorSession();
  dom.window.close();
  vi.unstubAllGlobals();
});

function unlock(token) {
  rememberOperatorSession({ operatorSessionToken: token, operatorSessionExpiresAt: new Date(Date.now() + 120_000).toISOString() });
}

function render(available = true) {
  return renderSchedule(main, { ...lifecycle.begin('work/schedule'), get: async path => ({
    ok: true, data: path === '/jobs/reconcile' ? { findings: [], previewAvailable: available } : { jobs: [], machines: [] },
  }) });
}

function click(text) {
  [...main.querySelectorAll('button')].find(button => button.textContent === text && !button.hidden).click();
}

const PATH = '/jobs/reconcile?preview=job-definitions';

function response(status = 200, patch = {}) {
  return { status, json: async () => ({
    schemaVersion: 1, complete: false, coverage: {
      legacy: 'complete', 'portable-journal': 'invalid', 'manifest-inventory': 'unchecked',
    }, scheduler: 'unknown', pool: 'unchecked', rows: [
      { slug: 'fixture-job', source: 'legacy', disposition: 'unknown', enabled: false, executor: 'script', reason: 'incomplete',
        raw: '<script>private body</script>' },
    ], truncated: false, ...patch,
  }) };
}

describe('Jobs preview on the normal Schedule page', () => {
  it('shows the explicit action on a clean schedule and performs no automatic preview', async () => {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetch);
    await render(false);
    expect(main.textContent).not.toContain('Preview job migration');
    await render();
    expect(fetch).not.toHaveBeenCalled();
    click('Preview job migration');
    await vi.waitFor(() => expect(main.textContent).toContain('fixture-job'));
    expect(fetch).toHaveBeenCalledWith(PATH, expect.objectContaining({
      headers: { Authorization: 'Bearer fixture-dashboard-bearer', 'X-Instar-Operator-Session': 'operator-first' },
      cache: 'no-store', signal: expect.any(AbortSignal),
    }));
    expect(main.textContent).toContain('Some job definitions could not be checked.');
    expect(main.textContent).toContain('Portable job journal: could not be verified.');
    expect(main.textContent).toContain('Other machines were not checked.');
    expect(main.textContent).not.toContain('private body');
    expect(main.querySelector('[aria-label="Job migration preview"] a')).toBeNull();
  });

  it('uses opaque continuation only in the fetch and asks for a fresh preview after a restart response', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(200, { cursor: 'opaque+cursor/?', truncated: true }))
      .mockResolvedValueOnce(response(409, { error: 'raw internal failure' }));
    vi.stubGlobal('fetch', fetch);
    await render();
    click('Preview job migration');
    await vi.waitFor(() => expect(main.querySelector('.job-preview-row')).not.toBeNull());
    expect(main.textContent).not.toContain('opaque+cursor/?');
    click('Next page');
    await vi.waitFor(() => expect(main.textContent).toContain('Start a fresh preview.'));
    expect(fetch.mock.calls[1][0]).toBe(PATH + '&cursor=opaque%2Bcursor%2F%3F');
    expect(main.textContent).not.toContain('raw internal failure');
  });

  it('uses the standard dashboard unlock when no current operator proof is present', async () => {
    forgetOperatorSession();
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ accepted: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        operatorSessionToken: 'newly-unlocked', operatorSessionExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      }) })
      .mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetch);
    await render();
    click('Preview job migration');
    await vi.waitFor(() => expect(document.querySelector('.pin-input')).not.toBeNull());
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/dashboard/unlock-check']);
    const pin = document.querySelector('.pin-input');
    pin.value = '123456';
    pin.closest('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(main.textContent).toContain('fixture-job'));
    expect(fetch.mock.calls[1][0]).toBe('/dashboard/unlock');
    expect(fetch.mock.calls[2]).toEqual([PATH, expect.objectContaining({
      headers: { Authorization: 'Bearer fixture-dashboard-bearer', 'X-Instar-Operator-Session': 'newly-unlocked' },
    })]);
    expect(main.textContent).not.toContain('123456');
  });

  it('aborts the request and rejects the late response after ordinary route disposal', async () => {
    let finish;
    const fetch = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    await render();
    click('Preview job migration');
    lifecycle.dispose();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    finish(response());
    await Promise.resolve();
    await Promise.resolve();
    expect(main.textContent).not.toContain('fixture-job');
  });

  it('clears open results immediately on lock and ignores an in-flight former operator proof', async () => {
    let finish;
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    await render();
    click('Preview job migration');
    await vi.waitFor(() => expect(main.textContent).toContain('fixture-job'));
    forgetOperatorSession();
    expect(main.textContent).not.toContain('fixture-job');
    unlock('operator-second');
    click('Preview job migration');
    unlock('operator-third');
    finish(response());
    await vi.waitFor(() => expect(main.textContent).toContain('Unlock again'));
    expect(main.textContent).not.toContain('fixture-job');
  });

  it('distinguishes busy, unavailable and denied without displaying server details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(429)).mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(403)));
    await render();
    for (const phrase of ['Another preview is running.', 'unavailable on this machine.', 'Unlock again']) {
      click('Preview job migration');
      await vi.waitFor(() => expect(main.textContent).toContain(phrase));
      expect(main.textContent).not.toContain('fixture-job');
    }
  });
});
