// Conversations page view models (docs/specs/dashboard-conversations-browser-device.md §4.8, §4.10).
// Pure: no DOM, no fetch, no timers. chats.js renders these; tests/unit/console-chats-model.test.ts
// checks them.

// ── conversations and their address in the hash (#/work/chats?c=<kind>:<id>) ──
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `app:<uuid>`, `telegram:<topicId>`, `slack:<conversationId>` → { kind, id } or null. */
export function parseConversationRef(value) {
  const m = /^(app|telegram|slack):(.+)$/.exec(String(value || ''));
  if (!m) return null;
  const [, kind, id] = m;
  if (kind === 'app') return UUID.test(id) ? { kind, id } : null;
  if (kind === 'telegram') return /^[1-9][0-9]{0,15}$/.test(id) ? { kind, id } : null;
  return /^-?[0-9]{1,20}$/.test(id) ? { kind, id } : null;
}
export function refString(ref) { return ref ? `${ref.kind}:${ref.id}` : ''; }
export function refFromQuery(query) {
  try { return parseConversationRef(new URLSearchParams(String(query || '').replace(/^\?/, '')).get('c')); } catch { return null; }
}
export function hashFor(ref) { return ref ? `#/work/chats?c=${encodeURIComponent(refString(ref))}` : '#/work/chats'; }

export const KIND_LABEL = { app: 'App', telegram: 'Telegram', slack: 'Slack' };

/** The list rows from GET /mobile/conversations?scope=pool. */
export function listRows(body) {
  const rows = Array.isArray(body && body.conversations) ? body.conversations : [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const kind = r.platform === 'telegram' || r.platform === 'slack' ? r.platform : r.platform === 'app' ? 'app' : null;
    if (!kind) continue;
    const ref = parseConversationRef(`${kind}:${r.id}`);
    if (!ref) continue;
    out.push({
      ref, key: refString(ref), kind, kindLabel: KIND_LABEL[kind],
      title: typeof r.title === 'string' && r.title.trim() ? r.title : (kind === 'telegram' ? `Topic ${r.id}` : 'Untitled'),
      lastActivity: typeof r.lastActivity === 'string' ? r.lastActivity : null,
      preview: typeof r.lastPreview === 'string' ? r.lastPreview : '',
      machine: typeof r.machine === 'string' ? r.machine : null,
      // The unread hook (§4.10): built separately; a badge only when the server sends a count.
      unread: Number.isInteger(r.unreadCount) && r.unreadCount >= 0 ? r.unreadCount : null,
    });
  }
  return out;
}
export function listMeta(body) {
  const failed = Array.isArray(body && body.pool && body.pool.failed) ? body.pool.failed.filter((f) => f && typeof f.machineId === 'string') : [];
  return { nextCursor: typeof (body && body.nextCursor) === 'string' && body.nextCursor ? body.nextCursor : null, failed, slackOwnerUnset: Boolean(body && body.slackOwnerUnset) };
}
/** Appends a later page, keeping the first copy of each conversation. */
export function mergeListPages(prev, next) {
  const seen = new Set(prev.map((r) => r.key));
  return [...prev, ...next.filter((r) => !seen.has(r.key))];
}
export function validTitle(t) {
  const s = String(t || '').trim();
  return s.length >= 1 && s.length <= 80 ? s : null;
}

// ── history rows → bubbles ─────────────────────────────────────────────────
/**
 * The origin mark for an operator bubble, for all five verdicts (§4.8). `own` is true when this
 * browser's own key signed it. Browser-signed comes from authenticated data: `originClient`.
 */
export function originMark(row, own) {
  const v = row && row.originVerified;
  if (v === 'verified') {
    const parts = [own ? 'signed (this browser)' : row.originClient === 'browser' ? 'signed from a browser' : 'signed'];
    if (row.originApprovedVia === 'dashboard-pin') parts.push('approved on dashboard');
    return { label: parts.join(' · '), tone: 'ok' };
  }
  if (v === 'redacted') return { label: 'signed — an invite or desktop code was removed', tone: 'ok' };
  // warning-exempt: a delivery or signature state on the operator's own message, shown inside the open conversation where it is read and answered
  if (v === 'failed') return { label: '⚠ signature does not check out', tone: 'bad' };
  if (v === 'unknown') return { label: 'couldn\'t check on this machine', tone: 'muted' };
  return null;
}

