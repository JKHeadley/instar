/**
 * Wiring-integrity guard for the account-follow-me cross-machine sign-in
 * BUDGET CHAIN.
 *
 * A single "Set up" tap on the Subscriptions grid nests four budgets:
 *
 *   L1  POST /subscription-pool/matrix/start-cell        (fronting machine route)
 *   L2  ├─ mandate delivery over the mesh (15s)
 *       └─ relay fetch → the target's enroll/start
 *   L3     POST /subscription-pool/follow-me/enroll/start (target machine route)
 *   L4       FrameworkLoginDriver.drive() pane scrape     (remoteScrapeTimeoutMs)
 *
 * Each outer budget MUST strictly exceed everything it wraps. When it doesn't,
 * a dumb timer kills a still-legitimate operation and REPLACES the handler's
 * honest classified outcome with a bare "Request timeout" — the operator loses
 * the diagnosis entirely.
 *
 * Regression under test (2026-08-20, operator report "Couldn't start: Request
 * timeout" on a cross-machine cell): L1 and L3 inherited the 30s DEFAULT while
 * L2's relay was hard-coded to 40s and L4 was configured to 180s — the
 * outermost budget was the SMALLEST in the stack.
 *
 * Asserted against the PRODUCTION map + matcher imported directly, never a
 * hand-rolled copy (PR-#334 dead-code lesson).
 */

import { describe, it, expect } from 'vitest';
import {
  buildRequestTimeoutOverrides,
  resolveRequestTimeout,
  resolveFollowMeBudgets,
  FOLLOWME_MANDATE_DELIVERY_BUDGET_MS,
  FOLLOWME_DEFAULT_SCRAPE_TIMEOUT_MS,
  FOLLOWME_SIMPLE_RELAY_FETCH_MS,
  FOLLOWME_SIMPLE_RELAY_ROUTE_MS,
} from '../../src/server/middleware.js';

const DEFAULT_MS = 30_000;

/** The operator-tunable knob, including the value that produced the live report. */
const SCRAPE_BUDGETS = [undefined, 60_000, 180_000, 240_000];

describe('account-follow-me cross-machine budget chain', () => {
  describe.each(SCRAPE_BUDGETS)('remoteScrapeTimeoutMs = %s', (scrape) => {
    const b = resolveFollowMeBudgets(scrape);
    const overrides = buildRequestTimeoutOverrides({ followMeRemoteScrapeTimeoutMs: scrape });
    const routeFor = (p: string) => resolveRequestTimeout(p, DEFAULT_MS, overrides);

    it('orders the chain strictly outermost-largest', () => {
      // L4 < L3
      expect(b.enrollStartRouteMs).toBeGreaterThan(b.scrapeMs);
      // L3 < L2
      expect(b.relayFetchMs).toBeGreaterThan(b.enrollStartRouteMs);
      // L2 (+ mandate delivery) < L1
      expect(b.startCellRouteMs).toBeGreaterThan(
        b.relayFetchMs + FOLLOWME_MANDATE_DELIVERY_BUDGET_MS,
      );
    });

    it('honours the configured scrape budget as the chain floor', () => {
      expect(b.scrapeMs).toBe(scrape ?? FOLLOWME_DEFAULT_SCRAPE_TIMEOUT_MS);
    });

    it('routes start-cell to its derived budget, never the 30s default', () => {
      const ms = routeFor('/subscription-pool/matrix/start-cell');
      expect(ms).toBe(b.startCellRouteMs);
      expect(ms).toBeGreaterThan(DEFAULT_MS);
    });

    it('routes the target-side enroll/start above its own pane scrape', () => {
      const ms = routeFor('/subscription-pool/follow-me/enroll/start');
      expect(ms).toBe(b.enrollStartRouteMs);
      expect(ms).toBeGreaterThan(b.scrapeMs);
    });

    it('covers the parameterised target-side completion routes', () => {
      // These sit UNDER the '/subscription-pool/follow-me/enroll' prefix; the
      // S7 email gate runs here, so a 408 mid-add would strand the enrollment.
      for (const p of [
        '/subscription-pool/follow-me/enroll/codex-sagemindai/submit-code',
        '/subscription-pool/follow-me/enroll/codex-sagemindai/cancel',
      ]) {
        expect(routeFor(p)).toBeGreaterThan(DEFAULT_MS);
      }
    });

    it('start-cell outlives the whole peer round-trip it awaits', () => {
      expect(routeFor('/subscription-pool/matrix/start-cell')).toBeGreaterThan(
        routeFor('/subscription-pool/follow-me/enroll/start'),
      );
    });
  });

  describe('simple fronting relays (submit-code, cancel)', () => {
    const overrides = buildRequestTimeoutOverrides();
    const routeFor = (p: string) => resolveRequestTimeout(p, DEFAULT_MS, overrides);

    it.each([
      '/subscription-pool/follow-me/submit-code',
      '/subscription-pool/follow-me/cancel',
    ])('%s outlives its own relay fetch', (p) => {
      const ms = routeFor(p);
      expect(ms).toBe(FOLLOWME_SIMPLE_RELAY_ROUTE_MS);
      expect(ms).toBeGreaterThan(FOLLOWME_SIMPLE_RELAY_FETCH_MS);
      expect(ms).toBeGreaterThan(DEFAULT_MS);
    });
  });

  it('leaves unrelated subscription-pool routes on the default budget', () => {
    const overrides = buildRequestTimeoutOverrides();
    // Guards against a too-greedy prefix swallowing the whole namespace.
    for (const p of ['/subscription-pool', '/subscription-pool/poll', '/subscription-pool/swap']) {
      expect(resolveRequestTimeout(p, DEFAULT_MS, overrides)).toBe(DEFAULT_MS);
    }
  });

  it('widening the operator knob widens every budget above it', () => {
    const small = resolveFollowMeBudgets(60_000);
    const large = resolveFollowMeBudgets(180_000);
    expect(large.enrollStartRouteMs).toBeGreaterThan(small.enrollStartRouteMs);
    expect(large.relayFetchMs).toBeGreaterThan(small.relayFetchMs);
    expect(large.startCellRouteMs).toBeGreaterThan(small.startCellRouteMs);
  });

  it('ignores a non-finite or non-positive knob rather than inverting the chain', () => {
    for (const bad of [0, -1, NaN, Infinity] as number[]) {
      const r = resolveFollowMeBudgets(bad);
      expect(r.scrapeMs).toBe(FOLLOWME_DEFAULT_SCRAPE_TIMEOUT_MS);
      expect(r.enrollStartRouteMs).toBeGreaterThan(r.scrapeMs);
    }
  });
});
