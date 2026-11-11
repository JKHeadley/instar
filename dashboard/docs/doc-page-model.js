// Instar Documents — the document page's pure logic (spec §3.6, §3.8; app contract items 2 and 7).
//
// No DOM, no fetch, no storage: everything here is a plain function of its inputs, so it runs in
// node under vitest exactly as it runs in the page. Hashing is passed in (`sha256Hex`, async),
// because WebCrypto is async in the browser and the tests use node's crypto.

// ── signing: instar-docpage-v1 (mirrors src/documents/docpageAuth.ts exactly) ──────────────────

export const DOCPAGE_DOMAIN = 'instar-docpage-v1';

/** The fields each operation's signed payload must carry, exactly (docpageAuth.ts PAYLOAD_FIELDS). */
export const PAYLOAD_FIELDS = Object.freeze({
  comment: ['docId', 'commentId', 'onVersion', 'start', 'end', 'bodyHash'],
  reply: ['docId', 'commentKey', 'replyId', 'bodyHash'],
  resolve: ['docId', 'commentKey'],
  reopen: ['docId', 'commentKey'],
  edit: ['docId', 'commentKey', 'bodyHash'],
  reanchor: ['docId', 'commentKey', 'onVersion', 'start', 'end'],
  send: ['docId', 'batchId', 'commentKeysHash', 'primaryRow', 'messageRequestId'],
  open: ['docId'],
});

/** JSON with keys sorted and no whitespace; undefined members dropped (src/documents/chain.ts canonicalJson). */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** The payload for one op, holding exactly its fields; throws on a missing or extra field. */
export function buildPayload(op, fields) {
  const want = PAYLOAD_FIELDS[op];
  if (!want) throw new Error(`unknown op ${op}`);
  const out = {};
  for (const k of want) {
    if (fields[k] === undefined || fields[k] === null) throw new Error(`missing ${k} for ${op}`);
    out[k] = fields[k];
  }
  return out;
}

/** The string the device signs, given the payload's sha256 hex. */
export function docpageStringFromHash({ deviceId, host, docId, op, requestId, timeMs }, payloadHashHex) {
  return `${DOCPAGE_DOMAIN}\n${deviceId}\n${String(host).toLowerCase()}\n${docId}\n${op}\n${requestId}\n${timeMs}\n${payloadHashHex}`;
}

/** The string the device signs. `sha256Hex(string) → Promise<hex>` over UTF-8. */
export async function docpageString(parts, payload, sha256Hex) {
  return docpageStringFromHash(parts, await sha256Hex(canonicalJson(payload)));
}

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const REQUEST_ID = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isUuid4 = (s) => typeof s === 'string' && UUID4.test(s);

/** `<13-digit ms>-<uuid v4>`: the docpage requestId, the chat requestId and the send batchId share it. */
export function requestIdOf(nowMs, uuid) {
  return `${String(Math.floor(nowMs)).padStart(13, '0').slice(-13)}-${uuid}`;
}

/**
 * The chat message's requestId for a Send batch. The chat routes accept only `<13 ms>-<uuid4>`
 * (MobileChatRequests.ts REQUEST_ID_PATTERN), so the batch id itself is used: it is derived from
 * the batch (§3.8), unique per Send, and a retry of the same batch re-sends the same id.
 */
export const messageRequestIdFor = (batchId) => batchId;

/**
 * The input hashed into `commentKeysHash` (service.ts commentKeysHashOf): canonical JSON of the
 * keys of MY open comments, sorted ascending. sha256hex of this string is the signed value.
 */
export const commentKeysJson = (keys) => canonicalJson([...keys].sort());
/** The comment keys a Send covers: all of mine that are open (sent or not). */
export const myOpenKeys = (page) => (page && page.comments ? page.comments.filter((c) => c.mine && !c.resolved).map((c) => c.key) : []);

/** A salted blob's hash input: sha256hex(salt + "\0" + text) (src/documents/blobs.ts blobHash). */
export const blobHashInput = (salt, text) => `${salt}\u0000${text}`;