export function deliveryLabel(state, detail) {
  if (state === 'delivered' || state === 'intercepted') return { label: 'delivered', tone: 'ok' };
  // warning-exempt: a delivery or signature state on the operator's own message, shown inside the open conversation where it is read and answered
  if (state === 'refused') return { label: detail ? `not delivered — ${detail}` : 'not delivered', tone: 'bad' };
  // warning-exempt: a delivery or signature state on the operator's own message, shown inside the open conversation where it is read and answered
  if (state === 'unknown') return { label: 'unknown — check the conversation', tone: 'attn' };
  if (state === 'pending' || state === 'sending' || state === 'waiting' || state === 'forwarded') return { label: 'sending', tone: 'muted' };
  return null;
}

const iso = (v) => {
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  return null;
};

/**
 * One bubble from a history row of any kind. `opts.own(row)` says whether this browser signed it.
 * side: 'right' for the operator, 'left' for the agent and other participants.
 */
export function bubble(kind, row, opts = {}) {
  if (!row || typeof row !== 'object') return null;
  let side; let who = null;
  if (kind === 'telegram') {
    side = row.fromUser ? 'right' : 'left';
    if (!row.fromUser) who = null;
  } else if (kind === 'slack') {
    side = row.role === 'operator' ? 'right' : 'left';
    if (row.role === 'participant') who = typeof row.senderName === 'string' ? row.senderName : 'Someone';
  } else {
    side = row.role === 'operator' ? 'right' : 'left';
  }
  const id = String(row.eventId || row.messageId || '');
  if (!id) return null;
  const own = side === 'right' && typeof opts.own === 'function' ? Boolean(opts.own(row)) : false;
  return {
    id,
    pos: positionOf(kind, row),
    messageId: row.messageId != null ? String(row.messageId) : null,
    side, who,
    text: typeof row.text === 'string' ? row.text : '',
    at: iso(row.at) || iso(row.timestamp),
    attachments: Array.isArray(row.attachments) ? row.attachments.filter((a) => a && typeof a.sha256 === 'string').map(attachmentView) : [],
    delivery: side === 'right' && kind !== 'telegram' ? deliveryLabel(row.deliveryState, row.deliveryDetail) : side === 'right' && row.deliveryState ? deliveryLabel(row.deliveryState, row.deliveryDetail) : null,
    mark: side === 'right' ? originMark(row, own) : null,
  };
}

/**
 * A message's read position `{ atMs, id }` (docs/specs/mobile-unread-messages.md §3.1): app and Slack →
 * `eventId`; Telegram → `eventId` when present, else `in:<messageId>` for the user's row and
 * `out:<messageId>` otherwise. Null when the row cannot name one.
 */
export function positionOf(kind, row) {
  const atMs = Date.parse(iso(row.at) || iso(row.timestamp) || '');
  if (!Number.isSafeInteger(atMs) || atMs < 0) return null;
  let id = null;
  if (kind === 'telegram') id = row.eventId ? String(row.eventId) : row.messageId != null ? `${row.fromUser ? 'in' : 'out'}:${row.messageId}` : null;
  else id = row.eventId ? String(row.eventId) : null;
  return id ? { atMs, id } : null;
}

/** The canonical read-marker ref of an open conversation (§3.1); Slack names its machine. */
export function readRefOf(ref, machine) {
  if (!ref) return null;
  if (ref.kind === 'app') return `app:${String(ref.id).toLowerCase()}`;
  if (ref.kind === 'telegram') return `telegram:${Number(ref.id)}`;
  if (ref.kind === 'slack') return machine ? `slack:${machine}:${ref.id}` : null;
  return null;
}

/**
 * The read mark for the newest message shown (dashboard-read-markers): `{ ref, id, atMs, machine? }`,
 * or null when nothing newer than `lastSent` is shown. Placeholders (`local:`) never count.
 */
