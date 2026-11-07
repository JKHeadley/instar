import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });
function page() {
  dom = new JSDOM('<main id="page"></main>', { url: 'https://agent.example/dashboard', pretendToBeVisual: true });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  let read = false;
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'PATCH') read = true;
    const data = url.includes('selectivity') ? { dryRun: false, categories: [{ id: 'job-status', description: 'Scheduled job reports', push: false }, { id: 'command-response', description: 'Command responses', push: false, configurable: false }] }
      : options?.method === 'PATCH' ? { ok: true } : { unread: read ? 0 : 1, items: read ? [] : [{ id: 'quiet-1', machineId: 'machine-a', category: 'job-status',
        text: '<img src=x onerror="alert(1)"> quoted notice', count: 3, updatedAt: new Date().toISOString() }], unavailable: [] };
    return { ok: true, json: async () => data };
  });
  vi.stubGlobal('fetch', fetch);
  return { main: document.querySelector('main')!, fetch };
}
describe('Notifications operator page', () => {
  it('renders stored bodies as text and keeps actions phone-sized', async () => {
    const { main } = page();
    const { renderNotifications } = await import('../../dashboard/console/notifications.js');
    await renderNotifications(main);
    expect(main.querySelector('[aria-label="Push command responses"]')).toBeNull();
    expect(main.textContent).toContain('<img src=x'); expect(main.querySelector('img')).toBeNull();
    const button = [...main.querySelectorAll('button')].find(node => node.textContent === 'Mark read')!;
    expect(button.style.minHeight).toBe('44px');
    expect(main.querySelector('input[aria-label="Push scheduled job reports"]')).not.toBeNull();
    expect(main.querySelector('h1')?.textContent).toBe('Notifications');
    expect(main.querySelector('.glance-root')?.textContent).toContain('Unread notices');
    expect(main.querySelector('.glance-root')?.textContent).toContain('Push choices');
  });
  it('marks a notice read at its owner and refreshes the feed', async () => {
    const { main, fetch } = page();
    const { renderNotifications } = await import('../../dashboard/console/notifications.js');
    await renderNotifications(main);
    const button = [...main.querySelectorAll('button')].find(node => node.textContent === 'Mark read')!;
    button.click();
    await vi.waitFor(() => expect(main.textContent).toContain('No unread notices'));
    expect(fetch.mock.calls.some(([url, options]) => url.includes('/quiet/quiet-1?machineId=machine-a') && options?.method === 'PATCH')).toBe(true);
  });
});
