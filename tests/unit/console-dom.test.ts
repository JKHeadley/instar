/**
 * Console shell in a DOM (docs/specs/console-makeover.md, MVP 1–2): boots the
 * SHIPPED console.js in jsdom against mocked routes and checks the behaviour
 * the screenshots cannot: the PIN screen without a token, six cards from live
 * answers, a failing source rendering "Can't tell" on its own card, See all,
 * a row that stays open across a refresh, and every legacy link being an
 * ordinary link (no iframe).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const NOW = new Date().toISOString();
const ROUTES: Record<string, unknown> = {
  '/sessions': { sessions: [] },
  '/health': { project: { name: 'echo' }, telegramOrigin: { heldForward: { count: 0, observedAt: Date.now(), expiredUnreported: 0 } } },
  '/attention?scope=pool': { items: [1, 2, 3, 4, 5].map((n) => ({ id: `a${n}`, title: `Item ${n}`, status: 'OPEN', priority: 'URGENT', createdAt: NOW, description: `Detail ${n}` })), pool: { failed: [] } },
  '/commitments?scope=mesh': { enabled: true, scope: 'mesh', commitments: [] },
  '/sessions?scope=pool': { sessions: [{ name: 'Fix it', status: 'running', startedAt: NOW, machineNickname: 'Mac Studio' }], pool: { failed: [] } },
  '/pool': { machines: [{ machineId: 'm1', nickname: 'Mac Studio', isSelf: true, online: true, routerReceivedAt: NOW, loadAvg: 1, hardware: { cpuCores: 16 } }] },
  '/guards': null, // fails: the card must say it cannot tell
  '/mandate': { mandates: [] },
};

let dom: JSDOM;
const flush = () => new Promise((r) => setTimeout(r, 30));

async function boot(token: string | null) {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/home' });
  const g = globalThis as Record<string, unknown>;
  Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage });
  if (token) dom.window.localStorage.setItem('instar_token', token);
  g.fetch = async (url: string) => {
    const body = ROUTES[url];
    if (body === undefined) return new dom.window.Response('{}', { status: 404 }) as unknown as Response;
    if (body === null) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) } as unknown as Response;
  };
  vi.resetModules();
  await import('../../dashboard/console/console.js');
  for (let i = 0; i < 10; i++) await flush();
  return dom.window.document;
}

afterEach(() => { dom?.window.close(); });

describe('console shell (jsdom)', () => {
  it('without a token it shows the PIN screen', async () => {
    const doc = await boot(null);
    expect(doc.querySelector('.pin-input')).not.toBeNull();
    expect(doc.querySelector('#card-needs')).toBeNull();
  });

  it('with a token it renders the headline and six cards', async () => {
    const doc = await boot('t');
    expect(doc.querySelectorAll('.card')).toHaveLength(6);
    expect(doc.querySelector('#heroTitle')!.textContent).toBe('5 things need you.');
  });

  it('promises waiting on you are listed in What needs you, and the headline agrees with it', async () => {
    const saved = { a: ROUTES['/attention?scope=pool'], c: ROUTES['/commitments?scope=mesh'] };
    ROUTES['/attention?scope=pool'] = { items: [{ id: 'r', title: 'Routine', status: 'OPEN', priority: 'LOW', category: 'worktree', createdAt: NOW }], pool: { failed: [] } };
    ROUTES['/commitments?scope=mesh'] = { enabled: true, scope: 'mesh', commitments: [
      { id: 'CMT-1', status: 'pending', owner: 'user', blockedOn: 'user-input', createdAt: NOW, agentResponse: 'Pick a name' },
      { id: 'CMT-2', status: 'pending', owner: 'user', blockedOn: 'user-authorization', createdAt: NOW, agentResponse: 'Approve the spend' },
    ] };
    try {
      const doc = await boot('t');
      expect(doc.querySelector('#heroTitle')!.textContent).toBe('2 things need you.');
      const card = doc.querySelector('#card-needs')!;
      expect(card.querySelector('.card-value')!.textContent).toBe('2 things');
      expect(card.textContent).not.toMatch(/Nothing needs you/);
      expect(card.querySelectorAll('button.row')).toHaveLength(2);
      // Housekeeping sits behind the Details fold, not on the face.
      expect(card.querySelector('.card-line')!.textContent).not.toContain('routine');
      expect(card.querySelector('details.card-details')!.textContent).toContain('1 routine notice kept in the log');
      expect(doc.querySelector('#card-promised .card-line')!.textContent).toBe('2 of them are waiting on you, listed under What needs you.');
    } finally {
      ROUTES['/attention?scope=pool'] = saved.a; ROUTES['/commitments?scope=mesh'] = saved.c;
    }
  });

  it('a failing source says "Can\'t tell" on its own card; the others render', async () => {
    const doc = await boot('t');
    const allowed = doc.querySelector('#card-allowed')!;
    expect(allowed.getAttribute('data-state')).toBe('unknown');
    expect(allowed.querySelector('.card-value')!.textContent).toBe("Can't tell");
    expect(doc.querySelector('#card-doing')!.getAttribute('data-state')).toBe('ok');
  });

  it('See all reveals every row; a row opened stays open across a refresh', async () => {
    const doc = await boot('t');
    const card = doc.querySelector('#card-needs')!;
    expect(card.querySelectorAll('button.row')).toHaveLength(3);
    (card.querySelector('.link-btn') as HTMLButtonElement).click();
    expect(card.querySelectorAll('button.row')).toHaveLength(5);
    const first = card.querySelector('button.row') as HTMLButtonElement;
    first.click();
    expect(first.getAttribute('aria-expanded')).toBe('true');
    // A refresh repaints the card from new data.
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    for (let i = 0; i < 10; i++) await flush();
    const again = doc.querySelector('#card-needs')!;
    // The page re-rendered; open state is per-session memory, so the row re-opens.
    const row = [...again.querySelectorAll('button.row')].find((b) => b.textContent!.includes('Item 1')) as HTMLButtonElement;
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(again.querySelectorAll('button.row')).toHaveLength(5);
  });

  it('group pages link to their native pages as ordinary links, with no iframe', async () => {
    const doc = await boot('t');
    dom.window.location.hash = '#/work';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    await flush();
    const tiles = [...doc.querySelectorAll('a.tile')].map((a) => a.getAttribute('href'));
    expect(tiles).toContain('#/work/sessions?paste=1');
    expect(tiles.every((h) => (h || '').startsWith('#/'))).toBe(true);
    expect(doc.querySelector('iframe')).toBeNull();
  });
});