export function readMarkFor(ref, list, machine, lastSent) {
  const r = readRefOf(ref, machine);
  if (!r) return null;
  let newest = null;
  for (const b of Array.isArray(list) ? list : []) {
    if (!b || String(b.id).startsWith('local:') || !b.pos) continue;
    if (!newest || b.pos.atMs > newest.atMs || (b.pos.atMs === newest.atMs && b.pos.id > newest.id)) newest = b.pos;
  }
  if (!newest) return null;
  if (lastSent && (lastSent.atMs > newest.atMs || (lastSent.atMs === newest.atMs && lastSent.id >= newest.id))) return null;
  return { ref: r, id: newest.id, atMs: newest.atMs, ...(machine ? { machine } : {}) };
}

/** Bubbles from one history page, oldest first, de-duplicated by id. */
export function bubbles(kind, rows, opts = {}) {
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const b = bubble(kind, r, opts);
    if (b) out.set(b.id, b);
  }
  return sortBubbles([...out.values()]);
}
export function sortBubbles(list) {
  return list.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || a.id.localeCompare(b.id));
}
/** Merges new bubbles over the ones shown (a newer reading of the same id wins). */
export function mergeBubbles(prev, next) {
  const m = new Map(prev.map((b) => [b.id, b]));
  for (const b of next) m.set(b.id, b);
  return sortBubbles([...m.values()]);
}

/** Applies an app `events` page: message events become bubbles, delivery events update states. */
export function applyEvents(prev, events, opts = {}) {
  let list = prev.slice();
  const msgs = [];
  const deliveries = [];
  // Events start at the beginning of the conversation; only the part from the oldest shown message on
  // is added, so catching up never pours the whole history in ("Earlier messages" pages backwards).
  const since = opts.since || null;
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue;
    if (e.kind === 'message' || e.kind === 'media-message') { if (!since || String(e.at || '') >= since) msgs.push(e); }
    else if (e.kind === 'delivery') deliveries.push(e);
  }
  if (msgs.length) list = mergeBubbles(list, bubbles('app', msgs, opts));
  for (const d of deliveries) {
    list = list.map((b) => (b.messageId && b.messageId === String(d.messageId) && b.side === 'right' ? { ...b, delivery: deliveryLabel(d.state, d.detail) } : b));
  }
  return list;
}

// ── media (§4.8) ───────────────────────────────────────────────────────────
/** Only these types become a viewable blob:; everything else is a download. */
export const VIEWABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav']);
export function blobTypeFor(mediaType) {
  const t = String(mediaType || '').toLowerCase().split(';')[0].trim();
  return VIEWABLE_TYPES.has(t) ? t : 'application/octet-stream';
}
export function attachmentView(a) {
  const type = blobTypeFor(a.mediaType);
  const display = type === 'application/octet-stream' ? 'file' : type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : 'audio';
  return {
    sha256: a.sha256, filename: typeof a.filename === 'string' && a.filename ? a.filename : 'file',
    size: Number.isFinite(a.size) ? a.size : null, blobType: type, display,
  };
}
/** The declared kind the upload route expects for a picked file. */
export function declaredKindFor(type) {
  const t = String(type || '').toLowerCase();
  if (t.startsWith('image/')) return 'photo';
  if (t.startsWith('video/')) return 'video';
  return 'file';
}
/** The `ref` a download names: app:<uuid>, telegram:<topicId>, or the Slack conversationKey. */
export function mediaRefFor(ref, slackConversationKey) {
  if (!ref) return null;
  if (ref.kind === 'app') return `app:${ref.id}`;
  if (ref.kind === 'telegram') return `telegram:${ref.id}`;
  return typeof slackConversationKey === 'string' ? slackConversationKey : null;
}
export function humanSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
/** Checks picked files against the limits from the status answer. → { ok } or { ok:false, reason } */
export function checkFiles(files, limits) {
  const l = limits || {};
  const maxFiles = Number(l.maxFiles) || 10;
  const maxFile = Number(l.maxFileBytes) || 50 * 1024 * 1024;
  const maxMsg = Number(l.maxMessageBytes) || 64 * 1024 * 1024;
  if (files.length > maxFiles) return { ok: false, reason: `At most ${maxFiles} files in one message.` };
  let total = 0;
  for (const f of files) {
    if (f.size > maxFile) return { ok: false, reason: `${f.name} is larger than ${humanSize(maxFile)}.` };
    total += f.size;
  }
  if (total > maxMsg) return { ok: false, reason: `These files are larger than ${humanSize(maxMsg)} together.` };
  return { ok: true };
}

