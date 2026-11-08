/**
 * People > Phones shows browsers (dashboard-conversations-browser-device.md §4.9): a "Browser" tag,
 * "last used on this machine", "not used yet", "Switched off on this agent" while the switch is off,
 * and the existing revoke worded for a browser — on the legacy Phones panel and on /dashboard/pair.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { mountPhonesPanel, browserWords } from '../../dashboard/phones.js';
import { browserWords as pairBrowserWords } from '../../dashboard-pair/pair-model.js';

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe('browserWords', () => {
  for (const [name, fn] of [['phones.js', browserWords], ['pair-model.js', pairBrowserWords]] as const) {
    it(`${name}: phone, used, unused, switched off`, () => {
      expect(fn({ status: 'active' })).toBeNull();
      expect(fn({ client: 'browser', lastSeenAt: '2026-11-02T10:00:00Z' })).toMatch(/^Browser · last used on this machine /);
      expect(fn({ client: 'browser' })).toBe('Browser · not used yet');
      expect(fn({ client: 'browser', lastSeenAt: '2026-11-02T10:00:00Z' }, { browserOff: true })).toBe('Browser · Switched off on this agent');
    });
  }
});

describe('legacy Phones panel', () => {
  async function render(statusCode: number) {
    const dom = new JSDOM('<section id="root"></section>');
    const root = dom.window.document.getElementById('root')!;
    (dom.window as unknown as { confirm: () => boolean }).confirm = () => true;
    const calls: string[] = [];
    const panel = mountPhonesPanel(root, {
      request: async (url: string, o: { method?: string } = {}) => {
        calls.push(`${o.method ?? 'GET'} ${url}`);
        if (url === '/mobile/pairing-approvals') return json(200, { approvals: [] });
        if (url === '/mobile/devices') return json(200, { devices: [{ id: 'b1', deviceName: 'Browser on Mac (tunnel)', status: 'active', client: 'browser', lastSeenAt: '2026-11-02T10:00:00Z' }, { id: 'p1', deviceName: 'iPhone', status: 'active' }] });
        if (url === '/mobile/browser-devices/status') return json(statusCode, {});
        if (url === '/mobile/devices/b1/revoke') return json(200, { revoked: true });
        return json(404, {});
      },
      unlock: () => {},
    });
    await panel.refresh();
    (root.querySelector('[data-glance-tile="paired"]') as HTMLButtonElement).click();
    return { root, calls };
  }

  it('tags the browser, says when it was last used, and words its revoke for a browser', async () => {
    const { root, calls } = await render(200);
    const rows = [...root.querySelectorAll('.phone-row')].map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('Browser on Mac (tunnel)');
    expect(rows[0]).toContain('Browser · last used on this machine');
    expect(rows[1]).not.toContain('Browser ·');
    const remove = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Remove this browser') as HTMLButtonElement;
    expect(remove).toBeTruthy();
    expect([...root.querySelectorAll('button')].some((b) => b.textContent === 'Remove this phone')).toBe(true);
    remove.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContain('POST /mobile/devices/b1/revoke');
  });

  it('while the switch is off, browser rows say so', async () => {
    const { root } = await render(503);
    expect(root.textContent).toContain('Browser · Switched off on this agent');
  });
});
