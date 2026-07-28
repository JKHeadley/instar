/**
 * wireRegistrySync — the named G2 wiring (spec §8 G2).
 *
 * The Phase-0 finding was a WIRING gap: MultiMachineCoordinator emits
 * `roleChange` (and now `leaseEpochChange`) but no subscriber marked the
 * registry dirty, so the durable push never fired. The spec demands the fix
 * NAME the wiring rather than restate intent — this factory IS that wiring,
 * extracted as a testable seam so a wiring-integrity test can assert the
 * subscription exists and that a simulated role change triggers a push (the
 * test that would have caught Phase 0).
 */

export interface CoordinatorEventSource {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export interface RegistryDirtySink {
  markRegistryDirty(reason: string): void;
}

export interface RegistrySyncWiring {
  /** Detach the subscriptions (used on shutdown / in tests). */
  unwire(): void;
  /** Event names this wiring subscribes to (asserted by wiring-integrity tests). */
  readonly wiredEvents: readonly string[];
}

/**
 * Subscribe a registry-dirty sink (the RegistrySyncDebouncer) to the
 * coordinator's authority-changing events. Returns a handle that can detach
 * the subscriptions and reports which events it wired (so tests can assert the
 * wiring is real, not dead code).
 */
export function wireRegistrySync(
  coordinator: CoordinatorEventSource,
  sink: RegistryDirtySink,
): RegistrySyncWiring {
  const onRole = (from: unknown, to: unknown) =>
    sink.markRegistryDirty(`roleChange ${String(from)}->${String(to)}`);
  const onEpoch = (epoch: unknown) => sink.markRegistryDirty(`leaseEpoch=${String(epoch)}`);

  coordinator.on('roleChange', onRole);
  coordinator.on('leaseEpochChange', onEpoch);

  return {
    wiredEvents: ['roleChange', 'leaseEpochChange'],
    unwire() {
      coordinator.off('roleChange', onRole);
      coordinator.off('leaseEpochChange', onEpoch);
    },
  };
}
