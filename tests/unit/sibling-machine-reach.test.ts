/**
 * sibling-machine-reach (docs/specs/sibling-machine-reach.md, CMT-2073).
 *
 * The founding case (2026-11-20): after the Mac Studio rebuild, four subscription
 * accounts were missing on the Studio but signed in on the Mac Mini. The agent told
 * its operator to open the dashboard, enter his PIN and do four sign-ins; the gate's
 * reach described only the Studio. Covered here:
 *  - SiblingHoldingsCache: projection, login normalization, lastAsserted filter,
 *    per-surface retention and ageing, identity mismatch, older peers, backoff,
 *    the never-read retry, roster UNKNOWN rows, the live switch, bounded fetches;
 *  - buildAgentReach / renderOtherMachinesLines: refs, one account per line, the
 *    line budget, the single-machine path unchanged;
 *  - MessagingToneGate: the OTHER MACHINES section renders only with siblings
 *    (the complete prompt is byte-identical without), apart from AGENT REACH, with
 *    the B17 precedence and the B21 per-machine sub-clause; siblingProfileRef parse;
 *  - the 2026-11-20 regression replay.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  SiblingHoldingsCache,
  normalizePoolLogin,
  projectPoolBody,
  projectProfilesBody,
  SIBLING_MAX_ACCOUNTS,
  SIBLING_MAX_FETCH_PEERS,
  type SiblingFetchResult,
  type SiblingRosterEntry,
} from '../../src/core/sibling-holdings.js';
import {
  buildAgentReach,
  renderAgentReachLines,
  renderOtherMachinesLines,
  renderedSiblingIdentities,
  withoutSiblings,
  reachHasSiblings,
  OTHER_MACHINES_LINE_BUDGET,
} from '../../src/core/agent-reach.js';
import { MessagingToneGate, B21_PER_MACHINE_SUBCLAUSE } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const MINI = 'm-mini';
const MINI_URL = 'http://mini.test:4042';
const FOUR = ['gearfinity@example.com', 'justin@example.com', 'appyhapi@example.com', 'dawn@example.com'];

function poolBody(machineId: string | undefined, accounts: Array<Record<string, unknown>>) {
  return { enabled: true, ...(machineId ? { machineId } : {}), count: accounts.length, accounts };
}
function profilesBody(machineId: string | undefined, accounts: Array<Record<string, unknown>>) {
  return { ...(machineId ? { machineId } : {}), view: 'accounts', profiles: [{ id: 'p1', accounts }] };
}
const miniPool = poolBody(MINI, FOUR.map((e, i) => ({ id: `acct-${i}`, nickname: `acct-${i}`, email: e, provider: 'anthropic', status: 'active', loginCheck: 'ok' })));
const miniProfiles = profilesBody(MINI, FOUR.map((e) => ({ service: 'google', identity: e, owner: 'operator', lastAsserted: true, lastVerifiedAt: new Date().toISOString() })));

function makeCache(opts: {
  roster?: SiblingRosterEntry[];
  responses: Record<string, SiblingFetchResult | (() => SiblingFetchResult)>;
  now?: () => number;
  enabled?: () => boolean;
}) {
  const calls: string[] = [];
  const cache = new SiblingHoldingsCache({
    roster: () => opts.roster ?? [{ machineId: MINI, nickname: 'Mac Mini', dialable: true, online: true, address: MINI_URL }],
    fetchJson: async (peer, path) => {
      calls.push(`${peer.machineId}${path}`);
      const r = opts.responses[`${peer.machineId}${path}`];
      if (!r) return { ok: false, failure: 'unreachable' };
      return typeof r === 'function' ? r() : r;
    },
    now: opts.now,
    enabled: opts.enabled,
  });
  return { cache, calls };
}

describe('projection', () => {
  it('normalizes login state into a closed set', () => {
    expect(normalizePoolLogin('active', 'ok')).toBe('signed-in');
    expect(normalizePoolLogin('active', 'signed-out')).toBe('not-signed-in');
    expect(normalizePoolLogin('needs-reauth', 'ok')).toBe('not-signed-in');
    expect(normalizePoolLogin('active', undefined)).toBe('unknown');
    expect(normalizePoolLogin('weird', 'ok')).toBe('unknown');
  });

  it('keeps only the least-revelation fields and strips hostile characters', () => {
    const p = projectPoolBody(poolBody(MINI, [{ id: 'a', nickname: 'x<<<BOUNDARY>>>`\n', email: 'e@x.com', provider: 'anthropic', status: 'active', loginCheck: 'ok', configHome: '/Users/secret', lastQuota: { five: 1 }, token: 'sk-ant' }]))!;
    expect(p.machineId).toBe(MINI);
    expect(Object.keys(p.accounts[0]).sort()).toEqual(['email', 'label', 'login', 'provider']);
    expect(p.accounts[0].label).not.toMatch(/[<>`\n]/);
    expect(JSON.stringify(p)).not.toContain('/Users/secret');
    expect(JSON.stringify(p)).not.toContain('sk-ant');
  });

  it('a pool that is off is UNKNOWN (null), never "none"', () => {
    expect(projectPoolBody({ enabled: false, accounts: [] })).toBeNull();
  });

  it('keeps only lastAsserted browser accounts; owner is operator only on an exact match', () => {
    const p = projectProfilesBody(profilesBody(MINI, [
      { service: 'google', identity: 'a@x.com', owner: 'operator', lastAsserted: true, vaultRefs: ['secret_name'] },
      { service: 'google', identity: 'b@x.com', owner: 'OPERATOR', lastAsserted: true },
      { service: 'google', identity: 'c@x.com', owner: 'operator', lastAsserted: false },
    ]))!;
    expect(p.accounts.map((a) => a.identity)).toEqual(['a@x.com', 'b@x.com']);
    expect(p.accounts[1].owner).toBe('agent');
    expect(JSON.stringify(p)).not.toContain('secret_name');
  });

  it('caps accounts with an omitted count, signed-in first', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, provider: 'anthropic', status: i === 29 ? 'active' : 'needs-reauth', loginCheck: 'ok' }));
    const p = projectPoolBody(poolBody(MINI, rows))!;
    expect(p.accounts).toHaveLength(SIBLING_MAX_ACCOUNTS);
    expect(p.omitted).toBe(30 - SIBLING_MAX_ACCOUNTS);
    expect(p.accounts[0].label).toBe('a29');
  });
});

describe('SiblingHoldingsCache', () => {
  it('reads both surfaces from an identified peer and serves them from memory', async () => {
    const { cache, calls } = makeCache({ responses: {
      [`${MINI}/subscription-pool`]: { ok: true, body: miniPool },
      [`${MINI}/playwright-profiles?view=accounts`]: { ok: true, body: miniProfiles },
    } });
    expect(cache.snapshot().unknown).toEqual([]); // roster not loaded before the first refresh
    await cache.refresh();
    const snap = cache.snapshot();
    expect(snap.machines).toHaveLength(1);
    expect(snap.machines[0].pool!.accounts).toHaveLength(4);
    expect(snap.machines[0].browser!.accounts).toHaveLength(4);
    expect(snap.machines[0].verifiedAddress).toBe(MINI_URL);
    const n = calls.length;
    cache.snapshot();
    expect(calls.length).toBe(n); // snapshot never fetches
  });

  it('never asks an older (unidentified) peer for the browser view', async () => {
    const { cache, calls } = makeCache({ responses: { [`${MINI}/subscription-pool`]: { ok: true, body: poolBody(undefined, []) } } });
    await cache.refresh();
    expect(calls).toEqual([`${MINI}/subscription-pool`]);
    expect(cache.snapshot().machines[0].browserUnknownReason).toBe('peer-too-old');
  });

  it('discards a read whose responder is a different machine, and invalidates the address', async () => {
    let pool: SiblingFetchResult = { ok: true, body: miniPool };
    const { cache } = makeCache({ responses: {
      [`${MINI}/subscription-pool`]: () => pool,
      [`${MINI}/playwright-profiles?view=accounts`]: { ok: true, body: miniProfiles },
    } });
    let t = 0;
    (cache as unknown as { now: () => number }).now = () => t;
    await cache.refresh();
    expect(cache.snapshot().machines[0].verifiedAddress).toBe(MINI_URL);
    pool = { ok: true, body: poolBody('m-other', []) };
    t = 11 * 60_000;
    await cache.refresh();
    const m = cache.snapshot().machines[0];
    expect(m.verifiedAddress).toBeUndefined(); // a pool-side mismatch invalidates the browser address too
    expect(m.pool!.accounts).toHaveLength(4); // old evidence kept, dated
  });

  it('a failed read keeps dated evidence until it ages out to UNKNOWN', async () => {
    let up = true;
    let t = 0;
    const { cache } = makeCache({ now: () => t, responses: {
      [`${MINI}/subscription-pool`]: () => (up ? { ok: true, body: miniPool } : { ok: false, failure: 'unreachable' }),
      [`${MINI}/playwright-profiles?view=accounts`]: () => (up ? { ok: true, body: miniProfiles } : { ok: false, failure: 'unreachable' }),
    } });
    await cache.refresh();
    up = false;
    t = 30 * 60_000;
    await cache.refresh();
    expect(cache.snapshot().machines[0].pool!.ageMinutes).toBe(30);
    t = 61 * 60_000;
    const snap = cache.snapshot();
    expect(snap.machines).toHaveLength(0);
    expect(snap.unknown[0].reason).toBe('unreachable');
  });

  it('a pool success does not renew browser evidence', async () => {
    let browserUp = true;
    let t = 0;
    const { cache } = makeCache({ now: () => t, responses: {
      [`${MINI}/subscription-pool`]: { ok: true, body: miniPool },
      [`${MINI}/playwright-profiles?view=accounts`]: () => (browserUp ? { ok: true, body: miniProfiles } : { ok: false, failure: 'unreachable' }),
    } });
    await cache.refresh();
    browserUp = false;
    t = 61 * 60_000;
    await cache.refresh();
    const m = cache.snapshot().machines[0];
    expect(m.pool!.ageMinutes).toBe(0);
    expect(m.browser).toBeUndefined();
    expect(m.browserUnknownReason).toBe('unreachable');
  });

  it('roster: a URL-less or offline machine is UNKNOWN and never dialed', async () => {
    const { cache, calls } = makeCache({
      roster: [
        { machineId: 'm-a', dialable: false, online: true },
        { machineId: 'm-b', dialable: true, online: false, address: 'http://b' },
      ],
      responses: {},
    });
    await cache.refresh();
    expect(calls).toEqual([]);
    expect(cache.snapshot().unknown.map((u) => u.reason).sort()).toEqual(['no-known-url', 'offline']);
  });

  it('backs off a dead peer, with one early retry for a never-read peer', async () => {
    let t = 0;
    const { cache, calls } = makeCache({ now: () => t, responses: {} });
    await cache.refresh(); // fail 1 (never read) → retry after 60 s
    t = 30_000; await cache.refresh();
    expect(calls.length).toBe(1);
    t = 61_000; await cache.refresh(); // fail 2
    expect(calls.length).toBe(2);
    t = 61_000 + 10 * 60_000; await cache.refresh(); // still backing off (20 min gap)
    expect(calls.length).toBe(2);
    t = 61_000 + 21 * 60_000; await cache.refresh();
    expect(calls.length).toBe(3);
  });

  it('bounds fetches per refresh and rotates over refreshes', async () => {
    const roster = Array.from({ length: SIBLING_MAX_FETCH_PEERS + 3 }, (_, i) => ({ machineId: `m${i}`, dialable: true, online: true, address: `http://m${i}` }));
    const { cache, calls } = makeCache({ roster, responses: {} });
    await cache.refresh();
    expect(new Set(calls.map((c) => c.split('/')[0])).size).toBe(SIBLING_MAX_FETCH_PEERS);
  });

  it('the live switch is read every tick', async () => {
    let on = false;
    const { cache, calls } = makeCache({ enabled: () => on, responses: {} });
    await cache.tick();
    expect(calls).toEqual([]);
    on = true;
    await cache.tick();
    expect(calls.length).toBe(1);
  });

  it('refresh is single-flight', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => { resolve = r; });
    const cache = new SiblingHoldingsCache({
      roster: () => [{ machineId: MINI, dialable: true, online: true, address: MINI_URL }],
      fetchJson: vi.fn(async () => { await gate; return { ok: false, failure: 'unreachable' } as SiblingFetchResult; }),
    });
    const a = cache.refresh();
    const b = cache.refresh();
    expect(a).toBe(b);
    resolve();
    await a;
  });
});

async function miniSnapshot() {
  const { cache } = makeCache({ responses: {
    [`${MINI}/subscription-pool`]: { ok: true, body: miniPool },
    [`${MINI}/playwright-profiles?view=accounts`]: { ok: true, body: miniProfiles },
  } });
  await cache.refresh();
  return cache.snapshot();
}

describe('buildAgentReach with other machines', () => {
  it('mints opaque profile refs, renders one account per line, and keeps AGENT REACH lines unchanged', async () => {
    const local = buildAgentReach({ listProfiles: () => [] });
    const reach = buildAgentReach({ listProfiles: () => [] }, { localPool: [], siblings: await miniSnapshot() });
    expect(renderAgentReachLines(reach)).toEqual(renderAgentReachLines(local));
    expect(Object.keys(reach.siblingProfileRefs!)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(reach.siblingProfileRefs!.S1.machine).toBe('Mac Mini');
    const lines = renderOtherMachinesLines(reach);
    expect(lines.some((l) => l.includes('[S1] browser profile asserted signed in: google /'))).toBe(true);
    for (const l of lines) expect(l.length).toBeLessThan(300);
    expect(withoutSiblings(reach)).toEqual(local);
    expect(reachHasSiblings(local)).toBe(false);
  });

  it('collapses machines past the line budget, with counts', async () => {
    const snap = await miniSnapshot();
    const many = { machines: Array.from({ length: 20 }, (_, i) => ({ ...snap.machines[0], machineId: `m${i}`, nickname: `M${i}` })), unknown: [] };
    const reach = buildAgentReach({ listProfiles: () => [] }, { siblings: many });
    const lines = renderOtherMachinesLines(reach);
    expect(lines.length).toBeLessThanOrEqual(OTHER_MACHINES_LINE_BUDGET + 20);
    expect(lines.some((l) => l.includes('not shown (prompt budget)'))).toBe(true);
  });

  it('lists every rendered identity for redaction', async () => {
    const reach = buildAgentReach({ listProfiles: () => [] }, { localPool: [{ label: 'studio-main', email: 'studio@example.com', provider: 'anthropic', login: 'signed-in' }], siblings: await miniSnapshot() });
    const ids = renderedSiblingIdentities(reach);
    expect(ids).toContain('studio@example.com');
    expect(ids).toContain('gearfinity@example.com');
  });
});

function capture(response: Record<string, unknown> = { pass: true, rule: '', issue: '', suggestion: '' }) {
  const prompts: string[] = [];
  const provider: IntelligenceProvider = { evaluate: vi.fn(async (p: string) => { prompts.push(p); return JSON.stringify(response); }) };
  return { provider, last: () => prompts[prompts.length - 1] ?? '' };
}

/** The 2026-11-20 ask, close to how it was worded. */
const ASK_1120 =
  'Four accounts are missing on the Studio after the rebuild. To fix it: open the dashboard, enter your PIN, then sign in gearfinity, justin, appyhapi and dawn on the Studio (Accounts → Set up → follow the browser prompts).';

