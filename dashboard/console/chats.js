// Conversations (docs/specs/dashboard-conversations-browser-device.md §4.8): the iPhone app's chats
// in the dashboard — app conversations, Telegram topics and Slack conversations, newest first; the
// open conversation as chat bubbles; send text, photos and files; new, rename, delete.
//
// Every request to a conversation route is signed by this browser's own device key
// (browser-device.js); the Bearer token is used only for the setup and status routes.
//
// SAFETY: every server and third-party value reaches the DOM through textContent (ui.js el).
// No signed write (send, create, rename, delete, setup, forget) ever starts from a URL or hash
// parameter: each needs an action in the page. Only the media types in chats-model.js VIEWABLE_TYPES
// become a viewable blob:; everything else is a download.

import { el, setKids, sheet, closeSheet, askPin, forgetOperatorSession } from './ui.js';
import {
  createBrowserDevice, consolePathAllowed, secureContextOk, newRequestId, sha256Hex, DELETED_REASON, refusalWords, readRecord, readAllRecords, deleteRecord,
} from './browser-device.js';
import {
  parseConversationRef, refString, refFromQuery, hashFor, listRows, listMeta, mergeListPages, validTitle,
  bubbles, mergeBubbles, applyEvents, deliveryLabel, mediaRefFor, declaredKindFor, checkFiles, humanSize,
  UNFINISHED_KEY, unfinishedAction, sendOutcome, pollUnion, createScheduler, ANNOUNCE_EVERY_MS, readMarkFor,
  setupRefusal, approvalWords, blobTypeFor,
} from './chats-model.js';
import { detectCredentialShape, CREDENTIAL_QUESTION } from './credential-shape.js';

const TOKEN_KEY = 'instar_token';
const POLL_LOCK = 'instar-chat-poll';
const CHANNEL = 'instar-chat';
const OWN_KEY = 'instar_chat_own:';
const OFF_TEXT = 'Conversations in the dashboard are switched off on this agent.';

const bearer = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
const now = () => Date.now();

/** The page. Self-refreshing: the console's 30 s cycle never re-runs it (§4.8 Lifecycle). */
export function renderChats(main, ctx = {}) {
  const page = new ChatsPage(main, ctx);
  if (ctx.selfRefreshing) ctx.selfRefreshing();
  if (ctx.onQuery) ctx.onQuery((q) => page.onQuery(q));
  if (ctx.onDispose) ctx.onDispose(() => page.dispose());
  page.start();
  return page;
}

class ChatsPage {
  constructor(main, ctx) {
    this.main = main;
    this.ctx = ctx;
    this.live = true;
    this.timers = new Set();
    this.aborts = new Set();
    this.blobUrls = new Set();
    this.device = createBrowserDevice({ bearer });
    this.status = null;
    this.rows = [];
    this.meta = { nextCursor: null, failed: [] };
    this.view = null;           // the open conversation
    this.tabId = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : String(Math.random());
    this.focusedAt = document.hasFocus && document.hasFocus() ? now() : 0;
    this.announcements = new Map();
    this.cursors = new Map();   // ref → events cursor (shared by broadcast so a new leader carries on)
    this.leader = false;
    this.union = [];
    this.scheduler = createScheduler();
    this.retries401 = 0;
  }

