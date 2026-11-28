/**
 * The attention routing mode, with the dated retirement of the legacy per-item mode.
 *
 * Standard: "Notices Route to the Alerts Topic, Never a New One" (docs/STANDARDS-REGISTRY.md),
 * sub-obligation STD-SUBCOUNTDOWN-per-item-routing-retirement. Single-topic routing is the default
 * and the only mode for new work. `attentionRouting.mode: 'per-item'` survives only as a rollback
 * lever for installs that predate single-topic routing: until PER_ITEM_ROUTING_REMOVED_ON it still
 * works and logs a deprecation notice naming that date; from that date it is ignored (single-topic
 * is used) and the notice says so. No shipped source may select per-item: the ratchet
 * tests/unit/per-item-routing-retirement.test.ts pins every quoted 'per-item' in src/ and scripts/
 * to the known declarations, so new code that sets the mode fails the unit suite. A person can still
 * set it by hand before the date; that only logs the warning.
 */

/** The day the legacy per-item attention routing mode stops working (UTC). */
export const PER_ITEM_ROUTING_REMOVED_ON = '2027-03-01';

export type AttentionRoutingMode = 'single-topic' | 'per-item';

let routingClock: () => number = () => Date.now();
/**
 * Test seam only: the shared test setup (tests/vitest-setup.ts) pins this to a day before the
 * removal so the tests of the legacy path keep running until that path is deleted. Production
 * never calls it. `null` restores the real clock.
 */
export function setPerItemRoutingClockForTests(clock: (() => number) | null): void {
  routingClock = clock ?? (() => Date.now());
}

export function resolveAttentionRoutingMode(requested: unknown, nowMs: number = routingClock()): { mode: AttentionRoutingMode; notice: string | null } {
  if (requested !== 'per-item') return { mode: 'single-topic', notice: null };
  const removedAt = Date.parse(`${PER_ITEM_ROUTING_REMOVED_ON}T00:00:00Z`);
  if (nowMs >= removedAt) {
    return { mode: 'single-topic', notice: `[telegram] attentionRouting.mode "per-item" was retired on ${PER_ITEM_ROUTING_REMOVED_ON}; attention items now go to the single Attention topic. Remove the setting from messaging[].config.` };
  }
  return { mode: 'per-item', notice: `[telegram] attentionRouting.mode "per-item" is deprecated and stops working on ${PER_ITEM_ROUTING_REMOVED_ON}; after that every attention item goes to the single Attention topic. Remove the setting to switch now.` };
}
