/**
 * The review driver's recording mode (docs/specs/frontier-design-review-standard.md §3):
 * ONE run that attempts every reviewer the module knows and returns a report the
 * server records. Only this mode can make a record; a single hand-picked
 * `--family` pass cannot.
 *
 *  - The credential guard runs over the design text first; a live secret stops
 *    the whole run before anything is sent, same-door pass included (decision 10).
 *  - The same-door (Claude) pass asks for the design model whatever the config's
 *    reviewer-model override says, because that pass is also the evidence of plan
 *    access; if the design model is refused it runs once more on the door's
 *    default model (decision 12). Where the standard is on it is enabled unless
 *    `specConverge.reviewers.anthropic.enabled` is explicitly false; where it is
 *    off, the family's existing gating applies.
 *  - An outside family runs only when its first-party CLI is one of the agent's
 *    enabled frameworks (decision 10); otherwise its row is `unavailable/disabled`.
 *  - Every family gets a row, so "never attempted" and "not available" cannot be
 *    confused. Nothing here records the framework-activation baseline.
 *
 * The feedback executor's code reviews call the reviewer module without this
 * mode and record nothing.
 */

import crypto from 'node:crypto';
import {
  CLAUDE_REVIEWER_EXPLICIT_MODELS,
  CLAUDE_REVIEWER_FRONTIER_MODELS,
  SUPPORTED_REVIEWER_FRAMEWORKS,
  isAnthropicReviewerEnabled,
  runCrossModelReview,
  type AssembledPrompt,
  type CrossModelDetectInputs,
  type CrossModelDetectionResult,
  type ReviewerConfig,
  type ReviewerResult,
} from './crossModelReviewer.js';
import { detectOutboundCredential } from '../messaging/outbound-credential-guard.js';
import { resolveDesignModel } from './designLane.js';
import { designStandardEnabled } from './designRouting.js';
import { mapModuleReason } from './designReviewRecord.js';
import type { ReviewAttempt, ReviewPass, ReviewReason } from './designReviewLedger.js';
import { CLAUDE_CODE_FRAMEWORK, CODEX_CLI_FRAMEWORK, GEMINI_CLI_FRAMEWORK, GROK_BUILD_FRAMEWORK } from './frameworkFacts.js';

/**
 * The Claude door's fallback review model when the agent's configured default
 * (`sessions.frameworkDefaultModels['claude-code']`) is not a concrete accepted
 * reviewer id. One fallback exhausts the door's two candidates (decision table).
 */
export const CLAUDE_DOOR_FALLBACK_REVIEW_MODEL = 'claude-opus-5-5';

const FAMILY_BY_FRAMEWORK: Record<string, string> = {
  [CLAUDE_CODE_FRAMEWORK]: 'claude',
  [CODEX_CLI_FRAMEWORK]: 'codex',
  [GEMINI_CLI_FRAMEWORK]: 'gemini',
  [GROK_BUILD_FRAMEWORK]: 'grok',
};

export interface RecordingConfig extends ReviewerConfig {
  enabledFrameworks?: string[];
  sessions?: { frameworkDefaultModels?: Record<string, string> };
}

export type RecordedReviewOutcome =
  | { ok: true; runId: string; passes: ReviewPass[]; unmappedReasons: string[] }
  | { ok: false; refused: 'live-secret'; kind: string };

/** The door's default review model for the one fallback. */
export function claudeFallbackReviewModel(config: RecordingConfig | undefined, lane: string): string {
  const configured = config?.sessions?.frameworkDefaultModels?.[CLAUDE_CODE_FRAMEWORK];
  const accepted = (m: string) => CLAUDE_REVIEWER_FRONTIER_MODELS.includes(m) || CLAUDE_REVIEWER_EXPLICIT_MODELS.includes(m);
  if (typeof configured === 'string' && configured !== lane && accepted(configured)) return configured;
  return CLAUDE_DOOR_FALLBACK_REVIEW_MODEL;
}

/** Is a degraded result the provider refusing the requested model (rather than one call failing)? */
function isRefusal(reason: ReviewReason): boolean {
  return reason === 'not-on-plan' || reason === 'limit-reached';
}

function attemptOf(asked: string, r: ReviewerResult, unmapped: string[]): { attempt: ReviewAttempt; reason?: ReviewReason } {
  if (r.status === 'ok') return { attempt: { askedModel: asked, outcome: 'ok' } };
  const m = mapModuleReason(r.reason);
  if (m.unmapped && r.reason) unmapped.push(r.reason);
  return { attempt: { askedModel: asked, outcome: isRefusal(m.reason) ? 'refused' : 'failed', reason: m.reason }, reason: m.reason };
}

