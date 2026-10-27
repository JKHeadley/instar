// Paste to a session (docs/specs/console-features/work.md, "Send content", legacy tab id
// `dropzone`). It lives inside Sessions: "Paste to a session" at the bottom of the list
// (asks which session; the most recently active one is preselected and named) and
// "Paste long text" in an open session's "⋯" menu (target fixed). Every decision lives
// here, pure and unit-tested: the counts, the targets, the exact POST /pastes body, the
// server's answer in words (delivered / waiting / failed), the live paste events, the
// recent list (last 20, this machine only), the delete confirm and its answer, and the
// "Type it into the session" path for a session on another machine (a stored paste only
// reaches this machine's sessions). Nothing here touches the DOM.
//
// Routes: POST /pastes, GET /pastes, DELETE /pastes/:id, and the WebSocket `input` frame.
// All take the bearer token alone; there is no PIN.

export const LABEL_MAX = 256;
export const RECENT_MAX = 20;
export const TYPE_ANSWER_MS = 8000;

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

/** "12,400 characters, about 3,100 tokens" (about 4 characters a token, as the legacy tab counts). */
export function countWords(text) {
  const chars = String(text || '').length;
  if (!chars) return 'Nothing pasted yet.';
  return `${plural(chars, 'character')}, about ${plural(Math.max(1, Math.round(chars / 4)), 'token')}`;
}

/** The storage notice, with the server's own retention when it is known. */
export function keptWords(retentionDays) {
  const d = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 7;
  return `Kept on this machine for ${plural(d, 'day')}. Don’t paste passwords or keys.`;
}

