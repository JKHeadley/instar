/**
 * native-conversation-forwarded-advisory (slice 3g) — what a send-policy refusal
 * on a reply IN CUSTODY means.
 *
 * The outbound check's refusal body is read by an allow-list into three classes:
 *  - `advisory`: a nudge on the text. The reply goes back to its author, who
 *    answers it (revise, or override with a reason). Nothing else sends it.
 *  - `refused`: a definite verdict on the text (a credential or loopback link, a
 *    blocking rule, a reasonless override). The reply ends; it is never retried.
 *  - `retain`: everything else, including a review that produced NO verdict (a
 *    capacity shed, an outage, a timeout, an unknown rule). Unchanged: the row
 *    stays queued and is reviewed again.
 *
 * Pure (the origin store worker imports it); the classifier that reads the
 * gate's rule table is `OriginPolicyClassifier.ts`.
 *
 * A signal, not an authority: the outbound check already decided. This module
 * only names which of its decisions are a verdict on the text (G-4).
 */
import type { OriginSendPolicyDecision } from './OriginSendPolicy.js';

export type PolicyVerdictClass = 'advisory' | 'refused' | 'retain';
type Refusal = Extract<OriginSendPolicyDecision, { ok: false }>;

/** Stored in `policy_verdict_json`. `issue` is never stored; a refused verdict keeps class and rule only. */
export interface PolicyVerdict {
  class: 'advisory' | 'refused';
  rule: string;
  suggestion?: string;
  decisionRef?: string | null;
  at: number;
  machineId: string;
}

const RULE_TEXT = /^[A-Za-z0-9_:.-]{1,64}$/;
const REF_TEXT = /^[A-Za-z0-9_:.\-]{1,128}$/;

/** The suggestion cut to 500 characters, with newlines and backticks removed (it is typed into a session). */
export function cleanSuggestion(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/`/g, "'").trim().slice(0, 500) : '';
}

/** The verdict to record, or null for a `retain` refusal (never an ending). */
export function policyVerdictOf(cls: PolicyVerdictClass, decision: Refusal | null | undefined, machineId: string, now: number): PolicyVerdict | null {
  if (cls === 'retain' || !decision) return null;
  const body = decision.body;
  const rawRule = typeof body.rule === 'string' ? body.rule : typeof body.blockedBy === 'string' ? body.blockedBy : decision.reason;
  const rule = RULE_TEXT.test(rawRule) ? rawRule : 'unknown-rule';
  if (cls === 'refused') return { class: 'refused', rule, at: now, machineId };
  const ref = typeof body.decisionRef === 'string' && REF_TEXT.test(body.decisionRef) ? body.decisionRef : null;
  return { class: 'advisory', rule, suggestion: cleanSuggestion(body.suggestion), decisionRef: ref, at: now, machineId };
}

/** Parse a stored or received verdict; anything malformed reads as none. */
export function readPolicyVerdict(value: unknown): PolicyVerdict | null {
  let v: unknown = value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if ((o.class !== 'advisory' && o.class !== 'refused') || typeof o.rule !== 'string' || !RULE_TEXT.test(o.rule)) return null;
  if (!Number.isSafeInteger(o.at) || typeof o.machineId !== 'string' || !o.machineId || o.machineId.length > 128) return null;
  if (o.class === 'refused') return { class: 'refused', rule: o.rule, at: o.at as number, machineId: o.machineId };
  const ref = typeof o.decisionRef === 'string' && REF_TEXT.test(o.decisionRef) ? o.decisionRef : null;
  return { class: 'advisory', rule: o.rule, suggestion: cleanSuggestion(o.suggestion), decisionRef: ref, at: o.at as number, machineId: o.machineId };
}

/** The answer reference for one advisory-bearing operation: the gate's `decisionRef`, or `op:<its own id>`. */
export function advisoryReference(verdict: Pick<PolicyVerdict, 'decisionRef'>, operationId: string): string {
  return verdict.decisionRef ? verdict.decisionRef : `op:${operationId}`;
}
/** True for a reference this machine resolves itself; it is removed before the policy input is sealed. */
export function isOperationReference(ref: unknown): ref is string {
  return typeof ref === 'string' && /^op:[A-Za-z0-9-]{1,256}$/.test(ref);
}

function hhmmUtc(at: number): string {
  const d = new Date(at);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/** Item 4 — the one session line for a reply handed back with an advisory. */
export function advisorySessionLine(input: { operationId: string; rule: string; suggestion?: string; deadlineAt: number; ref: string }): string {
  const suggestion = cleanSuggestion(input.suggestion);
  const said = suggestion ? `${suggestion}${/[.!?]$/.test(suggestion) ? '' : '.'}` : 'No suggestion was given.';
  return `Your reply \`${input.operationId}\` was not sent. The outbound check has a suggestion (\`${input.rule}\`): ${said} ` +
    `It stays held until you answer and ends undelivered at ${hhmmUtc(input.deadlineAt)}. ` +
    `To send a revised version, send it with \`--tone-complied ${input.rule} --tone-decision-ref ${input.ref}\`. ` +
    `To send it as written, resend its text with \`--tone-ack ${input.rule} --tone-reason "<why>" --tone-decision-ref ${input.ref}\`. ` +
    `A reply sent without that reference is a separate message and leaves this one held. ` +
    `Its text is at \`GET /telegram/origins/operations/${input.operationId}/text\`.`;
}
