/**
 * WS5.2 §5.3 step 3 / S7 — email-validation-before-selectable.
 *
 * When an operator-authorized follow-me enrollment COMPLETES on a target machine, the freshly
 * minted login's account email MUST be validated against the operator's expectation BEFORE the
 * account becomes selectable. A surprise email (the operator approved account A on their phone,
 * but the login that completed is a DIFFERENT account B) must NOT be auto-used — it raises an
 * attention item for the operator instead. This closes S7: "the target is trusted with a live
 * credential; host+email validated" — a wrong/unexpected account never silently becomes the one
 * the agent serves from.
 *
 * Standalone gate (NOT a mutation of the shared EnrollmentWizard.complete): the follow-me path
 * calls this with the completed email + the operator-expected email; only on a verified match
 * does it call SubscriptionPool.add() and mark the account selectable.
 *
 * PR2 increment 2: the gate + its tests. Wired into the §5.3 completion path in a later increment.
 */

export interface EmailValidationInput {
  /** The account email the COMPLETED login actually authenticated as (from the provider). */
  completedEmail: string | null | undefined;
  /** The account email the operator EXPECTED (the mandate's account; what they approved). */
  expectedEmail: string | null | undefined;
  /** The account id being enrolled (for the attention item). */
  accountId: string;
  /** Operator-facing nickname of the target machine (for the attention item). */
  targetMachineNickname: string;
}

export interface EmailMismatchAttentionItem {
  id: string;
  title: string;
  body: string;
  priority: 'high';
  source: 'agent';
}

export type EmailValidationResult =
  | { selectable: true; email: string }
  | {
      selectable: false;
      reason: 'email-mismatch' | 'missing-completed-email' | 'missing-expected-email';
      expected: string | null;
      got: string | null;
      attentionItem: EmailMismatchAttentionItem;
    };

/** Normalize an email for comparison (trim + lowercase). Returns '' for nullish/non-string. */
function normEmail(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * Validate a completed follow-me enrollment's email against operator expectation (S7).
 * FAILS CLOSED (selectable:false) on any mismatch OR on a missing completed/expected email —
 * an account is NEVER auto-selected unless its email provably matches what the operator approved.
 */
export function validateEnrolledAccountEmail(input: EmailValidationInput): EmailValidationResult {
  const got = normEmail(input.completedEmail);
  const expected = normEmail(input.expectedEmail);

  const attention = (reason: string): EmailMismatchAttentionItem => ({
    id: `agent:account-follow-me-email:${input.accountId}:${input.targetMachineNickname.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
    title: `Account enrollment needs your check on "${input.targetMachineNickname}"`,
    body:
      `An account-follow-me enrollment on "${input.targetMachineNickname}" ${reason}. ` +
      `Expected ${input.expectedEmail || '(unspecified)'}, got ${input.completedEmail || '(none)'}. ` +
      `The account was NOT auto-selected — review before it is used.`,
    priority: 'high',
    source: 'agent',
  });

  if (!got) {
    return { selectable: false, reason: 'missing-completed-email', expected: expected || null, got: null, attentionItem: attention('completed without a verifiable account email') };
  }
  if (!expected) {
    return { selectable: false, reason: 'missing-expected-email', expected: null, got: input.completedEmail ?? null, attentionItem: attention('has no operator-expected email to validate against') };
  }
  if (got !== expected) {
    return { selectable: false, reason: 'email-mismatch', expected: input.expectedEmail ?? null, got: input.completedEmail ?? null, attentionItem: attention('authenticated as a DIFFERENT account than approved') };
  }
  return { selectable: true, email: input.completedEmail!.trim() };
}
