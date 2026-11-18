// Projects on the Work door (docs/specs/work-front-doors.md stage 2a): pure model for GET /work/projects.
// The server owns the state words; this only shapes rows and links. No DOM here (tested in node).

import { verifiedDisplayName } from './display-identity.js';

/** Tone per state: what needs the person stands out, finished and paused are quiet. */
const TONE = { 'waiting-on-you': 'attn', 'stopped-retrying': 'bad', stalled: 'bad', drifting: 'attn', 'claims-done': 'attn', moving: 'ok', unknown: 'unknown', paused: 'quiet', done: 'quiet' };

/** A conversation key ("telegram:142909", or a bare app conversation id) as the console's chat link. */
export function conversationHref(key) {
  const k = String(key || '');
  if (!k) return null;
  const ref = /^[a-z]+:/.test(k) ? k : `app:${k}`;
  return `#/work/chats?c=${encodeURIComponent(ref)}`;
}

export function cardHref(id) { return `#/work/board?card=${encodeURIComponent(String(id || ''))}`; }

function cardView(c) {
  return { id: String(c.id), title: String(c.title || 'Untitled card'), sub: c.needLine ? String(c.needLine) : null, href: cardHref(c.id), chatHref: conversationHref(c.conversationKey) };
}

function shortDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The section's model. `ok: false` when the answer cannot be read at all (the page says so, never "no projects").
 * `line` names what could not be checked; `empty` is said only on a complete read with no projects.
 */
export function projectsView(data, now = Date.now()) {
  if (!data || !Array.isArray(data.projects)) return { ok: false };
  const active = [], finished = [];
  for (const p of data.projects) {
    const state = String(p.state || 'unknown');
    const done = p.done && Number.isFinite(p.done.total) ? p.done : { items: [], met: 0, total: 0 };
    const row = {
      key: String(p.key), title: verifiedDisplayName(p.title, p.key) || 'Project name unavailable', goal: String(p.goal || ''), state, stateWords: String(p.stateWords || ''), tone: TONE[state] || 'unknown',
      // Items nobody has checked yet are not "not done": say so instead of "0 of 3 done".
      doneLine: !done.total ? null : (done.items || []).every((i) => i.state !== 'pass' && i.state !== 'fail') ? `${done.total} to finish, not checked yet` : `${done.met} of ${done.total} done`,
      doneItems: (done.items || []).map((i) => ({ text: String(i.text), state: i.state === 'pass' ? 'pass' : i.state === 'fail' ? 'fail' : 'unknown' })),
      whyLine: state === 'unknown' && p.why ? `Why it's not known: ${String(p.why)}` : null,
      pausedLine: state === 'paused' && p.paused ? `You paused it on ${shortDate(p.paused.at)}: "${String(p.paused.quote)}"` : null,
      cards: (p.cards || []).map(cardView), moreCards: Number(p.moreCards) || 0,
      cardsLine: (p.cards || []).length ? `${(p.cards || []).length + (Number(p.moreCards) || 0)} card${(p.cards || []).length + (Number(p.moreCards) || 0) === 1 ? '' : 's'}` : null,
      chatHref: conversationHref(p.conversationKey || p.key),
      apps: appsView(p, now),
    };
    (state === 'done' ? finished : active).push(row);
  }
  const couldNot = Array.isArray(data.couldNotCheck) ? data.couldNotCheck.map(String) : [];
  const line = couldNot.length ? `Could not check ${couldNot.join(' and ')}, so this may not be everything.` : null;
  const loose = (data.notInProject || []).map(cardView);
  // Project tracking switched off is said as such, never as "no projects" (it was not checked).
  const cos = Array.isArray(data.sources) ? data.sources.find((x) => x && x.id === 'chiefOfStaff') : null;
  const off = !!cos && cos.state === 'off' && !active.length && !finished.length;
  const empty = !off && !active.length && !finished.length && !couldNot.length;
  return { ok: true, active, finished, loose, line, empty, off, count: active.length + finished.length };
}

// ── Project apps (docs/specs/project-apps.md §3.5) ──────────────────────────────────────────────
// The server adds apps / offers / answers / addable to a row only when the feature is on; a row
// without them has no apps. Every address comes from the server's own console route, and only a
// console hash route ("#/...") or the one custom-app wrapper path is ever used as a link, so a
// stored value can never become a script URL.

