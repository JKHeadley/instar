/**
 * Console shell in a DOM (docs/specs/console-makeover.md, MVP 1–2): boots the
 * SHIPPED console.js in jsdom against mocked routes and checks the behaviour
 * the screenshots cannot: the PIN screen without a token, six cards from live
 * answers, a failing source rendering "Can't tell" on its own card, bounded
 * authoritative Needs-you rows, and every legacy link being an
 * ordinary link (no iframe).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const NOW = new Date().toISOString();
const needs = (items: unknown[], options = {}) => ({
  schemaVersion: 2, count: items.length, complete: true, items, ...options,
});
const instruction = (title: string, step = 'Open Instar again.') => ({
  id: title, title, ownerAction: 'physical', action: { kind: 'instructions', steps: [step] },
});
const ROUTES: Record<string, unknown> = {
  '/needs': needs([1, 2, 3, 4, 5].map(n => instruction(`Item ${n}`))),
  '/sessions': { sessions: [] },
  '/health': { project: { name: 'echo' }, telegramOrigin: { heldForward: { count: 0, observedAt: Date.now(), expiredUnreported: 0 } } },
  '/attention?scope=pool&status=OPEN': { items: [1, 2, 3, 4, 5].map((n) => ({ id: `a${n}`, title: `Item ${n}`, status: 'OPEN', priority: 'URGENT', createdAt: NOW, description: `Detail ${n}` })), pool: { failed: [] } },
  '/commitments?scope=mesh': { enabled: true, scope: 'mesh', commitments: [] },
  '/sessions?scope=pool': { sessions: [{ name: 'Fix it', status: 'running', startedAt: NOW, machineNickname: 'Mac Studio' }], pool: { failed: [] } },
  '/telegram/topics?scope=pool': { topics: [], pool: { failed: [], unresolved: [] } },
  '/pool': { machines: [{ machineId: 'm1', nickname: 'Mac Studio', isSelf: true, online: true, routerReceivedAt: NOW, loadAvg: 1, hardware: { cpuCores: 16 }, servesChannels: { telegram: { chatIds: ['-1003742343280'] } } }] },
  '/guards': null, // fails: the card must say it cannot tell
  '/mandate': { mandates: [] },
};

let dom: JSDOM;
const flush = () => new Promise((r) => setTimeout(r, 30));

async function boot(token: string | null, ownerNeeds: () => unknown = () => ROUTES['/needs']) {
  // Home is a page of the phone app's frame now; on the web its address lands on Conversations (work-front-doors §2.1).
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/home?phone=1' });
  const g = globalThis as Record<string, unknown>;
  Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage });
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0);
  if (token) dom.window.localStorage.setItem('instar_token', token);
  g.fetch = async (url: string, options?: { headers?: Record<string, string> }) => {
    if (url === '/needs') expect(options?.headers?.['X-Instar-Needs-Contract']).toBe('in-place-v1');
    const body = url === '/needs' ? ownerNeeds() : ROUTES[url];
    if (body === undefined) return new Response('{}', { status: 404 });
    if (body === null) return new Response('{}', { status: 500 });
    return Response.json(body);
  };
  vi.resetModules();
  await import('../../dashboard/console/console.js');
  for (let i = 0; i < 10; i++) await flush();
  return dom.window.document;
}

afterEach(() => { dom?.window.close(); });

describe('console shell (jsdom)', () => {
  it('renders the pooled topic title on Home instead of the local topic-ID placeholder', async () => {
    const oldSessions = ROUTES['/sessions?scope=pool'];
    const oldTopics = ROUTES['/telegram/topics?scope=pool'];
    ROUTES['/sessions?scope=pool'] = { sessions: [{ name: 'topic-127504', platform: 'telegram', platformId: 127504, status: 'running', startedAt: NOW, machineNickname: 'Mama PC' }], pool: { failed: [] } };
    ROUTES['/telegram/topics?scope=pool'] = { topics: [{ topicId: 127504, topicName: 'Instar dashboard makeover' }], pool: { failed: [], unresolved: [] } };
    try {
      const doc = await boot('t');
      expect(doc.querySelector('#card-doing')?.textContent).toContain('Instar dashboard makeover');
      expect(doc.querySelector('#card-doing')?.textContent).not.toContain('topic-127504');
    } finally { ROUTES['/sessions?scope=pool'] = oldSessions; ROUTES['/telegram/topics?scope=pool'] = oldTopics; }
  });
  it('without a token it shows the PIN screen', async () => {
    const doc = await boot(null);
    expect(doc.querySelector('.pin-input')).not.toBeNull();
    expect(doc.querySelector('#card-needs')).toBeNull();
  });

  it('renders one negotiated Needs-you list and four independent status cards', async () => {
    const doc = await boot('t');
    expect(doc.querySelectorAll('.card')).toHaveLength(4);
    expect(doc.querySelectorAll('#homeNeedsStrip')).toHaveLength(1);
    expect(doc.querySelector('#card-needs, #card-reach')).toBeNull();
    expect(doc.querySelector('#heroTitle')!.textContent).toBe('Item 1');
  });

  it('renders a gate-off response and keeps its direct link on the request', async () => {
    const href = 'https://t.me/c/3742343280/127504';
    const doc = await boot('t', () => needs([
      { id: 'approve-1', title: 'Approve the schedule change', action: { kind: 'href', href } },
    ], { schemaVersion: 1, complete: false, couldNotCheck: ['Laptop'] }));
    expect(doc.querySelector('#heroTitle')?.textContent).toBe('Approve the schedule change');
    const link = doc.querySelector<HTMLAnchorElement>('#homeNeedsStrip a.needs-row');
    expect(link?.href).toBe(href);
    expect(doc.querySelector('#heroSub')?.textContent).not.toContain('Laptop');
    expect(doc.querySelector('#homeStatusNote')?.textContent).toContain('Could not check Laptop.');
  });

  it('shows a verified physical request in place and keeps unsigned approvals hidden', async () => {
    const doc = await boot('t', () => needs([
      instruction('Update Instar on your phone'),
      { id: 'approval', title: 'Approve rulebook changes', action: { kind: 'approval', requestId: 'opaque' } },
    ]));
    expect(doc.querySelector('#heroTitle')?.textContent).toBe('Update Instar on your phone');
    expect(doc.querySelector('#homeNeedsStrip .needs-instructions li')?.textContent).toBe('Open Instar again.');
    expect(doc.querySelector('#homeNeedsStrip .needs-badge')?.textContent).toBe('2');
    expect(doc.querySelector('#homeNeedsStrip')?.textContent).not.toContain('Approve rulebook changes');
    expect(doc.querySelector('#homeNeedsStrip .needs-consent')).toBeNull();
  });

  it('keeps an agent-owned missed promise out of the authoritative headline', async () => {
    const old = ROUTES['/commitments?scope=mesh'];
    ROUTES['/commitments?scope=mesh'] = { enabled: true, scope: 'mesh', commitments: [{
      id: 'CMT-MISS', status: 'violated', owner: 'agent', blockedOn: 'none', createdAt: NOW,
      hardDeadlineAt: new Date(Date.parse(NOW) - 60000).toISOString(),
      originMachineId: 'm1', userRequest: 'Please change the schedule',
    }] };
    try {
      const doc = await boot('t', () => needs([], { divertedCount: 1 }));
      expect(doc.querySelector('#heroTitle')?.textContent).not.toContain('Overdue');
      expect(doc.querySelector('#heroTitle a.hero-action')).toBeNull();
      expect(doc.querySelector('#homeNeedsStrip')?.textContent).toContain('Nothing needs you right now.');
      expect(doc.querySelector('#homeNeedsStrip')?.textContent).toContain('1 item was left out');
    } finally { ROUTES['/commitments?scope=mesh'] = old; }
  });

  it('shows an incomplete result and retries the negotiated list on demand', async () => {
    let available = false;
    const doc = await boot('t', () => available ? needs([instruction('Choose a time')]) : null);
    expect(doc.querySelector('#heroTitle')?.textContent).toContain("Couldn't check");
    const retry = [...doc.querySelectorAll<HTMLButtonElement>('#homeNeedsStrip button')].find(button => button.textContent === 'Try again');
    expect(retry).toBeTruthy();
    available = true;
    retry!.click();
    await flush();
    expect(doc.querySelector('#heroTitle')?.textContent).toBe('Choose a time');
  });

  it('uses a successful authoritative read while a separate promise status read fails', async () => {
    const old = ROUTES['/commitments?scope=mesh'];
    ROUTES['/commitments?scope=mesh'] = null;
    try {
      const doc = await boot('t', () => needs([instruction('Choose a time')]));
      expect(doc.querySelector('#heroTitle')?.textContent).toBe('Choose a time');
      expect(doc.querySelector('#card-promised')?.getAttribute('data-state')).toBe('unknown');
    } finally { ROUTES['/commitments?scope=mesh'] = old; }
  });

  it('keeps server coverage under agent status while preserving a known request', async () => {
    const doc = await boot('t', () => needs([instruction('Choose a time')], {
      complete: false, couldNotCheck: ['promises'],
    }));
    expect(doc.querySelector('#heroTitle')?.textContent).toBe('Choose a time');
    expect(doc.querySelector('#heroSub')?.textContent).not.toContain('promises');
    expect(doc.querySelector('#homeStatusNote')?.textContent).toContain('Could not check promises.');
  });

  it('does not rebuild a failed negotiated read from raw or previously displayed requests', async () => {
    let available = true;
    const doc = await boot('t', () => available ? needs([instruction('Choose a time')]) : null);
    expect(doc.querySelector('#heroTitle')?.textContent).toBe('Choose a time');
    available = false;
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    for (let i = 0; i < 15; i++) await flush();
    expect(doc.querySelector('#heroTitle')?.textContent).toContain("Couldn't check");
    expect(doc.querySelector('#homeNeedsStrip')?.textContent).not.toContain('Choose a time');
    expect(doc.querySelector('#homeNeedsStrip')?.textContent).not.toContain('Item 1');
  });

  it('a failing source says "Can\'t tell" on its own card; the others render', async () => {
    const doc = await boot('t');
    const allowed = doc.querySelector('#card-allowed')!;
    expect(allowed.getAttribute('data-state')).toBe('unknown');
    expect(allowed.querySelector('.card-value')!.textContent).toBe("Can't tell");
    expect(doc.querySelector('#card-doing')!.getAttribute('data-state')).toBe('ok');
  });

  it('expands and collapses the authoritative rows in place', async () => {
    const doc = await boot('t');
    const strip = doc.querySelector('#homeNeedsStrip')!;
    const rows = () => strip.querySelectorAll('.needs-row');
    const button = (words: RegExp) => [...strip.querySelectorAll('button')].find(b => words.test(b.textContent || ''));
    expect(rows()).toHaveLength(3);
    button(/Show all/)!.click();
    expect(rows()).toHaveLength(5);
    expect(strip.querySelector('.needs-groups')?.getAttribute('aria-label')).toBe('Requests that need you');
    button(/Show fewer/)!.click();
    expect(rows()).toHaveLength(3);
  });

  it('group pages link to their pages as ordinary links, with no iframe', async () => {
    const doc = await boot('t');
    dom.window.location.hash = '#/capacity';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    await flush();
    const tiles = [...doc.querySelectorAll('a.tile')].map((a) => a.getAttribute('href'));
    expect(tiles).toContain('#/capacity/health');
    expect(doc.querySelector('iframe')).toBeNull();
  });
});
