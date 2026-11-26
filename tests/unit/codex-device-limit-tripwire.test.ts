/**
 * CodexDeviceLimitTripwire — the per-machine bench state machine (spec codex-device-limit-tripwire
 * §2 B, §3, §4, §6, §7). Fakes: an in-memory pool that applies the store's release rule, a judge
 * whose verdicts the test hands back, and a manual clock with a timer queue.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  CodexDeviceLimitTripwire,
  DEVICE_LIMIT_BACKOFF_BASE_MS,
  DEVICE_LIMIT_BACKOFF_CAP_MS,
  DEVICE_LIMIT_CONFIRM_DELAY_MS,
  type CodexReadOutcome,
  type DeviceLimitNotice,
  type DeviceLimitSource,
  type DeviceLimitVerdict,
} from '../../src/core/CodexDeviceLimitTripwire.js';
import type { SubscriptionAccount } from '../../src/core/SubscriptionPool.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-31T12:00:00Z');

const BENCH_FIELDS = ['statusCause', 'deviceLimitSince', 'deviceLimitSuspectedAt', 'deviceLimitNextReadAt',
  'deviceLimitRefusedReads', 'deviceLimitReadsStopped'] as const;

/** In-memory pool with the store's release rule: a status move off needs-reauth clears the bench fields. */
class FakePool {
  accounts = new Map<string, SubscriptionAccount>();
  add(id: string, extra: Partial<SubscriptionAccount> = {}): void {
    this.accounts.set(id, {
      id, nickname: id, provider: 'openai', framework: 'codex-cli', status: 'active',
      configHome: `/home/x/.codex-${id}`, email: `${id}@example.test`, enrolledAt: '2026-01-01T00:00:00Z',
      ...extra,
    } as SubscriptionAccount);
  }
  list(): SubscriptionAccount[] { return [...this.accounts.values()].map((a) => ({ ...a })); }
  get(id: string): SubscriptionAccount | null { const a = this.accounts.get(id); return a ? { ...a } : null; }
  update(id: string, patch: Record<string, unknown>): SubscriptionAccount {
    const a = this.accounts.get(id) as unknown as Record<string, unknown>;
    if (!a) throw new Error(`no account ${id}`);
    const prior = a.status;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null) delete a[k]; else a[k] = v;
    }
    if (a.status !== 'needs-reauth' && a.status !== prior) {
      for (const f of BENCH_FIELDS) if (patch[f] === undefined) delete a[f];
    }
    return { ...(a as unknown as SubscriptionAccount) };
  }
}

interface Job { accountId: string; source: DeviceLimitSource; text: string; cb: (r: { verdict: DeviceLimitVerdict; decidedBy: string; deciders: number; cached: boolean }) => void }

function makeEnv(opts: { accounts?: string[]; nicknames?: Record<string, string> } = {}) {
  let clock = T0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const pool = new FakePool();
  for (const id of opts.accounts ?? ['a', 'b']) pool.add(id, opts.nicknames?.[id] ? { nickname: opts.nicknames[id] } : {});
  const jobs: Job[] = [];
  const reads: Array<{ accountId: string; confirmation: boolean }> = [];
  const notices: Array<DeviceLimitNotice | null> = [];
  const logs: Array<Record<string, unknown>> = [];
  const ledger = { benched: [] as Array<[string, boolean]>, released: [] as string[] };
  const settled: string[] = [];
  const moved: string[] = [];
  const config = { enabled: true, ignoreAccounts: [] as string[] };
  const tw = new CodexDeviceLimitTripwire({
    pool: pool as never,
    judge: { enqueue: (job, cb) => { jobs.push({ accountId: job.accountId, source: job.source, text: job.text, cb }); } },
    machineId: 'm1',
    config: () => config,
    requestRead: (accountId, o) => { reads.push({ accountId, confirmation: o.confirmation }); },
    ledger: { benched: (id, was) => { ledger.benched.push([id, was]); }, released: (id) => { ledger.released.push(id); } },
    settleRepairs: (id) => { settled.push(id); },
    moveSessions: (id) => { moved.push(id); },
    notice: (n) => { notices.push(n); },
    log: (row) => { logs.push(row); },
    now: () => clock,
    setTimer: (fn, ms) => { timers.push({ at: clock + ms, fn }); return {}; },
  });
  const advance = (ms: number) => {
    clock += ms;
    for (let i = 0; i < timers.length;) {
      if (timers[i].at <= clock) { const [t] = timers.splice(i, 1); t.fn(); } else i++;
    }
  };
  const acct = (id: string) => pool.get(id)!;
  const ok = (id: string, scheduled = true) => tw.afterCodexRead(acct(id), { kind: 'ok', scheduled });
  const refuse = (id: string, opts2: { stage?: 'read' | 'initialize'; scheduled?: boolean } = {}) =>
    tw.afterCodexRead(acct(id), { kind: 'auth-failed', refusal: { stage: opts2.stage ?? 'read', text: 'Too many devices on this account' }, scheduled: opts2.scheduled ?? true } as CodexReadOutcome);
  /** Resolve the newest pending job. */
  const verdict = (v: DeviceLimitVerdict, cached = false) => {
    const j = jobs.pop();
    if (!j) throw new Error('no pending judge job');
    j.cb({ verdict: v, decidedBy: 'jev', deciders: 1, cached });
  };
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  /** The full bench flow: a clean other account (b), two fresh device_limit refusals 6 min apart. */
  const benchA = async () => {
    ok('b');
    refuse('a'); verdict('device_limit');
    advance(6 * MIN);
    ok('b');
    refuse('a'); verdict('device_limit');
    await flush();
  };
  return { tw, pool, jobs, reads, notices, logs, ledger, settled, moved, config, advance, acct, ok, refuse, verdict, flush, benchA, now: () => clock };
}