const MAX_BUTTONS = 3;
const DAY_MS = 24 * 3600 * 1000;
const PLATFORM = { telegram: 'Telegram', slack: 'Slack' };
const VIA = { console: 'console', desktop: 'desktop app', phone: 'phone', bearer: 'agent' };

/** A console hash route, or null for anything else (never a javascript: or outside URL). */
export function safeHash(href) {
  const h = String(href || '');
  return /^#\/[A-Za-z0-9/_\-?=&%.:]*$/.test(h) ? h : null;
}

/** The shared custom-app wrapper page, exactly this shape (project-apps-sandbox §3.6), never anything else. */
const WRAPPER_RE = /^\/dashboard\/project-app\/\?app=pa_[0-9a-f]{16}$/;

/** An app's Open link: a console hash route, or the custom-app wrapper path; null for anything else. */
export function safeAppHref(href) {
  const h = String(href || '');
  return safeHash(h) || (WRAPPER_RE.test(h) ? h : null);
}

/** How the page follows an app link: a hash route stays in the console, the wrapper is a page load. */
export function appNavigation(href) {
  const h = safeAppHref(href);
  if (!h) return null;
  return h.startsWith('#') ? { kind: 'hash', href: h } : { kind: 'page', href: h };
}

function hhmm(t) {
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * One app's summary as a line: "headline · as of 14:05", or "last updated Nov 3" when the summary is
 * more than a day old. Pending and unreadable are said as such, never as zeros.
 * Returns { text, state, action?: {label, href} }.
 */
export function summaryLine(app, now = Date.now()) {
  const state = app && app.summaryState;
  if (state === 'ok' && app.summary && app.summary.headline) {
    const t = Date.parse(app.summary.asOf);
    const when = !Number.isFinite(t) ? '' : now - t > DAY_MS ? ` · last updated ${shortDate(app.summary.asOf)}` : ` · as of ${hhmm(t)}`;
    return { text: `${String(app.summary.headline)}${when}`, state: 'ok' };
  }
  if (state === 'pending') return { text: 'Reading the board…', state: 'pending' };
  const action = app && app.summaryAction && safeHash(app.summaryAction.href) ? { label: String(app.summaryAction.label || 'Open'), href: safeHash(app.summaryAction.href) } : null;
  return { text: app && app.summaryWhy ? String(app.summaryWhy) : 'The summary could not be read.', state: 'unreadable', ...(action ? { action } : {}) };
}

/** The pin status line for an attached app, or null when there is nothing to say or do. */
export function pinLine(pin) {
  if (!pin || typeof pin !== 'object') return null;
  const where = PLATFORM[pin.platform] || 'the conversation';
  if (pin.state === 'failed') return { text: `Couldn't pin the link in ${where}: ${pin.reason ? String(pin.reason) : 'no reason was given'}`, tone: 'bad', action: { label: 'Try again', act: 'retry' } }; // warning-path: inline
  if (pin.state === 'out-of-date') return { text: 'The pinned link is out of date', tone: 'attn', action: { label: 'Update link', act: 'update-link' } }; // warning-path: inline
  if (pin.state === 'uncertain') return { text: 'I may have posted the link already; check the conversation', tone: 'attn', action: { label: 'Post the link again', act: 'post-again' } }; // warning-path: inline
  if (pin.state === 'pending') return { text: `Pinning the link in ${where}…`, tone: 'quiet', action: null };
  return null;
}

function answerWords(a, title) {
  const on = shortDate(a.at);
  const via = VIA[a.via] ? ` (${VIA[a.via]})` : '';
  if (a.by === 'agent') return `Your agent withdrew ${title}${on ? ` on ${on}` : ''}`;
  const verb = a.answer === 'attach' ? 'attached' : a.answer === 'decline' ? 'said no to' : a.answer === 'detach' ? 'removed' : String(a.answer || 'answered');
  return `You ${verb} ${title}${on ? ` on ${on}` : ''}${via}`;
}

/** The first line of the agent's reason, and the rest (shown when expanded). */
function splitWhy(why) {
  const s = String(why || '').trim();
  const i = s.indexOf('\n');
  return i < 0 ? { first: s, rest: '' } : { first: s.slice(0, i).trim(), rest: s.slice(i + 1).trim() };
}

/**
 * A project row's apps, shaped for the page. `has` is false when the row carries no app fields at
 * all (feature off), so the page adds nothing.
 */
/**
 * A custom app that does not run (project-apps-sandbox, part 2): the words in place of its summary, or
 * null when it runs (or is a builtin app, which carries no state). Such an app has nothing to open.
 */
export function notRunningLine(app) {
  const state = app && app.state;
  if (state === 'off') return { text: 'Stopped', state: 'off' };
  if (state === 'not-approved') return { text: 'Waiting for your approval', state: 'not-approved' };
  return null;
}

export function appsView(row, now = Date.now()) {
  const r = row || {};
  const has = ['apps', 'offers', 'answers', 'addable'].some((k) => Array.isArray(r[k]));
  const apps = (Array.isArray(r.apps) ? r.apps : []).filter((a) => a && a.appRef).map((a) => {
    const title = String(a.title || a.appRef);
    const off = notRunningLine(a);
    return {
      appRef: String(a.appRef), title, label: `Open ${title}`, href: off ? null : safeAppHref(a.openHref),
      line: off || summaryLine(a, now), pin: pinLine(a.pin), ...(off ? { notRunning: off.state } : {}),
    };
  });
  const titles = new Map();
  for (const list of [r.addable, r.offers, r.apps]) for (const x of Array.isArray(list) ? list : []) if (x && x.appRef) titles.set(String(x.appRef), String(x.title || x.appRef));
  const titleOf = (ref) => titles.get(String(ref)) || String(ref);
  const offers = (Array.isArray(r.offers) ? r.offers : []).filter((o) => o && o.appRef).map((o) => {
    const why = splitWhy(o.why);
    return { appRef: String(o.appRef), title: titleOf(o.appRef), label: `Your agent suggests: ${titleOf(o.appRef)}`, whyFirst: why.first, whyRest: why.rest, at: String(o.at || '') };
  });
  const addable = (Array.isArray(r.addable) ? r.addable : []).filter((x) => x && x.appRef).map((x) => ({ appRef: String(x.appRef), title: titleOf(x.appRef), note: x.note ? String(x.note) : null }));
  const answers = (Array.isArray(r.answers) ? r.answers : []).filter((a) => a && a.appRef).map((a) => ({ appRef: String(a.appRef), text: answerWords(a, titleOf(a.appRef)) }));
  const withHref = apps.filter((a) => a.href);
  return {
    has,
    buttons: withHref.slice(0, MAX_BUTTONS),
    more: Math.max(0, withHref.length - MAX_BUTTONS),
    // A stopped or unapproved app reads "Sales pipeline · Stopped" on the collapsed row (no Open there).
    headline: !apps.length ? null : apps[0].notRunning ? { text: `${apps[0].title} · ${apps[0].line.text}`, state: apps[0].line.state } : apps[0].line,
    apps, offers, addable, answers,
    pins: apps.filter((a) => a.pin).map((a) => ({ appRef: a.appRef, title: a.title, ...a.pin })),
    hint: offers.length ? (offers.length === 1 ? 'Your agent has a suggestion' : `Your agent has ${offers.length} suggestions`) : null,
  };
}

/** A project key in the console's conversation form ("telegram:128732", "app:<id>"). */
export function conversationRefOf(key) {
  const k = String(key || '');
  if (!k) return '';
  return /^[a-z]+:/.test(k) ? k : `app:${k}`;
}

/**
 * The strip for an open conversation: the project whose key is that conversation, when it has an
 * attached app. `ref` is the conversation as "kind:id". Null when there is none or the read failed.
 */
export function appStripFor(data, ref, now = Date.now()) {
  if (!data || !Array.isArray(data.projects) || !ref) return null;
  const want = String(ref);
  const p = data.projects.find((x) => x && conversationRefOf(x.conversationKey || x.key) === want);
  if (!p) return null;
  const v = appsView(p, now);
  // The first app that opens; else the first that does not run, said plainly with nothing to open.
  const first = v.apps.find((a) => a.href) || v.apps.find((a) => a.notRunning);
  if (!first) return null;
  return { projectKey: String(p.key), appRef: first.appRef, title: first.title, label: first.href ? 'Open' : null, href: first.href || null, line: first.line };
}

/** The path of a project-app write route. */
export function appPath(projectKey, appRef, what) {
  return `/work/projects/${encodeURIComponent(String(projectKey))}/apps/${encodeURIComponent(String(appRef))}/${what}`;
}
