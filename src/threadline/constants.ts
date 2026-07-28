/**
 * Threadline shared constants.
 *
 * Single source of truth for the deployed relay endpoint. This literal was
 * previously duplicated across ~10 call sites, which is exactly how the
 * default drifted to the dead `relay.threadline.dev` host in some modules
 * while others used the live `threadline-relay.fly.dev` host — agents that
 * leaned on the stale default silently failed to reach the relay. Import
 * from here; never re-hardcode the URL.
 */

/** Hostname of the deployed Threadline relay (no scheme/path). */
export const DEFAULT_RELAY_HOST = 'threadline-relay.fly.dev';

/** WebSocket URL of the deployed Threadline relay. */
export const DEFAULT_RELAY_URL = `wss://${DEFAULT_RELAY_HOST}/v1/connect`;
