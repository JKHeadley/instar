/**
 * SessionRefresh × SwapWorkGate — the §4.2 chokepoint behavior
 * (docs/specs/swap-continuity-antithrash.md §4.2/§4.3/§4.5).
 *
 * The gate binds the PRIMITIVE (refreshSession), not a caller list. Both
 * sides of every caller-class boundary:
 *   - interactive (the DEFAULT for unlisted callers): busy → structured
 *     `session-busy` refusal, nothing killed; force:true → proceeds WITH the
 *     mitigation payload; idle → today's behavior byte-for-byte
 *   - proactive-swap: busy → refusal (the monitor owns the deferral)
 *   - reactive-swap: busy → bounded grace, executes at the FIRST not-busy
 *     observation; permanently busy → proceeds at the deadline WITH mitigations
 *   - recovery: exempt — never gated even when busy
 *   - dryRun: logs only, changes nothing
 *   - gate-before-rate-guard: a refused attempt consumes ZERO rate budget
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRefresh, type SwapContinuityGateContext } from '../../src/core/SessionRefresh.js';
import type { WorkProbeResult } from '../../src/core/SwapWorkGate.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { TopicResumeMap } from '../../src/core/TopicResumeMap.js';

const T0 = Date.parse('2026-07-02T15:00:00Z');

function busyProbe(over: Partial<WorkProbeResult> = {}): WorkProbeResult {
  return {
    busy: true,
    turnLeg: 'working',
    subagentLeg: 'ok',
    turnInFlight: true,
    subagents: [{ agentType: 'general-purpose', ageMinutes: 12 }],
    reason: 'busy-turn',
    ...over,
  };
}

function idleProbe(): WorkProbeResult {
  return { busy: false, turnLeg: 'idle', subagentLeg: 'ok', turnInFlight: false, subagents: [], reason: null };
}

function makeHarness(over: {
  probes?: Array<WorkProbeResult | 'throw'>;
  knobs?: Partial<ReturnType<SwapContinuityGateContext['getKnobs']>>;
  inbound?: Parameters<NonNullable<SwapContinuityGateContext['resolveUnansweredInbound']>>[0] extends never
    ? never
    : import('../../src/core/SwapWorkGate.js').MitigationInbound | 'none' | 'unknown';
  noGate?: boolean;
  rateLimit?: { maxPerWindow: number; windowMs: number };
} = {}) {
  let nowMs = T0;
  const clock = () => nowMs;
  const advance = (ms: number) => {
    nowMs += ms;
  };

  const probes = over.probes ?? [busyProbe()];
  let probeIdx = 0;
  const probe = vi.fn(async () => {
    const p = probes[Math.min(probeIdx, probes.length - 1)]!;
    probeIdx += 1;
    if (p === 'throw') throw new Error('probe machinery failed');
    return p;
  });

  const recordProceeded = vi.fn();
  const recordInteractiveRefusal = vi.fn();
  const wait = vi.fn(async (ms: number) => {
    advance(ms);
  });

  const workGateCtx: SwapContinuityGateContext = {
    probe,
    getKnobs: () => ({
      enabled: true,
      dryRun: false,
      reactiveGraceMs: 120_000,
      recheckMs: 10_000,
      ...over.knobs,
    }),
    recordProceeded,
    recordInteractiveRefusal,
    resolveUnansweredInbound: () => over.inbound ?? 'none',
    wait,
  };

  const killSession = vi.fn().mockReturnValue(true);
  const respawner = vi.fn(async () => 'new-tmux');
  const refresh = new SessionRefresh({
    sessionManager: { killSession } as unknown as SessionManager,
    state: {
      listSessions: vi
        .fn()
        .mockReturnValue([{ id: 'state-1', tmuxSession: 'echo-build', subscriptionAccountId: 'acct-a' }]),
    } as unknown as StateManager,
    telegram: { getTopicForSession: vi.fn().mockReturnValue(42) } as unknown as TelegramAdapter,
    topicResumeMap: { findUuidForSession: vi.fn(), save: vi.fn(), remove: vi.fn() } as unknown as TopicResumeMap,
    respawner,
    workGateCtx: over.noGate ? null : workGateCtx,
    rateLimit: over.rateLimit,
    clock,
  });

  return { refresh, respawner, killSession, probe, recordProceeded, recordInteractiveRefusal, wait, advance };
}

describe('SessionRefresh work gate (§4.2)', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('interactive-refresh (the default caller class)', () => {
    it('busy → structured session-busy refusal with the live work summary; NOTHING killed', async () => {
      const { refresh, respawner, killSession, recordInteractiveRefusal } = makeHarness();
      const r = await refresh.refreshSession({ sessionName: 'echo-build' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('session-busy');
        expect(r.turnInFlight).toBe(true);
        expect(r.subagents).toEqual([{ agentType: 'general-purpose', ageMinutes: 12 }]);
      }
      expect(killSession).not.toHaveBeenCalled();
      expect(respawner).not.toHaveBeenCalled();
      expect(recordInteractiveRefusal).toHaveBeenCalledOnce();
    });

    it('an ABSENT subagent leg is surfaced honestly: subagentLeg present, subagents OMITTED (R5-M1)', async () => {
      const { refresh } = makeHarness({
        probes: [busyProbe({ turnLeg: 'idle', turnInFlight: false, subagentLeg: 'absent', subagents: null, reason: 'busy-indeterminate' })],
      });
      const r = await refresh.refreshSession({ sessionName: 'echo-build' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('session-busy');
        expect(r.subagentLeg).toBe('absent');
        expect(r.subagents).toBeUndefined();
      }
    });

    it('force:true → proceeds OVER busy work WITH the mitigation payload appended (§4.5/§4.3)', async () => {
      const { refresh, respawner, killSession, recordProceeded } = makeHarness({
        inbound: { body: 'status?', from: 'justin' },
      });
      const r = await refresh.refreshSession({ sessionName: 'echo-build', followUpPrompt: 'continue', force: true });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.proceededOverBusy).toBe(true);
      expect(killSession).toHaveBeenCalled();
      const prompt = (respawner.mock.calls[0] as unknown[])[2] as string;
      expect(prompt).toContain('continue');
      expect(prompt).toContain('interrupted 1 running subagent');
      expect(prompt).toContain('«status?»');
      expect(recordProceeded).toHaveBeenCalledOnce();
      expect(recordProceeded.mock.calls[0]![0]).toMatchObject({ force: true, kind: 'interactive', inbound: 'reinjected' });
    });

    it('idle → today\'s behavior byte-for-byte (gate releases)', async () => {
      const { refresh, respawner } = makeHarness({ probes: [idleProbe()] });
      const r = await refresh.refreshSession({ sessionName: 'echo-build' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.proceededOverBusy).toBeUndefined();
      expect(respawner).toHaveBeenCalledOnce();
    });

    it('gate-before-rate-guard: a busy refusal consumes ZERO rate budget (§4.2)', async () => {
      const { refresh, respawner } = makeHarness({
        probes: [busyProbe(), busyProbe(), idleProbe()],
        rateLimit: { maxPerWindow: 1, windowMs: 600_000 },
      });
      // Two busy refusals — with the old order these would exhaust the budget.
      expect((await refresh.refreshSession({ sessionName: 'echo-build' })).ok).toBe(false);
      expect((await refresh.refreshSession({ sessionName: 'echo-build' })).ok).toBe(false);
      // The work landed → the ONE budgeted refresh still goes through.
      const r = await refresh.refreshSession({ sessionName: 'echo-build' });
      expect(r.ok).toBe(true);
      expect(respawner).toHaveBeenCalledOnce();
    });
  });

  describe('proactive-swap caller class', () => {
    it('busy → refusal (the monitor owns the deferral lifecycle); nothing killed', async () => {
      const { refresh, killSession } = makeHarness();
      const r = await refresh.refreshSession({ sessionName: 'echo-build', callerClass: 'proactive-swap' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('session-busy');
      expect(killSession).not.toHaveBeenCalled();
    });

    it('idle → the swap executes', async () => {
      const { refresh, respawner } = makeHarness({ probes: [idleProbe()] });
      const r = await refresh.refreshSession({ sessionName: 'echo-build', callerClass: 'proactive-swap' });
      expect(r.ok).toBe(true);
      expect(respawner).toHaveBeenCalledOnce();
    });
  });

  describe('reactive-swap caller class (§4.2 grace)', () => {
    it('executes at the FIRST not-busy observation — never sits out the full grace, no mitigations', async () => {
      const { refresh, respawner, recordProceeded, wait } = makeHarness({
        probes: [busyProbe(), busyProbe(), idleProbe()],
      });
      const r = await refresh.refreshSession({ sessionName: 'echo-build', callerClass: 'reactive-swap' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.proceededOverBusy).toBeUndefined(); // clean swap — work landed
      expect(respawner).toHaveBeenCalledOnce();
      expect(recordProceeded).not.toHaveBeenCalled();
      expect(wait.mock.calls.length).toBe(2); // two 10s re-checks, not the full 120s
    });

    it('permanently busy → proceeds AT the deadline WITH the mitigation payload (never refused, never stranded)', async () => {
      const { refresh, respawner, recordProceeded } = makeHarness({
        probes: [busyProbe()],
        inbound: 'unknown',
      });
      const r = await refresh.refreshSession({
        sessionName: 'echo-build',
        followUpPrompt: 'resume',
        callerClass: 'reactive-swap',
        accountId: 'acct-b',
        configHome: '/h/.claude-b',
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.proceededOverBusy).toBe(true);
      const prompt = (respawner.mock.calls[0] as unknown[])[2] as string;
      expect(prompt).toContain('interrupted 1 running subagent');
      expect(prompt).toContain('unanswered-inbound state was unavailable');
      expect(recordProceeded).toHaveBeenCalledOnce();
      expect(recordProceeded.mock.calls[0]![0]).toMatchObject({
        kind: 'reactive',
        from: 'acct-a',
        to: 'acct-b',
        inbound: 'unknown',
      });
    });
  });

  describe('recovery caller class + dark/dry-run', () => {
    it('recovery is EXEMPT — a wedged pane never deadlocks recovery (§4.2)', async () => {
      const { refresh, respawner, probe } = makeHarness({ probes: [busyProbe()] });
      const r = await refresh.refreshSession({ sessionName: 'echo-build', callerClass: 'recovery' });
      expect(r.ok).toBe(true);
      expect(respawner).toHaveBeenCalledOnce();
      expect(probe).not.toHaveBeenCalled();
    });

    it('dryRun logs the would-decision and changes NOTHING', async () => {
      const { refresh, respawner } = makeHarness({ probes: [busyProbe()], knobs: { dryRun: true } });
      const r = await refresh.refreshSession({ sessionName: 'echo-build' });
      expect(r.ok).toBe(true);
      expect(respawner).toHaveBeenCalledOnce();
    });

    it('no gate wired (dark install) → byte-for-byte today\'s behavior', async () => {
      const { refresh, respawner } = makeHarness({ noGate: true, probes: [busyProbe()] });
      const r = await refresh.refreshSession({ sessionName: 'echo-build' });
      expect(r.ok).toBe(true);
      expect(respawner).toHaveBeenCalledOnce();
    });

    it('a THROWING probe resolves busy for the interactive default (I7 — uncertainty is never a license to kill)', async () => {
      const { refresh, killSession } = makeHarness({ probes: ['throw'] });
      const r = await refresh.refreshSession({ sessionName: 'echo-build' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('session-busy');
      expect(killSession).not.toHaveBeenCalled();
    });
  });

  describe('precheckInteractiveBusy (§4.5 pre-202)', () => {
    it('busy → the 409 payload shape (counts + ages only); idle → null', async () => {
      const { refresh } = makeHarness({ probes: [busyProbe(), idleProbe()] });
      const busy = await refresh.precheckInteractiveBusy('echo-build');
      expect(busy).not.toBeNull();
      expect(busy!.turnInFlight).toBe(true);
      expect(busy!.subagents).toEqual([{ agentType: 'general-purpose', ageMinutes: 12 }]);
      expect(await refresh.precheckInteractiveBusy('echo-build')).toBeNull();
    });

    it('dryRun / dark → null (the route stays pre-change 202)', async () => {
      const { refresh } = makeHarness({ probes: [busyProbe()], knobs: { dryRun: true } });
      expect(await refresh.precheckInteractiveBusy('echo-build')).toBeNull();
      const { refresh: dark } = makeHarness({ noGate: true });
      expect(await dark.precheckInteractiveBusy('echo-build')).toBeNull();
    });

    it('absent subagent leg → subagentLeg surfaced, subagents omitted', async () => {
      const { refresh } = makeHarness({
        probes: [busyProbe({ turnLeg: 'idle', turnInFlight: false, subagentLeg: 'absent', subagents: null, reason: 'busy-indeterminate' })],
      });
      const busy = await refresh.precheckInteractiveBusy('echo-build');
      expect(busy!.subagentLeg).toBe('absent');
      expect(busy!.subagents).toBeUndefined();
    });
  });
});
