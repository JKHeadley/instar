/**
 * Console "Passwords & keys" page (docs/specs/console-features/people-settings.md,
 * "Passwords & keys", legacy tab `secrets`): every decision in the model on both sides
 * (waiting / expiring soon / expired, a failed request list is "can't tell" and never
 * "nothing waiting", key names only, the vault decrypt-failed hands-off line, sync on /
 * off / unreachable machines, the exact POST /secrets/request body), and the shipped
 * console in jsdom: the cards, the key names (never a value, never a length), a create
 * through the Ask sheet with no PIN anywhere, and a cancel through its confirm.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  leftWords, agoWords, topicNameMap, conversationWords, conversationChoices, dropLink, requestCard, buildRequests,
  buildKeys, buildSync, vaultBroken, secretsHeadline, secretsFacts, requestBody, testRequestBody, resultWords, shareWords,
  TTL_CHOICES, VAULT_BROKEN_WORDS,
} from '../../dashboard/console/secrets-model.js';
import { NATIVE_PAGES, tabHref, GROUPS } from '../../dashboard/console/nav-model.js';

const NOW = Date.parse('2026-10-25T18:00:00Z');
const ok = (data: unknown) => ({ ok: true, status: 200, data });
const off = () => ({ ok: false, status: 503, reason: 'switched off on this agent' });
const fail = (reason = 'the server answered 500') => ({ ok: false, status: 500, reason });
const pend = (over: Record<string, unknown> = {}) => ({ token: 'tok1', label: 'OpenAI API key', topicId: 52075, createdAt: NOW - 4 * 60_000, expiresAt: NOW + 11 * 60_000, expired: false, localUrl: '/secrets/drop/tok1', tunnelUrl: 'https://x.trycloudflare.com/secrets/drop/tok1', ...over });
const names = { '52075': 'Instar 2.0' };

describe('request words and grouping', () => {
  it('time left and ago read plainly; zero or less is expired', () => {
    expect(leftWords(11 * 60_000 + 5_000)).toBe('11 min left');
    expect(leftWords(45_000)).toBe('45 s left');
    expect(leftWords(65 * 60_000)).toBe('1 h 5 min left');
    expect(leftWords(60 * 60_000)).toBe('1 h left');
    expect(leftWords(0)).toBe('expired');
    expect(leftWords(Number.NaN)).toBe('expired');
    expect(agoWords(NOW - 30_000, NOW)).toBe('just now');
    expect(agoWords(NOW - 4 * 60_000, NOW)).toBe('4 min ago');
    expect(agoWords(NOW - 26 * 3600_000, NOW)).toBe('1 day ago');
  });
  it('a conversation reads by its name, else by its number; no topic is none', () => {
    const map = topicNameMap(ok({ topics: [{ topicId: 52075, sessionName: 's', topicName: 'Instar 2.0' }, { topicId: 9, sessionName: 's2', topicName: null }] }));
    expect(map).toEqual({ '52075': 'Instar 2.0' });
    expect(topicNameMap(fail())).toEqual({});
    expect(conversationWords(52075, map)).toBe('Instar 2.0');
    expect(conversationWords(9, map)).toBe('conversation 9');
    expect(conversationWords(undefined, map)).toBe('');
    expect(conversationChoices({ '2': 'b', '1': 'a' })).toEqual([{ value: '1', label: 'a' }, { value: '2', label: 'b' }]);
  });
  it('the link: the tunnel when there is one, else the local path on this origin; anything else is refused', () => {
    expect(dropLink(pend(), 'http://localhost:4040')).toEqual({ url: 'https://x.trycloudflare.com/secrets/drop/tok1', remote: true });
    expect(dropLink(pend({ tunnelUrl: null }), 'http://localhost:4040/')).toEqual({ url: 'http://localhost:4040/secrets/drop/tok1', remote: false });
    expect(dropLink(pend({ tunnelUrl: 'javascript:alert(1)', localUrl: 'javascript:alert(1)' }), 'http://x')).toBeNull();
    expect(dropLink(pend({ tunnelUrl: null, localUrl: '/secrets/drop/../../x' }), 'http://x')).toBeNull();
  });
  it('waiting soonest first, expiring within 5 min flagged, expired apart; a server-expired flag wins', () => {
    const r = buildRequests(ok({ pending: [pend(), pend({ token: 'tok2', label: 'GitHub token', expiresAt: NOW + 3 * 60_000 }), pend({ token: 'tok3', expiresAt: NOW - 60_000, expired: true }), pend({ token: 'tok4', expiresAt: NOW + 60_000, expired: true }), { label: 'no token' }] }), { names, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.waiting.map((c) => c.token)).toEqual(['tok2', 'tok1']);
    expect(r.waiting[0].soon).toBe(true);
    expect(r.waiting[1].soon).toBe(false);
    expect(r.expired.map((c) => c.token)).toEqual(['tok4', 'tok3']);
    expect(r.counts).toEqual({ waiting: 2, soon: 1, expired: 2 });
    expect(r.waiting[1].sub).toBe('for “Instar 2.0” · 11 min left');
    expect(requestCard(pend({ topicId: undefined, label: '' }), { now: NOW }).sub).toBe('no conversation named · 11 min left');
    expect(requestCard(pend({ topicId: undefined, label: '' }), { now: NOW }).label).toBe('A password or key');
  });
  it('a failed or shapeless list is can’t tell — never an empty “nothing waiting”', () => {
    const f = buildRequests(fail('no answer within 8 seconds'));
    expect(f).toEqual({ ok: false, reason: 'Can’t tell what the agent is waiting for: no answer within 8 seconds.' });
    expect(buildRequests(ok({})).ok).toBe(false);
    expect(secretsHeadline({ requests: f, keys: { ok: true, names: [] }, sync: { on: false, hidden: true } })).toEqual({ text: 'Can’t tell whether the agent is waiting on a password.', tone: 'muted' });
    expect(secretsFacts({ requests: f, keys: { ok: true, names: [] }, sync: { on: false, hidden: true } })[0]).toEqual({ n: '?', label: 'waiting' });
  });
});

describe('keys held, the vault, and sync', () => {
  it('key names only, sorted and de-duplicated; nothing else from the answer is kept', () => {
    const k = buildKeys(ok({ names: ['github_token', 'anthropic_api_key', 'github_token', '', 7], factCount: 3, vaultState: 'ok', block: 'secret block text' }), off());
    expect(k).toEqual({ ok: true, names: ['anthropic_api_key', 'github_token'], source: 'vault', empty: false });
    expect(JSON.stringify(k)).not.toContain('secret block text');
    expect(buildKeys(ok({ names: [], vaultState: 'absent' }), off())).toMatchObject({ ok: true, names: [], empty: true });
  });
  it('a switched-off key list falls back to the sync record’s names; with neither it is can’t tell with the reason', () => {
    expect(buildKeys(off(), ok({ localKeyPaths: ['telegram.token'] }))).toEqual({ ok: true, names: ['telegram.token'], source: 'sync' });
    expect(buildKeys(off(), off())).toMatchObject({ ok: false, decryptFailed: false, reason: 'Can’t tell which keys I hold: that list is switched off on this agent.' });
    expect(buildKeys(fail(), off())).toMatchObject({ ok: false, reason: 'Can’t tell which keys I hold: the server answered 500.' });
  });
  it('decrypt-failed from either source is the hands-off red line, and leads the headline', () => {
    const k = buildKeys(ok({ names: [], vaultState: 'decrypt-failed' }), off());
    expect(k).toMatchObject({ ok: false, decryptFailed: true });
    const s = buildSync(ok({ enabled: true, pushEnabled: false, mode: 'receive-only', localKeyPaths: [], vault: { status: 'decrypt-failed' }, syncTargets: [] }), null);
    expect(vaultBroken(k, { on: false, hidden: true })).toBe(true);
    expect(vaultBroken({ ok: true, names: [] }, s)).toBe(true);
    expect(vaultBroken({ ok: true, names: [] }, { on: false, hidden: true })).toBe(false);
    const requests = buildRequests(ok({ pending: [pend()] }), { now: NOW });
    expect(secretsHeadline({ requests, keys: k, sync: s })).toEqual({ text: VAULT_BROKEN_WORDS, tone: 'bad' });
    expect(VAULT_BROKEN_WORDS).toBe('I can’t open my saved keys on this machine — don’t change anything; tell me.');
  });
  it('sync: 503 hides it; a sending machine names its targets and the registered machines it can’t reach; a receiver says so', () => {
    expect(buildSync(off(), null)).toEqual({ on: false, hidden: true });
    expect(buildSync(fail(), null)).toMatchObject({ on: false, hidden: false });
    const pool = ok({ selfMachineId: 'm-self', machines: [{ machineId: 'm-self' }, { machineId: 'm-mini', nickname: 'Mac Mini' }, { machineId: 'm-pc', nickname: 'Mama PC' }] });
    const send = buildSync(ok({ enabled: true, pushEnabled: true, mode: 'full', localKeyPaths: [], syncTargets: [{ machineId: 'm-mini', nickname: 'Mac Mini' }] }), pool);
    expect(send).toMatchObject({ on: true, push: true, count: 1, words: 'Sends my keys to Mac Mini.', unreachableWords: 'Not reachable now: Mama PC. It gets keys when back.' });
    const two = buildSync(ok({ mode: 'full', syncTargets: [{ machineId: 'a', nickname: 'A' }, { machineId: 'b', nickname: 'B' }] }), null);
    expect(two.words).toBe('Sends my keys to 2 machines (A and B).');
    expect(buildSync(ok({ mode: 'full', syncTargets: [] }), null).words).toBe('Sends my keys to other machines, but none is reachable right now.');
    const recv = buildSync(ok({ mode: 'receive-only', pushEnabled: false, syncTargets: [{ machineId: 'm-mini' }] }), null);
    expect(recv.words).toBe('Receives keys from my other machines; this one does not send.');
    expect(secretsFacts({ requests: buildRequests(ok({ pending: [] }), { now: NOW }), keys: { ok: true, names: ['a'] }, sync: recv })).toEqual([
      { n: 0, label: 'waiting', tone: null }, { n: 1, label: 'key held' }, { n: 1, label: 'receiving from others' },
    ]);
  });
  it('headline and facts on both sides: nothing waiting, one waiting with one expiring soon', () => {
    const none = buildRequests(ok({ pending: [] }), { now: NOW });
    expect(secretsHeadline({ requests: none, keys: { ok: true, names: [] }, sync: { on: false, hidden: true } })).toEqual({ text: 'Nothing is waiting.', tone: 'ok' });
    const one = buildRequests(ok({ pending: [pend({ expiresAt: NOW + 2 * 60_000 })] }), { now: NOW });
    expect(secretsHeadline({ requests: one, keys: { ok: true, names: [] }, sync: { on: false, hidden: true } })).toEqual({ text: 'The agent is waiting on 1 password.', tone: 'attn' });
    expect(secretsFacts({ requests: one, keys: { ok: true, names: ['a', 'b'] }, sync: { on: false, hidden: true } })).toEqual([
      { n: 1, label: 'waiting', tone: 'attn' }, { n: 1, label: 'expiring within 5 min', tone: 'attn' }, { n: 2, label: 'keys held' },
    ]);
  });
});

describe('the request body and the server’s answer', () => {
  it('POST /secrets/request: label required, note and conversation optional, only the offered windows', () => {
    expect(requestBody({ label: ' OpenAI API key ', note: '', topicId: '52075', ttlMs: String(TTL_CHOICES[0].ms) })).toEqual({ ok: true, body: { label: 'OpenAI API key', ttlMs: 900_000, topicId: 52075 } });
    expect(requestBody({ label: 'x', note: 'for the eval job', topicId: '', ttlMs: '3600000' })).toEqual({ ok: true, body: { label: 'x', ttlMs: 3_600_000, description: 'for the eval job' } });
    const bad = requestBody({ label: '', note: 'n'.repeat(2000), topicId: 'abc', ttlMs: '42' });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems).toHaveLength(4);
    expect(JSON.stringify(requestBody({ label: 'x', ttlMs: '900000' }))).not.toContain('pin');
    expect(testRequestBody()).toEqual({ label: 'Test link from the console', description: 'Created from the console to try the secure drop. Safe to cancel.', ttlMs: 300_000 });
  });
  it('answers in words, per status', () => {
    expect(resultWords('create', 201, { token: 't' })).toEqual({ ok: true, text: 'Link ready. It works once, then it is gone.' });
    expect(resultWords('create', 429, { error: 'Too many pending requests' }).text).toBe('Not created: Too many pending requests. Cancel one first.');
    expect(resultWords('create', 400, { error: '"label" must be a non-empty string under 256 characters' }).ok).toBe(false);
    expect(resultWords('create', 0, {}).text).toBe('The server could not be reached. Nothing was sent.');
    expect(resultWords('cancel', 200, { ok: true })).toEqual({ ok: true, text: 'Cancelled. The link no longer works.' });
    expect(resultWords('cancel', 404, {})).toMatchObject({ ok: false, gone: true });
    expect(resultWords('cancel', 500, {}).ok).toBe(false);
    expect(shareWords('copied')).toBe('Copied.');
    expect(shareWords('cancelled')).toBe('');
    expect(shareWords('failed')).toMatch(/press and hold/);
  });
  it('the tile flips to the native page under its new name; the legacy id stays', () => {
    expect(NATIVE_PAGES.secrets).toBe('#/people/secrets');
    expect(tabHref('secrets')).toBe('#/people/secrets');
    expect(GROUPS.find((g) => g.id === 'people')!.tabs.find((t) => t.id === 'secrets')!.label).toBe('Passwords & keys');
  });
});

describe('passwords & keys in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());

  it('boots the shipped console: cards with live countdowns, key names only, a create with no PIN, and a confirmed cancel', async () => {
    const writes: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/people/secrets' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    const now = Date.now();
    let pending = [pend({ createdAt: now - 4 * 60_000, expiresAt: now + 11 * 60_000 + 30_000 }), pend({ token: 'tok9', label: 'Old key', expiresAt: now - 3600_000, expired: true })];
    const table: Record<string, { status?: number; body: () => unknown }> = {
      '/sessions': { body: () => ({ sessions: [] }) },
      '/secrets/pending': { body: () => ({ pending }) },
      '/self-knowledge/session-context?full=1': { body: () => ({ names: ['openai_api_key', 'github_token'], factCount: 1, vaultState: 'ok', block: 'VALUE-SHOULD-NEVER-RENDER sk-live-123' }) },
      '/secrets/sync-status': { status: 503, body: () => ({ error: 'secret-sync not available' }) },
      '/telegram/topics': { body: () => ({ topics: [{ topicId: 52075, sessionName: 's', topicName: 'Instar 2.0' }] }) },
      '/pool': { body: () => ({ enabled: false, machines: [] }) },
    };
    g.fetch = async (url: string, opts?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const method = (opts && opts.method) || 'GET';
      if (method !== 'GET') {
        writes.push({ method, url, body: opts && opts.body ? JSON.parse(opts.body) : null });
        if (method === 'POST' && url === '/secrets/request') {
          pending = [...pending, pend({ token: 'tok2', label: 'Stripe key', topicId: 52075, createdAt: Date.now(), expiresAt: Date.now() + 900_000, tunnelUrl: null, localUrl: '/secrets/drop/tok2' })];
          return { ok: true, status: 201, json: async () => ({ token: 'tok2', localUrl: '/secrets/drop/tok2', tunnelUrl: null, expiresIn: 900_000 }) };
        }
        if (method === 'DELETE') { pending = pending.filter((p) => !url.endsWith(p.token)); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
      }
      const hit = table[url];
      if (!hit) return { ok: false, status: 404, json: async () => ({ error: 'no such route in the test' }) };
      const status = hit.status || 200;
      return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(hit.body())) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 20));
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('The agent is waiting on 1 password.');
    expect([...doc.querySelectorAll('.fact')].map((f) => f.textContent)).toEqual(['1waiting', '2keys held']);
    expect(doc.querySelector('#sec-sync')).toBeNull(); // sync is off: no section, no false claim
    const cards = doc.querySelectorAll('.secret-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector('.secret-label')!.textContent).toBe('OpenAI API key');
    expect(cards[0].querySelector('.need-sub')!.textContent).toBe('for “Instar 2.0” · 11 min left');
    expect(cards[0].querySelector('a[data-open]')!.getAttribute('href')).toBe('https://x.trycloudflare.com/secrets/drop/tok1');
    expect(cards[0].querySelector('a[data-open]')!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(doc.querySelector('#sec-expired .list-count')!.textContent).toBe('1');
    expect(doc.querySelector('#sec-expired .list-rows')!.hasAttribute('hidden')).toBe(true);
    // Keys: names only, collapsed by default; no value, no length anywhere on the page.
    const fold = doc.querySelector('#sec-keys') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')!.textContent).toBe('Keys I already hold (2)');
    expect([...fold.querySelectorAll('.key-names li')].map((n) => n.textContent)).toEqual(['github_token', 'openai_api_key']);
    expect(doc.body.textContent).not.toContain('VALUE-SHOULD-NEVER-RENDER');
    expect(doc.body.textContent).not.toContain('sk-live');
    expect(doc.body.innerHTML).not.toMatch(/length/i);

    // Ask someone for one → a real POST, no PIN sheet, then the share card.
    (doc.querySelector('button[data-ask]') as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet .sheet-title')!.textContent).toBe('Ask someone for one');
    expect([...doc.querySelectorAll('.sheet select[aria-label="Which conversation hears when it arrives"] option')].map((o) => o.textContent)).toEqual(['No conversation', 'Instar 2.0']);
    (doc.querySelector('.sheet button[data-create]') as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet .action-status')!.textContent).toMatch(/^Say what it is/);
    expect(writes).toHaveLength(0);
    (doc.querySelector('.sheet input[aria-label="What is it?"]') as HTMLInputElement).value = 'Stripe key';
    (doc.querySelector('.sheet select[aria-label="Which conversation hears when it arrives"]') as HTMLSelectElement).value = '52075';
    (doc.querySelector('.sheet button[data-create]') as HTMLButtonElement).click();
    for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 20));
    expect(writes).toEqual([{ method: 'POST', url: '/secrets/request', body: { label: 'Stripe key', ttlMs: 900_000, topicId: 52075 } }]);
    expect(doc.querySelector('.pin-input')).toBeNull();
    expect(doc.querySelector('.sheet .sheet-title')!.textContent).toBe('Link ready');
    expect(doc.querySelector('.sheet a[data-open]')!.getAttribute('href')).toBe('http://localhost:4040/secrets/drop/tok2');
    expect(doc.querySelector('.sheet')!.textContent).toContain('This link only works on this machine’s network');
    expect(doc.querySelectorAll('.secrets-page .secret-card')).toHaveLength(2); // the page refreshed underneath

    // Cancel: in the "…" sheet, quiet, with a one-line confirm.
    (doc.querySelector('.secrets-page button[data-more="tok1"]') as HTMLButtonElement).click();
    (doc.querySelector('.sheet button[data-cancel="tok1"]') as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet .confirm-text')!.textContent).toBe('The link stops working.');
    (doc.querySelector('.sheet button[data-cancel-confirm="tok1"]') as HTMLButtonElement).click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 20));
    expect(writes[1]).toEqual({ method: 'DELETE', url: '/secrets/pending/tok1', body: null });
    expect(doc.querySelector('.sheet .sheet-danger .action-status')!.textContent).toBe('Cancelled. The link no longer works.');
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 20));
    expect(doc.querySelector('.sheet')).toBeNull();
    expect(doc.querySelector('.page-title')!.textContent).toBe('The agent is waiting on 1 password.');
    expect([...doc.querySelectorAll('.secret-label')].map((n) => n.textContent)).toEqual(['Stripe key']);
    expect(writes).toHaveLength(2);
  });
});
