// Sessions page model (docs/specs/console-features/work.md, "Sessions", legacy tab id
// `sessions`). Every decision lives here, pure and unit-tested: which sessions are
// running where, which need a look (quiet, or running on two machines at once), the
// model in words, machines that did not answer, the exact bodies of every write
// (create, close, remote close, door switch, the new-topic default) and the server's
// answers in words, and the WebSocket frames the terminal sends. Nothing here touches
// the DOM.

import { verifiedDisplayName, uniqueNamedChoices } from './display-identity.js';
import { sessionTopicName } from './topic-names.js';

export const WORKING_MS = 2 * 60_000;   // activity under 2 min reads "working"
export const QUIET_MS = 10 * 60_000;    // 10+ min without activity reads "quiet" (never "stuck")
export const HISTORY_FIRST = 2000;      // lines the server sends on subscribe
export const HISTORY_STEP = 5000;
export const HISTORY_MAX = 50_000;

const isActive = (s) => s && (s.status === 'running' || s.status === 'starting');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "now", "4 min", "2 h", "3 days": a span in words. */
export function spanWords(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return plural(d, 'day');
}

/** A model id in words. A bare family name means the exact version was not recorded. */
export function modelWords(id) {
  if (!id || typeof id !== 'string') return null;
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  let m = /^(fable|opus|sonnet|haiku)$/i.exec(id);
  if (m) return `${cap(m[1].toLowerCase())}, version not recorded`;
  m = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/.exec(id);
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  m = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?$/.exec(id);
  if (m) return `GPT-${m[1]}${m[2] ? ' ' + cap(m[2]) : ''}`;
  return id;
}

/** The short model name for option lists ("Opus 5.5", "Opus (latest)"). */
export function modelOptionWords(id) {
  if (/^(fable|opus|sonnet|haiku)$/.test(id || '')) return `${id.charAt(0).toUpperCase()}${id.slice(1)} (latest)`;
  return modelWords(id) || id;
}

/** Stable row key: another machine's tmux name never collides with a local one. */
export function sessionKey(s) {
  return s.remote ? `remote:${s.machineId || '?'}:${s.tmuxSession}` : String(s.tmuxSession || s.id || s.name);
}

/** The name the operator knows: the Telegram topic name when there is one. */
export function sessionTitle(s, topicNames = {}) {
  const n = String(sessionTopicName(s, topicNames) || (s && (s.name || s.tmuxSession)) || 'A session').replace(/^\[.*?\]\s*/, '').trim();
  return n.length > 80 ? n.slice(0, 77) + '…' : n || 'A session';
}

/** What the session is doing, from its last tool activity. Quiet is never called stuck. */
export function activity(s, now = Date.now()) {
  if (s && s.status === 'starting') return { state: 'starting', words: 'starting', end: 'starting' };
  const last = Date.parse(s && s.telemetry && s.telemetry.lastActivity);
  if (!Number.isFinite(last)) return { state: 'no-reading', words: 'no activity reading', end: '' };
  const age = Math.max(0, now - last);
  const span = spanWords(age);
  if (age < WORKING_MS) return { state: 'working', words: span === 'now' ? 'active now' : `active ${span} ago`, end: span, ageMs: age };
  if (age >= QUIET_MS) {
    const min = Math.floor(age / 60_000);
    return { state: 'quiet', words: `quiet for ${min < 60 ? `${min} min` : span}`, end: min < 60 ? `${min} min` : span, ageMs: age };
  }
  return { state: 'calm', words: `active ${span} ago`, end: span, ageMs: age };
}

/** "3 sessions running on 2 machines" bookkeeping: the merged pool list. */
export function mergeSessions(poolData, wsSessions) {
  const all = Array.isArray(poolData && poolData.sessions) ? poolData.sessions : [];
  const poolLocal = all.filter((s) => s && s.remote !== true && isActive(s));
  const remote = all.filter((s) => s && s.remote === true && isActive(s));
  let local = poolLocal;
  if (Array.isArray(wsSessions)) {
    // The live list wins for this machine; the pool read adds what the socket does not carry.
    const byTmux = new Map(poolLocal.map((s) => [s.tmuxSession, s]));
    local = wsSessions.filter(isActive).map((w) => {
      const p = byTmux.get(w.tmuxSession) || {};
      return { ...p, ...w, protected: p.protected, machineId: p.machineId, machineNickname: w.machineNickname || p.machineNickname, telemetry: w.telemetry || p.telemetry };
    });
  }
  return { local, remote };
}

