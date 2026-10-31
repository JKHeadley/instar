// Permission slips — pure view-model
// (docs/specs/console-features/people-settings.md, "Permission slips", legacy tab id `mandates`).
//
// Every decision lives here so it can be tested: how a slip is grouped (active / ended),
// the plain-words bounds sentence, the audit rows and their count label, the approval
// cards, and the exact request bodies the PIN-gated routes take
// (POST /mandate/issue, POST /mandate/:id/revoke, POST /mandate/:id/grants,
// POST /authorization-requests/:id/approve|deny — all adapter (c): the PIN rides in
// that one body and is cleared the moment the request settles).

import { ago } from './home-model.js';
import { verifiedDisplayName } from './display-identity.js';

// ── Words ─────────────────────────────────────────────────────────────────
// Mirrors dashboard/mandates.js ACTION_PHRASES: the coordination authorities and the
// RolePolicy floor actions, in plain words. Unknown slugs are de-slugified, never dumped raw.
export const ACTION_PHRASES = {
  'exchange-read-credential': 'hand over a read-only credential',
  'sign-code-review': 'sign a code review',
  'execute-cutover': 'run the cutover',
  'account-follow-me': 'sign an account in on another machine',
  'money-movement': 'move money',
  'prod-deploy': 'deploy to production',
  'credential-access': 'use a credential',
  'destructive-data': 'run a destructive data operation',
  'external-send': 'send something outside',
  'grant-authority': 'grant authority to others',
};
export function humanAction(slug) {
  const s = String(slug || '').trim();
  if (!s) return 'act';
  return ACTION_PHRASES[s] || s.replace(/[-_]+/g, ' ');
}

// Mirrors FLOOR_ACTIONS in src/permissions/RolePolicy.ts (the legacy grant form's list).
export const FLOOR_ACTIONS = ['money-movement', 'prod-deploy', 'credential-access', 'destructive-data', 'external-send', 'grant-authority'];

// The operator picks a window, never types a timestamp (legacy GRANT_DURATIONS).
export const GRANT_DURATIONS = [
  { label: '15 minutes', minutes: 15 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '24 hours', minutes: 1440 },
];

// The first-mandate shape, prefilled so the operator edits rather than authors (legacy template).
/* operator-surface-power-user: the pre-existing advanced hand-written slip form is never the default grant path; ordinary grants start from a server-authored request. */
export const AUTHORITIES_TEMPLATE = JSON.stringify([
  { action: 'exchange-read-credential', bounds: { credentialScope: 'read-only', onMachine: true } },
  { action: 'sign-code-review', bounds: { artifact: 'migration-port', mutual: true } },
], null, 2);

export function joinHuman(parts) {
  const p = parts.filter(Boolean);
  if (p.length === 0) return '';
  if (p.length === 1) return p[0];
  return `${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}`;
}

