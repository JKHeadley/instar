/**
 * Pure summarizers for the phone's native Plans, What I've learned about you and Other agents reads
 * (docs/specs/mobile-native-plans-people.md), both sides of each rule, plus the allowlist entries.
 */
import { describe, it, expect } from 'vitest';
import {
  summarizePlans, summarizePreferences, summarizeCorrections, summarizeLearned, summarizeAgents, summarizeChannels, healthWords,
  needsWords, projectLine, initiativeLine, cleanText, MAX_FINISHED, MAX_PLANS, MAX_CORRECTIONS, FUTURE_SKEW_MS, type PeerList,
} from '../../src/server/mobilePlansPeopleRoutes.js';
import { DEVICE_ALLOWLIST } from '../../src/server/mobilePairingRoutes.js';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const H = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const D = (d: number) => H(d * 24);
const names: Record<string, string> = { m_peer: 'Mac Mini', m_far: 'Laptop' };
const cov = { now: NOW, nicknameOf: (id: string) => names[id] ?? null };
const ok = (items: unknown[]) => ({ state: 'ok' as const, items });

describe('plans', () => {
  it('groups by the console rules: needs you, moving within 7 days, idle, older at 14 days, finished', () => {
    const r = summarizePlans(ok([
      { id: 'a', title: 'Needs me', status: 'active', needsUser: true, lastTouchedAt: H(1) },
      { id: 'b', title: 'Moving', status: 'active', lastTouchedAt: D(6.9) },
      { id: 'c', title: 'Idle', status: 'active', lastTouchedAt: D(7.1) },
      { id: 'd', title: 'Still idle', status: 'paused', lastTouchedAt: D(13.9) },
      { id: 'e', title: 'Older', status: 'active', needsUser: true, lastTouchedAt: D(14.1) },
      { id: 'f', title: 'Done', status: 'completed', lastTouchedAt: D(1) },
      { id: 'g', title: 'Strange status', status: 'zzz', lastTouchedAt: H(1) },
    ]), [], cov) as any;
    expect(r.sections.needsYou.map((p: any) => p.title)).toEqual(['Needs me']);
    // An unknown status (a newer peer's) is grouped as open, never dropped.
    expect(r.sections.inFlight.map((p: any) => p.title)).toEqual(['Strange status', 'Moving']);
    expect(r.sections.inFlight[0].statusWords).toBe('zzz');
    expect(r.sections.idle.map((p: any) => p.title)).toEqual(['Idle', 'Still idle']);
    expect(r.sections.older.map((p: any) => p.title)).toEqual(['Older']);
    expect(r.sections.finished.map((p: any) => p.title)).toEqual(['Done']);
    expect(r.headline).toBe('5 plans in flight. 1 needs you.');
    expect(r.sections.idle[1].line).toBe('paused');
  });

  it('a child folds under its project and counts in its round line; never a record id, path or link', () => {
    const r = summarizePlans(ok([
      { id: 'p1', kind: 'project', title: 'Big plan', status: 'active', firstLaunchAckAt: D(3), targetRepoPath: '/Users/x/repo', links: [{ url: 'https://secret.example' }],
        rounds: [{ status: 'in-progress', itemIds: ['k1', 'k2', 'k3'] }], lastTouchedAt: D(2) },
      { id: 'k1', title: 'Child one', status: 'active', parentProjectId: 'p1', pipelineStage: 'merged', specPath: 'docs/specs/x.md', lastTouchedAt: H(3) },
      { id: 'k2', title: 'Child two', status: 'active', parentProjectId: 'p1', pipelineStage: 'building' },
    ]), [], cov) as any;
    expect(r.sections.inFlight).toHaveLength(1);
    expect(r.sections.inFlight[0]).toMatchObject({ title: 'Big plan', kind: 'project', line: 'round 1 of 1 · 1 of 3 pieces merged · running', needs: null, touchedAt: H(3) });
    const text = JSON.stringify(r);
    for (const leak of ['"p1"', 'k1', '/Users/x', 'secret.example', 'docs/specs']) expect(text).not.toContain(leak);
  });

  it('needs-you words: an unacknowledged advance, a first launch, needsUser with and without a reason; a finished plan never needs you', () => {
    expect(needsWords({ kind: 'project', status: 'active', unacknowledgedAdvanceCount: 1, firstLaunchAckAt: 'x', rounds: [{ status: 'complete' }, { status: 'pending' }] })).toBe('Waiting for your OK on round 2');
    expect(needsWords({ kind: 'project', status: 'active', rounds: [{ status: 'pending' }] })).toBe('Waiting for your OK on round 1');
    expect(needsWords({ kind: 'project', status: 'active', firstLaunchAckAt: 'x', rounds: [{ status: 'pending' }] })).toBeNull();
    expect(needsWords({ status: 'active', needsUser: true, needsUserReason: 'pick one' })).toBe('Waiting on you: pick one');
    expect(needsWords({ status: 'active', needsUser: true })).toBe('Waiting on you');
    expect(needsWords({ status: 'awaiting-user' })).toBe('Waiting on you');
    expect(needsWords({ status: 'completed', needsUser: true })).toBeNull();
    expect(projectLine({ status: 'halted', firstLaunchAckAt: 'x', rounds: [{ status: 'complete' }] }, [])).toBe('all 1 rounds done · halted');
    expect(initiativeLine({ status: 'active', phases: [{ status: 'done' }, { status: 'done' }] })).toBe('all 2 steps done');
  });

  it('plans are per machine: the same id on two machines is two rows with distinct keys, each named by its machine', () => {
    const peers: PeerList[] = [
      { machineId: 'm_peer', state: 'ok', items: [{ id: 'x', title: 'Same', status: 'active', lastTouchedAt: H(1), needsUser: true }] },
      { machineId: 'm_unnamed', state: 'unreached' },
      { machineId: 'm_off', state: 'off' },
    ];
    const r = summarizePlans(ok([{ id: 'x', title: 'Same', status: 'active', lastTouchedAt: H(3) }]), peers, { ...cov, offlineMachineIds: ['m_far'] }) as any;
    expect(r.sections.needsYou.map((p: any) => [p.title, p.machine])).toEqual([['Same', 'Mac Mini']]);
    expect(r.sections.inFlight.map((p: any) => [p.title, p.machine])).toEqual([['Same', null]]);
    expect(r.sections.needsYou[0].key).not.toBe(r.sections.inFlight[0].key);
    expect(r.unread).toEqual({ count: 1, names: [] });
    expect(r.offline).toEqual({ count: 1, names: ['Laptop'] });
    expect(r.headline).toBe('2 plans in flight (on the machines that answered). 1 needs you.');
  });

  it('a future-dated plan time counts as no time (undated, grouped like the console groups an undated plan)', () => {
    const r = summarizePlans(ok([{ id: 'f', title: 'Forged', status: 'active', lastTouchedAt: new Date(NOW + FUTURE_SKEW_MS + 60_000).toISOString() }]), [], cov) as any;
    expect(r.sections.inFlight.map((p: any) => [p.title, p.touchedAt])).toEqual([['Forged', null]]);
  });

  it('the same id with a different title on another machine is a different plan; children resolve on their own machine', () => {
    const r = summarizePlans(ok([
      { id: 'plan', title: 'Here plan', status: 'active', lastTouchedAt: H(2) },
      { id: 'proj', kind: 'project', title: 'Here project', status: 'active', firstLaunchAckAt: 'x', rounds: [{ status: 'in-progress', itemIds: ['kid'] }], lastTouchedAt: H(3) },
    ]), [{ machineId: 'm_peer', state: 'ok', items: [
      { id: 'plan', title: 'Other plan', status: 'active', lastTouchedAt: H(1) },
      { id: 'kid', title: 'Peer child', status: 'active', parentProjectId: 'proj', pipelineStage: 'merged', lastTouchedAt: H(1) },
    ] }], cov) as any;
    const titles = r.sections.inFlight.map((p: any) => p.title);
    expect(titles).toEqual(expect.arrayContaining(['Here plan', 'Other plan', 'Peer child', 'Here project']));
    expect(r.sections.inFlight.find((p: any) => p.title === 'Here project').line).toBe('round 1 of 1 · 0 of 1 piece merged · running');
    expect(new Set(r.sections.inFlight.map((p: any) => p.key)).size).toBe(4);
    expect(titles).toHaveLength(4);
  });

  it('off here and nowhere else answered: off; unreadable here: says it cannot read', () => {
    expect(summarizePlans({ state: 'off' }, [], cov)).toMatchObject({ enabled: false, headline: 'Plan tracking is off on this agent.' });
    expect(summarizePlans({ state: 'unavailable' }, [], cov)).toMatchObject({ enabled: true, selfState: 'unavailable', headline: 'Can’t read plans right now.' });
    const peerOnly = summarizePlans({ state: 'unavailable' }, [{ machineId: 'm_peer', state: 'ok', items: [{ id: 'q', title: 'Peer plan', status: 'active', lastTouchedAt: H(1) }] }], cov) as any;
    expect(peerOnly.selfState).toBe('unavailable');
    expect(peerOnly.headline).toBe('1 plan in flight (on the machines that answered).');
  });

  it('caps: finished keeps its newest 20; the overall cap marks truncated', () => {
    const finished = Array.from({ length: MAX_FINISHED + 5 }, (_, i) => ({ id: `f${i}`, title: `Done ${i}`, status: 'completed', lastTouchedAt: H(i + 1) }));
    const r = summarizePlans(ok(finished), [], cov) as any;
    expect(r.sections.finished).toHaveLength(MAX_FINISHED);
    expect(r.sections.finished[0].title).toBe('Done 0');
    expect(r.counts.finished).toBe(MAX_FINISHED + 5);
    expect(r.truncated).toBe(true);
    const many = Array.from({ length: MAX_PLANS + 3 }, (_, i) => ({ id: `a${i}`, title: `Plan ${i}`, status: 'active', lastTouchedAt: H(1) }));
    const big = summarizePlans(ok(many), [], cov) as any;
    expect(big.sections.inFlight).toHaveLength(MAX_PLANS);
    expect(big.truncated).toBe(true);
  });

  it('titles: an id-shaped title reads as unavailable; control and bidi characters are removed; secrets scrubbed', () => {
    const r = summarizePlans(ok([
      { id: 'abc', title: 'abc', status: 'active', lastTouchedAt: H(1) },
      { id: 'def', kind: 'project', title: 'Sneaky‮txt.exe ghp_' + 'A'.repeat(36), status: 'active', firstLaunchAckAt: 'x', rounds: [], lastTouchedAt: H(2) },
    ]), [], cov) as any;
    expect(r.sections.inFlight[0].title).toBe('Initiative name unavailable');
    expect(r.sections.inFlight[1].title).not.toContain('‮');
    expect(r.sections.inFlight[1].title).not.toContain('AAAAAAAA');
    expect(cleanText('a\u0007b', 10)).toBe('ab');
  });
});