/** One machine's name, from the pool roster, never a raw id when a name exists. */
function nicknameOf(pool, machineId) {
  const m = (pool && Array.isArray(pool.machines) ? pool.machines : []).find((x) => x.machineId === machineId);
  return verifiedDisplayName(m && m.nickname, machineId) || 'another machine';
}

/**
 * The whole list. sessionsRes is the GET /sessions?scope=pool read; ws is the live
 * socket's list for this machine (null when the socket has not sent one).
 */
/** The message a session receives for attached files: the operator's text, then one
 *  line per file naming where it was saved, so the session can open it. */
export function attachmentMessage(text, paths) {
  const lines = paths.map((p) => `[Attached file from the dashboard: ${p} (read it to see what I sent)]`);
  return [String(text || '').trim(), ...lines].filter(Boolean).join('\n');
}

/** `triggeredBy` on a session the operator created from the dashboard's New session box. */
export const OPERATOR_CREATED = 'dashboard-operator';

/** Internal = machinery the operator did not start: scheduled jobs, and helper sessions
 *  the agent spawned for itself (no chat attached, not created from the dashboard). A
 *  conversation (Telegram, Slack, ...) is never internal. Hidden by default, one toggle away. */
export function isInternalSession(s) {
  if (!s) return false;
  if (s.jobSlug || s.type === 'job') return true;
  return (s.platform || 'headless') === 'headless' && s.triggeredBy !== OPERATOR_CREATED;
}

/** The History read for a session: its conversation record, a page at a time. A session
 *  on another machine is read through this machine, which asks the owner. */
export const HISTORY_PAGE = 150;
export function historyUrl(s, before = null) {
  const q = new URLSearchParams({ limit: String(HISTORY_PAGE) });
  if (before != null) q.set('before', String(before));
  if (s.remote && s.machineId) q.set('machineId', s.machineId);
  return `/sessions/${encodeURIComponent(s.tmuxSession)}/transcript?${q}`;
}

/** Words for a failed History read: never "no history" when the read failed. */
export function historyErrorWords(res) {
  const d = (res && res.data) || {};
  if (d.reason === 'no-transcript') return 'This session has no conversation record yet.';
  if (d.reason === 'peer-unreachable' || d.reason === 'peer-unknown') return `Can’t tell: ${d.error || 'the session’s machine did not answer'}.`;
  const why = d.error || (res && res.reason) || (res && res.status ? `the server answered ${res.status}` : 'the server could not be reached');
  return `Can’t tell: ${String(why).replace(/\.$/, '')}.`;
}

/** A user line from a chat bridge carries a routing prefix; show only what was said. */
export function historyText(e) {
  let t = String((e && e.text) || '');
  if (e && e.role === 'user') t = t.replace(/^\[(telegram|slack|whatsapp):[^\]]*\]\s*/, '');
  return t;
}

