// Other agents — pure view-model (docs/specs/console-features/people-settings.md,
// "Other agents"; legacy tab id `threadline`). Every decision the page shows is made
// here, from route JSON or a fetch failure, so the unit tests exercise the shipped code.
//
// The delivery words follow the contracts in the agent home's CLAUDE.md ("What
// relayStatus means", "A2A dark peers") and are kept DISTINCT:
//   dark        — nothing back from the peer for N h; my own ledger's proxy, not proof
//   stale       — a message of mine has awaited its acknowledgement past the threshold
//   queued      — the relay holds the last message because the peer is offline
//   unconfirmed — the relay gave no verdict on the last message: unknown, NOT lost
// A value that could not be read says so; it never renders as fine.

import { ago } from './home-model.js';
import { verifiedDisplayName } from './display-identity.js';

export const PEER_FRESH_MS = 15 * 60 * 1000;
export const LEAK_ALARM_MS = 24 * 60 * 60 * 1000;

const fpOk = (fp) => typeof fp === 'string' && /^[0-9a-f]{6,64}$/i.test(fp);
const lower = (fp) => (typeof fp === 'string' ? fp.toLowerCase() : '');
export function shortFp(fp) { return fpOk(fp) ? `${fp.slice(0, 12)}…` : ''; }
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

/** 'ok' when the route answered, 'off' on a 503 (switched off on this agent), 'failed' otherwise. */
export function sourceState(res) {
  if (!res) return 'failed';
  if (res.ok) return 'ok';
  return res.status === 503 || /switched off/.test(String(res.reason || '')) ? 'off' : 'failed';
}
const errText = (res) => (res && res.data && typeof res.data.error === 'string' ? res.data.error : res && res.code ? String(res.code) : '');

/** "for 6 h" from a past instant; null when unusable. */
export function forHow(ts, now = Date.now()) {
  const a = ago(ts, now);
  return a && a !== 'just now' ? `for ${a.replace(' ago', '')}` : a ? 'since just now' : null;
}

/** A UTC instant as the operator's local clock time ("3:40 pm"); the date too when it is not today. */
export function localTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'an unknown time';
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

// ── My own relay (GET /threadline/health) ────────────────────────────────────
const RELAY_WORDS = {
  connected: { word: 'Connected to the agent network', tone: 'ok' },
  standby: { word: 'Standing by: another of my machines holds the network connection', tone: 'ok' },
  disconnected: { word: 'Not connected to the agent network — retrying on my own', tone: 'attn' },
  'never-connected': { word: 'Not connected to the agent network yet — still coming up, or the first connect failed', tone: 'attn' },
  displaced: { word: 'Another connection using my identity took the network (usually my other machine); I try again after a 15-minute pause', tone: 'bad' },
  'not-provisioned': { word: 'No agent-network identity on this machine yet', tone: 'attn' },
  'not-configured': { word: 'The agent network is off on this agent', tone: 'off' },
};
const IDENTITY_WORDS = {
  agree: { word: 'My machines agree on who I am on the network', tone: 'ok' },
  'partial-agree': { word: 'The machines I could observe agree on my identity; some were not observed', tone: 'ok' },
  disagree: { word: 'My machines disagree about my network identity — messages sent to the other address are lost', tone: 'bad' },
  'cannot-tell': { word: 'Not enough observation to compare my machines’ identities', tone: 'unknown' },
};

export function relayModel(res, now = Date.now()) {
  if (!res || !res.ok) {
    return { state: 'cant-tell', word: `Can’t tell whether I’m connected to the agent network: ${res ? res.reason : 'not read'}`, tone: 'unknown', connected: false, since: null, fingerprint: null, shortFp: '', mutualVerifiedCount: null, identity: null, raw: null };
  }
  const d = res.data || {};
  const r = d.relay && typeof d.relay === 'object' ? d.relay : {};
  const state = typeof r.state === 'string' ? r.state : 'cant-tell';
  let w = RELAY_WORDS[state] || (state === 'cant-tell' ? { word: 'Can’t tell whether I’m connected: the health answer carried no relay state', tone: 'unknown' } : { word: `Relay state: ${state}`, tone: 'unknown' });
  if (state === 'disconnected' && r.recoverable === false) w = { word: 'Not connected to the agent network, and not retrying', tone: 'bad' };
  const idc = d.identityCoherence && typeof d.identityCoherence === 'object' ? d.identityCoherence : null;
  const identity = idc && IDENTITY_WORDS[idc.state] ? { state: idc.state, ...IDENTITY_WORDS[idc.state] } : idc && idc.state === 'not-run' ? { state: 'not-run', word: 'Identity check not run yet', tone: 'unknown' } : null;
  return {
    state, word: w.word, tone: w.tone, connected: state === 'connected' || state === 'standby',
    since: r.since ? ago(r.since, now) : null,
    fingerprint: fpOk(d.fingerprint) ? d.fingerprint : null, shortFp: shortFp(d.fingerprint),
    mutualVerifiedCount: typeof d.mutualVerifiedCount === 'number' ? d.mutualVerifiedCount : null,
    identity, raw: d,
  };
}