describe('learned', () => {
  it('parses the session-context block, with and without the confidence suffix, in its own order', () => {
    const r = summarizePreferences({ ok: true, data: { present: true, count: 4, block: '<x>\n- Lead with the answer (confidence 0.85, seen 3×)\n- Fairly (confidence 0.5, seen 1×)\n- A bare line\nnot a pref' } }) as any;
    expect(r.items.map((i: any) => [i.text, i.sureWords, i.seenWords])).toEqual([['Lead with the answer', 'sure', 'seen 3 times'], ['Fairly', 'fairly sure', 'seen once'], ['A bare line', null, 'seen once']]);
    expect(r).toMatchObject({ state: 'ok', total: 4, notLoaded: 1 });
    expect(summarizePreferences({ ok: true, data: { present: false, block: '' } })).toMatchObject({ state: 'ok', items: [], total: 0 });
    expect(summarizePreferences({ ok: false, off: true })).toMatchObject({ state: 'off' });
    expect(summarizePreferences({ ok: false, off: false })).toMatchObject({ state: 'unavailable' });
    expect(summarizePreferences({ ok: true, data: {} })).toMatchObject({ state: 'unavailable' });
  });

  it('corrections: watching vs earlier (noise never watching), merged by id, newest first, no ids or topic ids', () => {
    const own = { ok: true as const, data: { records: [
      { id: 'c1', kind: 'user-preference', status: 'open', occurrenceCount: 1, scrubbedSummary: 'Plainer words', detectedAt: H(5), topicId: 555123, dedupeKey: 'dk' },
      { id: 'c2', kind: 'noise', status: 'open', scrubbedSummary: '', detectedAt: H(4) },
      { id: 'c3', kind: 'infra-gap', status: 'verified', scrubbedSummary: 'Retry the relay', detectedAt: H(9), updatedAt: H(2) },
    ], totalRecords: 3 } };
    const peers: PeerList[] = [{ machineId: 'm_peer', state: 'ok', items: [{ id: 'c1', kind: 'user-preference', status: 'reopened', scrubbedSummary: 'Plainer words', detectedAt: H(5), updatedAt: H(1) }] }, { machineId: 'm_x', state: 'off' }];
    const r = summarizeCorrections(own, peers, cov) as any;
    expect(r.watching.map((c: any) => [c.summary, c.reopened, c.machine])).toEqual([['Plainer words', true, 'Mac Mini']]);
    expect(r.earlier.map((c: any) => [c.summary, c.statusWords])).toEqual([['Retry the relay', 'Saved and sticking'], ['No clear lesson', 'Seen once — waiting to see if it comes back']]);
    expect(r.unread.count).toBe(0);
    expect(r.truncated).toBe(false);
    const text = JSON.stringify(r);
    for (const leak of ['"c1"', '555123', 'dk']) expect(text).not.toContain(leak);
  });

  it('a full page from any machine marks truncated; local off with no peers is off; unknown status never reads saved', () => {
    const full = Array.from({ length: MAX_CORRECTIONS }, (_, i) => ({ id: `r${i}`, kind: 'user-preference', status: 'weird', detectedAt: H(i + 1) }));
    const r = summarizeCorrections({ ok: true, data: { records: full } }, [], cov) as any;
    expect(r.truncated).toBe(true);
    expect(r.earlier[0].statusWords).toBe('Status not recorded');
    expect(summarizeCorrections({ ok: false, off: true }, [], cov)).toMatchObject({ state: 'off' });
    expect(summarizeCorrections({ ok: false, off: true }, [], { ...cov, offlineMachineIds: ['m_far'] })).toMatchObject({ state: 'unavailable', offline: { count: 1, names: ['Laptop'] } });
    expect(summarizeCorrections({ ok: false, off: true }, [{ machineId: 'm_peer', state: 'ok', items: [] }], cov)).toMatchObject({ state: 'ok', selfState: 'off', watching: [], earlier: [] });
    expect(summarizeCorrections({ ok: false, off: true }, [{ machineId: 'm_peer', state: 'unreached' }], cov)).toMatchObject({ state: 'unavailable', unread: { count: 1, names: ['Mac Mini'] } });
  });

  it('the headline says nothing is learned yet, or how many things', () => {
    const none = summarizeLearned({ ok: true, data: { present: false, block: '' } }, { ok: false, off: true }, [], cov) as any;
    expect(none.headline).toBe('Nothing yet — correct me the same way twice and it shows up here.');
    expect(summarizeLearned({ ok: false, off: true }, { ok: false, off: true }, [], cov)).toMatchObject({ headline: 'Learning from corrections is off on this agent.' });
  });
});

