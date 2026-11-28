import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { mountPhonesPanel, pairedDeviceRows } from '../../dashboard/phones.js';
import { pairedDeviceRows as pairPairedGroups } from '../../dashboard-pair/pair-model.js';

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const DEVICES = [
  { id: 'b1', deviceName: 'Browser on Mac (tunnel)', status: 'active', client: 'browser', lastSeenAt: '2026-11-02T10:00:00Z' },
  { id: 'p1', deviceName: 'iPhone', deviceKind: 'phone', status: 'active', approvedAt: '2026-10-01T00:00:00Z' },
  { id: 'p2', deviceName: 'New iPhone', status: 'pending' },
  { id: 'b2', status: 'active', client: 'browser' },
  { id: 'gone', deviceName: 'Old', status: 'revoked' },
];

interface Row { id: string; name: string; detail: string; removable: boolean; what: string }

describe('pairedDeviceRows', () => {
  for (const [name, fn] of [['phones.js', pairedDeviceRows], ['pair-model.js', pairPairedGroups]] as const) {
    it(`${name}: keeps active and pending devices in one list and identifies their kind`, () => {
      const rows = fn([...DEVICES, { id: 'mac', status: 'active', deviceKind: 'computer' }]) as Row[];
      expect(rows.map((r) => r.id)).toEqual(['b1', 'p1', 'p2', 'b2', 'mac']);
      expect(rows[0].detail).toMatch(/^Last used on this machine /);
      expect(rows[1]).toMatchObject({ name: 'iPhone', removable: true, what: 'phone' });
      expect(rows[1].detail).toMatch(/^Paired since /);
      expect(rows[2]).toMatchObject({ detail: 'Waiting to confirm', removable: false, what: 'device' });
      expect(rows[3]).toMatchObject({ name: 'Unnamed computer', detail: 'Not used yet', what: 'computer' });
      expect(rows[4]).toMatchObject({ detail: 'Paired', what: 'computer' });
    });

    it(`${name}: browsers switched off on this agent say so; an unreadable list is empty`, () => {
      expect(fn(DEVICES, { browserOff: true })[0].detail).toBe('Switched off on this agent');
      expect(fn(null)).toEqual([]);
    });
  }
});

describe('legacy Devices panel', () => {
  async function render(statusCode: number) {
    const dom = new JSDOM('<section id="root"></section>');
    const root = dom.window.document.getElementById('root')!;
    (dom.window as unknown as { confirm: () => boolean }).confirm = () => true;
    const calls: string[] = [];
    const panel = mountPhonesPanel(root, {
      request: async (url: string, o: { method?: string } = {}) => {
        calls.push(`${o.method ?? 'GET'} ${url}`);
        if (url === '/mobile/pairing-approvals') return json(200, { approvals: [] });
        if (url === '/mobile/devices') return json(200, { devices: [{ id: 'b1', deviceName: 'Browser on Mac (tunnel)', status: 'active', client: 'browser', lastSeenAt: '2026-11-02T10:00:00Z' }, { id: 'p1', deviceName: 'iPhone', deviceKind: 'phone', status: 'active' }] });
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

  it('lists phones and computers together and preserves browser removal', async () => {
    const { root, calls } = await render(200);
    const order = [...root.querySelectorAll('h3, .phone-row')].map((n) => n.tagName === 'H3' ? n.textContent : n.querySelector('.phone-row-name')!.textContent);
    expect(order.slice(-3)).toEqual(['Paired devices', 'Browser on Mac (tunnel)', 'iPhone']);
    expect(root.textContent).toContain('Last used on this machine');
    expect(root.textContent).toContain('Computer · Last used');
    expect(root.textContent).toContain('Phone · Paired');
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