// ── Pairing (GET /threadline/pairing, GET /threadline/pairing/invites) ───────
const PAIRING_WORDS = {
  'mutual-verified': 'Paired',
  'identity-verified': 'Paired (on another of my machines)',
  // The code: a peer in `invite-accepted` is an INVITER I approved; its operator still has to Finish.
  'invite-accepted': 'Pairing not finished — waiting for the other side to finish',
  'pending-verification': 'Started with the old word check — pair by invite instead',
  'verification-failed': 'Blocked (the old word check did not match)',
};
export function pairingWord(state) { return state ? (PAIRING_WORDS[state] || `Pairing: ${String(state).replace(/-/g, ' ')}`) : null; }
export const isPaired = (state) => state === 'mutual-verified' || state === 'identity-verified';

/** Invites waiting for this operator's Finish: used, with an acceptor, undecided, not leaked. */
export function finishPrompts(invites) { return (Array.isArray(invites) ? invites : []).filter((i) => i && i.state === 'used' && i.acceptor && !i.decision && !i.secondAccept); }
/** Leak alarms from the last 24 h. */
export function leakAlarms(invites, now = Date.now()) { return (Array.isArray(invites) ? invites : []).filter((i) => i && i.secondAccept && now - Date.parse(i.secondAccept.at) < LEAK_ALARM_MS); }
export function openInvites(invites, now = Date.now()) { return (Array.isArray(invites) ? invites : []).filter((i) => i && i.state === 'open' && Date.parse(i.exp) > now); }

/**
 * The pairing picture. state: 'ok' | 'off' (pairing not enabled here) | 'elsewhere' (this machine
 * does not run the relay, another of mine does) | 'cant-tell'. Pairings are kept whenever the
 * list answered, even when the invites could not be read.
 */
export function pairingModel(pairingRes, invitesRes, poolRes, now = Date.now()) {
  const pr = sourceState(pairingRes);
  const inv = sourceState(invitesRes);
  const base = { pairings: [], invites: [], pendingAccepts: [], knownPeers: [], restartNotices: [], finishPrompts: [], alarms: [], openInvites: [], holder: null, invitesReason: null };
  const notEnabled = (res) => /not enabled/i.test(errText(res));
  const elsewhere = (res) => /does not (run|hold) the Threadline relay/i.test(errText(res));
  if (pr === 'off' && notEnabled(pairingRes)) return { ...base, state: 'off', reason: 'Pairing is turned off on this agent.' };
  if (pr === 'off' && elsewhere(pairingRes)) return { ...base, state: 'elsewhere', reason: 'Pairing runs on another of my machines.', holder: relayHolder(poolRes) };
  if (pr !== 'ok') return { ...base, state: 'cant-tell', reason: `Couldn’t read my pairings: ${pr === 'off' ? (errText(pairingRes) || 'switched off on this agent') : (pairingRes ? pairingRes.reason : 'not read')}.` };
  const pairings = Array.isArray(pairingRes.data && pairingRes.data.pairings) ? pairingRes.data.pairings.filter((p) => p && typeof p === 'object') : [];
  let out = { ...base, state: 'ok', reason: null, pairings };
  if (inv === 'ok') {
    const d = invitesRes.data || {};
    out = { ...out, invites: Array.isArray(d.invites) ? d.invites : [], pendingAccepts: Array.isArray(d.pendingAccepts) ? d.pendingAccepts : [], knownPeers: Array.isArray(d.knownPeers) ? d.knownPeers : [], restartNotices: (Array.isArray(d.restartNotices) ? d.restartNotices : []).filter((n) => n && Date.parse(n.exp) > now) };
  } else if (inv === 'off' && elsewhere(invitesRes)) {
    out = { ...out, state: 'elsewhere', reason: 'Invites are made on the machine that holds my network connection.', holder: relayHolder(poolRes) };
  } else {
    out = { ...out, invitesReason: `Couldn’t read my invites: ${invitesRes ? (errText(invitesRes) || invitesRes.reason) : 'not read'}.` };
  }
  out.finishPrompts = finishPrompts(out.invites);
  out.alarms = leakAlarms(out.invites, now);
  out.openInvites = openInvites(out.invites, now);
  return out;
}

