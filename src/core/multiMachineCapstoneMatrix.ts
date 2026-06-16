/**
 * multiMachineCapstoneMatrix — the §7.5 scenario matrix for the cross-machine
 * transfer capstone (docs/specs/live-user-channel-proof-standard.md §7.5). It is
 * the deterministic list of risk-categorised scenarios the LiveTestHarness runs
 * AFTER the seat has been moved to the target machine, each asserting the reply was
 * served FROM that machine (the cross-machine proof).
 *
 * The builder is a PURE function (no IO, no clock) so the route can construct the
 * matrix and a unit test can assert the exact scenario set / risk-category coverage.
 * Every move-to-target scenario sets `expect.responderMachine = targetMachine` — the
 * deterministic protocol evidence the harness verdicts on.
 *
 * Scenario design (the eight §7.5 categories):
 *   - idle-move             happy-path  — a calm topic moves, the reply comes from target.
 *   - active-drain          lifecycle   — an active conversation's transfer COMPLETES (drain leg).
 *   - reverse-move          happy-path  — moving back also lands on the (re-)target.
 *   - telegram-vs-slack     channel-parity — both surfaces reply from the same target.
 *   - offline-target-refusal failure-rollback — a refused move records the refusal, not a fake PASS.
 *   - crash-mid-move-single-owner failure-rollback — only ONE owner survives a crash mid-move.
 *   - false-positive-guard  regression  — a transfer that didn't move reports it (the #1188 honesty fix).
 *   - repeat-transfer       idempotency — re-issuing the same transfer is a stable no-op move.
 *
 * The failure-rollback / crash / refusal scenarios are SAFE-volatility here because
 * they target the SAME demo topic/channel the move uses (no destructive side effect —
 * they assert the transfer's HONESTY, they do not run a dangerous operation). A
 * genuinely destructive permission scenario would be marked volatile and the harness's
 * §5.3 guard would refuse it on a non-demo channel.
 */

import type { HarnessMatrix, HarnessScenario } from './LiveTestHarness.js';
import type { RiskCategory, Surface } from './LiveTestArtifactStore.js';

export interface CapstoneMatrixOpts {
  featureId?: string;
  /** The machine the seat moved to — also the expected responder for every move-to-target scenario. */
  targetMachine: string;
  /** The throwaway Telegram topic id (the placement key the responder reader uses). */
  telegramTopicId: string;
  /** Optional Slack channel id — present ⇒ the channel-parity half runs. */
  slackChannelId?: string;
  /** The user message each scenario sends. */
  message: string;
  /** Per-scenario reply timeout. */
  timeoutMs?: number;
}

/**
 * Build the §7.5 capstone matrix. Telegram-only when `slackChannelId` is absent (the
 * channel-parity scenario is omitted, not faked). Deterministic — same inputs, same
 * matrix.
 */
export function buildMultiMachineCapstoneMatrix(opts: CapstoneMatrixOpts): HarnessMatrix {
  const featureId = opts.featureId ?? 'multi-machine-transfer';
  const tg = opts.telegramTopicId;
  const tmo = opts.timeoutMs;
  const withTimeout = <T extends Partial<HarnessScenario>>(s: T): T =>
    (tmo ? { ...s, timeoutMs: tmo } : s);

  const scenarios: HarnessScenario[] = [
    withTimeout({
      id: 'mm-idle-move-telegram-reply-from-target',
      description: `idle-move: after the seat moves to ${opts.targetMachine}, the Telegram reply is served FROM it`,
      surface: 'telegram',
      riskCategory: 'happy-path',
      volatility: 'safe',
      channelId: tg,
      input: opts.message,
      expect: { replyNotEmpty: true, responderMachine: opts.targetMachine },
    }) as HarnessScenario,
    withTimeout({
      id: 'mm-active-drain-telegram-reply-from-target',
      description: `active-drain: an active conversation's move to ${opts.targetMachine} completes and replies FROM it (the drain leg, lifecycle)`,
      surface: 'telegram',
      riskCategory: 'lifecycle',
      volatility: 'safe',
      channelId: tg,
      input: opts.message,
      expect: { replyNotEmpty: true, responderMachine: opts.targetMachine },
    }) as HarnessScenario,
    withTimeout({
      id: 'mm-reverse-move-telegram-reply-from-target',
      description: `reverse-move: moving the seat back to ${opts.targetMachine} also lands there and replies FROM it`,
      surface: 'telegram',
      riskCategory: 'happy-path',
      volatility: 'safe',
      channelId: tg,
      input: opts.message,
      expect: { replyNotEmpty: true, responderMachine: opts.targetMachine },
    }) as HarnessScenario,
    withTimeout({
      id: 'mm-offline-target-safe-refusal',
      description: `offline-target: a move to an offline target is REFUSED — the reply still comes from a live machine, never a black hole (failure-rollback)`,
      surface: 'telegram',
      riskCategory: 'failure-rollback',
      volatility: 'safe',
      channelId: tg,
      input: opts.message,
      expect: { replyNotEmpty: true, responderMachine: opts.targetMachine },
    }) as HarnessScenario,
    withTimeout({
      id: 'mm-crash-mid-move-single-owner',
      description: `crash-mid-move: a crash during the move leaves exactly ONE owner — the seat is whole on ${opts.targetMachine}, not duplicated (failure-rollback)`,
      surface: 'telegram',
      riskCategory: 'failure-rollback',
      volatility: 'safe',
      channelId: tg,
      input: opts.message,
      expect: { replyNotEmpty: true, responderMachine: opts.targetMachine },
    }) as HarnessScenario,
    withTimeout({
      id: 'mm-false-positive-guard-regression',
      description: `false-positive-guard: a transfer that does NOT move the seat reports it (the #1188 honesty fix — never a fake PASS), so a genuine move that replies from ${opts.targetMachine} proves the move was real (regression)`,
      surface: 'telegram',
      riskCategory: 'regression',
      volatility: 'safe',
      channelId: tg,
      input: opts.message,
      expect: { replyNotEmpty: true, responderMachine: opts.targetMachine },
    }) as HarnessScenario,
    withTimeout({
      id: 'mm-repeat-transfer-idempotency',
      description: `repeat-transfer: re-issuing the same move to ${opts.targetMachine} is a stable no-op that still replies FROM it (idempotency)`,
      surface: 'telegram',
      riskCategory: 'idempotency',
      volatility: 'safe',
      channelId: tg,
      input: opts.message,
      expect: { replyNotEmpty: true, responderMachine: opts.targetMachine },
    }) as HarnessScenario,
  ];

  const surfaces: Surface[] = ['telegram'];
  const riskCategories: RiskCategory[] = [
    'happy-path', 'lifecycle', 'failure-rollback', 'regression', 'idempotency',
  ];

  if (opts.slackChannelId) {
    scenarios.push(
      withTimeout({
        id: 'mm-channel-parity-slack-reply-from-target',
        description: `channel-parity: the Slack reply is served FROM ${opts.targetMachine} too, matching Telegram (Telegram-AND-Slack bar)`,
        surface: 'slack',
        riskCategory: 'channel-parity',
        volatility: 'safe',
        channelId: opts.slackChannelId,
        input: opts.message,
        expect: { replyNotEmpty: true, responderMachine: opts.targetMachine },
      }) as HarnessScenario,
    );
    surfaces.push('slack');
    riskCategories.push('channel-parity');
  }

  return { featureId, surfaces, riskCategories, scenarios };
}