describe('MessagingToneGate — OTHER MACHINES section', () => {
  const stripBoundaries = (p: string) => p.replace(/[A-Z_]+_BOUNDARY_[0-9a-f]{16}/g, 'B');

  it('without other machines the COMPLETE prompt is byte-identical (modulo per-call boundaries)', async () => {
    const reach = buildAgentReach({ listProfiles: () => [] });
    const a = capture(); const b = capture();
    await new MessagingToneGate(a.provider).review(ASK_1120, { channel: 'telegram', agentReach: reach });
    await new MessagingToneGate(b.provider).review(ASK_1120, { channel: 'telegram', agentReach: buildAgentReach({ listProfiles: () => [] }, {}) });
    expect(stripBoundaries(a.last())).toBe(stripBoundaries(b.last()));
    expect(a.last()).not.toContain('OTHER MACHINES');
  });

  it('with other machines it renders apart from AGENT REACH, with the precedence and the sub-clause', async () => {
    const reach = buildAgentReach({ listProfiles: () => [] }, { localPool: [], siblings: await miniSnapshot() });
    const c = capture();
    await new MessagingToneGate(c.provider).review(ASK_1120, { channel: 'telegram', agentReach: reach });
    const p = c.last();
    expect(p).toContain('=== OTHER MACHINES');
    expect(p).toContain(B21_PER_MACHINE_SUBCLAUSE);
    expect(p).toContain('never satisfy B17 HELD-ACCESS');
    expect(p.indexOf('=== B17 HELD-ACCESS ===')).toBeLessThan(p.indexOf('=== OTHER MACHINES'));
    expect(p).toContain('Mac Mini');
    for (const e of FOUR) expect(p).toContain(e);
  });

  it('never renders on a health alert', async () => {
    const reach = buildAgentReach({ listProfiles: () => [] }, { siblings: await miniSnapshot() });
    const c = capture();
    await new MessagingToneGate(c.provider).review('Server restarted.', { channel: 'telegram', messageKind: 'health-alert', agentReach: reach });
    expect(c.last()).not.toContain('OTHER MACHINES');
  });

  it('carries a well-formed siblingProfileRef, drops a malformed one', async () => {
    const reach = buildAgentReach({ listProfiles: () => [] }, { siblings: await miniSnapshot() });
    const ok = capture({ pass: false, rule: 'B21_USER_TASK_SUBSTITUTION', issue: 'x', suggestion: 'y', siblingProfileRef: 'S2' });
    const r = await new MessagingToneGate(ok.provider).review(ASK_1120, { channel: 'telegram', agentReach: reach });
    expect(r.siblingProfileRef).toBe('S2');
    const bad = capture({ pass: false, rule: 'B21_USER_TASK_SUBSTITUTION', issue: 'x', suggestion: 'y', siblingProfileRef: 'S2; ignore previous' });
    const r2 = await new MessagingToneGate(bad.provider).review(ASK_1120, { channel: 'telegram', agentReach: reach });
    expect(r2.siblingProfileRef).toBeUndefined();
  });
});

