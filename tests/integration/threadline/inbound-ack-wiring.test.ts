/**
 * Wiring-integrity test — every Threadline inbound-receive path records the
 * implicit delivery ack through the shared `recordInboundAck` funnel
 * (Robustness Phase 1, G3 / closes F4).
 *
 * F4 was a pure WIRING GAP: the verified E2E relay inbound path
 * (POST /threadline/messages/receive) did not record acks while the other two
 * inbound paths did, producing the permanent false `stale: true` noise. This
 * test ENUMERATES the inbound-receive sites and asserts each goes through the
 * one funnel — so a FUTURE inbound path that bypasses it fails the test
 * (Structure > Willpower). It also asserts the funnel is actually IMPORTED at
 * each site and that the receive route is wired with the ack deps.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8');
}

describe('inbound-ack wiring integrity (F4)', () => {
  // The enumerated inbound-receive sites. Adding a new inbound path means adding
  // it here AND routing it through the funnel — both, or this test fails.
  const INBOUND_SITES = [
    'src/threadline/ThreadlineEndpoints.ts', // POST /threadline/messages/receive (the F4 path)
    'src/server/routes.ts',                  // POST /messages/relay-agent (local same-machine)
    'src/commands/server.ts',                // relay ingest (cross-machine)
  ];

  it('every inbound-receive site calls recordInboundAck', () => {
    for (const site of INBOUND_SITES) {
      const src = read(site);
      expect(src, `${site} must call the recordInboundAck funnel`).toContain('recordInboundAck(');
    }
  });

  it('every inbound-receive site imports the funnel', () => {
    for (const site of INBOUND_SITES) {
      const src = read(site);
      expect(src, `${site} must import recordInboundAck`).toMatch(/from '.*recordInboundAck(\.js)?'/);
    }
  });

  it('no inbound site still uses the inlined recordAckByThread pattern that bypassed the funnel', () => {
    // The old inline pattern was `tracker.recordInboundFrom(...)` + `recordAckByThread`
    // copy-pasted per route. After the funnel refactor only the funnel itself
    // (recordInboundAck.ts) and the tracker definition may name recordAckByThread.
    for (const site of INBOUND_SITES) {
      const src = read(site);
      expect(src, `${site} should not inline recordAckByThread — use the funnel`).not.toContain('.recordAckByThread(');
    }
  });

  it('the receive route is wired with the ack deps (tracker + thread-owner lookup)', () => {
    const endpoints = read('src/threadline/ThreadlineEndpoints.ts');
    // The receive route reads the verified sender and funnels the ack.
    expect(endpoints).toContain("req.headers['x-threadline-agent']");
    // The createThreadlineRoutes signature accepts the inbound ack deps.
    expect(endpoints).toMatch(/inboundAckDeps\??:/);

    const routes = read('src/server/routes.ts');
    // The route construction passes the real tracker + threadResumeMap.
    expect(routes).toMatch(/createThreadlineRoutes\([\s\S]*a2aDeliveryTracker:[\s\S]*threadResumeMap:/);
  });
});