const isBenched = (a: SubscriptionAccount) => a.status === 'needs-reauth' && a.statusCause === 'codex-device-limit';

describe('CodexDeviceLimitTripwire — suspicion and bench', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('regression: right after a restart (another account not yet read) the floor is unknown — no bench, no "refusing alike" alarm', async () => {
    env.refuse('a'); env.verdict('device_limit');          // b never read by this process
    env.advance(6 * MIN);
    env.refuse('a'); env.verdict('device_limit');
    await env.flush();
    expect(isBenched(env.acct('a'))).toBe(false);
    expect(env.logs.some((r) => r.action === 'floor-unknown')).toBe(true);
    expect(env.notices.filter((n) => n && /refusing in the same way/.test(n.body))).toHaveLength(0);
  });

  it('first fresh read-refusal device_limit ⇒ suspected + a confirmation read after 5 min, no bench', () => {
    env.ok('b');
    env.refuse('a');
    expect(env.jobs).toHaveLength(1);
    expect(env.jobs[0].source).toBe('read-refusal');
    env.verdict('device_limit');
    const a = env.acct('a');
    expect(a.deviceLimitSuspectedAt).toBe(new Date(T0).toISOString());
    expect(isBenched(a)).toBe(false);
    expect(env.tw.counters.suspected).toBe(1);
    env.advance(DEVICE_LIMIT_CONFIRM_DELAY_MS - 1);
    expect(env.reads).toEqual([]);
    env.advance(1);
    expect(env.reads).toEqual([{ accountId: 'a', confirmation: true }]);
    expect(env.ledger.benched).toEqual([]);
  });

  it('second fresh device_limit 5–60 min later with the machine floor ⇒ benched with every side effect', async () => {
    await env.benchA();
    const a = env.acct('a');
    expect(isBenched(a)).toBe(true);
    expect(a.deviceLimitSince).toBe(new Date(env.now()).toISOString());
    expect(a.deviceLimitSuspectedAt).toBeUndefined();
    expect(a.deviceLimitNextReadAt).toBe(new Date(env.now() + DEVICE_LIMIT_BACKOFF_BASE_MS).toISOString());
    expect(a.deviceLimitRefusedReads).toBe(0);
    expect(a.deviceLimitReadsStopped).toBe(false);
    expect(env.ledger.benched).toEqual([['a', false]]);
    expect(env.settled).toEqual(['a']);
    expect(env.moved).toEqual(['a']);
    const last = env.notices.at(-1)!;
    expect(last).not.toBeNull();
    expect(last.title).toContain('1 account benched');
    expect(last.machineId).toBe('m1');
    expect(env.logs.some((r) => r.action === 'benched' && r.accountId === 'a')).toBe(true);
  });

  it('ledger records wasNeedsReauth when the account was already needs-reauth', async () => {
    env.pool.update('a', { status: 'needs-reauth' });
    await env.benchA();
    expect(env.ledger.benched).toEqual([['a', true]]);
  });

  it('a second refusal under 5 min is the same episode ⇒ no bench', async () => {
    env.ok('b');
    env.refuse('a'); env.verdict('device_limit');
    const firstAt = env.acct('a').deviceLimitSuspectedAt;
    env.advance(3 * MIN);
    env.refuse('a'); env.verdict('device_limit');
    await env.flush();
    expect(isBenched(env.acct('a'))).toBe(false);
    expect(env.acct('a').deviceLimitSuspectedAt).toBe(firstAt);
  });

  it('a second refusal over 60 min later is a new first observation', async () => {
    env.refuse('a'); env.verdict('device_limit');
    env.advance(61 * MIN);
    env.ok('b');
    env.refuse('a'); env.verdict('device_limit');
    await env.flush();
    expect(isBenched(env.acct('a'))).toBe(false);
    expect(env.acct('a').deviceLimitSuspectedAt).toBe(new Date(env.now()).toISOString());
    expect(env.tw.counters.suspected).toBe(2);
  });

  it('a cached verdict never moves state (neither suspects nor confirms)', async () => {
    env.ok('b');
    env.refuse('a'); env.verdict('device_limit', true);
    expect(env.acct('a').deviceLimitSuspectedAt).toBeUndefined();
    env.refuse('a'); env.verdict('device_limit');
    env.advance(6 * MIN);
    env.ok('b');
    env.refuse('a'); env.verdict('device_limit', true);
    await env.flush();
    expect(isBenched(env.acct('a'))).toBe(false);
  });

  it('undecided waits: no suspicion', () => {
    env.refuse('a'); env.verdict('undecided');
    expect(env.acct('a').deviceLimitSuspectedAt).toBeUndefined();
  });

  it('not_device_limit clears an existing suspicion', () => {
    env.refuse('a'); env.verdict('device_limit');
    expect(env.acct('a').deviceLimitSuspectedAt).toBeDefined();
    env.advance(6 * MIN);
    env.refuse('a'); env.verdict('not_device_limit');
    expect(env.acct('a').deviceLimitSuspectedAt).toBeUndefined();
    expect(env.logs.some((r) => r.action === 'suspicion-ended' && r.why === 'not-device-limit')).toBe(true);
  });

  it('a clean live read clears suspicion', () => {
    env.refuse('a'); env.verdict('device_limit');
    env.advance(MIN);
    env.ok('a');
    expect(env.acct('a').deviceLimitSuspectedAt).toBeUndefined();
  });

  it('floor fails (every account refusing alike) ⇒ no bench + HIGH "refusing in the same way" line', async () => {
    env.ok('b');
    env.refuse('a'); env.verdict('device_limit');
    env.advance(6 * MIN);
    env.refuse('b'); // b's latest completed read is now a refusal
    env.jobs.length = 0;
    env.refuse('a'); env.verdict('device_limit');
    await env.flush();
    expect(isBenched(env.acct('a'))).toBe(false);
    expect(env.tw.counters.refusingAlikeBlocks).toBe(1);
    const n = env.notices.at(-1)!;
    expect(n.priority).toBe('HIGH');
    expect(n.body).toContain('refusing in the same way');
    expect(n.body).toContain('Nothing has been benched.');
    expect(env.tw.noticeCondition()).toBe('active');
  });

  it('floor needs the other account clean within 60 min', async () => {
    env.ok('b');
    env.advance(55 * MIN);
    env.refuse('a'); env.verdict('device_limit');
    env.advance(6 * MIN); // b's clean read is now 61 min old
    env.refuse('a'); env.verdict('device_limit');
    await env.flush();
    expect(isBenched(env.acct('a'))).toBe(false);
  });

  it('a single-account machine never benches', async () => {
    const solo = makeEnv({ accounts: ['a'] });
    solo.refuse('a'); solo.verdict('device_limit');
    solo.advance(6 * MIN);
    solo.refuse('a'); solo.verdict('device_limit');
    await solo.flush();
    expect(isBenched(solo.acct('a'))).toBe(false);
  });

  it('a transport failure with no refusal text is not judged', () => {
    env.tw.afterCodexRead(env.acct('a'), { kind: 'unavailable', scheduled: true });
    expect(env.jobs).toHaveLength(0);
  });
});

