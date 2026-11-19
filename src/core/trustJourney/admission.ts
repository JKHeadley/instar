/**
 * Admission for governed kinds (trust-journey decisions 9, 10 and 13, section 6a).
 *
 * - Reads are not gated.
 * - Instar's own system services keep today's behaviour (decision 9).
 * - A kind with an unchanged legacy grant keeps today's gate behaviour (`legacy`).
 * - Everything else is governed: a sign-in, a kind with any person-set change, or a kind with no
 *   grant at all. A governed kind asks unless the person's proven level is "Do it and show me" or
 *   "Just do it" AND the action's scope is known AND it touches no always-ask item. An action the
 *   person approved once (its exact identity) is admitted once.
 *
 * Pure: every input is passed in.
 */
import { SYSTEM_SERVICES, type DerivedEffect } from '../../data/effect-kinds.js';

export type AdmissionDecision =
  | { verdict: 'not-gated'; why: 'read' | 'not-an-mcp-tool' }
  | { verdict: 'legacy'; why: 'system-service' | 'unchanged-legacy-grant' }
  | { verdict: 'proceed'; why: 'grant'; level: string }
  | { verdict: 'proceed-once'; why: 'approved-once'; approvalId: string }
  | { verdict: 'ask'; why: AskReason }
  /** "Don't do this": refused, naming the setting; no card is sent (spec section 2). */
  | { verdict: 'refused'; why: 'blocked' };

export type AskReason = 'no-grant' | 'grant-asks' | 'unknown-scope' | 'always-ask-item' | 'sign-in' | 'unreadable-history' | 'holder-unreachable';

export interface AdmissionInputs {
  effect: DerivedEffect | null;
  /** True when this kind holds a legacy grant (any machine) and no person-set change since. */
  unchangedLegacy: (kind: string) => boolean;
  /** The person's proven level for the kind, or null when none is recorded. */
  provenLevel: (kind: string) => string | null;
  /** A key whose history holds a record this build cannot read. */
  unreadableHistory: (kind: string) => boolean;
  /** An unused one-time approval for this exact action. */
  unusedApproval: (actionIdentity: string) => { approvalId: string } | null;
  /** The level in force for the kind (any source), or null when none applies. */
  currentLevel?: (kind: string) => string | null;
}

export function decideAdmission(i: AdmissionInputs): AdmissionDecision {
  const e = i.effect;
  if (!e) return { verdict: 'not-gated', why: 'not-an-mcp-tool' };
  if (e.operation === 'read') return { verdict: 'not-gated', why: 'read' };
  if (SYSTEM_SERVICES.includes(e.service)) return { verdict: 'legacy', why: 'system-service' };
  // Decision 15: sign-in inherits no write or legacy grant; it is always governed.
  if (e.operation !== 'sign-in' && i.unchangedLegacy(e.kind)) return { verdict: 'legacy', why: 'unchanged-legacy-grant' };

  // Current restrictions first: a later "never do it" or an unreadable history wins over an earlier
  // one-time approval of the same call.
  if (i.unreadableHistory(e.kind)) return { verdict: 'ask', why: 'unreadable-history' };
  if (i.currentLevel?.(e.kind) === 'blocked') return { verdict: 'refused', why: 'blocked' };

  const once = i.unusedApproval(e.actionIdentity);
  if (once) return { verdict: 'proceed-once', why: 'approved-once', approvalId: once.approvalId };

  if (e.operation === 'sign-in') return { verdict: 'ask', why: 'sign-in' };
  if (e.floor.length > 0) return { verdict: 'ask', why: 'always-ask-item' };
  const level = i.provenLevel(e.kind);
  if (level === null) return { verdict: 'ask', why: 'no-grant' };
  if (level !== 'log' && level !== 'autonomous') return { verdict: 'ask', why: 'grant-asks' };
  // Missing or unknown scope requires approval (spec section 9 and decision 3).
  if (e.audience === 'unknown') return { verdict: 'ask', why: 'unknown-scope' };
  return { verdict: 'proceed', why: 'grant', level };
}

/** The plain sentence the hook prints when it refuses a call that now waits for the person. */
export function askSentence(reason: AskReason, sent: 'sent' | 'awaiting-acceptance' | 'undelivered' | 'other'): string {
  const why: Record<AskReason, string> = {
    'no-grant': 'the person has not set what I may do alone for this kind of action',
    'grant-asks': 'the person asked to approve this kind of action first',
    'unknown-scope': 'who this action reaches cannot be worked out, so it needs the person',
    'always-ask-item': 'this kind of action always needs the person (it speaks publicly or widens the role)',
    'sign-in': 'signing in with a stored credential always needs the person',
    'unreadable-history': 'its approval history holds a record this version cannot read',
    'holder-unreachable': 'this machine does not hold the serving lease, and governed actions are admitted only there',
  };
  const where = sent === 'sent' ? 'A card asking for approval is in their direct chat; run the identical call again after they approve it.'
    : sent === 'awaiting-acceptance' ? 'They have been asked for their one-time acceptance first; the card follows.'
      : sent === 'undelivered' ? 'The approval card could not be delivered to their direct chat; tell them in this conversation.'
        : 'Nothing was sent.';
  return `Waiting for the person's approval: ${why[reason]}. ${where} Continue with other work meanwhile.`;
}
