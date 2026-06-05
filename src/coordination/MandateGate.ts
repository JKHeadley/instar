/**
 * MandateGate — the deny-by-default enforcement point for autonomous A2A actions.
 *
 * `evaluate()` runs the spec's ordered checks (§4) and AUDITS every decision (allow
 * AND deny). With NO valid mandate loaded the gate denies everything — so the system
 * is inert (weakens nothing) until Justin authors a mandate through the PIN-gated path.
 *
 * Order (any miss → deny, audited):
 *   1. mandate exists
 *   2. authorship valid (T1/T2)
 *   3. not expired (T4)
 *   4. not revoked (T5)
 *   5. caller is a named party (T6/T9)
 *   6. an Authority matches `action` AND `params` are within `bounds`
 *   7. if the Authority requires a condition, it evaluates true from REAL state (T7/T10)
 *   8. → allow
 *
 * The agent's "judgment" never authorizes anything — the mandate (a human-authored
 * policy) and the objective conditions do. This is `requester ≠ authorizer` preserved.
 */

import type { MandateStore } from './MandateStore.js';
import type { ConditionsRegistry } from './conditions.js';
import type { MandateAudit } from './MandateAudit.js';
import type { Authority, MandateEvaluation, MandateAuditEntry } from './types.js';

export interface MandateGateResult {
  decision: 'allow' | 'deny';
  reason: string;
  conditionResult: boolean | null;
  audit: MandateAuditEntry;
}

/** Deterministic, key-sorted serialization for value comparison. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** Every key in `bounds` must be present in `params` with a deeply-equal value.
 *  `params` MAY carry extra keys — the bounds only constrain the keys they name. */
export function paramsSatisfyBounds(params: Record<string, unknown>, bounds: Record<string, unknown>): boolean {
  for (const key of Object.keys(bounds)) {
    if (!(key in params)) return false;
    if (stableStringify(params[key]) !== stableStringify(bounds[key])) return false;
  }
  return true;
}

export interface MandateGateDeps {
  store: MandateStore;
  conditions: ConditionsRegistry;
  audit: MandateAudit;
  now?: () => number;
}

export class MandateGate {
  private readonly d: MandateGateDeps;
  constructor(deps: MandateGateDeps) {
    this.d = deps;
  }

  private nowMs(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  private deny(ev: MandateEvaluation, reason: string, conditionResult: boolean | null = null): MandateGateResult {
    const audit = this.d.audit.record({
      mandateId: ev.mandateId, agentFp: ev.agentFp, action: ev.action,
      decision: 'deny', reason, conditionResult,
    });
    return { decision: 'deny', reason, conditionResult, audit };
  }

  private allow(ev: MandateEvaluation, reason: string, conditionResult: boolean | null): MandateGateResult {
    const audit = this.d.audit.record({
      mandateId: ev.mandateId, agentFp: ev.agentFp, action: ev.action,
      decision: 'allow', reason, conditionResult,
    });
    return { decision: 'allow', reason, conditionResult, audit };
  }

  evaluate(ev: MandateEvaluation): MandateGateResult {
    // 1. exists
    const mandate = this.d.store.get(ev.mandateId);
    if (!mandate) return this.deny(ev, `mandate "${ev.mandateId}" not found`);

    // 2. authorship valid
    if (!this.d.store.verifyAuthorship(mandate)) {
      return this.deny(ev, 'mandate authorship proof is invalid (forged or edited)');
    }

    // 3. not expired
    if (this.nowMs() > Date.parse(mandate.expiresAt)) {
      return this.deny(ev, `mandate expired at ${mandate.expiresAt}`);
    }

    // 4. not revoked
    if (mandate.revoked) {
      return this.deny(ev, `mandate revoked at ${mandate.revoked.at}: ${mandate.revoked.reason}`);
    }

    // 5. caller is a named party
    if (!mandate.agents.includes(ev.agentFp)) {
      return this.deny(ev, `agent ${ev.agentFp} is not a named party to this mandate`);
    }

    // 6. an authority matches action + params within bounds
    const matching: Authority | undefined = mandate.authorities.find(
      (a) => a.action === ev.action && paramsSatisfyBounds(ev.params, a.bounds),
    );
    if (!matching) {
      const sameAction = mandate.authorities.some((a) => a.action === ev.action);
      return this.deny(
        ev,
        sameAction
          ? `params exceed the bounds of authority "${ev.action}"`
          : `no authority for action "${ev.action}" in this mandate`,
      );
    }

    // 7. condition (if any) evaluates true from real state
    if (matching.requiresCondition) {
      const ok = this.d.conditions.evaluate(matching.requiresCondition);
      if (!ok) {
        return this.deny(ev, `objective condition "${matching.requiresCondition}" not met`, false);
      }
      return this.allow(ev, `authority "${ev.action}" granted (condition "${matching.requiresCondition}" met)`, true);
    }

    // 8. allow (no condition)
    return this.allow(ev, `authority "${ev.action}" granted`, null);
  }
}