  // ── lifecycle ──
  later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); if (this.live) fn(); }, ms);
    this.timers.add(t);
    return t;
  }
  abortable() {
    const c = new AbortController();
    this.aborts.add(c);
    return c;
  }
  dispose() {
    this.live = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const c of this.aborts) { try { c.abort(); } catch { /* already done */ } }
    this.aborts.clear();
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.releaseLeadership();
    if (this.channel) { try { this.post({ type: 'withdraw', tab: this.tabId }); this.channel.close(); } catch { /* closed */ } this.channel = null; }
    if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.onFocus) window.removeEventListener('focus', this.onFocus);
    this.revokeBlobs();
    if (this.observer) { try { this.observer.disconnect(); } catch { /* gone */ } }
  }
  revokeBlobs() {
    for (const u of this.blobUrls) { try { URL.revokeObjectURL(u); } catch { /* gone */ } }
    this.blobUrls.clear();
    if (this.view) this.view.media = new Map();
  }

  // ── start: the status route decides what to show ──
  async start() {
    if (!consolePathAllowed(location.pathname)) { this.paintNote('Conversations open only in the dashboard itself.'); return; }
    if (!secureContextOk()) {
      this.paintNote('Conversations need a secure address. Open the dashboard at its secure address (https), or on this computer at localhost.');
      return;
    }
    this.paintLoading();
    const st = await this.device.status(null);
    if (!this.live) return;
    if (st.off) { this.paintNote(OFF_TEXT); return; }
    if (!st.ok) { this.paintRetry('Couldn\'t reach the agent to check this browser.', () => this.start()); return; }
    this.status = st.data;
    let rec = null;
    try { rec = await this.device.load(st.data.machineId); } catch { rec = null; }
    if (!this.live) return;
    if (!rec || rec.status === 'enrolling' || !rec.deviceId) {
      // No key for the machine answering this address: maybe this browser was set up on another
      // machine and the address moved (§4.6 elsewhere). Ask about that key; never delete it on a guess.
      const others = (await readAllRecords().catch(() => [])).filter((x) => x && x.machineId !== st.data.machineId && x.deviceId && x.keyHash);
      const prior = others.find((x) => x.status === 'active') || others[0] || null;
      if (prior && this.live) {
        const ps = await this.device.status(prior.keyHash);
        if (!this.live) return;
        const state = ps.ok && ps.data.key ? ps.data.key.state : 'unknown';
        if (state === 'revoked') await deleteRecord(prior.machineId).catch(() => {});
        else {
          const where = state === 'elsewhere' && ps.data.key.nickname ? ps.data.key.nickname : 'another machine';
          this.paintSetup(`This browser was set up on ${where}; this address is now served by ${st.data.nickname || 'this machine'}.`, { replace: prior.status === 'active' && prior.keyPair ? { record: prior } : null });
          return;
        }
      }
      this.paintSetup();
      return;
    }
    if (rec.status === 'pending') { this.paintPending({ fingerprint: rec.fingerprint, approval: rec.approval, expiresAt: rec.expiresAt }); return; }
    this.openApp();
  }

  // ── simple states ──
  shell(...kids) { setKids(this.main, el('div', { class: 'chats-page chat-state' }, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Work · Conversations' }), el('h1', { class: 'page-title', text: 'Conversations' })), ...kids)); }
  paintLoading() { this.shell(el('p', { class: 'card-line', text: 'Checking this browser…' })); }
  paintNote(text) { this.shell(el('p', { class: 'card-line chat-note', text })); }
  paintRetry(text, retry) {
    const b = el('button', { class: 'btn-quiet', type: 'button', text: 'Retry' });
    b.addEventListener('click', () => retry());
    this.shell(el('p', { class: 'card-line chat-note', text }), b);
  }

  // ── setup (§4.2 client side) ──
  defaultName() {
    const nav = globalThis.navigator || {};
    const ua = (nav.userAgent || '');
    const platform = (nav.userAgentData && nav.userAgentData.platform) || (/Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'this computer');
    const h = location.hostname;
    const via = h === 'localhost' || h === '127.0.0.1' ? 'localhost' : /\.ts\.net$/i.test(h) ? 'Tailscale' : 'tunnel';
    return `Browser on ${platform} (${via})`.slice(0, 60);
  }

  paintSetup(reason, opts = {}) {
    const name = el('input', { class: 'chat-input', type: 'text', maxlength: '60', value: this.defaultName(), 'aria-label': 'Name for this browser' });
    const err = el('p', { class: 'unlock-error', role: 'alert' });
    const go = el('button', { class: 'btn-primary', type: 'button', text: opts.replace ? 'Set up this browser here' : 'Set up this browser' });
    const path = this.status && this.status.approvalPath;
    const how = path === 'telegram'
      ? 'You will be asked for your dashboard PIN, then approve this browser in your private Telegram chat with the agent, or on your phone.'
      : path === 'dashboard' ? 'You will be asked for your dashboard PIN, which approves this browser.' : 'You will be asked for your dashboard PIN, then to approve this browser.';
    go.addEventListener('click', async () => {
      go.disabled = true; err.textContent = '';
      const r = await this.device.setup({
        askSession: () => askPin({ title: 'Your PIN', explain: 'Type your dashboard PIN to set up this browser.', adapter: 'session' }).then((x) => (x && x.session) || null),
        forgetSession: forgetOperatorSession,
        deviceName: (name.value || '').trim() || this.defaultName(),
        replaceFrom: opts.replace || null,
      }).catch(() => ({ ok: false, status: 0, error: 'failed' }));
      if (!this.live) return;
      go.disabled = false;
      if (!r.ok) { if (r.error !== 'cancelled') err.textContent = setupRefusal(r.status, r.data || { error: r.error, detail: r.detail }); return; }
      const a = r.answer || {};
      if (a.status === 'active') { this.openApp(); return; }
      this.paintPending(a);
    });
    this.shell(
      reason ? el('p', { class: 'card-line chat-note', text: reason }) : null,
      el('section', { class: 'card chat-setup' },
        el('h2', { class: 'card-title', text: opts.replace ? 'Set up this browser on this machine' : 'Set up this browser' }),
        el('p', { class: 'card-line', text: 'To read and send your conversations here, this browser becomes a device of its own, like a second phone. It makes a private key that cannot be copied out of it, and every message it sends is signed with that key and marked as sent from a browser.' }),
        el('p', { class: 'card-line', text: how }),
        el('label', { class: 'chat-label' }, el('span', { text: 'Name' }), name),
        go, err),
    );
  }

  paintPending(answer) {
    const a = answer || {};
    const err = el('p', { class: 'unlock-error', role: 'alert' });
    const code = el('input', { class: 'chat-input', type: 'text', autocomplete: 'one-time-code', 'aria-label': 'Approval code' });
    const confirm = el('button', { class: 'btn-quiet', type: 'button', text: 'Confirm code' });
    const left = el('p', { class: 'card-line chat-countdown' });
    confirm.addEventListener('click', async () => {
      const v = code.value.trim();
      if (!v) { err.textContent = 'Type the code from your private chat.'; return; }
      confirm.disabled = true;
      const r = await this.device.call('POST', '/mobile/device/confirm', { json: { code: v } });
      confirm.disabled = false;
      if (!this.live) return;
      if (r.ok && r.data && r.data.status === 'active') { await this.device.setStatus('active'); this.openApp(); return; }
      err.textContent = (r.data && (r.data.detail || r.data.error)) ? String(r.data.detail || r.data.error) : 'That code did not work.';
    });
    this.shell(el('section', { class: 'card chat-setup' },
      el('h2', { class: 'card-title', text: 'Waiting for approval' }),
      el('p', { class: 'card-line', text: approvalWords(a.approval) }),
      el('p', { class: 'card-line' }, el('span', { text: 'This browser\'s key: ' }), el('strong', { class: 'chat-fingerprint', text: a.fingerprint || (this.device.record && this.device.record.fingerprint) || '' })),
      el('p', { class: 'card-line chat-muted', text: 'Approve only if the key shown in the approval message matches this one.' }),
      el('label', { class: 'chat-label' }, el('span', { text: 'Code' }), code), confirm, left, err));
    const expires = Date.parse(a.expiresAt || (this.device.record && this.device.record.expiresAt) || '');
    const tick = () => {
      if (!this.live || !left.isConnected) return;
      if (Number.isFinite(expires)) {
        const s = Math.max(0, Math.round((expires - this.device.clock.now()) / 1000));
        left.textContent = s > 0 ? `The approval window closes in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.` : 'The approval window has closed.';
      }
      this.later(tick, 1000);
    };
    tick();
    const poll = async () => {
      if (!this.live || !confirm.isConnected) return;
      if (document.visibilityState === 'visible') {
        const r = await this.device.call('GET', '/mobile/device');
        if (!this.live || !confirm.isConnected) return;
        const s = r.ok && r.data ? r.data.status : null;
        if (s === 'active') { await this.device.setStatus('active'); this.openApp(); return; }
        if (s === 'declined' || s === 'expired') {
          await this.device.forget();
          this.paintSetup(s === 'declined' ? DELETED_REASON.declined : DELETED_REASON.expired);
          return;
        }
        if (r.status === 401) { await this.handle401(); return; }
      }
      this.later(poll, 5000);
    };
    this.later(poll, 5000);
  }

  // ── a refused signed call (§4.6) ──
  async handle401() {
    const d = await this.device.checkAfter401();
    if (!this.live) return 'gone';
    if (d.deleted) { this.clearUnfinished(); this.teardownApp(); this.paintSetup(DELETED_REASON[d.show] || DELETED_REASON.removed); return 'gone'; }
    if (d.show === 'elsewhere') {
      this.teardownApp();
      const old = d.machineId ? await readRecord(d.machineId).catch(() => null) : null;
      const replace = old && old.status === 'active' && old.keyPair ? { record: old } : null;
      const nick = this.status && this.status.nickname ? this.status.nickname : 'this machine';
      this.paintSetup(`This browser was set up on ${d.nickname || 'another machine'}; this address is now served by ${nick}.`, { replace });
      return 'gone';
    }
    if (d.show === 'refused') {
      if (this.retries401 < 5) { this.retries401++; return 'retry'; }
      this.teardownApp();
      this.paintRetry(refusalWords(d.reason, this.device.clock.skewMinutes()), () => { this.retries401 = 0; this.start(); });
      return 'gone';
    }
    if (d.show === 'off') { this.teardownApp(); this.paintNote(OFF_TEXT); return 'gone'; }
    this.teardownApp();
    this.paintRetry('Couldn\'t check this browser right now.', () => { this.retries401 = 0; this.start(); });
    return 'gone';
  }

  /** A signed JSON call with the 401 rule and the 5-retry backoff for a transient refusal. */
  async call(method, path, opts = {}) {
    for (;;) {
      const r = await this.device.call(method, path, opts);
      if (r.status !== 401) { if (r.ok) this.retries401 = 0; return r; }
      const what = await this.handle401();
      if (what !== 'retry') return { ...r, gone: true };
      await new Promise((res) => this.later(res, 500 * 2 ** this.retries401));
      if (!this.live) return { ...r, gone: true };
    }
  }

  // ── the app: list + conversation ──
  openApp() {
    if (!this.live) return;
    const record = this.device.record;
    this.ownIds = loadOwn(record && record.deviceId);
    const skew = this.device.clock.skewMinutes();
    this.listEl = el('div', { class: 'chat-rows', role: 'list' });
    this.moreBtn = el('button', { class: 'btn-quiet chat-more', type: 'button', text: 'Show more', hidden: true });
    this.moreBtn.addEventListener('click', () => this.loadList(true));
    this.failedEl = el('p', { class: 'card-line chat-muted', hidden: true });
    const newBtn = el('button', { class: 'btn-primary chat-new', type: 'button', text: 'New conversation' });
    newBtn.addEventListener('click', () => this.newConversation());
    const forget = el('button', { class: 'btn-quiet chat-forget', type: 'button', text: 'Forget this browser' });
    forget.addEventListener('click', () => this.forgetBrowser());
    this.viewEl = el('div', { class: 'chat-view' }, el('p', { class: 'chat-pick', text: 'Pick a conversation.' }));
    this.pageEl = el('div', { class: 'chats-page' },
      el('div', { class: 'chat-list' },
        el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Work · Conversations' }), el('h1', { class: 'page-title', text: 'Conversations' })),
        skew ? el('p', { class: 'card-line chat-note', text: `Your computer's clock is ${Math.abs(skew)} minutes off.` }) : null,
        el('div', { class: 'chat-list-actions' }, newBtn, forget),
        this.listEl, this.moreBtn, this.failedEl),
      this.viewEl);
    setKids(this.main, this.pageEl);
    this.startPolling();
    this.loadList(false);
    this.onQuery(this.ctxQuery());
  }
  teardownApp() {
    this.releaseLeadership();
    if (this.view) this.closeView();
    this.pageEl = null;
  }
  ctxQuery() { const h = location.hash; const i = h.indexOf('?'); return i < 0 ? '' : h.slice(i + 1); }

  async loadList(more) {
    const cursor = more && this.meta.nextCursor ? `&cursor=${encodeURIComponent(this.meta.nextCursor)}` : '';
    this.spent();
    const r = await this.call('GET', `/mobile/conversations?scope=pool&limit=50${cursor}`);
    if (!this.live || r.gone) return;
    if (r.ok) this.applyList(r.data, more);
    else if (!more && !this.rows.length) setKids(this.listEl, el('p', { class: 'card-line chat-muted', text: r.status === 503 ? OFF_TEXT : 'Couldn\'t load the conversations right now.' }));
  }
  applyList(data, more) {
    const rows = listRows(data);
    if (more) { this.pagedMore = true; this.rows = mergeListPages(this.rows, rows); }
    // A refresh of the first page replaces it; pages the operator opened with "Show more" are kept below.
    else this.rows = this.pagedMore ? mergeListPages(rows, this.rows) : rows;
    const meta = listMeta(data);
    this.meta = more || !this.pagedMore ? meta : { ...meta, nextCursor: this.meta.nextCursor };
    this.paintList();
  }
  paintList() {
    if (!this.listEl) return;
    const open = this.view ? refString(this.view.ref) : '';
    if (this.view && this.view.titleEl) {
      const row = this.rows.find((r) => r.key === open);
      if (row) { this.view.titleEl.textContent = row.title; this.view.titleEl = null; }
    }
    if (!this.rows.length) { setKids(this.listEl, el('p', { class: 'card-line chat-muted', text: 'No conversations yet.' })); }
    else {
      setKids(this.listEl, this.rows.map((r) => el('a', { class: `row chat-row${r.key === open ? ' open' : ''}`, href: hashFor(r.ref), role: 'listitem' },
        el('span', { class: 'chat-row-main' },
          el('span', { class: 'chat-row-top' }, el('span', { class: 'chat-row-title', text: r.title }), el('span', { class: `chat-kind chat-kind-${r.kind}`, text: r.kindLabel })),
          el('span', { class: 'chat-row-preview', text: r.preview || ' ' })),
        el('span', { class: 'chat-row-side' },
          r.lastActivity ? el('span', { class: 'chat-row-time', text: shortTime(r.lastActivity) }) : null,
          // The conversation on screen is being read (and reported read, which clears the count on the phone too): no badge for it.
          r.unread > 0 && r.key !== open ? el('span', { class: 'chat-unread', text: String(r.unread), 'aria-label': `${r.unread} unread` }) : null))));
    }
    this.moreBtn.hidden = !this.meta.nextCursor;
    const failed = this.meta.failed || [];
    this.failedEl.hidden = failed.length === 0;
    this.failedEl.textContent = failed.length ? `Not shown: conversations on ${failed.map((f) => f.machineId).join(', ')} (that machine did not answer).` : '';
  }

  async newConversation() {
    const input = el('input', { class: 'chat-input', type: 'text', maxlength: '80', 'aria-label': 'Title' });
    const err = el('p', { class: 'unlock-error', role: 'alert' });
    const go = el('button', { class: 'btn-primary', type: 'submit', text: 'Start' });
    const form = el('form', { class: 'pin-form' }, el('p', { class: 'confirm-text', text: 'A title for the new conversation (1–80 characters).' }), input, go, err);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const title = validTitle(input.value);
      if (!title) { err.textContent = 'Type a title of 1 to 80 characters.'; return; }
      go.disabled = true;
      const r = await this.call('POST', '/mobile/conversations', { json: { title, requestId: newRequestId(this.device.clock.now()) } });
      go.disabled = false;
      if (!this.live || r.gone) { closeSheet(); return; }
      if (!r.ok || !r.data || !r.data.conversationKey) { err.textContent = (r.data && (r.data.detail || r.data.error)) || 'That did not work.'; return; }
      closeSheet();
      this.loadList(false);
      location.hash = hashFor({ kind: 'app', id: r.data.conversationKey });
    });
    sheet({ title: 'New conversation' }, form);
    setTimeout(() => input.focus(), 50);
  }

  async forgetBrowser() {
    const go = el('button', { class: 'btn-primary', type: 'button', text: 'Forget this browser' });
    const err = el('p', { class: 'unlock-error', role: 'alert' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      const r = await this.device.revokeSelf();
      if (!this.live) return;
      if (!r.ok) { go.disabled = false; err.textContent = 'The agent could not remove this browser right now. Try again.'; return; }
      closeSheet();
      this.clearUnfinished();
      this.teardownApp();
      this.paintSetup('This browser was removed.');
    });
    sheet({ title: 'Forget this browser' }, el('div', { class: 'pin-form' },
      el('p', { class: 'confirm-text', text: 'This removes this browser\'s key. It can no longer read or send here until it is set up again.' }), go, err));
  }

  // ── the open conversation ──
  onQuery(query) {
    if (!this.pageEl) return;
    const ref = refFromQuery(query);
    const cur = this.view ? refString(this.view.ref) : '';
    if (ref && refString(ref) === cur) return;
    if (this.view) this.closeView();
    this.pageEl.classList.toggle('has-open', Boolean(ref));
    if (!ref) { setKids(this.viewEl, el('p', { class: 'chat-pick', text: 'Pick a conversation.' })); this.paintList(); this.announce(); return; }
    this.openView(ref);
  }

  closeView() {
    const v = this.view;
    this.view = null;
    if (!v) return;
    v.live = false;
    if (v.abort) { try { v.abort.abort(); } catch { /* done */ } }
    this.revokeBlobs();
    if (this.observer) { try { this.observer.disconnect(); } catch { /* gone */ } this.observer = null; }
  }

  openView(ref) {
    const row = this.rows.find((r) => r.key === refString(ref));
    const v = { ref, live: true, list: [], nextBefore: null, oldestTs: null, media: new Map(), mediaQueue: [], mediaInFlight: 0, slackKey: null, abort: this.abortable(), sending: 0 };
    this.view = v;
    const title = el('h2', { class: 'chat-title', text: row ? row.title : (ref.kind === 'telegram' ? `Topic ${ref.id}` : 'Conversation') });
    // Opened from a link before the list arrived: the real title is filled in when the list paints.
    v.titleEl = row ? null : title;
    const back = el('a', { class: 'btn-quiet chat-back', href: '#/work/chats', 'aria-label': 'Back to conversations', text: '‹' });
    const menu = el('div', { class: 'chat-menu' });
    if (ref.kind === 'app') {
      const rename = el('button', { class: 'btn-quiet', type: 'button', text: 'Rename' });
      rename.addEventListener('click', () => this.rename(v, title));
      const del = el('button', { class: 'btn-quiet chat-delete', type: 'button', text: 'Delete' });
      del.addEventListener('click', () => this.remove(v));
      menu.append(rename, del);
    }
    v.msgs = el('div', { class: 'chat-messages', role: 'log', 'aria-live': 'polite' });
    v.earlier = el('button', { class: 'btn-quiet chat-earlier', type: 'button', text: 'Earlier messages', hidden: true });
    v.earlier.addEventListener('click', () => this.loadEarlier(v));
    v.paused = el('p', { class: 'card-line chat-muted chat-paused', hidden: true, text: 'Live updates paused here — this conversation refreshes when you click into this window.' });
    v.statusLine = el('p', { class: 'card-line chat-muted', role: 'status' });
    v.nodes = new Map();
    setKids(this.viewEl, el('div', { class: 'chat-open' },
      el('div', { class: 'chat-bar' }, back, el('div', { class: 'chat-titles' }, title, el('p', { class: 'chat-sub', text: row ? row.kindLabel : ({ app: 'App', telegram: 'Telegram', slack: 'Slack' })[ref.kind] })), menu),
      v.paused, v.earlier, v.msgs, this.composer(v), v.statusLine));
    this.pageEl.classList.add('has-open');
    this.paintList();
    this.loadFirst(v);
    this.announce();
  }

  historyPath(v, { pool, before } = {}) {
    const { kind, id } = v.ref;
    if (kind === 'app') return `/mobile/chat/app/${encodeURIComponent(id)}/messages?limit=50${pool ? '&scope=pool' : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    if (kind === 'telegram') return `/telegram/topics/${encodeURIComponent(id)}/messages?limit=50${pool ? '&scope=pool' : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    return `/mobile/chat/slack/${encodeURIComponent(id)}/messages?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`;
  }
  ownCheck() {
    const rec = this.device.record;
    return (row) => Boolean(row && ((rec && row.originDeviceId && row.originDeviceId === rec.deviceId) || (row.messageId && this.ownIds.has(String(row.messageId)))));
  }

  async loadFirst(v) {
    this.spent();
    const r = await this.call('GET', this.historyPath(v, { pool: true }));
    if (!v.live || r.gone) return;
    if (r.status === 404) { v.statusLine.textContent = 'This conversation is not here any more.'; return; }
    if (!r.ok) { v.statusLine.textContent = r.status === 503 ? OFF_TEXT : 'Couldn\'t load this conversation right now.'; return; }
    this.applyHistory(v, r.data, { replace: true });
    this.resumeUnfinished(v);
    this.scrollToEnd(v, true);
  }

  applyHistory(v, data, { replace = false, earlier = false } = {}) {
    if (!data) return;
    if (v.ref.kind === 'slack' && typeof data.conversationKey === 'string') v.slackKey = data.conversationKey;
    const rows = Array.isArray(data.messages) ? data.messages : [];
    const next = bubbles(v.ref.kind, rows, { own: this.ownCheck() });
    if (earlier || replace) {
      v.nextBefore = typeof data.nextBefore === 'string' ? data.nextBefore : null;
      if (v.ref.kind === 'telegram') { const t = rows.length ? Date.parse(rows[0].timestamp) : NaN; v.oldestTs = Number.isFinite(t) ? t : null; }
      v.earlier.hidden = v.ref.kind === 'telegram' ? !(rows.length >= 50) : !v.nextBefore;
    }
    this.setBubbles(v, mergeBubbles(v.list, next));
  }

  setBubbles(v, list) {
    // A server row replaces this page's own placeholder for the same message.
    const real = new Set(list.filter((b) => !b.id.startsWith('local:') && b.messageId).map((b) => b.messageId));
    const realTexts = list.filter((b) => !b.id.startsWith('local:') && b.side === 'right').map((b) => `${b.text}|${b.at}`);
    v.list = list.filter((b) => {
      if (!b.id.startsWith('local:')) return true;
      if (b.messageId && real.has(b.messageId)) return false;
      if (b.final && v.ref.kind !== 'app' && realTexts.some((k) => k.startsWith(`${b.text}|`))) return false;
      return true;
    });
    this.paintBubbles(v);
    this.maybeMarkRead(v);
  }

  /**
   * Reading here clears the count everywhere (dashboard-read-markers, like Telegram Web and the phone):
   * the focused, visible tab reports the newest message shown as read, through the same per-person
   * marker the phone uses. Only when something newer than the last report is shown; one at a time.
   */
  async maybeMarkRead(v) {
    if (!v || !v.live || v.markInFlight || document.visibilityState !== 'visible' || !(document.hasFocus && document.hasFocus())) return;
    const row = this.rows.find((r) => r.key === refString(v.ref));
    const mark = readMarkFor(v.ref, v.list, row ? row.machine : null, v.lastMark || null);
    if (!mark) return;
    v.markInFlight = true;
    try {
      const r = await this.call('POST', '/mobile/conversations/read', { json: { marks: [mark] } });
      if (r.gone) return;
      const res = r.ok && r.data && Array.isArray(r.data.results) ? r.data.results[0] : null;
      // A refused or unknown mark is not retried for this position; a pending one is retried when newer messages arrive.
      if (r.ok && (!res || res.ok || res.error === 'unknown-conversation')) v.lastMark = { atMs: mark.atMs, id: mark.id };
      if (r.ok && res && res.ok && v.live) this.loadList(false);
    } catch { /* @silent-fallback-ok — a read report is best-effort; the next new message reports again */ } finally { v.markInFlight = false; }
  }

  paintBubbles(v) {
    const atEnd = v.msgs.scrollHeight - v.msgs.scrollTop - v.msgs.clientHeight < 80;
    const want = new Set(v.list.map((b) => b.id));
    for (const [id, n] of v.nodes) if (!want.has(id)) { n.remove(); v.nodes.delete(id); }
    let prev = null;
    for (const b of v.list) {
      const sig = JSON.stringify([b.text, b.delivery && b.delivery.label, b.mark && b.mark.label, b.attachments.length, b.who]);
      let n = v.nodes.get(b.id);
      if (!n || n.dataset.sig !== sig) {
        const fresh = this.bubbleNode(v, b);
        fresh.dataset.sig = sig;
        if (n) n.replaceWith(fresh); else if (prev) prev.after(fresh); else v.msgs.prepend(fresh);
        v.nodes.set(b.id, fresh);
        n = fresh;
      } else if (prev ? prev.nextSibling !== n : v.msgs.firstChild !== n) {
        if (prev) prev.after(n); else v.msgs.prepend(n);
      }
      prev = n;
    }
    if (atEnd) this.scrollToEnd(v);
  }
  scrollToEnd(v, force) {
    if (!force && v.msgs.scrollTop > 0 && v.msgs.scrollHeight - v.msgs.scrollTop - v.msgs.clientHeight > 200) return;
    v.msgs.scrollTop = v.msgs.scrollHeight;
  }

  bubbleNode(v, b) {
    const meta = [];
    if (b.at) meta.push(el('span', { class: 'chat-time', text: shortTime(b.at) }));
    if (b.delivery) meta.push(el('span', { class: `chat-delivery tone-${b.delivery.tone}`, text: b.delivery.label }));
    if (b.mark) meta.push(el('span', { class: `chat-mark tone-${b.mark.tone}`, text: b.mark.label }));
    return el('div', { class: `chat-bubble chat-${b.side}`, 'data-id': b.id },
      b.who ? el('div', { class: 'chat-who', text: b.who }) : null,
      b.text ? el('div', { class: 'chat-text', text: b.text }) : null,
      b.attachments.length ? el('div', { class: 'chat-files' }, b.attachments.map((a) => this.attachmentNode(v, a))) : null,
      el('div', { class: 'chat-meta' }, meta));
  }

  async loadEarlier(v) {
    v.earlier.disabled = true;
    const before = v.ref.kind === 'telegram' ? (v.oldestTs ? String(v.oldestTs) : null) : v.nextBefore;
    this.spent();
    const keep = v.msgs.scrollHeight - v.msgs.scrollTop;
    const r = await this.call('GET', this.historyPath(v, { pool: v.ref.kind !== 'slack', before }));
    v.earlier.disabled = false;
    if (!v.live || r.gone || !r.ok) return;
    this.applyHistory(v, r.data, { earlier: true });
    v.msgs.scrollTop = v.msgs.scrollHeight - keep;
  }

  async rename(v, titleEl) {
    const input = el('input', { class: 'chat-input', type: 'text', maxlength: '80', value: titleEl.textContent, 'aria-label': 'Title' });
    const err = el('p', { class: 'unlock-error', role: 'alert' });
    const go = el('button', { class: 'btn-primary', type: 'submit', text: 'Rename' });
    const form = el('form', { class: 'pin-form' }, input, go, err);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const title = validTitle(input.value);
      if (!title) { err.textContent = 'Type a title of 1 to 80 characters.'; return; }
      go.disabled = true;
      const r = await this.call('PATCH', `/mobile/conversations/${encodeURIComponent(v.ref.id)}`, { json: { title, requestId: newRequestId(this.device.clock.now()) } });
      go.disabled = false;
      if (r.gone) { closeSheet(); return; }
      if (!r.ok) { err.textContent = (r.data && (r.data.detail || r.data.error)) || 'That did not work.'; return; }
      closeSheet();
      titleEl.textContent = (r.data && r.data.title) || title;
      this.loadList(false);
    });
    sheet({ title: 'Rename conversation' }, form);
  }

  async remove(v) {
    const go = el('button', { class: 'btn-primary', type: 'button', text: 'Delete' });
    const err = el('p', { class: 'unlock-error', role: 'alert' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      const r = await this.call('DELETE', `/mobile/conversations/${encodeURIComponent(v.ref.id)}`, { json: { requestId: newRequestId(this.device.clock.now()) } });
      if (r.gone) { closeSheet(); return; }
      if (!r.ok) { go.disabled = false; err.textContent = (r.data && (r.data.detail || r.data.error)) || 'That did not work.'; return; }
      closeSheet();
      this.rows = this.rows.filter((x) => x.key !== refString(v.ref));
      location.hash = '#/work/chats';
      this.loadList(false);
    });
    sheet({ title: 'Delete this conversation?' }, el('div', { class: 'pin-form' },
      el('p', { class: 'confirm-text', text: 'It is removed from every machine of this agent. This cannot be undone.' }), go, err));
  }

  // ── composer (§4.8) ──
  composer(v) {
    const canSend = !(v.ref.kind === 'telegram' && this.status && this.status.telegramSend === false);
    if (!canSend) return el('p', { class: 'card-line chat-readonly', text: 'Sending to Telegram works from the machine serving Telegram.' });
    const text = el('textarea', { class: 'chat-compose', rows: '2', placeholder: 'Message', 'aria-label': 'Message' });
    const send = el('button', { class: 'btn-primary chat-send', type: 'button', text: 'Send', disabled: true });
    const pick = el('input', { type: 'file', multiple: true, hidden: true, 'aria-label': 'Attach files' });
    const attach = el('button', { class: 'btn-quiet chat-attach', type: 'button', text: 'Attach' });
    const chosen = el('div', { class: 'chat-chosen' });
    const progress = el('progress', { class: 'chat-progress', max: '100', value: '0', hidden: true });
    v.files = [];
    const refresh = () => { send.disabled = !(text.value.trim() || v.files.length); };
    text.addEventListener('input', refresh);
    text.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); if (!send.disabled) send.click(); }
    });
    attach.addEventListener('click', () => pick.click());
    pick.addEventListener('change', () => {
      const files = Array.from(pick.files || []);
      pick.value = '';
      const all = [...v.files, ...files];
      const ok = checkFiles(all, this.status && this.status.limits);
      if (!ok.ok) { v.statusLine.textContent = ok.reason; return; }
      v.files = all;
      setKids(chosen, v.files.map((f, i) => {
        const x = el('button', { class: 'btn-quiet chat-unpick', type: 'button', text: '×', 'aria-label': `Remove ${f.name}` });
        x.addEventListener('click', () => { v.files.splice(i, 1); pick.dispatchEvent(new Event('change')); });
        return el('span', { class: 'chat-file-chip' }, el('span', { text: `${f.name} · ${humanSize(f.size)}` }), x);
      }));
      refresh();
    });
    send.addEventListener('click', async () => {
      const body = text.value.trim();
      const files = v.files.slice();
      if (!body && !files.length) return;
      if (body && detectCredentialShape(body).detected) {
        const choice = await credentialChoice();
        if (choice === 'drop') { location.hash = '#/people/secrets'; return; }
        if (choice !== 'send') return;
      }
      text.value = ''; v.files = []; setKids(chosen); refresh();
      this.send(v, body, files, progress, box);
    });
    const box = el('div', { class: 'chat-composer' }, chosen, progress, el('div', { class: 'chat-compose-row' }, attach, pick, text, send));
    return box;
  }

  async send(v, text, files, progress, box) {
    const record = this.device.record;
    const requestId = newRequestId(this.device.clock.now());
    const entry = { requestId, ref: refString(v.ref), text, uploads: [], firstSentAt: now(), deviceId: record.deviceId, machineId: record.machineId };
    const local = { id: `local:${requestId}`, messageId: null, side: 'right', who: null, text, at: new Date(this.device.clock.now()).toISOString(), attachments: files.map((f) => ({ sha256: '', filename: f.name, size: f.size, blobType: 'application/octet-stream', display: 'file' })), delivery: deliveryLabel('sending'), mark: null };
    v.sending++;
    box.setAttribute('data-interaction-open', '');
    this.setBubbles(v, mergeBubbles(v.list, [local]));
    this.scrollToEnd(v, true);
    try {
      if (files.length) {
        progress.hidden = false;
        const ups = await this.uploadAll(v, files, requestId, progress);
        progress.hidden = true;
        // warning-exempt: a delivery or signature state on the operator's own message, shown inside the open conversation where it is read and answered
        if (!ups) { this.finishLocal(v, local, { label: 'not delivered — a file could not be sent', tone: 'bad' }); return; }
        entry.uploads = ups;
      }
      saveUnfinished(entry);
      await this.deliver(v, entry, local);
    } finally {
      v.sending--;
      if (!v.sending) box.removeAttribute('data-interaction-open');
    }
  }

  sendPath(ref) {
    if (ref.kind === 'app') return `/mobile/chat/app/${encodeURIComponent(ref.id)}`;
    if (ref.kind === 'telegram') return `/mobile/chat/${encodeURIComponent(ref.id)}`;
    return `/mobile/chat/slack/${encodeURIComponent(ref.id)}`;
  }

  /** Sends until a final answer; retried only under the device that signed it (§4.8). */
  async deliver(v, entry, local) {
    let wait = 2000;
    for (;;) {
      const ref = parseConversationRef(entry.ref);
      const json = { text: entry.text || '', requestId: entry.requestId, ...(entry.uploads.length ? { attachments: entry.uploads } : {}) };
      const r = await this.call('POST', this.sendPath(ref), { json });
      if (r.gone) { this.finishLocal(v, local, deliveryLabel('unknown')); return; }
      const out = sendOutcome(r.status, r.data);
      if (r.ok && r.data && r.data.messageId) { local.messageId = String(r.data.messageId); rememberOwn(this.ownIds, entry.deviceId, local.messageId); }
      if (out.final) {
        dropUnfinished(entry.requestId);
        this.finishLocal(v, local, out.label);
        this.refreshOpen(v);
        return;
      }
      // 202 in-progress: the server is still delivering the first copy of this requestId (a reload or a
      // lost answer); ask again with the same requestId until a final answer names the message.
      if (r.ok && r.status !== 202) { dropUnfinished(entry.requestId); this.finishLocal(v, local, out.label, true); this.refreshOpen(v); return; }
      if (!this.live || !v.live) return; // kept in sessionStorage: retried when this conversation opens again here
      const ms = r.retryAfterMs || wait;
      wait = Math.min(wait * 2, 30_000);
      await new Promise((res) => this.later(res, ms));
      if (unfinishedAction(entry, { deviceId: this.device.record && this.device.record.deviceId, machineId: this.device.record && this.device.record.machineId, nowMs: this.device.clock.now() }) !== 'retry') {
        dropUnfinished(entry.requestId);
        this.finishLocal(v, local, deliveryLabel('unknown'));
        return;
      }
    }
  }
  finishLocal(v, local, label, pending) {
    local.delivery = label;
    local.final = !pending;
    if (v.live) this.setBubbles(v, mergeBubbles(v.list.filter((b) => b.id !== local.id), [{ ...local }]));
  }
  refreshOpen(v) { if (v.live) this.pollNow(v); }

  resumeUnfinished(v) {
    const rec = this.device.record;
    const mine = readUnfinished().filter((e) => e.ref === refString(v.ref));
    for (const e of mine) {
      const action = unfinishedAction(e, { deviceId: rec && rec.deviceId, machineId: rec && rec.machineId, nowMs: this.device.clock.now() });
      const local = { id: `local:${e.requestId}`, messageId: null, side: 'right', who: null, text: e.text, at: new Date(e.firstSentAt || now()).toISOString(), attachments: [], delivery: deliveryLabel(action === 'retry' ? 'sending' : 'unknown'), mark: null, final: action !== 'retry' };
      this.setBubbles(v, mergeBubbles(v.list, [local]));
      if (action === 'retry') this.deliver(v, e, local);
      else dropUnfinished(e.requestId); // shown as unknown, never re-sent
    }
  }
  clearUnfinished() { try { sessionStorage.removeItem(UNFINISHED_KEY); } catch { /* blocked */ } }

  /** Uploads each file (one at a time, chunks one at a time) → the signed attachment list, or null. */
  async uploadAll(v, files, requestId, progress) {
    const ref = mediaRefFor(v.ref, v.slackKey);
    if (!ref) { v.statusLine.textContent = 'Files cannot be sent here yet.'; return null; }
    const total = files.reduce((s, f) => s + f.size, 0) || 1;
    let done = 0;
    const out = [];
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const sha256 = await sha256Hex(bytes);
      const declaredType = f.type || 'application/octet-stream';
      const meta = { conversationRef: ref, size: f.size, sha256, declaredKind: declaredKindFor(declaredType), declaredType, filename: (f.name || 'file').slice(0, 255) };
      const start = await this.call('POST', '/mobile/media/uploads', { json: { ...meta, requestId: newRequestId(this.device.clock.now()) } });
      if (!start.ok || !start.data || !start.data.uploadId) { v.statusLine.textContent = (start.data && start.data.detail) || `${f.name} could not be sent.`; return null; }
      const chunk = Number(start.data.chunkSize) || (1024 * 1024);
      const have = new Set(Array.isArray(start.data.received) ? start.data.received : []);
      const count = Math.max(1, Math.ceil(f.size / chunk));
      for (let i = 0; i < count; i++) {
        if (!this.live) return null;
        if (!have.has(i)) {
          for (let attempt = 0; ; attempt++) {
            const part = bytes.subarray(i * chunk, Math.min(f.size, (i + 1) * chunk));
            const r = await this.call('PUT', `/mobile/media/uploads/${encodeURIComponent(start.data.uploadId)}/chunks/${i}`, { bytes: part });
            if (r.ok) break;
            if (r.gone || attempt >= 6 || (r.status !== 429 && r.status !== 0 && r.status < 500)) { v.statusLine.textContent = (r.data && r.data.detail) || `${f.name} could not be sent.`; return null; }
            await new Promise((res) => this.later(res, r.retryAfterMs || 2000));
          }
        }
        done += Math.min(chunk, f.size - i * chunk);
        progress.value = String(Math.round((done / total) * 100));
      }
      out.push({ uploadId: start.data.uploadId, ...meta });
    }
    return out.map(({ conversationRef: _c, ...a }) => a);
  }

  // ── media display (§4.8) ──
  attachmentNode(v, a) {
    const label = `${a.filename}${a.size ? ` · ${humanSize(a.size)}` : ''}`;
    const box = el('div', { class: `chat-file chat-file-${a.display}` });
    if (!a.sha256) { box.append(el('span', { class: 'chat-file-name', text: label })); return box; }
    const btn = el('button', { class: 'btn-quiet chat-file-load', type: 'button', text: a.display === 'image' ? 'Loading image…' : a.display === 'file' ? `Download ${label}` : `Play ${label}` });
    box.append(btn);
    const load = () => this.queueMedia(v, a, box, btn);
    btn.addEventListener('click', load);
    if (a.display === 'image') {
      if (typeof IntersectionObserver === 'function') {
        if (!this.observer) this.observer = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) { this.observer.unobserve(e.target); const f = e.target.__chatLoad; if (f) f(); } });
        box.__chatLoad = load;
        this.observer.observe(box);
      } else load();
    }
    return box;
  }

  queueMedia(v, a, box, btn) {
    if (box.__loading) return;
    box.__loading = true;
    v.mediaQueue.push({ a, box, btn, started: now() });
    this.pumpMedia(v);
  }
  async pumpMedia(v) {
    while (v.live && v.mediaInFlight < 3 && v.mediaQueue.length) {
      const job = v.mediaQueue.shift();
      v.mediaInFlight++;
      this.fetchMedia(v, job).finally(() => { v.mediaInFlight--; if (v.live) this.pumpMedia(v); });
    }
  }
  async fetchMedia(v, job) {
    const { a, box, btn } = job;
    const cached = v.media.get(a.sha256);
    if (cached) { this.showMedia(a, box, btn, cached); return; }
    const ref = mediaRefFor(v.ref, v.slackKey);
    if (!ref) { btn.textContent = 'Not available here'; return; }
    let r;
    try { r = await this.device.signedFetch('GET', `/mobile/media/${encodeURIComponent(a.sha256)}?ref=${encodeURIComponent(ref)}`, { signal: v.abort.signal }); } catch { box.__loading = false; btn.textContent = 'Retry'; return; }
    if (!v.live) return;
    if (r.status === 202) {
      const d = await r.json().catch(() => ({}));
      if (now() - job.started > 60_000) { box.__loading = false; btn.textContent = 'Still copying from another machine — Retry'; return; }
      btn.textContent = 'Copying from another machine…';
      this.later(() => { v.mediaQueue.push(job); this.pumpMedia(v); }, Number(d.retryAfterMs) || 2000);
      return;
    }
    if (r.status === 429) { const ra = Number(r.headers.get('Retry-After')); this.later(() => { v.mediaQueue.push(job); this.pumpMedia(v); }, Number.isFinite(ra) ? ra * 1000 : 2000); return; }
    if (r.status === 401) { box.__loading = false; await this.handle401(); return; }
    if (!r.ok) { box.__loading = false; btn.textContent = 'Not available — Retry'; return; }
    // Only the allowlisted types become viewable; the blob's type comes from that list, never the response.
    const blob = new Blob([await r.arrayBuffer()], { type: blobTypeFor(a.blobType) });
    if (!v.live) return;
    const url = URL.createObjectURL(blob);
    this.blobUrls.add(url);
    v.media.set(a.sha256, url);
    this.showMedia(a, box, btn, url);
  }
  showMedia(a, box, btn, url) {
    let node;
    if (a.display === 'image') node = el('img', { class: 'chat-img', src: url, alt: a.filename });
    else if (a.display === 'video') node = el('video', { class: 'chat-video', src: url, controls: true });
    else if (a.display === 'audio') node = el('audio', { class: 'chat-audio', src: url, controls: true });
    else node = el('a', { class: 'btn-quiet chat-download', href: url, download: a.filename, text: `Save ${a.filename}` });
    btn.replaceWith(node);
    if (a.display === 'file') node.click();
  }

  // ── one poller per browser (§4.8) ──
  post(msg) { if (this.channel) { try { this.channel.postMessage(msg); } catch { /* closed */ } } }
  spent() { if (this.leader) this.scheduler.spend(now()); else this.post({ type: 'spent', at: now() }); }

  startPolling() {
    if (this.channel || this.announceTimer) return;
    if (typeof BroadcastChannel === 'function') {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (ev) => this.onMessage(ev.data || {});
    }
    this.onVisibility = () => {
      if (document.visibilityState === 'visible') { this.announce(); this.seekLeadership(); }
      else { this.post({ type: 'withdraw', tab: this.tabId }); this.releaseLeadership(); }
    };
    this.onFocus = () => { this.focusedAt = now(); this.announce(); if (this.view) { this.pollNow(this.view); this.maybeMarkRead(this.view); } };
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('focus', this.onFocus);
    this.announceTimer = setInterval(() => { if (this.live && document.visibilityState === 'visible') this.announce(); }, ANNOUNCE_EVERY_MS);
    this.announce();
    if (document.visibilityState === 'visible') this.seekLeadership();
  }

  myAnnouncement() {
    return { type: 'announce', tab: this.tabId, ref: this.view ? refString(this.view.ref) : null, at: now(), focusedAt: this.focusedAt, focused: Boolean(document.hasFocus && document.hasFocus()) };
  }
  announce() {
    if (!this.live || document.visibilityState !== 'visible') return;
    const a = this.myAnnouncement();
    this.announcements.set(this.tabId, a);
    this.post(a);
    if (this.leader) this.replan();
  }

  onMessage(m) {
    if (!this.live) return;
    if (m.type === 'announce' && m.tab) { this.announcements.set(m.tab, m); if (this.leader) this.replan(); }
    else if (m.type === 'withdraw' && m.tab) { this.announcements.delete(m.tab); if (this.leader) this.replan(); }
    else if (m.type === 'who') this.announce();
    else if (m.type === 'spent' && this.leader) this.scheduler.spend(Number(m.at) || now());
    else if (m.type === 'result') this.applyResult(m);
  }

  seekLeadership() {
    if (this.leader || this.lockAbort || !this.live || !this.pageEl) return;
    const locks = globalThis.navigator && globalThis.navigator.locks;
    if (!locks || typeof locks.request !== 'function') { this.becomeLeader(null); return; }
    this.lockAbort = new AbortController();
    locks.request(POLL_LOCK, { signal: this.lockAbort.signal }, () => new Promise((release) => {
      if (!this.live || document.visibilityState !== 'visible') { release(); return; }
      this.becomeLeader(release);
    })).catch(() => { /* aborted: this tab went hidden or left */ }).finally(() => { this.lockAbort = null; });
  }
  becomeLeader(release) {
    this.leader = true;
    this.releaseLock = release;
    this.scheduler = createScheduler();
    if (this.lastBackoff) this.scheduler.restore(this.lastBackoff);
    this.post({ type: 'who' });
    this.replan();
    this.loop();
  }
  releaseLeadership() {
    if (this.lockAbort) { try { this.lockAbort.abort(); } catch { /* done */ } this.lockAbort = null; }
    if (this.loopTimer) { clearTimeout(this.loopTimer); this.loopTimer = null; }
    this.leader = false;
    if (this.releaseLock) { const r = this.releaseLock; this.releaseLock = null; r(); }
  }

  replan() {
    const t = now();
    const anns = [...this.announcements.values()].filter((a) => a.ref);
    const refs = pollUnion(anns, t);
    this.union = refs;
    const items = refs.map((r) => { const p = parseConversationRef(r); return p ? { ref: r, kind: p.kind, fallback: this.fallbacks && this.fallbacks.has(r) } : null; }).filter(Boolean);
    this.scheduler.setConversations(items, t);
    this.post({ type: 'result', union: refs });
    this.markPaused();
  }
  markPaused() {
    if (!this.view) return;
    const mine = refString(this.view.ref);
    this.view.paused.hidden = !this.union.length || this.union.includes(mine);
  }

  loop() {
    if (!this.leader || !this.live) return;
    if (this.loopTimer) { clearTimeout(this.loopTimer); this.loopTimer = null; }
    const n = this.scheduler.next(now(), { visible: document.visibilityState === 'visible' });
    if (n.task) { this.runTask(n.task); return; }
    if (n.waitMs != null) this.loopTimer = setTimeout(() => { this.loopTimer = null; this.loop(); }, Math.max(50, n.waitMs));
  }

  taskPath(task) {
    if (task.mode === 'list') return '/mobile/conversations?scope=pool&limit=50';
    const ref = parseConversationRef(task.ref);
    if (task.mode === 'events') { const c = this.cursors.get(task.ref); return `/mobile/chat/app/${encodeURIComponent(ref.id)}/events?limit=100${c ? `&cursor=${encodeURIComponent(c)}` : ''}`; }
    const v = { ref };
    if (task.mode === 'fallback') return this.historyPath(v, { pool: true });
    if (task.mode === 'pool') return this.historyPath(v, { pool: ref.kind === 'telegram' });
    return this.historyPath(v, { pool: false });
  }

  async runTask(task) {
    const t0 = now();
    this.scheduler.start(task, t0);
    let r;
    try { r = await this.call('GET', this.taskPath(task)); } catch { r = { ok: false, status: 0 }; }
    if (!this.live) return;
    this.scheduler.finish(task, now(), { status: r.status, retryAfterMs: r.retryAfterMs });
    if (r.gone) return;
    if (task.mode === 'events' && r.status === 404) {
      (this.fallbacks || (this.fallbacks = new Set())).add(task.ref);
      this.scheduler.fallBack(task.ref, now());
    } else if (task.mode === 'fallback' && r.ok && this.fallbacks && this.fallbacks.has(task.ref) && Math.random() < 0.25) {
      // Every few pool reads, try the events route again: it answers once the conversation is stored here.
      this.fallbacks.delete(task.ref);
      this.scheduler.recover(task.ref, now());
    }
    if (r.ok) {
      const msg = { type: 'result', mode: task.mode, ref: task.ref, data: r.data, backoff: this.scheduler.snapshot(), union: this.union };
      if (task.mode === 'events' && r.data && typeof r.data.cursor === 'string') {
        this.cursors.set(task.ref, r.data.cursor);
        msg.cursor = r.data.cursor;
        // Behind by a full page: read the next one at once (still inside the budget).
        if (Array.isArray(r.data.events) && r.data.events.length >= 100) this.scheduler.bump(task.ref, now());
      }
      this.post(msg);
      this.applyResult(msg);
    } else this.post({ type: 'result', backoff: this.scheduler.snapshot(), union: this.union });
    this.loop();
  }

  applyResult(m) {
    if (Array.isArray(m.backoff)) this.lastBackoff = m.backoff;
    if (Array.isArray(m.union)) { this.union = m.union; this.markPaused(); }
    if (m.cursor && m.ref) this.cursors.set(m.ref, m.cursor);
    if (!m.mode || !m.data) return;
    if (m.mode === 'list') { this.applyList(m.data, false); return; }
    const v = this.view;
    if (!v || refString(v.ref) !== m.ref || !v.live) return;
    if (m.mode === 'events') { const since = v.list.find((b) => !b.id.startsWith('local:'))?.at || null; this.setBubbles(v, applyEvents(v.list, m.data.events, { own: this.ownCheck(), since })); }
    else this.applyHistory(v, m.data);
  }

  /** The focused tab's conversation: read now (an operator-caused read, counted in the budget). */
  async pollNow(v) {
    if (!v || !v.live) return;
    const ref = refString(v.ref);
    if (this.leader && this.scheduler.tasks().some((t) => t.ref === ref && t.mode !== 'pool')) { this.scheduler.bump(ref, now()); this.loop(); return; }
    this.spent();
    const r = await this.call('GET', this.historyPath(v, { pool: v.ref.kind !== 'slack' }));
    if (r.ok && v.live) this.applyHistory(v, r.data);
  }
}