/** 16 random bytes as hex. `bytes` is a Uint8Array(16). */
export const saltHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// ── comment bodies ──────────────────────────────────────────────────────────────────────────────

export const MAX_BODY_CHARS = 40_000;
const BLOB_BYTES = 48 * 1024; // src/documents/rows.ts FORMAT.blobBytes, measured on the serialized blob

function utf8Length(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** A plain sentence when a body can't be posted, else null. */
export function bodyProblem(text) {
  const t = String(text ?? '');
  if (!t.trim()) return 'Write something first.';
  if (t.length > MAX_BODY_CHARS || utf8Length(JSON.stringify({ salt: '0'.repeat(32), text: t })) > BLOB_BYTES) {
    return 'This comment is too long to post in one piece. Split it into two.';
  }
  return null;
}

// ── projection text and offsets ─────────────────────────────────────────────────────────────────

export const blockText = (block) => block.runs.map((r) => r.text).join('');
/** The projection: every block's text, joined by "\n" (render.ts). */
export const projectionOf = (blocks) => blocks.map(blockText).join('\n');

/**
 * A point inside a block → projection offset. `runLengths` are the block's run text lengths in
 * order; `runIndex` the run holding the point, `charOffset` the offset inside that run's text.
 */
export function pointOffset(blockStart, runLengths, runIndex, charOffset) {
  let o = blockStart;
  const i = Math.max(0, Math.min(runIndex, runLengths.length));
  for (let k = 0; k < i; k++) o += runLengths[k];
  const len = i < runLengths.length ? runLengths[i] : 0;
  return o + Math.max(0, Math.min(charOffset, len));
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Two selection endpoints (projection offsets, either order) → `{start, end}` snapped to whole
 * characters (never splitting a surrogate pair) and trimmed of surrounding whitespace, or null
 * when nothing remains.
 */
export function normalizeSelection(a, b, text) {
  let start = Math.max(0, Math.min(a, b, text.length));
  let end = Math.min(text.length, Math.max(a, b, 0));
  if (start > 0 && start < text.length && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1))) start -= 1;
  if (end > 0 && end < text.length && isLow(text.charCodeAt(end)) && isHigh(text.charCodeAt(end - 1))) end += 1;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return end > start ? { start, end } : null;
}

/**
 * One block's runs split into pieces at comment-range boundaries. Each piece: `{runIndex, text,
 * start (absolute), keys (comment keys covering it)}`. Concatenating piece texts per run gives
 * the run text back; the page creates one text node per piece and records `start` for it.
 */
export function segmentBlock(block, ranges) {
  const out = [];
  let pos = block.start;
  block.runs.forEach((run, runIndex) => {
    const rs = pos; const re = pos + run.text.length;
    const cuts = new Set([rs, re]);
    for (const r of ranges) {
      if (r.start > rs && r.start < re) cuts.add(r.start);
      if (r.end > rs && r.end < re) cuts.add(r.end);
    }
    const points = [...cuts].sort((x, y) => x - y);
    for (let i = 0; i + 1 < points.length; i++) {
      const s = points[i]; const e = points[i + 1];
      if (e <= s) continue;
      const keys = ranges.filter((r) => r.start < e && r.end > s).map((r) => r.key);
      out.push({ runIndex, text: run.text.slice(s - rs, e - rs), start: s, keys });
    }
    pos = re;
  });
  return out;
}

/** Comment ranges to highlight: only on the latest version, only placed and open comments. */
export function highlightRanges(page) {
  if (!page || !page.version || !page.version.latest) return [];
  return (page.comments || [])
    .filter((c) => !c.resolved && c.anchorState !== 'orphaned' && Number.isInteger(c.start) && Number.isInteger(c.end) && c.end > c.start)
    .map((c) => ({ key: c.key, start: c.start, end: c.end }));
}

/** For ordered list items: the number each shows, counting runs of items at the same level. */
export function itemNumbers(blocks) {
  const counters = [];
  return blocks.map((b) => {
    if (b.kind !== 'item') { counters.length = 0; return null; }
    const level = b.level || 1;
    counters.length = Math.min(counters.length, level);
    while (counters.length < level) counters.push(0);
    counters[level - 1] += 1;
    return b.ordered ? counters[level - 1] : null;
  });
}

