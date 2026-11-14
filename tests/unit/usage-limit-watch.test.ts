// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { interpretProbe } from '../../src/core/claudeKeyProbe.js';
import { classifyClaudeAuthFailure, isUsageLimitOutput } from '../../src/core/claudeChildAuth.js';
import { buildKeyRecoveryPrompt } from '../../src/core/claudeKeyRecovery.js';
import { PresenceProxy } from '../../src/monitoring/PresenceProxy.js';
import {
  ANSWER_WAIT_MS, NOTICE_MAX_ATTEMPTS, OPERATOR_OK_TEXT, PERSON_LIMITED_TEXT, PERSON_RESEND_TEXT, PROBE_CEILING_MS, PROBE_START_MS,
  OPERATOR_NOTICE_GAP_MS, REFRESH_MAX_PER_DAY, REFRESH_WINDOW_MS, REOPEN_COOLDOWN_MS, SIGNAL_MIN_PROBE_INTERVAL_MS, UsageLimitWatch, decideLimitRefresh, nextProbeDelay, operatorLimitText, resetFromBanner,
  type UsageLimitWatchDeps, type UsageProbeResult,
} from '../../src/core/UsageLimitWatch.js';

function rig(overrides: Partial<UsageLimitWatchDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limit-'));
  const r = {
    dir, clock: 1_000_000,
    confirmed: new Set<string>(['s1', 's2']),
    otherAccount: false,
    knownRoom: false,
    stillWalled: new Set<string>(['s1', 's2']),
    banner: "You've hit your weekly limit · resets Nov 8, 11am (UTC)" as string | null,
    probes: [] as UsageProbeResult[], probeCount: 0,
    fingerprint: 'fp-a' as string | null,
    walledNow: [] as string[],
    running: new Set<string>(['s1', 's2']),
    held: { s1: 2, s2: 1 } as Record<string, number | null>,
    refreshed: [] as Array<[string, string]>, refreshOk: true,
    answered: true as boolean | null,
    operator: [] as string[], operatorDelivers: true,
    session: [] as Array<[string, string]>, channel: [] as string[],
    reports: [] as string[],
  };
  const make = (start = true) => { const w = new UsageLimitWatch({
    stateFile: path.join(dir, 'state.json'),
    confirmSession: (s) => r.confirmed.has(s),
    anotherAccountHasRoom: () => r.otherAccount,
    accountKnownToHaveRoom: () => r.knownRoom,
    stillWalled: (s) => r.stillWalled.has(s),
    bannerFor: () => r.banner,
    channelFor: (s) => ({ platform: 'slack', channelId: `C-${s}` }),
    probe: async () => { r.probeCount += 1; return r.probes.shift() ?? 'limited'; },
    keyFingerprint: () => r.fingerprint,
    isKeyAgent: () => true,
    listWalledSessions: async () => r.walledNow,
    isSessionRunning: (s) => r.running.has(s),
    recoveryPrompt: async (s) => (r.held[s] === null ? null : { prompt: `answer ${s}`, held: r.held[s] ?? 0 }),
    refresh: async (s, p) => { r.refreshed.push([s, p]); return { ok: r.refreshOk }; },
    answeredSince: async () => r.answered,
    notifyOperator: async (t) => { r.operator.push(t); return r.operatorDelivers; },
    notifySession: async (s, t) => { r.session.push([s, t]); return true; },
    notifyChannel: async (c, t) => { r.channel.push(`${c.platform === 'slack' ? c.channelId : c.topicId}:${t}`); return true; },
    report: ({ reason }) => { r.reports.push(reason); },
    now: () => r.clock,
    manualTimers: true,
    ...overrides,
  }); if (start) w.start(); return w; };
  return { r, make };
}