/** The machine that holds the serving lease runs the relay: GET /pool → router.holder, named by nickname. */
export function relayHolder(poolRes) {
  const d = poolRes && poolRes.ok && poolRes.data;
  const id = d && d.router && typeof d.router.holder === 'string' ? d.router.holder : null;
  if (!id) return null;
  const m = Array.isArray(d.machines) ? d.machines.find((x) => x && x.machineId === id) : null;
  return { machineId: id, name: verifiedDisplayName(m && m.nickname, id) || 'another machine' };
}

export function machineNames(poolRes) {
  const d = poolRes && poolRes.ok && poolRes.data;
  const names = {};
  if (d && Array.isArray(d.machines)) for (const m of d.machines) if (m && m.machineId) names[m.machineId] = verifiedDisplayName(m.nickname, m.machineId) || 'another machine';
  return { names, selfMachineId: d && typeof d.selfMachineId === 'string' ? d.selfMachineId : null };
}

// ── Peer delivery health (GET /threadline/peers/health) ──────────────────────
/** connectedNow true / false / null (with its reason) in words — "as of" is always said. */
export function connectedWords(p, now = Date.now()) {
  const asOf = p.connectedAsOf ? ago(p.connectedAsOf, now) : null;
  if (p.connectedNow === true) return `the relay saw it connected${asOf ? ` as of ${asOf}` : ''}`;
  if (p.connectedNow === false) return `the relay saw it not connected${asOf ? ` as of ${asOf}` : ''}`;
  const why = p.connectedNowReason;
  if (why === 'relay-down') return 'I can’t see whether it is connected: my own relay connection is down';
  if (why === 'stale') return `I can’t see whether it is connected: my record is too old to trust${asOf ? ` (${asOf})` : ''}`;
  if (why === 'no-row') return 'I can’t see whether it is connected: the relay has no record of it';
  return null;
}

/**
 * One peer's channel in words, from its /threadline/peers/health row.
 * kind: 'dark' | 'stale' | 'queued' | 'unconfirmed' | 'rejected' | 'answered' | 'sent' | 'quiet'.
 */
export function peerWords(p, now = Date.now()) {
  const lastHeardTs = [p.lastAckedAt, p.lastInboundAt].map((t) => Date.parse(t)).filter(Number.isFinite).sort((a, b) => b - a)[0] || null;
  const lastHeard = lastHeardTs ? ago(lastHeardTs, now) : null;
  const conn = connectedWords(p, now);
  const queued = Number(p.queuedCount) || 0;
  const pending = Number(p.pendingCount) || 0;
  const last = p.lastRelayStatus;
  let kind; let word; let sub; let tone;
  if (p.dark === true) {
    kind = 'dark'; tone = 'bad';
    const since = p.darkSince ? forHow(p.darkSince, now) : null;
    word = `Nothing back ${since || 'for a long while'}`;
    sub = `${queued ? `${plural(queued, 'message')} waiting unanswered; ` : ''}it may be offline, or listening at another address — my ledger can’t tell which`;
  } else if (p.stale === true) {
    kind = 'stale'; tone = 'attn';
    word = 'Waiting for an acknowledgement';
    sub = `${plural(pending, 'message')} of mine ${pending === 1 ? 'has' : 'have'} gone unacknowledged${Number.isFinite(p.oldestPendingAgeMs) ? ` for ${ago(now - p.oldestPendingAgeMs, now).replace(' ago', '')}` : ' past the usual wait'}`;
  } else if (last === 'queued') {
    kind = 'queued'; tone = 'attn';
    word = 'Messages waiting at the relay';
    sub = 'it looks offline; the relay holds my message for it until it returns';
  } else if (last === 'unconfirmed') {
    kind = 'unconfirmed'; tone = 'unknown';
    word = 'Last message unconfirmed';
    sub = 'the relay gave no verdict: not known lost, not known delivered';
  } else if (last === 'rejected') {
    kind = 'rejected'; tone = 'attn';
    word = 'The relay refused my last message';
    sub = 'a later resend may work; the message is tracked as failed';
  } else if (lastHeard) {
    kind = 'answered'; tone = 'ok';
    word = `Answered ${lastHeard}`;
    sub = pending ? `${plural(pending, 'message')} still awaiting its acknowledgement` : '';
  } else if (p.lastSentAt) {
    kind = 'sent'; tone = pending ? 'attn' : 'ok';
    word = `Sent ${ago(p.lastSentAt, now)}, nothing back yet`;
    sub = '';
  } else {
    kind = 'quiet'; tone = 'ok'; word = 'No messages exchanged yet'; sub = '';
  }
  const counts = [p.failedCount ? `${plural(p.failedCount, 'failed send')}` : null, p.unconfirmedCount ? `${plural(p.unconfirmedCount, 'unconfirmed')}` : null].filter(Boolean).join(', ');
  return { kind, word, sub: [sub, conn].filter(Boolean).join('; '), tone, lastHeard, counts, queued, pending };
}