export function humanScope(scope) {
  const s = String(scope || '').trim();
  if (!s) return 'Permission slip';
  const words = s.replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function shortFp(fp) {
  const s = String(fp || '');
  return s.length > 12 ? `${s.slice(0, 8)}…` : s;
}

/** A moment in plain words: "today 3:00 pm", "tomorrow 9:15 am", "Friday 3:00 pm", "Nov 1, 3:00 pm". */
export function whenWords(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'an unknown time';
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (ms) => { const x = new Date(ms); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const days = Math.round((startOfDay(t) - startOfDay(now)) / 86400000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString([], { weekday: 'long' })} ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}${Math.abs(days) > 300 ? ` ${d.getFullYear()}` : ''}, ${time}`;
}

/** An agent's verified name from the fingerprint → name map. */
export function agentName(fp, names = {}) {
  const key = String(fp || '').toLowerCase();
  const name = verifiedDisplayName(names[key], key);
  if (name) return name;
  return fp ? 'an unnamed agent' : 'an agent';
}

/** A person's name from the registered-user list, else an honest unavailable label. */
export function personName(id, users = []) {
  const u = (users || []).find((x) => x && x.slackUserId === id);
  return verifiedDisplayName(u && u.name, id) || 'an unnamed person';
}

/** The fingerprint → name map the page builds from /health (self), /threadline/health (own fp) and knownPeers. */
export function nameMap({ selfFp, selfName, peers = [] } = {}) {
  const map = {};
  for (const p of peers) if (p && typeof p.fp === 'string' && p.name) map[p.fp.toLowerCase()] = String(p.name);
  if (selfFp && selfName) map[String(selfFp).toLowerCase()] = String(selfName);
  return map;
}

// ── Slips ─────────────────────────────────────────────────────────────────
export function mandateState(m, now = Date.now()) {
  if (m && m.revoked) return 'revoked';
  const t = Date.parse(m && m.expiresAt);
  if (!Number.isFinite(t) || t <= now) return 'expired';
  return 'active';
}

/** "Echo and Dawn may sign code reviews and hand over read-only credentials until Friday 3:00 pm." */
export function slipSummary(m, names = {}, now = Date.now()) {
  const agents = Array.isArray(m.agents) ? m.agents.filter(Boolean) : [];
  const acts = (Array.isArray(m.authorities) ? m.authorities : []).map((a) => humanAction(a && a.action));
  const grants = Array.isArray(m.grants) ? m.grants : [];
  const until = whenWords(m.expiresAt, now);
  const state = mandateState(m, now);
  const verb = state === 'active' ? 'may' : 'could';
  const ending = state === 'active' ? `until ${until}` : state === 'revoked' ? `until it was revoked` : `until it expired ${until}`;
  const same = agents.length === 2 && agents[0].toLowerCase() === agents[1].toLowerCase();
  const who = agents.length === 0 ? 'No agent' : same || agents.length === 1 ? agentName(agents[0], names) : `${agentName(agents[0], names)} and ${agentName(agents[1], names)}`;
  if (acts.length === 0 && grants.length > 0) {
    return `A carrier for ${grants.length === 1 ? 'one person’s grant' : `${grants.length} people’s grants`}, ${ending}.`;
  }
  if (acts.length === 0) return `${who} ${verb} do nothing under this slip yet, ${ending}.`;
  return `${who} ${verb} ${joinHuman(acts)} ${ending}.`;
}

/** Each grant as a sentence; expired ones say so. */
export function grantRows(m, users = [], now = Date.now()) {
  const grants = Array.isArray(m.grants) ? m.grants : [];
  return grants.map((g, i) => {
    const t = Date.parse(g.expiresAt);
    const live = Number.isFinite(t) && t > now && mandateState(m, now) === 'active';
    const who = personName(g.grantedTo, users);
    return {
      key: `g${i}:${g.grantedTo}:${g.floorAction}`,
      text: live ? `${who} may ${humanAction(g.floorAction)} until ${whenWords(g.expiresAt, now)}.` : `${who} could ${humanAction(g.floorAction)} until ${whenWords(g.expiresAt, now)} (over).`,
      live, person: who, id: g.grantedTo,
    };
  });
}

/** One slip → one card. */
export function slipCard(m, { names = {}, users = [], now = Date.now() } = {}) {
  const state = mandateState(m, now);
  const grants = grantRows(m, users, now);
  const people = grants.filter((g) => g.live).map((g) => g.person);
  const invalid = m.authorshipValid === false;
  const stateWords = state === 'revoked' ? `Revoked ${ago(m.revoked.at, now) || 'earlier'}${m.revoked.reason ? ` — ${m.revoked.reason}` : ''}`
    : state === 'expired' ? `Expired ${ago(m.expiresAt, now) || 'earlier'}` : `Until ${whenWords(m.expiresAt, now)}`;
  return {
    key: `slip:${m.id}`, id: m.id, state, invalid,
    title: humanScope(m.scope),
    summary: slipSummary(m, names, now),
    stateWords,
    peopleLine: people.length ? `Also lets ${joinHuman(people)} act.` : '',
    invalidLine: invalid ? 'This slip’s signature doesn’t check out. Treat it as unusable and tell the agent.' : '',
    grants,
    tone: invalid ? 'bad' : state === 'active' ? null : 'unknown',
    record: m,
  };
}

/** GET /mandate → active and ended groups, or an honest reason. */
export function buildSlips(res, opts = {}) {
  const now = opts.now || Date.now();
  if (!res || !res.ok) {
    const off = /switched off/.test(res && res.reason || '');
    return { ok: false, off, reason: off ? 'Permission slips are switched off on this agent (the mandate engine is not running).' : `Can’t read the permission slips: ${(res && res.reason) || 'no answer'}.` };
  }
  const list = res.data && Array.isArray(res.data.mandates) ? res.data.mandates : null;
  if (!list) return { ok: false, off: false, reason: 'The permission-slip list answered without its list.' };
  const cards = list.filter((m) => m && typeof m.id === 'string').map((m) => slipCard(m, { ...opts, now }));
  const bySoonest = (a, b) => (Date.parse(a.record.expiresAt) || 0) - (Date.parse(b.record.expiresAt) || 0);
  const byLatest = (a, b) => (Date.parse(b.record.revoked ? b.record.revoked.at : b.record.expiresAt) || 0) - (Date.parse(a.record.revoked ? a.record.revoked.at : a.record.expiresAt) || 0);
  const active = cards.filter((c) => c.state === 'active').sort(bySoonest);
  const ended = cards.filter((c) => c.state !== 'active').sort(byLatest);
  const people = new Set();
  for (const c of active) for (const g of c.grants) if (g.live) people.add(g.id);
  return {
    ok: true, active, ended, looked: true,
    counts: { active: active.length, ended: ended.length, people: people.size, invalid: cards.filter((c) => c.invalid).length },
  };
}

// ── Audit ─────────────────────────────────────────────────────────────────
/** One decision in plain words: who asked, what, allow/deny and the reason. */
export function auditRow(e, { names = {}, users = [], now = Date.now() } = {}) {
  const allowed = e.decision === 'allow';
  const action = String(e.action || '');
  let what;
  if (action.startsWith('grant-floor:')) {
    const who = personName(e.agentFp, users);
    what = allowed ? `${who} was granted “${humanAction(action.slice('grant-floor:'.length))}”` : `a grant for ${who} to ${humanAction(action.slice('grant-floor:'.length))} was refused`;
  } else {
    const who = agentName(e.agentFp, names);
    what = allowed ? `${who} may ${humanAction(action)}` : `${who} tried to ${humanAction(action)}`;
  }
  return {
    key: `a:${e.hash || e.ts}`,
    main: `${allowed ? 'Allowed' : 'Refused'} · ${what}`,
    sub: e.reason ? String(e.reason) : '',
    end: ago(e.ts, now) || '',
    tone: allowed ? null : 'attn',
    allowed,
    record: e,
  };
}

/**
 * GET /mandate/audit?limit=200 → rows newest first + the chain verdict + a count whose
 * label says what it was counted over (the route returns only the newest `limit`
 * entries, so "today" is claimed only when the window is demonstrably covered).
 */
export function buildAudit(res, opts = {}) {
  const now = opts.now || Date.now();
  const limit = opts.limit || 200;
  if (!res || !res.ok) {
    const off = /switched off/.test(res && res.reason || '');
    return { ok: false, off, reason: off ? 'The decision history is switched off on this agent.' : `Can’t read the decision history: ${(res && res.reason) || 'no answer'}.`, chain: { state: 'unknown', words: 'Can’t tell whether the record is intact.' } };
  }
  const d = res.data || {};
  const entries = Array.isArray(d.entries) ? d.entries.filter(Boolean) : null;
  if (!entries) return { ok: false, off: false, reason: 'The decision history answered without its entries.', chain: { state: 'unknown', words: 'Can’t tell whether the record is intact.' } };
  const chainOk = d.chain && typeof d.chain.ok === 'boolean' ? d.chain.ok : null;
  const chain = chainOk === false
    ? { state: 'broken', words: `The decision record is broken — possible tampering${d.chain && d.chain.brokenAt !== undefined ? ` at entry ${d.chain.brokenAt}` : ''}. Treat as an incident.` }
    : chainOk === true ? { state: 'intact', words: 'Record intact.' } : { state: 'unknown', words: 'Can’t tell whether the record is intact: the answer had no chain verdict.' };
  const rows = entries.slice().sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0)).map((e) => auditRow(e, { ...opts, now }));
  const allowed = rows.filter((r) => r.allowed).length;
  const refused = rows.length - allowed;
  const total = typeof d.total === 'number' ? d.total : null;
  const oldest = entries.reduce((min, e) => { const t = Date.parse(e.ts); return Number.isFinite(t) && t < min ? t : min; }, Infinity);
  const covered = entries.length > 0 && ((total !== null && total === entries.length) || oldest <= now - 86400000);
  let countLabel;
  if (rows.length === 0) countLabel = 'No decisions recorded yet.';
  else if (covered) {
    const dayRows = rows.filter((r) => (Date.parse(r.record.ts) || 0) > now - 86400000);
    const dayAllowed = dayRows.filter((r) => r.allowed).length;
    countLabel = `${dayAllowed} allowed, ${dayRows.length - dayAllowed} refused in the last 24 h.`;
  } else countLabel = `Among the latest ${rows.length} decisions: ${allowed} allowed, ${refused} refused.`;
  return { ok: true, chain, rows, counts: { allowed, refused, total }, countLabel, limit };
}

// ── Approvals waiting ─────────────────────────────────────────────────────
/** GET /authorization-requests?status=pending → cards, hidden when the feature is off. */
export function buildApprovals(res) {
  if (!res || !res.ok) {
    const off = /switched off/.test(res && res.reason || '');
    return off ? { ok: false, off: true, hidden: true, rows: [] } : { ok: false, off: false, hidden: false, reason: `Can’t tell if anything is waiting for your approval: ${(res && res.reason) || 'no answer'}.`, rows: [] };
  }
  const list = res.data && Array.isArray(res.data.requests) ? res.data.requests : null;
  if (!list) return { ok: false, off: false, hidden: false, reason: 'The approval list answered without its requests.', rows: [] };
  return {
    ok: true, off: false, hidden: false,
    rows: list.filter((r) => r && r.status === 'pending' && typeof r.id === 'string').map((r) => ({
      key: `req:${r.id}`, id: r.id,
      headline: typeof r.headline === 'string' && r.headline ? r.headline : 'An approval is requested.',
      reason: typeof r.reason === 'string' ? r.reason : '',
      agent: typeof r.createdByAgent === 'string' ? r.createdByAgent : 'The agent',
      here: r.heldOnThisMachine !== false,
      machine: typeof r.createdOnMachine === 'string' ? r.createdOnMachine : '',
      expires: r.requestExpiresAt || null,
      record: r,
    })),
  };
}

// ── Headline + facts ──────────────────────────────────────────────────────
export function mandatesHeadline({ slips, approvals, audit }) {
  if (audit && audit.ok && audit.chain.state === 'broken') return { text: 'The decision record is broken — treat this as an incident.', tone: 'bad' };
  if (approvals && approvals.ok && approvals.rows.length) {
    const n = approvals.rows.length;
    const who = approvals.rows[0].agent;
    return { text: `${n === 1 ? who : `${n} requests`} ${n === 1 ? 'is asking you to approve 1 thing.' : 'are waiting for your approval.'}`, tone: 'attn' };
  }
  if (!slips || !slips.ok) return { text: slips && slips.off ? 'Permission slips are switched off on this agent.' : 'Can’t tell what you have allowed.', tone: 'muted' };
  if (slips.counts.invalid) return { text: `${slips.counts.invalid === 1 ? 'One slip’s' : `${slips.counts.invalid} slips’`} signature doesn’t check out.`, tone: 'bad' };
  const waitUnknown = approvals && !approvals.ok && !approvals.hidden;
  if (slips.counts.active === 0) return { text: 'No slips — every agent-to-agent action is refused until you sign one.', tone: 'ok' };
  return { text: `${slips.counts.active === 1 ? '1 slip' : `${slips.counts.active} slips`} active; ${waitUnknown ? 'can’t tell if anything is waiting.' : 'nothing waiting.'}`, tone: waitUnknown ? 'muted' : 'ok' };
}

export function mandatesFacts({ slips, approvals, audit }) {
  const facts = [];
  if (approvals && !approvals.hidden) facts.push(approvals.ok ? { n: approvals.rows.length, label: 'waiting on you', tone: approvals.rows.length ? 'attn' : null } : { n: '?', label: 'waiting on you' });
  facts.push(slips && slips.ok ? { n: slips.counts.active, label: slips.counts.active === 1 ? 'active slip' : 'active slips' } : { n: '?', label: 'active slips' });
  if (slips && slips.ok) facts.push({ n: slips.counts.people, label: slips.counts.people === 1 ? 'person with a grant' : 'people with grants' });
  if (audit && audit.ok) facts.push({ n: audit.chain.state === 'broken' ? 'broken' : audit.chain.state === 'intact' ? 'intact' : '?', label: 'decision record', tone: audit.chain.state === 'broken' ? 'bad' : null });
  else facts.push({ n: '?', label: 'decision record' });
  return facts.slice(0, 4);
}

// ── Request bodies (adapter c: the PIN rides in this one body) ────────────
export function parseAuthorities(text) {
  try {
    const v = JSON.parse(String(text || '').trim() || '[]');
    if (!Array.isArray(v) || v.length === 0) return { ok: false, problem: 'Authorities is empty — the slip must delegate at least one action.' };
    if (v.some((a) => !a || typeof a.action !== 'string' || !a.action || typeof a.bounds !== 'object' || a.bounds === null)) return { ok: false, problem: 'Each authority needs an action and bounds.' };
    return { ok: true, authorities: v };
  } catch { return { ok: false, problem: 'Authorities is not valid JSON — it must be an array of { action, bounds }.' }; }
}

/** The one-dashboard account-follow-me path: issue + deliver through /mandate/issue-for-machine. */
export function followMeTarget(authorities) {
  if (!Array.isArray(authorities)) return null;
  const a = authorities.find((x) => x && x.action === 'account-follow-me' && x.bounds && typeof x.bounds.accountId === 'string' && typeof x.bounds.targetMachineId === 'string');
  return a ? { accountId: a.bounds.accountId, targetMachineId: a.bounds.targetMachineId } : null;
}

/** POST /mandate/issue body (routes.ts: scope, agents[2], authorities[], future expiresAt, pin). */
export function issueRequest(form, pin, now = Date.now()) {
  const problems = [];
  const scope = String(form.scope || '').trim();
  const a = String(form.agentA || '').trim();
  const b = String(form.agentB || '').trim();
  if (!scope) problems.push('Give the slip a short name.');
  if (!a) problems.push('This agent’s fingerprint is missing.');
  if (!b) problems.push('Pick or paste the other agent’s fingerprint.');
  const auth = parseAuthorities(form.authorities);
  if (!auth.ok) problems.push(auth.problem);
  const exp = Date.parse(form.expiresAt || '');
  if (!Number.isFinite(exp)) problems.push('Pick when it expires — every slip expires.');
  else if (exp <= now) problems.push('The expiry is in the past.');
  if (!pin) problems.push('Your PIN is needed.');
  if (problems.length) return { ok: false, problems };
  const expiresAt = new Date(exp).toISOString();
  const fm = followMeTarget(auth.authorities);
  if (fm) return { ok: true, path: '/mandate/issue-for-machine', body: { pin, scope, agents: [a, b], expiresAt, accountId: fm.accountId, targetMachineId: fm.targetMachineId } };
  return { ok: true, path: '/mandate/issue', body: { pin, scope, agents: [a, b], authorities: auth.authorities, expiresAt } };
}

/** POST /mandate/:id/revoke body (reason optional; the server defaults it). */
export function revokeRequest(pin, reason) {
  const r = String(reason || '').trim();
  return r ? { pin, reason: r } : { pin };
}

/**
 * POST /mandate/:id/grants body. The window is clamped to the slip's own expiry
 * client-side (the server refuses a longer one; a shorter window beats a refusal).
 */
export function grantRequest(m, form, pin, now = Date.now()) {
  const grantedTo = String(form.grantedTo || '').trim();
  const floorAction = FLOOR_ACTIONS.includes(form.floorAction) ? form.floorAction : '';
  const minutes = Number(form.minutes);
  const problems = [];
  if (!grantedTo) problems.push('Pick who the grant is for.');
  if (!floorAction) problems.push('Pick what they may do.');
  if (!Number.isFinite(minutes) || minutes <= 0) problems.push('Pick for how long.');
  if (!pin) problems.push('Your PIN is needed.');
  if (problems.length) return { ok: false, problems };
  let end = now + minutes * 60000;
  const slipEnd = Date.parse(m && m.expiresAt);
  let clamped = false;
  if (Number.isFinite(slipEnd) && end > slipEnd) { end = slipEnd; clamped = true; }
  return { ok: true, clamped, expiresAt: new Date(end).toISOString(), body: { pin, grants: [{ floorAction, grantedTo, authorizedBy: 'operator (dashboard PIN)', expiresAt: new Date(end).toISOString() }] } };
}

export function approveRequest(pin) { return { pin }; }
/** POST /authorization-requests/:id/deny: denyReason is required by the server. */
export function denyRequest(pin, reason) {
  const r = String(reason || '').trim();
  if (!r) return { ok: false, problems: ['A short reason is needed to decline.'] };
  return { ok: true, body: { pin, denyReason: r } };
}

/** The server's answer in words, per status. `kind` names the action for the success line. */
export function resultWords(kind, status, data) {
  const err = data && typeof data.error === 'string' ? data.error : '';
  if (status === 403) return { ok: false, text: /Incorrect PIN/i.test(err) ? `That PIN was not accepted${typeof (data && data.attemptsRemaining) === 'number' ? ` · ${data.attemptsRemaining} tries left` : ''}. Nothing has changed.` : 'That PIN was not accepted. Nothing has changed.' };
  if (status === 429) return { ok: false, text: 'Too many PIN attempts. Wait a few minutes, then try again. Nothing has changed.' };
  if (status === 503) return { ok: false, text: /dashboardPin/i.test(err) ? 'No dashboard PIN is configured on this agent, so this cannot be done from here.' : `This is switched off on this agent${err ? `: ${err}` : ''}.` };
  if (status === 404) return { ok: false, text: 'That slip no longer exists here. Nothing has changed.' };
  if (status === 0) return { ok: false, text: 'The server could not be reached. Nothing was sent.' };
  if (status === 502 && kind === 'issue') return { ok: false, issued: true, text: `The slip was issued here, but delivering it to the other machine failed${data && (data.reason || data.error) ? `: ${data.reason || data.error}` : ''}. It is listed; retry the delivery later.` };
  if (status >= 400) return { ok: false, text: `Not done: ${err || `the server answered ${status}`}. Nothing has changed.` };
  if (kind === 'issue') return { ok: true, text: `Issued${data && data.delivered ? ' and delivered to the other machine' : ''}. The slip is active.` };
  if (kind === 'revoke') return { ok: true, text: 'Revoked. Everything this slip allowed is refused from now on.' };
  if (kind === 'grant') return { ok: true, text: 'Granted. The slip now carries it.' };
  if (kind === 'approve') return { ok: true, text: data && data.alreadyApproved ? 'This was already approved.' : 'Approved. The grant is active.' };
  if (kind === 'deny') return { ok: true, text: 'Declined.' };
  return { ok: true, text: 'Done.' };
}

/** datetime-local wants local "YYYY-MM-DDTHH:MM"; one week out by default (the legacy default). */
export function defaultExpiryLocal(now = Date.now()) {
  const d = new Date(now + 7 * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