export function buildSessions(sessionsRes, { ws = null, now = Date.now(), topicNames = {}, showInternal = false } = {}) {
  if (!sessionsRes || !sessionsRes.ok) return { ok: false, reason: `Couldn’t list sessions: ${(sessionsRes && sessionsRes.reason) || 'no answer'}.` };
  const data = sessionsRes.data || {};
  if (!Array.isArray(data.sessions)) return { ok: false, reason: 'The session list answered without sessions.' };
  const pool = data.pool || {};
  const selfName = pool.selfMachineNickname || null;
  const machines = Array.isArray(pool.machines) ? pool.machines : [];
  const multi = pool.enabled === true && machines.length >= 2;
  const { local, remote } = mergeSessions(data, ws);
  const duplicateConversations = new Set((Array.isArray(pool.duplicateTopics) ? pool.duplicateTopics : [])
    .filter((d) => typeof d.platform === 'string' && d.platformId != null)
    .map((d) => `${d.platform}:${String(d.platformId)}`));
  const allRows = [...local.map((s) => ({ ...s, machineNickname: s.machineNickname || selfName })), ...remote].map((s) => {
    const a = activity(s, now);
    const duplicate = s.duplicateTopic === true || (typeof s.platform === 'string' && s.platformId != null
      && duplicateConversations.has(`${s.platform}:${String(s.platformId)}`));
    const machine = verifiedDisplayName(s.machineNickname, s.machineId) || (s.remote ? nicknameOf(pool, s.machineId) : 'This machine');
    const started = Date.parse(s.startedAt);
    const running = Number.isFinite(started) ? spanWords(now - started) : null;
    const sub = [machine, running && running !== 'now' ? running : running ? 'just started' : null, duplicate ? 'running on two machines at once' : a.state === 'no-reading' ? null : a.words].filter(Boolean).join(' · ');
    return {
      key: sessionKey(s), title: sessionTitle(s, topicNames), sub, end: a.end, activity: a.state, duplicate, internal: isInternalSession(s),
      tone: duplicate ? 'bad' : a.state === 'quiet' ? 'attn' : a.state === 'no-reading' ? 'unknown' : null,
      machine, remote: s.remote === true, model: modelWords(s.model),
      session: { tmuxSession: s.tmuxSession, id: s.id, name: s.name, machineId: s.machineId || null, machineNickname: machine, remote: s.remote === true, protected: s.protected, platform: s.platform || 'headless', platformId: s.platformId ?? null, model: s.model || null, type: s.type || (s.jobSlug ? 'job' : 'interactive'), internal: isInternalSession(s), telemetry: s.telemetry || null, startedAt: s.startedAt || null, status: s.status },
    };
  });
  // Most recently active first inside each group.
  const lastOf = (r) => Date.parse(r.session.telemetry && r.session.telemetry.lastActivity) || Date.parse(r.session.startedAt) || 0;
  allRows.sort((x, y) => lastOf(y) - lastOf(x));
  const hiddenInternal = showInternal ? 0 : allRows.filter((r) => r.internal).length;
  const internalCount = allRows.filter((r) => r.internal).length;
  const rows = showInternal ? allRows : allRows.filter((r) => !r.internal);
  const needsLook = rows.filter((r) => r.duplicate || r.activity === 'quiet');
  const working = rows.filter((r) => !needsLook.includes(r));
  const failedIds = new Set((Array.isArray(pool.failed) ? pool.failed : []).map((f) => f.machineId));
  const unanswered = [...failedIds].map((id) => {
    const m = machines.find((x) => x.machineId === id);
    const es = m && m.emptyState;
    const last = es && es.lastSeen ? spanWords(now - Date.parse(es.lastSeen)) : null;
    return { machineId: id, name: nicknameOf(pool, id), words: last && last !== 'now' ? `not answering (last seen ${last} ago)` : 'not answering' };
  });
  const idleMachines = multi ? machines.filter((m) => m.sessionCount === 0 && !failedIds.has(m.machineId)).map((m) => ({
    machineId: m.machineId, name: verifiedDisplayName(m.nickname, m.machineId) || 'another machine',
    words: m.emptyState && m.emptyState.text ? (m.emptyState.kind === 'online' ? 'answering, nothing running' : m.emptyState.text) : 'state unknown',
    ok: Boolean(m.emptyState && m.emptyState.kind === 'online'),
  })) : [];
  const machineCount = multi ? machines.length : 1;
  return {
    ok: true, rows, allRows, hiddenInternal, internalCount, showInternal, needsLook, working, idleMachines, unanswered, multi, selfName,
    selfMachineId: pool.selfMachineId || null,
    counts: { running: rows.length, quiet: rows.filter((r) => r.activity === 'quiet').length, duplicate: rows.filter((r) => r.duplicate).length, machines: machineCount, answering: machineCount - unanswered.length },
  };
}

/** The page's one sentence. */
export function sessionsHeadline(m) {
  if (!m || !m.ok) return { text: 'Can’t tell what is running.', tone: 'unknown' };
  const { running, quiet, duplicate } = m.counts;
  const lead = running === 0 ? 'Nothing is running.' : `${plural(running, 'session')} running.`;
  let tail = '';
  if (duplicate) tail = duplicate === 1 ? ' One is running on two machines at once.' : ` ${duplicate} are running on two machines at once.`;
  else if (quiet === 1) {
    const q = m.needsLook.find((r) => r.activity === 'quiet');
    tail = ` One has been quiet for ${q ? q.end.replace(' min', ' minutes') : 'a while'}.`;
  } else if (quiet > 1) tail = ` ${quiet} have been quiet for 10+ minutes.`;
  else if (running === 0 && m.unanswered.length === 0) tail = m.multi ? ' Machines: all answering.' : '';
  return { text: lead + tail, tone: duplicate ? 'bad' : quiet ? 'attn' : 'ok' };
}

