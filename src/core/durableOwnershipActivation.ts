/**
 * durableOwnershipActivation — the pool-consistent activation predicate for the
 * cross-machine durable ownership store (spec:
 * docs/specs/pool-consistent-multimachine-activation.md).
 *
 * The transfer fix's durable store + OwnershipApplier MUST run on every machine that
 * CONSUMES replicated placement journals — otherwise a seat transferred TO a machine
 * whose store is dark never materializes ownership there and the move dies on arrival
 * (the live Laptop↔Mini finding, 2026-06-16: the Mini's echo wasn't a dev agent, so a
 * purely per-machine dev-gate left the store dark there while the Laptop's was live).
 *
 * So activation is the OR of:
 *   - the per-machine dev-agent gate (a dev agent opts in to dogfood), AND
 *   - the explicit, pool-consistent `multiMachine.coherenceJournal.replication.enabled
 *     === true` signal — the SAME one gating the placement-replication applier
 *     (`journalSyncApplier`). Invariant: a machine running placement replication runs the
 *     ownership applier + durable store too (they consume the same replicated placements).
 *
 * A single-machine agent (no replication, not dev) stays on the in-memory store — a
 * strict no-op.
 */

/** The replication signal: explicit opt-in (`=== true`); ConfigDefaults leaves it absent. */
export function isPlacementReplicationEnabled(config: unknown): boolean {
  const c = config as { multiMachine?: { coherenceJournal?: { replication?: { enabled?: unknown } } } } | null;
  return c?.multiMachine?.coherenceJournal?.replication?.enabled === true;
}

/**
 * Whether to activate the durable ownership store + applier on THIS machine.
 * `isDevAgentGate` is the injected `resolveDevAgentGate` (so this stays pure/testable).
 */
export function shouldActivateDurableOwnership(
  config: unknown,
  // The injected `resolveDevAgentGate` — typed loosely so the real gate
  // (`(boolean|undefined, DevAgentGateConfig|undefined) => boolean`) and test fakes
  // both satisfy it without importing the gate's config type here.
  isDevAgentGate: (flag: any, config: any) => boolean,
): boolean {
  const c = config as { multiMachine?: { durableOwnership?: { enabled?: boolean } } } | null;
  const devOn = isDevAgentGate(c?.multiMachine?.durableOwnership?.enabled, config);
  return devOn || isPlacementReplicationEnabled(config);
}

// (pool-consistent activation — see docs/specs/pool-consistent-multimachine-activation.md)
