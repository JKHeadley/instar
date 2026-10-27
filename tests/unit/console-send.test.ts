/**
 * Console "Paste to a session" (docs/specs/console-features/work.md, "Send content",
 * legacy tab `dropzone`, now inside Sessions): every decision in send-model.js on both
 * sides (the counts, the targets with the most recent preselected and named, the exact
 * POST /pastes body, delivered / waiting / failed with the text kept, the recent list,
 * the delete confirm and its answer, live paste events, typing into another machine's
 * session and that machine's answer), and the shipped console in jsdom: the sheet from
 * the list and from an open session, a send, a live delivery event, a delete asked once,
 * and a typed-in paste to another machine — no PIN anywhere.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  countWords, keptWords, pasteTargets, targetWords, pasteBody, pasteResultWords, statusWords, buildRecent, recentHead,
  DELETE_CONFIRM, deleteResultWords, pasteEvent, typeResultWords, RECENT_MAX,
} from '../../dashboard/console/send-model.js';
import { NATIVE_PAGES, tabHref, GROUPS } from '../../dashboard/console/nav-model.js';

const NOW = Date.parse('2026-10-26T18:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const row = (over: Record<string, unknown> = {}, sess: Record<string, unknown> = {}) => ({
  key: 'echo-fix', title: 'Bug: login loop', ...over,
  session: { tmuxSession: 'echo-fix', name: 'echo-fix', remote: false, type: 'interactive', machineNickname: 'Mac Studio', telemetry: { lastActivity: iso(NOW - 60_000) }, startedAt: iso(NOW - 3600_000), ...sess },
});

describe('send model', () => {
  it('counts characters and tokens; nothing pasted says so', () => {
    expect(countWords('')).toBe('Nothing pasted yet.');
    expect(countWords('x'.repeat(12_400))).toBe('12,400 characters, about 3,100 tokens');
    expect(countWords('a')).toBe('1 character, about 1 token');
    expect(keptWords(7)).toBe('Kept on this machine for 7 days. Don’t paste passwords or keys.');
    expect(keptWords(undefined)).toMatch(/7 days/);
    expect(keptWords(1)).toMatch(/1 day\./);
  });

  it('targets: this machine first, most recent preselected and named; jobs never; another machine typed in', () => {
    const older = row({ key: 'old', title: 'Topic 127504' }, { tmuxSession: 'old', name: 'old', telemetry: { lastActivity: iso(NOW - 30 * 60_000) } });
    const job = row({ key: 'job', title: 'digest' }, { tmuxSession: 'job', name: 'job', type: 'job', telemetry: { lastActivity: iso(NOW) } });
    const remote = row({ key: 'remote:m-mini:r', title: 'Feedback drain' }, { tmuxSession: 'r', name: 'r', remote: true, machineId: 'm-mini', machineNickname: 'Mac Mini', telemetry: { lastActivity: iso(NOW) } });
    const t = pasteTargets([older, job, remote, row()], { now: NOW });
    expect(t.choices.map((c) => [c.value, c.kind, c.label])).toEqual([
      ['echo-fix', 'paste', 'Bug: login loop, active 1 min ago'],
      ['old', 'paste', 'Topic 127504, active 30 min ago'],
      ['remote:m-mini:r', 'type', 'Feedback drain, on Mac Mini (typed in)'],
    ]);
    expect(t.value).toBe('echo-fix');
    expect(targetWords(t.choices[0])).toBe('Goes to Bug: login loop.');
    expect(targetWords(t.choices[2])).toMatch(/^Mac Mini is another machine, so a stored paste can’t reach it\. This is typed in like a message: it is not kept as a paste\.$/);
    // Nothing running here: the one stored choice keeps it for the next session.
    const none = pasteTargets([remote], { now: NOW });
    expect(none.choices[0]).toMatchObject({ value: '__next__', kind: 'next' });
    expect(none.value).toBe('__next__');
    expect(targetWords(none.choices[0])).toMatch(/delivered when one starts/);
    expect(pasteTargets([], { now: NOW }).choices.map((c) => c.kind)).toEqual(['next']);
    // Fixed to one session (from its ⋯ menu), or gone.
    expect(pasteTargets([older, row()], { now: NOW, fixedKey: 'old' })).toMatchObject({ fixed: true, value: 'old', choices: [{ value: 'old' }] });
    expect(pasteTargets([row()], { now: NOW, fixedKey: 'gone' })).toEqual({ fixed: true, value: null, choices: [] });
    expect(targetWords(null)).toBe('That session is not running any more.');
  });

  it('the body: text required, label bounded, the named session, none for "next", never for a typed target', () => {
    const t = pasteTargets([row()], { now: NOW });
    expect(pasteBody({ text: '  ', label: '', choice: t.choices[0] })).toEqual({ ok: false, problems: ['Paste some text first.'] });
    expect(pasteBody({ text: 'log', label: 'x'.repeat(257), choice: t.choices[0] }).ok).toBe(false);
    expect(pasteBody({ text: 'log', label: '', choice: null })).toEqual({ ok: false, problems: ['Pick a session.'] });
    expect(pasteBody({ text: 'a log\n', label: ' build log ', choice: t.choices[0] })).toEqual({ ok: true, body: { content: 'a log\n', label: 'build log', targetSession: 'echo-fix' } });
    expect(pasteBody({ text: 'a', label: '', choice: { value: '__next__', kind: 'next', row: null } })).toEqual({ ok: true, body: { content: 'a' } });
    const typed = pasteTargets([row({ key: 'r' }, { remote: true, machineNickname: 'Mac Mini' })], { now: NOW }).choices.find((c) => c.kind === 'type');
    expect(pasteBody({ text: 'a', label: '', choice: typed }).ok).toBe(false);
  });

  it('the answer: delivered names the session, waiting is amber, failed keeps the text', () => {
    const titleOf = (n: string) => (n === 'echo-fix' ? 'Bug: login loop' : null);
    expect(pasteResultWords(201, { ok: true, pasteId: 'p1', status: 'notified', sessionName: 'echo-fix', contentLength: 12400 }, { titleOf })).toEqual({ state: 'delivered', tone: 'ok', pasteId: 'p1', text: 'Delivered 12,400 characters to Bug: login loop.' });
    expect(pasteResultWords(201, { ok: true, pasteId: 'p2', status: 'written', contentLength: 5 })).toMatchObject({ state: 'waiting', tone: 'attn', text: 'No session was ready; the 5 characters will be delivered when one starts. It stays in Recent pastes until then.' });
    expect(pasteResultWords(413, { ok: false, error: 'too_large', message: 'Paste exceeds 10MB limit' })).toEqual({ state: 'failed', tone: 'bad', text: 'Not sent: Paste exceeds 10MB limit. Your text is still here.' });
    expect(pasteResultWords(503, { error: 'Paste system not available' }).text).toMatch(/switched off on this agent/);
    expect(pasteResultWords(429, {}).text).toMatch(/too many pastes/);
    expect(pasteResultWords(0, {}).text).toMatch(/could not be reached/);
    expect(pasteResultWords(500, {}).text).toBe('Not sent: the server answered 500. Your text is still here.');
  });

  it('statuses in words; recent is newest first, capped at 20, this machine only; a failed read is can’t tell', () => {
    expect(statusWords('notified').text).toBe('delivered');
    expect(statusWords('acknowledged').text).toBe('read by the session');
    expect(statusWords('written')).toEqual({ text: 'waiting for a session', tone: 'attn' });
    expect(statusWords('odd').text).toBe('status unknown (odd)');
    const pastes = Array.from({ length: 23 }, (_, i) => ({ pasteId: `p${i}`, label: i === 22 ? 'build log' : undefined, timestamp: iso(NOW - (23 - i) * 60_000), status: i === 22 ? 'written' : 'notified', contentLength: 1200, targetSession: i === 22 ? 'echo-fix' : undefined }));
    const m = buildRecent({ ok: true, data: { ok: true, pastes, stats: { retentionDays: 7 } } }, { now: NOW });
    expect(m.ok && m.rows).toHaveLength(RECENT_MAX);
    expect(m.ok && m.rows[0]).toEqual({ id: 'p22', title: 'build log', status: 'waiting for a session', tone: 'attn', sub: '1,200 characters · 1 min ago · waiting for a session · for echo-fix' });
    expect(m.ok && m.rows[1].title).toBe('No label');
    expect(recentHead(m)).toEqual({ title: 'Recent pastes (23)', sub: '23 in the last 7 days, on this machine only · 1 waiting · newest 20 shown.' });
    expect(recentHead(buildRecent({ ok: true, data: { pastes: [], stats: { retentionDays: 7 } } }))).toEqual({ title: 'Recent pastes (0)', sub: 'None in the last 7 days, on this machine.' });
    const bad = buildRecent({ ok: false, reason: 'switched off on this agent' });
    expect(bad).toEqual({ ok: false, reason: 'Can’t list recent pastes: switched off on this agent.' });
    expect(recentHead(bad)).toEqual({ title: 'Recent pastes', sub: 'Can’t list recent pastes: switched off on this agent.' });
    expect(buildRecent({ ok: true, data: {} }).ok).toBe(false);
  });

  it('delete asks once and reads the answer; live events name the paste', () => {
    expect(DELETE_CONFIRM).toBe('Delete this paste? The session keeps what it already read.');
    expect(deleteResultWords(200, { ok: true, deleted: true })).toEqual({ ok: true, text: 'Deleted.' });
    expect(deleteResultWords(404, {})).toEqual({ ok: true, gone: true, text: 'Already gone.' });
    expect(deleteResultWords(500, { message: 'disk' })).toEqual({ ok: false, text: 'Not deleted: disk.' });
    expect(deleteResultWords(0, {}).ok).toBe(false);
    expect(pasteEvent({ type: 'paste_delivered', pasteId: 'p1', session: 'echo-fix', contentLength: 40 }, { titleOf: () => 'Bug: login loop' })).toEqual({ pasteId: 'p1', state: 'delivered', tone: 'ok', text: 'Delivered 40 characters to Bug: login loop.' });
    expect(pasteEvent({ type: 'paste_acknowledged', pasteId: 'p1', session: 'echo-fix' })!.text).toBe('echo-fix has read it.');
    expect(pasteEvent({ type: 'output' })).toBeNull();
  });

  it('typing into another machine: sent, refused, gone, unknown — never claimed without an answer', () => {
    expect(typeResultWords({ ack: true }, 'Mac Mini')).toMatchObject({ ok: true, text: 'Typed into the session on Mac Mini.' });
    expect(typeResultWords({ code: 'input-not-allowed' }, 'Mac Mini').text).toBe('Mac Mini doesn’t accept typing from other machines. Your text is still here.');
    expect(typeResultWords({ code: 'session-not-found' }, 'Mac Mini').ok).toBe(false);
    expect(typeResultWords({ ack: false }, 'Mac Mini').ok).toBe(false);
    expect(typeResultWords({ timeout: true }, 'Mac Mini')).toMatchObject({ ok: false, tone: 'unknown' });
    expect(typeResultWords({ code: 'not-connected' }, 'Mac Mini').text).toMatch(/live updates are paused/);
  });

  it('the Send content tile opens the paste sheet inside Sessions, and says text only', () => {
    expect(NATIVE_PAGES.dropzone).toBe('#/work/sessions?paste=1');
    expect(tabHref('dropzone')).toBe('#/work/sessions?paste=1');
    const tile = GROUPS.find((g) => g.id === 'work')!.tabs.find((t) => t.id === 'dropzone')!;
    expect(tile.desc).not.toMatch(/files/);
    expect(tile.desc).toMatch(/Sessions/);
  });
});

describe('paste in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());

  it('boots the shipped console: the sheet from the list and from ⋯, a send, a live delivery, a delete asked once, a typed-in paste to another machine', async () => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/work/sessions?paste=1' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    const now = Date.now();
    const sockets: FakeWS[] = [];
    class FakeWS {
      readyState = 0; sent: Record<string, unknown>[] = []; onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: string }) => void; url: string;
      constructor(url: string) { this.url = url; sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 0); }
      send(s: string) { this.sent.push(JSON.parse(s)); }
      close() { this.readyState = 3; }
      push(m: unknown) { this.onmessage && this.onmessage({ data: JSON.stringify(m) }); }
    }
    g.WebSocket = FakeWS;
    (dom.window as unknown as Record<string, unknown>).Terminal = class { buffer = { active: { baseY: 0, viewportY: 0 } }; loadAddon() {} open() {} onScroll() {} clear() {} write() {} scrollToBottom() {} dispose() {} };
    (dom.window as unknown as Record<string, unknown>).FitAddon = { FitAddon: class { fit() {} } };
    const s = (over: Record<string, unknown>) => ({ id: 'u1', name: 'echo-fix', tmuxSession: 'echo-fix', status: 'running', startedAt: iso(now - 40 * 60_000), model: 'claude-opus-5-5', platform: 'telegram', platformId: 1, platformName: 'Bug: login loop', protected: false, machineId: 'm-studio', telemetry: { lastActivity: iso(now - 60_000) }, ...over });
    const list = [
      s({}),
      s({ id: 'u2', name: 'older', tmuxSession: 'older', platformName: 'Topic 127504', platformId: 2, telemetry: { lastActivity: iso(now - 5 * 60_000) } }),
      s({ id: 'u3', name: 'drain', tmuxSession: 'drain', platformName: 'Feedback drain', platformId: 3, remote: true, machineId: 'm-mini', machineNickname: 'Mac Mini', telemetry: { lastActivity: iso(now - 2 * 60_000) } }),
    ];
    let pastes: Array<Record<string, unknown>> = [{ pasteId: 'p-old', label: 'old log', timestamp: iso(now - 3600_000), status: 'notified', contentLength: 900 }];
    const writes: Array<{ method: string; url: string; body: Record<string, unknown> | null; headers: Record<string, string> }> = [];
    g.fetch = async (url: string, opts?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const method = (opts && opts.method) || 'GET';
      const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(body)) });
      if (method !== 'GET') writes.push({ method, url, body: opts && opts.body ? JSON.parse(opts.body) : null, headers: (opts && opts.headers) || {} });
      if (url === '/sessions') return json(200, list);
      if (url === '/sessions?scope=pool') return json(200, { sessions: list, pool: { enabled: true, selfMachineId: 'm-studio', selfMachineNickname: 'Mac Studio', machines: [{ machineId: 'm-studio', nickname: 'Mac Studio', sessionCount: 2 }, { machineId: 'm-mini', nickname: 'Mac Mini', sessionCount: 1 }], failed: [], duplicateTopics: [] } });
      if (url === '/pastes' && method === 'GET') return json(200, { ok: true, pastes, stats: { retentionDays: 7 } });
      if (url === '/pastes' && method === 'POST') {
        const b = JSON.parse(opts!.body!);
        if (pastes.length >= 2) return json(413, { ok: false, error: 'too_large', message: 'Paste exceeds 10MB limit' });
        pastes = [{ pasteId: 'p-new', label: b.label, timestamp: iso(Date.now()), status: 'written', contentLength: b.content.length, targetSession: b.targetSession }, ...pastes];
        return json(201, { ok: true, pasteId: 'p-new', status: 'written', contentLength: b.content.length });
      }
      if (method === 'DELETE' && url.startsWith('/pastes/')) { const id = decodeURIComponent(url.slice(8)); const had = pastes.length; pastes = pastes.filter((p) => p.pasteId !== id); return json(had === pastes.length ? 404 : 200, { ok: true, deleted: true }); }
      return json(404, { error: 'no such route in the test' });
    };
    const flush = async (n = 25) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 20)); };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    await flush();
    const doc = dom.window.document;
    const q = (sel: string) => doc.querySelector(sel) as HTMLElement;

    // The old ?tab=dropzone link landed here with the sheet up; the flag is dropped.
    expect(q('.sheet .sheet-title').textContent).toBe('Paste to a session');
    expect(dom.window.location.hash).toBe('#/work/sessions');
    const pick = q('.sheet select[aria-label="Paste to"]') as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Bug: login loop, active 1 min ago', 'Topic 127504, active 5 min ago', 'Feedback drain, on Mac Mini (typed in)']);
    expect(pick.value).toBe('echo-fix');
    expect(q('.sheet .paste-where').textContent).toBe('Goes to Bug: login loop.');
    expect(q('.sheet .paste-kept').textContent).toBe('Kept on this machine for 7 days. Don’t paste passwords or keys.');
    expect(q('.sheet .paste-recent .list-head h2').textContent).toBe('Recent pastes (1)');

    // Empty text never leaves the page.
    (q('.sheet button[data-paste-send]') as HTMLButtonElement).click();
    await flush(3);
    expect(writes).toHaveLength(0);
    expect(q('.sheet .paste-result').textContent).toBe('Paste some text first.');

    // A send: the exact body, then waiting (amber); the form clears; Recent refreshes.
    const text = q('.sheet .paste-text') as HTMLTextAreaElement;
    text.value = 'x'.repeat(400);
    text.dispatchEvent(new dom.window.Event('input'));
    expect(q('.sheet .paste-count').textContent).toBe('400 characters, about 100 tokens');
    (q('.sheet input[aria-label="What is it? (optional)"]') as HTMLInputElement).value = 'build log';
    (q('.sheet button[data-paste-send]') as HTMLButtonElement).click();
    await flush(5);
    expect(writes[0]).toMatchObject({ method: 'POST', url: '/pastes', body: { content: 'x'.repeat(400), label: 'build log', targetSession: 'echo-fix' } });
    expect(writes[0].headers.Authorization).toBe('Bearer t');
    expect(q('.sheet .paste-result').getAttribute('data-tone')).toBe('attn');
    expect(q('.sheet .paste-result').textContent).toMatch(/^No session was ready; the 400 characters/);
    expect(text.value).toBe('');
    expect(q('.sheet .paste-recent .list-head h2').textContent).toBe('Recent pastes (2)');

    // The live delivery event for that paste updates the result line.
    sockets.at(-1)!.push({ type: 'paste_delivered', pasteId: 'p-new', session: 'echo-fix', contentLength: 400 });
    await flush(3);
    expect(q('.sheet .paste-result').textContent).toBe('Delivered 400 characters to Bug: login loop.');

    // A refused send keeps the text in the box.
    text.value = 'second';
    (q('.sheet button[data-paste-send]') as HTMLButtonElement).click();
    await flush(5);
    expect(q('.sheet .paste-result').textContent).toBe('Not sent: Paste exceeds 10MB limit. Your text is still here.');
    expect(text.value).toBe('second');

    // Recent opens; Delete asks once, then removes it.
    (q('.sheet button[data-recent]') as HTMLButtonElement).click();
    expect(doc.querySelectorAll('.sheet .paste-row')).toHaveLength(2);
    (q('.sheet button[data-paste-delete="p-old"]') as HTMLButtonElement).click();
    expect(q('.sheet .paste-item .confirm-text').textContent).toBe('Delete this paste? The session keeps what it already read.');
    expect(writes.filter((w) => w.method === 'DELETE')).toHaveLength(0);
    (q('.sheet button[data-paste-delete-confirm="p-old"]') as HTMLButtonElement).click();
    await flush(5);
    expect(writes.at(-1)).toMatchObject({ method: 'DELETE', url: '/pastes/p-old' });
    expect(q('.sheet .paste-item .action-status').textContent).toBe('Deleted.');
    await flush(50);
    expect(q('.sheet .paste-recent .list-head h2').textContent).toBe('Recent pastes (1)');

    // Another machine's session: typed in over the live stream, and that machine's answer shown.
    pick.value = 'remote:m-mini:drain';
    pick.dispatchEvent(new dom.window.Event('change'));
    expect(q('.sheet button[data-paste-send]').textContent).toBe('Type it into the session');
    expect(q('.sheet .paste-where').textContent).toMatch(/not kept as a paste/);
    text.value = 'hello mini';
    const nPosts = writes.length;
    (q('.sheet button[data-paste-send]') as HTMLButtonElement).click();
    await flush(2);
    const ws = sockets.at(-1)!;
    expect(ws.sent).toContainEqual({ type: 'subscribe', session: 'drain', machineId: 'm-mini' });
    expect(ws.sent).toContainEqual({ type: 'input', session: 'drain', text: 'hello mini', machineId: 'm-mini' });
    ws.push({ type: 'error', code: 'input-not-allowed', session: 'drain', machineId: 'm-mini' });
    await flush(3);
    expect(q('.sheet .paste-result').textContent).toBe('Mac Mini doesn’t accept typing from other machines. Your text is still here.');
    expect(ws.sent).toContainEqual({ type: 'unsubscribe', session: 'drain', machineId: 'm-mini' });
    expect(writes.length).toBe(nPosts); // typed, never stored
    (q('.sheet button[data-paste-send]') as HTMLButtonElement).click();
    await flush(2);
    ws.push({ type: 'input_ack', session: 'drain', success: true, machineId: 'm-mini' });
    await flush(3);
    expect(q('.sheet .paste-result').textContent).toBe('Typed into the session on Mac Mini.');
    expect(text.value).toBe('');

    // From an open session's ⋯ menu: the target is fixed and named.
    (q('.sheet .sheet-close') as HTMLButtonElement).click();
    dom.window.location.hash = '#/work/sessions?s=older';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    await flush();
    (q('button[data-more]') as HTMLButtonElement).click();
    (q('.sheet button[data-paste-here]') as HTMLButtonElement).click();
    await flush(3);
    expect(q('.sheet .sheet-title').textContent).toBe('Paste long text');
    expect(q('.sheet .card-line').textContent).toBe('Paste to: Topic 127504, active 5 min ago');
    expect(doc.querySelector('.sheet select[aria-label="Paste to"]')).toBeNull();
    expect(doc.querySelector('.pin-input')).toBeNull();
    expect(doc.body.innerHTML).not.toContain('tab=dropzone');
  });
});