// ── unfinished sends (§4.8 Composer) ────────────────────────────────────────
export const UNFINISHED_KEY = 'instar_chat_unfinished';
export const MAX_SEND_AGE_MS = 23 * 60 * 60 * 1000;

/**
 * What to do with an unfinished send found in sessionStorage. It is retried only under the same
 * device and machine, and only while its requestId is under 23 hours old (server-corrected).
 */
export function unfinishedAction(entry, { deviceId, machineId, nowMs }) {
  if (!entry || typeof entry !== 'object') return 'drop';
  const t = Number(/^(\d{13})-/.exec(String(entry.requestId || ''))?.[1]);
  if (!Number.isFinite(t)) return 'drop';
  if (entry.deviceId !== deviceId || entry.machineId !== machineId) return 'unknown';
  if (nowMs - t > MAX_SEND_AGE_MS) return 'unknown';
  return 'retry';
}

/** A send's answer → { final, state, label }. Not final: retry later with the same requestId. */
export function sendOutcome(status, data) {
  const d = data || {};
  if (status === 200 || status === 201) {
    const state = typeof d.deliveryState === 'string' ? d.deliveryState : 'pending';
    return { final: state !== 'pending' && state !== 'forwarded' && state !== 'waiting', state, label: deliveryLabel(state, d.detail || d.deliveryDetail) };
  }
  // warning-exempt: a delivery or signature state on the operator's own message, shown inside the open conversation where it is read and answered
  if (status === 404) return { final: true, state: 'gone', label: { label: 'the conversation is gone', tone: 'bad' } };
  // warning-exempt: a delivery or signature state on the operator's own message, shown inside the open conversation where it is read and answered
  if (status === 403) return { final: true, state: 'refused', label: { label: d.detail ? `not delivered — ${d.detail}` : 'not delivered', tone: 'bad' } };
  // warning-exempt: a delivery or signature state on the operator's own message, shown inside the open conversation where it is read and answered
  if (status === 409) return { final: true, state: 'unknown', label: { label: d.error === 'not-serving' ? 'Sending to Telegram works from the machine serving Telegram' : 'unknown — check the conversation', tone: 'attn' } };
  // warning-exempt: a delivery or signature state on the operator's own message, shown inside the open conversation where it is read and answered
  if (status === 400 || status === 413) return { final: true, state: 'refused', label: { label: d.detail || 'not delivered', tone: 'bad' } };
  return { final: false, state: 'sending', label: deliveryLabel('sending') };
}

// ── one poller per browser (§4.8) ───────────────────────────────────────────
export const POLL_BUDGET_PER_MIN = 60;
export const MAX_POLLED = 8;
export const ANNOUNCE_EVERY_MS = 10_000;
export const ANNOUNCE_STALE_MS = 25_000;
export const INTERVAL = { events: 4000, newest: 5000, fallback: 15000, pool: 30000, list: 30000 };
export const MAX_BACKOFF_MS = 30_000;

/**
 * The union of announced conversations the leader polls: announcements older than 25 s dropped,
 * at most 8, the focused tab's conversation always included (displacing the least recently focused).
 * `announcements`: [{ tab, ref, at, focusedAt, focused }]
 */
export function pollUnion(announcements, nowMs, max = MAX_POLLED) {
  const live = (announcements || []).filter((a) => a && a.ref && nowMs - a.at <= ANNOUNCE_STALE_MS);
  const byRef = new Map();
  for (const a of live) {
    const prev = byRef.get(a.ref);
    if (!prev || (a.focusedAt || 0) > (prev.focusedAt || 0) || (a.focused && !prev.focused)) byRef.set(a.ref, { ref: a.ref, focusedAt: a.focusedAt || 0, focused: Boolean(a.focused) || Boolean(prev && prev.focused) });
    else if (a.focused) prev.focused = true;
  }
  const all = [...byRef.values()].sort((x, y) => (y.focused - x.focused) || (y.focusedAt - x.focusedAt));
  return all.slice(0, max).map((x) => x.ref);
}

