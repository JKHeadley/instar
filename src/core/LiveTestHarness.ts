/**
 * LiveTestHarness — the user-role live-test runner (spec
 * docs/specs/live-user-channel-proof-standard.md §5). It drives a feature
 * end-to-end AS THE USER through the real surface (Telegram AND Slack for a channel
 * feature), recording a signed PASS/FAIL scenario matrix as the artifact the
 * completion gate reads.
 *
 * This module is the harness CORE: it runs a scenario matrix over an INJECTED
 * `ChannelDriver` (send / awaitReply / isDemoChannel), so it is unit-testable with a
 * fake driver. The REAL Telegram + Slack drivers (real-account drive, §5.4, demo
 * channels) and the Playwright dashboard driver wire into this same interface.
 *
 * Structural safety (§5.3): a volatile/permission scenario is REFUSED before any
 * send unless its target channel is a demo channel — a structural throw, not a
 * convention, so a destructive scenario can never touch the live operator channel.
 *
 * Determinism (§5.6/§4.4): the PASS/FAIL verdict rests on DETERMINISTIC protocol
 * evidence (the reply text + the responder machine id captured from the real
 * platform), not a fuzzy judgment. (An optional Tier-1 semantic supervisor for
 * natural-language expectations is a follow-on; the core encodes exact checks.)
 */

import type {
  LiveTestArtifact, LiveTestArtifactStore, RiskCategory, ScenarioRow, Surface,
} from './LiveTestArtifactStore.js';

export interface SendResult { messageId: string }
export interface ReplyResult { text: string; messageId: string; responderMachineId?: string }

/** The injected channel transport — a real adapter (Telegram/Slack) OR a fake. */
export interface ChannelDriver {
  /** Whether (surface, channelId) is a registered demo channel (§5.3 isolation). */
  isDemoChannel(surface: Surface, channelId: string): boolean;
  /** Send a user message on the real surface. */
  send(surface: Surface, channelId: string, text: string): Promise<SendResult>;
  /** Await the agent's reply (resolves null on timeout). */
  awaitReply(surface: Surface, channelId: string, opts: { timeoutMs: number; afterMessageId?: string }): Promise<ReplyResult | null>;
  /**
   * OPTIONAL — collect EVERY message that lands on the channel within a window
   * (after `afterMessageId`). Backs ABSENCE assertions: "after X, no message
   * matching <pattern> arrives within the window". A single awaitReply can't prove
   * absence (it returns the first reply, and a spurious background nudge may land
   * AFTER a legitimate reply). A driver that does not implement this makes an
   * absence scenario BLOCKED (driver-unsupported), never a silent pass. The fix
   * this enables to test: a finished session must emit ZERO throttle-resume nudges
   * (live incident 2026-06-24).
   */
  collectMessages?(surface: Surface, channelId: string, opts: { windowMs: number; afterMessageId?: string }): Promise<ReplyResult[]>;
}

export type Volatility = 'safe' | 'volatile' | 'permission';

export interface HarnessScenario {
  id: string;
  description: string;
  surface: Surface;
  riskCategory: RiskCategory;
  volatility: Volatility;
  channelId: string;
  /** The user message to send. */
  input: string;
  /**
   * Deterministic expectations checked against the captured reply (or, for an
   * absence scenario, against every message collected over `absenceWindowMs`).
   * - replyContains / replyNotEmpty / responderMachine: assert the reply.
   * - replyMustNotContain: the (first) reply must NOT contain this substring.
   * - noMessageMatching: ABSENCE — paired with `absenceWindowMs`, asserts NO
   *   message landing on the channel within the window contains this substring.
   */
  expect: {
    replyContains?: string;
    replyNotEmpty?: boolean;
    responderMachine?: string;
    replyMustNotContain?: string;
    noMessageMatching?: string;
  };
  /**
   * When set, this is an ABSENCE scenario: after sending `input`, the harness
   * collects every message on the channel for this many ms and asserts none match
   * `expect.noMessageMatching`. Requires a driver implementing `collectMessages`.
   */
  absenceWindowMs?: number;
  timeoutMs?: number;
}

export interface HarnessMatrix {
  featureId: string;
  surfaces: Surface[];
  riskCategories: RiskCategory[];
  scenarios: HarnessScenario[];
}

export interface LiveTestHarnessDeps {
  store: LiveTestArtifactStore;
  driver: ChannelDriver;
  runnerFingerprint: string;
  /** Bounded retries on a reply timeout before recording FAIL (§5.5 flake mgmt). */
  maxReplyRetries?: number;
  defaultTimeoutMs?: number;
  now?: () => number;
  logger?: (m: string) => void;
}

export class HarnessVolatileChannelError extends Error {
  constructor(scenarioId: string, surface: Surface, channelId: string) {
    super(`refusing volatile/permission scenario "${scenarioId}" on non-demo channel ${surface}:${channelId} (§5.3 — volatile scenarios run only on demo channels)`);
    this.name = 'HarnessVolatileChannelError';
  }
}

export class LiveTestHarness {
  private readonly d: LiveTestHarnessDeps;

  constructor(deps: LiveTestHarnessDeps) {
    this.d = deps;
  }

  private now(): number { return (this.d.now ?? Date.now)(); }
  private log(m: string): void { this.d.logger?.(`[live-test-harness] ${m}`); }

