/**
 * GuardRegistry — boot-time self-registration of guard runtime getters
 * (GUARD-POSTURE-ENDPOINT-SPEC §2.1/§2.2).
 *
 * Constructed guard components register a SYNCHRONOUS in-memory getter for
 * each manifest key they own (one row PER declared sub-guard). The /guards
 * endpoint snapshots these getters per request; reconciliation against the
 * declared manifest turns "expected on this host but never registered" into
 * the `missing` state instead of a silent omission.
 *
 * Contract (Tier-1 enforced):
 *  - Getters MUST be synchronous in-memory property reads — no async, no
 *    file/process/tmux I/O. The endpoint's <100ms criterion depends on this.
 *  - A getter that THROWS is isolated per-guard and surfaces as `errored`
 *    (louder, not quieter) — one broken component must not take down the
 *    whole inventory.
 */

export interface GuardRuntimeStatus {
  enabled: boolean;
  dryRun?: boolean;
  /** Last tick epoch-ms. 0/absent while enabled reads as a dead tick loop
   *  (`on-stale`) — registration is not life. */
  lastTickAt?: number;
  jobCount?: number;
  pausedJobCount?: number;
}

export type GuardRuntimeGetter = () => GuardRuntimeStatus;

export type GuardRuntimeRead =
  | { kind: 'ok'; status: GuardRuntimeStatus }
  | { kind: 'error'; message: string }
  | { kind: 'unregistered' };

export class GuardRegistry {
  private readonly getters = new Map<string, GuardRuntimeGetter>();

  /** Register the runtime getter for a manifest key. Last registration wins
   *  (a respawned component re-registers over its dead predecessor). */
  register(key: string, getter: GuardRuntimeGetter): void {
    this.getters.set(key, getter);
  }

  has(key: string): boolean {
    return this.getters.has(key);
  }

  registeredKeys(): string[] {
    return [...this.getters.keys()].sort();
  }

  /** Snapshot one guard's runtime. Never throws — a throwing getter is the
   *  `errored` state's input, isolated per guard. */
  read(key: string): GuardRuntimeRead {
    const getter = this.getters.get(key);
    if (!getter) return { kind: 'unregistered' };
    try {
      const status = getter();
      if (!status || typeof status !== 'object' || typeof status.enabled !== 'boolean') {
        return { kind: 'error', message: 'getter returned a non-status value' };
      }
      return { kind: 'ok', status };
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }
}