describe('CodexDeviceLimitTripwire — trigger-only sources', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('regression: a trigger-source verdict bypasses the read floor at most once per account per 10 min (no judge-budget loop)', () => {
    env.ok('b');
    env.refuse('a', { stage: 'initialize' }); env.verdict('device_limit');
    env.refuse('a', { stage: 'initialize' }); env.verdict('device_limit');
    expect(env.reads).toEqual([{ accountId: 'a', confirmation: true }, { accountId: 'a', confirmation: false }]);
    env.advance(10 * MIN);
    env.refuse('a', { stage: 'initialize' }); env.verdict('device_limit');
    expect(env.reads.at(-1)).toEqual({ accountId: 'a', confirmation: true });
  });

  it('initialize-error device_limit only requests a read (no suspicion)', () => {
    env.ok('b');
    env.refuse('a', { stage: 'initialize' });
    expect(env.jobs[0].source).toBe('initialize-error');
    env.verdict('device_limit');
    expect(env.acct('a').deviceLimitSuspectedAt).toBeUndefined();
    expect(env.reads).toEqual([{ accountId: 'a', confirmation: true }]);
  });

  it('login-status text device_limit only requests a read', () => {
    env.tw.afterLoginStatusText(env.acct('a'), 'Not logged in: device limit reached');
    expect(env.jobs[0].source).toBe('login-status');
    env.verdict('device_limit');
    expect(env.acct('a').deviceLimitSuspectedAt).toBeUndefined();
    expect(env.reads).toEqual([{ accountId: 'a', confirmation: true }]);
  });

  it('a not_device_limit trigger verdict requests nothing', () => {
    env.tw.afterLoginStatusText(env.acct('a'), 'Not logged in');
    env.verdict('not_device_limit');
    expect(env.reads).toEqual([]);
  });

  it('sign-in page (onRepairStopped) only requests a read and raises a low notice', () => {
    env.tw.onRepairStopped('a');
    expect(env.reads).toEqual([{ accountId: 'a', confirmation: true }]);
    expect(env.acct('a').deviceLimitSuspectedAt).toBeUndefined();
    expect(isBenched(env.acct('a'))).toBe(false);
    const n = env.notices.at(-1)!;
    expect(n.priority).toBe('low');
    expect(n.body).toContain('sign-in attempt stopped');
  });

  it('login-status text is ignored for a benched account', async () => {
    await env.benchA();
    env.tw.afterLoginStatusText(env.acct('a'), 'device limit');
    expect(env.jobs).toHaveLength(0);
  });
});

