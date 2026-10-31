/**
 * Console "Other agents" page (docs/specs/console-features/people-settings.md, Threadline →
 * Other agents): every decision in the model on both sides — my own relay state first, the
 * four distinct delivery words (dark / stale / queued / unconfirmed), pairing states, a
 * conversation another machine holds, peer-authored bodies kept as text, and the one
 * honest page when the agent network is off — plus the shipped console in jsdom rendering
 * a peer-authored body with HTML in it as text, never markup.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  sourceState, relayModel, pairingModel, relayHolder, peerWords, connectedWords, conversationRows, buildAgents, waitingCards, buildAgentsPage,
  threadModel, symmetryWords, inviteResultWords, inviteSentence, pinResultWords, bearerResultWords, enableWords, bindRequest, bindResultWords, localTime, pairingWord, shortFp,
} from '../../dashboard/console/agents-model.js';
import { NATIVE_PAGES, tabHref, GROUPS } from '../../dashboard/console/nav-model.js';

const NOW = Date.parse('2026-10-25T20:00:00Z');
const ok = (data: unknown) => ({ ok: true, status: 200, data });
const off = (error = 'switched off') => ({ ok: false, status: 503, reason: 'switched off on this agent', data: { error }, code: error });
const fail = (reason = 'the server answered 500', status = 500) => ({ ok: false, status, reason, data: null, code: null });
const minsAgo = (m: number) => new Date(NOW - m * 60000).toISOString();
const FP = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const FP2 = 'ffeeddccbbaa99887766554433221100';
const FP3 = '0123456789abcdef0123456789abcdef';

const health = (relay: Record<string, unknown>, extra: Record<string, unknown> = {}) => ok({ status: 'ok', relay, protocol: 'threadline', fingerprint: FP3, mutualVerifiedCount: 2, ...extra });
const peer = (over: Record<string, unknown> = {}) => ({
  peerFp: FP, peerName: 'PP', lastSentAt: minsAgo(4), lastAckedAt: minsAgo(4), lastInboundAt: minsAgo(30), pendingCount: 0, oldestPendingAgeMs: null, escalatedCount: 0, failedCount: 0, unconfirmedCount: 0,
  lastRelayStatus: 'delivered', stale: false, dark: false, darkSince: null, queuedCount: 0, connectedNow: true, connectedNowReason: null, connectedAsOf: minsAgo(2), ...over,
});
const pairings = (rows: unknown[]) => ok({ pairings: rows });
const invites = (over: Record<string, unknown> = {}) => ok({ invites: [], pendingAccepts: [], knownPeers: [{ fp: FP, name: 'PP', pairingState: 'mutual-verified' }], restartNotices: [], handshake: [], ...over });
const usedInvite = { iid: 'ab'.repeat(16), state: 'used', exp: minsAgo(-50), createdAt: minsAgo(10), acceptor: { fp: FP2, key: 'k', agent: 'Scout', owner: 'Carl', acceptedAt: minsAgo(1) } };
const pool = ok({ enabled: true, selfMachineId: 'studio', router: { holder: 'mini', epoch: 3, holdsLease: false }, machines: [{ machineId: 'studio', nickname: 'Mac Studio' }, { machineId: 'mini', nickname: 'the mini' }] });
const conv = (rows: unknown[], partial = false) => ok({ scope: 'mesh', conversations: rows, partial });
const ownConv = { kind: 'own', conversationId: 'thread-pp-1', peerFingerprint: FP, holderMachineId: 'studio', status: 'open', stalenessMs: 0 };
const replicaConv = { kind: 'replica', conversationId: 'thread-pp-2', peerFingerprint: FP, holderMachineId: 'mini', boundTopicId: 52075, status: 'open', stalenessMs: 7 * 60000, streamStatus: 'behind' };
const threads = ok({ threads: [{ threadId: 'thread-pp-1', remoteAgent: FP, remoteAgentName: 'PP', messageCount: 6, inboundCount: 3, outboundCount: 3, firstSeen: minsAgo(600), lastSeen: minsAgo(12), avgResponseLatencyMs: 1000, bridge: null, hasSpawnedSession: false }], count: 1 });
const quiet = () => ({ health: health({ state: 'connected', recoverable: true }), pairingRes: pairings([{ peerFp: FP, peerName: 'PP', state: 'mutual-verified', verifiedAt: minsAgo(500), trustSource: 'pairing' }]), invitesRes: invites(), peersRes: ok({ peers: [peer()], count: 1, staleCount: 0, darkCount: 0 }), convRes: conv([ownConv]), threadsRes: threads, poolRes: pool });

describe('my own relay comes first', () => {
  it('names every relay state in words, with its tone; a failed health read is can’t tell, never fine', () => {
    expect(relayModel(health({ state: 'connected', recoverable: true }), NOW)).toMatchObject({ state: 'connected', tone: 'ok', connected: true, fingerprint: FP3, mutualVerifiedCount: 2 });
    expect(shortFp(FP3)).toBe('0123456789ab…');
    expect(relayModel(health({ state: 'disconnected', recoverable: true, since: minsAgo(3) }), NOW)).toMatchObject({ state: 'disconnected', tone: 'attn', connected: false, since: '3 min ago' });
    expect(relayModel(health({ state: 'disconnected', recoverable: true }), NOW).word).toContain('retrying on my own');
    expect(relayModel(health({ state: 'displaced', recoverable: false, since: minsAgo(20) }), NOW)).toMatchObject({ state: 'displaced', tone: 'bad' });
    expect(relayModel(health({ state: 'displaced', recoverable: false }), NOW).word).toContain('15-minute pause');
    expect(relayModel(health({ state: 'not-provisioned', recoverable: true }), NOW)).toMatchObject({ state: 'not-provisioned', tone: 'attn' });
    expect(relayModel(health({ state: 'standby', recoverable: true }), NOW)).toMatchObject({ state: 'standby', connected: true, tone: 'ok' });
    expect(relayModel(health({ state: 'never-connected', recoverable: true }), NOW).tone).toBe('attn');
    expect(relayModel(health({ state: 'not-configured', recoverable: true }), NOW)).toMatchObject({ state: 'not-configured', tone: 'off', connected: false });
    const ct = relayModel(fail('no answer within 5 seconds'), NOW);
    expect(ct).toMatchObject({ state: 'cant-tell', tone: 'unknown', connected: false, fingerprint: null, mutualVerifiedCount: null });
    expect(ct.word).toContain('no answer within 5 seconds');
    expect(relayModel(ok({ status: 'ok' }), NOW).state).toBe('cant-tell'); // no relay block: not fabricated as connected
  });
  it('identity coherence: agree / partial / disagree / cannot-tell are told apart; absent means single machine', () => {
    expect(relayModel(health({ state: 'connected' }, { identityCoherence: { state: 'agree' } }), NOW).identity).toMatchObject({ state: 'agree', tone: 'ok' });
    expect(relayModel(health({ state: 'connected' }, { identityCoherence: { state: 'partial-agree' } }), NOW).identity!.tone).toBe('ok');
    const dis = relayModel(health({ state: 'connected' }, { identityCoherence: { state: 'disagree' } }), NOW).identity!;
    expect(dis.tone).toBe('bad');
    expect(dis.word).toContain('lost');
    expect(relayModel(health({ state: 'connected' }, { identityCoherence: { state: 'cannot-tell' } }), NOW).identity!.tone).toBe('unknown');
    expect(relayModel(health({ state: 'connected' }), NOW).identity).toBeNull();
  });
});

describe('peer delivery words are distinct', () => {
  it('dark: nothing back for N h, a proxy that cannot tell offline from wrong address', () => {
    const w = peerWords(peer({ dark: true, darkSince: minsAgo(6 * 60), queuedCount: 3, lastAckedAt: minsAgo(7 * 60), lastInboundAt: null, lastRelayStatus: 'queued', connectedNow: null, connectedNowReason: 'no-row', connectedAsOf: null }), NOW);
    expect(w.kind).toBe('dark');
    expect(w.tone).toBe('bad');
    expect(w.word).toBe('Nothing back for 6 h');
    expect(w.sub).toContain('3 messages waiting unanswered');
    expect(w.sub).toContain('may be offline, or listening at another address');
    expect(w.sub).toContain('the relay has no record of it');
  });
  it('stale: a message of mine has waited for its acknowledgement past the threshold (not dark)', () => {
    const w = peerWords(peer({ stale: true, pendingCount: 2, oldestPendingAgeMs: 40 * 60000, connectedNow: false, connectedAsOf: minsAgo(1) }), NOW);
    expect(w).toMatchObject({ kind: 'stale', tone: 'attn', word: 'Waiting for an acknowledgement' });
    expect(w.sub).toContain('2 messages of mine have gone unacknowledged for 40 min');
    expect(w.sub).toContain('the relay saw it not connected as of 1 min ago');
  });
  it('queued: the relay holds the message because the peer is offline; unconfirmed: unknown, not lost; rejected: the relay refused it', () => {
    const q = peerWords(peer({ lastRelayStatus: 'queued', lastAckedAt: null, lastInboundAt: null, pendingCount: 1 }), NOW);
    expect(q).toMatchObject({ kind: 'queued', tone: 'attn', word: 'Messages waiting at the relay' });
    expect(q.sub).toContain('looks offline');
    const u = peerWords(peer({ lastRelayStatus: 'unconfirmed', lastAckedAt: null, lastInboundAt: null, unconfirmedCount: 1, connectedNow: null, connectedNowReason: 'relay-down', connectedAsOf: null }), NOW);
    expect(u).toMatchObject({ kind: 'unconfirmed', tone: 'unknown', word: 'Last message unconfirmed' });
    expect(u.sub).toContain('not known lost, not known delivered');
    expect(u.sub).toContain('my own relay connection is down');
    expect(u.counts).toBe('1 unconfirmed');
    const r = peerWords(peer({ lastRelayStatus: 'rejected', lastAckedAt: null, lastInboundAt: null, failedCount: 2 }), NOW);
    expect(r).toMatchObject({ kind: 'rejected', tone: 'attn' });
    expect(r.counts).toBe('2 failed sends');
  });
  it('a healthy peer says when it last answered; sent-but-nothing-back and never-messaged are their own words', () => {
    expect(peerWords(peer(), NOW)).toMatchObject({ kind: 'answered', tone: 'ok', word: 'Answered 4 min ago', lastHeard: '4 min ago' });
    expect(peerWords(peer(), NOW).sub).toBe('the relay saw it connected as of 2 min ago');
    expect(peerWords(peer({ lastAckedAt: null, lastInboundAt: null, lastRelayStatus: 'delivered', lastSentAt: minsAgo(9), pendingCount: 1 }), NOW)).toMatchObject({ kind: 'sent', tone: 'attn', word: 'Sent 9 min ago, nothing back yet' });
    expect(peerWords(peer({ lastAckedAt: null, lastInboundAt: null, lastSentAt: null, lastRelayStatus: null, connectedNow: null, connectedNowReason: 'stale', connectedAsOf: minsAgo(90) }), NOW)).toMatchObject({ kind: 'quiet', word: 'No messages exchanged yet' });
    expect(connectedWords({ connectedNow: null, connectedNowReason: 'stale', connectedAsOf: minsAgo(90) }, NOW)).toContain('too old to trust (2 h ago)');
    expect(connectedWords({ connectedNow: null, connectedNowReason: null }, NOW)).toBeNull();
  });
});

describe('pairing', () => {
  it('ok: pairings + invites, with finish prompts, leak alarms, open invites and unexpired restart notices picked out', () => {
    const leaked = { iid: 'cd'.repeat(16), state: 'used', exp: minsAgo(-30), secondAccept: { at: minsAgo(60), agent: 'Mallory' } };
    const p = pairingModel(pairings([{ peerFp: FP, peerName: 'PP', state: 'mutual-verified' }]), invites({ invites: [usedInvite, leaked, { iid: 'ef'.repeat(16), state: 'open', exp: minsAgo(-20) }, { iid: '12'.repeat(16), state: 'open', exp: minsAgo(5) }], pendingAccepts: [{ iid: '34'.repeat(16), claimedAgent: 'Scout', claimedOwner: 'Justin', inviterFp: FP2, exp: minsAgo(-30), checkCode: 'K7Q2' }], restartNotices: [{ id: 'a'.repeat(64), claimedAgent: 'Old', exp: minsAgo(-10) }, { id: 'b'.repeat(64), claimedAgent: 'Gone', exp: minsAgo(1) }] }), pool, NOW);
    expect(p.state).toBe('ok');
    expect(p.finishPrompts.map((i) => i.iid)).toEqual([usedInvite.iid]);
    expect(p.alarms.map((i) => i.iid)).toEqual([leaked.iid]);
    expect(p.openInvites.map((i) => i.iid)).toEqual(['ef'.repeat(16)]);
    expect(p.restartNotices.map((n) => n.claimedAgent)).toEqual(['Old']);
    expect(p.pendingAccepts).toHaveLength(1);
    expect(p.knownPeers[0].name).toBe('PP');
    const cards = waitingCards(p, NOW);
    expect(cards.map((c) => c.kind)).toEqual(['restart', 'alarm', 'accept', 'finish']);
    expect(cards[3]).toMatchObject({ name: 'Scout', actions: ['finish', 'not-them'] });
    expect(cards[3].body).toContain('which says it belongs to Carl');
    expect(cards[2].body).toContain('K7Q2');
    expect(cards[1].body).toContain('Mallory');
  });
  it('a 503 is told apart: turned off, relay on another machine (named from /pool), or can’t tell', () => {
    const o = pairingModel(off('verified pairing not enabled'), off('verified pairing not enabled'), pool, NOW);
    expect(o.state).toBe('off');
    const e = pairingModel(pairings([]), off('invite pairing unavailable (this machine does not run the Threadline relay)'), pool, NOW);
    expect(e.state).toBe('elsewhere');
    expect(e.holder).toEqual({ machineId: 'mini', name: 'the mini' });
    expect(relayHolder(ok({ enabled: false, machines: [], router: null }))).toBeNull();
    expect(pairingModel(off('trust manager unavailable'), off('trust manager unavailable'), pool, NOW).state).toBe('cant-tell');
    const partial = pairingModel(pairings([{ peerFp: FP, peerName: 'PP', state: 'mutual-verified' }]), fail('no answer within 5 seconds'), pool, NOW);
    expect(partial.state).toBe('ok');
    expect(partial.pairings).toHaveLength(1);
    expect(partial.invitesReason).toContain('no answer within 5 seconds');
  });
  it('pairing words follow the code: invite-accepted waits on the OTHER side’s finish (my own finish shows as a waiting card)', () => {
    expect(pairingWord('mutual-verified')).toBe('Paired');
    expect(pairingWord('identity-verified')).toContain('another of my machines');
    expect(pairingWord('invite-accepted')).toContain('waiting for the other side to finish');
    expect(pairingWord('verification-failed')).toContain('Blocked');
    expect(pairingWord(null)).toBeNull();
  });
});

describe('conversations and the merged agent rows', () => {
  it('an own conversation is openable; one another machine holds is a summary that names the holder and the record age', () => {
    const c = conversationRows(conv([ownConv, replicaConv]), threads, { selfMachineId: 'studio', names: { studio: 'Mac Studio', mini: 'the mini' } }, NOW);
    expect(c.state).toBe('ok');
    const own = c.rows.find((r) => r.id === 'thread-pp-1')!;
    expect(own).toMatchObject({ heldElsewhere: false, main: 'Conversation name unavailable', end: '12 min ago', hasTopic: false });
    expect(own.sub).toBe('open · 6 messages · no Telegram topic');
    const rep = c.rows.find((r) => r.id === 'thread-pp-2')!;
    expect(rep).toMatchObject({ heldElsewhere: true, holderName: 'the mini', main: 'Conversation name unavailable', hasTopic: true });
    expect(rep.sub).toContain('lives on the mini (record 7 min old)');
    expect(rep.sub).toContain('record behind');
    expect(Object.keys(c.byPeer)).toEqual([FP]);
    expect(conversationRows(off('conversation store not available'), threads, {}, NOW)).toMatchObject({ state: 'off', rows: [] });
    expect(conversationRows(fail(), threads, {}, NOW).reason).toContain('the server answered 500');
    // No pool: the own rows name the self machine, so a replica is still recognised.
    expect(conversationRows(conv([ownConv, replicaConv]), fail(), {}, NOW).rows.find((r) => r.id === 'thread-pp-2')!.heldElsewhere).toBe(true);
  });
  it('one row per agent from pairings, delivery records and history; history-only is never shown as paired; peers off reads can’t tell', () => {
    const pairing = pairingModel(pairings([{ peerFp: FP, peerName: 'PP', state: 'mutual-verified' }, { peerFp: FP2, peerName: 'Scout', state: 'invite-accepted' }]), invites(), pool, NOW);
    const conversations = conversationRows(conv([ownConv, { ...ownConv, conversationId: 'thread-muse-1', peerFingerprint: FP3 }]), ok({ threads: [{ threadId: 'thread-muse-1', remoteAgent: FP3, remoteAgentName: 'Muse', messageCount: 1, lastSeen: minsAgo(1) }] }), { selfMachineId: 'studio' }, NOW);
    const { agents, peersState } = buildAgents({ pairing, peersRes: ok({ peers: [peer(), peer({ peerFp: FP2, peerName: 'Scout', dark: true, darkSince: minsAgo(360), lastAckedAt: null, lastInboundAt: null, queuedCount: 1 })] }), conversations, threadsRes: threads }, NOW);
    expect(peersState).toBe('ok');
    // Problems first, then can't-tell, then fine (the same order the Machines page uses).
    expect(agents.map((a) => [a.name, a.tone])).toEqual([['Scout', 'bad'], ['Muse', 'unknown'], ['PP', 'ok']]);
    expect(agents[2].sub).toBe('Paired · Answered 4 min ago');
    expect(agents[2].end).toBe('4 min ago');
    expect(agents[0].sub).toBe('Pairing not finished — waiting for the other side to finish · Nothing back for 6 h');
    expect(agents[1]).toMatchObject({ historyOnly: true, paired: false, sub: 'History only · no delivery record yet' });
    expect(agents[1].conversations).toHaveLength(1);
    const offPeers = buildAgents({ pairing, peersRes: off('A2A delivery tracker not initialized'), conversations, threadsRes: threads }, NOW);
    expect(offPeers.agents.find((a) => a.name === 'PP')!.sub).toBe('Paired · can’t tell if it’s reachable');
    expect(offPeers.peersReason).toContain('switched off');
    expect(buildAgents({ pairing, peersRes: fail(), conversations, threadsRes: threads }, NOW).peersReason).toContain('the server answered 500');
  });
});

describe('the page', () => {
  it('leads with what waits on the operator, then my own relay, then a peer not answering, then waiting sends, then the calm count', () => {
    const q = quiet();
    expect(buildAgentsPage(q, NOW)).toMatchObject({ mode: 'ok', headline: 'PP is reachable.', tone: 'ok' });
    expect(buildAgentsPage(q, NOW).facts.map((f) => [f.n, f.label])).toEqual([[1, 'paired'], [0, 'waiting on you'], [0, 'not answering']]);
    const two = buildAgentsPage({ ...q, pairingRes: pairings([{ peerFp: FP, peerName: 'PP', state: 'mutual-verified' }, { peerFp: FP2, peerName: 'Codey', state: 'mutual-verified' }]), peersRes: ok({ peers: [peer(), peer({ peerFp: FP2, peerName: 'Codey', lastAckedAt: minsAgo(120) })] }) }, NOW);
    expect(two.headline).toBe('2 agents, both reachable.');
    const waiting = buildAgentsPage({ ...q, invitesRes: invites({ invites: [usedInvite] }) }, NOW);
    expect(waiting).toMatchObject({ headline: 'Scout is waiting for you to finish pairing.', tone: 'attn' });
    expect(waiting.waiting[0].kind).toBe('finish');
    expect(waiting.facts[1]).toMatchObject({ n: 1, label: 'waiting on you', tone: 'attn' });
    const down = buildAgentsPage({ ...q, health: health({ state: 'disconnected', recoverable: true, since: minsAgo(2) }) }, NOW);
    expect(down).toMatchObject({ headline: 'I’m not connected to the agent network — checking again.', tone: 'attn' });
    expect(down.facts.find((f) => f.label === 'my connection')).toMatchObject({ n: 'down', tone: 'attn' });
    expect(buildAgentsPage({ ...q, health: health({ state: 'displaced', recoverable: false }) }, NOW).tone).toBe('bad');
    const dark = buildAgentsPage({ ...q, peersRes: ok({ peers: [peer({ dark: true, darkSince: minsAgo(6 * 60), lastAckedAt: minsAgo(7 * 60), lastInboundAt: null })] }) }, NOW);
    expect(dark).toMatchObject({ headline: 'PP hasn’t answered for 6 h.', tone: 'bad' });
    expect(dark.facts[2]).toMatchObject({ n: 1, label: 'not answering', tone: 'bad' });
    const queued = buildAgentsPage({ ...q, peersRes: ok({ peers: [peer({ lastRelayStatus: 'queued', lastAckedAt: null, lastInboundAt: null })] }) }, NOW);
    expect(queued).toMatchObject({ headline: 'Messages to PP are waiting.', tone: 'attn' });
    // An unreadable relay read never claims connection, and never hides the agents.
    const ct = buildAgentsPage({ ...q, health: fail('no answer within 5 seconds') }, NOW);
    expect(ct.headline).toBe('PP is reachable.');
    expect(ct.facts.find((f) => f.label === 'my connection')).toMatchObject({ n: 'can’t tell', tone: 'unknown' });
    // Peers unreadable: the count is honest about reachability.
    expect(buildAgentsPage({ ...q, peersRes: fail() }, NOW).headline).toBe('1 agent; can’t tell whether it is reachable.');
    // Pairing elsewhere names the holder; a partial pool read is a note, not silence.
    const elsewhere = buildAgentsPage({ ...q, pairingRes: pairings([]), invitesRes: off('invite pairing unavailable (this machine does not run the Threadline relay)'), peersRes: ok({ peers: [peer()], pool: { failed: [{ machineId: 'mini', error: 'offline' }] } }) }, NOW);
    expect(elsewhere.sub).toContain('Pairing runs on the mini');
    expect(elsewhere.notes).toContain('No delivery records from the mini.');
    const disagree = buildAgentsPage({ ...q, health: health({ state: 'connected' }, { identityCoherence: { state: 'disagree' } }) }, NOW);
    expect(disagree.sub).toContain('My machines disagree');
    expect(buildAgentsPage({ ...q, pairingRes: pairings([]), peersRes: ok({ peers: [] }), convRes: conv([]) }, NOW)).toMatchObject({ headline: 'No other agents yet.', sub: 'Connect another agent to start.' });
  });
  it('the network off: one headline, how to turn it on, no sections; certain only when the relay itself says not-configured', () => {
    const offAll = { health: health({ state: 'not-configured', recoverable: true }), pairingRes: off('verified pairing not enabled'), invitesRes: off('verified pairing not enabled'), peersRes: off('A2A delivery tracker not initialized'), convRes: off('conversation store not available'), threadsRes: off('Threadline observability not initialized'), poolRes: ok({ enabled: false, machines: [] }) };
    const o = buildAgentsPage(offAll, NOW);
    expect(o).toMatchObject({ mode: 'off', certain: true, headline: 'The agent network is off on this agent.', tone: 'muted', agents: [], waiting: [] });
    expect(o.sub).toContain('ask me to “connect to the agent network”');
    expect(o.sub).toContain('Turn on pairing');
    const unsure = buildAgentsPage({ ...offAll, health: fail('the server answered 404'), peersRes: ok({ peers: [] }) }, NOW);
    expect(unsure).toMatchObject({ mode: 'off', certain: false, headline: 'The agent network looks off on this agent.' });
    expect(unsure.sub).toContain('the server answered 404');
    // One known agent means the page is NOT the off page, whatever the relay says.
    expect(buildAgentsPage({ ...offAll, peersRes: ok({ peers: [peer()] }) }, NOW).mode).toBe('ok');
    expect(buildAgentsPage({ ...offAll, peersRes: ok({ peers: [peer()] }) }, NOW).sub).toContain('Pairing is turned off on this agent');
  });
});

describe('one conversation’s history', () => {
  it('bodies are kept as strings for textContent (HTML is not parsed); direction, back-fill and sync words are read; only diverged states are actionable', () => {
    const t = ok({ threadId: 'thread-pp-1', messageCount: 2, hasMore: false, bodiesAreUntrustedData: true, entries: [
      { seq: 1, messageId: 'm1', direction: 'inbound', body: '<img src=x onerror="alert(1)"> hello', createdAt: minsAgo(5), at: minsAgo(5), backfilled: true },
      { seq: 2, messageId: 'm2', direction: 'outbound', body: null, at: minsAgo(4) },
    ] });
    const m = threadModel(t, ok({ threadId: 'thread-pp-1', symmetryState: 'diverged', chainOk: true }));
    expect(m.ok).toBe(true);
    expect(m.entries[0]).toMatchObject({ direction: 'in', body: '<img src=x onerror="alert(1)"> hello', backfilled: true });
    expect(m.entries[1]).toMatchObject({ direction: 'out', body: null });
    expect(m.symmetry).toMatchObject({ state: 'diverged', actionable: true, tone: 'attn' });
    expect(m.untrusted).toBe(true);
    expect(symmetryWords('verified')).toMatchObject({ actionable: false, tone: 'ok' });
    expect(symmetryWords('diverged-unreconcilable').actionable).toBe(true);
    expect(symmetryWords('unverified-peer-legacy').actionable).toBe(false);
    expect(symmetryWords('local-integrity-fault').tone).toBe('bad');
    expect(threadModel(t, ok({ symmetryState: 'local-integrity-fault', chainOk: false, recovery: 'Delete the log and re-converge.' })).symmetry!.recovery).toBe('Delete the log and re-converge.');
    expect(threadModel(t, fail('no answer within 5 seconds')).symmetry!.state).toBe('cant-tell');
    expect(threadModel(off('Canonical history not available'), null)).toMatchObject({ ok: false, reason: 'The message history is switched off on this agent.' });
    expect(threadModel(fail(), null).reason).toContain('the server answered 500');
    expect(threadModel(ok({ threadId: 'x' }), null).reason).toContain('without its messages');
  });
});

describe('action words never claim more than the server did', () => {
  it('an invite shows the server’s message, the plan’s sentence and the expiry in local time; 503s are told apart', () => {
    const exp = minsAgo(-60);
    const w = inviteResultWords(200, { ok: true, iid: 'ab'.repeat(16), exp, message: 'Echo invites you… tlinv1:abc.def' }, NOW);
    expect(w).toMatchObject({ ok: true, message: 'Echo invites you… tlinv1:abc.def', exp });
    expect(w.sentence).toBe(`Send this privately to their person, in any app you already use. It works once and expires at ${localTime(exp, NOW)}.`);
    expect(inviteSentence(exp, NOW)).toContain(new Date(exp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    expect(localTime('nonsense')).toBe('an unknown time');
    expect(inviteResultWords(503, { error: 'invite pairing unavailable (this machine does not run the Threadline relay)' }).text).toContain('machine that holds my network connection');
    expect(inviteResultWords(503, { error: 'verified pairing not enabled' }).text).toContain('turned off');
    expect(inviteResultWords(400, { error: 'ttlMinutes must be between 1 and 1440' }).text).toBe('Could not make an invite: ttlMinutes must be between 1 and 1440.');
  });
  it('PIN, bearer, enable and bind results', () => {
    expect(pinResultWords(200, { ok: true }, 'Done.')).toEqual({ ok: true, text: 'Done.' });
    expect(pinResultWords(403, { error: 'Operator PIN required' }).text).toBe('That PIN was not accepted. Nothing has changed.');
    expect(pinResultWords(429, {}).text).toContain('Too many PIN attempts');
    expect(pinResultWords(503, { error: 'PIN authentication not available (no dashboardPin configured)' }).text).toContain('No dashboard PIN is configured');
    expect(pinResultWords(503, { error: 'verified pairing not enabled' }).text).toBe('verified pairing not enabled. Nothing has changed.');
    expect(pinResultWords(409, { error: 'no such pending accept' }).text).toBe('no such pending accept. Nothing has changed.');
    expect(bearerResultWords(200, {}, 'Declined.')).toEqual({ ok: true, text: 'Declined.' });
    expect(bearerResultWords(409, { error: 'no open invite with that id' }).text).toBe('no open invite with that id. Nothing has changed.');
    expect(enableWords(200, { state: 'ready' })).toMatchObject({ ok: true, done: true });
    expect(enableWords(202, { state: 'restart-requested', sayToPerson: 'I am switching the agent network on; back in a minute.' })).toMatchObject({ ok: true, done: false, text: 'I am switching the agent network on; back in a minute.' });
    expect(enableWords(409, { state: 'unavailable-here' }).text).toContain('Another of my machines holds');
    expect(enableWords(503, { state: 'restart-unavailable', reason: 'no supervised restart here' }).text).toBe('no supervised restart here');
    expect(bindRequest('open', 'thread-pp-1', '')).toEqual({ action: 'open', threadId: 'thread-pp-1' });
    expect(bindRequest('tie', 'thread-pp-1', ' 52075 ')).toEqual({ action: 'tie', threadId: 'thread-pp-1', targetTopicId: 52075 });
    expect(bindRequest('tie', 'thread-pp-1', 'PP Hub')).toEqual({ action: 'tie', threadId: 'thread-pp-1', targetTopicName: 'PP Hub' });
    expect(bindResultWords(200, { ok: true, topicName: '🤝 PP' }).text).toBe('Done: this conversation now lives in “🤝 PP”; its future replies go there.');
    expect(bindResultWords(503, { error: 'Threadline hub not available' }).text).toContain('not available on this agent');
    expect(bindResultWords(409, { error: 'More than one unbound conversation' }).ok).toBe(false);
    expect(sourceState(undefined)).toBe('failed');
  });
  it('the tile flips to the native page under its new name, and the old name stays as the legacy tab id', () => {
    expect(NATIVE_PAGES.threadline).toBe('#/people/agents');
    expect(tabHref('threadline')).toBe('#/people/agents');
    const tab = GROUPS.find((g) => g.id === 'people')!.tabs.find((t) => t.id === 'threadline')!;
    expect(tab.label).toBe('Other agents');
  });
});

describe('the page in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());

  it('boots the shipped console and renders a peer-authored body with HTML in it as text, inside a labelled quote; the Finish card takes the PIN in one body', async () => {
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const html = '<img src=x onerror="alert(1)"><b>bold</b> says PP';
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/people/agents' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    g.fetch = async (url: string, opts?: { method?: string; body?: string }) => {
      if (opts && opts.method === 'POST') { posted.push({ url, body: JSON.parse(opts.body || '{}') }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
      const q = quiet();
      const live = new Date(Date.now() - 4 * 60000).toISOString(); // the page reads the real clock
      const table: Record<string, { status?: number; body: unknown }> = {
        '/sessions': { body: { sessions: [] } },
        '/health': { body: { project: { name: 'echo' } } },
        '/threadline/health': { body: q.health.data },
        '/threadline/pairing': { body: q.pairingRes.data },
        '/threadline/pairing/invites': { body: invites({ invites: [{ ...usedInvite, exp: new Date(Date.now() + 3600_000).toISOString() }] }).data },
        '/threadline/peers/health?scope=pool': { body: { peers: [peer({ lastSentAt: live, lastAckedAt: live, lastInboundAt: live, connectedAsOf: live })], count: 1 } },
        '/threadline/conversations?scope=mesh': { body: conv([ownConv, replicaConv]).data },
        '/threadline/observability/threads': { body: threads.data },
        '/pool': { body: pool.data },
        '/threadline/threads/thread-pp-1?limit=200': { body: { threadId: 'thread-pp-1', hasMore: false, bodiesAreUntrustedData: true, entries: [{ seq: 1, messageId: 'm1', direction: 'inbound', body: html, at: minsAgo(5) }, { seq: 2, messageId: 'm2', direction: 'outbound', body: 'noted', at: minsAgo(4) }] } },
        '/threadline/threads/thread-pp-1/health': { body: { threadId: 'thread-pp-1', symmetryState: 'verified', chainOk: true } },
      };
      const hit = table[url];
      if (!hit) return { ok: false, status: 404, json: async () => ({ error: 'no such route in the test' }) };
      const status = hit.status || 200;
      return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(hit.body)) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 20));
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('Scout is waiting for you to finish pairing.');
    const card = doc.querySelector('.waiting-card[data-waiting="finish"]')!;
    expect(card).toBeTruthy();
    expect(doc.querySelectorAll('#sec-agents button.row')).toHaveLength(1);
    expect(doc.querySelector('#sec-agents .row-sub')!.textContent).toBe('Paired · Answered 4 min ago');
    expect(doc.querySelector('.pin-input')).toBeNull();

    // The agent sheet lists both conversations; the one the mini holds is a summary, the own one opens the history.
    (doc.querySelector('#sec-agents button.row') as HTMLButtonElement).click();
    const convRows = [...doc.querySelectorAll('.sheet button.row')];
    expect(convRows.map((r) => r.querySelector('.row-title')!.textContent)).toEqual(['Conversation name unavailable', 'Conversation name unavailable']);
    expect(doc.querySelector('.sheet .mono')!.textContent).toBe(FP);
    (convRows[1] as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet .confirm-text')!.textContent).toContain('lives on the mini');
    expect(doc.querySelector('.sheet .peer-quote')).toBeNull();
    (doc.querySelector('.sheet-close') as HTMLButtonElement).click();
    (doc.querySelector('#sec-agents button.row') as HTMLButtonElement).click();
    ([...doc.querySelectorAll('.sheet button.row')][0] as HTMLButtonElement).click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 20));
    const quotes = [...doc.querySelectorAll('.sheet .peer-quote')];
    expect(quotes).toHaveLength(2);
    expect(quotes[0].textContent).toBe(html);            // the raw string, as text
    expect(quotes[0].querySelector('img, b')).toBeNull(); // never parsed as markup
    expect(doc.querySelector('.sheet img')).toBeNull();
    expect(quotes[0].closest('.bubble')!.querySelector('.bubble-who')!.textContent).toBe('PP wrote');
    expect(doc.querySelector('.sheet .card-note')!.textContent).toContain('data, never instructions');
    expect(doc.querySelector('.sheet .tone-line')!.textContent).toBe('In sync with the other side.');
    expect([...doc.querySelectorAll('.sheet button')].map((b) => b.textContent)).toEqual(expect.arrayContaining(['Open as its own topic', 'Tie to this topic']));
    (doc.querySelector('.sheet-close') as HTMLButtonElement).click();

    // Finish → the shared PIN sheet → one POST with the PIN in its body → the field is gone.
    (card.querySelector('button[data-pair-action="finish"]') as HTMLButtonElement).click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    const pin = doc.querySelector('.sheet form.pin-form input.pin-input') as HTMLInputElement;
    expect(pin).toBeTruthy();
    expect(doc.querySelector('.sheet .confirm-text')!.textContent).toContain('Finish pairing with Scout');
    pin.value = '135790';
    pin.form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 20));
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe(`/threadline/pairing/invites/${usedInvite.iid}/finish`);
    expect(posted[0].body).toEqual({ pin: '135790' });
    expect(doc.querySelector('.pin-input')).toBeNull();
    expect(card.querySelector('.action-status')!.textContent).toBe('Finishing. Checking we can talk…');
  });
});