// ── links ───────────────────────────────────────────────────────────────────────────────────────

/** An href the page may link to (http, https, mailto), or null to show plain text. */
export function safeHref(href) {
  if (typeof href !== 'string' || !href) return null;
  let u;
  try { u = new URL(href); } catch { return null; }
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.href : null;
}

// ── location ────────────────────────────────────────────────────────────────────────────────────

/** `#code=…&comment=…` → `{code, comment}` (either null). */
export function parseFragment(hash) {
  const h = String(hash || '').replace(/^#/, '');
  const p = new URLSearchParams(h);
  const code = p.get('code');
  const comment = p.get('comment');
  return { code: code || null, comment: comment || null };
}

/** The document id: the last path segment of `/docs/<id>`. */
export function docIdFromPath(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  return parts.length ? decodeURIComponent(parts[parts.length - 1]) : '';
}

// ── words ───────────────────────────────────────────────────────────────────────────────────────

/** "Version 3 of 3" — position in the version list, which is in order. */
export function versionWords(page) {
  if (!page || !page.version) return 'No version yet';
  const list = page.versions || [];
  const i = list.findIndex((v) => v.id === page.version.id);
  return i >= 0 ? `Version ${i + 1} of ${list.length}` : `Version ${page.version.label}`;
}

export function anchorNote(state) {
  if (state === 'edited') return 'The passage changed since this comment';
  if (state === 'orphaned') return 'The passage this comment was on was removed';
  return null;
}

/** Comments a Send would cover: mine, open, not yet sent. */
export const unsentMine = (page) => (page && page.comments ? page.comments.filter((c) => c.mine && !c.resolved && !c.sent) : []);
export const openCount = (page) => (page && page.comments ? page.comments.filter((c) => !c.resolved).length : 0);
export const openWords = (n) => (n === 1 ? '1 open comment' : `${n} open comments`);

/** The Send template (§3.8), exactly. */
export function sendMessage({ count, title, label, origin, id }) {
  return `I left ${count} ${count === 1 ? 'comment' : 'comments'} on "${title}" (version ${label}): ${origin}/docs/${id}`;
}

/** Send is possible: allowed, a conversation to send into, and something unsent of mine. */
export function canSend(page) {
  return Boolean(page && page.me && page.me.canSend && page.primary && page.primary.sendPath && page.primary.primaryRow && page.version && unsentMine(page).length > 0);
}

/** Plain words for a failed request. Never the raw code. */
export function errorWords(status, body, ctx = {}) {
  const code = body && typeof body.error === 'string' ? body.error : '';
  const agent = ctx.agentName || 'the agent';
  const conv = ctx.conversation ? ` in ${ctx.conversation}` : '';
  switch (code) {
    case 'document-moved': return `This document moved while sending. Send again to tell ${agent}${conv}.`;
    case 'quote-not-in-document': return 'That passage could not be found in this version. Select it again.';
    case 'comment-too-long': return 'This comment is too long to post in one piece. Split it into two.';
    case 'body-required': return 'Write something first.';
    case 'comments-changed': return 'Your comments changed while sending. Send again.';
    case 'not-allowed': return 'You can\'t do that on this document.';
    case 'unknown-comment': return 'That comment is no longer here. The page has been refreshed.';
    case 'unknown-version': return 'That version is no longer available.';
    case 'unknown-document': return 'This document isn\'t available to you.';
    case 'version-text-unavailable': return 'This version\'s text was removed or is still arriving.';
    case 'access-being-checked': return 'Your access is still being checked. Try again in a moment.';
    case 'document-changed': return 'The document changed while you were writing. Try again.';
    case 'document-not-here-yet': return 'This document hasn\'t reached this machine yet. Try again in a moment.';
    case 'signature-refused': return 'This browser\'s request was refused. Check that your computer\'s clock is right, then try again.';
    case 'doc-session-expired': return ctx.inApp ? 'This page timed out. Open the document again from the app.' : 'This page timed out. Reload it to continue.';
    case 'documents-off': return 'Documents are turned off on this agent.';
    case 'not-serving': case 'owner-unavailable': return 'Messages aren\'t being received right now. Try again shortly.';
    case 'too-many-requests': return 'Too many messages right now. Try again in a minute.';
    case 'outcome-unknown': return 'The message may or may not have reached the agent. Check the conversation before sending again.';
    default: break;
  }
  if (body && typeof body.detail === 'string' && body.detail && !/^[a-z0-9-]+$/.test(body.detail)) return body.detail;
  if (status === 0) return 'The agent couldn\'t be reached. Check your connection and try again.';
  if (status === 401) return ctx.inApp ? 'This page timed out. Open the document again from the app.' : 'This page timed out. Reload it to continue.';
  if (status === 403) return 'You can\'t do that on this document.';
  if (status === 429) return 'Too many requests right now. Try again in a minute.';
  if (status >= 500) return 'Something went wrong on the agent. Try again in a moment.';
  return 'That didn\'t work. Try again.';
}

// ── drafts ──────────────────────────────────────────────────────────────────────────────────────

export const draftKey = (docId, kind, a, b) => `instar-doc-draft:${docId}:${kind}:${a}${b === undefined ? '' : `-${b}`}`;

/** A stored draft, or null for anything unreadable. Shape: {text, id, salt?}. */
export function parseDraft(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d.text !== 'string' || !isUuid4(d.id)) return null;
    return { text: d.text, id: d.id, ...(typeof d.salt === 'string' && /^[0-9a-f]{32}$/.test(d.salt) ? { salt: d.salt } : {}) };
  } catch { return null; }
}

