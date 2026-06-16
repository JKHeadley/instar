/**
 * Tier-1 tests for the pool-consistent durable-ownership activation predicate
 * (spec: pool-consistent-multimachine-activation.md). Proves the fix for the live
 * Laptop↔Mini finding: the durable store activates wherever placement replication is
 * on (pool-consistent), NOT only on a dev-flagged machine — so a non-dev pool machine
 * (the Mini) no longer leaves the store dark and the seat dies on arrival.
 */
import { describe, it, expect } from 'vitest';
import { shouldActivateDurableOwnership, isPlacementReplicationEnabled } from '../../src/core/durableOwnershipActivation.js';

// Fake dev-gate: dev when config.developmentAgent === true (mirrors resolveDevAgentGate's
// shape closely enough for the predicate under test — the gate itself is tested elsewhere).
const devGate = (flag: unknown, config: unknown): boolean => {
  if (flag === true) return true;
  if (flag === false) return false;
  return (config as { developmentAgent?: unknown })?.developmentAgent === true;
};

const cfg = (over: Record<string, unknown> = {}) => ({ multiMachine: {}, ...over });
const withReplication = (on: boolean) => cfg({ multiMachine: { coherenceJournal: { replication: { enabled: on } } } });

describe('durable-ownership activation predicate', () => {
  it('THE FIX: a NON-dev machine with replication ON activates (the Mini case)', () => {
    const config = { developmentAgent: false, multiMachine: { coherenceJournal: { replication: { enabled: true } } } };
    expect(shouldActivateDurableOwnership(config, devGate)).toBe(true);
  });

  it('regression of the bug: a non-dev machine with replication OFF stays dark', () => {
    const config = { developmentAgent: false, multiMachine: { coherenceJournal: { replication: { enabled: false } } } };
    expect(shouldActivateDurableOwnership(config, devGate)).toBe(false);
  });

  it('a dev machine activates even without replication (dogfood opt-in preserved)', () => {
    const config = { developmentAgent: true, multiMachine: {} };
    expect(shouldActivateDurableOwnership(config, devGate)).toBe(true);
  });

  it('a dev machine WITH replication activates (the Laptop case)', () => {
    const config = { developmentAgent: true, multiMachine: { coherenceJournal: { replication: { enabled: true } } } };
    expect(shouldActivateDurableOwnership(config, devGate)).toBe(true);
  });

  it('a single-machine non-dev agent (no replication) stays on InMemory — strict no-op', () => {
    expect(shouldActivateDurableOwnership({ developmentAgent: false, multiMachine: {} }, devGate)).toBe(false);
  });

  it('replication signal requires the EXPLICIT === true (absent / truthy-but-not-true does not count)', () => {
    expect(isPlacementReplicationEnabled(withReplication(true))).toBe(true);
    expect(isPlacementReplicationEnabled(withReplication(false))).toBe(false);
    expect(isPlacementReplicationEnabled(cfg())).toBe(false); // absent
    expect(isPlacementReplicationEnabled({ multiMachine: { coherenceJournal: { replication: { enabled: 1 } } } })).toBe(false); // not === true
    expect(isPlacementReplicationEnabled(null)).toBe(false);
  });

  it('an explicit durableOwnership.enabled:true activates regardless of dev/replication', () => {
    const config = { developmentAgent: false, multiMachine: { durableOwnership: { enabled: true } } };
    expect(shouldActivateDurableOwnership(config, devGate)).toBe(true);
  });
});
