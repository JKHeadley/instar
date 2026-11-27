import { z } from 'zod';
import { isOwnerNeedsAskWithdrawn, type OwnerNeedsAskIdentity, type OwnerNeedsWithdrawal } from './OwnerNeedsWithdrawal.js';

const reference = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const ownerAction = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('approval'), requestId: reference }),
  z.strictObject({ kind: z.literal('approval-batch'), disclosureId: reference }),
  z.strictObject({ kind: z.literal('credential'), requestId: reference }),
  z.strictObject({ kind: z.literal('instructions'), template: z.literal('update-instar-phone') }),
]);

export type OwnerNeedsActionKind = 'approve' | 'credential' | 'physical';

type SourceAction = z.infer<typeof ownerAction>;
type OwnerNeedsReferenceAction = Exclude<SourceAction, { kind: 'instructions' }>;
export type OwnerNeedsAction = OwnerNeedsReferenceAction |
  { kind: 'instructions'; steps: string[] };

const presentations = {
  'trust-change': { action: 'approval', title: 'Review a trust change', why: 'Your device approval is required before this change can be applied.' },
  'project-completion': { action: 'approval-batch', title: 'Review project completion', why: 'Your decision is needed to finish the projects in this request.' },
  'credential-request': { action: 'credential', title: 'Provide a credential', why: 'The agent needs you to enter a credential in the protected form.' },
  'update-instar-phone': { action: 'instructions', title: 'Update Instar on your phone', why: 'This update requires you to open TestFlight.' },
} as const;

type OwnerNeedsPresentation = keyof typeof presentations;

export function ownerNeedsPresentation(template: unknown, action: OwnerNeedsAction['kind']) {
  if (typeof template !== 'string' || !Object.hasOwn(presentations, template)) return null;
  const copy = presentations[template as OwnerNeedsPresentation];
  if (copy.action !== action) return null;
  return { title: copy.title, why: copy.why, detail: null };
}

export interface OwnerNeedsCandidate {
  /** Resolved by the source's authority rather than supplied by untrusted card text. */
  responsibility: 'agent' | 'owner-required' | 'unknown';
  actions: readonly unknown[];
  ownerAction?: OwnerNeedsActionKind;
  /** Reviewed, action-specific copy selected by the source for the exact request. */
  presentation?: OwnerNeedsPresentation;
  /** Resolve the validated reference against current request and owner authority on each read. */
  verifiesCurrentOwnerRequest?: (action: OwnerNeedsReferenceAction) => boolean;
  /** Legacy destination or alternate action that would still send the owner away. */
  handoffs: readonly string[];
  /** The source supplies the exact current identity and its verified withdrawal lookup. */
  withdrawal?: { ask: OwnerNeedsAskIdentity; record: OwnerNeedsWithdrawal | null };
}

export type OwnerNeedsAdmission =
  | { disposition: 'show'; ownerAction: OwnerNeedsActionKind; action: OwnerNeedsAction }
  | { disposition: 'route-to-agent' | 'withdrawn' }
  | { disposition: 'hold'; reason: 'owner-dependency-unknown' | 'handoff' | 'action-required' | 'invalid-action' | 'request-unavailable' | 'source-unavailable' };

/** Shared owner projection floor. A hold never edits or authorizes the source. */
export function admitOwnerNeedsCard(candidate: OwnerNeedsCandidate): OwnerNeedsAdmission {
  if (candidate.withdrawal && isOwnerNeedsAskWithdrawn(candidate.withdrawal.ask, candidate.withdrawal.record)) {
    return { disposition: 'withdrawn' };
  }
  if (candidate.responsibility === 'agent') return { disposition: 'route-to-agent' };
  if (candidate.responsibility !== 'owner-required') return { disposition: 'hold', reason: 'owner-dependency-unknown' };
  if (candidate.handoffs.length > 0) return { disposition: 'hold', reason: 'handoff' };
  if (candidate.actions.length !== 1) return { disposition: 'hold', reason: 'action-required' };

  const action = ownerAction.safeParse(candidate.actions[0]);
  if (!action.success) return { disposition: 'hold', reason: 'invalid-action' };
  const kind: OwnerNeedsActionKind = action.data.kind === 'instructions' ? 'physical' : action.data.kind === 'credential' ? 'credential' : 'approve';
  if (candidate.ownerAction !== kind) return { disposition: 'hold', reason: 'invalid-action' };
  if (action.data.kind !== 'instructions') {
    try {
      if (candidate.verifiesCurrentOwnerRequest?.(action.data) === true) {
        return { disposition: 'show', ownerAction: kind, action: action.data };
      }
    } catch {
      return { disposition: 'hold', reason: 'source-unavailable' };
    }
    return { disposition: 'hold', reason: 'request-unavailable' };
  }

  return { disposition: 'show', ownerAction: kind, action: { kind: 'instructions', steps: [
    'Open TestFlight on your iPhone and select Instar.',
    'Tap Update if TestFlight offers an update. If you see Open, you already have the latest version available to you.',
    'Open Instar again.',
  ] } };
}