/** At most four facts. "Waiting on you" is omitted: sessions do not report it yet. */
export function sessionsFacts(m) {
  if (!m || !m.ok) return [];
  const f = [{ n: m.counts.running, label: 'running', tone: null }, { n: m.counts.quiet, label: 'quiet 10+ min', tone: m.counts.quiet ? 'attn' : null }];
  if (m.counts.duplicate) f.push({ n: m.counts.duplicate, label: 'on two machines', tone: 'bad' });
  if (m.multi) f.push({ n: `${m.counts.answering} of ${m.counts.machines}`, label: 'machines answering', tone: m.unanswered.length ? 'attn' : null });
  return f;
}

/** The partial-coverage line: named machines whose sessions are not shown. */
export function partialWords(m) {
  if (!m || !m.ok || !m.unanswered.length) return null;
  const names = m.unanswered.map((u) => u.name);
  return `${names.join(', ')} did not answer; ${names.length === 1 ? 'its' : 'their'} sessions are not shown.`;
}

/** The title bar under the name: "Mac Studio · Opus 5.5". */
export function titleLine(s) {
  return [s.machineNickname, modelWords(s.model) || 'model not recorded', s.type === 'job' ? 'scheduled job' : null].filter(Boolean).join(' · ');
}

// ── Close ────────────────────────────────────────────────────────────────
/** The exact request: local DELETE, or the relay to the owning machine. */
export function closeRequest(s) {
  if (s.remote) return { method: 'POST', path: `/sessions/${encodeURIComponent(s.tmuxSession)}/remote-close`, body: { machineId: s.machineId, sessionUuid: s.id } };
  return { method: 'DELETE', path: `/sessions/${encodeURIComponent(s.tmuxSession)}`, body: null };
}

/** The one-sentence confirm, with the protected warning or the honest unknown. */
export function closeConfirmWords(s, title) {
  const where = s.remote ? ` on ${s.machineNickname || 'another machine'}` : '';
  const lines = [`Close “${title}”${where}? Its conversation is kept.`];
  if (s.protected === true) lines.push('This one is normally kept running.');
  else if (s.remote && s.protected === undefined) lines.push('That machine did not say whether this one is normally kept running.');
  return lines;
}

/** The server's answer in words. gone = already closed; unknown = check again. */
export function closeResultWords(s, status, data) {
  const d = data || {};
  const where = s.remote ? ` on ${s.machineNickname || 'that machine'}` : '';
  if (s.remote) {
    if (status === 200 && d.alreadyClosed) return { ok: true, gone: true, text: 'Already closed.' };
    if (status === 200) return { ok: true, text: `Closed${where}.` };
    if (d.outcomeUnknown) return { ok: false, unknown: true, text: 'Outcome unknown, checking.' };
    if (status === 404) return { ok: false, text: 'That machine is not one this agent knows.' };
    return { ok: false, text: d.error ? `Not closed: ${d.error}.` : `Not closed: the server answered ${status || 'nothing'}.` };
  }
  if (status === 200) return { ok: true, text: 'Closed.' };
  if (status === 404) return { ok: true, gone: true, text: 'Already closed.' };
  if (status === 409) return { ok: false, text: 'Not closed: the server kept it running.' };
  return { ok: false, text: d.error ? `Not closed: ${d.error}.` : status ? `Not closed: the server answered ${status}.` : 'Not closed: the server could not be reached.' };
}

// ── Doors and models (POST /sessions/create, /topic-profile/*) ───────────
/** Door options; a door that can't be picked says why and is disabled. */
export function doorChoices(options, { withAgentDefault = false } = {}) {
  const doors = Array.isArray(options && options.doors) ? options.doors : [];
  const hasDefault = options && options.newTopicDefault && options.newTopicDefault.framework;
  const out = [];
  if (withAgentDefault && !hasDefault) out.push({ value: '', label: 'Agent default', disabled: false });
  for (const d of doors) {
    let label = d.label || d.framework;
    if (d.availability === 'assumed') label += ' (not verified)';
    if (!d.selectable) label += ` — ${d.reason || 'unavailable'}${d.chatOnly ? ' (you can still pin this in chat)' : ''}`;
    out.push({ value: d.framework, label, disabled: !d.selectable });
  }
  return out;
}