describe('CodexDeviceLimitTripwire — stale verdicts', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('a clean read after the refused read makes its verdict stale', () => {
    env.refuse('a');
    env.advance(1000);
    env.ok('a');
    env.verdict('device_limit');
    expect(env.acct('a').deviceLimitSuspectedAt).toBeUndefined();
    expect(env.tw.counters.staleVerdicts).toBe(1);
    expect(env.logs.some((r) => r.action === 'stale-verdict')).toBe(true);
  });

  it('switch off before the verdict ⇒ dropped', () => {
    env.refuse('a');
    env.config.enabled = false;
    env.verdict('device_limit');
    env.config.enabled = true;
    expect(env.acct('a').deviceLimitSuspectedAt).toBeUndefined();
    expect(env.tw.counters.staleVerdicts).toBe(1);
  });

  it('account added to ignoreAccounts before the verdict ⇒ dropped', () => {
    env.refuse('a');
    env.config.ignoreAccounts = ['a'];
    env.verdict('device_limit');
    expect(env.acct('a').deviceLimitSuspectedAt).toBeUndefined();
    expect(env.tw.counters.staleVerdicts).toBe(1);
  });

  it('a credential change (new email in the slot) before the verdict ⇒ dropped', () => {
    env.refuse('a');
    env.pool.update('a', { email: 'someone-else@example.test' });
    env.verdict('device_limit');
    expect(env.acct('a').deviceLimitSuspectedAt).toBeUndefined();
    expect(env.tw.counters.staleVerdicts).toBe(1);
  });

  it('switched off, reads are not even judged', () => {
    env.config.enabled = false;
    env.refuse('a');
    expect(env.jobs).toHaveLength(0);
  });

  it('an ignored account is never judged', () => {
    env.config.ignoreAccounts = ['a'];
    env.refuse('a');
    expect(env.jobs).toHaveLength(0);
  });
});

