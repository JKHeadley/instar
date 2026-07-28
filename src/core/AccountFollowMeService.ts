/**
 * WS5.2 §5.2 — Account Follow-Me service: composes the primitives into the depth-zero → consent
 * flow, and the mandate-delivered → proceed flow. Pure orchestration over INJECTED deps (pool
 * reader, consent emitter, enroll driver) so it is unit-testable WITHOUT spawning a server; the
 * HTTP route / scheduler tick later just constructs it with real deps.
 *
 * Two entry points:
 *   - scanAndOffer(): detect depth-zero enrollment candidates (R7-bounded), run each through the
 *     orchestrator (no operator mandate yet → consent-required), and emit ONE AGGREGATED consent
 *     item (P17 Bounded Notification Surface) — never one per machine. Never enrolls anything.
 *   - onMandateDelivered(): a portable account-follow-me mandate arrived from the operator machine
 *     → verify it (R4a bridge) → run the orchestrator with it → on allow, return an enroll-drive
 *     instruction for the caller to execute (per-server, OQ6). Still never self-authorizes.
 *
 * The service decides; the side effects (raising the attention item, driving the EnrollmentWizard,
 * SubscriptionPool.add) are injected so each is independently testable + swappable. PR2 increment 3b.
 */

import { detectEnrollmentOffers, type PoolMachineDepth, type OperatorAccount } from './AccountFollowMeDetector.js';
import {
  AccountFollowMeOrchestrator,
  type FollowMeConsentRequest,
  type FollowMeMechanism,
} from './AccountFollowMeOrchestrator.js';
import { acceptDeliveredMandate, type PortableMandate } from '../coordination/AccountFollowMeMandateBridge.js';
import type crypto from 'node:crypto';

export interface AggregatedConsent {
  /** Stable id so the attention item dedups per scan-set (one running item, not a flood). */
  id: string;
  title: string;
  body: string;
  priority: 'medium';
  source: 'agent';
  offers: FollowMeConsentRequest[];
}

export interface EnrollDriveInstruction {
  accountId: string;
  targetMachineId: string;
  mechanism: FollowMeMechanism;
  /** The verified mandate id authorizing this drive (audit). */
  mandateId: string;
}

export interface AccountFollowMeServiceDeps {
  /** Read the pool's per-machine account depth + the operator's accounts (WS5.1 / SubscriptionPool). */
  readPoolDepth: () => { machines: PoolMachineDepth[]; accounts: OperatorAccount[] };
  /** Per-account max-follow-machines cap (R7). */
  maxFollowMachines: () => number;
  /** (account,target) pairs already offered/in-flight — never re-offered (`${accountId}::${targetMachineId}`). */
  inFlight: () => ReadonlySet<string>;
  /** The §5.2 orchestrator (request-never-self-authorize). */
  orchestrator: AccountFollowMeOrchestrator;
  /** Raise ONE aggregated consent attention item. */
  emitAggregatedConsent: (consent: AggregatedConsent) => void;
  log?: (msg: string) => void;
}

export class AccountFollowMeService {
  constructor(private readonly deps: AccountFollowMeServiceDeps) {}

  /**
   * §5.2 scan: surface (never act on) the depth-zero enrollment offers. Runs each candidate through
   * the orchestrator — with no mandate yet, each yields consent-required — and emits ONE aggregated
   * consent item over all of them. Returns the consent requests surfaced (empty if none).
   */
  scanAndOffer(): { offered: FollowMeConsentRequest[] } {
    const { machines, accounts } = this.deps.readPoolDepth();
    const candidates = detectEnrollmentOffers({
      machines,
      accounts,
      maxFollowMachines: this.deps.maxFollowMachines(),
      inFlight: this.deps.inFlight(),
    });
    if (candidates.length === 0) return { offered: [] };

    const consents: FollowMeConsentRequest[] = [];
    for (const c of candidates) {
      const decision = this.deps.orchestrator.requestEnrollment({
        accountId: c.accountId,
        accountEmail: c.accountEmail,
        targetMachineId: c.targetMachineId,
        targetMachineNickname: c.targetMachineNickname,
        // no mandateId on a scan → orchestrator returns consent-required (never proceeds)
      });
      if (!decision.proceed) consents.push(decision.consent);
    }
    if (consents.length === 0) return { offered: [] };

    // ONE aggregated attention item over all offers (P17), id stable to the offered (account,target) set.
    const key = consents.map((c) => `${c.accountId}:${c.targetMachineId}`).sort().join(',');
    const targets = [...new Set(consents.map((c) => c.targetMachineNickname))].join(', ');
    this.deps.emitAggregatedConsent({
      id: `agent:account-follow-me-consent:${key}`,
      title: `Authorize account access on ${consents.length} machine(s)?`,
      body:
        `These machines have no account yet: ${targets}. ` +
        `Authorize them to use your subscription on the dashboard (one tap each). ` +
        `Nothing is enrolled until you approve.`,
      priority: 'medium',
      source: 'agent',
      offers: consents,
    });
    this.deps.log?.(`[account-follow-me] surfaced ${consents.length} enrollment consent offer(s)`);
    return { offered: consents };
  }

  /**
   * A portable account-follow-me mandate was delivered from the operator machine. Verify it (R4a),
   * then run the orchestrator with it. On allow, return an enroll-drive instruction; otherwise null
   * (verification failed, or the gate denied — never proceed, never self-authorize).
   */
  onMandateDelivered(args: {
    portable: PortableMandate;
    operatorEd25519PublicKey: crypto.KeyObject | string | Buffer;
    expectedOperatorMachineFingerprint: string;
    /** The (account,target,mechanism,email,nickname) this mandate is expected to authorize. */
    request: { accountId: string; accountEmail: string; targetMachineId: string; targetMachineNickname: string; mechanism?: FollowMeMechanism };
  }): EnrollDriveInstruction | null {
    const accept = acceptDeliveredMandate({
      portable: args.portable,
      operatorEd25519PublicKey: args.operatorEd25519PublicKey,
      expectedOperatorMachineFingerprint: args.expectedOperatorMachineFingerprint,
    });
    if (!accept.accepted) {
      this.deps.log?.(`[account-follow-me] delivered mandate rejected: ${accept.reason}`);
      return null;
    }
    const decision = this.deps.orchestrator.requestEnrollment({
      accountId: args.request.accountId,
      accountEmail: args.request.accountEmail,
      targetMachineId: args.request.targetMachineId,
      targetMachineNickname: args.request.targetMachineNickname,
      mechanism: args.request.mechanism,
      mandateId: accept.mandate.id,
    });
    if (!decision.proceed) {
      this.deps.log?.(`[account-follow-me] gate denied a verified mandate: ${decision.reason}`);
      return null;
    }
    return {
      accountId: decision.accountId,
      targetMachineId: decision.targetMachineId,
      mechanism: decision.mechanism,
      mandateId: accept.mandate.id,
    };
  }
}
