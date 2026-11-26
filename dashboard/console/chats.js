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

import { compareConversationActivity, conversationRefKey, conversationTreePreferences, hasAuthoritativeSections, renderOwnerTree, treeConversationRow, treePage } from './conversation-tree.js';
import { el, setKids, sheet, closeSheet, askPin, forgetOperatorSession, operatorSession } from './ui.js';
import {
  createBrowserDevice, consolePathAllowed, secureContextOk, newRequestId, sha256Hex, DELETED_REASON, refusalWords, readRecord, readAllRecords, deleteRecord,
} from './browser-device.js';
import {
  parseConversationRef, refString, refFromQuery, messageFromQuery, hashFor, listRows, listMeta, mergeListPages, validTitle,
  bubbles, mergeBubbles, applyEvents, deliveryLabel, mediaRefFor, declaredKindFor, checkFiles, humanSize,
  UNFINISHED_KEY, unfinishedAction, sendOutcome, pollUnion, createScheduler, ANNOUNCE_EVERY_MS, readMarkFor, telegramReadOnlyNote,
  setupRefusal, approvalWords, privateChatWords, blobTypeFor, listPinned, orderWithTree,
  pinsFrom, pinBarText, nextPinIndex, pinIdOf, pinsPathOf, pinOutcomeWords,
  listPinnedRows, listPinRefOf, splitPinned, listPinOutcomeWords, messageTime, messagePieces,
  LIST_VIEW_KEY, listViewFrom, HIERARCHY_MAX_PAGES, hierarchyIndex, groupRows, groupCountWords,
  effortMembers, trackedProjects, projectsForGroups, groupSections, rebuildQuickPage,
} from './chats-model.js';

/**
 * A message's text with its inline markdown shown as styling (bold, italic, code, strike, web links).
 * Built from text nodes and elements only: message text is untrusted, so it never goes through HTML.
 */
