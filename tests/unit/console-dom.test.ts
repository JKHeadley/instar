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
  '/telegram/topics?scope=pool': { topics: [], pool: { failed: [], unresolved: [] } },
  '/pool': { machines: [{ machineId: 'm1', nickname: 'Mac Studio', isSelf: true, online: true, routerReceivedAt: NOW, loadAvg: 1, hardware: { cpuCores: 16 }, servesChannels: { telegram: { chatIds: ['-1003742343280'] } } }] },
  '/guards': null, // fails: the card must say it cannot tell
  '/mandate': { mandates: [] },
};

let dom: JSDOM;
const flush = () => new Promise((r) => setTimeout(r, 30));

async function boot(token: string | null) {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/home' });
  const g = globalThis as Record<string, unknown>;
  Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage });
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0);
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

  it('with a token it renders the headline and six cards', async () => {
    const doc = await boot('t');
    expect(doc.querySelectorAll('.card')).toHaveLength(6);
    expect(doc.querySelector('#heroTitle')!.textContent).toBe('Item 1');
  });

  it('links the one request directly and keeps a missing machine under status', async () => {
    const oldAttention = ROUTES['/attention?scope=pool'];
    ROUTES['/attention?scope=pool'] = { items: [{ id: 'approve-1', title: 'Approve the schedule change',
      status: 'OPEN', priority: 'URGENT', topicId: 127504, createdAt: NOW }],
      pool: { failed: [{ nickname: 'Laptop' }] } };
    try {
      const doc = await boot('t');
      const direct = doc.querySelector('#heroTitle a') as HTMLAnchorElement;
      expect(direct.textContent).toContain('Approve the schedule change');
      expect(direct.href).toBe('https://t.me/c/3742343280/127504');
      expect(doc.querySelector('#heroSub')!.textContent).not.toContain('Laptop');
      expect(doc.querySelector('#card-needs')!.textContent).not.toContain('Laptop');
      expect(doc.querySelector('.home-details summary')!.textContent).toContain('some checks incomplete');
      expect(doc.querySelector('#homeStatusNote')!.textContent).toContain("Couldn't reach Laptop");
    } finally { ROUTES['/attention?scope=pool'] = oldAttention; }
  });

  it('one tap on the named Home request opens its action sheet', async () => {
    const oldAttention = ROUTES['/attention?scope=pool'];
    const oldCommitments = ROUTES['/commitments?scope=mesh'];
    ROUTES['/attention?scope=pool'] = { items: [], pool: { failed: [] } };
    ROUTES['/commitments?scope=mesh'] = { enabled: true, scope: 'mesh', commitments: [{
      id: 'CMT-1043', status: 'pending', owner: 'user', blockedOn: 'user-authorization',
      createdAt: NOW, originMachineId: 'm1', userRequest: 'Approve rulebook changes',
      agentResponse: 'I will merge after approval.', topicId: 95267,
    }] };
    try {
      const doc = await boot('t');
      const link = doc.querySelector('#heroTitle a.hero-action') as HTMLAnchorElement;
      expect(link?.textContent).toBe('Approve rulebook changes');
      expect(link?.getAttribute('href')).toContain('id=CMT-1043');
      expect((doc.querySelector('#card-needs') as HTMLElement).hidden).toBe(true);
      expect((doc.querySelector('.home-details') as HTMLDetailsElement).open).toBe(false);
      dom.window.location.hash = link.getAttribute('href')!;
      for (let i = 0; i < 10; i++) await flush();
      expect(doc.querySelector('.sheet[role="dialog"]')?.textContent).toContain('Approve rulebook changes');
      expect(doc.querySelector('.sheet-actions a')?.textContent).toBe('Reply in the conversation');
    } finally {
      ROUTES['/attention?scope=pool'] = oldAttention;
      ROUTES['/commitments?scope=mesh'] = oldCommitments;
    }
  });

  it('keeps an Echo-owned missed promise out of the default headline', async () => {
    const oldAttention = ROUTES['/attention?scope=pool'];
    const oldCommitments = ROUTES['/commitments?scope=mesh'];
    ROUTES['/attention?scope=pool'] = { items: [], pool: { failed: [] } };
    ROUTES['/commitments?scope=mesh'] = { enabled: true, scope: 'mesh', commitments: [{
      id: 'CMT-MISS', status: 'violated', owner: 'agent', blockedOn: 'none', hardDeadlineAt: new Date(Date.parse(NOW) - 60_000).toISOString(),
      createdAt: NOW, originMachineId: 'm1', userRequest: 'Please change the schedule',
      agentResponse: 'Changing the schedule now', topicId: 95267,
    }] };
    try {
      const doc = await boot('t');
      expect(doc.querySelector('#heroTitle')?.textContent).not.toContain('Overdue');
      expect(doc.querySelector('#heroTitle a.hero-action')).toBeNull();
      expect((doc.querySelector('#heroIssueLink') as HTMLAnchorElement).hidden).toBe(true);
    } finally {
      ROUTES['/attention?scope=pool'] = oldAttention;
      ROUTES['/commitments?scope=mesh'] = oldCommitments;
    }
  });

  it('retries a failed promise read before declaring the action queue unknown', async () => {
    const oldAttention = ROUTES['/attention?scope=pool'];
    const oldCommitments = ROUTES['/commitments?scope=mesh'];
    ROUTES['/attention?scope=pool'] = { items: [], pool: { failed: [] } };
    let reads = 0;
    Object.defineProperty(ROUTES, '/commitments?scope=mesh', { configurable: true, get: () => ++reads === 1 ? null : {
      enabled: true, scope: 'mesh', commitments: [{ id: 'CMT-RETRY', status: 'pending', owner: 'user',
        blockedOn: 'user-input', createdAt: NOW, originMachineId: 'm1', userRequest: 'Choose a time' }],
    } });
    try {
      const doc = await boot('t');
      expect(reads).toBe(2);
      expect(doc.querySelector('#heroTitle')?.textContent).toBe('Choose a time');
      expect(doc.querySelector('#card-needs')?.textContent).not.toContain("Couldn't check for promises");
    } finally {
      ROUTES['/attention?scope=pool'] = oldAttention;
      Object.defineProperty(ROUTES, '/commitments?scope=mesh', { configurable: true, writable: true, value: oldCommitments });
    }
  });

  it('keeps retrying a promise read after several failures until the action arrives', async () => {
    const oldAttention = ROUTES['/attention?scope=pool'];
    const oldCommitments = ROUTES['/commitments?scope=mesh'];
    ROUTES['/attention?scope=pool'] = { items: [], pool: { failed: [] } };
    let reads = 0;
    Object.defineProperty(ROUTES, '/commitments?scope=mesh', { configurable: true, get: () => ++reads < 4 ? null : {
      enabled: true, scope: 'mesh', commitments: [{ id: 'CMT-LATE-ANSWER', status: 'pending', owner: 'user',
        blockedOn: 'user-input', createdAt: NOW, originMachineId: 'm1', userRequest: 'Choose a time' }],
    } });
    try {
      const doc = await boot('t');
      expect(doc.querySelector('#card-promised')?.textContent).toContain('Checking again automatically');
      for (let i = 0; i < 80 && reads < 4; i++) await flush();
      expect(reads).toBe(4);
      expect(doc.querySelector('#heroTitle')?.textContent).toBe('Choose a time');
    } finally {
      ROUTES['/attention?scope=pool'] = oldAttention;
      Object.defineProperty(ROUTES, '/commitments?scope=mesh', { configurable: true, writable: true, value: oldCommitments });
    }
  });

  it('retries a partial attention answer when a machine did not answer', async () => {
    const oldAttention = ROUTES['/attention?scope=pool'];
    let reads = 0;
    Object.defineProperty(ROUTES, '/attention?scope=pool', { configurable: true, get: () => ({
      items: [], pool: { failed: ++reads === 1 ? [{ machineId: 'm2' }] : [] },
    }) });
    try {
      const doc = await boot('t');
      for (let i = 0; i < 20 && reads < 2; i++) await flush();
      expect(reads).toBe(2);
      expect(doc.querySelector('#card-needs')?.textContent).not.toContain('Checking again automatically');
    } finally {
      Object.defineProperty(ROUTES, '/attention?scope=pool', { configurable: true, writable: true, value: oldAttention });
    }
  });

  it('keeps the last promise result in the action queue after two failed refresh reads', async () => {
    const oldAttention = ROUTES['/attention?scope=pool'];
    const oldCommitments = ROUTES['/commitments?scope=mesh'];
    ROUTES['/attention?scope=pool'] = { items: [], pool: { failed: [] } };
    ROUTES['/commitments?scope=mesh'] = { enabled: true, scope: 'mesh', commitments: [{
      id: 'CMT-LAST', status: 'pending', owner: 'user', blockedOn: 'user-input',
      createdAt: NOW, originMachineId: 'm1', userRequest: 'Choose a time',
    }] };
    try {
      const doc = await boot('t');
      expect(doc.querySelector('#heroTitle')?.textContent).toBe('Choose a time');
      ROUTES['/commitments?scope=mesh'] = null;
      dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
      for (let i = 0; i < 15; i++) await flush();
      expect(doc.querySelector('#heroTitle')?.textContent).toBe('Choose a time');
      expect(doc.querySelector('#card-needs')?.textContent).not.toContain('last successful check');
      expect(doc.querySelector('#homeStatusNote')?.textContent).toContain('last successful check');
      expect(doc.querySelector('#card-promised')?.textContent).toContain('Showing what I saw');
    } finally {
      ROUTES['/attention?scope=pool'] = oldAttention;
      ROUTES['/commitments?scope=mesh'] = oldCommitments;
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

  it('group pages link to legacy tabs as ordinary links, with no iframe', async () => {
    const doc = await boot('t');
    dom.window.location.hash = '#/work';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    await flush();
    const tiles = [...doc.querySelectorAll('a.tile')].map((a) => a.getAttribute('href'));
    expect(tiles).toContain('/dashboard?tab=dropzone');
    expect(doc.querySelector('iframe')).toBeNull();
  });
});