// ── Conversations (GET /threadline/conversations?scope=mesh + observability) ─
const SYMMETRY_WORDS = {
  verified: { word: 'In sync with the other side', tone: 'ok', actionable: false },
  diverged: { word: 'Out of sync with the other side (advisory — nothing is blocked)', tone: 'attn', actionable: true },
  'diverged-unreconcilable': { word: 'Out of sync with the other side and cannot be reconciled (advisory — nothing is blocked)', tone: 'attn', actionable: true },
  'version-skew': { word: 'The two sides run different versions, so sync can’t be compared yet', tone: 'unknown', actionable: false },
  'unverified-peer-legacy': { word: 'The other side runs an older version that cannot confirm sync', tone: 'unknown', actionable: false },
  'unverified-backfill': { word: 'Not compared yet: this history was back-filled', tone: 'unknown', actionable: false },
  'local-integrity-fault': { word: 'My own copy of this history is damaged', tone: 'bad', actionable: false },
  unknown: { word: 'Sync with the other side not checked yet', tone: 'unknown', actionable: false },
};
export function symmetryWords(state) { return SYMMETRY_WORDS[state] || { word: `Sync state: ${String(state || 'unknown')}`, tone: 'unknown', actionable: false }; }

/**
 * Conversations grouped by peer. A conversation another machine holds is a summary row
 * ("lives on <machine>"); its messages are never shown from here.
 */
export function conversationRows(convRes, threadsRes, { selfMachineId = null, names = {}, topicNames = {} } = {}, now = Date.now()) {
  const st = sourceState(convRes);
  if (st !== 'ok') return { state: st, reason: st === 'off' ? 'Conversation records are switched off on this agent.' : `Couldn’t read my conversations: ${convRes ? convRes.reason : 'not read'}.`, byPeer: {}, rows: [], partial: false };
  const d = convRes.data || {};
  const list = Array.isArray(d.conversations) ? d.conversations.filter((c) => c && typeof c.conversationId === 'string') : null;
  if (!list) return { state: 'failed', reason: 'The conversation list answered without its rows.', byPeer: {}, rows: [], partial: false };
  const threads = {};
  if (threadsRes && threadsRes.ok && Array.isArray(threadsRes.data && threadsRes.data.threads)) for (const t of threadsRes.data.threads) if (t && t.threadId) threads[t.threadId] = t;
  const ownIds = list.filter((c) => c.kind === 'own').map((c) => c.holderMachineId);
  const self = selfMachineId || ownIds[0] || null;
  const rows = list.map((c) => {
    const t = threads[c.conversationId] || null;
    const heldElsewhere = c.kind === 'replica' || (self ? c.holderMachineId !== self : false);
    const holderName = names[c.holderMachineId] || 'another machine';
    const topic = (c.boundTopicId && verifiedDisplayName(topicNames[String(c.boundTopicId)], c.boundTopicId)) || verifiedDisplayName(t && t.bridge && t.bridge.topicName, c.boundTopicId);
    const last = t && t.lastSeen ? ago(t.lastSeen, now) : null;
    const subParts = [c.status === 'closed' ? 'closed' : 'open', t ? plural(t.messageCount, 'message') : null, topic || 'no Telegram topic'];
    if (heldElsewhere) subParts.push(`lives on ${holderName}${c.stalenessMs > 0 ? ` (record ${ago(now - c.stalenessMs, now).replace(' ago', '')} old)` : ''}`);
    if (c.streamStatus && c.streamStatus !== 'current') subParts.push(`record ${c.streamStatus}`);
    return {
      key: `${c.holderMachineId}:${c.conversationId}`, id: c.conversationId, peerFp: lower(c.peerFingerprint),
      main: topic ? `Conversation in ${topic}` : 'Conversation name unavailable',
      sub: subParts.filter(Boolean).join(' · '), end: last || '',
      tone: c.status === 'closed' ? 'unknown' : null,
      heldElsewhere, holderId: c.holderMachineId, holderName, stalenessMs: Number(c.stalenessMs) || 0, status: c.status, boundTopicId: c.boundTopicId || null, hasTopic: Boolean(c.boundTopicId || (t && t.bridge)),
      lastSeenTs: t && t.lastSeen ? Date.parse(t.lastSeen) : 0, record: c, thread: t,
    };
  }).sort((a, b) => b.lastSeenTs - a.lastSeenTs || a.main.localeCompare(b.main));
  const byPeer = {};
  const peerNames = {};
  for (const r of rows) {
    (byPeer[r.peerFp] ||= []).push(r);
    if (!peerNames[r.peerFp] && r.thread && typeof r.thread.remoteAgentName === 'string' && r.thread.remoteAgentName && lower(r.thread.remoteAgent) === r.peerFp) peerNames[r.peerFp] = r.thread.remoteAgentName;
  }
  return { state: 'ok', reason: null, byPeer, peerNames, rows, partial: Boolean(d.partial), threadsRead: Boolean(threadsRes && threadsRes.ok) };
}

