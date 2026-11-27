/**
 * People > Phones shows browsers (dashboard-conversations-browser-device.md §4.9) under their own
 * "Paired browsers" heading, apart from phones (docs/specs/dashboard-ui-quality-standard.md): "last
 * used on this machine", "not used yet", "Switched off on this agent" while the switch is off, no
 * repeated kind tag in any row, and a short Remove worded for a browser — on the legacy Phones panel
 * and on /dashboard/pair.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { mountPhonesPanel, pairedGroups } from '../../dashboard/phones.js';
import { pairedGroups as pairPairedGroups } from '../../dashboard-pair/pair-model.js';

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const DEVICES = [
  { id: 'b1', deviceName: 'Browser on Mac (tunnel)', status: 'active', client: 'browser', lastSeenAt: '2026-11-02T10:00:00Z' },
  { id: 'p1', deviceName: 'iPhone', status: 'active', approvedAt: '2026-10-01T00:00:00Z' },
  { id: 'p2', deviceName: 'New iPhone', status: 'pending' },
  { id: 'b2', status: 'active', client: 'browser' },
  { id: 'gone', deviceName: 'Old', status: 'revoked' },
];

interface Row { id: string; name: string; detail: string; removable: boolean; what: string }

describe('pairedGroups', () => {
  for (const [name, fn] of [['phones.js', pairedGroups], ['pair-model.js', pairPairedGroups]] as const) {
    it(`${name}: splits phones from browsers, one short detail line each, no repeated kind tag`, () => {
      const { phones, browsers } = fn(DEVICES) as { phones: Row[]; browsers: Row[] };
      expect(phones.map((r) => r.id)).toEqual(['p1', 'p2']);
      expect(browsers.map((r) => r.id)).toEqual(['b1', 'b2']);
      expect(phones[0]).toMatchObject({ name: 'iPhone', removable: true, what: 'phone' });
      expect(phones[0].detail).toMatch(/^Paired since /);
      expect(phones[1]).toMatchObject({ detail: 'Waiting to confirm', removable: false });
      expect(browsers[0].detail).toMatch(/^Last used on this machine /);
      expect(browsers[1]).toMatchObject({ name: 'Unnamed browser', detail: 'Not used yet', what: 'browser' });
      for (const r of [...phones, ...browsers]) expect(`${r.name} ${r.detail}`).not.toMatch(/Browser ·|Paired ·/);
    });

    it(`${name}: browsers switched off on this agent say so; an unreadable list is empty`, () => {
      expect((fn(DEVICES, { browserOff: true }) as { browsers: Row[] }).browsers[0].detail).toBe('Switched off on this agent');
      expect(fn(null)).toEqual({ phones: [], browsers: [] });
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

  it('lists browsers under their own heading after the phones, and a short Remove worded for a browser', async () => {
    const { root, calls } = await render(200);
    const order = [...root.querySelectorAll('h3, .phone-row')].map((n) => n.tagName === 'H3' ? n.textContent : n.querySelector('.phone-row-name')!.textContent);
    expect(order.slice(-4)).toEqual(['Paired phones', 'iPhone', 'Paired browsers', 'Browser on Mac (tunnel)']);
    expect(root.textContent).toContain('Last used on this machine');
    expect(root.textContent).not.toMatch(/Browser ·|Paired ·/);
    const remove = root.querySelector('button[aria-label="Remove Browser on Mac (tunnel)"]') as HTMLButtonElement;
    expect(remove.textContent).toBe('Remove');
    remove.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContain('POST /mobile/devices/b1/revoke');
  });

  it('while the switch is off, browser rows say so', async () => {
    const { root } = await render(503);
    expect(root.textContent).toContain('Switched off on this agent');
  });
});