describe('UsageLimitWatch', () => {
  let t: ReturnType<typeof rig>;
  beforeEach(() => { t = rig(); });
  afterEach(() => { fs.rmSync(t.r.dir, { recursive: true, force: true }); });

  describe('deciding usage ran out', () => {
    it('a banner the transcript does not confirm tells nobody', async () => {
      const h = t.make();
      await h.noteWall('printed-the-words');
      expect(h.isLimited()).toBe(false);
      expect(t.r.operator).toEqual([]);
    });

    it('a confirmed wall tells the operator once, with the reset and the way to act', async () => {
      const h = t.make();
      await h.noteWall('s1');
      await h.noteWall('s2');
      expect(h.isLimited()).toBe(true);
      expect(t.r.operator).toHaveLength(1);
      expect(t.r.operator[0]).toContain('It resets Nov 8, 11am (UTC).');
      expect(t.r.operator[0]).toContain('instar set-claude-key');
      expect(h.status()?.resets).toBe('Nov 8, 11am (UTC)');
    });

    it('stays out of the way while another account has room: no false "can\'t reply to anyone"', async () => {
      t.r.otherAccount = true;
      const h = t.make();
      await h.noteWall('s1');
      expect(h.isLimited()).toBe(false);
    });

    it('a refused internal call on an agent with another account free never even probes', async () => {
      t.r.otherAccount = true;
      const h = t.make();
      h.noteCallLimited();
      await new Promise((res) => setImmediate(res));
      expect(t.r.probeCount).toBe(0);
      expect(h.isLimited()).toBe(false);
    });

    it('nothing opens before the server is fully up; the wall signals again later', async () => {
      const h = t.make(false);
      await h.noteWall('s1');
      h.noteCallLimited();
      expect(h.isLimited()).toBe(false);
      expect(t.r.probeCount).toBe(0);
      h.start();
      await h.noteWall('s1');
      expect(h.isLimited()).toBe(true);
    });

    it('an internal call signal only starts a probe, and only the probe decides', async () => {
      const h = t.make();
      t.r.probes.push('ok');
      h.noteCallLimited();
      await new Promise((res) => setImmediate(res));
      expect(t.r.probeCount).toBe(1);
      expect(h.isLimited()).toBe(false);
      h.noteCallLimited();
      expect(t.r.probeCount).toBe(1); // rate limited
      t.r.clock += SIGNAL_MIN_PROBE_INTERVAL_MS;
      t.r.probes.push('limited');
      h.noteCallLimited();
      await new Promise((res) => setImmediate(res));
      expect(h.isLimited()).toBe(true);
      expect(t.r.operator).toHaveLength(1); // told with no conversation in sight
    });

    it('an unusable probe concludes nothing', async () => {
      const h = t.make();
      t.r.probes.push('other');
      h.noteCallLimited();
      await new Promise((res) => setImmediate(res));
      expect(h.isLimited()).toBe(false);
    });

    it('the person line exists only while limited', async () => {
      const h = t.make();
      expect(h.personNotice()).toBeNull();
      await h.noteWall('s1');
      expect(h.personNotice()).toBe(PERSON_LIMITED_TEXT);
    });
  });

  describe('operator notice delivery', () => {
    it('retries an undelivered notice on ticks, then caps and reports', async () => {
      t.r.operatorDelivers = false;
      const h = t.make();
      await h.noteWall('s1');
      for (let i = 0; i < 10; i++) await h.tick();
      expect(t.r.operator).toHaveLength(NOTICE_MAX_ATTEMPTS);
      expect(t.r.reports.some((m) => m.includes('operator could not be told'))).toBe(true);
    });
  });

  describe('probing', () => {
    it('backs off to a ceiling while still limited', async () => {
      const h = t.make();
      await h.noteWall('s1');
      await h.tick();
      expect(t.r.probeCount).toBe(0); // first probe waits
      t.r.clock += PROBE_START_MS;
      await h.tick();
      expect(t.r.probeCount).toBe(1);
      await h.tick();
      expect(t.r.probeCount).toBe(1);
      expect(nextProbeDelay(PROBE_CEILING_MS)).toBe(PROBE_CEILING_MS);
    });

    it('a new key is probed straight away', async () => {
      const h = t.make();
      h.boot();
      await h.noteWall('s1');
      t.r.fingerprint = 'fp-b';
      t.r.probes.push('ok');
      await h.tick();
      expect(t.r.probeCount).toBe(1);
      expect(h.isLimited()).toBe(false);
    });
  });

  describe('when usage comes back', () => {
    const openAndRecover = async (h: UsageLimitWatch) => {
      await h.noteWall('s1');
      t.r.clock += PROBE_START_MS;
      t.r.probes.push('ok');
      await h.tick();
    };

    it('each waiting conversation restarts with its own prompt, and the operator hears the all-clear', async () => {
      const h = t.make();
      await h.noteWall('s1');
      await h.noteWall('s2');
      t.r.clock += PROBE_START_MS;
      t.r.probes.push('ok');
      await h.tick();
      expect(h.isLimited()).toBe(false);
      expect(t.r.refreshed).toEqual([['s1', 'answer s1'], ['s2', 'answer s2']]);
      expect(t.r.operator.at(-1)).toBe(OPERATOR_OK_TEXT);
    });

    it('also finds walled sessions it never heard about', async () => {
      const h = t.make();
      t.r.walledNow = ['s2'];
      await openAndRecover(h);
      expect(t.r.refreshed.map(([s]) => s)).toEqual(['s1', 's2']);
    });

    it('nothing held means no restart and nobody asked to resend', async () => {
      t.r.held.s1 = 0;
      const h = t.make();
      await openAndRecover(h);
      expect(t.r.refreshed).toEqual([]);
      t.r.clock += ANSWER_WAIT_MS;
      await h.tick();
      expect(t.r.session).toEqual([]);
    });

    it('unreadable held messages: no restart, reported', async () => {
      t.r.held.s1 = null;
      const h = t.make();
      await openAndRecover(h);
      expect(t.r.refreshed).toEqual([]);
      expect(t.r.reports.some((m) => m.includes('Could not read'))).toBe(true);
    });

    it('a session that ended during the limit: its conversation is asked to resend', async () => {
      const h = t.make();
      await h.noteWall('s1');
      t.r.running.delete('s1');
      t.r.clock += PROBE_START_MS;
      t.r.probes.push('ok');
      await h.tick();
      expect(t.r.refreshed).toEqual([]);
      expect(t.r.channel).toEqual([`C-s1:${PERSON_RESEND_TEXT}`]);
    });

    it('answered in time: nothing more; not answered: asked to resend once and reported', async () => {
      const h = t.make();
      t.r.answered = false;
      await openAndRecover(h);
      t.r.clock += ANSWER_WAIT_MS - 1;
      await h.tick();
      expect(t.r.session).toEqual([]);
      t.r.clock += 1;
      await h.tick();
      await h.tick();
      expect(t.r.session).toEqual([['s1', PERSON_RESEND_TEXT]]);
      expect(t.r.reports.some((m) => m.includes('no answer was seen'))).toBe(true);
    });

    it('answered: the person is not asked anything', async () => {
      const h = t.make();
      await openAndRecover(h);
      t.r.answered = true;
      t.r.clock += ANSWER_WAIT_MS;
      await h.tick();
      expect(t.r.session).toEqual([]);
    });

    it('a refused restart stays listed and is tried again; only the cap asks the person to resend', async () => {
      t.r.refreshOk = false;
      const h = t.make();
      await openAndRecover(h);
      expect(t.r.session).toEqual([]);
      await h.tick();
      await h.tick();
      expect(t.r.refreshed).toHaveLength(REFRESH_MAX_PER_DAY);
      await h.tick();
      expect(t.r.refreshed).toHaveLength(REFRESH_MAX_PER_DAY);
      expect(t.r.session).toEqual([['s1', PERSON_RESEND_TEXT]]);
      expect(t.r.reports.some((m) => m.includes('did not pick up'))).toBe(true);
    });

    it('a session that moved on by itself is never restarted: that would kill its work', async () => {
      t.r.stillWalled.delete('s1');
      const h = t.make();
      await openAndRecover(h);
      expect(t.r.refreshed).toEqual([]);
      expect(t.r.session).toEqual([]);
    });

    it('a fresh reading of an account with room ends the episode without a probe', async () => {
      const h = t.make();
      await h.noteWall('s1');
      t.r.knownRoom = true;
      await h.tick();
      expect(h.isLimited()).toBe(false);
      expect(t.r.probeCount).toBe(0);
    });

    it('merely not knowing an account is full does not end it: a wall memory expiring is not usage back', async () => {
      const h = t.make();
      await h.noteWall('s1');
      t.r.otherAccount = true;
      await h.tick();
      expect(h.isLimited()).toBe(true);
    });

    it('an old banner left on a pane cannot flap: no new episode in the cooldown, and one notice in the gap', async () => {
      const h = t.make();
      await openAndRecover(h);
      await h.noteWall('s1');
      expect(h.isLimited()).toBe(false);
      t.r.clock += REOPEN_COOLDOWN_MS;
      await h.noteWall('s1');
      expect(h.isLimited()).toBe(true);
      expect(t.r.operator.filter((m) => m.startsWith('Your agent has run out'))).toHaveLength(1);
      t.r.clock += OPERATOR_NOTICE_GAP_MS;
      await h.tick();
      expect(t.r.operator.filter((m) => m.startsWith('Your agent has run out'))).toHaveLength(2);
    });

    it('a session that walls again right away stops being restarted at the daily cap', async () => {
      const h = t.make();
      for (let i = 0; i < REFRESH_MAX_PER_DAY + 2; i++) {
        await openAndRecover(h);
        t.r.clock += REOPEN_COOLDOWN_MS;
      }
      expect(t.r.refreshed).toHaveLength(REFRESH_MAX_PER_DAY);
      expect(t.r.reports.some((m) => m.includes('did not pick up'))).toBe(true);
    });

    it('the operator is told again in a later episode, past the notice gap', async () => {
      const h = t.make();
      await openAndRecover(h);
      t.r.clock += OPERATOR_NOTICE_GAP_MS;
      await h.noteWall('s1');
      expect(t.r.operator.filter((m) => m.startsWith('Your agent has run out'))).toHaveLength(2);
    });

    it('survives a restart mid-limit and still recovers', async () => {
      const first = t.make();
      await first.noteWall('s1');
      const second = t.make();
      second.boot();
      expect(second.isLimited()).toBe(true);
      t.r.clock += PROBE_START_MS;
      t.r.probes.push('ok');
      await second.tick();
      expect(t.r.refreshed.map(([s]) => s)).toEqual(['s1']);
      expect(t.r.operator.filter((m) => m.startsWith('Your agent has run out'))).toHaveLength(1);
    });
  });

  it('never persists a key or message text: state is names and times only', async () => {
    const h = t.make();
    await h.noteWall('s1');
    expect(fs.statSync(path.join(t.r.dir, 'state.json')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(t.r.dir, 'state.json'), 'utf8')).not.toContain('fp-a');
  });

  it('a corrupt state file means nothing was in progress', () => {
    fs.writeFileSync(path.join(t.r.dir, 'state.json'), '{nope');
    const h = t.make();
    h.boot();
    expect(h.isLimited()).toBe(false);
  });
});

