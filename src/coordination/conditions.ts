/**
 * Conditions registry — named, objective predicates that gate high-risk authorities.
 *
 * Structure > Willpower applied to delegation: a conditioned authority (e.g. a
 * future `execute-cutover`) fires ONLY when its named condition evaluates true from
 * REAL state — `integrity-gate-pass` ← `runIntegrityGate().passed`,
 * `parity-zero-divergence` ← `ParityMonitor.gate().cleared`. The agent's assertion
 * that "it's safe" is NEVER the input; the objective check is (threat-model T7/T10).
 *
 * Resolvers are INJECTED so this module stays decoupled from the integrity/parity
 * machinery. A condition with no wired resolver evaluates **false** (deny-safe): an
 * un-evaluable gate must never fall open. The first mandate (Justin's A/A/B) carries
 * NO conditioned authority, so nothing here is exercised yet — it is built for the
 * future cutover authority and tested on both sides of the boundary.
 */

/** A resolver returns the live truth of a condition from real state. */
export type ConditionResolver = () => boolean;

export class ConditionsRegistry {
  private readonly resolvers = new Map<string, ConditionResolver>();

  /** Register (or replace) the resolver for a named condition. */
  register(name: string, resolver: ConditionResolver): this {
    this.resolvers.set(name, resolver);
    return this;
  }

  /** True iff the condition is registered. */
  has(name: string): boolean {
    return this.resolvers.has(name);
  }

  /**
   * Evaluate a (possibly compound) condition. A `+`-joined expression
   * (e.g. 'integrity-gate-pass+parity-zero-divergence') is the AND of its parts —
   * ALL must resolve true. An unregistered part → false (deny-safe). Any resolver
   * that throws → false (deny-safe).
   */
  evaluate(expr: string): boolean {
    const parts = expr.split('+').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return false;
    for (const part of parts) {
      const resolver = this.resolvers.get(part);
      if (!resolver) return false;
      let result: boolean;
      try { result = resolver() === true; } catch { result = false; }
      if (!result) return false;
    }
    return true;
  }
}