const lastOf = (s) => Date.parse(s && s.telemetry && s.telemetry.lastActivity) || Date.parse(s && s.startedAt) || 0;
const ageWords = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'active now';
  if (m < 60) return `active ${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `active ${h} h ago` : `active ${Math.floor(h / 24)} d ago`;
};

/**
 * Who can receive a paste, from the Sessions model's rows (`row.session`, `row.title`).
 * Conversations only (a scheduled job never gets one, as the server's own pick skips them).
 * This machine's sessions come first, most recently active first; another machine's
 * sessions follow and are typed in instead. With nothing here running, the one stored
 * choice is "the next session that starts" (no target: the server keeps it waiting).
 */
export function pasteTargets(rows, { now = Date.now(), fixedKey = null } = {}) {
  const all = (Array.isArray(rows) ? rows : []).filter((r) => r && r.session && r.session.type !== 'job');
  const sorted = [...all].sort((a, b) => lastOf(b.session) - lastOf(a.session));
  const local = sorted.filter((r) => !r.session.remote);
  const remote = sorted.filter((r) => r.session.remote);
  const choices = [];
  for (const r of local) {
    const t = lastOf(r.session);
    const age = t ? ageWords(now - t) : null;
    choices.push({ value: r.key, kind: 'paste', row: r, label: age ? `${r.title}, ${age}` : r.title });
  }
  if (!local.length) choices.push({ value: '__next__', kind: 'next', row: null, label: 'The next session that starts on this machine' });
  for (const r of remote) choices.push({ value: r.key, kind: 'type', row: r, label: `${r.title}, on ${r.session.machineNickname || 'another machine'} (typed in)` });
  if (fixedKey) {
    const hit = choices.find((c) => c.value === fixedKey);
    return { choices: hit ? [hit] : [], value: hit ? hit.value : null, fixed: true };
  }
  return { choices, value: choices.length ? choices[0].value : null, fixed: false };
}

/** The line under the picker: where it goes, and how, in words. */
export function targetWords(choice) {
  if (!choice) return 'That session is not running any more.';
  if (choice.kind === 'next') return 'No conversation is running on this machine; it will be delivered when one starts.';
  if (choice.kind === 'type') return `${choice.row.session.machineNickname || 'That machine'} is another machine, so a stored paste can’t reach it. This is typed in like a message: it is not kept as a paste.`;
  return `Goes to ${choice.row.title}.`;
}

/** The exact POST /pastes body, or the reasons it never leaves the page. */
export function pasteBody({ text, label, choice }) {
  const problems = [];
  if (!String(text || '').trim()) problems.push('Paste some text first.');
  const l = String(label || '').trim();
  if (l.length > LABEL_MAX) problems.push(`The label is ${fmt(l.length)} characters; keep it under ${LABEL_MAX}.`);
  if (!choice) problems.push('Pick a session.');
  else if (choice.kind === 'type') problems.push('That session is on another machine; use Type it into the session.');
  if (problems.length) return { ok: false, problems };
  const body = { content: String(text) };
  if (l) body.label = l;
  if (choice.kind === 'paste' && choice.row.session.name) body.targetSession = choice.row.session.name;
  return { ok: true, body };
}

/** The server's answer to POST /pastes in words. failed keeps the text in the box. */
export function pasteResultWords(status, data, { titleOf } = {}) {
  const d = data || {};
  if (status === 201 || (status >= 200 && status < 300 && d.ok)) {
    const chars = plural(d.contentLength || 0, 'character');
    if (d.status === 'notified') {
      const who = (titleOf && titleOf(d.sessionName)) || d.sessionName || 'the session';
      return { state: 'delivered', tone: 'ok', pasteId: d.pasteId || null, text: `Delivered ${chars} to ${who}.` };
    }
    return { state: 'waiting', tone: 'attn', pasteId: d.pasteId || null, text: `No session was ready; the ${chars} will be delivered when one starts. It stays in Recent pastes until then.` };
  }
  if (status === 503) return { state: 'failed', tone: 'bad', text: 'Not sent: pasting is switched off on this agent. Your text is still here.' };
  if (status === 429) return { state: 'failed', tone: 'bad', text: 'Not sent: too many pastes in the last minute. Wait a moment and send again; your text is still here.' };
  if (status === 0) return { state: 'failed', tone: 'bad', text: 'Not sent: the server could not be reached. Your text is still here.' };
  const why = d.message || d.error;
  return { state: 'failed', tone: 'bad', text: why ? `Not sent: ${String(why).replace(/\.$/, '')}. Your text is still here.` : `Not sent: the server answered ${status}. Your text is still here.` };
}

/** A paste's status in words. */
export function statusWords(status) {
  if (status === 'notified') return { text: 'delivered', tone: 'ok' };
  if (status === 'acknowledged') return { text: 'read by the session', tone: 'ok' };
  if (status === 'written' || status === 'queued') return { text: 'waiting for a session', tone: 'attn' };
  return { text: status ? `status unknown (${status})` : 'status unknown', tone: 'unknown' };
}

const agoWords = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
};

/** GET /pastes → the Recent pastes list (newest first, last 20), or can't tell with the reason. */
export function buildRecent(res, { now = Date.now() } = {}) {
  if (!res || !res.ok) return { ok: false, reason: `Can’t list recent pastes: ${(res && res.reason) || 'no answer'}.` };
  const data = res.data || {};
  if (!Array.isArray(data.pastes)) return { ok: false, reason: 'Can’t list recent pastes: the answer had no list.' };
  const all = data.pastes.filter((p) => p && p.pasteId).sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
  const days = data.stats && Number.isFinite(data.stats.retentionDays) ? data.stats.retentionDays : 7;
  const rows = all.slice(0, RECENT_MAX).map((p) => {
    const sw = statusWords(p.status);
    return {
      id: p.pasteId, title: p.label ? String(p.label) : 'No label', status: sw.text, tone: sw.tone,
      sub: [plural(p.contentLength || 0, 'character'), agoWords(now - Date.parse(p.timestamp)), sw.text, p.targetSession ? `for ${p.targetSession}` : null].filter(Boolean).join(' · '),
    };
  });
  const waiting = all.filter((p) => p.status === 'written' || p.status === 'queued').length;
  return { ok: true, rows, total: all.length, waiting, retentionDays: days, more: Math.max(0, all.length - rows.length) };
}

/** "Recent pastes (3)" and the line under it. */
export function recentHead(m) {
  if (!m || !m.ok) return { title: 'Recent pastes', sub: m ? m.reason : 'Not read yet.' };
  const sub = m.total === 0 ? `None in the last ${plural(m.retentionDays, 'day')}, on this machine.`
    : `${fmt(m.total)} in the last ${plural(m.retentionDays, 'day')}, on this machine only${m.waiting ? ` · ${fmt(m.waiting)} waiting` : ''}${m.more ? ` · newest ${RECENT_MAX} shown` : ''}.`;
  return { title: `Recent pastes (${fmt(m.total)})`, sub };
}

export const DELETE_CONFIRM = 'Delete this paste? The session keeps what it already read.';

/** The server's answer to DELETE /pastes/:id in words. */
export function deleteResultWords(status, data) {
  const d = data || {};
  if (status === 200 && d.deleted !== false) return { ok: true, text: 'Deleted.' };
  if (status === 404) return { ok: true, gone: true, text: 'Already gone.' };
  if (status === 503) return { ok: false, text: 'Not deleted: pasting is switched off on this agent.' };
  if (status === 0) return { ok: false, text: 'Not deleted: the server could not be reached.' };
  return { ok: false, text: d.message || d.error ? `Not deleted: ${String(d.message || d.error).replace(/\.$/, '')}.` : `Not deleted: the server answered ${status}.` };
}

/** A live paste event from the socket: which paste, and its new state in words. */
export function pasteEvent(msg, { titleOf } = {}) {
  if (!msg || (msg.type !== 'paste_delivered' && msg.type !== 'paste_acknowledged')) return null;
  const who = (titleOf && titleOf(msg.session)) || msg.session || 'the session';
  if (msg.type === 'paste_delivered') return { pasteId: msg.pasteId || null, state: 'delivered', tone: 'ok', text: `Delivered ${plural(msg.contentLength || 0, 'character')} to ${who}.` };
  return { pasteId: msg.pasteId || null, state: 'read', tone: 'ok', text: `${who} has read it.` };
}

/**
 * Typing into another machine's session: the answer to the `input` frame in words.
 * answer is { ack: boolean } (input_ack), { code } (an error frame), or { timeout: true }.
 */
export function typeResultWords(answer, machine) {
  const where = machine || 'that machine';
  if (answer && answer.ack === true) return { ok: true, tone: 'ok', text: `Typed into the session on ${where}.` };
  if (answer && answer.ack === false) return { ok: false, tone: 'bad', text: `${where} did not take it: the session did not accept the text. Your text is still here.` };
  const code = answer && answer.code;
  if (code === 'input-not-allowed') return { ok: false, tone: 'bad', text: `${where} doesn’t accept typing from other machines. Your text is still here.` };
  if (code === 'machine-unreachable') return { ok: false, tone: 'bad', text: `${where} is not answering. Your text is still here.` };
  if (code === 'session-not-found') return { ok: false, tone: 'bad', text: `That session is not running on ${where} any more. Your text is still here.` };
  if (code === 'not-connected') return { ok: false, tone: 'bad', text: 'Not sent: live updates are paused, reconnecting. Your text is still here.' };
  if (code) return { ok: false, tone: 'bad', text: `${where} refused it (${code}). Your text is still here.` };
  return { ok: false, tone: 'unknown', text: `No answer from ${where} yet, so I can’t tell whether it arrived. Look at the session before sending again.` };
}
