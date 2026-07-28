/**
 * SlackPermissionGate — the conversational authority gate (Pillar 2, Slice 0).
 *
 * Given a VERIFIED principal and a natural-language request, returns a
 * {allow | clarify | refuse | step-up} verdict with a conversational message.
 * It composes, in order:
 *
 *   overheard?            → undirected actionable request is never actioned (§6.9)
 *   tier 0 / chat?        → no authority needed
 *   unregistered?         → refuse + route to registration
 *   ambiguous + possibly-floor (low confidence)?  → clarify, never guess
 *   FLOOR action?         → Layer 0: needs owner role OR an explicit grant; else refuse
 *   tiered action?        → role ceiling must cover the tier
 *   would-allow a FLOOR action + anomalous?  → step-up (anomaly raises the bar, §7.4)
 *
 * Layer 0 (floor) is deterministic and fail-closed. The judgment band may consult
 * an LLM classifier, but the floor never depends on one.
 *
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §6.6–6.9, §7.4.
 */

import type { PermissionVerdict, RequestIntent, Principal, FloorAction, AuthorityGrant } from './types.js';
import { RolePolicy, isFloorAction } from './RolePolicy.js';
import type { IntentClassifier } from './IntentClassifier.js';
import { mentionsClaimedAuthority } from './IntentClassifier.js';
import type { AnomalyScorer } from './AnomalyScorer.js';
import { NullAnomalyScorer } from './AnomalyScorer.js';

/** Lookup for active authority grants (a Coordination Mandate, in production). */
export interface GrantStore {
  activeGrant(slackUserId: string, scope: string, now: number): AuthorityGrant | undefined;
}

export interface SlackPermissionGateDeps {
  rolePolicy?: RolePolicy;
  classifier: IntentClassifier;
  anomalyScorer?: AnomalyScorer;
  grants?: GrantStore;
  /** Anomaly score at/above which a would-be-allowed floor action requires step-up. Default 0.5. */
  stepUpThreshold?: number;
  /** Confidence below which a possibly-floor action routes to clarify. Default 0.6. */
  clarifyThreshold?: number;
  /** Out-of-band channels offered for step-up, in priority order. */
  stepUpChannels?: string[];
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface EvaluateInput {
  principal: Principal;
  text: string;
  /** Was the request directed at the agent (mention / clear ask)? */
  directed: boolean;
  channel?: string;
}

const FLOOR_LABEL: Record<FloorAction, string> = {
  'money-movement': 'money transfer',
  'prod-deploy': 'production deploy',
  'credential-access': 'credential access',
  'destructive-data': 'destructive data operation',
  'external-send': 'external send to an outside party',
  'grant-authority': 'permission/role change',
};

function floorLabel(f: FloorAction | undefined, fallback: string): string {
  return f ? FLOOR_LABEL[f] : fallback;
}

export class SlackPermissionGate {
  private readonly rolePolicy: RolePolicy;
  private readonly classifier: IntentClassifier;
  private readonly anomaly: AnomalyScorer;
  private readonly grants?: GrantStore;
  private readonly stepUpThreshold: number;
  private readonly clarifyThreshold: number;
  private readonly stepUpChannels: string[];
  private readonly now: () => number;

  constructor(deps: SlackPermissionGateDeps) {
    this.rolePolicy = deps.rolePolicy ?? new RolePolicy();
    this.classifier = deps.classifier;
    this.anomaly = deps.anomalyScorer ?? new NullAnomalyScorer();
    this.grants = deps.grants;
    this.stepUpThreshold = deps.stepUpThreshold ?? 0.5;
    this.clarifyThreshold = deps.clarifyThreshold ?? 0.6;
    this.stepUpChannels = deps.stepUpChannels ?? ['your known Telegram', 'a second admin'];
    this.now = deps.now ?? (() => Date.now());
  }