// ── margin layout (computer) ────────────────────────────────────────────────────────────────────

/**
 * Threads beside their passages. `items`: `[{key, top, height}]` (anchor top, card height), any
 * order. Cards keep their order by anchor, pushed down to avoid overlapping. When any card would
 * be pushed further than `maxShift` from its passage, the margin collapses into a list.
 * → `{mode: 'margin', tops: {key: top}}` or `{mode: 'list'}`.
 */
export function marginLayout(items, { gap = 8, maxShift = 160 } = {}) {
  const sorted = [...items].sort((a, b) => a.top - b.top || String(a.key).localeCompare(String(b.key)));
  const tops = {};
  let next = -Infinity;
  for (const it of sorted) {
    const top = Math.max(it.top, next);
    if (top - it.top > maxShift) return { mode: 'list' };
    tops[it.key] = top;
    next = top + it.height + gap;
  }
  return { mode: 'margin', tops };
}

// ── compare ─────────────────────────────────────────────────────────────────────────────────────

/** Diff ops → pieces with a class (merging neighbours of the same kind). */
export function diffPieces(ops) {
  const out = [];
  for (const o of ops || []) {
    if (!o || typeof o.text !== 'string' || !o.text) continue;
    const kind = o.op === 'ins' ? 'ins' : o.op === 'del' ? 'del' : 'eq';
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += o.text; else out.push({ kind, text: o.text });
  }
  return out;
}

// ── bridge (app) ────────────────────────────────────────────────────────────────────────────────

/** The `fields` of an in-app write: the signed payload's fields minus hashes (the app adds them). */
export function bridgeFields(op, { docId, commentKey, replyId }) {
  switch (op) {
    case 'reply': return { docId, commentKey, replyId };
    case 'resolve': case 'reopen': case 'edit': return { docId, commentKey };
    default: throw new Error(`not a page bridge op: ${op}`);
  }
}

/** A message from the app (CustomEvent detail) if it has a known shape, else null. */
export function parseAppEvent(detail) {
  if (!detail || typeof detail !== 'object') return null;
  if (detail.type === 'write-result' && typeof detail.id === 'string') return { type: 'write-result', id: detail.id, status: Number(detail.status) || 0, body: detail.body && typeof detail.body === 'object' ? detail.body : null };
  if (detail.type === 'refresh') return { type: 'refresh' };
  if (detail.type === 'focus-comment' && typeof detail.commentKey === 'string') return { type: 'focus-comment', commentKey: detail.commentKey };
  return null;
}

