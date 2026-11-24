// @ts-nocheck: tests exercise the deployed browser-native ES modules.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { workDiscoveryPanel } from '../../dashboard/console/work-discovery.js';

const APP = '11111111-1111-4111-8111-111111111111';
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<main></main>', { url: 'http://localhost/dashboard/console/#/work/board' });
  vi.stubGlobal('document', dom.window.document);
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });

function panel(options = {}) {
  const send = options.send ?? vi.fn(async () => ({ status: 200, data: {
    version: 1, status: 'partial',
    candidates: [
      { kind: 'conversation', ref: `app:${APP}`, messageId: 'source-event', title: 'Earlier private discussion', snippet: '<img src=x onerror="boom()"> text' },
      { kind: 'pull-request', repository: 'JKHeadley/instar', number: 3342, state: 'OPEN', matchedBy: 'all-terms', title: 'Earlier review', url: 'javascript:boom()' },
      { kind: 'pull-request', repository: 'unknown/private', number: 9, title: 'Rejected repo link' },
      { kind: 'conversation', ref: `app:${APP}`, messageId: 'javascript: alert(1)', title: 'Rejected position' },
    ],
    coverage: { conversations: { platforms: { app: 'present', telegram: 'unknown', slack: 'unsearched' }, peers: 'unsearched' }, pullRequests: { status: 'stale' } },
  } }));
  const child = workDiscoveryPanel({ send, sessionToken: () => 'dst_operator', ...options });
  if (child) document.querySelector('main').append(child);
  return { child, send };
}

function submit(child) {
  child.querySelector('input').value = ' prior subject ';
  child.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
}

describe('private Work search panel', () => {
  it('keeps the query in the POST and renders only canonical links and plain snippets', async () => {
    const { child, send } = panel();
    submit(child);
    expect(child.querySelector('[role="status"]').textContent).toBe('Searching for earlier work…');
    expect(child.querySelector('button').disabled).toBe(true);
    await vi.waitFor(() => expect(child.querySelectorAll('a')).toHaveLength(2));
    expect(send).toHaveBeenCalledWith('/work/discover', { query: 'prior subject' }, expect.any(AbortSignal));
    expect([...child.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual([
      `#/work/chats?c=${encodeURIComponent('app:' + APP)}&m=source-event`, 'https://github.com/JKHeadley/instar/pull/3342',
    ]);
    expect(child.textContent).toContain('<img src=x onerror="boom()"> text');
    expect(child.querySelector('img')).toBeNull();
    expect(child.textContent).not.toContain('Rejected repo link');
    expect(child.textContent).toContain('Open when checked');
    expect(child.textContent).toContain('Matched all search terms across pull request fields.');
    expect(child.textContent).toContain('Could not verify coverage');
    expect(child.textContent).toContain('Older results');
    expect(dom.window.location.href).not.toContain('prior');
  });

  it('does not render for unsigned, shared, team or master sessions', () => {
    for (const token of ['', 'mps_member', 'device_guest', 'master-key']) {
      expect(panel({ sessionToken: () => token }).child).toBeNull();
    }
  });

  it('distinguishes no available sources and a failed request without displaying server detail', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ status: 503, data: { version: 1, status: 'unavailable', candidates: [], coverage: { pullRequests: { status: 'unavailable' } } } })
      .mockResolvedValueOnce({ status: 500, data: { error: 'raw private stack text' } });
    const { child } = panel({ send });
    submit(child);
    await vi.waitFor(() => expect(child.textContent).toContain('No sources could be checked.'));
    expect(child.querySelector('details')).not.toBeNull();
    submit(child);
    await vi.waitFor(() => expect(child.textContent).toContain('The search could not finish. Try again.'));
    expect(child.textContent).not.toContain('raw private stack text');
    expect(child.querySelector('details')).toBeNull();
  });

  it('discards late evidence on a disposed Work visit', async () => {
    let finish;
    let dispose;
    const sent = new Promise(resolve => { finish = resolve; });
    const { child, send } = panel({ send: vi.fn(() => sent), onDispose: fn => { dispose = fn; } });
    submit(child);
    dispose();
    expect(send.mock.calls[0][2].aborted).toBe(true);
    finish({ status: 200, data: { version: 1, candidates: [{ kind: 'pull-request', repository: 'JKHeadley/instar', number: 3342 }] } });
    await sent;
    await Promise.resolve();
    expect(child.querySelector('a')).toBeNull();
    expect(child.querySelector('input').value).toBe('');
  });
});
