/**
 * RenderedPlanStore — the S2-3/C3-4/C5-3 canonical rendered-plan machinery of
 * the Routing Control Room PIN surfaces (docs/specs/routing-control-room-
 * spend-alerts.md, Increment B, Surface 2).
 *
 * The PIN authorizes a CANONICAL SERVER-RENDERED PLAN — nothing else applies:
 *  - render(): takes the structured request, enumerates EVERY field the commit
 *    will change into an immutable plan snapshot (plain language + typed
 *    fields), pins the version(s) of every governed store the plan touches,
 *    mints a single-use nonce, stamps a short TTL.
 *  - commit(): validates plan exists / not consumed / not expired / nonce
 *    matches / pinned versions still current — then returns EXACTLY the
 *    snapshot's fields. A request field absent from the render can never be
 *    committed (the smuggled-field gap is closed by construction: the commit
 *    path never sees the original request).
 *  - The nonce is consumed on commit (no replay); an expired plan must be
 *    re-rendered; a version drift refuses deterministically ("re-rendered —
 *    here's the fresh plan" is the caller's UX).
 *
 * No separable "approved-plan token" outlives the single commit — a captured
 * approval is worthless (C3-4).
 */

import crypto from 'node:crypto';

export const PLAN_TTL_MS = 10 * 60 * 1000;

export type PlanAction = 'caps-adjust' | 'go-live' | 'unfreeze' | 'price-promote';

export interface RenderedPlan {
  planId: string;
  nonce: string;
  action: PlanAction;
  /** The plain-language enumeration the operator PIN-approves. */
  renderedText: string;
  /** The EXACT typed fields the commit will apply — the ONLY commit input. */
  fields: Record<string, unknown>;
  /** Store-version pins (e.g. { capsStore: 3 }) checked at commit (C5-3). */
  versionsPinned: Record<string, number>;
  expiresAt: number;
  consumed: boolean;
  renderedAt: number;
}

export class PlanCommitError extends Error {
  constructor(public code: 'unknown-plan' | 'consumed' | 'expired' | 'bad-nonce' | 'version-drift', msg: string) {
    super(msg);
    this.name = 'PlanCommitError';
  }
}

export class RenderedPlanStore {
  private plans = new Map<string, RenderedPlan>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(opts?: { now?: () => number; ttlMs?: number }) {
    this.now = opts?.now ?? (() => Date.now());
    this.ttlMs = opts?.ttlMs ?? PLAN_TTL_MS;
  }

  /** Render an immutable plan snapshot. The caller provides the plain-language text and the exact typed fields. */
  render(action: PlanAction, renderedText: string, fields: Record<string, unknown>, versionsPinned: Record<string, number>): RenderedPlan {
    this.prune();
    const plan: RenderedPlan = {
      planId: crypto.randomBytes(8).toString('hex'),
      nonce: crypto.randomBytes(16).toString('hex'),
      action,
      renderedText,
      fields: structuredClone(fields),
      versionsPinned: { ...versionsPinned },
      expiresAt: this.now() + this.ttlMs,
      consumed: false,
      renderedAt: this.now(),
    };
    this.plans.set(plan.planId, plan);
    return plan;
  }

  /**
   * Validate + consume. `currentVersions` supplies the LIVE version of every
   * governed store; commit refuses on a mismatch of any store the plan pinned.
   * Returns the immutable snapshot fields — the SOLE commit input.
   */
  commit(planId: string, nonce: string, currentVersions: Record<string, number>): RenderedPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new PlanCommitError('unknown-plan', 'no such plan — render one first');
    if (plan.consumed) throw new PlanCommitError('consumed', 'plan already committed (single-use nonce)');
    if (this.now() > plan.expiresAt) throw new PlanCommitError('expired', 'plan expired — re-render');
    const a = crypto.createHash('sha256').update(String(nonce)).digest();
    const b = crypto.createHash('sha256').update(plan.nonce).digest();
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new PlanCommitError('bad-nonce', 'nonce mismatch');
    }
    for (const [store, pinned] of Object.entries(plan.versionsPinned)) {
      if (currentVersions[store] !== pinned) {
        throw new PlanCommitError('version-drift', `store '${store}' changed since the plan was rendered (pinned ${pinned}, is ${currentVersions[store]}) — re-rendered plan required`);
      }
    }
    plan.consumed = true; // consume BEFORE returning — no replay even on a downstream failure
    return plan;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, p] of this.plans) {
      if (p.consumed || now > p.expiresAt + this.ttlMs) this.plans.delete(id);
    }
  }
}