// ── linking this computer (§3.6a) ───────────────────────────────────────────────────────────────

export const LINK_PREFIX = 'instar-link:1:';
/** Marks an IndexedDB record the document page made (the console store holds one record per machine). */
export const LINK_PURPOSE = 'documents';
export const LINK_POLL_MS = 2000;

/** base64url (no padding) of a string's UTF-8 bytes. */
export function b64urlText(text) {
  const u8 = new TextEncoder().encode(String(text));
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The text the QR code carries: `instar-link:1:` + base64url(JSON {k, n, m, h}).
 * k = the browser's public key (base64url raw P-256 point), n = nonce, m = machine id, h = host.
 * Throws on a missing part, so a half-made code is never shown.
 */
export function linkPayload({ browserPublicKey, nonce, machineId, host }) {
  const parts = { k: browserPublicKey, n: nonce, m: machineId, h: typeof host === 'string' ? host.toLowerCase() : host };
  for (const [k, v] of Object.entries(parts)) if (typeof v !== 'string' || !v) throw new Error(`link-payload-missing-${k}`);
  return LINK_PREFIX + b64urlText(JSON.stringify(parts));
}

/** Milliseconds since epoch from a number (ms) or an ISO string; null when unreadable. */
export function timeMsOf(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v) { const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v); return Number.isFinite(t) && t > 0 ? t : null; }
  return null;
}

/**
 * When the code stops working, in this computer's clock: the server's expiry corrected by the
 * server's Date header (when there is one), so a computer clock that is off doesn't cut it short
 * or keep a dead code on screen. Falls back to 10 minutes from now.
 */
export function linkDeadline({ expiresAt, serverDate, receivedAt }) {
  const exp = timeMsOf(expiresAt);
  const srv = typeof serverDate === 'string' ? Date.parse(serverDate) : NaN;
  if (exp === null) return receivedAt + 10 * 60_000;
  return Number.isFinite(srv) ? receivedAt + (exp - srv) : exp;
}

/**
 * What to do with one status answer. `httpStatus` 0 = network error.
 * → {next: 'linked', deviceId} | {next: 'wait'} | {next: 'retry'} | {next: 'expired'}
 * 'retry' keeps polling (a busy or unreachable server is not an answer); past the deadline every
 * answer but 'linked' is 'expired'.
 */
export function linkPollDecision({ httpStatus, answer, nowMs, deadlineMs }) {
  const st = answer && typeof answer.state === 'string' ? answer.state : null;
  if (httpStatus === 200 && st === 'linked' && typeof answer.deviceId === 'string' && answer.deviceId) return { next: 'linked', deviceId: answer.deviceId };
  if (httpStatus === 200 && st === 'expired') return { next: 'expired' };
  if (httpStatus === 404 || httpStatus === 410) return { next: 'expired' }; // the nonce is unknown here (used, or the machine restarted)
  if (Number.isFinite(deadlineMs) && nowMs >= deadlineMs) return { next: 'expired' };
  if (httpStatus === 200 && st === 'waiting') return { next: 'wait' };
  return { next: 'retry' };
}

/**
 * Whether the page may use this machine's slot in the console's store.
 * → 'free' (nothing there), 'reuse' (our own unfinished link: keep its key), 'replace' (our own
 * earlier link, refused now) or 'taken' (the console's own key: never overwritten from here).
 */
export function linkSlot(rec) {
  if (!rec) return 'free';
  if (rec.linkedFor !== LINK_PURPOSE) return 'taken';
  if (rec.status === 'linking' && rec.keyPair && rec.publicKey) return 'reuse';
  return 'replace';
}

/** The record once the phone linked it: the shape an active console record has. */
export function linkedRecord(rec, { deviceId, host }) {
  const { linkNonce, linkDeadline: _d, ...rest } = rec;
  return { ...rest, deviceId, host: String(host).toLowerCase(), status: 'active', linkedAt: new Date().toISOString() };
}