// ── small helpers ──
function shortTime(isoText) {
  const t = Date.parse(isoText);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const same = new Date().toDateString() === d.toDateString();
  return same ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function credentialChoice() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); closeSheet(); } };
    const drop = el('button', { class: 'btn-primary', type: 'button', text: 'Use a Secret Drop link' });
    const send = el('button', { class: 'btn-quiet', type: 'button', text: 'Send as written' });
    drop.addEventListener('click', () => finish('drop'));
    send.addEventListener('click', () => finish('send'));
    sheet({ title: 'This looks like a password or key', onClose: () => { if (!done) { done = true; resolve('cancel'); } } },
      el('div', { class: 'pin-form' }, el('p', { class: 'confirm-text', text: CREDENTIAL_QUESTION }), el('div', { class: 'confirm-row' }, drop, send)));
  });
}

function readUnfinished() {
  try { const v = JSON.parse(sessionStorage.getItem(UNFINISHED_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveUnfinished(entry) {
  try { const list = readUnfinished().filter((e) => e.requestId !== entry.requestId); list.push(entry); sessionStorage.setItem(UNFINISHED_KEY, JSON.stringify(list.slice(-50))); } catch { /* blocked: the send still runs */ }
}
function dropUnfinished(requestId) {
  try { sessionStorage.setItem(UNFINISHED_KEY, JSON.stringify(readUnfinished().filter((e) => e.requestId !== requestId))); } catch { /* blocked */ }
}

function loadOwn(deviceId) {
  if (!deviceId) return new Set();
  try { const v = JSON.parse(localStorage.getItem(OWN_KEY + deviceId) || '[]'); return new Set(Array.isArray(v) ? v.map(String) : []); } catch { return new Set(); }
}
function rememberOwn(set, deviceId, messageId) {
  set.add(messageId);
  try { localStorage.setItem(OWN_KEY + deviceId, JSON.stringify([...set].slice(-500))); } catch { /* blocked: the mark falls back to "signed from a browser" */ }
}