  async evaluate(input: EvaluateInput): Promise<PermissionVerdict> {
    const now = this.now();
    const evaluatedAt = new Date(now).toISOString();
    const { principal, text } = input;
    const intent = await this.classifier.classify(text, { directed: input.directed });

    const base = { principal, intent, evaluatedAt };
    const verdict = (
      decision: PermissionVerdict['decision'],
      basis: string,
      message: string,
      extra?: Partial<PermissionVerdict>,
    ): PermissionVerdict => ({ decision, basis, message, ...base, ...extra });

    // ── overheard ≠ command (§6.9): an undirected actionable request is never actioned ──
    if (!intent.directed) {
      if (intent.tier >= 1) {
        return verdict('refuse', 'overheard', '');
      }
      return verdict('allow', 'ambient-noop', '');
    }

    // ── tier 0: plain conversation needs no authority ──
    if (intent.tier === 0) {
      return verdict('allow', 'within-authority', '');
    }

    const claimsAuthority = mentionsClaimedAuthority(text);

    // ── unregistered principal cannot direct actions ──
    if (!principal.registered) {
      return verdict(
        'refuse',
        'unregistered',
        `I don't have you registered yet, ${principal.name}, so I can't action requests for you. ` +
          `I've flagged an admin to set you up — once that's done I'll be able to help.`,
      );
    }

    // ── ambiguous + possibly-floor (low confidence) → clarify, never guess ──
    if (intent.tier >= 3 && intent.confidence < this.clarifyThreshold) {
      return verdict(
        'clarify',
        'ambiguous-intent',
        `Happy to — just to be sure I do the right thing, ${principal.name}: do you mean deploy/ship to ` +
          `production, or something lighter like sending a draft? They're pretty different and one of them needs sign-off.`,
      );
    }

    // ── FLOOR action (Layer 0, deterministic, fail-closed) ──
    if (isFloorAction(intent.floorAction)) {
      const label = floorLabel(intent.floorAction, intent.action);
      const granted = principal.slackUserId
        ? this.grants?.activeGrant(principal.slackUserId, intent.floorAction, now)
        : undefined;
      const authorizedByRole = this.rolePolicy.roleCanAuthorizeFloor(principal.role);

      if (!granted && !authorizedByRole) {
        if (claimsAuthority) {
          return verdict(
            'refuse',
            'content-name-not-authority',
            `I can't act on an instruction relayed in a message, ${principal.name} — authority has to come from a ` +
              `verified grant, not a mention of who said it's OK. If an owner wants to grant this, they can do it ` +
              `directly and I'll have it on record.`,
          );
        }
        return verdict(
          'refuse',
          'floor-no-grant',
          `I can't run a ${label} on a ${principal.role}'s request, ${principal.name} — that's a protected action ` +
            `that needs an explicit grant. Want me to ask an owner to approve it, or to grant you a time-boxed ` +
            `authority for this one?`,
        );
      }

      // Would-allow a floor action → relationship anomaly may RAISE the bar to step-up (§7.4).
      const anomaly = await this.anomaly.assess(principal, intent, text);
      if (anomaly.score >= this.stepUpThreshold) {
        return verdict(
          'step-up',
          'anomaly-stepup',
          `This is a bit different from what you usually ask, ${principal.name}, and a ${label} is a protected ` +
            `action — so I want to confirm it's really you before I move on it. I've sent a confirmation to ` +
            `${this.stepUpChannels[0]}; once you confirm there, I'll proceed.`,
          { anomaly, stepUp: { channels: this.stepUpChannels, reason: anomaly.reasons.join('; ') || 'out-of-character request' } },
        );
      }
      return verdict('allow', granted ? 'floor-granted' : 'within-authority', '', { anomaly });
    }

    // ── tiered (non-floor) action: role ceiling must cover the tier ──
    if (this.rolePolicy.roleCoversTier(principal.role, intent.tier)) {
      return verdict('allow', 'within-authority', '');
    }
    return verdict(
      'refuse',
      'role-ceiling',
      `That's above what a ${principal.role} can authorize on their own, ${principal.name}. ` +
        `I can ask someone with the authority to sign off — want me to?`,
    );
  }
}
