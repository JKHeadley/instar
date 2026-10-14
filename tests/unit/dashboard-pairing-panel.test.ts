/**
 * Dashboard "Pair with another agent" card (docs/specs/a2a-pairing-invite-link.md §8).
 * Pure renderers + the controller against a fake fetch, in a real jsdom DOM.
 * Covers the rules from Justin's test: nothing he is looking at or typing into is reset by a
 * timer, the PIN is asked once, and waiting decisions come first with a count on the tab.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
// @ts-expect-error — plain JS dashboard module
import { renderPairing, renderPairings, renderPending, renderOpenInvites, finishPrompts, pendingCount, createController } from '../../dashboard/pairing.js';

const FP = 'ab'.repeat(16);
const IID = 'cd'.repeat(16);
const NOW = Date.parse('2026-10-14T12:00:00Z');
const later = (min: number) => new Date(NOW + min * 60_000).toISOString();

const openInvite = { iid: IID, state: 'open', exp: later(60), createdAt: later(0) };
const usedInvite = { iid: IID, state: 'used', exp: later(60), createdAt: later(0), acceptor: { fp: FP, key: 'k', agent: 'Carl', owner: 'Carl O', acceptedAt: later(1) } };
const pendingAccept = { iid: 'ef'.repeat(16), claimedAgent: 'Scout', claimedOwner: 'Justin', inviterFp: FP, exp: later(30), checkCode: 'K7Q2' };

interface Server { invites: any[]; pendingAccepts: any[]; pairings: any[] }

function setup(server: Server, reply: (url: string, opts: any) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } })) {
  const dom = new JSDOM(`<button id="navToggle">&#9776; <span>Sessions</span></button><button class="tab" data-tab="threadline">Threadline</button>
    <div id="root"><div id="notice"></div><div id="pending"></div><div id="pinRow"><input id="pin"></div>
    <select id="ttl"><option value="60">1h</option></select><div id="out"></div><div id="open"></div>
    <textarea id="in"></textarea><div id="list"></div></div>`);
  const doc = dom.window.document;
  const $ = (id: string) => doc.getElementById(id)! as any;
  const els = { root: $('root'), notice: $('notice'), pending: $('pending'), open: $('open'), list: $('list'), pin: $('pin'), pinRow: $('pinRow'), ttl: $('ttl'), inviteOut: $('out'), inviteIn: $('in'), tabButton: doc.querySelector('.tab') as any, navToggle: $('navToggle') };
  const calls: Array<{ url: string; opts: any }> = [];
  const fetchImpl = async (url: string, opts: any = {}) => {
    calls.push({ url, opts });
    if (url === '/threadline/pairing/invites' && !opts.method) return { status: 200, json: async () => ({ invites: server.invites, pendingAccepts: server.pendingAccepts }) };
    if (url === '/threadline/pairing' && !opts.method) return { status: 200, json: async () => ({ pairings: server.pairings }) };
    const r = reply(url, opts);
    return { status: r.status, json: async () => r.body };
  };
  const c = createController({ doc, els, fetchImpl, now: () => NOW });
  return { doc, els, calls, c, $ };
}
const click = (c: any, el: any) => c.onClick({ target: el });
const empty = (): Server => ({ invites: [], pendingAccepts: [], pairings: [] });

describe('pairing card — rendering', () => {
  it('waiting decisions: an approve prompt and a finish prompt, names labelled as claimed; nothing for an open invite', () => {
    const html = renderPending({ invites: [usedInvite, { ...openInvite, iid: 'aa'.repeat(16) }], pendingAccepts: [pendingAccept] }, NOW);
    expect(html).toContain('calls itself <strong>Scout</strong>');
    expect(html).toContain(`data-approve="${pendingAccept.iid}"`);
    expect(html).toContain(`data-finish="${IID}"`);
    expect(html).toContain('Not them');
    expect(html).not.toContain('aa'.repeat(16));
    expect(pendingCount({ invites: [usedInvite], pendingAccepts: [pendingAccept] })).toBe(2);
  });

  it('a decided or leaked invite asks for nothing; a leak shows an alarm', () => {
    expect(finishPrompts([{ ...usedInvite, decision: 'finished' }])).toEqual([]);
    const leaked = { ...usedInvite, secondAccept: { fp: 'f'.repeat(32), agent: 'Mallory', owner: '', at: later(2) } };
    expect(finishPrompts([leaked])).toEqual([]);
    expect(renderPending({ invites: [leaked], pendingAccepts: [] }, NOW)).toMatch(/your invite got out[\s\S]*Mallory/);
  });

  it('open invites list with a cancel button; expired ones are not listed', () => {
    expect(renderOpenInvites([openInvite], NOW)).toContain(`data-revoke="${IID}"`);
    expect(renderOpenInvites([{ ...openInvite, exp: later(-1) }], NOW)).toBe('');
  });

  it('agents list: states in plain words, no 12-word controls, names escaped', () => {
    expect(renderPairing({ peerFp: FP, peerName: 'scout', state: 'mutual-verified' })).toContain('Paired');
    expect(renderPairing({ peerFp: FP, state: 'invite-accepted' })).toContain('Waiting for the other side');
    const old = renderPairing({ peerFp: FP, state: 'pending-verification' });
    expect(old).toContain('Pair by invite instead');
    expect(old).not.toMatch(/data-their-word|Show my words/);
    expect(renderPairing({ peerFp: FP, peerName: '<img src=x onerror=1>', state: 'mutual-verified' })).not.toContain('<img');
    expect(renderPairings([])).toContain('No paired agents yet');
  });
});

describe('pairing card — controller', () => {
  it('make an invite: the message is shown with Copy, and a later refresh never touches it', async () => {
    const server = empty();
    const { els, c, calls } = setup(server, (url) => url === '/threadline/pairing/invites'
      ? { status: 200, body: { ok: true, iid: IID, exp: later(60), message: 'Scout invites you… tlinv1:abc.def' } }
      : { status: 200, body: {} });
    await c.load();
    await click(c, { dataset: { makeInvite: '' } });
    expect(JSON.parse(calls.find((x) => x.url === '/threadline/pairing/invites' && x.opts.method === 'POST')!.opts.body)).toEqual({ ttlMinutes: 60 });
    const box = els.inviteOut.querySelector('[data-invite-text]');
    expect(box.value).toContain('tlinv1:abc.def');
    server.invites = [openInvite];
    await c.load(); await c.load();
    expect(els.inviteOut.querySelector('[data-invite-text]')).toBe(box); // same node: not re-rendered
    expect(els.open.innerHTML).toContain('data-revoke');
  });

  it('a refresh with no change re-renders nothing; text typed into the paste box survives refreshes', async () => {
    const server = { ...empty(), pendingAccepts: [pendingAccept] };
    const { els, c } = setup(server);
    await c.load();
    const node = els.pending.firstElementChild;
    els.inviteIn.value = 'half-pasted';
    els.pin.value = '13';
    await c.load(); await c.load();
    expect(els.pending.firstElementChild).toBe(node);
    expect(els.inviteIn.value).toBe('half-pasted');
    expect(els.pin.value).toBe('13');
  });

  it('the PIN is asked once: after one accepted use it is held, the field hides, and the next action needs no typing', async () => {
    const server = { ...empty(), pendingAccepts: [pendingAccept], invites: [usedInvite] };
    const { els, c, calls } = setup(server);
    await c.load();
    await click(c, els.pending.querySelector('[data-approve]'));
    expect(calls.some((x) => x.url.endsWith('/approve'))).toBe(false); // no PIN yet: nothing sent
    els.pin.value = '135790';
    await click(c, els.pending.querySelector('[data-approve]'));
    expect(JSON.parse(calls.find((x) => x.url.endsWith('/approve'))!.opts.body)).toEqual({ pin: '135790' });
    expect(c.hasPin()).toBe(true);
    expect(els.pinRow.style.display).toBe('none');
    expect(els.pending.innerHTML).toContain('The agent that calls itself'); // a sentence starts with a capital
    await click(c, els.pending.querySelector('[data-finish]'));
    expect(JSON.parse(calls.find((x) => x.url.endsWith('/finish'))!.opts.body)).toEqual({ pin: '135790' });
  });

  it('a refused PIN is forgotten and the field comes back', async () => {
    const server = { ...empty(), invites: [usedInvite] };
    const { els, c } = setup(server, () => ({ status: 403, body: { error: 'wrong' } }));
    await c.load();
    els.pin.value = '0000';
    await click(c, els.pending.querySelector('[data-finish]'));
    expect(c.hasPin()).toBe(false);
    expect(els.pinRow.style.display).toBe(''); // a decision still waits, so the field comes back
    expect(els.notice.textContent).toMatch(/not accepted/);
  });

  it('paste an invite: checked, the box is emptied (the secret leaves the page), and the decision waits at the top', async () => {
    const server = empty();
    const { els, c, calls } = setup(server, (url) => {
      if (url.endsWith('/inspect')) { server.pendingAccepts = [pendingAccept]; return { status: 200, body: { ok: true } }; }
      return { status: 200, body: {} };
    });
    els.inviteIn.value = 'Fwd: tlinv1:abc.def';
    await click(c, { dataset: { inspectInvite: '' } });
    expect(JSON.parse(calls.find((x) => x.url.endsWith('/inspect'))!.opts.body)).toEqual({ invite: 'Fwd: tlinv1:abc.def' });
    expect(els.inviteIn.value).toBe('');
    expect(els.pending.innerHTML).toContain('data-approve');
  });

  it('the Threadline tab AND the header menu button show how many decisions wait', async () => {
    const server = { ...empty(), invites: [usedInvite], pendingAccepts: [pendingAccept] };
    const { els, c } = setup(server);
    await c.load();
    expect(els.tabButton.textContent).toBe('Threadline (2)');
    // the tabs hide behind the header menu button, so the count shows there too
    expect(els.navToggle.querySelector('[data-pair-badge]').textContent).toBe('2 waiting');
    expect(els.navToggle.querySelector('[data-pair-badge]').getAttribute('aria-label')).toBe('2 pairing decisions waiting');
    server.invites = []; server.pendingAccepts = [];
    await c.load();
    expect(els.tabButton.textContent).toBe('Threadline');
    expect(els.navToggle.querySelector('[data-pair-badge]').style.display).toBe('none');
  });

  it('cancel and decline need no PIN', async () => {
    const server = { ...empty(), invites: [openInvite], pendingAccepts: [pendingAccept] };
    const { els, c, calls } = setup(server);
    await c.load();
    await click(c, els.open.querySelector('[data-revoke]'));
    await click(c, els.pending.querySelector('[data-decline]'));
    expect(calls.find((x) => x.url === `/threadline/pairing/invites/${IID}`)!.opts.method).toBe('DELETE');
    expect(calls.some((x) => x.url.endsWith('/decline'))).toBe(true);
  });
});

describe('pairing card — the PIN field appears only when a decision waits', () => {
  it('hidden with nothing waiting, shown above the decisions when one arrives', async () => {
    const server = empty();
    const { els, c } = setup(server);
    await c.load();
    expect(els.pinRow.style.display).toBe('none');
    server.pendingAccepts = [pendingAccept];
    await c.load();
    expect(els.pinRow.style.display).toBe('');
  });
});

describe('pairing card — page wiring', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../dashboard/index.html'), 'utf-8');
  it('the card is first on the Threadline tab, before the bridge settings, with no 12-word controls', () => {
    const tab = html.slice(html.indexOf('id="threadlineTab"'));
    expect(tab.indexOf('id="pairCard"')).toBeGreaterThan(0);
    expect(tab.indexOf('id="pairCard"')).toBeLessThan(tab.indexOf('id="tlBridgeCard"'));
    expect(html).not.toContain('Compare 12 words');
    expect(html).toContain("import('/dashboard/pairing.js')");
  });
  it('the panel starts at login (for the tab count) and the page offers a reload when the server version changes', () => {
    expect((html.match(/startPairingPanel\(\);/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('id="dashVersionBar"');
    // the PIN field comes BEFORE the decisions it unlocks
    expect(html.indexOf('id="pairPinRow"')).toBeLessThan(html.indexOf('id="pairPending"'));
    expect(html).toMatch(/h\.version !== window\.__dashServerVersion/);
  });
});