describe('CodexDeviceLimitTripwire — release, backoff, breaker', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(async () => { env = makeEnv(); await env.benchA(); env.reads.length = 0; });

  it('a clean read on a benched account schedules a confirmation read; the second clean read releases', () => {
    env.ok('a');
    expect(isBenched(env.acct('a'))).toBe(true);
    env.advance(DEVICE_LIMIT_CONFIRM_DELAY_MS);
    expect(env.reads).toEqual([{ accountId: 'a', confirmation: true }]);
    env.ok('a', false);
    const a = env.acct('a');
    expect(a.status).toBe('active');
    for (const f of BENCH_FIELDS) expect((a as unknown as Record<string, unknown>)[f]).toBeUndefined();
    expect(env.ledger.released).toEqual(['a']);
    expect(env.logs.some((r) => r.action === 'released' && r.observed === 'released-without-sign-in')).toBe(true);
    expect(env.notices.at(-1)).toBeNull();
  });

  it('a refusal between clean reads resets the release count', () => {
    env.ok('a');
    env.refuse('a', { scheduled: false });
    env.ok('a');
    expect(isBenched(env.acct('a'))).toBe(true);
    env.ok('a');
    expect(env.acct('a').status).toBe('active');
  });

  it('a refusal on a benched account is never sent to the judge', () => {
    env.jobs.length = 0;
    env.refuse('a');
    expect(env.jobs).toHaveLength(0);
  });

  it('scheduled refusals back off 1 h → doubling → 6 h cap; confirmation refusals do not count', () => {
    expect(Date.parse(env.acct('a').deviceLimitNextReadAt!) - env.now()).toBe(HOUR);
    env.refuse('a', { scheduled: false });
    expect(env.acct('a').deviceLimitRefusedReads).toBe(0);
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      env.refuse('a');
      delays.push(Date.parse(env.acct('a').deviceLimitNextReadAt!) - env.now());
    }
    expect(delays).toEqual([2 * HOUR, 4 * HOUR, DEVICE_LIMIT_BACKOFF_CAP_MS, DEVICE_LIMIT_BACKOFF_CAP_MS]);
    expect(env.acct('a').deviceLimitRefusedReads).toBe(4);
  });

  it('breaker: after 8 refused reads at the 6 h cap, scheduled reads stop and the notice says so', () => {
    // Reads 1–3 come after the 1 h, 2 h and 4 h waits; reads 4–11 are the 8 at the 6 h cap.
    for (let i = 0; i < 10; i++) env.refuse('a');
    expect(env.acct('a').deviceLimitReadsStopped).toBe(false);
    env.refuse('a');
    expect(env.acct('a').deviceLimitReadsStopped).toBe(true);
    expect(env.logs.filter((r) => r.action === 'breaker')).toHaveLength(1);
    expect(env.notices.at(-1)!.body).toContain('automatic checks have stopped');
    env.refuse('a');
    expect(env.logs.filter((r) => r.action === 'breaker')).toHaveLength(1); // logged once
  });

  it('regression: a clean read resets the breaker count and re-enables scheduled checks', () => {
    for (let i = 0; i < 11; i++) env.refuse('a');
    expect(env.acct('a').deviceLimitReadsStopped).toBe(true);
    env.ok('a');
    expect(isBenched(env.acct('a'))).toBe(true); // one clean read never releases
    expect(env.acct('a').deviceLimitRefusedReads).toBe(0);
    expect(env.acct('a').deviceLimitReadsStopped).toBe(false);
  });

  it('skipScheduledRead follows deviceLimitNextReadAt and the breaker', () => {
    expect(env.tw.skipScheduledRead(env.acct('a'))).toBe(true);
    env.advance(HOUR);
    expect(env.tw.skipScheduledRead(env.acct('a'))).toBe(false);
    env.pool.update('a', { deviceLimitReadsStopped: true });
    expect(env.tw.skipScheduledRead(env.acct('a'))).toBe(true);
    expect(env.tw.skipScheduledRead(env.acct('b'))).toBe(false);
    env.config.enabled = false;
    expect(env.tw.skipScheduledRead(env.acct('a'))).toBe(false);
  });

  it('holdsRestore is true only for a benched account while enabled', () => {
    expect(env.tw.holdsRestore('a')).toBe(true);
    expect(env.tw.holdsRestore('b')).toBe(false);
    expect(env.tw.holdsRestore('missing')).toBe(false);
    env.config.enabled = false;
    expect(env.tw.holdsRestore('a')).toBe(false);
  });
});