// ── Agents: one row per agent from pairings, peer health, conversations ──────
export function buildAgents({ pairing, peersRes, conversations, threadsRes }, now = Date.now()) {
  const peersState = sourceState(peersRes);
  const byFp = new Map();
  const touch = (fp, name) => {
    const k = lower(fp);
    if (!fpOk(k)) return null;
    if (!byFp.has(k)) byFp.set(k, { fp: k, names: [], pairing: null, health: null, conversations: [] });
    const a = byFp.get(k);
    const title = verifiedDisplayName(name, k);
    if (title && !a.names.includes(title)) a.names.push(title);
    return a;
  };
  for (const p of pairing.pairings) { const a = touch(p.peerFp, p.peerName); if (a) a.pairing = p; }
  if (peersState === 'ok') for (const p of (peersRes.data.peers || [])) { const a = touch(p.peerFp, p.peerName); if (a) a.health = p; }
  if (conversations.state === 'ok') {
    const threads = threadsRes && threadsRes.ok && Array.isArray(threadsRes.data && threadsRes.data.threads) ? threadsRes.data.threads : [];
    for (const [fp, rows] of Object.entries(conversations.byPeer)) {
      const t = threads.find((x) => x && lower(x.remoteAgent) === fp && x.remoteAgentName);
      const a = touch(fp, (conversations.peerNames && conversations.peerNames[fp]) || (t ? t.remoteAgentName : null));
      if (a) a.conversations = rows;
    }
  }
  const agents = [...byFp.values()].map((a) => {
    const name = a.names.map((candidate) => verifiedDisplayName(candidate, a.fp)).find(Boolean) || 'Unnamed agent';
    const pw = a.pairing ? pairingWord(a.pairing.state) : null;
    const health = a.health ? peerWords(a.health, now) : null;
    const historyOnly = !a.pairing && a.conversations.length > 0;
    const stateWord = pw || (historyOnly ? 'History only' : 'Not paired');
    const reach = health ? health.word : peersState === 'ok' ? 'no delivery record yet' : 'can’t tell if it’s reachable';
    const tone = historyOnly ? 'unknown' : health ? health.tone : peersState === 'ok' ? (isPaired(a.pairing && a.pairing.state) ? 'ok' : 'unknown') : 'unknown';
    const waitingOnOther = a.pairing && a.pairing.state === 'invite-accepted';
    return {
      key: `agent:${a.fp}`, fp: a.fp, shortFp: shortFp(a.fp), name, main: name,
      sub: `${stateWord} · ${a.names.length ? reach : 'Name not recorded'}`, end: health && health.lastHeard ? health.lastHeard : '', tone: waitingOnOther && tone === 'ok' ? 'attn' : tone,
      pairingState: a.pairing ? a.pairing.state : null, pairingWord: stateWord, paired: isPaired(a.pairing && a.pairing.state), historyOnly,
      health, healthRow: a.health, pairingRow: a.pairing, conversations: a.conversations, peersState,
    };
  });
  const order = { bad: 0, attn: 1, unknown: 2, ok: 3 };
  agents.sort((x, y) => (order[x.tone] ?? 2) - (order[y.tone] ?? 2) || Number(y.paired) - Number(x.paired) || x.name.localeCompare(y.name));
  return { agents, peersState, peersReason: peersState === 'ok' ? null : peersState === 'off' ? 'Delivery records are switched off on this agent, so I can’t tell whether each agent is reachable.' : `Couldn’t read delivery records: ${peersRes ? peersRes.reason : 'not read'}.` };
}