  /**
   * Run the scenario matrix and write the signed artifact. `runId` lets the caller
   * pin a stable id (defaults to a now-stamped id). THROWS HarnessVolatileChannelError
   * if any volatile/permission scenario targets a non-demo channel (fail-fast, before
   * any send) — the §5.3 structural guard.
   */
  async run(matrix: HarnessMatrix, opts: { runId?: string } = {}): Promise<{ artifact: LiveTestArtifact; entry: ReturnType<LiveTestArtifactStore['write']> }> {
    // §5.3 PRE-FLIGHT: refuse the whole run if a volatile/permission scenario points
    // at a non-demo channel — before a single message is sent.
    for (const s of matrix.scenarios) {
      if (s.volatility !== 'safe' && !this.d.driver.isDemoChannel(s.surface, s.channelId)) {
        throw new HarnessVolatileChannelError(s.id, s.surface, s.channelId);
      }
    }

    const rows: ScenarioRow[] = [];
    for (const s of matrix.scenarios) {
      rows.push(await this.runScenario(s));
    }

    const runId = opts.runId ?? `run-${this.now()}`;
    const artifact: LiveTestArtifact = {
      featureId: matrix.featureId,
      runId,
      surfaces: matrix.surfaces,
      riskCategories: matrix.riskCategories,
      scenarios: rows,
      createdAt: new Date(this.now()).toISOString(),
      runnerFingerprint: this.d.runnerFingerprint,
    };
    const entry = this.d.store.write(artifact);
    return { artifact, entry };
  }

  private async runScenario(s: HarnessScenario): Promise<ScenarioRow> {
    const timeoutMs = s.timeoutMs ?? this.d.defaultTimeoutMs ?? 30_000;
    const maxRetries = this.d.maxReplyRetries ?? 2;
    const base: ScenarioRow = { id: s.id, description: s.description, surface: s.surface, riskCategory: s.riskCategory, verdict: 'FAIL' };

    // ── ABSENCE scenario: assert NO message matching the pattern lands within the
    // window (the structural way to catch a spurious background message — e.g. a
    // throttle-resume nudge fired against a finished session).
    if (s.absenceWindowMs != null) {
      const pattern = s.expect.noMessageMatching;
      if (!pattern) {
        return { ...base, verdict: 'BLOCKED', blockedKind: 'operator-waiver', blockedReason: 'absence scenario missing expect.noMessageMatching' };
      }
      if (!this.d.driver.collectMessages) {
        // Never silently pass — an absence assertion an unsupported driver cannot
        // make is BLOCKED with a named reason, not a PASS.
        return { ...base, verdict: 'BLOCKED', blockedKind: 'platform-error', blockedReason: 'driver does not support collectMessages (absence assertion unverifiable)' };
      }
      try {
        const sent = await this.d.driver.send(s.surface, s.channelId, s.input);
        const collected = await this.d.driver.collectMessages(s.surface, s.channelId, { windowMs: s.absenceWindowMs, afterMessageId: sent.messageId });
        const offending = collected.find(m => m.text.includes(pattern));
        const evidence = { channelId: s.channelId, messageIds: [sent.messageId, ...collected.map(m => m.messageId)] };
        if (offending) {
          this.log(`scenario ${s.id} FAIL: spurious message matched "${pattern}": ${JSON.stringify(offending.text.slice(0, 120))}`);
          return { ...base, verdict: 'FAIL', evidence, blockedReason: `spurious message matched "${pattern}"` };
        }
        return { ...base, verdict: 'PASS', evidence };
      } catch (err) {
        // @silent-fallback-ok: not a silent fallback — a driver error is SURFACED as a
        // FAIL verdict (with the error in blockedReason) that the LiveTestGate consumes
        // and VETOES on. The error is escalated, not swallowed; this is the loud path.
        return { ...base, verdict: 'FAIL', blockedReason: `driver error: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    try {
      const sent = await this.d.driver.send(s.surface, s.channelId, s.input);
      let reply: ReplyResult | null = null;
      for (let attempt = 0; attempt <= maxRetries && !reply; attempt++) {
        reply = await this.d.driver.awaitReply(s.surface, s.channelId, { timeoutMs, afterMessageId: sent.messageId });
      }
      if (!reply) {
        // §5.5: a generic timeout is FAIL (not auto-BLOCKED — that needs an
        // independently-attributed platform outage).
        return { ...base, verdict: 'FAIL', evidence: { channelId: s.channelId, messageIds: [sent.messageId] }, blockedReason: 'no reply within timeout' };
      }
      const evidence = { channelId: s.channelId, messageIds: [sent.messageId, reply.messageId], responderMachineId: reply.responderMachineId };
      // Deterministic assertions (§4.4 protocol evidence is the verdict, not a guess).
      const failures: string[] = [];
      if (s.expect.replyContains && !reply.text.includes(s.expect.replyContains)) failures.push(`reply missing "${s.expect.replyContains}"`);
      if (s.expect.replyNotEmpty && reply.text.trim() === '') failures.push('reply empty');
      if (s.expect.replyMustNotContain && reply.text.includes(s.expect.replyMustNotContain)) failures.push(`reply unexpectedly contained "${s.expect.replyMustNotContain}"`);
      if (s.expect.responderMachine && reply.responderMachineId !== s.expect.responderMachine) failures.push(`responder ${reply.responderMachineId ?? 'unknown'} ≠ expected ${s.expect.responderMachine}`);
      if (failures.length) {
        this.log(`scenario ${s.id} FAIL: ${failures.join('; ')}`);
        return { ...base, verdict: 'FAIL', evidence, blockedReason: failures.join('; ') };
      }
      return { ...base, verdict: 'PASS', evidence };
    } catch (err) {
      // A driver error is a FAIL with the reason (never a silent skip).
      return { ...base, verdict: 'FAIL', blockedReason: `driver error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