/**
 * The read scheduler: every signed read the page makes passes through it. At most `budget` reads a
 * minute, never two at once, intervals stretched to fit the budget, a 429 doubling the interval
 * (honouring Retry-After) up to 30 s and a success halving it back. Pure: the caller supplies time.
 */
export function createScheduler({ budget = POLL_BUDGET_PER_MIN } = {}) {
  const tasks = new Map(); // id → task
  const window = [];       // times of reads started in the last minute
  let inFlight = null;

  function taskId(t) { return t.ref ? `${t.mode}|${t.ref}` : t.mode; }

  /** Replace the polled set. `refs`: [{ ref, kind }] (the union). The list task is kept. */
  function setConversations(refs, nowMs) {
    const want = new Map();
    want.set('list', { mode: 'list', ref: null });
    for (const r of refs) {
      if (!r || !r.ref) continue;
      if (r.kind === 'app') {
        const mode = r.fallback ? 'fallback' : 'events';
        want.set(`${mode}|${r.ref}`, { mode, ref: r.ref, kind: r.kind });
      } else {
        want.set(`newest|${r.ref}`, { mode: 'newest', ref: r.ref, kind: r.kind });
        want.set(`pool|${r.ref}`, { mode: 'pool', ref: r.ref, kind: r.kind });
      }
    }
    for (const id of [...tasks.keys()]) if (!want.has(id)) tasks.delete(id);
    for (const [id, t] of want) {
      if (!tasks.has(id)) tasks.set(id, { ...t, id, mult: 1, nextAt: t.mode === 'pool' || t.mode === 'list' ? nowMs + INTERVAL[t.mode] : nowMs, notBefore: 0 });
    }
  }

  /** How much to stretch every interval so the demand fits the budget. */
  function stretch() {
    let demand = 0;
    for (const t of tasks.values()) demand += 60_000 / Math.min(INTERVAL[t.mode] * t.mult, capOf(t));
    return demand > budget ? demand / budget : 1;
  }
  /** A task's own interval (backoff capped at 30 s, or its base when that is longer), stretched to the budget. */
  function capOf(t) { return Math.max(MAX_BACKOFF_MS, INTERVAL[t.mode]); }
  function intervalOf(t) { return Math.min(INTERVAL[t.mode] * t.mult, capOf(t)) * stretch(); }

  function prune(nowMs) { while (window.length && nowMs - window[0] >= 60_000) window.shift(); }

  /** The next task to run now, or { waitMs }. `visible`: false → nothing runs. */
  function next(nowMs, { visible = true } = {}) {
    if (!visible) return { waitMs: null };
    if (inFlight) return { waitMs: null };
    prune(nowMs);
    if (window.length >= budget) return { waitMs: Math.max(1, window[0] + 60_000 - nowMs) };
    let best = null;
    for (const t of tasks.values()) {
      const at = Math.max(t.nextAt, t.notBefore);
      if (!best || at < Math.max(best.nextAt, best.notBefore)) best = t;
    }
    if (!best) return { waitMs: null };
    const at = Math.max(best.nextAt, best.notBefore);
    if (at > nowMs) return { waitMs: at - nowMs };
    return { task: best };
  }

  /** Counts a read the operator caused (opening, Earlier messages): it spends budget but has no task. */
  function spend(nowMs) { prune(nowMs); window.push(nowMs); }
  function canSpend(nowMs) { prune(nowMs); return window.length < budget; }

  function start(task, nowMs) { inFlight = task.id; window.push(nowMs); }

  /** outcome: { status, retryAfterMs? } */
  function finish(task, nowMs, outcome = {}) {
    if (inFlight === task.id) inFlight = null;
    const t = tasks.get(task.id);
    if (!t) return;
    const status = outcome.status;
    if (status === 429) {
      t.mult = Math.min(t.mult * 2, capOf(t) / INTERVAL[t.mode]);
      if (Number.isFinite(outcome.retryAfterMs) && outcome.retryAfterMs > 0) t.notBefore = nowMs + Math.min(outcome.retryAfterMs, 5 * 60_000);
    } else if (status >= 200 && status < 300) {
      t.mult = Math.max(1, t.mult / 2);
    } else if (status === 0 || status >= 500) {
      t.mult = Math.min(t.mult * 2, capOf(t) / INTERVAL[t.mode]);
    }
    t.nextAt = nowMs + intervalOf(t);
  }

  /** An app conversation not stored here yet (events 404): newest pool page every 15 s instead. */
  function fallBack(ref, nowMs) {
    const id = `events|${ref}`;
    const t = tasks.get(id);
    if (!t) return;
    tasks.delete(id);
    tasks.set(`fallback|${ref}`, { mode: 'fallback', ref, kind: 'app', id: `fallback|${ref}`, mult: 1, nextAt: nowMs + INTERVAL.fallback, notBefore: 0 });
  }
  function recover(ref, nowMs) {
    const id = `fallback|${ref}`;
    if (!tasks.has(id)) return;
    tasks.delete(id);
    tasks.set(`events|${ref}`, { mode: 'events', ref, kind: 'app', id: `events|${ref}`, mult: 1, nextAt: nowMs, notBefore: 0 });
  }

  /** Makes a conversation's own reads due now (the operator focused it, or a page came back full). */
  function bump(ref, nowMs) {
    for (const t of tasks.values()) if (t.ref === ref && t.mode !== 'pool') t.nextAt = Math.min(t.nextAt, nowMs);
  }

  /** The backoff state the leader broadcasts with each result, so a new leader carries it on. */
  function snapshot() { return [...tasks.values()].map((t) => ({ id: t.id, mult: t.mult, notBefore: t.notBefore })); }
  function restore(state) {
    for (const s of Array.isArray(state) ? state : []) {
      const t = tasks.get(s && s.id);
      if (t && Number.isFinite(s.mult) && s.mult >= 1) { t.mult = s.mult; t.notBefore = Number(s.notBefore) || 0; }
    }
  }

  return { setConversations, next, start, finish, spend, canSpend, fallBack, recover, bump, snapshot, restore, tasks: () => [...tasks.values()].map((t) => ({ ...t })), intervalOf: (id) => { const t = tasks.get(id); return t ? intervalOf(t) : null; }, readsInLastMinute: (nowMs) => { prune(nowMs); return window.length; } };
}