// ── Waiting on you ───────────────────────────────────────────────────────────
const claimed = (agent, owner) => {
  const name = verifiedDisplayName(agent);
  const ownerName = verifiedDisplayName(owner);
  return `${name ? `the agent that calls itself ${name}` : 'an agent whose name is unavailable'}${ownerName ? `, which says it belongs to ${ownerName}` : ''}`;
};
export function waitingCards(pairing, now = Date.now()) {
  const cards = [];
  for (const n of pairing.restartNotices) cards.push({ kind: 'restart', id: n.id, title: 'An invite was cleared by a restart', body: `An invite from ${claimed(n.claimedAgent, n.claimedOwner)} was waiting for your approval when I restarted, and it was cleared (its secret lived only in memory). Paste it again, or forward it to my Telegram, before it expires at ${localTime(n.exp, now)}.`, actions: ['dismiss'] });
  for (const a of pairing.alarms) {
    const secondName = verifiedDisplayName(a.secondAccept && a.secondAccept.agent);
    cards.push({ kind: 'alarm', iid: a.iid, title: 'Warning: your invite got out', body: `Two agents used the same invite, so I paused the first one: it cannot receive anything secret. The second ${secondName ? `calls itself ${secondName}` : 'has no verified name'}. Make a new invite and send it privately.`, actions: [] });
  }
  for (const p of pairing.pendingAccepts) cards.push({ kind: 'accept', iid: p.iid, name: verifiedDisplayName(p.claimedAgent) || 'An unnamed agent', title: `Pair with ${claimed(p.claimedAgent, p.claimedOwner)}?`, body: `Only approve if you know who sent you this invite. Check code (optional, to read to them): ${p.checkCode || '—'}. It expires at ${localTime(p.exp, now)}.`, actions: ['approve', 'decline'] });
  for (const i of pairing.finishPrompts) cards.push({ kind: 'finish', iid: i.iid, name: verifiedDisplayName(i.acceptor && i.acceptor.agent) || 'An unnamed agent', title: `${verifiedDisplayName(i.acceptor && i.acceptor.agent) || 'An unnamed agent'} accepted your invite.`, body: `${claimed(i.acceptor && i.acceptor.agent, i.acceptor && i.acceptor.owner).replace(/^the/, 'The')} accepted it. Finish only if that is who you sent it to.`, actions: ['finish', 'not-them'] });
  return cards;
}