/** Model options for one door: "Account default" first; dated twins folded away. */
export function modelChoices(options, framework, selected = null) {
  const door = (Array.isArray(options && options.doors) ? options.doors : []).find((d) => d.framework === framework);
  if (!door) return { disabled: true, choices: [{ value: '', label: '—' }], value: '' };
  const models = Array.isArray(door.models) ? door.models : [];
  const set = new Set(models);
  const shown = models.filter((m) => { if (m === selected) return true; const dated = /^(.*)-\d{8}$/.exec(m); return !(dated && set.has(dated[1])); });
  const choices = [{ value: '', label: 'Account default' }, ...shown.map((m) => ({ value: m, label: modelOptionWords(m) }))];
  const want = selected !== undefined && selected !== null ? selected : (door.defaultModel || '');
  return { disabled: false, choices, value: choices.some((c) => c.value === want) ? want : '' };
}

/** "Claude Code · Opus 5.5". */
export function doorModelWords(options, framework, model) {
  const door = (Array.isArray(options && options.doors) ? options.doors : []).find((d) => d.framework === framework);
  return `${door ? door.label : framework} · ${model ? modelOptionWords(model) : 'Account default'}`;
}

/** The regime note: what a model choice actually does on this agent. */
export function regimeWords(options) {
  const r = options && options.regime;
  if (r === 'dry-run') return 'On this agent a chosen model is recorded as intent, not applied; the door still switches.';
  if (r === 'disabled') return 'On this agent the door switch works, but model choice is turned off; a model will be refused.';
  return null;
}

/** Machine options for a new session: only when 2+ machines; offline and clock-out disabled. */
export function machineChoices(poolRes) {
  const data = poolRes && poolRes.ok ? poolRes.data : null;
  const machines = data && Array.isArray(data.machines) ? data.machines : [];
  if (machines.length < 2) return null;
  const self = data.selfMachineId || null;
  const uniqueMachines = new Set(uniqueNamedChoices(machines, (m) => m.machineId, (m) => m.nickname).map((m) => m.machineId));
  const out = [{ value: '', label: 'Automatic', disabled: false }];
  for (const m of machines) {
    if (!m || typeof m.machineId !== 'string') continue;
    let label = verifiedDisplayName(m.nickname, m.machineId) || 'Machine name unavailable';
    if (m.machineId === self) label += ' (this machine)';
    const offline = m.online !== true;
    const clockOff = m.clockSkewStatus === 'suspect-clock-removed';
    if (offline) { const ls = m.liveness && m.liveness.state; label += ls === 'unreachable' ? ' (not answering)' : ls === 'stale' ? ' (not checked recently)' : ' (no recent contact)'; }
    else if (clockOff) label += ' (clock out of step)';
    else if (m.quotaState && m.quotaState.blocked === true) label += ' (at usage limit)';
    out.push({ value: m.machineId, label, disabled: offline || clockOff || !uniqueMachines.has(m.machineId), self: m.machineId === self });
  }
  return { choices: out, selfMachineId: self };
}

export const PLATFORMS = [
  { value: 'auto', label: 'Automatic' },
  { value: 'telegram', label: 'Telegram topic' },
  { value: 'slack', label: 'Slack' },
  { value: 'headless', label: 'No chat (terminal only)' },
];

/** Door and model apply to Telegram topics only (v1); so does the machine choice. */
export function platformAllowsDoor(platform) { return platform !== 'headless' && platform !== 'slack'; }

/**
 * The exact POST /sessions/create body. An unchanged door/model pick sends nothing,
 * so the server seeds its own default, exactly as the legacy modal does.
 */
export function createBody({ name, platform = 'auto', framework = '', model = '', machine = '' }, options) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, problems: ['Give it a name.'] };
  const body = { name: n, headless: platform === 'headless' };
  if (platform !== 'auto') body.platform = platform;
  if (platformAllowsDoor(platform) && framework) {
    const def = options && options.newTopicDefault;
    const pick = { framework, model: model || null };
    const differs = !def || !def.framework || def.framework !== pick.framework || (def.model || null) !== pick.model;
    if (differs) { body.framework = pick.framework; body.model = pick.model; }
  }
  if (platformAllowsDoor(platform) && machine) body.machine = machine;
  return { ok: true, body };
}