describe('CodexDeviceLimitTripwire — tick()', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv({ accounts: ['a', 'b', 'c'] }); });

  it('expires a suspicion after 60 min', () => {
    env.refuse('a'); env.verdict('device_limit');
    env.advance(60 * MIN);
    env.tw.tick();
    expect(env.acct('a').deviceLimitSuspectedAt).toBeDefined();
    env.advance(1);
    env.tw.tick();
    expect(env.acct('a').deviceLimitSuspectedAt).toBeUndefined();
    expect(env.logs.some((r) => r.why === 'suspicion-expired')).toBe(true);
  });

  it('switch-off releases benched accounts, clears suspicion and the notice', async () => {
    await env.benchA();
    env.refuse('c'); env.verdict('device_limit');
    expect(env.acct('c').deviceLimitSuspectedAt).toBeDefined();
    env.config.enabled = false;
    env.tw.tick();
    expect(env.acct('a').status).toBe('active');
    expect(env.acct('a').statusCause).toBeUndefined();
    expect(env.acct('c').deviceLimitSuspectedAt).toBeUndefined();
    expect(env.notices.at(-1)).toBeNull();
    expect(env.logs.some((r) => r.action === 'released' && r.observed === 'switch-off')).toBe(true);
    const before = env.notices.length;
    env.tw.tick(); // already off: nothing more happens
    expect(env.notices.length).toBe(before);
  });

  it('ignoreAccounts releases a bench and clears a suspicion on the next tick', async () => {
    await env.benchA();
    env.refuse('c'); env.verdict('device_limit');
    env.config.ignoreAccounts = ['a', 'c'];
    env.tw.tick();
    expect(env.acct('a').status).toBe('active');
    expect(env.acct('c').deviceLimitSuspectedAt).toBeUndefined();
    expect(env.logs.some((r) => r.action === 'released' && r.observed === 'ignored')).toBe(true);
  });

  it('detects an operator release (another writer set active)', async () => {
    await env.benchA();
    env.pool.update('a', { status: 'active' });
    env.tw.tick();
    expect(env.logs.some((r) => r.action === 'released' && r.observed === 'operator-released')).toBe(true);
    expect(env.notices.at(-1)).toBeNull();
    expect(env.tw.noticeCondition()).toBe('cleared');
  });
});

describe('CodexDeviceLimitTripwire — the notice', () => {
  it('normal while another Codex account is signed in; HIGH when none is', async () => {
    const env = makeEnv();
    await env.benchA();
    expect(env.notices.at(-1)!.priority).toBe('normal');

    const env2 = makeEnv();
    env2.pool.update('b', { status: 'needs-reauth' }); // not benched, but not signed in either
    await env2.benchA();
    expect(isBenched(env2.acct('a'))).toBe(true);
    expect(env2.notices.at(-1)!.priority).toBe('HIGH');
  });

  it('a stopped-repair-only row is low; noticeCondition tracks the row', () => {
    const env = makeEnv();
    expect(env.tw.noticeCondition()).toBe('cleared');
    env.tw.onRepairStopped('a');
    expect(env.notices.at(-1)!.priority).toBe('low');
    expect(env.notices.at(-1)!.title).toBe('Codex device limit: possible lockout seen on this machine');
    expect(env.tw.noticeCondition()).toBe('active');
  });

  it('24 h re-notify brake: a row re-opened within 24 h of clearing is silent; after 24 h it buzzes', async () => {
    const env = makeEnv();
    await env.benchA();
    expect(env.notices.at(-1)!.silent).toBe(false);
    env.ok('a'); env.ok('a'); // two clean reads release ⇒ the row clears
    expect(env.notices.at(-1)).toBeNull();
    env.advance(HOUR);
    env.tw.onRepairStopped('a');
    expect(env.notices.at(-1)!.silent).toBe(true);
    env.advance(25 * HOUR); // the stopped repair ages out and the row clears again
    env.tw.refreshNotice();
    expect(env.notices.at(-1)).toBeNull();
    env.advance(25 * HOUR);
    env.tw.onRepairStopped('b');
    expect(env.notices.at(-1)!.silent).toBe(false);
  });

  it('nicknames are HTML-escaped in the body', async () => {
    const env = makeEnv({ nicknames: { a: '<b>A&co</b>' } });
    await env.benchA();
    const body = env.notices.at(-1)!.body;
    expect(body).toContain('&lt;b&gt;A&amp;co&lt;/b&gt;');
    expect(body).not.toContain('<b>');
  });

  it('status() reports the counts', async () => {
    const env = makeEnv();
    await env.benchA();
    expect(env.tw.status()).toMatchObject({ enabled: true, benchedNow: 1, suspectedNow: 0, refusingAlike: false });
  });
});