describe('agents', () => {
  const FP = 'abcdef0123456789';
  const FP2 = '0123456789abcdef';
  const okRows = (rows: unknown[]) => ({ state: 'ok' as const, rows, failedMachineIds: [] });

  it('health words for each kind, from timestamps and flags only', () => {
    expect(healthWords({ dark: true, darkSince: H(6), queuedCount: 2 }, NOW)).toMatchObject({ kind: 'dark', words: 'Nothing back for 6 h', tone: 'bad' });
    expect(healthWords({ stale: true, pendingCount: 1 }, NOW)).toMatchObject({ kind: 'stale', tone: 'attn' });
    expect(healthWords({ lastRelayStatus: 'queued' }, NOW).kind).toBe('queued');
    expect(healthWords({ lastRelayStatus: 'unconfirmed' }, NOW)).toMatchObject({ kind: 'unconfirmed', tone: 'unknown' });
    expect(healthWords({ lastRelayStatus: 'rejected' }, NOW).kind).toBe('rejected');
    expect(healthWords({ lastInboundAt: H(2) }, NOW)).toMatchObject({ kind: 'answered', words: 'Answered 2 h ago', tone: 'ok', lastHeardAt: H(2) });
    expect(healthWords({ lastSentAt: H(1), pendingCount: 1 }, NOW)).toMatchObject({ kind: 'sent', tone: 'attn' });
    expect(healthWords({}, NOW)).toMatchObject({ kind: 'quiet', words: 'No messages exchanged yet' });
    expect(healthWords({ lastInboundAt: H(1), connectedNowReason: 'relay-down' }, NOW).detail).toContain('my own relay connection is down');
  });

  it('one row per agent across machines: strongest pairing, freshest delivery; bad first; no fingerprints', () => {
    const r = summarizeAgents(
      okRows([{ peerFp: FP, peerName: 'Dawn', state: 'invite-accepted' }, { peerFp: FP.toUpperCase(), peerName: 'Dawn', state: 'mutual-verified' }, { peerFp: FP2, peerName: 'Luna', state: 'verification-failed' }, { peerFp: 'not-a-fp', peerName: 'Ghost', state: 'mutual-verified' }]),
      okRows([{ peerFp: FP, lastInboundAt: H(30) }, { peerFp: FP, lastInboundAt: H(1) }, { peerFp: FP2, dark: true, darkSince: H(8) }]),
      { channels: [] }, cov) as any;
    expect(r.agents.map((a: any) => [a.name, a.trust, a.health])).toEqual([['Luna', 'blocked', 'dark'], ['Dawn', 'paired', 'answered']]);
    expect(r.agents[1].healthWords).toBe('Answered 1 h ago');
    expect(r.headline).toBe('Luna hasn’t answered for 8 h.');
    expect(JSON.stringify(r)).not.toContain(FP);
    expect(JSON.stringify(r).toLowerCase()).not.toContain(FP2.toLowerCase());
  });

  it('pairing merge: blocked anywhere shows blocked; paired here beats paired elsewhere and unfinished', () => {
    const rows = (states: string[]) => okRows(states.map((state) => ({ peerFp: FP, peerName: 'Dawn', state })));
    const t = (states: string[]) => (summarizeAgents(rows(states), okRows([]), { channels: [] }, cov) as any).agents[0].trust;
    expect(t(['mutual-verified', 'verification-failed'])).toBe('blocked');
    expect(t(['identity-verified', 'mutual-verified'])).toBe('paired');
    expect(t(['invite-accepted', 'identity-verified'])).toBe('paired-elsewhere');
    expect(t(['pending-verification', 'invite-accepted'])).toBe('unfinished');
    expect(t(['something-new'])).toBe('other');
    // A mutual pairing that only another machine holds is "paired elsewhere" here.
    const remoteOnly = (summarizeAgents(okRows([{ peerFp: FP, peerName: 'Dawn', state: 'mutual-verified', remote: true }]), okRows([]), { channels: [] }, cov) as any).agents[0];
    expect([remoteOnly.trust, remoteOnly.trustWords]).toEqual(['paired-elsewhere', 'Paired (on another of my machines)']);
    expect(t(['mutual-verified'])).toBe('paired');
  });

  it('no delivery record: "no record yet" when delivery answered, "can’t tell" when it did not; a fingerprint-shaped name is refused', () => {
    const answered = summarizeAgents(okRows([{ peerFp: FP, peerName: FP.slice(0, 8), state: 'mutual-verified' }]), okRows([]), { channels: [] }, cov) as any;
    expect(answered.agents[0]).toMatchObject({ name: 'Unnamed agent', healthWords: 'No delivery record yet', tone: 'ok' });
    const unknown = summarizeAgents(okRows([{ peerFp: FP, peerName: 'Dawn', state: 'mutual-verified' }]), { state: 'unavailable' }, { channels: [] }, cov) as any;
    expect(unknown.agents[0]).toMatchObject({ healthWords: 'Can’t tell if it’s reachable', tone: 'unknown' });
    expect(unknown.headline).toBe('1 agent; can’t tell whether it is reachable.');
    expect(unknown.delivery).toEqual({ state: 'unavailable', reason: 'Couldn’t read delivery tracking just now.' });
    const none = summarizeAgents({ state: 'off' }, { state: 'off' }, { channels: [] }, cov) as any;
    expect(none.headline).toBe('Can’t tell which agents I work with.');
  });

  it('names the public recovery channel without exposing its operational evidence or credentials',()=>{
    const result=summarizeChannels({channels:[{id:'server-down-recovery',audience:'peer',state:'unknown',direction:'none',detail:'private host 10.42.7.3',purpose:'owner-device-secret',cost:'relay-credential-secret'}]}) as any;
    expect(result.channels).toEqual([{key:'server-down-recovery',name:'Machine recovery',audience:'agents',state:'unknown',stateWords:'Can’t tell',directionWords:'carries nothing',tone:'unknown'}]);
    expect(result.channelSummary.working).toBe(0);
    for(const secret of ['10.42.7.3','owner-device-secret','relay-credential-secret'])expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('channels: fixed names and verdict words, never the registry evidence text; unknown is never working', () => {
    const r = summarizeChannels({ channels: [
      { id: 'mutual-ssh', audience: 'peer', state: 'not-configured', direction: 'none', detail: 'ssh to 10.0.0.5 failed', purpose: 'x' },
      { id: 'user-slack', audience: 'user', state: 'mystery', direction: 'bidirectional', detail: 'xoxb-secret' },
      { id: 'brand-new', audience: 'peer', state: 'unknown', direction: 'none', detail: 'probe exceeded' },
    ], summary: { total: 3, working: 0, unusable: 1, unknown: 2 } }) as any;
    expect(r.channels.map((c: any) => [c.name, c.state, c.stateWords])).toEqual([['Machine-to-machine SSH', 'not-configured', 'Not set up here'], ['Slack', 'unknown', 'Can’t tell'], ['Another channel', 'unknown', 'Can’t tell']]);
    expect(r.channels[2].key).not.toBe('brand-new');
    expect(r.channelSummary).toEqual({ total: 3, working: 0, unusable: 1, unknown: 2 });
    const text = JSON.stringify(r);
    for (const leak of ['10.0.0.5', 'xoxb', 'probe exceeded']) expect(text).not.toContain(leak);
    expect(summarizeChannels({ channels: [], error: 'boom' })).toMatchObject({ channelsState: 'unavailable' });
  });

  it('a broken relay leads the headline', () => {
    const r = summarizeAgents(okRows([]), okRows([]), { channels: [{ id: 'threadline-relay', state: 'broken', direction: 'none' }] }, cov) as any;
    expect(r.headline).toBe('I’m not connected to the agent network right now.');
  });
});

describe('allowlist', () => {
  it('admits exactly GET on the three paths, owner only, one own bucket; the raw routes stay off', () => {
    for (const p of ['/mobile/plans', '/mobile/learned', '/mobile/agents']) {
      const rules = DEVICE_ALLOWLIST.filter((r) => r.re.test(p));
      expect(rules, p).toHaveLength(1);
      expect(rules[0]).toMatchObject({ method: 'GET', body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'plans-people-reads' });
    }
    for (const p of ['/mobile/plans/x', '/mobile/learnedx', '/initiatives', '/projects', '/preferences/session-context', '/corrections', '/channels', '/threadline/pairing', '/threadline/peers/health']) {
      expect(DEVICE_ALLOWLIST.some((r) => r.re.test(p)), p).toBe(false);
    }
  });
});
