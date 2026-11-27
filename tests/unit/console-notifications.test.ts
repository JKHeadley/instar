import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });
function page(body = '<img src=x onerror="alert(1)"> quoted notice') {
  dom = new JSDOM('<main id="page"></main>', { url: 'https://agent.example/dashboard', pretendToBeVisual: true });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  let read = false;
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'PATCH') read = true;
    const data = url.includes('selectivity') ? { dryRun: false, categories: [{ id: 'job-status', description: 'Scheduled job reports', push: false }, { id: 'command-response', description: 'Command responses', push: false, configurable: false }] }
      : options?.method === 'PATCH' ? { ok: true } : { unread: read ? 0 : 1, items: read ? [] : [{ id: 'quiet-1', machineId: 'machine-a', category: 'job-status',
        text: body, count: 3, updatedAt: new Date().toISOString() }], unavailable: [] };
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
  it.each(['another page', 'a newer notifications view', 'a detached page'])('keeps a delayed save from repainting %s', async target => {
    const { main, fetch } = page();
    const original = fetch.getMockImplementation()!;
    let finishSave!: () => void;
    const pending = new Promise<void>(resolve => { finishSave = resolve; });
    fetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'PATCH') await pending;
      return original(url, options);
    });
    const { renderNotifications } = await import('../../dashboard/console/notifications.js');
    await renderNotifications(main);
    const button = [...main.querySelectorAll('button')].find(node => node.textContent === 'Mark read')!;
    button.click();
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(1);
    if (target === 'another page') main.innerHTML = '<h1>Accounts</h1><p>Current page</p>';
    else if (target === 'a newer notifications view') await renderNotifications(main, undefined, { unread: false });
    else main.remove();
    const current = main.innerHTML;
    const requests = fetch.mock.calls.length;
    finishSave();
    // Drain the actual async click callback, including the response's json() and any refresh.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(main.innerHTML).toBe(current);
    expect(fetch.mock.calls).toHaveLength(requests);
    if (target === 'a newer notifications view') expect((main.querySelector('[aria-label="Only unread notices"]') as HTMLInputElement).checked).toBe(false);
  });


  it('keeps a long notice readable while preserving its full safe text and action', async () => {
    const body = '<img src=x> ' + 'A long report. '.repeat(1200) + 'Ending 🚀';
    const { main } = page(body);
    const { renderNotifications } = await import('../../dashboard/console/notifications.js');
    await renderNotifications(main);
    const article = main.querySelector('article.need-card')!;
    const details = article.querySelector('details')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe('Read full notice');
    expect(article.querySelector('.notice-preview')!.textContent!.length).toBeLessThanOrEqual(225);
    expect(details.querySelector('.notice-full')?.textContent).toBe(body);
    expect(article.querySelector('img')).toBeNull();
    expect(article.querySelector('[title]')).toBeNull();
    expect([...article.querySelectorAll('button')].some(b => b.textContent === 'Mark read')).toBe(true);
    details.querySelector('summary')!.click();
    expect(details.open).toBe(true);
    const { refreshHeld } = await import('../../dashboard/console/ui.js');
    await vi.waitFor(() => expect(refreshHeld(main)).toBe(true));
    details.open = false;
    await vi.waitFor(() => expect(refreshHeld(main)).toBe(false));
  });
  it('uses readable references in both the preview and the full notice', async () => {
    const id = 'm_' + 'a'.repeat(32);
    const { main } = page(`Computer ${id} reported in topic 123456789. ` + 'More evidence. '.repeat(100));
    const { renderNotifications } = await import('../../dashboard/console/notifications.js');
    await renderNotifications(main);
    for (const node of main.querySelectorAll('.notice-preview, .notice-full')) {
      expect(node.textContent).not.toContain(id);
      expect(node.textContent).not.toContain('123456789');
      expect(node.textContent).toContain('More evidence.');
    }
  });
  it.each([320, 321])('uses disclosure only beyond the readable threshold (%s characters)', async count => {
    const { main } = page('🚀'.repeat(count));
    const { renderNotifications } = await import('../../dashboard/console/notifications.js');
    await renderNotifications(main);
    const article = main.querySelector('article.need-card')!;
    expect(!!article.querySelector('details')).toBe(count > 320);
    if (count > 320) {
      const preview = article.querySelector('.notice-preview')!.textContent!;
      expect(preview).not.toContain('�');
      expect(Array.from(preview).length).toBeLessThanOrEqual(221);
    }
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