describe('pure parts', () => {
  it('reads the reset from the real banner, and says nothing when there is none', () => {
    expect(resetFromBanner("You've hit your weekly limit · resets Nov 8, 11am (UTC)")).toBe('Nov 8, 11am (UTC)');
    expect(resetFromBanner('Usage limit reached · limit resets 8am')).toBe('8am');
    expect(resetFromBanner("You've hit your weekly limit")).toBeNull();
    expect(resetFromBanner(null)).toBeNull();
  });

  it('operator wording matches how the agent can get capacity', () => {
    expect(operatorLimitText({ resets: null, keyAgent: true })).toContain('claude setup-token');
    const pool = operatorLimitText({ resets: '8am', keyAgent: false });
    expect(pool).toContain('It resets 8am.');
    expect(pool).toContain('Accounts page');
    expect(pool).not.toContain('setup-token');
  });

  it('the brake holds at the daily cap', () => {
    expect(decideLimitRefresh({ recentRefreshes: REFRESH_MAX_PER_DAY - 1 })).toBe('attempt');
    expect(decideLimitRefresh({ recentRefreshes: REFRESH_MAX_PER_DAY })).toBe('gave-up');
  });
});

describe('reading a call refused for usage', () => {
  // Field wording, nimbus, 2026-11-04. The JSON envelope matches the CLI's other errors (see ClaudeKeyHealth.test.ts).
  const limited = JSON.stringify({ is_error: true, api_error_status: 429, result: "You've hit your weekly limit · resets Nov 8, 11am (UTC)" });

  it('names the limit, on its wording, not on a bare 429', () => {
    expect(isUsageLimitOutput(limited)).toBe(true);
    expect(isUsageLimitOutput(JSON.stringify({ is_error: true, api_error_status: 429, result: 'Server is temporarily limiting requests (not your usage limit) · Rate limited' }))).toBe(false);
    expect(isUsageLimitOutput(JSON.stringify({ is_error: false, result: "You've hit your weekly limit" }))).toBe(false);
    expect(isUsageLimitOutput('not json')).toBe(false);
    for (const banner of ['Usage limit reached · limit resets 8am', 'Session limit reached ∙ resets 10:30pm', "You've hit your opus limit · resets Nov 6", "You've hit your limit"]) {
      expect(isUsageLimitOutput(JSON.stringify({ is_error: true, result: banner }))).toBe(true);
    }
    expect(isUsageLimitOutput(JSON.stringify({ is_error: true, result: 'I read that a usage limit reached someone' }))).toBe(false);
  });

  it('a limit never reads as a dead key, so nobody is told to replace a good one', () => {
    expect(classifyClaudeAuthFailure(limited)).toBeNull();
    expect(interpretProbe(true, limited)).toBe('inconclusive');
  });
});