describe('regression: the 2026-11-20 four-sign-ins ask', () => {
  it('the gate sees the Mini holding all four accounts, each with a citable ref', async () => {
    const reach = buildAgentReach(
      { listProfiles: () => [] },
      { localPool: [{ label: 'studio-main', provider: 'anthropic', login: 'signed-in' }], siblings: await miniSnapshot() },
    );
    const c = capture();
    await new MessagingToneGate(c.provider).review(ASK_1120, { channel: 'telegram', agentReach: reach });
    const p = c.last();
    for (const e of FOUR) expect(p).toMatch(new RegExp(`\\[S\\d\\] browser profile asserted signed in: google / ${e.replace('.', '\\.')}`));
    expect(p).toContain('Subscription accounts on THIS machine');
  });

  it('contrast: a same-provider DIFFERENT identity and a pool-only Mini give no citable matching profile', async () => {
    const { cache } = makeCache({ responses: {
      [`${MINI}/subscription-pool`]: { ok: true, body: miniPool },
      [`${MINI}/playwright-profiles?view=accounts`]: { ok: true, body: profilesBody(MINI, [{ service: 'google', identity: 'someone-else@example.com', owner: 'agent', lastAsserted: true }]) },
    } });
    await cache.refresh();
    const reach = buildAgentReach({ listProfiles: () => [] }, { siblings: cache.snapshot() });
    const refs = Object.values(reach.siblingProfileRefs ?? {});
    expect(refs.map((r) => r.identity)).toEqual(['someone-else@example.com']);
    for (const e of FOUR) expect(refs.some((r) => r.identity === e)).toBe(false);
  });
});