export function messageTextNode(text) {
  return el('div', { class: 'chat-text' }, messagePieces(text).map((p) => {
    let n = p.code ? el('code', { class: 'chat-code', text: p.text }) : document.createTextNode(p.text);
    if (p.strike) n = el('s', {}, n);
    if (p.italic) n = el('em', {}, n);
    if (p.bold) n = el('strong', {}, n);
    if (p.url) n = el('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, n);
    return n;
  }));
}
import { chiefOfStaffNeedRows, chiefOfStaffCardRows } from './needs-model.js';
import { appStripFor, appPath, appNavigation } from './projects-model.js';
import { detectCredentialShape, CREDENTIAL_QUESTION } from './credential-shape.js';

const TOKEN_KEY = 'instar_token';
const POLL_LOCK = 'instar-chat-poll';
const CHANNEL = 'instar-chat';
const OWN_KEY = 'instar_chat_own:';
const OFF_TEXT = 'Conversations in the dashboard are switched off on this agent.';
// The hierarchy is read again at most this often (the list itself refreshes every 30 s).
const HIERARCHY_TTL_MS = 60000;

const bearer = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
const now = () => Date.now();

// Project apps (docs/specs/project-apps.md §3.5): the projects read behind the conversation's app
// strip, kept for 30 s and shared by every conversation opened meanwhile. A failed read is no strip.
const PROJECTS_TTL_MS = 30000;
let projectsCache = null; // { at, data } | { at, pending: Promise }
function projectsForStrip() {
  if (projectsCache && now() - projectsCache.at < PROJECTS_TTL_MS) return projectsCache.pending || Promise.resolve(projectsCache.data);
  const pending = fetch('/work/projects', { headers: { Authorization: `Bearer ${bearer()}` }, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((data) => { projectsCache = data ? { at: now(), data } : null; return data; });
  projectsCache = { at: now(), pending };
  return pending;
}

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
    this.quickPages = new Map(); // ref → complete quick-page rows and their server-issued hashes
    this.leader = false;
    this.union = [];
    this.scheduler = createScheduler();
    this.retries401 = 0;
    // The list grouped by the conversation hierarchy: null until (and unless) the hierarchy read answers.
    this.hierarchy = null;
    this.ownerTree = [];
    this.treePreferences = conversationTreePreferences();
    this.hierarchyAt = 0;
    this.hierarchyLoading = false;
    this.groupProjects = new Map(); // effort key → the tracked project it is (Chief of Staff projects); empty → plain groups
    this.listView = (() => { try { return listViewFrom(localStorage.getItem(LIST_VIEW_KEY)); } catch { return 'grouped'; } })();
    this.openGroups = new Set();
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
    void this.loadChiefOfStaffNeeds().then(() => { if (this.live) this.refreshNeedCard(); });
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

  // ── Chief of Staff (chief-of-staff-topic.md §1.4/§5): what its projects need from the owner leads this page,
  // in place, with the action (open the Chief of Staff conversation). Same rows as the Needs-you list (needs-model.js).
  async loadChiefOfStaffNeeds() {
    this.cosNeeds = []; this.cosRef = null;
    try {
      const r = this.ctx && this.ctx.get ? await this.ctx.get('/chief-of-staff') : await this.call('GET', '/chief-of-staff');
      const rows = chiefOfStaffNeedRows(r, now());
      this.cosNeeds = Array.isArray(rows) ? rows : [];
      const key = r && r.ok && r.data && typeof r.data.conversationKey === 'string' ? r.data.conversationKey : null;
      this.cosRef = key ? parseConversationRef(key) : null;
      this.cosName = r && r.ok && r.data && typeof r.data.displayName === 'string' ? r.data.displayName : 'Chief of Staff';
    } catch { this.cosNeeds = []; }
  }
  /** The slot the card renders into — one element for the page's life, so a late answer lands in place without a repaint. */
  needCard() {
    if (!this.needSlot) this.needSlot = el('div', { class: 'cos-need-slot' });
    this.refreshNeedCard();
    return this.needSlot;
  }
  refreshNeedCard() {
    if (!this.needSlot) return;
    // The Needs-you list above this page already shows each project's wait; then only the check-in stays here.
    const stripShown = typeof document !== 'undefined' && !!document.querySelector('#needsStrip:not([hidden])');
    const rows = chiefOfStaffCardRows(this.cosNeeds, { stripShown });
    if (!rows.length) { setKids(this.needSlot); return; }
    const lead = rows[0];
    const more = rows.length - 1;
    const open = el('a', { class: 'btn-primary', href: this.cosRef ? hashFor(this.cosRef) : '#/work/chats', text: `Open ${this.cosName || 'Chief of Staff'}` });
    const checkIn = el('button', { class: 'btn-quiet', type: 'button', text: 'Check in' });
    checkIn.addEventListener('click', () => this.checkInWithChiefOfStaff(checkIn));
    setKids(this.needSlot, el('div', { class: 'need-card', 'data-operator-need': 'chief-of-staff' },
      el('p', { class: 'need-title', text: lead.main }),
      lead.sub ? el('p', { class: 'card-line', text: lead.sub }) : null,
      more > 0 ? el('p', { class: 'card-line chat-muted', text: `+${more} more in the Chief of Staff conversation` }) : null,
      el('div', { class: 'chat-list-actions' }, open, checkIn)));
  }
  /** §4: the dashboard check-in — a PIN prompt, one POST, the PIN not kept. */
  async checkInWithChiefOfStaff(button) {
    const pin = await askPin({ title: `Check in with your ${this.cosName || 'Chief of Staff'}`, explain: 'This tells it you are still around, so it may keep restarting and closing work for the next few days. Your PIN is used for this one request and not kept.', adapter: 'body' });
    if (!pin) return;
    const token = (() => { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } })();
    let r;
    try {
      const res = await fetch('/chief-of-staff/check-in', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Instar-Request': '1' }, body: JSON.stringify({ pin: pin.pin }) });
      r = { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    } catch { r = { ok: false, status: 0, data: {} }; }
    pin.pin = '';
    const status = el('p', { class: 'action-status', role: 'status', text: r.ok ? 'Checked in. It stays awake for the next few days.' : r.status === 403 ? 'That PIN was not accepted.' : r.status === 503 ? 'The Chief of Staff is not switched on here.' : (r.data && r.data.error) || `The server answered ${r.status || 'nothing'}.` });
    sheet({ title: 'Check in' }, status);
    if (r.ok) { await this.loadChiefOfStaffNeeds(); this.refreshNeedCard(); }
    if (button) button.disabled = false;
  }

  // ── simple states ──
  shell(...kids) { setKids(this.main, el('div', { class: 'chats-page chat-state' }, this.needCard(), el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Work · Conversations' }), el('h1', { class: 'page-title', text: 'Conversations' })), ...kids)); }
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
    const how = path === 'telegram' && this.status && this.status.ownerPhoneApproves
      ? 'You will approve this browser on your iPhone with Face ID (a Telegram message comes too, as a backup).'
      : path === 'telegram'
      ? `You will approve this browser in ${privateChatWords(this.status && this.status.approvalChat)}, or on your phone.`
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
      el('p', { class: 'card-line', text: approvalWords(a.approval, this.status && this.status.approvalChat, a.telegramBackup) }),
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
    this.moreBtn.addEventListener('click', () => {
      if (this.ownerTree.length && this.listView === 'grouped') void this.loadHierarchy(true, true);
      else void this.loadList(true);
    });
    this.failedEl = el('p', { class: 'card-line chat-muted', hidden: true });
    this.listPinNoteEl = el('p', { class: 'unlock-error chat-list-pin-note', role: 'alert', hidden: true });
    // Grouped | All: shown only once the hierarchy has answered; the choice is remembered in this browser.
    this.viewChips = { grouped: el('button', { class: 'chip', type: 'button', text: 'Grouped' }), all: el('button', { class: 'chip', type: 'button', text: 'Flat' }) };
    for (const [view, chip] of Object.entries(this.viewChips)) chip.addEventListener('click', () => this.setListView(view));
    this.viewToggleEl = el('div', { class: 'chat-view-toggle', role: 'group', 'aria-label': 'Show conversations', hidden: true }, this.viewChips.grouped, this.viewChips.all);
    this.viewToggleEl.append(this.treePreferences.sortControl(() => this.paintList()));
    const newBtn = el('button', { class: 'btn-primary chat-new', type: 'button', text: 'New conversation' });
    newBtn.addEventListener('click', () => this.newConversation());
    const forget = el('button', { class: 'btn-quiet chat-forget', type: 'button', text: 'Forget this browser' });
    forget.addEventListener('click', () => this.forgetBrowser());
    this.viewEl = el('div', { class: 'chat-view' }, el('p', { class: 'chat-pick', text: 'Pick a conversation.' }));
    this.pageEl = el('div', { class: 'chats-page' },
      el('div', { class: 'chat-list' },
        this.needCard(),
        el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Work · Conversations' }), el('h1', { class: 'page-title', text: 'Conversations' })),
        skew ? el('p', { class: 'card-line chat-note', text: `Your computer's clock is ${Math.abs(skew)} minutes off.` }) : null,
        el('div', { class: 'chat-list-actions' }, newBtn, forget),
        this.viewToggleEl, this.listPinNoteEl, this.listEl, this.moreBtn, this.failedEl),
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
    if (!more) this.pinnedKey = (listPinned(data) || {}).key || null; // the first page carries the Chief of Staff pin (§1.4); a later page keeps it
    // Conversations this person pinned (conversation-list-pins): the first page carries them; null ⇒ the feature is off here.
    if (!more) this.listPins = listPinnedRows(data);
    if (more) { this.pagedMore = true; this.rows = mergeListPages(this.rows, rows); }
    // A refresh of the first page replaces it; pages the operator opened with "Show more" are kept below.
    else this.rows = this.pagedMore ? mergeListPages(rows, this.rows) : rows;
    const meta = listMeta(data);
    this.meta = more || !this.pagedMore ? meta : { ...meta, nextCursor: this.meta.nextCursor };
    this.paintList();
    if (!more) void this.loadHierarchy();
  }

  /**
   * The conversation hierarchy behind the grouped list: every node (view=all), read signed by this
   * browser; with a PIN unlock already in this page, the dashboard route is tried when the signed read
   * is refused. Refused / missing / off (403, 404, 503) → no hierarchy: the list is flat, exactly as
   * before. Any other failure keeps the last answer, so a blip never reshuffles the list.
   */
  async loadHierarchy(force = false, moreTree = false) {
    if (this.hierarchyLoading || (!force && now() - this.hierarchyAt < HIERARCHY_TTL_MS)) return;
    this.hierarchyLoading = true;
    try {
      const requested = moreTree ? this.ownerTree.at(-1)?.nextCursor : null;
      if (moreTree && !requested) return;
      const treeResult = await this.call('GET', `/mobile/conversation-graph/tree${requested ? `?cursor=${encodeURIComponent(requested)}` : ''}`);
      if (!this.live || treeResult.gone) return;
      const tree = treeResult.ok ? treePage(treeResult.data) : null;
      if (hasAuthoritativeSections(tree)) {
        if (tree.nextCursor === requested && requested) tree.nextCursor = null;
        this.ownerTree = moreTree ? [...this.ownerTree, tree] : [tree];
        this.hierarchyAt = now();
        this.paintList();
        return;
      }
      if (moreTree) {
        if (treeResult.status === 409) queueMicrotask(() => void this.loadHierarchy(true));
        else {
          this.failedEl.hidden = false;
          this.failedEl.textContent = 'More groups could not be loaded. Try again.';
        }
        return;
      }
      if (this.ownerTree.length && ![401, 403, 404, 503].includes(treeResult.status)) {
        // Keep the preceding authorized projection over a transient read failure.
        this.failedEl.hidden = false;
        this.failedEl.textContent = 'The conversation tree could not be refreshed.';
        return;
      }
      this.ownerTree = [];
      let r = await this.readHierarchy((path) => this.call('GET', `/mobile${path}`));
      if (!this.live || r.gone) return;
      if (!r.ok && r.status === 403 && operatorSession()) r = await this.readHierarchy((path) => dashboardRead(path));
      if (!this.live) return;
      this.hierarchyAt = now();
      if (r.ok) {
        this.hierarchy = hierarchyIndex(r.pages);
        // Which groups are tracked projects: a failed projects read leaves every group plain.
        const projects = this.hierarchy ? trackedProjects(await projectsForStrip()) : null;
        if (!this.live) return;
        this.groupProjects = projectsForGroups(this.hierarchy ? effortMembers(r.pages) : null, projects);
      } else if ([403, 404, 503].includes(r.status)) { this.hierarchy = null; this.groupProjects = new Map(); }
      this.paintList();
    } finally { this.hierarchyLoading = false; }
  }
  async readHierarchy(get) {
    this.spent();
    const pages = [];
    let cursor = null;
    for (let i = 0; i < HIERARCHY_MAX_PAGES; i++) {
      const r = await get(`/conversation-graph/roots?view=all${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!this.live || r.gone) return { ok: false, gone: true };
      if (!r.ok) return { ok: false, status: r.status };
      pages.push(r.data);
      cursor = r.data && typeof r.data.nextCursor === 'string' && r.data.nextCursor ? r.data.nextCursor : null;
      if (!cursor) break;
    }
    return { ok: true, pages };
  }
  setListView(view) {
    this.listView = listViewFrom(view);
    try { localStorage.setItem(LIST_VIEW_KEY, this.listView); } catch { /* blocked: the choice lasts for this page */ }
    this.paintList();
  }
  toggleGroup(key) {
    if (this.openGroups.has(key)) this.openGroups.delete(key); else this.openGroups.add(key);
    this.paintList();
  }
  paintList() {
    if (!this.listEl) return;
    const open = this.view ? refString(this.view.ref) : '';
    if (this.view && this.view.titleEl) {
      const row = this.rows.find((r) => r.key === open);
      if (row) { this.view.titleEl.textContent = row.title; this.view.titleEl = null; }
    }
    // Grouped | All: the toggle shows only when the hierarchy answered; without it the list is the full flat list.
    if (this.listView === 'grouped' && this.hierarchyAt === 0) {
      // Flat rows arrive first. Do not show pinned project descendants as loose
      // conversations while their authoritative placement is still loading.
      setKids(this.listEl, el('p', { class: 'card-line chat-muted', role: 'status', text: 'Loading conversation tree…' }));
      this.moreBtn.hidden = true;
      return;
    }
    const grouped = (this.ownerTree.length > 0 || Boolean(this.hierarchy)) && this.listView === 'grouped';
    if (this.viewToggleEl) {
      this.viewToggleEl.hidden = !this.hierarchy && !this.ownerTree.length;
      this.viewChips.all.textContent = this.ownerTree.length ? 'Flat' : 'All';
      this.viewToggleEl.querySelector('select').hidden = !this.ownerTree.length;
      for (const [view, chip] of Object.entries(this.viewChips)) chip.setAttribute('aria-pressed', String(view === (grouped ? 'grouped' : 'all')));
    }
    if (grouped && this.ownerTree.length) {
      const byKey = new Map(this.rows.map(row => [row.key, row]));
      const details = (node) => el('a', { class: 'link-btn', href: `#/work/conversations?node=${encodeURIComponent(node.key)}`, text: 'See more in this group' });
      const nodes = renderOwnerTree(this.ownerTree, {
        preferences: this.treePreferences,
        conversationRow: (node) => {
          const ref = parseConversationRef(conversationRefKey(node.ref));
          if (!ref) return el('a', { class: 'row chat-row', href: `#/work/conversations?node=${encodeURIComponent(node.key)}`, text: node.title });
          const row = byKey.get(refString(ref));
          return treeConversationRow(el('a', { class: `row chat-row${refString(ref) === open ? ' open' : ''}`, href: hashFor(ref) },
            el('span', { class: 'chat-row-main' },
              el('span', { class: 'chat-row-title', text: row?.title || node.title }),
              row?.preview ? el('span', { class: 'chat-row-preview', text: row.preview }) : null),
            row?.unread > 0 && refString(ref) !== open ? el('span', { class: 'chat-unread', text: String(row.unread), 'aria-label': `${row.unread} unread` }) : null), row?.title || node.title, row?.lastActivity || node.freshness);
        },
        groupDetails: details,
      });
      setKids(this.listEl, nodes.length ? nodes : el('p', { class: 'card-line chat-muted', text: 'No conversations yet.' }));
    } else if (!this.rows.length) { setKids(this.listEl, el('p', { class: 'card-line chat-muted', text: 'No conversations yet.' })); }
    else {
      const pinsOn = Array.isArray(this.listPins);
      const { pinned, rest } = splitPinned(this.rows, pinsOn ? this.listPins : []);
      const rowEl = (r, isPinned) => {
        const link = el('a', { class: `row chat-row${r.key === open ? ' open' : ''}${r.key === this.pinnedKey ? ' chat-pinned' : ''} chat-depth-${isPinned ? 0 : Math.min(r.depth || 0, 3)}`, href: hashFor(r.ref), role: 'listitem' },
          el('span', { class: 'chat-row-main' },
            el('span', { class: 'chat-row-top' }, el('span', { class: 'chat-row-title', text: r.title }), el('span', { class: `chat-kind chat-kind-${r.kind}`, text: r.kindLabel })),
            el('span', { class: 'chat-row-preview', text: r.preview || ' ' })),
          el('span', { class: 'chat-row-side' },
            r.lastActivity ? el('span', { class: 'chat-row-time', text: shortTime(r.lastActivity) }) : null,
            // The conversation on screen is being read (and reported read, which clears the count on the phone too): no badge for it.
            r.unread > 0 && r.key !== open ? el('span', { class: 'chat-unread', text: String(r.unread), 'aria-label': `${r.unread} unread` }) : null));
        if (!pinsOn || !listPinRefOf(r)) return link;
        const btn = el('button', { class: `btn-quiet chat-list-pin${isPinned ? ' chat-list-unpin' : ''}`, type: 'button', text: isPinned ? 'Unpin' : 'Pin', 'aria-label': `${isPinned ? 'Unpin' : 'Pin'} ${r.title}` });
        btn.addEventListener('click', () => this.setListPin(r, !isPinned, btn));
        return el('div', { class: 'chat-row-wrap' }, link, btn);
      };
      const kids = [];
      if (pinned.length && !this.ownerTree.length) {
        kids.push(el('div', { class: 'chat-group-label chat-pinned-group', text: 'Pinned' }));
        for (const r of pinned) kids.push(rowEl(r, true));
        if (!grouped) kids.push(el('div', { class: 'chat-group-label', text: 'All conversations' }));
      }
      if (grouped) {
        const { lead, groups, ungrouped } = groupRows(rest, this.hierarchy, this.pinnedKey);
        if (lead) kids.push(rowEl(lead, false));
        // Two sections, as on the iPhone: "Projects" (groups linked to a tracked project) and "Groups" (plain groups).
        // A group with no conversations is never shown; an empty section has no header.
        const sections = groupSections(groups, this.groupProjects);
        const groupEl = (g) => {
          // The group holding the open conversation stays open, so the row on screen is never hidden.
          const expanded = this.openGroups.has(g.key) || g.rows.some((r) => r.key === open);
          // A tracked project (Chief of Staff) gets the project mark and its status chip; a plain group keeps the folder and count.
          const project = g.project;
          const label = [project ? `Project ${g.displayTitle}` : `Group ${g.displayTitle}`, project && project.status ? project.status.label : null, groupCountWords(g.count), g.unread > 0 ? `${g.unread} unread` : null].filter(Boolean).join(', ');
          const head = el('button', { class: `chat-effort-row${project ? ' chat-project-row' : ''}${expanded ? ' expanded' : ''}`, type: 'button', 'aria-expanded': expanded ? 'true' : 'false', 'aria-label': label },
            el('span', { class: `chat-group-icon${project ? ' chat-group-icon-project' : ''}`, icon: project ? 'flag' : 'folder' }),
            el('span', { class: 'chat-row-main' },
              el('span', { class: 'chat-row-top' },
                el('span', { class: 'chat-row-title', text: g.displayTitle }),
                project && project.status ? el('span', { class: `chat-project-status tone-${project.status.tone}`, text: project.status.label }) : null),
              el('span', { class: 'chat-row-preview', text: groupCountWords(g.count) })),
            el('span', { class: 'chat-row-side' },
              g.lastActivity ? el('span', { class: 'chat-row-time', text: shortTime(g.lastActivity) }) : null,
              g.unread > 0 ? el('span', { class: 'chat-unread', text: String(g.unread), 'aria-label': `${g.unread} unread` }) : null),
            el('span', { class: 'chat-effort-chev', 'aria-hidden': 'true', text: '›' }));
          head.addEventListener('click', () => this.toggleGroup(g.key));
          kids.push(head);
          if (expanded) {
            if (project) kids.push(el('a', { class: 'link-btn chat-open-project', href: project.href, text: 'Open project' }));
            for (const r of g.rows) kids.push(rowEl(r, false));
          }
        };
        if (sections.projects.length) kids.push(el('div', { class: 'chat-group-label chat-projects-label', text: 'Projects' }));
        for (const g of sections.projects) groupEl(g);
        if (sections.groups.length) kids.push(el('div', { class: 'chat-group-label chat-groups-label', text: 'Groups' }));
        for (const g of sections.groups) groupEl(g);
        if (ungrouped.length) {
          kids.push(el('div', { class: 'chat-group-label chat-ungrouped-label' },
            el('span', { text: 'Not in a group yet' }),
            el('a', { class: 'chat-review-suggestions', href: '#/work/conversations?view=suggestions', text: 'Review suggestions' })));
          for (const r of ungrouped) kids.push(rowEl(r, false));
        }
      } else if (this.ownerTree.length) {
        const compare = compareConversationActivity(this.treePreferences.sort);
        const pinnedKeys = new Set(pinned.map(row => row.key));
        const rows = [...pinned, ...rest].sort((a, b) =>
          Number(b.key === this.pinnedKey) - Number(a.key === this.pinnedKey) || compare(a, b));
        for (const row of rows) kids.push(rowEl(row, pinnedKeys.has(row.key)));
      } else {
        for (const row of orderWithTree(rest, this.pinnedKey)) kids.push(rowEl(row, false));
      }
      setKids(this.listEl, kids);
    }
    this.moreBtn.hidden = !(grouped && this.ownerTree.length ? this.ownerTree.at(-1).nextCursor : this.meta.nextCursor);
    const failed = this.meta.failed || [];
    this.failedEl.hidden = failed.length === 0;
    this.failedEl.textContent = failed.length ? `Not shown: conversations on ${failed.map((f) => f.machineId).join(', ')} (that machine did not answer).` : '';
  }

  /** Pin or unpin a whole conversation for this person (conversation-list-pins), then refresh the first page. */
  async setListPin(row, pinned, btn) {
    const ref = listPinRefOf(row);
    if (!ref) return;
    if (btn) btn.disabled = true;
    this.listPinNoteEl.hidden = true;
    const r = await this.call('POST', '/mobile/conversations/pins', { json: { ref, pinned } });
    if (btn) btn.disabled = false;
    if (!this.live || r.gone) return;
    const words = listPinOutcomeWords(r);
    if (words) { this.listPinNoteEl.textContent = words; this.listPinNoteEl.hidden = false; return; }
    await this.loadList(false);
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
    const target = messageFromQuery(query);
    if (ref && refString(ref) === cur) {
      if (this.view.sourceTarget !== target) {
        this.view.sourceTarget = target;
        this.view.sourceGeneration++;
        if (this.view.historyReady) this.findSource(this.view);
      }
      return;
    }
    if (this.view) this.closeView();
    this.pageEl.classList.toggle('has-open', Boolean(ref));
    if (!ref) { setKids(this.viewEl, el('p', { class: 'chat-pick', text: 'Pick a conversation.' })); this.paintList(); this.announce(); return; }
    this.openView(ref, target);
  }

  closeView() {
    const v = this.view;
    this.view = null;
    if (!v) return;
    v.live = false;
    if (v.historyWaitTimer) { clearTimeout(v.historyWaitTimer); this.timers.delete(v.historyWaitTimer); }
    if (v.abort) { try { v.abort.abort(); } catch { /* done */ } }
    this.revokeBlobs();
    if (this.observer) { try { this.observer.disconnect(); } catch { /* gone */ } this.observer = null; }
  }

  openView(ref, sourceTarget = null) {
    const row = this.rows.find((r) => r.key === refString(ref));
    const v = { ref, sourceTarget, sourceGeneration: 0, historyReady: false, earlierLoadSeq: 0, live: true, list: [], nextBefore: null, oldestTs: null, media: new Map(), mediaQueue: [], mediaInFlight: 0, slackKey: null, abort: this.abortable(), sending: 0, pins: [], pinIndex: 0 };
    this.view = v;
    const title = el('h2', { class: 'chat-title', text: row ? row.title : 'Conversation' });
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
    v.historyWords = el('p', { class: 'card-line chat-muted' });
    v.historyRetry = el('button', { class: 'btn-quiet chat-history-retry', type: 'button', text: 'Try again', hidden: true });
    v.historyRetry.addEventListener('click', () => this.loadFirst(v));
    v.historyNotice = el('div', { class: 'chat-history-state', role: 'status' }, v.historyWords, v.historyRetry);
    v.msgs.append(v.historyNotice);
    v.earlier = el('button', { class: 'btn-quiet chat-earlier', type: 'button', text: 'Earlier messages', hidden: true });
    v.earlier.addEventListener('click', () => { this.pauseSource(v); this.loadEarlier(v); });
    v.paused = el('p', { class: 'card-line chat-muted chat-paused', hidden: true, text: 'Live updates paused here — this conversation refreshes when you click into this window.' });
    v.statusLine = el('p', { class: 'card-line chat-muted', role: 'status' });
    v.sourceText = el('span', { text: 'Opening the original conversation…' });
    v.sourceMore = el('button', { class: 'btn-quiet', type: 'button', text: 'Keep looking', hidden: true });
    v.sourceMore.addEventListener('click', () => this.findSource(v));
    v.sourceNotice = el('div', { class: 'card-line chat-source-target', role: 'status', hidden: !sourceTarget }, v.sourceText, v.sourceMore);
    v.nodes = new Map();
    v.pinBar = this.pinBar(v);
    v.appStrip = el('div', { class: 'chat-appstrip', hidden: true });
    setKids(this.viewEl, el('div', { class: 'chat-open' },
      el('div', { class: 'chat-bar' }, back, el('div', { class: 'chat-titles' }, title, el('p', { class: 'chat-sub', text: row ? row.kindLabel : ({ app: 'App', telegram: 'Telegram', slack: 'Slack' })[ref.kind] })), menu),
      v.appStrip, v.pinBar, v.paused, v.sourceNotice, v.earlier, v.msgs, this.composer(v), v.statusLine));
    this.pageEl.classList.add('has-open');
    this.paintList();
    this.loadFirst(v, { recoverUnfinished: true });
    this.loadAppStrip(v);
    this.announce();
  }

  /** The project's app strip (headline + Open), drawn when the projects read lands; never awaited. */
  loadAppStrip(v) {
    projectsForStrip().then((data) => {
      if (!v.live || this.view !== v) return;
      const s = appStripFor(data, refString(v.ref));
      if (!s) { v.appStrip.hidden = true; return; }
      // A stopped or unapproved app has nothing to open: the strip says so with no Open button.
      const open = s.href ? el('a', { class: 'btn-quiet btn-inline chat-appstrip-open', href: s.href, text: s.label, 'aria-label': `Open ${s.title}` }) : null;
      if (open) open.addEventListener('click', (ev) => {
        ev.preventDefault();
        fetch(appPath(s.projectKey, s.appRef, 'opened'), { method: 'POST', headers: { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json', 'X-Instar-Request': '1' }, body: '{}', keepalive: true }).catch(() => {});
        const nav = appNavigation(s.href);
        if (nav && nav.kind === 'hash') location.hash = nav.href; else if (nav) location.assign(nav.href);
      });
      setKids(v.appStrip,
        el('div', { class: 'chat-appstrip-text' },
          el('span', { class: 'chat-appstrip-title', text: s.title }),
          el('span', { class: `chat-appstrip-line app-${s.line.state}`, text: s.line.text })),
        open);
      v.appStrip.hidden = false;
    }).catch(() => {});
  }

  historyPath(v, { pool, before, knownRows } = {}) {
    const { kind, id } = v.ref;
    if (kind === 'app') return `/mobile/chat/app/${encodeURIComponent(id)}/messages?limit=50${pool ? '&scope=pool' : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    // Hashes describe rows we actually hold, not a time boundary that could skip late messages.
    const since = knownRows !== undefined && !before ? `&knownRows=${encodeURIComponent(knownRows)}` : '';
    if (kind === 'telegram') return `/telegram/topics/${encodeURIComponent(id)}/messages?limit=50${pool ? '&scope=pool' : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}${since}`;
    return `/mobile/chat/slack/${encodeURIComponent(id)}/messages?limit=50&machine=${encodeURIComponent(this.slackMachine(v.ref) || '')}${before ? `&before=${encodeURIComponent(before)}` : ''}${since}`;
  }
  /** Keep full quick pages for every tab; a leader change never inherits hashes without rows. */
  rememberQuickPage(ref, cache) {
    this.quickPages.delete(ref);
    if (cache) this.quickPages.set(ref, cache);
    // Bounded recent-page memory. An evicted reference simply requests a full page next time.
    while (this.quickPages.size > 16) this.quickPages.delete(this.quickPages.keys().next().value);
  }
  /**
   * The machine a Slack conversation was listed from (a Slack id is local to it; the routes require it).
   * The list shows only this machine's own Slack rows, so before the list arrives it is this machine.
   */
  slackMachine(ref) {
    const row = this.rows.find((r) => r.key === refString(ref));
    return (row && row.machine) || (this.status && this.status.machineId) || null;
  }
  ownCheck() {
    const rec = this.device.record;
    return (row) => Boolean(row && ((rec && row.originDeviceId && row.originDeviceId === rec.deviceId) || (row.messageId && this.ownIds.has(String(row.messageId)))));
  }

  async loadFirst(v, { recoverUnfinished = false } = {}) {
    if (!this.live || !v.live || this.view !== v || v.historyPending) return;
    v.historyPending = true;
    v.historyError = null;
    v.historyWaiting = false;
    this.paintHistoryState(v);
    v.historyWaitTimer = this.later(() => {
      if (!v.live || this.view !== v || !v.historyPending) return;
      v.historyWaiting = true;
      this.paintHistoryState(v);
    }, 10_000);
    this.spent();
    try {
      const r = await this.readHistory(v, this.historyPath(v, { pool: true }));
      if (!this.live || !v.live || this.view !== v || r.gone) return;
      if (!r.ok) {
        v.sourceNotice.hidden = true;
        v.historyError = r.status === 404 ? 'This conversation is not here any more.' : 'Couldn\'t load this conversation right now.';
        return;
      }
      v.historyReady = true;
      this.applyHistory(v, r.data, { replace: true });
      // Preserve the existing open-time recovery; a history retry never resumes a send.
      if (recoverUnfinished) this.resumeUnfinished(v);
      this.scrollToEnd(v, true);
      this.findSource(v);
    } catch {
      // A failed history read changes only its explanation, never messages or a draft.
      if (this.live && v.live && this.view === v) v.historyError = 'Couldn\'t load this conversation right now.';
    } finally {
      v.historyPending = false;
      clearTimeout(v.historyWaitTimer); this.timers.delete(v.historyWaitTimer);
      v.historyWaitTimer = null;
      if (this.live && v.live && this.view === v) this.paintHistoryState(v);
    }
  }

  /** Initial, retry, focus and scheduled reads of one view/path share one signed request. */
  readHistory(v, path) {
    if (!v.historyReads) v.historyReads = new Map();
    const current = v.historyReads.get(path);
    if (current) return current;
    const pending = this.call('GET', path).finally(() => {
      if (v.historyReads.get(path) === pending) v.historyReads.delete(path);
    });
    v.historyReads.set(path, pending);
    return pending;
  }

  paintHistoryState(v) {
    if (!v.historyNotice) return;
    const hasMessages = v.list.length > 0;
    v.historyNotice.hidden = hasMessages && !v.historyError;
    v.historyRetry.hidden = v.historyPending || (!v.historyError && hasMessages);
    v.historyRetry.disabled = Boolean(v.historyPending);
    if (v.historyError) v.historyWords.textContent = hasMessages
      ? 'Couldn\'t refresh this conversation. Messages already loaded are still shown.' : v.historyError;
    else if (v.historyPending) v.historyWords.textContent = v.historyWaiting
      ? 'Waiting for the agent to return this conversation\'s messages. Your draft is unchanged.' : 'Loading messages…';
    else v.historyWords.textContent = 'No messages were returned for this conversation. Try again to check its history.';
  }

  applyHistory(v, data, { replace = false, earlier = false } = {}) {
    if (!data) return;
    v.historyError = null;
    if (v.ref.kind === 'slack' && typeof data.conversationKey === 'string') v.slackKey = data.conversationKey;
    const pins = pinsFrom(data);
    if (pins) this.setPins(v, pins);
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
    // A row this browser signed, with the placeholder's text, from no earlier than a minute before it:
    // the server already holds the message, even while the send's own answer is on its way (a Telegram
    // send answers only after dispatch, so the polled row can arrive first).
    const ownRows = list.filter((b) => !b.id.startsWith('local:') && b.side === 'right' && b.own);
    v.list = list.filter((b) => {
      if (!b.id.startsWith('local:')) return true;
      if (b.messageId && real.has(b.messageId)) return false;
      if (ownRows.some((o) => o.text === b.text && Date.parse(o.at || '') >= Date.parse(b.at || '') - 60_000)) return false;
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
      const sig = JSON.stringify([b.text, b.delivery && b.delivery.label, b.mark && b.mark.label, b.attachments.length, b.who, this.isPinned(v, b)]);
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
    this.paintHistoryState(v);
    if (atEnd) this.scrollToEnd(v);
  }
  scrollToEnd(v, force) {
    if (!force && v.msgs.scrollTop > 0 && v.msgs.scrollHeight - v.msgs.scrollTop - v.msgs.clientHeight > 200) return;
    v.msgs.scrollTop = v.msgs.scrollHeight;
  }

  bubbleNode(v, b) {
    const meta = [];
    if (b.at) meta.push(el('span', { class: 'chat-time', text: messageTime(b.at) }));
    if (b.delivery) meta.push(el('span', { class: `chat-delivery tone-${b.delivery.tone}`, text: b.delivery.label }));
    if (b.mark) meta.push(el('span', { class: `chat-mark tone-${b.mark.tone}`, text: b.mark.label }));
    const pinId = this.canPin(v) ? pinIdOf(v.ref.kind, b) : null;
    if (this.isPinned(v, b)) meta.push(el('span', { class: 'chat-pinned-mark', text: 'Pinned' }));
    if (pinId) {
      const more = el('button', { class: 'btn-quiet chat-msg-menu', type: 'button', text: '⋯', 'aria-label': 'Message options' });
      more.addEventListener('click', () => this.messageMenu(v, pinId));
      meta.push(more);
    }
    return el('div', { class: `chat-bubble chat-${b.side}`, 'data-id': b.id, ...(b.messageId ? { 'data-message-id': b.messageId } : {}) },
      b.who ? el('div', { class: 'chat-who', text: b.who }) : null,
      b.text ? messageTextNode(b.text) : null,
      b.attachments.length ? el('div', { class: 'chat-files' }, b.attachments.map((a) => this.attachmentNode(v, a))) : null,
      el('div', { class: 'chat-meta' }, meta));
  }

  // ── pinned messages (docs/specs/conversation-pinned-messages.md) ──
  /** The bar under the title: the pin it shows (tap to jump, then the next), and the list of all pins. */
  pinBar(v) {
    const jump = el('button', { class: 'chat-pin-jump', type: 'button', 'aria-label': 'Go to pinned message' });
    const all = el('button', { class: 'btn-quiet chat-pin-all', type: 'button', text: 'All pins' });
    jump.addEventListener('click', () => this.onPinBar(v));
    all.addEventListener('click', () => this.pinList(v));
    const bar = el('div', { class: 'chat-pinbar', hidden: true }, jump, all);
    v.pinJump = jump;
    return bar;
  }
  setPins(v, pins) {
    const before = JSON.stringify(v.pins.map((p) => p.messageId));
    v.pins = pins;
    if (v.pinIndex >= pins.length) v.pinIndex = 0;
    const t = pinBarText(pins, v.pinIndex);
    v.pinBar.hidden = !t;
    if (t) {
      setKids(v.pinJump, el('span', { class: 'chat-pin-label', text: t.count ? `${t.label} · ${t.count}` : t.label }), el('span', { class: 'chat-pin-preview', text: t.preview }));
    }
    // A bubble's "Pinned" mark follows the list.
    if (before !== JSON.stringify(pins.map((p) => p.messageId))) this.paintBubbles(v);
  }
  isPinned(v, b) {
    return Boolean(b && b.messageId && v.pins && v.pins.some((p) => p.messageId === b.messageId));
  }
  /** Pins change only where a message can be sent (a read-only Telegram view shows them but cannot change them). */
  canPin(v) {
    return !(v.ref.kind === 'telegram' && this.status && this.status.telegramSend === false);
  }
  pinsPath(v) {
    const base = pinsPathOf(v.ref);
    if (!base) return null;
    return v.ref.kind === 'slack' ? `${base}?machine=${encodeURIComponent(this.slackMachine(v.ref) || '')}` : base;
  }
  async loadPins(v) {
    const path = this.pinsPath(v);
    if (!path || !v.live) return;
    const r = await this.call('GET', path);
    if (!v.live || r.gone || !r.ok) return;
    const pins = pinsFrom(r.data);
    if (pins) this.setPins(v, pins);
  }
  async onPinBar(v) {
    const t = pinBarText(v.pins, v.pinIndex);
    if (!t) return;
    const found = await this.jumpTo(v, t.messageId);
    if (!found) v.statusLine.textContent = 'That message is further back than the dashboard has loaded.';
    v.pinIndex = nextPinIndex(v.pinIndex, v.pins.length);
    this.setPins(v, v.pins);
  }
  /** Scroll to a message and flash it, loading up to 5 earlier pages to find it. */
  async jumpTo(v, messageId) {
    this.pauseSource(v);
    for (let i = 0; i <= 5 && v.live; i++) {
      const b = v.list.find((x) => x.messageId === messageId);
      const n = b ? v.nodes.get(b.id) : null;
      if (n) {
        if (typeof n.scrollIntoView === 'function') n.scrollIntoView({ block: 'center', behavior: 'smooth' });
        n.classList.add('chat-flash');
        this.later(() => n.classList.remove('chat-flash'), 1600);
        return true;
      }
      if (v.earlier.hidden || i === 5) return false;
      await this.loadEarlier(v);
    }
    return false;
  }
  messageMenu(v, messageId) {
    const pinned = v.pins.some((p) => p.messageId === messageId);
    const err = el('p', { class: 'unlock-error', role: 'alert' });
    const go = el('button', { class: 'btn-primary', type: 'button', text: pinned ? 'Unpin' : 'Pin' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      const words = await this.setPinned(v, messageId, !pinned);
      go.disabled = false;
      if (words === null) { closeSheet(); return; }
      if (words.error) { err.textContent = words.text; return; }
      closeSheet();
      if (words.text) v.statusLine.textContent = words.text;
    });
    sheet({ title: 'Message' }, el('div', { class: 'pin-form' }, go, err));
  }
  /** Pin or unpin; answers null when the browser is gone, else the words to show (an error, or a platform refusal). */
  async setPinned(v, messageId, pinned) {
    const path = pinsPathOf(v.ref);
    if (!path) return { error: true, text: 'That did not work. Try again.' };
    const json = { messageId, pinned, requestId: newRequestId(this.device.clock.now()), ...(v.ref.kind === 'slack' ? { machine: this.slackMachine(v.ref) || '' } : {}) };
    const r = await this.call('POST', path, { json });
    if (r.gone) return null;
    if (r.ok) { const pins = pinsFrom(r.data); if (pins && v.live) this.setPins(v, pins); }
    return { error: !r.ok, text: pinOutcomeWords(r) };
  }
  pinList(v) {
    const rows = v.pins.map((p) => {
      const open = el('button', { class: 'chat-pin-row-open', type: 'button' }, el('span', { class: 'chat-pin-preview', text: p.preview || 'Pinned message' }),
        el('span', { class: 'chat-pin-by', text: [p.who ? `Pinned by ${p.who}` : 'Pinned', p.fromTelegram ? 'in Telegram' : '', p.pinnedAt ? messageTime(p.pinnedAt) : ''].filter(Boolean).join(' · ') }));
      open.addEventListener('click', async () => { closeSheet(); const ok = await this.jumpTo(v, p.messageId); if (!ok) v.statusLine.textContent = 'That message is further back than the dashboard has loaded.'; });
      const kids = [open];
      if (this.canPin(v)) {
        const un = el('button', { class: 'btn-quiet chat-pin-unpin', type: 'button', text: 'Unpin' });
        un.addEventListener('click', async () => {
          un.disabled = true;
          const words = await this.setPinned(v, p.messageId, false);
          if (words === null) { closeSheet(); return; }
          if (words.error) { un.disabled = false; v.statusLine.textContent = words.text; return; }
          closeSheet();
          if (words.text) v.statusLine.textContent = words.text;
          if (v.pins.length) this.pinList(v);
        });
        kids.push(un);
      }
      return el('li', { class: 'chat-pin-row' }, kids);
    });
    sheet({ title: v.pins.length === 1 ? '1 pinned message' : `${v.pins.length} pinned messages` },
      rows.length ? el('ul', { class: 'chat-pin-list' }, rows) : el('p', { class: 'confirm-text', text: 'Nothing is pinned here.' }));
  }

  async loadEarlier(v, current = () => v.live) {
    const seq = ++v.earlierLoadSeq;
    v.earlier.disabled = true;
    const before = v.ref.kind === 'telegram' ? (v.oldestTs ? String(v.oldestTs) : null) : v.nextBefore;
    this.spent();
    const keep = v.msgs.scrollHeight - v.msgs.scrollTop;
    const r = await this.call('GET', this.historyPath(v, { pool: v.ref.kind !== 'slack', before }));
    if (seq === v.earlierLoadSeq) v.earlier.disabled = false;
    if (!v.live || !current() || seq !== v.earlierLoadSeq) return 'stale';
    if (r.gone || !r.ok) return 'failed';
    this.applyHistory(v, r.data, { earlier: true });
    v.msgs.scrollTop = v.msgs.scrollHeight - keep;
    const after = v.ref.kind === 'telegram' ? (v.oldestTs ? String(v.oldestTs) : null) : v.nextBefore;
    return !v.earlier.hidden && after === before ? 'stalled' : 'loaded';
  }

  pauseSource(v) {
    if (!v.sourceTarget) return;
    v.sourceGeneration++;
    v.sourceText.textContent = 'Original message navigation paused. ';
    v.sourceMore.textContent = 'Return to original message';
    v.sourceMore.hidden = false;
  }

  /** Same five-page search batch as pin navigation; further history stays explicitly reachable. */
  async findSource(v) {
    const target = v.sourceTarget;
    const generation = ++v.sourceGeneration;
    const current = () => v.live && v.sourceGeneration === generation;
    v.sourceNotice.hidden = !target;
    v.sourceMore.hidden = true;
    if (!target) return;
    v.sourceText.textContent = 'Looking for the original message…';
    for (let page = 0; page <= 5 && current(); page++) {
      const row = v.list.find(b => b.messageId === target || b.id === target);
      const node = row ? v.nodes.get(row.id) : null;
      if (node) {
        node.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        node.classList.add('chat-flash');
        this.later(() => node.classList.remove('chat-flash'), 1600);
        v.sourceText.textContent = 'Original message';
        return;
      }
      if (v.earlier.hidden) {
        v.sourceText.textContent = 'The original message is not in the available history.';
        return;
      }
      if (page === 5) {
        v.sourceText.textContent = 'The original message has not been found. More history is available. ';
        v.sourceMore.textContent = 'Keep looking'; v.sourceMore.hidden = false;
        return;
      }
      const result = await this.loadEarlier(v, current);
      if (!current()) return;
      // A response can contain the target even when its continuation cursor is stuck.
      if (result === 'stalled' && v.list.some(b => b.messageId === target || b.id === target)) continue;
      if (result === 'stale') {
        v.sourceText.textContent = 'The original message has not been located yet. ';
        v.sourceMore.textContent = 'Keep looking'; v.sourceMore.hidden = false;
        return;
      }
      if (result !== 'loaded') {
        v.sourceText.textContent = 'Could not read earlier messages. ';
        v.sourceMore.textContent = 'Try again'; v.sourceMore.hidden = false;
        return;
      }
    }
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
    if (!canSend) return el('p', { class: 'card-line chat-readonly', text: telegramReadOnlyNote(this.status) });
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
    // One way in for every file: the Attach picker, a paste and a drop (Telegram parity M6/M7).
    const addFiles = (files) => {
      const all = [...v.files, ...files];
      const ok = checkFiles(all, this.status && this.status.limits);
      if (!ok.ok) { v.statusLine.textContent = ok.reason; return; }
      v.files = all;
      setKids(chosen, v.files.map((f, i) => {
        const x = el('button', { class: 'btn-quiet chat-unpick', type: 'button', text: '×', 'aria-label': `Remove ${f.name}` });
        x.addEventListener('click', () => { v.files.splice(i, 1); addFiles([]); });
        return el('span', { class: 'chat-file-chip' }, el('span', { text: `${f.name} · ${humanSize(f.size)}` }), x);
      }));
      refresh();
    };
    pick.addEventListener('change', () => {
      const files = Array.from(pick.files || []);
      pick.value = '';
      addFiles(files);
    });
    // A pasted screenshot or copied file joins the tray; pasted text stays ordinary text.
    text.addEventListener('paste', (ev) => {
      const pasted = pastedFiles(ev.clipboardData);
      if (!pasted.length) return;
      ev.preventDefault();
      addFiles(pasted);
      text.focus();
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
    // Files dropped anywhere on the open conversation (its messages or the composer) join the tray.
    let depth = 0;
    const over = (on) => box.classList.toggle('dropping', on);
    for (const t of [box, v.msgs].filter(Boolean)) {
      t.addEventListener('dragenter', (ev) => { if (!carriesFiles(ev.dataTransfer)) return; ev.preventDefault(); depth++; over(true); });
      t.addEventListener('dragover', (ev) => { if (!carriesFiles(ev.dataTransfer)) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; over(true); });
      t.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) over(false); });
      t.addEventListener('drop', (ev) => {
        if (!carriesFiles(ev.dataTransfer)) return;
        ev.preventDefault(); depth = 0; over(false);
        const files = Array.from(ev.dataTransfer.files || []);
        if (files.length) { addFiles(files); text.focus(); }
      });
    }
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
      const json = { text: entry.text || '', requestId: entry.requestId, ...(entry.uploads.length ? { attachments: entry.uploads } : {}), ...(ref.kind === 'slack' ? { machine: this.slackMachine(ref) } : {}) };
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
    // Quick reads send the hashes of a complete cached page. Pool reads above stay full.
    return this.historyPath(v, { pool: false, ...(task.mode === 'newest' ? { knownRows: (this.quickPages.get(task.ref)?.hashes || []).join(',') } : {}) });
  }

  async runTask(task) {
    const t0 = now();
    this.scheduler.start(task, t0);
    // Snapshot the exact baseline sent: another tab's result may arrive while this read waits.
    const previous = task.mode === 'newest' ? this.quickPages.get(task.ref) || null : null;
    let r;
    try {
      const path = this.taskPath(task);
      const v = this.view;
      r = v?.live && task.ref === refString(v.ref) ? await this.readHistory(v, path) : await this.call('GET', path);
    } catch { r = { ok: false, status: 0 }; }
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
      if (task.mode === 'newest') {
        const page = rebuildQuickPage(previous, r.data);
        this.rememberQuickPage(task.ref, page.cache);
        msg.data = page.data;
        msg.quickFullPage = Boolean(page.data);
        msg.resetQuickPage = !page.data;
      }
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
    if (m.resetQuickPage && m.ref) this.rememberQuickPage(m.ref, null);
    if (!m.mode || !m.data) return;
    if (m.mode === 'list') { this.applyList(m.data, false); return; }
    // Broadcasts carry full reconstructed pages. Even an unfocused tab/new leader learns rows
    // and hashes together, never an unseen hash that would suppress a missing message.
    if (m.mode === 'newest' && m.ref && m.quickFullPage) {
      const page = rebuildQuickPage(null, m.data);
      this.rememberQuickPage(m.ref, page.cache);
      if (!page.data) return;
    }
    const v = this.view;
    if (!v || refString(v.ref) !== m.ref || !v.live) return;
    if (m.mode === 'events') {
      const since = v.list.find((b) => !b.id.startsWith('local:'))?.at || null;
      this.setBubbles(v, applyEvents(v.list, m.data.events, { own: this.ownCheck(), since }));
      if (Array.isArray(m.data.events) && m.data.events.some((e) => e && e.kind === 'pin')) this.loadPins(v);
    }
    else this.applyHistory(v, m.data);
  }

  /** The focused tab's conversation: read now (an operator-caused read, counted in the budget). */
  async pollNow(v) {
    if (!v || !v.live || v.historyPending) return;
    const ref = refString(v.ref);
    if (this.leader && this.scheduler.tasks().some((t) => t.ref === ref && t.mode !== 'pool')) { this.scheduler.bump(ref, now()); this.loop(); return; }
    this.spent();
    const r = await this.readHistory(v, this.historyPath(v, { pool: v.ref.kind !== 'slack' }));
    if (r.ok && v.live) this.applyHistory(v, r.data);
  }
}

// ── small helpers ──
/** A hierarchy read on the dashboard route with this page's PIN unlock (never asks for the PIN). */
async function dashboardRead(path) {
  const proof = operatorSession();
  if (!proof) return { ok: false, status: 403 };
  try {
    const r = await fetch(path, { headers: { Authorization: `Bearer ${bearer()}`, 'X-Instar-Operator-Session': proof }, cache: 'no-store' });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
  } catch { return { ok: false, status: 0 }; }
}
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

/** True while a drag carries files (not a text or link drag, which the browser handles as usual). */
export function carriesFiles(dt) {
  return !!dt && Array.from(dt.types || []).includes('Files');
}

/**
 * The files on a paste, or []. A copied screenshot arrives as a nameless "image.png", so it gets a
 * name that tells two pastes apart ("Pasted image 14.32.07.png").
 */
export function pastedFiles(cd, at = new Date()) {
  if (!cd) return [];
  let files = Array.from(cd.files || []);
  if (!files.length && cd.items) files = Array.from(cd.items).filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
  const stamp = [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, '0')).join('.');
  return files.map((f, i) => {
    if (f.name && f.name !== 'image.png') return f;
    const ext = (String(f.type || '').split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
    const name = `Pasted image ${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${ext || 'png'}`;
    try { return new File([f], name, { type: f.type, lastModified: f.lastModified }); } catch { return f; } // @silent-fallback-ok: no File constructor keeps the original name
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
