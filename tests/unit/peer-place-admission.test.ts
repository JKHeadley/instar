/**
 * Another agent's place: the admission truth table, the status the app reads, the registry,
 * thread ownership on the real store, the route guard, the spawn manager's keys and capacity,
 * the receiving machine's check and the acknowledgment text.
 * Spec: docs/specs/memory-privacy-agent-places.md.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decidePeerAdmission, agentSessionsStatus, hasExplicitGrant, isPeerPlaceKey, peerFingerprintOfPlace,
  AGENT_SESSIONS_REFUSED_REASON,
} from '../../src/users/peerPlaceAdmission.js';
import { PlaceSessionRegistry } from '../../src/threadline/PlaceSessionRegistry.js';
import { ThreadResumeMap } from '../../src/threadline/ThreadResumeMap.js';
import { memorySessionAllows, memoryReplyChannel } from '../../src/server/memorySessionGuard.js';
import { SpawnRequestManager, spawnAgentKey } from '../../src/messaging/SpawnRequestManager.js';
import { handleTopicReplyInjectCommand } from '../../src/threadline/relayForward.js';
import { requiredAckInstructionForPlace, requiredAckReminderForPlace } from '../../src/threadline/requiredAck.js';
import { conversationRefOf } from '../../src/users/TeamConfinement.js';
import { isUnplacedPeerOriginSession } from '../../src/core/SessionManager.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';

const FP = 'f'.repeat(64);
const granted = { source: 'user-granted', level: 'verified' };
const base = { multiPerson: true, fingerprint: FP, trust: granted, refuseAgentSessions: false, scopedSessionsReady: true };

describe('admission truth table (§1)', () => {
  it('not multi-person: today, whatever else is true', () => {
    for (const fingerprint of [null, FP]) for (const refuse of [true, false]) {
      expect(decidePeerAdmission({ ...base, multiPerson: false, fingerprint, refuseAgentSessions: refuse }).kind).toBe('today');
    }
  });
  it('no authenticated fingerprint: refused', () => {
    expect(decidePeerAdmission({ ...base, fingerprint: null })).toMatchObject({ kind: 'refused', cause: 'no-identity', reason: AGENT_SESSIONS_REFUSED_REASON });
    expect(decidePeerAdmission({ ...base, fingerprint: '   ' })).toMatchObject({ kind: 'refused', cause: 'no-identity' });
  });
  it('no explicit grant: refused; setup-default never qualifies, even at a high level', () => {
    expect(decidePeerAdmission({ ...base, trust: null })).toMatchObject({ kind: 'refused', cause: 'no-grant' });
    expect(decidePeerAdmission({ ...base, trust: { source: 'setup-default', level: 'verified' } })).toMatchObject({ cause: 'no-grant' });
    expect(decidePeerAdmission({ ...base, trust: { source: 'setup-default', level: 'autonomous' } })).toMatchObject({ cause: 'no-grant' });
    expect(decidePeerAdmission({ ...base, trust: { source: 'user-granted', level: 'untrusted' } })).toMatchObject({ cause: 'no-grant' });
  });
  it('every granting source admits at verified or above', () => {
    for (const source of ['user-granted', 'paired-machine-granted', 'mutual-verified']) {
      for (const level of ['verified', 'trusted', 'autonomous']) {
        expect(hasExplicitGrant({ source, level })).toBe(true);
      }
    }
  });
  it('the switch refuses', () => {
    expect(decidePeerAdmission({ ...base, refuseAgentSessions: true })).toMatchObject({ kind: 'refused', cause: 'switch' });
  });
  it('no sandbox or framework: refused', () => {
    expect(decidePeerAdmission({ ...base, scopedSessionsReady: false })).toMatchObject({ kind: 'refused', cause: 'no-sandbox' });
  });
  it('everything present: the peer\'s own place, keyed by the fingerprint', () => {
    expect(decidePeerAdmission(base)).toEqual({ kind: 'place', placeKey: `agent:${FP}`, fingerprint: FP });
  });
  it('place-key helpers', () => {
    expect(isPeerPlaceKey(`agent:${FP}`)).toBe(true);
    expect(isPeerPlaceKey('agent:')).toBe(false);
    expect(isPeerPlaceKey('slack:C1')).toBe(false);
    expect(peerFingerprintOfPlace(`agent:${FP}`)).toBe(FP);
    expect(peerFingerprintOfPlace(null)).toBeNull();
  });
});

describe('agentSessions status (§7, §8)', () => {
  it('owner-reach on one person; refused with the switch or no sandbox; own-place otherwise', () => {
    expect(agentSessionsStatus({ multiPerson: false, refuseAgentSessions: false, scopedSessionsReady: true })).toBe('owner-reach');
    expect(agentSessionsStatus({ multiPerson: true, refuseAgentSessions: true, scopedSessionsReady: true })).toBe('refused');
    expect(agentSessionsStatus({ multiPerson: true, refuseAgentSessions: false, scopedSessionsReady: false })).toBe('refused');
    expect(agentSessionsStatus({ multiPerson: true, refuseAgentSessions: false, scopedSessionsReady: true })).toBe('own-place');
  });
});

describe('PlaceSessionRegistry (§4)', () => {
  const make = (cap = 3, idleMs = 1000) => {
    let now = 1_000_000;
    const reg = new PlaceSessionRegistry({ globalCap: () => cap, idleMs: () => idleMs, now: () => now });
    return { reg, advance: (ms: number) => { now += ms; } };
  };
  it('one session per peer: a running peer gets its live session back', () => {
    const { reg } = make();
    const r = reg.reserve('a');
    expect(r.kind).toBe('reserved');
    if (r.kind === 'reserved') r.markRunning('s-a');
    expect(reg.reserve('a')).toEqual({ kind: 'live', sessionName: 's-a' });
    expect(reg.live('a')).toBe('s-a');
  });
  it('a peer still launching is refused, not double-launched', () => {
    const { reg } = make();
    reg.reserve('a');
    expect(reg.reserve('a')).toEqual({ kind: 'refused', reason: 'launching' });
  });
  it('at the cap a new peer is refused and nothing live is ended', () => {
    const { reg } = make(2);
    for (const fp of ['a', 'b']) { const r = reg.reserve(fp); if (r.kind === 'reserved') r.markRunning(`s-${fp}`); }
    expect(reg.reserve('c')).toEqual({ kind: 'refused', reason: 'cap' });
    expect(reg.live('a')).toBe('s-a');
    expect(reg.live('b')).toBe('s-b');
  });
  it('reservation is atomic: reserved records count toward the cap', () => {
    const { reg } = make(2);
    reg.reserve('a'); reg.reserve('b');
    expect(reg.reservedCount()).toBe(2);
    expect(reg.reserve('c').kind).toBe('refused');
  });
  it('a failed launch releases its slot; a running place counts once', () => {
    const { reg } = make(1);
    const r = reg.reserve('a');
    if (r.kind === 'reserved') r.release();
    expect(reg.reserve('b').kind).toBe('reserved');
    const { reg: reg2 } = make(3);
    const r2 = reg2.reserve('x');
    if (r2.kind === 'reserved') r2.markRunning('s-x');
    expect(reg2.reservedCount()).toBe(0);
  });
  it('idle end skips busy sessions', () => {
    const { reg, advance } = make(3, 1000);
    const r = reg.reserve('a'); if (r.kind === 'reserved') r.markRunning('s-a');
    reg.touch('a', 5000);
    advance(2000);
    expect(reg.idle()).toHaveLength(0);
    advance(4000);
    expect(reg.idle().map(x => x.sessionName)).toEqual(['s-a']);
    reg.forgetSession('s-a');
    expect(reg.live('a')).toBeNull();
  });
});

describe('thread ownership on the real store (§2)', () => {
  const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-place-owner-'));
    return new ThreadResumeMap(dir, dir);
  };
  it('a new thread is claimed by its first authenticated sender, and write-once', () => {
    const map = mk();
    expect(map.claimOwner('t', 'aa', { hasStoredMessages: false })).toEqual({ owner: 'aa', claimed: true });
    expect(map.claimOwner('t', 'bb', { hasStoredMessages: false })).toEqual({ owner: 'aa', claimed: false });
    const entry = { uuid: 'u', sessionName: 's', createdAt: '', savedAt: '', lastAccessedAt: '', remoteAgent: 'bb', subject: '', state: 'active' as const, pinned: false, messageCount: 1, peerFingerprint: 'bb' };
    map.save('t', entry);
    expect(map.ownership('t').owner).toBe('aa');
  });
  it('a thread with stored messages and no record is never claimed', () => {
    expect(mk().claimOwner('t', 'aa', { hasStoredMessages: true })).toEqual({ owner: null, claimed: false });
  });
  it('a legacy record is adopted only by the exact fingerprint it recorded', () => {
    const map = mk();
    const legacy = { uuid: 'u', sessionName: 's', createdAt: '', savedAt: '', lastAccessedAt: '', remoteAgent: 'aa', subject: '', state: 'idle' as const, pinned: false, messageCount: 2 };
    map.save('legacy', legacy);
    expect(map.claimOwner('legacy', 'bb', { hasStoredMessages: true }).owner).toBeNull();
    expect(map.claimOwner('legacy', 'aa', { hasStoredMessages: true })).toEqual({ owner: 'aa', claimed: true });
    map.save('named', { ...legacy, remoteAgent: 'codey' });
    expect(map.claimOwner('named', 'aa', { hasStoredMessages: true }).owner).toBeNull();
  });
  it('adoption carries the thread id only: no transcript, flagged adopted', () => {
    const map = mk();
    map.save('legacy', { uuid: 'owner-reach-uuid', sessionName: 's', createdAt: '', savedAt: '', lastAccessedAt: '', remoteAgent: 'aa', subject: '', state: 'idle' as const, pinned: false, messageCount: 2 });
    map.claimOwner('legacy', 'aa', { hasStoredMessages: true });
    const c = (map as any).store.get('legacy');
    expect(c.sessionUuid).toBeUndefined();
    expect(c.ownerAdopted).toBe(true);
  });
  it('the inbound recorder\'s bare record for this very message is claimed by the authenticated sender', () => {
    const map = mk();
    (map as any).store.mutateSync('fresh', (d: any) => { d.remoteAgent = 'agenta'; d.participants.peers.push('agenta'); d.messageCount = 1; return d; });
    expect(map.claimOwner('fresh', 'aa', { hasStoredMessages: false })).toEqual({ owner: 'aa', claimed: true });
    expect((map as any).store.get('fresh').ownerAdopted).toBeUndefined();
    // ...but not when other messages are stored on it, nor when it holds a transcript.
    (map as any).store.mutateSync('busy', (d: any) => { d.remoteAgent = 'agenta'; return d; });
    expect(map.claimOwner('busy', 'aa', { hasStoredMessages: true }).owner).toBeNull();
    (map as any).store.mutateSync('withuuid', (d: any) => { d.remoteAgent = 'agenta'; d.sessionUuid = 'u'; return d; });
    expect(map.claimOwner('withuuid', 'aa', { hasStoredMessages: false }).owner).toBeNull();
  });
  it('a thread this version sent by name is never adopted', () => {
    const map = mk();
    map.save('byname', { uuid: '', sessionName: '', createdAt: '', savedAt: '', lastAccessedAt: '', remoteAgent: 'aa', subject: '', state: 'active' as const, pinned: false, messageCount: 1 });
    map.markOwnerless('byname');
    expect(map.claimOwner('byname', 'aa', { hasStoredMessages: true }).owner).toBeNull();
  });
  it('clearTranscript forgets the transcript and its audience', () => {
    const map = mk();
    map.claimOwner('t', 'aa', { hasStoredMessages: false });
    map.save('t', { uuid: 'u1', sessionName: 's', createdAt: '', savedAt: '', lastAccessedAt: '', remoteAgent: 'aa', subject: '', state: 'active' as const, pinned: false, messageCount: 1, audienceKey: 'place:agent:aa' });
    map.clearTranscript('t');
    const c = (map as any).store.get('t');
    expect(c.sessionUuid).toBeUndefined();
    expect(c.audienceKey).toBeUndefined();
  });
});

describe('route guard (§5, §6)', () => {
  const peer = { sessionId: 's', audience: { kind: 'place' as const, placeKey: `agent:${FP}` }, placeKey: `agent:${FP}` };
  const slack = { sessionId: 's', audience: { kind: 'place' as const, placeKey: 'slack:C1' }, placeKey: 'slack:C1' };
  it('the reply route is a peer place\'s only', () => {
    expect(memorySessionAllows('POST', '/threadline/session-reply', peer)).toBe(true);
    expect(memorySessionAllows('POST', '/threadline/session-reply', slack)).toBe(false);
    expect(memoryReplyChannel('POST', '/threadline/session-reply')).toBe('threadline');
  });
  it('a peer place cannot reach the owner or the maintainers', () => {
    expect(memorySessionAllows('POST', '/team/proposals', peer)).toBe(false);
    expect(memorySessionAllows('POST', '/feedback', peer)).toBe(false);
    expect(memorySessionAllows('POST', '/team/proposals', slack)).toBe(true);
    expect(memorySessionAllows('POST', '/feedback', slack)).toBe(true);
  });
  it('a peer place never replies into Slack, the app or a person\'s channel', () => {
    for (const [m, p] of [['POST', '/slack/session-reply'], ['POST', '/app/session-reply'], ['GET', '/app/media-path/x'], ['POST', '/telegram/reply/1'], ['POST', '/slack/reply/C1'], ['POST', '/whatsapp/send/1']] as const) {
      expect(memorySessionAllows(m, p, peer)).toBe(false);
    }
    expect(memorySessionAllows('POST', '/slack/session-reply', slack)).toBe(true);
  });
  it('a peer place reaches no memory route and no relay-send', () => {
    for (const [m, p] of [['GET', '/memory/search'], ['GET', '/topic/context'], ['GET', '/commitments'], ['POST', '/threadline/relay-send'], ['POST', '/threadline/ack'], ['GET', '/view/x'], ['GET', '/api/files/download']] as const) {
      expect(memorySessionAllows(m, p, peer)).toBe(false);
    }
  });
});

describe('spawn manager (§3, §4)', () => {
  const req = (over: Record<string, unknown> = {}) => ({
    requester: { agent: 'peer-name', session: 's', machine: 'm' }, target: { agent: 'me', machine: 'm' },
    reason: 'r', context: 'ctx', priority: 'critical' as const, ...over,
  });
  it('keys a place by fingerprint, never by the shared display name', () => {
    expect(spawnAgentKey(req({ memoryPeer: 'aa' }) as any)).toBe('peer-place:aa');
    expect(spawnAgentKey(req({ memoryPeer: 'bb' }) as any)).not.toBe(spawnAgentKey(req({ memoryPeer: 'aa' }) as any));
    expect(spawnAgentKey(req() as any)).toBe('peer-name');
  });
  it('refuseSpawn sees the request; a capacity refusal queues without spawning; no priority overrides the free slot', async () => {
    const spawnSession = vi.fn().mockResolvedValue({ sessionId: 'x', tmuxSession: 'x' });
    const refuseSpawn = vi.fn(() => null);
    const mk = (over: Record<string, unknown>) => new SpawnRequestManager({
      maxSessions: 5, getActiveSessions: () => [], spawnSession, refuseSpawn, cooldownMs: 0, ...over,
    } as any);
    const capped = mk({ placeCapacity: () => 'Agent places are full (3/3); queued.' });
    const r1 = await capped.evaluate(req({ memoryPeer: 'aa' }) as any);
    expect(refuseSpawn).toHaveBeenCalledWith(expect.objectContaining({ memoryPeer: 'aa' }));
    expect(r1.approved).toBe(false);
    expect(r1.queued).toBe(true);
    expect(spawnSession).not.toHaveBeenCalled();
    const full = mk({ getActiveSessions: () => [1, 2, 3, 4], placeCapacity: undefined });
    const r2 = await full.evaluate(req({ memoryPeer: 'bb' }) as any);
    expect(r2.approved).toBe(false);
    expect(r2.reason).toMatch(/one slot kept free/);
    const ok = mk({});
    const r3 = await ok.evaluate(req({ memoryPeer: 'cc' }) as any);
    expect(r3.approved).toBe(true);
    expect(spawnSession).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ memoryPeer: 'cc' }));
    const placePrompt = spawnSession.mock.calls[spawnSession.mock.calls.length - 1][0] as string;
    expect(placePrompt).toContain('threadline-reply.sh');
    expect(placePrompt).not.toContain('threadline_send');
  });
});

describe('the receiving machine applies the same rule (§3)', () => {
  it('a refused topic is not typed into, definitively, so the holder posts it', async () => {
    const inject = vi.fn();
    const result = await handleTopicReplyInjectCommand({ type: 'a2a-topic-reply-inject', topicId: 7, text: 'hi', messageId: 'm' } as any, {
      enabled: () => true, getSessionForTopic: () => 's', isSessionAlive: () => true, inject, peerReplyAllowed: () => false,
    });
    expect(result).toEqual({ injected: false, definitive: true, reason: 'memory-privacy-refused' });
    expect(inject).not.toHaveBeenCalled();
  });
});

describe('an injected message in a place names the script (§5)', () => {
  it('the reply hint replaces threadline_send', () => {
    const msg = { id: 'm1', from: { agent: 'peer', session: 's', machine: 'x' }, to: { agent: 'me', session: 'best', machine: 'y' }, subject: 'hi', body: 'hello', type: 'query', priority: 'medium', threadId: 't9', createdAt: new Date().toISOString() } as any;
    const f = new MessageFormatter();
    const placed = f.formatInline(msg, undefined, { replyHint: '.instar/scripts/threadline-reply.sh --thread t9 "your reply"' });
    expect(placed).toContain('threadline-reply.sh --thread t9');
    expect(placed).not.toContain('threadline_send');
    expect(f.formatInline(msg)).toContain('threadline_send');
  });
});

describe('acknowledgment text and locks', () => {
  it('a place session is told to use the script, never threadline_ack', () => {
    expect(requiredAckInstructionForPlace('ar-1')).toContain('threadline-reply.sh --ack ar-1');
    expect(requiredAckInstructionForPlace('ar-1')).not.toContain('threadline_ack');
    expect(requiredAckReminderForPlace(['ar-1', 'ar-2'])).toContain('--ack ar-1 --ack ar-2');
  });
  it('spawns for one peer share a lock outside the app namespace', () => {
    expect(conversationRefOf({ memoryPlace: { kind: 'shared', placeKey: `agent:${FP}` } })).toBe(`peer-place:${FP}`);
    expect(conversationRefOf({ memoryPlace: { kind: 'system' } })).toBeNull();
  });
  it('an A2A session without a place is recognised for the flip', () => {
    expect(isUnplacedPeerOriginSession({ triggeredBy: 'spawn-request', tmuxSession: 'x', name: 'x' } as any)).toBe(true);
    expect(isUnplacedPeerOriginSession({ tmuxSession: 'echo-msg-warm-1', name: 'x' } as any)).toBe(true);
    expect(isUnplacedPeerOriginSession({ triggeredBy: 'spawn-request', tmuxSession: 'x', name: 'x', memoryScopeDir: '/s' } as any)).toBe(false);
    expect(isUnplacedPeerOriginSession({ tmuxSession: 'echo-topic-12', name: 'x' } as any)).toBe(false);
  });
});
