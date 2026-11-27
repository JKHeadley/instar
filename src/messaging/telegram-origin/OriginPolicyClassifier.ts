/**
 * native-conversation-forwarded-advisory (slice 3g) item 1 — the allow-list that
 * names which send-policy refusals are a verdict on the text. Kept apart from
 * `OriginPolicyVerdict.ts` because it reads the tone gate's rule table, which the
 * origin store worker must not load.
 */
import { RULE_DISPOSITIONS } from '../../core/MessagingToneGate.js';
import type { OriginSendPolicyDecision } from './OriginSendPolicy.js';
import { policyVerdictOf } from './OriginPolicyVerdict.js';
import type { PolicyVerdict, PolicyVerdictClass } from './OriginPolicyVerdict.js';

type Refusal = Extract<OriginSendPolicyDecision, { ok: false }>;

/** A real rule of the outbound check: never `CAPACITY_UNAVAILABLE`, `GATE_UNAVAILABLE`, `GATE_TIMEOUT` or an unknown id. */
export function isVerdictRule(rule: unknown): rule is string {
  return typeof rule === 'string' && Object.prototype.hasOwnProperty.call(RULE_DISPOSITIONS, rule);
}

export function policyVerdictClass(decision: Refusal | null | undefined): PolicyVerdictClass {
  const body = decision?.body;
  if (!body || typeof body !== 'object') return 'retain';
  const error = body.error, blockedBy = body.blockedBy;
  if (error === 'tone-gate-advisory') return 'advisory';
  if (blockedBy === 'credential-exposure-guard' || blockedBy === 'localhost-link-guard') return 'refused';
  if (error === 'tone-gate-advisory-reason-required') return 'refused';
  if (error === 'tone-gate-blocked' && isVerdictRule(body.rule) && (body.failedClosed !== true || body.degradedToDeterministic === true)) return 'refused';
  return 'retain';
}

/** The verdict to record for this refusal, or null when it is `retain` (never an ending). */
export function classifyPolicyRefusal(decision: Refusal | null | undefined, machineId: string, now: number): PolicyVerdict | null {
  return policyVerdictOf(policyVerdictClass(decision), decision, machineId, now);
}
