/**
 * AnchoredAuthorization — the ONLY typed shape that may authorize an
 * irreversible action (Threadline Robustness Phase 1, G2 / D-C; CMT-1362).
 *
 * THE POSITIVE BOUNDARY. G2 ("prose is inert") is enforced POSITIVELY, not as a
 * negative audit that rots: an irreversible-action gate may accept authorization
 * ONLY as a typed reference to a durable, operator-anchored, audited artifact —
 * a Coordination Mandate, a ReviewExchange, or an OperatorConfirm. NEVER a raw
 * string, a transcript, a conversation/history summary, or a ContentClassifier
 * output. A Threadline prose message has no pathway to this type by construction,
 * so a "Dawn confirmed" / "Echo confirmed" in a message body can never become
 * authority — there is nothing to detect-and-block because prose is inert.
 *
 * This file deliberately carries NO import of ConversationStore / ThreadlineRouter
 * / message envelopes / ContentClassifier — the import-boundary test asserts that
 * an irreversible-action gate's authorization input is THIS type and that this
 * module never learns about prose. Adding a prose pathway here is a build break.
 */

/**
 * A reference to an anchored authorization artifact. It is a typed REFERENCE
 * (kind + id + the audit hash that proves the gate decision authorizing it), not
 * free text. The referenced artifact lives in its own durable, hash-chained
 * store (MandateStore / ReviewExchange / OperatorConfirmGate); the gate
 * re-verifies the reference against that store before acting on it.
 */
export type AnchoredAuthorization =
  | {
      kind: 'mandate';
      /** Mandate id in the MandateStore. */
      id: string;
      /** The hash of the mandate-gate decision that authorized this action. */
      auditHash: string;
    }
  | {
      kind: 'review-exchange';
      /** ReviewExchange id. */
      id: string;
      /** The audit hash of the gate decision behind the accepted sign-off. */
      auditHash: string;
    }
  | {
      kind: 'operator-confirm';
      /** The operator-confirm requestId. */
      id: string;
      /** Who authorized (the verified operator), for the audit trail. */
      authorizedBy: string;
    };

const ANCHORED_KINDS = new Set(['mandate', 'review-exchange', 'operator-confirm']);

/**
 * Type guard: is `input` a well-formed AnchoredAuthorization? Returns false for
 * ANY string, number, null, array, transcript-shaped object, history summary, or
 * ContentClassifier result — i.e. for every prose-derived shape. This is the
 * runtime half of the positive boundary; the import-boundary test is the static
 * half.
 */
export function isAnchoredAuthorization(input: unknown): input is AnchoredAuthorization {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const o = input as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !ANCHORED_KINDS.has(o.kind)) return false;
  if (typeof o.id !== 'string' || o.id.length === 0) return false;
  if (o.kind === 'operator-confirm') {
    return typeof o.authorizedBy === 'string' && o.authorizedBy.length > 0;
  }
  // mandate / review-exchange require a non-empty audit hash linking the decision.
  return typeof o.auditHash === 'string' && o.auditHash.length > 0;
}

/**
 * Enforce the positive boundary: return the typed authorization or THROW. An
 * irreversible-action gate calls this on its authorization input so that a
 * string / transcript / summary / classifier output can never authorize the
 * action — the gate fails closed on the authority path (a deliberate contrast
 * with the lease send-gate, which fails OPEN for inert prose).
 */
export function requireAnchoredAuthorization(input: unknown, context: string): AnchoredAuthorization {
  if (!isAnchoredAuthorization(input)) {
    throw new AnchoredAuthorizationError(context, input);
  }
  return input;
}

/** Thrown when an irreversible-action gate is handed a non-anchored authorization. */
export class AnchoredAuthorizationError extends Error {
  readonly context: string;
  constructor(context: string, received: unknown) {
    const receivedKind = Array.isArray(received)
      ? 'array'
      : received === null
        ? 'null'
        : typeof received;
    super(
      `Irreversible-action authorization at "${context}" must be a typed anchored ` +
      `artifact (mandate / review-exchange / operator-confirm reference), not ` +
      `${receivedKind}. Threadline prose carries no authority — anchor the decision ` +
      `via a Coordination Mandate or ReviewExchange.`,
    );
    this.name = 'AnchoredAuthorizationError';
    this.context = context;
  }
}
