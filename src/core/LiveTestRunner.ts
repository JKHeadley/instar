/**
 * LiveTestRunner — the orchestrator that APPLIES the live-user-channel-proof standard
 * to the cross-machine transfer (docs/specs/live-user-channel-proof-standard.md §6 —
 * the first feature held to the bar). It encodes the capstone flow that a user-role
 * session runs:
 *
 *   1. MOVE THE SEAT FIRST — transfer the (throwaway) topic to the target machine.
 *      If the transfer reports the seat did NOT move, the capstone premise is false and
 *      we stop loudly (that "ok:true but moved nothing" lie is the original bug — we
 *      refuse to paper over it).
 *   2. Then run the LiveTestHarness over a scenario matrix that sends a real message
 *      through each channel and asserts the reply was served FROM the target machine
 *      (the `responderMachine` expectation — the deterministic cross-machine proof).
 *
 * This module is pure orchestration over the injected harness + an injected `transfer`
 * action, so it is unit-testable with fakes. The server.ts route wires the real
 * RealChannelDriver (real senders + placement reader) into the harness and the real
 * `POST /pool/transfer` into `transfer`.
 *
 * Honesty contract: a non-moved seat THROWS (never records a misleading PASS); a moved
 * seat that then fails to reply-from-target is a normal harness FAIL (recorded with the
 * responder mismatch). The artifact only ever shows PASS when the seat moved AND the
 * reply genuinely came from the target machine.
 */

import type { LiveTestHarness, HarnessMatrix, HarnessScenario } from './LiveTestHarness.js';
import type { Surface } from './LiveTestArtifactStore.js';

export interface TransferResult {
  /** Did the seat genuinely move (the honest signal, NOT a bare ok:true)? */
  seatMoved: boolean;
  detail?: string;
}

export interface MultiMachineCapstoneOpts {
  featureId?: string;
  /** The machine the seat must move to (e.g. the Mini's machine id) — also the expected responder. */
  targetMachine: string;
  /** The throwaway Telegram topic id (also the placement key the responder reader uses). */
  telegramTopicId: string;
  /** Optional Slack channel id for the Slack half of the Telegram-AND-Slack bar. */
  slackChannelId?: string;
  /** The real transfer action (server.ts injects POST /pool/transfer). MUST report seatMoved honestly. */
  transfer: (topicId: string, toMachine: string) => Promise<TransferResult>;
  /** The user message to send (default a benign probe). */
  message?: string;
  timeoutMs?: number;
  runId?: string;
}

export class LiveTestRunnerError extends Error {
  constructor(message: string) { super(message); this.name = 'LiveTestRunnerError'; }
}

export class LiveTestRunner {
  constructor(private readonly deps: { harness: LiveTestHarness; logger?: (m: string) => void }) {}

  private log(m: string): void { this.deps.logger?.(`[live-test-runner] ${m}`); }

  /**
   * Run the multi-machine transfer capstone. Throws LiveTestRunnerError if the seat did
   * not move (the capstone cannot meaningfully run). Otherwise returns the harness
   * artifact (PASS only when the reply came FROM `targetMachine`).
   */
  async runMultiMachineTransferCapstone(opts: MultiMachineCapstoneOpts) {
    // 1. Move the seat FIRST — and demand the honest seatMoved signal.
    const t = await opts.transfer(opts.telegramTopicId, opts.targetMachine);
    if (!t.seatMoved) {
      throw new LiveTestRunnerError(
        `transfer to ${opts.targetMachine} did not move the seat (${t.detail ?? 'seatMoved=false'}) — ` +
        `capstone cannot run (refusing to record a misleading PASS over a non-move)`,
      );
    }
    this.log(`seat moved to ${opts.targetMachine}; running channel scenarios`);

    // 2. Build the matrix — each channel asserts the reply was served FROM targetMachine.
    const message = (opts.message ?? `live-test probe ${opts.runId ?? ''}`).trim();
    const surfaces: Surface[] = opts.slackChannelId ? ['telegram', 'slack'] : ['telegram'];
    const scenarios: HarnessScenario[] = [
      {
        id: 'mm-transfer-telegram-reply-from-target',
        description: `after transfer to ${opts.targetMachine}, the Telegram reply is served FROM it`,
        surface: 'telegram',
        riskCategory: 'happy-path',
        volatility: 'safe',
        channelId: opts.telegramTopicId,
        input: message,
        expect: { replyNotEmpty: true, responderMachine: opts.targetMachine },
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      },
    ];
    if (opts.slackChannelId) {
      scenarios.push({
        id: 'mm-transfer-slack-reply-from-target',
        description: `after transfer to ${opts.targetMachine}, the Slack reply is served FROM it (channel parity)`,
        surface: 'slack',
        riskCategory: 'channel-parity',
        volatility: 'safe',
        channelId: opts.slackChannelId,
        input: message,
        expect: { replyNotEmpty: true, responderMachine: opts.targetMachine },
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      });
    }

    const matrix: HarnessMatrix = {
      featureId: opts.featureId ?? 'multi-machine-transfer',
      surfaces,
      riskCategories: opts.slackChannelId ? ['happy-path', 'channel-parity'] : ['happy-path'],
      scenarios,
    };
    return this.deps.harness.run(matrix, opts.runId ? { runId: opts.runId } : {});
  }
}