// ── The page ─────────────────────────────────────────────────────────────────
export function buildAgentsPage({ health, pairingRes, invitesRes, peersRes, convRes, threadsRes, poolRes, topicNames = {} }, now = Date.now()) {
  const relay = relayModel(health, now);
  const pairing = pairingModel(pairingRes, invitesRes, poolRes, now);
  const { names, selfMachineId } = machineNames(poolRes);
  const conversations = conversationRows(convRes, threadsRes, { selfMachineId, names, topicNames }, now);
  const { agents, peersState, peersReason } = buildAgents({ pairing, peersRes, conversations, threadsRes }, now);
  const waiting = waitingCards(pairing, now);
  const paired = agents.filter((a) => a.paired);
  const dark = agents.filter((a) => a.paired && a.name !== 'Unnamed agent' && a.health && a.health.kind === 'dark');
  const waitingSends = agents.filter((a) => a.paired && a.name !== 'Unnamed agent' && a.health && (a.health.kind === 'stale' || a.health.kind === 'queued'));

  // Nothing of the network answers and pairing is off: one headline, how to turn it on, no empty sections.
  const relayOff = relay.state === 'not-configured';
  const relayUnknown = relay.state === 'cant-tell';
  if (pairing.state === 'off' && (relayOff || relayUnknown) && agents.length === 0 && waiting.length === 0) {
    return {
      mode: 'off', certain: relayOff, relay, pairing, agents, waiting, conversations, facts: [], topicNames,
      headline: relayOff ? 'The agent network is off on this agent.' : 'The agent network looks off on this agent.',
      sub: `${relayOff ? '' : `${relay.word}. `}Pairing is turned off too. To turn it on, ask me to “connect to the agent network”, or tap Turn on pairing below; that restarts my server, and this page reconnects by itself.`,
      tone: 'muted', notes: [],
    };
  }

  let headline; let tone = 'ok';
  if (waiting.length) {
    const first = waiting[0];
    headline = waiting.length === 1
      ? (first.kind === 'finish' ? `${first.name} is waiting for you to finish pairing.` : first.kind === 'accept' ? `${first.name} wants to pair with you.` : first.kind === 'alarm' ? 'An invite of yours got out.' : 'An invite was cleared by a restart.')
      : `${waiting.length} things are waiting on you.`;
    tone = 'attn';
  } else if (pairing.state === 'off' && paired.length === 0) {
    headline = 'The agent network is off on this machine.';
    tone = 'muted';
  } else if (!relay.connected && relay.state !== 'cant-tell' && !relayOff) {
    headline = relay.state === 'displaced' ? 'I’m not connected to the agent network — another connection took my place.' : relay.state === 'not-provisioned' ? 'I have no agent-network identity on this machine yet.' : 'I’m not connected to the agent network — checking again.';
    tone = relay.tone === 'bad' ? 'bad' : 'attn';
  } else if (dark.length) {
    headline = dark.length === 1 ? `${dark[0].name} hasn’t answered ${dark[0].health.word.replace(/^Nothing back /, '')}.` : `${dark.length} agents haven’t answered in a while.`;
    tone = 'bad';
  } else if (waitingSends.length) {
    headline = waitingSends.length === 1 ? `Messages to ${waitingSends[0].name} are waiting.` : `Messages to ${waitingSends.length} agents are waiting.`;
    tone = 'attn';
  } else if (agents.length) {
    const reachable = agents.filter((a) => a.health && a.health.tone === 'ok').length;
    if (peersState !== 'ok') { headline = `${plural(agents.length, 'agent')}; can’t tell whether ${agents.length === 1 ? 'it is' : 'they are'} reachable.`; tone = 'muted'; }
    else if (reachable === agents.length) headline = agents.length === 1 ? `${agents[0].name} is reachable.` : agents.length === 2 ? '2 agents, both reachable.' : `${agents.length} agents, all reachable.`;
    else headline = `${plural(agents.length, 'agent')}, ${reachable} answered recently.`;
  } else if (pairing.state === 'cant-tell' || peersState === 'failed') {
    headline = 'Can’t tell which agents I work with.'; tone = 'muted';
  } else {
    headline = 'No other agents yet.';
  }
  const subParts = [];
  if (waiting.length && !relay.connected && relay.state !== 'cant-tell' && !relayOff) subParts.push(`${relay.word}.`);
  if (pairing.state === 'elsewhere') subParts.push(pairing.holder ? `Pairing runs on ${pairing.holder.name}; open the console there to make or approve invites.` : 'Pairing runs on another of my machines.');
  if (pairing.state === 'off' && agents.length) subParts.push(paired.length ? 'Existing agents are listed below.' : agents.some(a => a.historyOnly) ? 'Past conversations are saved below.' : 'No agents are paired here.');
  if (pairing.state === 'cant-tell') subParts.push(pairing.reason);
  if (!agents.length && pairing.state === 'ok' && !waiting.length) subParts.push('Connect another agent to start.');
  if (relay.identity && relay.identity.tone === 'bad') subParts.push(relay.identity.word + '.');
  const facts = [
    { n: paired.length, label: 'paired' },
    { n: waiting.length, label: 'waiting on you', tone: waiting.length ? 'attn' : null },
    { n: dark.length, label: 'not answering', tone: dark.length ? 'bad' : null },
    relay.connected ? null : { n: relay.state === 'cant-tell' ? 'can’t tell' : relayOff ? 'off' : 'down', label: 'my connection', tone: relay.state === 'cant-tell' ? 'unknown' : relayOff ? null : 'attn' },
  ].filter(Boolean);
  const notes = [];
  if (peersReason) notes.push(peersReason);
  if (conversations.state !== 'ok') notes.push(conversations.reason);
  else if (conversations.partial) notes.push('Some older conversation records may be missing: the cross-machine read hit its bound.');
  if (pairing.invitesReason) notes.push(pairing.invitesReason);
  if (peersState === 'ok' && peersRes.data && peersRes.data.pool && Array.isArray(peersRes.data.pool.failed) && peersRes.data.pool.failed.length) notes.push(`No delivery records from ${peersRes.data.pool.failed.map((f) => names[f.machineId] || 'another machine').join(', ')}.`);
  return { mode: 'ok', certain: true, headline, sub: subParts.join(' '), tone,
    facts: pairing.state === 'off' && paired.length === 0 && waiting.length === 0 ? [] : facts,
    relay, pairing, agents, waiting, conversations, notes, topicNames };
}