export interface RunRecordedDesignReviewArgs {
  /** The design text as reviewed (scanned for live secrets before anything is sent). */
  text: string;
  assembled: AssembledPrompt;
  config?: RecordingConfig;
  timeoutMs?: number;
  /** Tests inject a reviewer seam; production uses the module's runCrossModelReview. */
  review?: typeof runCrossModelReview;
  detectInputs?: CrossModelDetectInputs;
  /** Tests inject detection per framework; production uses each family's own detect. */
  detectFor?: (frameworkId: string) => CrossModelDetectionResult;
}

/** Attempt every family in parallel and return the passes. Never throws for a reviewer failure. */
export async function runRecordedDesignReview(args: RunRecordedDesignReviewArgs): Promise<RecordedReviewOutcome> {
  const secret = detectOutboundCredential(args.text);
  if (secret.detected) return { ok: false, refused: 'live-secret', kind: String(secret.kind ?? 'credential') };

  const config = args.config ?? {};
  const review = args.review ?? runCrossModelReview;
  const enabledFrameworks = Array.isArray(config.enabledFrameworks) ? config.enabledFrameworks : [CLAUDE_CODE_FRAMEWORK];
  const detectInputs: CrossModelDetectInputs = args.detectInputs ?? { enabledFrameworks };
  const standardOn = designStandardEnabled(config);
  const unmapped: string[] = [];

  const passFor = async (frameworkId: string): Promise<ReviewPass> => {
    const family = FAMILY_BY_FRAMEWORK[frameworkId] ?? frameworkId;
    const entry = SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === frameworkId)!;
    const lane = resolveDesignModel(frameworkId);
    const unavailable = (reason: ReviewReason): ReviewPass => ({ family, door: frameworkId, attempts: [], model: null, modelBasis: 'requested', status: 'unavailable', reason });

    if (frameworkId === CLAUDE_CODE_FRAMEWORK) {
      const explicitOff = config.specConverge?.reviewers?.anthropic?.enabled === false;
      const on = standardOn ? !explicitOff : isAnthropicReviewerEnabled(config);
      if (!on) return unavailable('disabled');
    } else if (!enabledFrameworks.includes(frameworkId)) {
      // Decision 10: a provider this agent's sessions do not run on is not used,
      // even when its CLI is signed in on the machine.
      return unavailable('disabled');
    }

    const detection = args.detectFor ? args.detectFor(frameworkId) : entry.detect(detectInputs);
    if (!detection.available) {
      const m = mapModuleReason(detection.reason);
      if (m.unmapped && detection.reason) unmapped.push(detection.reason);
      return unavailable(m.reason);
    }

    const runOn = async (model: string): Promise<ReviewerResult> => {
      if (frameworkId === CLAUDE_CODE_FRAMEWORK) {
        const forced: ReviewerConfig = {
          ...config,
          specConverge: { ...config.specConverge, reviewers: { ...config.specConverge?.reviewers, anthropic: { ...config.specConverge?.reviewers?.anthropic, enabled: true, model } } },
        };
        return review({ assembled: args.assembled, family: frameworkId, detectionOverride: { ...detection, model }, config: forced, detectInputs, ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}) });
      }
      return review({ assembled: args.assembled, family: frameworkId, detectionOverride: { ...detection, model }, config, detectInputs, ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}) });
    };

    const asked = lane ?? detection.model ?? '';
    const first = await runOn(asked);
    const a1 = attemptOf(asked, first, unmapped);
    const attempts: ReviewAttempt[] = [a1.attempt];
    let final = first;
    let finalModel = asked;
    // Decision 12: the same-door pass falls back once to the door's default model.
    if (frameworkId === CLAUDE_CODE_FRAMEWORK && first.status !== 'ok' && a1.attempt.outcome === 'refused' && lane) {
      const fallback = claudeFallbackReviewModel(config, lane);
      const second = await runOn(fallback);
      attempts.push(attemptOf(fallback, second, unmapped).attempt);
      final = second;
      finalModel = fallback;
    }
    if (final.status === 'ok') {
      return {
        family, door: frameworkId, attempts,
        model: final.model ?? finalModel,
        // The module's concrete-model check runs before every call, but no CLI
        // output naming the model is read here, so the basis is what was requested.
        modelBasis: 'requested',
        status: 'ok',
        verdict: final.verdict ?? 'UNKNOWN',
      };
    }
    const last = attempts[attempts.length - 1];
    return { family, door: frameworkId, attempts, model: null, modelBasis: 'requested', status: final.status === 'unavailable' ? 'unavailable' : 'degraded', reason: last.reason ?? 'call-failed' };
  };

  const frameworks = SUPPORTED_REVIEWER_FRAMEWORKS.map((f) => f.id as string);
  const passes = await Promise.all(frameworks.map((id) => passFor(id).catch((): ReviewPass => ({
    family: FAMILY_BY_FRAMEWORK[id] ?? id, door: id, attempts: [], model: null, modelBasis: 'requested', status: 'degraded', reason: 'call-failed',
  }))));
  return { ok: true, runId: crypto.randomBytes(16).toString('hex'), passes, unmappedReasons: [...new Set(unmapped)] };
}