describe('the restart prompt', () => {
  const held = [{ who: 'U1', text: 'hello', at: 1 }];

  it('says what actually happened', () => {
    const usage = buildKeyRecoveryPrompt({ platform: 'telegram', topicId: 5 }, held, 'usage');
    expect(usage).toContain('ran out of Claude usage');
    expect(usage).not.toContain('sign-in key');
    expect(usage).toContain('hello');
    expect(buildKeyRecoveryPrompt({ platform: 'telegram', topicId: 5 }, held)).toContain('sign-in key');
  });
});

describe('the standby while limited', () => {
  const mk = (notice: string | null, llm: () => Promise<string>) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-limit-'));
    const sent: string[] = [];
    const proxy: any = new PresenceProxy({
      stateDir, agentName: 'echo',
      intelligence: { evaluate: llm },
      usageLimitNotice: () => notice,
      confirmSessionUsageLimit: () => false,
      getProcessTree: () => [], isSessionAlive: () => true, getSessionForTopic: () => 'sess-1',
      captureSessionOutput: () => 'Starting up, no banner on this pane yet',
      sendMessage: async (_t: number, text: string) => { sent.push(text); },
      getAuthorizedUserIds: () => [],
    } as any);
    proxy.start();
    const state = {
      topicId: 7, sessionName: 'sess-1', userMessageAt: Date.now() - 30_000, userMessageText: 'hi', userMessageBaselineSnapshot: null,
      tier1FiredAt: null, tier1Snapshot: null, tier1SnapshotHash: null, tier2FiredAt: null, tier2Snapshot: null, tier2SnapshotHash: null,
      tier3FiredAt: null, tier3Assessment: null, tier3Summary: null, tier3RecheckCount: 0, silencedUntil: null, cancelled: false,
      llmCallCount: 0, lastLlmCallAt: 0, conversationHistory: [], lastAckText: null, lastAckAt: null,
    };
    proxy.states.set(7, state);
    return { proxy, sent, state, stateDir };
  };

  it('proven limited: says so, without a model call and without "actively working" (the 2026-11-04 silence)', async () => {
    let calls = 0;
    const { proxy, sent, state, stateDir } = mk(PERSON_LIMITED_TEXT, async () => { calls += 1; return 'x'; });
    await proxy.fireTier1(7, state);
    proxy.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(PERSON_LIMITED_TEXT);
    expect(sent[0]).not.toContain('actively working');
    expect(calls).toBe(0);
  });

  it('not limited: the ordinary path is untouched', async () => {
    const { proxy, sent, state, stateDir } = mk(null, async () => { throw new Error('model down'); });
    await proxy.fireTier1(7, state);
    proxy.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
    expect(sent.join()).not.toContain(PERSON_LIMITED_TEXT);
  });
});

