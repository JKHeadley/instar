/**
 * The dashboard's Phones card (docs/specs/mobile-native-conversations.md §4.4): a no-Telegram
 * agent's pending phone and its code appear only when the operator-session route answers; a 403
 * asks for the PIN unlock and shows no code; values are rendered as text, never HTML.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { mountPhonesPanel, prettyCode, minutesLeft, phonesGlanceSpec } from '../../dashboard/phones.js';
import { validateGlanceSpec } from '../../dashboard/glance.js';

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

function mount(answers: Record<string, () => Response>) {
  const dom = new JSDOM('<section id="root"></section>');
  const root = dom.window.document.getElementById('root')!;
  const calls: Array<{ url: string; method: string }> = [];
  let unlocked = 0;
  const panel = mountPhonesPanel(root, {
    request: async (url: string, options: { method?: string } = {}) => { calls.push({ url, method: options.method ?? 'GET' }); return (answers[`${options.method ?? 'GET'} ${url}`] ?? (() => json(404, {})))(); },
    unlock: () => { unlocked++; },
    now: () => Date.parse('2026-11-02T10:00:00Z'),
  });
  return { root, panel, calls, unlocked: () => unlocked };
}

describe('Phones card', () => {
  it('formats the code and time left', () => {
    expect(prettyCode('123456')).toBe('123 456');
    expect(minutesLeft('2026-11-02T10:12:00Z', Date.parse('2026-11-02T10:00:00Z'))).toBe('12 min left');
    expect(minutesLeft('2026-11-02T09:00:00Z', Date.parse('2026-11-02T10:00:00Z'))).toBe('expired');
  });

  it('the glance passes the F10 floor in every state and never carries a code', () => {
    for (const st of [{ waiting: 0, paired: 0 }, { waiting: 1, paired: 2 }, { waiting: 3, paired: 1 }, { locked: true, paired: 1 }, {}]) {
      expect(validateGlanceSpec(phonesGlanceSpec(st)).ok).toBe(true);
    }
    expect(phonesGlanceSpec({ waiting: 1, paired: 0 }).headline).toBe('A phone is waiting to pair. Open Waiting to see the code.');
  });

  it('without an operator session: asks to unlock and shows no code', async () => {
    const t = mount({
      'GET /mobile/pairing-approvals': () => json(403, { error: 'operator-session-required' }),
      'GET /mobile/devices': () => json(200, { devices: [] }),
    });
    await t.panel.refresh();
    const unlock = [...t.root.querySelectorAll('button')].find((b) => /Unlock/.test(b.textContent ?? ''))!;
    expect(unlock.hidden).toBe(false);
    unlock.click();
    expect(t.unlocked()).toBe(1);
    expect(t.root.querySelector('.phone-code')).toBeNull();
  });

  it('with a session: shows the waiting phone, its key and code as text; decline posts to the route', async () => {
    const t = mount({
      'GET /mobile/pairing-approvals': () => json(200, { approval: 'dashboard', approvals: [{ deviceId: 'dev-1', deviceName: '<img src=x onerror=alert(1)>', label: null, fingerprint: 'AB12-CD34', code: '654321', expiresAt: '2026-11-02T10:10:00Z' }] }),
      'GET /mobile/devices': () => json(200, { devices: [{ id: 'dev-0', deviceName: 'Old phone', status: 'active', approvedAt: '2026-10-01T00:00:00Z' }] }),
      'POST /mobile/pairing-approvals/dev-1/decline': () => json(200, { declined: true }),
    });
    await t.panel.refresh();
    expect(t.root.querySelector('.phone-code')).toBeNull(); // behind the Waiting tile
    (t.root.querySelector('[data-glance-tile="waiting"]') as HTMLButtonElement).click();
    expect(t.root.querySelector('.phone-code')!.textContent).toBe('654 321');
    expect(t.root.textContent).toContain('AB12-CD34');
    expect(t.root.textContent).toContain('10 min left');
    expect(t.root.querySelector('img')).toBeNull(); // the name is text, not markup
    expect(t.root.textContent).not.toContain('Old phone'); // behind the Paired tile
    expect(t.root.querySelector('[data-glance-tile="paired"]')!.textContent).toContain('1');
    const decline = [...t.root.querySelectorAll('button')].find((b) => /decline/.test(b.textContent ?? ''))!;
    decline.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.calls.some((c) => c.method === 'POST' && c.url === '/mobile/pairing-approvals/dev-1/decline')).toBe(true);
  });

  it('pairing off: says so', async () => {
    const t = mount({ 'GET /mobile/pairing-approvals': () => json(503, {}), 'GET /mobile/devices': () => json(503, {}) });
    await t.panel.refresh();
    expect(t.root.textContent).toContain('Phone pairing is turned off');
  });
});
