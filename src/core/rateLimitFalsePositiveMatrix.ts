/**
 * rateLimitFalsePositiveMatrix — the user-role scenario matrix that proves, through
 * the REAL channel, that the rate-limit/error recovery no longer false-fires on a
 * finished or idle session (live incident 2026-06-24). It is the prevention layer the
 * fix needs: a unit test proves the guard logic; THIS proves the user never receives a
 * spurious "throttle resume" nudge end-to-end.
 *
 * It exercises the harness's ABSENCE capability (`absenceWindowMs` +
 * `expect.noMessageMatching`) — the structural way to catch a spurious background
 * message, which a single send→reply assertion cannot. Pairs a happy-path scenario
 * (the agent still replies normally) with the regression absence scenarios so the gate
 * has a load-bearing PASS and the no-false-nudge guarantee in one signed artifact.
 */

import type { HarnessMatrix, HarnessScenario } from './LiveTestHarness.js';
import type { RiskCategory, Surface } from './LiveTestArtifactStore.js';

/** The exact user-facing string the false positive emitted — the thing we assert is ABSENT. */
export const THROTTLE_RESUME_NUDGE_FRAGMENT = 'throttle should have cleared';

export interface RateLimitFalsePositiveOpts {
  featureId?: string;
  telegramTopicId: string;
  slackChannelId?: string;
  /** A benign user message that elicits a normal reply (happy-path) + closes a turn. */
  message?: string;
  /** How long to watch for a spurious nudge after the turn finishes. */
  absenceWindowMs?: number;
  timeoutMs?: number;
}

export function buildRateLimitFalsePositiveMatrix(opts: RateLimitFalsePositiveOpts): HarnessMatrix {
  const featureId = opts.featureId ?? 'rate-limit-false-positive-fix';
  const tg = opts.telegramTopicId;
  const message = opts.message ?? 'Quick check-in — are you there?';
  // Default 90s: a real throttle false-positive fires its FIRST user notice
  // immediately on report() (well inside the window), but the window must also exceed
  // the throttle recovery's first backoff (30s) + verify window (25s) ≈ 55s so a
  // regression that only surfaces at the first resume/verify still lands inside it.
  // (spec-converge finding: a 60s window only barely cleared that ~55s envelope.)
  const absenceWindowMs = opts.absenceWindowMs ?? 90_000;
  const tmo = opts.timeoutMs;
  const t = <T extends Partial<HarnessScenario>>(s: T): T => (tmo ? { ...s, timeoutMs: tmo } : s);

  const scenarios: HarnessScenario[] = [
    // Happy-path: the agent still answers a normal message (the fix must not mute it).
    t({
      id: 'rl-happy-path-normal-reply',
      description: 'happy-path: a normal user message gets a non-empty reply (the recovery guard did not break normal replies)',
      surface: 'telegram',
      riskCategory: 'happy-path',
      volatility: 'safe',
      channelId: tg,
      input: message,
      expect: { replyNotEmpty: true, replyMustNotContain: THROTTLE_RESUME_NUDGE_FRAGMENT },
    }) as HarnessScenario,
    // Regression (absence): after the turn finishes, NO spurious throttle-resume nudge
    // arrives in the topic within the window. This is the exact false positive.
    t({
      id: 'rl-finished-session-no-throttle-nudge',
      description: 'regression: after a session finishes, zero throttle-resume nudges arrive within the window (the live incident)',
      surface: 'telegram',
      riskCategory: 'regression',
      volatility: 'safe',
      channelId: tg,
      input: message,
      absenceWindowMs,
      expect: { noMessageMatching: THROTTLE_RESUME_NUDGE_FRAGMENT },
    }) as HarnessScenario,
  ];

  const surfaces: Surface[] = ['telegram'];
  const riskCategories: RiskCategory[] = ['happy-path', 'regression'];

  // Channel parity: the same no-spurious-nudge guarantee must hold on Slack.
  if (opts.slackChannelId) {
    scenarios.push(
      t({
        id: 'rl-slack-parity-no-throttle-nudge',
        description: 'channel-parity: Slack also emits no spurious throttle-resume nudge after a finished session',
        surface: 'slack',
        riskCategory: 'channel-parity',
        volatility: 'safe',
        channelId: opts.slackChannelId,
        input: message,
        absenceWindowMs,
        expect: { noMessageMatching: THROTTLE_RESUME_NUDGE_FRAGMENT },
      }) as HarnessScenario,
    );
    surfaces.push('slack');
    riskCategories.push('channel-parity');
  }

  return { featureId, surfaces, riskCategories, scenarios };
}
