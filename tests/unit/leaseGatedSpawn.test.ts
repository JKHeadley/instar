/**
 * Unit tests for G3 lease-gated spawn decision (MESH-SELF-HEAL-SPEC §3.3, FD6).
 * Covers BOTH sides of every decision boundary (semantic-correctness standard).
 */
import { describe, it, expect } from 'vitest';
import {
  decideLeaseGatedSpawn,
  LeaseGatedSpawnSoakLedger,
  decideBindingCleanupOnKill,
  applyBindingCleanupOnKill,
  type BindingRegistryPort,
} from '../../src/core/leaseGatedSpawn.js';

const base = {
  holdsLease: true,
  flagEnabled: true,
  dryRun: false,
  singleMachine: false,
  forwardAvailable: true,
};

describe('decideLeaseGatedSpawn — G3 lease-gated spawn', () => {
  describe('legacy / no-op paths (must be byte-for-byte spawn)', () => {
    it('flag OFF → always spawn locally (legacy), even if not holding the lease', () => {
      const d = decideLeaseGatedSpawn({ ...base, flagEnabled: false, holdsLease: false });
      expect(d.spawnLocally).toBe(true);
      expect(d.action).toBe('spawn');
      expect(d.reason).toBe('flag-off-legacy');
    });

    it('single-machine → always spawn locally (no-op), even with flag on and holdsLease false', () => {
      // holdsLease defaults true on single-machine anyway, but the singleMachine
      // guard must win regardless so the gate is a strict no-op.
      const d = decideLeaseGatedSpawn({ ...base, singleMachine: true, holdsLease: false });
      expect(d.spawnLocally).toBe(true);
      expect(d.action).toBe('spawn');
      expect(d.reason).toBe('single-machine-noop');
    });
  });

  describe('multi-machine, flag on — gate on the fenced lease', () => {
    it('HOLDS lease → spawn locally', () => {
      const d = decideLeaseGatedSpawn({ ...base, holdsLease: true });
      expect(d.spawnLocally).toBe(true);
      expect(d.action).toBe('spawn');
      expect(d.reason).toBe('holds-lease');
    });

    it('does NOT hold lease + forward available → FORWARD (do not spawn) — fail-CLOSED', () => {
      const d = decideLeaseGatedSpawn({ ...base, holdsLease: false, forwardAvailable: true });
      expect(d.spawnLocally).toBe(false);
      expect(d.action).toBe('forward');
      expect(d.reason).toBe('not-holder-forward-to-owner');
    });

    it('does NOT hold lease + dryRun → would forward, but spawn locally this soak', () => {
      const d = decideLeaseGatedSpawn({ ...base, holdsLease: false, dryRun: true });
      expect(d.spawnLocally).toBe(true);
      expect(d.action).toBe('dry-run-would-forward');
      expect(d.reason).toContain('dry-run');
    });

    it('does NOT hold lease + forward seam UNAVAILABLE → spawn locally to avoid a strand (flagged)', () => {
      const d = decideLeaseGatedSpawn({ ...base, holdsLease: false, forwardAvailable: false });
      expect(d.spawnLocally).toBe(true);
      expect(d.action).toBe('spawn-forward-unavailable');
      expect(d.reason).toContain('no-forward-seam');
    });
  });

  describe('precedence', () => {
    it('flag-off beats every other input (legacy wins)', () => {
      const d = decideLeaseGatedSpawn({
        holdsLease: false, flagEnabled: false, dryRun: true, singleMachine: false, forwardAvailable: true,
      });
      expect(d.action).toBe('spawn');
      expect(d.reason).toBe('flag-off-legacy');
    });

    it('single-machine beats holdsLease/forward state (no-op wins over forward)', () => {
      const d = decideLeaseGatedSpawn({
        holdsLease: false, flagEnabled: true, dryRun: false, singleMachine: true, forwardAvailable: true,
      });
      expect(d.action).toBe('spawn');
      expect(d.reason).toBe('single-machine-noop');
    });

    it('dryRun takes precedence over forward-unavailable when not holding the lease', () => {
      const d = decideLeaseGatedSpawn({
        holdsLease: false, flagEnabled: true, dryRun: true, singleMachine: false, forwardAvailable: false,
      });
      // dry-run soak observes the would-forward intent; it always spawns.
      expect(d.action).toBe('dry-run-would-forward');
      expect(d.spawnLocally).toBe(true);
    });
  });

  // Operator directive 2026-06-27: observe-mode MUST record evaluable
  // counterfactual evidence AND be able to produce a promotion recommendation —
  // the loop that "never closes" for dark features.
  describe('soak ledger — evaluable evidence + promotion signal', () => {
    const t = '2026-06-27T00:00:00.000Z';

    it('counts the load-bearing counterfactual: dry-run would-have-prevented-duplicate', () => {
      const led = new LeaseGatedSpawnSoakLedger();
      // 3 non-holder inbounds during a dry-run soak = 3 duplicates the gate would have prevented.
      for (let i = 0; i < 3; i++) {
        const d = decideLeaseGatedSpawn({ ...base, holdsLease: false, dryRun: true });
        led.record(d, t);
      }
      // 2 normal holder spawns.
      for (let i = 0; i < 2; i++) led.record(decideLeaseGatedSpawn({ ...base, holdsLease: true }), t);
      const s = led.summary();
      expect(s.decisions).toBe(5);
      expect(s.wouldHavePreventedDuplicate).toBe(3);
      expect(s.spawnedAsHolder).toBe(2);
      expect(s.firstAt).toBe(t);
    });

    it('produces a PROMOTE recommendation once dry-run shows real prevented duplicates', () => {
      const led = new LeaseGatedSpawnSoakLedger();
      led.record(decideLeaseGatedSpawn({ ...base, holdsLease: false, dryRun: true }), t);
      const sig = led.promotionSignal();
      expect(sig.recommendation).toBe('promote');
      expect(sig.why).toMatch(/prevented 1 duplicate/);
    });

    it('recommends CONSIDER-REMOVAL when it soaked but never fired usefully', () => {
      const led = new LeaseGatedSpawnSoakLedger();
      // Only holder spawns + legacy — the gate never had anything to prevent here.
      led.record(decideLeaseGatedSpawn({ ...base, holdsLease: true }), t);
      led.record(decideLeaseGatedSpawn({ ...base, flagEnabled: false }), t);
      const sig = led.promotionSignal();
      expect(sig.recommendation).toBe('consider-removal');
    });

    it('reports ENFORCING once the gate is live and actually forwarding', () => {
      const led = new LeaseGatedSpawnSoakLedger();
      led.record(decideLeaseGatedSpawn({ ...base, holdsLease: false }), t); // enabled, non-dry-run, forwards
      const sig = led.promotionSignal();
      expect(sig.recommendation).toBe('enforcing');
      expect(led.summary().forwarded).toBe(1);
    });

    it('keep-soaking when nothing observed yet', () => {
      expect(new LeaseGatedSpawnSoakLedger().promotionSignal().recommendation).toBe('keep-soaking');
    });
  });

  describe('decideBindingCleanupOnKill — G3.4 single-writer binding lifecycle', () => {
    it('flag OFF → skip-legacy (binding persists across kill, as before)', () => {
      const d = decideBindingCleanupOnKill({ flagEnabled: false, dryRun: false, hasBinding: true });
      expect(d.clearNow).toBe(false);
      expect(d.action).toBe('skip-legacy');
    });

    it('no binding for the killed session → skip-no-binding (nothing to clear)', () => {
      const d = decideBindingCleanupOnKill({ flagEnabled: true, dryRun: false, hasBinding: false });
      expect(d.clearNow).toBe(false);
      expect(d.action).toBe('skip-no-binding');
    });

    it('enabled + dryRun + binding → would-clear, but DO NOT clear this soak', () => {
      const d = decideBindingCleanupOnKill({ flagEnabled: true, dryRun: true, hasBinding: true });
      expect(d.clearNow).toBe(false);
      expect(d.action).toBe('dry-run-would-clear');
    });

    it('enabled + live + binding → CLEAR the stale binding now', () => {
      const d = decideBindingCleanupOnKill({ flagEnabled: true, dryRun: false, hasBinding: true });
      expect(d.clearNow).toBe(true);
      expect(d.action).toBe('clear');
    });

    it('enabled + live + binding + respawnImminent → skip-respawn-kill (KEEP binding so recovery resolves)', () => {
      const d = decideBindingCleanupOnKill({ flagEnabled: true, dryRun: false, hasBinding: true, respawnImminent: true });
      expect(d.clearNow).toBe(false);
      expect(d.action).toBe('skip-respawn-kill');
    });

    it('respawnImminent takes precedence over dryRun → no would-clear counterfactual (clearing would BREAK recovery)', () => {
      const d = decideBindingCleanupOnKill({ flagEnabled: true, dryRun: true, hasBinding: true, respawnImminent: true });
      expect(d.clearNow).toBe(false);
      expect(d.action).toBe('skip-respawn-kill');
    });
  });

  describe('soak ledger — binding-cleanup counterfactual + promotion', () => {
    const t = '2026-06-27T00:00:00.000Z';

    it('counts would-have-cleared in dry-run; not on skip-legacy / skip-no-binding', () => {
      const led = new LeaseGatedSpawnSoakLedger();
      led.recordBindingCleanup(decideBindingCleanupOnKill({ flagEnabled: true, dryRun: true, hasBinding: true }), t);
      led.recordBindingCleanup(decideBindingCleanupOnKill({ flagEnabled: true, dryRun: true, hasBinding: true }), t);
      led.recordBindingCleanup(decideBindingCleanupOnKill({ flagEnabled: false, dryRun: false, hasBinding: true }), t); // skip-legacy
      led.recordBindingCleanup(decideBindingCleanupOnKill({ flagEnabled: true, dryRun: false, hasBinding: false }), t); // skip-no-binding
      const s = led.summary();
      expect(s.bindingCleanupDecisions).toBe(2);
      expect(s.wouldHaveClearedStaleBinding).toBe(2);
      expect(s.bindingsCleared).toBe(0);
    });

    it('PROMOTE once dry-run shows it would have cleared a real stale binding', () => {
      const led = new LeaseGatedSpawnSoakLedger();
      led.recordBindingCleanup(decideBindingCleanupOnKill({ flagEnabled: true, dryRun: true, hasBinding: true }), t);
      expect(led.promotionSignal().recommendation).toBe('promote');
    });

    it('ENFORCING once it has actually cleared a stale binding live', () => {
      const led = new LeaseGatedSpawnSoakLedger();
      led.recordBindingCleanup(decideBindingCleanupOnKill({ flagEnabled: true, dryRun: false, hasBinding: true }), t);
      const sig = led.promotionSignal();
      expect(sig.recommendation).toBe('enforcing');
      expect(sig.why).toMatch(/cleared 1 stale binding/);
      expect(led.summary().bindingsCleared).toBe(1);
    });
  });

  describe('applyBindingCleanupOnKill — wiring integrity (binding IFF live session)', () => {
    // A fake registry standing in for TelegramAdapter — records unregister calls
    // and lets us assert the binding is gone after a kill.
    function fakeRegistry(initial: Record<string, number>): BindingRegistryPort & { bindings: Map<string, number>; unregistered: number[] } {
      const bindings = new Map<string, number>(Object.entries(initial));
      const unregistered: number[] = [];
      return {
        bindings,
        unregistered,
        getTopicForSession(sessionName: string): number | null {
          return bindings.get(sessionName) ?? null;
        },
        unregisterTopic(topicId: number): void {
          unregistered.push(topicId);
          for (const [k, v] of bindings) if (v === topicId) bindings.delete(k);
        },
      };
    }
    const t = '2026-06-27T00:00:00.000Z';

    it('enabled + live: kill → unregisterTopic called → binding GONE (a dead session cannot resurrect)', () => {
      const reg = fakeRegistry({ 'sess-A': 42 });
      const led = new LeaseGatedSpawnSoakLedger();
      const d = applyBindingCleanupOnKill({ registry: reg, sessionName: 'sess-A', flagEnabled: true, dryRun: false, ledger: led, nowIso: t });
      expect(d.action).toBe('clear');
      expect(reg.unregistered).toEqual([42]);
      // The invariant: after kill, the next inbound resolves to NO binding → no resume of a dead session.
      expect(reg.getTopicForSession('sess-A')).toBeNull();
      expect(led.summary().bindingsCleared).toBe(1);
    });

    it('dryRun: records the counterfactual but does NOT actually clear (binding survives the soak)', () => {
      const reg = fakeRegistry({ 'sess-A': 42 });
      const led = new LeaseGatedSpawnSoakLedger();
      const d = applyBindingCleanupOnKill({ registry: reg, sessionName: 'sess-A', flagEnabled: true, dryRun: true, ledger: led, nowIso: t });
      expect(d.action).toBe('dry-run-would-clear');
      expect(reg.unregistered).toEqual([]);
      expect(reg.getTopicForSession('sess-A')).toBe(42); // unchanged
      expect(led.summary().wouldHaveClearedStaleBinding).toBe(1);
    });

    it('respawnImminent (recovery bounce): enabled+live but binding SURVIVES so the same-topic respawn still resolves it', () => {
      const reg = fakeRegistry({ 'sess-A': 42 });
      const led = new LeaseGatedSpawnSoakLedger();
      const auditEntries: string[] = [];
      const d = applyBindingCleanupOnKill({
        registry: reg, sessionName: 'sess-A', flagEnabled: true, dryRun: false,
        ledger: led, nowIso: t, respawnImminent: true,
        audit: (e) => auditEntries.push(e.event),
      });
      expect(d.action).toBe('skip-respawn-kill');
      expect(reg.unregistered).toEqual([]); // binding NOT cleared
      expect(reg.getTopicForSession('sess-A')).toBe(42); // recovery's getSessionForTopic still resolves
      expect(led.summary().bindingsCleared).toBe(0);
      expect(led.summary().wouldHaveClearedStaleBinding).toBe(0); // not a counterfactual either
      expect(auditEntries).toEqual([]); // no transition → no audit
    });

    it('flag OFF: strict no-op — binding untouched, nothing recorded', () => {
      const reg = fakeRegistry({ 'sess-A': 42 });
      const led = new LeaseGatedSpawnSoakLedger();
      applyBindingCleanupOnKill({ registry: reg, sessionName: 'sess-A', flagEnabled: false, dryRun: false, ledger: led, nowIso: t });
      expect(reg.unregistered).toEqual([]);
      expect(reg.getTopicForSession('sess-A')).toBe(42);
      expect(led.summary().bindingCleanupDecisions).toBe(0);
    });

    it('audit fires on a real transition (clear) with the right entry; NOT on a skip', () => {
      const cleared: string[] = [];
      const auditEntries: Array<{ event: string; topicId: number; dryRun: boolean }> = [];
      // enabled + live → clear → audit 'binding-cleared'
      applyBindingCleanupOnKill({
        registry: fakeRegistry({ 'sess-A': 42 }), sessionName: 'sess-A',
        flagEnabled: true, dryRun: false, ledger: new LeaseGatedSpawnSoakLedger(), nowIso: t,
        log: (m) => cleared.push(m),
        audit: (e) => auditEntries.push({ event: e.event, topicId: e.topicId, dryRun: e.dryRun }),
      });
      expect(auditEntries).toEqual([{ event: 'binding-cleared', topicId: 42, dryRun: false }]);

      // dryRun → would-clear → audit 'binding-would-clear'
      auditEntries.length = 0;
      applyBindingCleanupOnKill({
        registry: fakeRegistry({ 'sess-A': 7 }), sessionName: 'sess-A',
        flagEnabled: true, dryRun: true, ledger: new LeaseGatedSpawnSoakLedger(), nowIso: t,
        audit: (e) => auditEntries.push({ event: e.event, topicId: e.topicId, dryRun: e.dryRun }),
      });
      expect(auditEntries).toEqual([{ event: 'binding-would-clear', topicId: 7, dryRun: true }]);

      // flag off → skip → NO audit
      auditEntries.length = 0;
      applyBindingCleanupOnKill({
        registry: fakeRegistry({ 'sess-A': 9 }), sessionName: 'sess-A',
        flagEnabled: false, dryRun: false, ledger: new LeaseGatedSpawnSoakLedger(), nowIso: t,
        audit: (e) => auditEntries.push({ event: e.event, topicId: e.topicId, dryRun: e.dryRun }),
      });
      expect(auditEntries).toEqual([]);
    });

    it('killed session that had NO binding: no clear, no counterfactual (not a stale-binding event)', () => {
      const reg = fakeRegistry({ 'sess-A': 42 });
      const led = new LeaseGatedSpawnSoakLedger();
      const d = applyBindingCleanupOnKill({ registry: reg, sessionName: 'sess-UNBOUND', flagEnabled: true, dryRun: false, ledger: led, nowIso: t });
      expect(d.action).toBe('skip-no-binding');
      expect(reg.unregistered).toEqual([]);
      expect(led.summary().bindingCleanupDecisions).toBe(0);
    });
  });

  describe('invariant — the gate NEVER strands a message', () => {
    it('every input combination that does not spawn must be a real forward (seam available)', () => {
      for (const holdsLease of [true, false]) {
        for (const flagEnabled of [true, false]) {
          for (const dryRun of [true, false]) {
            for (const singleMachine of [true, false]) {
              for (const forwardAvailable of [true, false]) {
                const d = decideLeaseGatedSpawn({ holdsLease, flagEnabled, dryRun, singleMachine, forwardAvailable });
                if (!d.spawnLocally) {
                  // The only non-spawn outcome is a genuine forward with a seam.
                  expect(d.action).toBe('forward');
                  expect(forwardAvailable).toBe(true);
                }
              }
            }
          }
        }
      }
    });
  });
});
