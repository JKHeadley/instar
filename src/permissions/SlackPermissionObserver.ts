/**
 * SlackPermissionObserver — the single object the SlackAdapter calls to evaluate a
 * message against the permission gate. Composes resolver → gate → ledger.
 *
 * Slice 0 ships OBSERVE-ONLY: `observe()` evaluates and RECORDS the verdict but
 * never blocks the message path (enforce=false). This lets us measure the gate's
 * decisions (and false-positive rate) against real traffic before enforcement is
 * ever switched on (§11). It must NEVER throw — a failure here cannot break delivery.
 *
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §6.6, §6.10, §11.
 */

import type { PermissionVerdict } from './types.js';
import type { SlackPrincipalResolver } from './SlackPrincipalResolver.js';
import type { SlackPermissionGate } from './SlackPermissionGate.js';
import type { PermissionDecisionLedger } from './PermissionDecisionLedger.js';

export interface ObserveInput {
  slackUserId: string;
  displayName?: string;
  text: string;
  directed: boolean;
  channel?: string;
}

export interface SlackPermissionObserverDeps {
  resolver: SlackPrincipalResolver;
  gate: SlackPermissionGate;
  ledger: PermissionDecisionLedger;
  /** When true the observer would ENFORCE (block). Slice 0 ships observe-only (false). */
  enforce?: boolean;
}

export class SlackPermissionObserver {
  constructor(private readonly deps: SlackPermissionObserverDeps) {}

  /** Resolve → evaluate → record (observe-only). Returns the verdict; never throws. */
  async observe(input: ObserveInput): Promise<PermissionVerdict | null> {
    try {
      const principal = this.deps.resolver.resolve(input.slackUserId, input.displayName);
      const verdict = await this.deps.gate.evaluate({
        principal,
        text: input.text,
        directed: input.directed,
        channel: input.channel,
      });
      this.deps.ledger.record(verdict, { channel: input.channel, enforced: this.enforcing });
      return verdict;
    } catch {
      // Observe-only: a gate/ledger failure must NEVER break the message path.
      return null;
    }
  }

  get enforcing(): boolean {
    return this.deps.enforce ?? false;
  }
}
