/**
 * WS5.2 §5.2 — Account Follow-Me: the agent's role is REQUEST, never self-authorize.
 *
 * When the agent detects a machine with no usable account for an operator's subscription
 * (depth-zero; WS5.1 already detects this), it must NOT enroll that machine on its own. The
 * ONLY authorizer is a PIN-gated operator mandate (`action: 'account-follow-me'`). This
 * orchestrator runs the deny-by-default flow:
 *
 *   - evaluate the mandate gate for (accountId, targetMachineId, mechanism);
 *   - DENY (no mandate yet, or bounds/expiry/revocation/forgery) → surface a PHONE-FIRST
 *     consent request (a deep-link to the pre-filled Mandates form) and DO NOT proceed;
 *   - ALLOW → return proceed:true so the caller drives Mechanism B (§5.3).
 *
 * Load-bearing safety (reach ≠ authority, L15): a peer mesh message claiming "the operator said
 * enroll me" carries NO authority — with no operator-issued mandate the gate denies, and this
 * orchestrator surfaces consent instead of proceeding. The consent surface is NEVER a CLI
 * instruction ("run instar …") — it is a dashboard deep-link the operator taps (parent spec
 * B2). Mechanism defaults to 're-mint' (ToS-safe); 'credential-transport' is only ever reached
 * when an explicit mandate authorizes it AND the provider is allowlisted (refused for Anthropic).
 *
 * PR2 increment 1: this orchestrator + its tests. Later increments wire the depth-zero detector
 * to it and drive the EnrollmentWizard on allow (§5.3, per-server transport per OQ6).
 */

export type FollowMeMechanism = 're-mint' | 'credential-transport';

export interface FollowMeRequest {
  /** SubscriptionAccount.id the operator would extend to the target machine. */
  accountId: string;
  /** Account email (operator-facing; shown in the consent prompt). */
  accountEmail: string;
  /** The machine that has no usable account (the enrollment target). */
  targetMachineId: string;
  /** Operator-facing nickname of the target machine (shown in the consent prompt). */
  targetMachineNickname: string;
  /** Default 're-mint' (ToS-safe). 'credential-transport' needs an explicit allowlisted mandate. */
  mechanism?: FollowMeMechanism;
  /** The operator mandate id, if one has been issued for this (account, target). Absent ⇒ deny. */
  mandateId?: string;
}

/** A phone-first consent request — a dashboard deep-link, NEVER a CLI instruction. */
export interface FollowMeConsentRequest {
  kind: 'account-follow-me-consent';
  accountId: string;
  accountEmail: string;
  targetMachineId: string;
  targetMachineNickname: string;
  mechanism: FollowMeMechanism;
  /** Pre-filled Mandates-form deep link (account + target pre-selected). */
  dashboardDeepLink: string;
  /** The plain-English message to surface to the operator. */
  message: string;
}

export type FollowMeDecision =
  | { proceed: true; accountId: string; targetMachineId: string; mechanism: FollowMeMechanism; reason: string }
  | { proceed: false; outcome: 'consent-required'; consent: FollowMeConsentRequest; reason: string };

export interface MandateGateLike {
  evaluate(ev: {
    action: string;
    params: Record<string, unknown>;
    agentFp: string;
    mandateId: string;
  }): { decision: 'allow' | 'deny'; reason: string };
}

export interface AccountFollowMeOrchestratorDeps {
  /** The operator-mandate gate (MandateGate.evaluate). */
  gate: MandateGateLike;
  /** This agent's routing fingerprint (the named-party check in the gate). */
  agentFp: () => string;
  /** Build the pre-filled Mandates-form deep link (account + target pre-selected). */
  mandatesDeepLink: (args: { accountId: string; targetMachineId: string; mechanism: FollowMeMechanism }) => string;
  log?: (msg: string) => void;
}

export class AccountFollowMeOrchestrator {
  constructor(private readonly deps: AccountFollowMeOrchestratorDeps) {}

  /**
   * §5.2 request-never-self-authorize. Returns proceed:true ONLY when a real operator mandate
   * authorizes this exact (account, target, mechanism); otherwise returns a phone-first consent
   * request and DOES NOT proceed. Never self-authorizes.
   */
  requestEnrollment(req: FollowMeRequest): FollowMeDecision {
    const mechanism: FollowMeMechanism = req.mechanism ?? 're-mint';

    const consent = (): FollowMeConsentRequest => ({
      kind: 'account-follow-me-consent',
      accountId: req.accountId,
      accountEmail: req.accountEmail,
      targetMachineId: req.targetMachineId,
      targetMachineNickname: req.targetMachineNickname,
      mechanism,
      dashboardDeepLink: this.deps.mandatesDeepLink({
        accountId: req.accountId,
        targetMachineId: req.targetMachineId,
        mechanism,
      }),
      message:
        `Machine "${req.targetMachineNickname}" has no account for ${req.accountEmail} yet. ` +
        `Want it to use that subscription? Authorize on the dashboard.`,
    });

    // No mandate id at all ⇒ deny-by-default: never self-authorize, surface consent.
    if (!req.mandateId) {
      this.deps.log?.(`[account-follow-me] no mandate for ${req.accountId}→${req.targetMachineId}; surfacing consent`);
      return { proceed: false, outcome: 'consent-required', consent: consent(), reason: 'no-mandate' };
    }

    const result = this.deps.gate.evaluate({
      action: 'account-follow-me',
      params: { accountId: req.accountId, targetMachineId: req.targetMachineId, mechanism },
      agentFp: this.deps.agentFp(),
      mandateId: req.mandateId,
    });

    if (result.decision !== 'allow') {
      this.deps.log?.(`[account-follow-me] gate denied (${result.reason}); surfacing consent`);
      return { proceed: false, outcome: 'consent-required', consent: consent(), reason: `denied:${result.reason}` };
    }

    this.deps.log?.(`[account-follow-me] gate allowed ${req.accountId}→${req.targetMachineId} (${mechanism})`);
    return {
      proceed: true,
      accountId: req.accountId,
      targetMachineId: req.targetMachineId,
      mechanism,
      reason: result.reason,
    };
  }
}