// ── One conversation's history (GET /threadline/threads/:id + /health) ──────
/** Entries carry UNTRUSTED peer-authored bodies: the page writes `body` with textContent only. */
export function threadModel(threadRes, healthRes) {
  const st = sourceState(threadRes);
  if (st !== 'ok') return { ok: false, reason: st === 'off' ? 'The message history is switched off on this agent.' : `Couldn’t read this conversation: ${threadRes ? threadRes.reason : 'not read'}.`, entries: [], symmetry: null };
  const d = threadRes.data || {};
  const list = Array.isArray(d.entries) ? d.entries : null;
  if (!list) return { ok: false, reason: 'The conversation answered without its messages.', entries: [], symmetry: null };
  const entries = list.map((e) => ({
    seq: e.seq, direction: e.direction === 'inbound' || e.direction === 'in' ? 'in' : 'out',
    body: typeof e.body === 'string' ? e.body : null, at: e.at || e.createdAt || null, backfilled: Boolean(e.backfilled), messageId: e.messageId,
  }));
  let symmetry = null;
  if (healthRes && healthRes.ok && healthRes.data) {
    const h = healthRes.data;
    symmetry = { state: h.symmetryState || 'unknown', ...symmetryWords(h.symmetryState), chainOk: h.chainOk !== false, recovery: typeof h.recovery === 'string' ? h.recovery : null };
  } else if (healthRes) symmetry = { state: 'cant-tell', word: `Can’t tell whether the two sides are in sync: ${healthRes.reason}`, tone: 'unknown', actionable: false, chainOk: null, recovery: null };
  return { ok: true, entries, hasMore: Boolean(d.hasMore), symmetry, untrusted: d.bodiesAreUntrustedData !== false };
}

// ── Action words: never more than the server said ───────────────────────────
export function inviteSentence(exp, now = Date.now()) {
  return `Send this privately to their person, in any app you already use. It works once and expires at ${localTime(exp, now)}.`;
}
export function inviteResultWords(status, data, now = Date.now()) {
  if (status === 200 && data && typeof data.message === 'string') return { ok: true, message: data.message, exp: data.exp || null, sentence: inviteSentence(data.exp, now), iid: data.iid || null };
  if (status === 503) return { ok: false, text: /relay/i.test(String(data && data.error)) ? 'Invites are made on the machine that holds my network connection; open the console there.' : 'Pairing is turned off on this agent, so no invite can be made.' };
  return { ok: false, text: `Could not make an invite: ${(data && data.error) || `the server answered ${status}`}.` };
}
export function pinResultWords(status, data, okText) {
  if (status === 200) return { ok: true, text: okText };
  if (status === 403) return { ok: false, text: 'That PIN was not accepted. Nothing has changed.' };
  if (status === 429) return { ok: false, text: 'Too many PIN attempts; wait a little and try again. Nothing has changed.' };
  if (status === 503) return { ok: false, text: /PIN/i.test(String(data && data.error)) ? 'No dashboard PIN is configured on this agent, so this cannot be approved from here.' : `${(data && data.error) || 'That part is switched off on this agent'}. Nothing has changed.` };
  return { ok: false, text: `${(data && data.error) || `The server answered ${status}`}. Nothing has changed.` };
}
export function bearerResultWords(status, data, okText) {
  if (status === 200) return { ok: true, text: okText };
  return { ok: false, text: `${(data && data.error) || `The server answered ${status}`}. Nothing has changed.` };
}
export function enableWords(status, data) {
  const say = data && typeof data.sayToPerson === 'string' ? data.sayToPerson : '';
  if (status === 200) return { ok: true, done: true, text: say || 'Pairing is on.' };
  if (status === 202) return { ok: true, done: false, text: say || 'Switching the agent network on. My server restarts for it; this page reconnects by itself.' };
  if (status === 409) return { ok: false, text: say || (data && data.state === 'unavailable-here' ? 'Another of my machines holds the network connection; turn it on from there.' : (data && data.reason) || 'Could not switch pairing on here.') };
  return { ok: false, text: say || (data && (data.error || data.reason)) || `The server answered ${status}.` };
}
export function bindRequest(action, threadId, target) {
  const body = { action, threadId };
  if (action === 'tie') {
    const n = Number(target);
    if (Number.isInteger(n) && n > 0 && /^\d+$/.test(String(target).trim())) body.targetTopicId = n; else body.targetTopicName = String(target || '').trim();
  }
  return body;
}
export function bindResultWords(status, data) {
  if (status === 200) return { ok: true, text: `Done: this conversation now lives in ${verifiedDisplayName(data && data.topicName, data && data.topicId) ? `“${verifiedDisplayName(data.topicName, data.topicId)}”` : 'its topic'}; its future replies go there.` };
  if (status === 503) return { ok: false, text: 'The Telegram hub is not available on this agent, so conversations can’t be tied to a topic from here.' };
  return { ok: false, text: `${(data && data.error) || `The server answered ${status}`}. Nothing has changed.` };
}
