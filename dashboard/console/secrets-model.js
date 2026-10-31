// Passwords & keys — pure view-model
// (docs/specs/console-features/people-settings.md, "Passwords & keys", legacy tab id `secrets`).
//
// Every decision lives here so it can be tested: which requests are waiting / expiring /
// expired, the live "11 min left" words, the conversation name, the keys-held list
// (NAMES ONLY — never a value, never a length), the vault's decrypt-failed warning, the
// sync line, the headline and facts, the exact POST /secrets/request body, and the
// server's answer in words. Every route here is adapter (a): the bearer token is enough,
// so no PIN is ever asked.

import { verifiedDisplayName } from './display-identity.js';

export const SOON_MS = 5 * 60_000;

/** "Valid for" choices in the Ask sheet (the route accepts 1 min … 1 h). */
export const TTL_CHOICES = [
  { label: '15 minutes', ms: 15 * 60_000 },
  { label: '1 hour', ms: 60 * 60_000 },
];
export const TEST_TTL_MS = 5 * 60_000;

/** Time left in plain words: "11 min left", "45 s left", "1 h 5 min left", "expired". */
export function leftWords(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min left` : `${h} h left`;
}

/** How long ago, short: "just now", "4 min ago", "2 h ago", "3 days ago". */
export function agoWords(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const d = Math.max(0, now - ms);
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** GET /telegram/topics → { "123": "Instar 2.0" } (unnamed topics left out). */
export function topicNameMap(res) {
  const list = res && res.ok && res.data && Array.isArray(res.data.topics) ? res.data.topics : [];
  const map = {};
  for (const t of list) if (t && Number.isFinite(Number(t.topicId))) {
    const name = verifiedDisplayName(t.topicName, t.topicId);
    if (name) map[String(t.topicId)] = name;
  }
  return map;
}

/** The conversation picker's options, named ones first by name; "" = tell no conversation. */
export function conversationChoices(names = {}) {
  const entries = Object.entries(names).map(([id, name]) => ({ value: id, label: verifiedDisplayName(name, id) })).filter((entry) => entry.label);
  const counts = new Map();
  for (const entry of entries) counts.set(entry.label.toLocaleLowerCase(), (counts.get(entry.label.toLocaleLowerCase()) || 0) + 1);
  return entries.filter((entry) => counts.get(entry.label.toLocaleLowerCase()) === 1).sort((a, b) => a.label.localeCompare(b.label));
}

/** A conversation in words: its name, else "conversation 123", else "" (none named). */
export function conversationWords(topicId, names = {}) {
  if (topicId === undefined || topicId === null || topicId === '') return '';
  return verifiedDisplayName(names[String(topicId)], topicId) || 'conversation name unavailable';
}

/**
 * A drop link the page may open or share: the tunnel URL (reachable from a phone) when
 * there is one, else the local path made absolute against this page's origin. Anything
 * that is not an http(s) URL or a /secrets/drop/ path is refused (never put in an href).
 */
export function dropLink(p, origin = '') {
  const t = p && typeof p.tunnelUrl === 'string' ? p.tunnelUrl : '';
  if (/^https?:\/\//i.test(t)) return { url: t, remote: true };
  const l = p && typeof p.localUrl === 'string' ? p.localUrl : '';
  if (/^\/secrets\/drop\/[A-Za-z0-9_-]+$/.test(l)) return { url: `${String(origin || '').replace(/\/$/, '')}${l}`, remote: false };
  return null;
}

/** One pending request → one card. */
export function requestCard(p, { names = {}, now = Date.now(), origin = '' } = {}) {
  const expiresAt = Number(p.expiresAt);
  const left = expiresAt - now;
  const expired = p.expired === true || !Number.isFinite(expiresAt) || left <= 0;
  const conv = conversationWords(p.topicId, names);
  const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim() : 'A password or key';
  return {
    key: `secret:${p.token}`,
    token: String(p.token || ''),
    label,
    conversation: conv,
    topicId: p.topicId ?? null,
    expiresAt,
    createdAt: Number(p.createdAt),
    expired,
    soon: !expired && left <= SOON_MS,
    leftWords: expired ? 'expired' : leftWords(left),
    // The context line: conversation (when named) and the time left — updated live by the page.
    sub: [conv ? `for “${conv}”` : 'no conversation named', expired ? `expired ${agoWords(expiresAt, now)}` : leftWords(left)].join(' · '),
    asked: agoWords(Number(p.createdAt), now),
    link: dropLink(p, origin),
  };
}

/** GET /secrets/pending → waiting (soonest first) and expired (latest first), or an honest reason. */
export function buildRequests(res, opts = {}) {
  const now = opts.now || Date.now();
  if (!res || !res.ok) return { ok: false, reason: `Can’t tell what the agent is waiting for: ${(res && res.reason) || 'no answer'}.` };
  const list = res.data && Array.isArray(res.data.pending) ? res.data.pending : null;
  if (!list) return { ok: false, reason: 'Can’t tell what the agent is waiting for: the request list answered without its list.' };
  const cards = list.filter((p) => p && typeof p.token === 'string' && p.token).map((p) => requestCard(p, { ...opts, now }));
  const waiting = cards.filter((c) => !c.expired).sort((a, b) => a.expiresAt - b.expiresAt);
  const expired = cards.filter((c) => c.expired).sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
  return { ok: true, waiting, expired, counts: { waiting: waiting.length, soon: waiting.filter((c) => c.soon).length, expired: expired.length } };
}

/**
 * The key NAMES the agent already holds. Source: GET /self-knowledge/session-context?full=1
 * (names only); falls back to the secret-sync key list when that is switched off. Lengths
 * and values are never read into the model.
 */
export function buildKeys(ctxRes, syncRes) {
  const clean = (arr) => [...new Set(arr.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim()))].sort((a, b) => a.localeCompare(b));
  if (ctxRes && ctxRes.ok && ctxRes.data && Array.isArray(ctxRes.data.names)) {
    const vaultState = ctxRes.data.vaultState;
    if (vaultState === 'decrypt-failed') return { ok: false, decryptFailed: true, names: [], reason: 'Can’t open the saved keys on this machine.' };
    return { ok: true, names: clean(ctxRes.data.names), source: 'vault', empty: vaultState === 'absent' };
  }
  if (syncRes && syncRes.ok && syncRes.data && Array.isArray(syncRes.data.localKeyPaths)) {
    return { ok: true, names: clean(syncRes.data.localKeyPaths), source: 'sync' };
  }
  const off = /switched off/.test((ctxRes && ctxRes.reason) || '');
  return { ok: false, decryptFailed: false, names: [], reason: off ? 'Can’t tell which keys I hold: that list is switched off on this agent.' : `Can’t tell which keys I hold: ${(ctxRes && ctxRes.reason) || 'no answer'}.` };
}

/**
 * GET /secrets/sync-status (+ GET /pool for who is registered) → the sync line.
 * 503 = sync is off: hidden (single-machine or dark), never "can't tell".
 */
export function buildSync(res, poolRes) {
  if (!res || !res.ok) {
    if (/switched off/.test((res && res.reason) || '')) return { on: false, hidden: true };
    return { on: false, hidden: false, reason: `Can’t tell whether keys sync to other machines: ${(res && res.reason) || 'no answer'}.` };
  }
  const d = res.data || {};
  const targets = Array.isArray(d.syncTargets) ? d.syncTargets.filter((t) => t && t.machineId) : [];
  const nameOf = (t) => verifiedDisplayName(t.nickname, t.machineId) || 'another machine';
  const targetIds = new Set(targets.map((t) => t.machineId));
  const pool = poolRes && poolRes.ok && poolRes.data && Array.isArray(poolRes.data.machines) ? poolRes.data : null;
  const selfId = pool ? pool.selfMachineId : null;
  const unreachable = pool ? pool.machines.filter((m) => m && m.machineId && m.machineId !== selfId && !m.isSelf && !targetIds.has(m.machineId)).map((m) => verifiedDisplayName(m.nickname, m.machineId) || 'another machine') : [];
  const push = d.mode === 'full' || d.pushEnabled === true;
  const list = targets.map(nameOf);
  const joined = list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  let words;
  if (push) words = targets.length ? `Sends my keys to ${targets.length === 1 ? joined : `${targets.length} machines (${joined})`}.` : 'Sends my keys to other machines, but none is reachable right now.';
  else words = 'Receives keys from my other machines; this one does not send.';
  return {
    on: true, hidden: false, push, words, count: targets.length,
    unreachableWords: unreachable.length ? `Not reachable now: ${unreachable.join(', ')}. ${unreachable.length === 1 ? 'It gets' : 'They get'} keys when back.` : '',
    vaultBroken: d.vault && d.vault.status === 'decrypt-failed',
  };
}

/** The vault cannot be opened (either source says so): the hands-off red line. */
export function vaultBroken(keys, sync) {
  return Boolean((keys && keys.decryptFailed) || (sync && sync.vaultBroken));
}
export const VAULT_BROKEN_WORDS = 'I can’t open my saved keys on this machine — don’t change anything; tell me.';

export function secretsHeadline({ requests, keys, sync }) {
  if (vaultBroken(keys, sync)) return { text: VAULT_BROKEN_WORDS, tone: 'bad' };
  if (!requests || !requests.ok) return { text: 'Can’t tell whether the agent is waiting on a password.', tone: 'muted' };
  const n = requests.counts.waiting;
  if (n === 0) return { text: 'Nothing is waiting.', tone: 'ok' };
  return { text: `The agent is waiting on ${n === 1 ? '1 password' : `${n} passwords`}.`, tone: 'attn' };
}

export function secretsFacts({ requests, keys, sync }) {
  const facts = [];
  if (requests && requests.ok) {
    facts.push({ n: requests.counts.waiting, label: 'waiting', tone: requests.counts.waiting ? 'attn' : null });
    if (requests.counts.soon) facts.push({ n: requests.counts.soon, label: 'expiring within 5 min', tone: 'attn' });
  } else facts.push({ n: '?', label: 'waiting' });
  if (keys && keys.ok) facts.push({ n: keys.names.length, label: keys.names.length === 1 ? 'key held' : 'keys held' });
  else facts.push({ n: '?', label: 'keys held', tone: keys && keys.decryptFailed ? 'bad' : null });
  if (sync && sync.on) facts.push({ n: sync.count, label: sync.push ? (sync.count === 1 ? 'machine synced to' : 'machines synced to') : 'receiving from others' });
  return facts.slice(0, 4);
}

/** POST /secrets/request body (routes.ts validateSecretRequestBody), or the problems in words. */
export function requestBody(form) {
  const problems = [];
  const label = String(form.label || '').trim();
  const description = String(form.note || '').trim();
  if (!label) problems.push('Say what it is (for example “OpenAI API key”).');
  else if (label.length > 255) problems.push('Keep the name under 256 characters.');
  if (description.length > 1023) problems.push('Keep the note under 1024 characters.');
  const ttlMs = Number(form.ttlMs);
  if (!TTL_CHOICES.some((c) => c.ms === ttlMs)) problems.push('Pick how long the link works.');
  let topicId;
  if (form.topicId !== undefined && form.topicId !== null && String(form.topicId) !== '') {
    topicId = Number(form.topicId);
    if (!Number.isInteger(topicId)) problems.push('That conversation can’t be told.');
  }
  if (problems.length) return { ok: false, problems };
  const body = { label, ttlMs };
  if (description) body.description = description;
  if (topicId !== undefined) body.topicId = topicId;
  return { ok: true, body };
}

/** The small "Try it with a test link" request (legacy test button, now visible). */
export function testRequestBody() {
  return { label: 'Test link from the console', description: 'Created from the console to try the secure drop. Safe to cancel.', ttlMs: TEST_TTL_MS };
}

/** The server's answer in words. */
export function resultWords(kind, status, data) {
  const err = data && typeof data.error === 'string' ? data.error : '';
  if (status === 0) return { ok: false, text: 'The server could not be reached. Nothing was sent.' };
  if (kind === 'cancel') {
    if (status === 404) return { ok: false, gone: true, text: 'That request had already ended — it was used, cancelled or expired.' };
    if (status >= 400) return { ok: false, text: `Not cancelled: ${err || `the server answered ${status}`}.` };
    return { ok: true, text: 'Cancelled. The link no longer works.' };
  }
  if (status === 429) return { ok: false, text: `Not created: ${err || 'too many open requests'}. Cancel one first.` };
  if (status === 400) return { ok: false, text: `Not created: ${err || 'the request was refused'}.` };
  if (status >= 400) return { ok: false, text: `Not created: ${err || `the server answered ${status}`}.` };
  return { ok: true, text: 'Link ready. It works once, then it is gone.' };
}

/** Share result in words (Web Share → clipboard → show the link to copy by hand). */
export function shareWords(outcome) {
  if (outcome === 'shared') return 'Shared.';
  if (outcome === 'copied') return 'Copied.';
  if (outcome === 'cancelled') return '';
  return 'Couldn’t share or copy here — press and hold the link to copy it.';
}
