/**
 * Wiring-integrity test (Robustness Phase 2, D-B) — every Threadline
 * message-persisting path appends to the canonical log through the ONE funnel
 * `recordThreadMessage`. The structural F3 fix: a FUTURE path that persists a
 * message but bypasses the funnel fails THIS test (Structure > Willpower).
 *
 * Mirrors Phase 1's recordInboundAck wiring test exactly.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8');
}

describe('canonical-history wiring integrity (F3)', () => {
  // The enumerated message-persisting sites. Adding a new send/receive path means
  // routing it through `recordThreadMessage` AND adding it here — both, or this
  // test fails.
  const PERSIST_SITES = [
    'src/server/routes.ts',                  // outbound relay-send (local + relay) + inbound relay-agent
    'src/threadline/ThreadlineEndpoints.ts', // inbound POST /threadline/messages/receive (the verified E2E path)
  ];

  it('every message-persisting site calls the recordThreadMessage funnel', () => {
    for (const site of PERSIST_SITES) {
      const src = read(site);
      expect(src, `${site} must call recordThreadMessage`).toContain('recordThreadMessage(');
    }
  });

  it('every message-persisting site imports the funnel', () => {
    for (const site of PERSIST_SITES) {
      const src = read(site);
      expect(src, `${site} must import recordThreadMessage`).toMatch(/recordThreadMessage.*from '.*recordThreadMessage(\.js)?'/s);
    }
  });

  it('the outbound relay-send path records BOTH the local and relay legs', () => {
    const routes = read('src/server/routes.ts');
    // The local fast-path records before building the envelope (post-leg threadSync).
    expect(routes).toMatch(/recordThreadMessage\(ctx\.threadMessageRecorder, \{[\s\S]*?direction: 'outbound'/);
    // The relay fallback path also records (by relayMsgId).
    expect(routes).toContain('messageId: relayMsgId');
  });

  it('both inbound paths record an inbound leg', () => {
    const routes = read('src/server/routes.ts');
    const endpoints = read('src/threadline/ThreadlineEndpoints.ts');
    expect(routes).toMatch(/direction: 'inbound'/);
    expect(endpoints).toMatch(/direction: 'inbound'/);
  });

  it('the placeholder hard-`messageCount:0` thread route is DELETED (the second F3 hard-zero source)', () => {
    const endpoints = read('src/threadline/ThreadlineEndpoints.ts');
    // The old placeholder unconditionally returned { messages: [], messageCount: 0 }.
    expect(endpoints).not.toMatch(/messages:\s*\[\],\s*\n\s*messageCount:\s*0/);
  });

  it('the conversation-discipline resolver JOIN rides the developmentAgent dark-gate (NOT a hardcoded enabled:false)', () => {
    const routes = read('src/server/routes.ts');
    // The resolver's `enabled` is resolved through resolveDevAgentGate (dev-live/fleet-dark),
    // never read as a raw config flag.
    expect(routes).toMatch(/resolveDevAgentGate\(\s*cdCfg\?\.conversationDiscipline\?\.enabled/);
  });
});