/** The create answer in words: started, starting elsewhere, unsettled, or refused. */
export function createResultWords(status, data, name) {
  const d = data || {};
  const machineName = verifiedDisplayName(d.machine?.nickname, d.machine?.machineId) || 'the chosen machine';
  if (!(status >= 200 && status < 300)) return { ok: false, text: d.error || d.message || (status ? `Not created: the server answered ${status}.` : 'Not created: the server could not be reached.') };
  const where = d.profile ? ` on ${d.profile.label}${d.profile.model ? ' · ' + modelOptionWords(d.profile.model) : ''}` : '';
  if (d.ownership === 'superseded' || d.ownership === 'not-confirmed') return { ok: true, warn: true, text: d.error || `“${name}” was created, but which machine owns it is not settled yet. Send it a message.` };
  if (d.started === 'unknown') return { ok: true, warn: true, text: d.error || `“${name}” may still be starting on ${machineName}.` };
  if (d.started === 'requested' && d.machine) return { ok: true, text: `Starting “${name}” on ${machineName}.` };
  return { ok: true, text: `Started “${name}”${d.topicId ? ` with a Telegram topic${where}` : ' with no chat'}${d.machine ? ` on ${machineName}` : ''}.` };
}

/** The new-topic default in words, for the "Change the default" line. */
export function defaultWords(options) {
  const def = options && options.newTopicDefault;
  if (!def || !def.framework) return 'New topics start on the agent default.';
  return `New topics start on ${doorModelWords(options, def.framework, def.model)}${def.replication === 'local-only' ? ' (this machine only)' : ''}.`;
}

/** Where the topic's current door came from. */
export function profileSourceWords(profile) {
  const src = profile && profile.resolved && profile.resolved.sources ? profile.resolved.sources.framework : '';
  const by = profile && profile.pin && profile.pin.updatedBy ? profile.pin.updatedBy : '';
  if (src === 'profile-pin' && (by === 'system:dashboard-create' || by === 'system:new-topic-default')) return 'set when it was created';
  if (src === 'profile-pin') return 'pinned by you';
  return 'the default';
}

/** A door switch has landed only when the session list shows the LAUNCHED model. */
export function switchLanded(sessions, job) {
  if (!Array.isArray(sessions) || !job) return null;
  return sessions.find((x) => String(x.platformId) === String(job.topicId) && Date.parse(x.startedAt) >= job.since - 1000 && (job.model === null || x.model === job.model)) || null;
}

/** A Telegram session on this machine can switch its door; others keep the label. */
export function canSwitchDoor(s) {
  return Boolean(s && !s.remote && s.platform === 'telegram' && s.platformId != null);
}

// ── Terminal ─────────────────────────────────────────────────────────────
/** The keys tray. Stop (Ctrl+C) is last, red and asks once: it is the one key that loses work. */
export const KEYS = [
  { label: 'Enter', key: 'Enter' },
  { label: 'y', key: 'y' },
  { label: 'n', key: 'n' },
  { label: 'Esc', key: 'Escape' },
  { label: '↑', key: 'Up', aria: 'Arrow up' },
  { label: '↓', key: 'Down', aria: 'Arrow down' },
  { label: '←', key: 'Left', aria: 'Arrow left' },
  { label: '→', key: 'Right', aria: 'Arrow right' },
];
export const STOP_KEY = { label: 'Stop (Ctrl+C)', key: 'C-c', confirm: 'Interrupt what it is doing?' };

/** A WebSocket frame; another machine's session carries its machineId so the server relays. */
export function frame(type, s, extra = {}) {
  return { type, session: s.tmuxSession, ...extra, ...(s.remote && s.machineId ? { machineId: s.machineId } : {}) };
}

/** The next scroll-back batch, or null when the server's limit is reached. */
export function nextHistoryBatch(loaded) {
  const next = Math.min((loaded || HISTORY_FIRST) + HISTORY_STEP, HISTORY_MAX);
  return next > (loaded || HISTORY_FIRST) ? next : null;
}

/** A stream error frame in words. Never a silent black screen. */
export function streamErrorWords(msg) {
  const code = msg && msg.code;
  const words = {
    'machine-unreachable': 'That machine is not answering.',
    'peer-stream-lost': 'The stream from that machine was lost; reconnecting.',
    'input-not-allowed': 'Typing into sessions from another machine is switched off on that machine.',
    'session-transferred': `This session moved to ${(msg && msg.newMachineId) || 'another machine'}. Go back and open it again to follow it.`,
    'invalid-session': 'That session name is not valid.',
    'session-not-found': 'That session is not running on that machine.',
  }[code];
  return words || null;
}

/** The text composer: grows to 6 lines; an empty message sends nothing. */
export function composerRows(text) {
  const lines = String(text || '').split('\n').length;
  return Math.min(6, Math.max(1, lines));
}
