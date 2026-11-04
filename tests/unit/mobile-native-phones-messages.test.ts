/**
 * Pure summarizers for the phone's native Messages to you and Insights reads
 * (docs/specs/mobile-native-phones-messages.md), both sides of each rule, plus the allowlist entries,
 * the insight engine's cachedOnly read and the origin runtime's summary inputs.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  summarizeMessages, summarizeLocalMessages, summarizeInsights, holdWords, heldHeadline, forwardsHeadline, sourceWords,
  MAX_HELD_GROUPS, MAX_INSIGHT_PAGES, MAX_INSIGHT_LINES, MAX_NOT_READY, FOOTER_LINE, type PeerMessages, type PeerInsights,
} from '../../src/server/mobilePhonesMessagesRoutes.js';
import { DEVICE_ALLOWLIST } from '../../src/server/mobilePairingRoutes.js';
import { DashboardInsightEngine } from '../../src/monitoring/DashboardInsightEngine.js';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const H = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const names: Record<string, string> = { m_peer: 'Mac Mini', m_far: 'Laptop' };
const topics: Record<string, string> = { '134088': 'Instar app' };
const opts = { now: NOW, topicName: (id: string) => topics[id] ?? null, nicknameOf: (id: string) => names[id] ?? null };
const FAKE_KEY = 'ghp_' + 'Q'.repeat(36);

const held = (over: Record<string, unknown>) => ({ operationId: 'op-' + Math.random().toString(36).slice(2), hold_reason: 'lease-not-held', since: H(2), producerKind: 'session', holder: 'm_secret', deadlineAt: H(-1), ...over });
const status = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ state: 'ok' as const, data: { held: rows, heldForward: { expiredUnreported: 0 }, expiredHolds: { totalSinceBoot: 0 }, activation: { complete: true, observations: [] }, metrics: { counts: {} }, ...extra } });

describe('messages: this machine', () => {
  it('groups named conversations apart and unnamed ones by cause, largest first, with the console headline', () => {
    const r = summarizeLocalMessages(status([
      held({ topicId: '134088', since: H(3) }),
      held({ topicId: '134088', since: H(1) }),
      held({ topicId: '999', producerKind: 'server-automation', hold_reason: 'capacity-unavailable' }),
      held({ hold_reason: 'transport-acceptance-unknown', producerKind: 'server-automation' }),
      held({ hold_reason: 'transport-acceptance-unknown', producerKind: 'session' }),
    ]), opts) as any;
    expect(r.state).toBe('ok');
    expect(r.heldCount).toBe(5);
    expect(r.headline).toBe('3 replies and 2 automatic messages are held on this machine.');
    expect(r.sub).toBe('I need to restore delivery. This is not a task for you. The oldest has waited 3 h.');
    expect(r.groups.map((g: any) => [g.title, g.count, g.reasonWords])).toEqual([
      ['2 delayed messages', 2, 'Telegram did not confirm it arrived'],
      ['Instar app', 2, 'waiting to be routed through the machine that holds the conversation'],
      ['Conversation name unavailable', 1, 'waiting for room to send'],
    ]);
    const instar = r.groups.find((g: any) => g.title === 'Instar app');
    expect(instar.oldestAt).toBe(H(3));
    const text = JSON.stringify(r);
    for (const leak of ['op-', '134088', '999', 'm_secret', 'operationId', 'holder']) expect(text, leak).not.toContain(leak);
  });

  it('the reply/automatic split falls back to a plain count when a producer kind is unknown', () => {
    expect(heldHeadline(2, 0, 0, 2)).toBe('2 messages are held on this machine.');
    expect(heldHeadline(1, 1, 0, 0)).toBe('1 reply is held on this machine.');
    expect(heldHeadline(0)).toBe('No messages are held.');
    expect(heldHeadline(undefined)).toBe("Can't tell how many messages are held.");
  });

  it('hold reasons come only from the fixed words', () => {
    expect(holdWords('capacity-unavailable')).toBe('waiting for room to send');
    expect(holdWords(`weird-${FAKE_KEY}`)).toBe('held for another reason');
    expect(holdWords(undefined)).toBe('held for an unstated reason');
  });

  it('expired, unconfirmed and readiness lines appear only when their counters say so', () => {
    const quiet = summarizeLocalMessages(status([]), opts) as any;
    expect(quiet).toMatchObject({ headline: 'Messages to you', sub: '', tone: 'ok', expired: 0, unconfirmedLine: null, recording: 'on', notReady: [] });
    const r = summarizeLocalMessages(status([], {
      heldForward: { expiredUnreported: 1 }, expiredHolds: { totalSinceBoot: 2 },
      metrics: { counts: { 'attempt:accepted': 1200, 'attempt:outcome-unknown': 3 } },
      activation: { complete: false, observations: [
        { obligation: 'browser-profiles', subject: 'coverage', state: 'unknown', reason: 'enrollment-observation-missing' },
        { obligation: 'storage-readers', subject: 'store', state: 'ready', reason: '' },
        { obligation: 'bot-writers', subject: `bot ${FAKE_KEY} account 7812716706`, state: 'held', reason: 'not-bound to chat -100777' },
        { obligation: 'made-up', subject: 's', state: 'unknown', reason: 'x' },
      ] },
    }), opts) as any;
    expect(r.headline).toBe('3 messages expired before delivery.');
    expect(r.tone).toBe('bad');
    expect(r.unconfirmedLine).toBe('Of 1,200 sends Telegram confirmed, 3 more ended without a confirmation either way.');
    expect(r.recording).toBe('not fully set up');
    // Fixed vocabulary only: obligation words, state, and a known reason; subjects and other reasons never cross.
    expect(r.notReady.map((n: any) => [n.title, n.detail, n.tone])).toEqual([
      ['browser profiles', "can't tell yet · not checked yet", 'unknown'], ['bot writers', 'held', 'attn'], ['Another recording check', "can't tell yet", 'unknown']]);
    for (const leak of ['ghp_QQQQ', '7812716706', '-100777', 'coverage', 'made-up']) expect(JSON.stringify(r), leak).not.toContain(leak);
  });

  it('caps the readiness list and says so', () => {
    const observations = Array.from({ length: MAX_NOT_READY + 2 }, (_, i) => ({ obligation: `o-${i}`, subject: 's', state: 'unknown', reason: 'r' }));
    const r = summarizeLocalMessages(status([], { activation: { complete: false, observations } }), opts) as any;
    expect(r.notReady).toHaveLength(MAX_NOT_READY);
    expect(r.truncated).toBe(true);
  });

  it('an unreadable status says what /health can tell, worded as forwards only, never "none held"', () => {
    const r = summarizeLocalMessages({ state: 'unavailable' }, { ...opts, heldForward: { count: 2 } }) as any;
    expect(r).toMatchObject({ state: 'unavailable', heldCount: null, tone: 'attn', groups: [] });
    expect(r.headline).toBe('2 replies are waiting to be passed to the machine that holds the conversation.');
    expect(forwardsHeadline(0)).toMatch(/^No replies are waiting to be passed on; other held messages can't be read/);
    expect((summarizeLocalMessages({ state: 'unavailable' }, opts) as any).headline).toBe("Can't tell how many messages are held.");
    expect((summarizeLocalMessages({ state: 'off' }, opts) as any)).toMatchObject({ state: 'off', sub: 'Message recording is not running on this machine.' });
    // A status that answers without its held list is unavailable, not "nothing held".
    expect((summarizeLocalMessages({ state: 'ok', data: { metrics: {} } }, opts) as any).state).toBe('unavailable');
  });

  it('refuses a placeholder or id as a conversation title', () => {
    const r = summarizeLocalMessages(status([held({ topicId: '42' })]), { ...opts, topicName: () => null }) as any;
    expect(r.groups[0].title).toBe('Conversation name unavailable');
  });
});

describe('messages: across machines', () => {
  const peerLocal = (rows: unknown[]) => ({ machineId: 'm_peer', state: 'ok' as const, data: summarizeLocalMessages(status(rows), opts) });

  it('adds each peer\'s groups with its machine and lists every machine with its own state', () => {
    const peers: PeerMessages[] = [peerLocal([held({ topicId: '134088' }), held({ topicId: '134088' }), held({ topicId: '134088' })]), { machineId: 'm_far', state: 'unreached' }];
    const r = summarizeMessages(status([held({ topicId: '134088' })]), peers, opts) as any;
    expect(r.groups.map((g: any) => [g.title, g.count, g.machine])).toEqual([['Instar app', 3, 'Mac Mini'], ['Instar app', 1, null]]);
    expect(new Set(r.groups.map((g: any) => g.key)).size).toBe(2);
    expect(r.machines).toEqual([{ name: 'This machine', count: 1, complete: true, state: 'ok' }, { name: 'Mac Mini', count: 3, complete: true, state: 'ok' }]);
    expect(r.unread).toEqual({ count: 1, names: ['Laptop'] });
    expect(r.headline).toBe('1 reply is held on this machine; 3 more on other machines. Machines that did not answer or can\'t tell are not counted.');
    expect(r.footerLine).toBe(FOOTER_LINE);
    for (const leak of ['m_peer', 'm_far']) expect(JSON.stringify(r)).not.toContain(leak);
  });

  it('a peer that answered unavailable is listed as such, never as zero held; a malformed peer body is unread', () => {
    const r = summarizeMessages(status([]), [
      { machineId: 'm_peer', state: 'ok', data: summarizeLocalMessages({ state: 'unavailable' }, opts) },
      { machineId: 'm_far', state: 'ok', data: { hello: 'world' } },
    ], opts) as any;
    expect(r.machines[1]).toEqual({ name: 'Mac Mini', count: null, complete: true, state: 'unavailable' });
    expect(r.unread.names).toEqual(['Laptop']);
    expect(r.headline).toBe('Messages to you. Machines that did not answer or can\'t tell are not counted.');
  });

  it('peers holding while this machine holds none: the headline says so; peer text is re-cleaned', () => {
    const data = summarizeLocalMessages(status([held({ topicId: '134088' })]), opts) as any;
    data.groups[0].title = `Evil ‮title ${FAKE_KEY}`;
    data.groups[0].reasonWords = 'injected reason text';
    const r = summarizeMessages(status([]), [{ machineId: 'm_peer', state: 'ok', data }], opts) as any;
    expect(r.headline).toBe('1 message is held on other machines.');
    expect(r.tone).toBe('attn');
    expect(r.groups[0].title).not.toContain('‮');
    expect(r.groups[0].reasonWords).toBe('held for another reason');
    expect(JSON.stringify(r)).not.toContain('ghp_QQQQ');
  });

  it('a truncated peer marks the merged answer truncated; the same cause on two machines is two rows', () => {
    const rows = [held({ hold_reason: 'capacity-unavailable', topicId: undefined })];
    const data = { ...(summarizeLocalMessages(status(rows), opts) as any), truncated: true };
    const other = { ...(summarizeLocalMessages(status(rows), opts) as any) };
    const r = summarizeMessages(status(rows), [{ machineId: 'm_peer', state: 'ok', data }, { machineId: 'm_far', state: 'ok', data: other }], opts) as any;
    expect(r.groups).toHaveLength(3);
    expect(new Set(r.groups.map((g: any) => g.key)).size).toBe(3);
    expect(r.truncated).toBe(true);
    const ins = (t: boolean): PeerInsights => ({ machineId: 'm_peer', state: 'ok', data: { selfState: 'ok', truncated: t, pages: [{ key: 'k', title: 'T', headline: 'H', sourceWords: 'Plain summary', lines: [], metrics: [] }] } });
    expect((summarizeInsights({ state: 'off' }, [ins(true)], opts) as any).truncated).toBe(true);
    expect((summarizeInsights({ state: 'off' }, [ins(false)], opts) as any).truncated).toBe(false);
  });

  it('a held read that filled its page is a lower bound and marks the answer truncated', () => {
    const rows = Array.from({ length: 200 }, () => held({ topicId: '134088' }));
    const r = summarizeLocalMessages({ state: 'ok', data: { ...status(rows).data, heldComplete: false } }, opts) as any;
    expect(r.headline).toBe('At least 200 messages are held on this machine (more may not be listed).');
    expect(r.groups).toHaveLength(1);
    expect(r.truncated).toBe(true);
    expect(r.heldComplete).toBe(false);
    const empty = summarizeLocalMessages({ state: 'ok', data: { ...status([]).data, heldComplete: false } }, opts) as any;
    expect(empty.headline).toMatch(/^Some held messages may not be listed/);
  });

  it('a peer whose held read filled its page is shown as at least its count', () => {
    const rows = Array.from({ length: 200 }, () => held({ topicId: '134088' }));
    const data = summarizeLocalMessages({ state: 'ok', data: { ...status(rows).data, heldComplete: false } }, opts);
    const r = summarizeMessages(status([]), [{ machineId: 'm_peer', state: 'ok', data }], opts) as any;
    expect(r.headline).toBe('At least 200 messages are held on other machines.');
    expect(r.machines[1]).toEqual({ name: 'Mac Mini', count: 200, complete: false, state: 'ok' });
    const both = summarizeMessages(status([held({ topicId: '134088' })]), [{ machineId: 'm_peer', state: 'ok', data }], opts) as any;
    expect(both.headline).toBe('1 reply is held on this machine; at least 200 more on other machines.');
  });

  it('a local read that failed keeps both facts: the local forwards and the peers\' held count', () => {
    const peer = { machineId: 'm_peer', state: 'ok' as const, data: summarizeLocalMessages(status(Array.from({ length: 12 }, () => held({ topicId: '134088' }))), opts) };
    const r = summarizeMessages({ state: 'unavailable' }, [peer], { ...opts, heldForward: { count: 2 } }) as any;
    expect(r.headline).toBe("2 replies are waiting to be passed to the machine that holds the conversation; 12 are held on other machines. Machines that did not answer or can't tell are not counted.");
    const off = summarizeMessages({ state: 'off' }, [peer], opts) as any;
    expect(off.headline).toBe("Can't tell how many messages are held; 12 are held on other machines. Machines that did not answer or can't tell are not counted.");
  });

  it('an unknown peer count qualifies a healthy local headline', () => {
    const r = summarizeMessages(status([held({ topicId: '134088' })]), [{ machineId: 'm_peer', state: 'ok', data: summarizeLocalMessages({ state: 'unavailable' }, opts) }], opts) as any;
    expect(r.headline).toBe("1 reply is held on this machine. Machines that did not answer or can't tell are not counted.");
  });

  it('caps groups across machines', () => {
    const rows = Array.from({ length: MAX_HELD_GROUPS + 5 }, (_, i) => held({ topicId: String(1000 + i) }));
    const r = summarizeMessages(status(rows), [], opts) as any;
    expect(r.groups).toHaveLength(MAX_HELD_GROUPS);
    expect(r.truncated).toBe(true);
  });
});

describe('insights', () => {
  const page = (over: Record<string, unknown> = {}) => ({ page: 'jobs', title: 'Schedule', tab: 'jobs', headline: 'Two jobs ran late.', source: 'deterministic', cacheHit: false, asOf: H(1), stale: false,
    lines: [{ text: 'reflection-trigger ran 2 h late', severity: 'watch', action: 'Open Schedule' }, { text: 'odd', severity: 'nonsense' }],
    metrics: [{ label: 'Jobs', value: 12, trend: 'up' }, { label: 'Late', value: '2', trend: 'sideways' }], ...over });

  it('trims each page: no tab or page id; severity and trend clamped; source in words', () => {
    const r = summarizeInsights({ state: 'ok', data: { pages: [page()] } }, [], opts) as any;
    expect(r).toMatchObject({ state: 'ok', selfState: 'ok', headline: '1 page has something to say.', truncated: false });
    const p = r.pages[0];
    expect(p).toMatchObject({ title: 'Schedule', headline: 'Two jobs ran late.', sourceWords: 'Plain summary', stale: false, machine: null, asOf: H(1) });
    expect(p.lines).toEqual([{ text: 'reflection-trigger ran 2 h late', severity: 'watch', action: 'Open Schedule' }, { text: 'odd', severity: 'info', action: null }]);
    expect(p.metrics).toEqual([{ label: 'Jobs', value: '12', trend: 'up' }, { label: 'Late', value: '2', trend: null }]);
    expect(Object.keys(p)).not.toContain('tab');
    expect(JSON.stringify(r)).not.toContain('"jobs"');
  });

  it('source words', () => {
    expect(sourceWords('llm', true)).toBe('AI summary, saved');
    expect(sourceWords('llm', false)).toBe('AI summary');
    expect(sourceWords('paused', false)).toMatch(/^Paused/);
    expect(sourceWords('empty', false)).toBe('No data yet');
    expect(sourceWords('mystery', false)).toBe('Summary');
  });

  it('state table: off only when every source is known off; partial answers keep their pages and say so', () => {
    const peerOk = (pages: unknown[]): PeerInsights => ({ machineId: 'm_peer', state: 'ok', data: summarizeInsights({ state: 'ok', data: { pages } }, [], opts) });
    const peerOff: PeerInsights = { machineId: 'm_peer', state: 'ok', data: summarizeInsights({ state: 'off' }, [], opts) };
    expect((summarizeInsights({ state: 'off' }, [], opts) as any)).toMatchObject({ state: 'off', headline: 'Insights are not turned on for this agent.' });
    expect((summarizeInsights({ state: 'off' }, [peerOff], opts) as any).state).toBe('off');
    expect((summarizeInsights({ state: 'off' }, [{ machineId: 'm_peer', state: 'unreached' }], opts) as any)).toMatchObject({ state: 'unavailable', unread: { count: 1, names: ['Mac Mini'] } });
    expect((summarizeInsights({ state: 'off' }, [], { ...opts, offlineMachineIds: ['m_far'] }) as any).state).toBe('unavailable');
    const mixed = summarizeInsights({ state: 'unavailable' }, [peerOk([page({ title: `Peer ${FAKE_KEY}` })])], opts) as any;
    expect(mixed.state).toBe('ok');
    expect(mixed.headline).toBe('1 page has something to say (on the machines that answered).');
    expect(mixed.pages[0].machine).toBe('Mac Mini');
    expect(JSON.stringify(mixed)).not.toContain('ghp_QQQQ');
    expect(JSON.stringify(mixed)).not.toContain('m_peer');
    const none = summarizeInsights({ state: 'ok', data: { pages: [] } }, [{ machineId: 'm_far', state: 'unreached' }], opts) as any;
    expect(none.headline).toBe('No pages have insights to show yet (on the machines that answered).');
  });

  it('caps pages and lines', () => {
    const pages = Array.from({ length: MAX_INSIGHT_PAGES + 3 }, (_, i) => page({ page: `p${i}`, lines: Array.from({ length: 9 }, (_, j) => ({ text: `l${j}`, severity: 'info' })) }));
    const r = summarizeInsights({ state: 'ok', data: { pages } }, [], opts) as any;
    expect(r.pages).toHaveLength(MAX_INSIGHT_PAGES);
    expect(r.truncated).toBe(true);
    expect(r.pages[0].lines).toHaveLength(MAX_INSIGHT_LINES);
  });
});

describe('insight engine cachedOnly: a phone read never starts a model call', () => {
  const make = () => {
    const evaluate = vi.fn(async () => JSON.stringify({ headline: 'AI says jobs are late.', lines: [{ text: 'late', severity: 'watch' }] }));
    const engine = new DashboardInsightEngine({
      pages: [{ id: 'jobs', title: 'Schedule', tab: 'jobs', collect: () => ({ facts: ['2 late'], metrics: [{ label: 'Late', value: '2' }], anomalies: [{ text: '2 jobs late', severity: 'watch' }], updatedAt: NOW }) }],
      intelligence: { evaluate } as never, enabled: true, dryRun: false,
    } as never);
    return { engine, evaluate };
  };
  it('without a cached summary it serves the plain floor and calls nothing', async () => {
    const { engine, evaluate } = make();
    const r = await engine.getAll({ cachedOnly: true });
    expect(r.pages[0].source).toBe('deterministic');
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('after the console generated one, the same summary is served from the cache', async () => {
    const { engine, evaluate } = make();
    const first = await engine.getAll();
    const calls = evaluate.mock.calls.length;
    const r = await engine.getAll({ cachedOnly: true });
    expect(evaluate.mock.calls.length).toBe(calls);
    expect(r.pages[0].source).toBe(first.pages[0].source);
    if (first.pages[0].source === 'llm') expect(r.pages[0].cacheHit).toBe(true);
  });
});

describe('allowlist', () => {
  it('GET only, owner only, own bucket; the raw origin and insight routes stay off', () => {
    for (const p of ['/mobile/messages', '/mobile/insights']) {
      const rule = DEVICE_ALLOWLIST.find((x) => x.method === 'GET' && x.re.test(p));
      expect(rule, p).toBeDefined();
      expect([...rule!.statuses]).toEqual(['active']);
      expect(rule).toMatchObject({ body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'phones-messages-reads' });
      expect(rule!.unassignedOk).toBeUndefined();
      expect(DEVICE_ALLOWLIST.some((x) => x.method !== 'GET' && x.re.test(p))).toBe(false);
    }
    for (const p of ['/telegram/origins', '/telegram/origins/status', '/telegram/origin-display', '/insights', '/insights/jobs', '/insights/status']) {
      expect(DEVICE_ALLOWLIST.some((x) => x.re.test(p)), p).toBe(false);
    }
  });
});