// ── the setup card (§4.2, §4.6) ─────────────────────────────────────────────
/** Words for a refused setup, by the server's error code. */
export function setupRefusal(status, data) {
  const d = data || {};
  const code = d.error || '';
  const words = {
    'browser-devices-off': 'Conversations in the dashboard are switched off on this agent.',
    'pairing-paused': 'Setting up new devices is paused on this agent right now.',
    'not-secure-address': 'Open the dashboard at its secure address (or on this computer at localhost) to set up this browser.',
    'browser-proof-invalid': 'This browser\'s key could not be checked. Try again.',
    'duplicate-key': 'This browser\'s key is already in use. Try again to make a new one.',
    'operator-session-required': 'Your PIN is needed to set up this browser.',
    'too-many-browsers': 'This machine already has the most browsers it allows. Remove one in People > Phones first.',
    'too-many-setups': 'Too many browsers were set up in the last hour.',
    'replaces-invalid': 'The earlier key of this browser could not be checked.',
    'approval-unavailable': d.detail || 'Set up this browser from the machine serving Telegram.',
    'not-delivered': 'The approval message could not be sent.',
  };
  if (words[code]) return code === 'too-many-setups' && d.nextAllowedAt ? `${words[code]} The next one is allowed at ${new Date(d.nextAllowedAt).toLocaleTimeString()}.` : words[code];
  if (status === 0) return 'The agent could not be reached.';
  return d.detail || `Setting up this browser did not work (the server answered ${status}).`;
}

/** Where the owner approves a pending browser, by the setup answer's approval path. */
export function approvalWords(approval) {
  if (approval === 'telegram' || approval === 'telegram-dm') return 'Approve it in your private Telegram chat with the agent (tap Approve, or type the code here), or on your phone.';
  if (approval === 'owner-phone') return 'Approve it on your phone.';
  if (approval === 'dashboard') return 'Approved with your PIN.';
  return 'Approve it where the agent asks you to.';
}