describe('server wiring', () => {
  const server = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
  const block = server.slice(server.indexOf('new UsageLimitWatch({'), server.indexOf('usageLimitWatch.boot();'));

  it('hears the settled wall and failed internal calls', () => {
    expect(server).toContain("watchdog.on('usage-wall', (name: string) => { void usageLimitWatch.noteWall(name); });");
    expect(server).toContain('setClaudeUsageLimitedListener(() => usageLimitWatch.noteCallLimited());');
  });

  it('uses the transcript proof and makes no whole-agent claim while another account has room', () => {
    expect(block).toContain('sessionManager.confirmSessionUsageLimit(name)');
    expect(block).toMatch(/rescue\?\.status\(\)\.effective/);
    expect(block).toContain('rescue.isKnownWalled(a.id)');
    expect(block).toContain('stillWalled: (name) =>');
  });

  it('shares the real notice routes and the same held-message reads as key recovery', () => {
    expect(block).toContain('notifyOperator: noticeToOperator,');
    expect(block).toContain("buildKeyRecoveryPrompt(convo.channel, held, 'usage')");
  });

  it('a conversation on another framework is not told it ran out', () => {
    const at = server.indexOf('usageLimitNotice: (name) => {');
    expect(server.slice(at, at + 300)).toContain("=== 'claude-code' ? (activeUsageLimitWatch()?.personNotice() ?? null) : null");
  });

  it('starts only once the rescue exists', () => {
    expect(server.indexOf('activeUsageLimitWatch()?.start();')).toBeGreaterThan(server.indexOf('_usageWallRescue = new UsageWallRescue({'));
  });

  it('feeds the standby and /health', () => {
    expect(server).toContain('usageLimitNotice: (name) => {');
    expect(fs.readFileSync(path.join(__dirname, '../../src/server/routes.ts'), 'utf8')).toContain('base.claudeUsage = claudeUsage');
  });

  it('existing agents learn of it on update', () => {
    const migrator = fs.readFileSync(path.join(__dirname, '../../src/core/PostUpdateMigrator.ts'), 'utf8');
    expect(migrator).toContain('content.includes(USAGE_LIMIT_WATCH_MARKER)');
    expect(fs.readFileSync(path.join(__dirname, '../../src/scaffold/templates.ts'), 'utf8')).toContain('${USAGE_LIMIT_WATCH_BULLET}');
  });
});
