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

// canonical-migration-validator: threadline-inbound-canonical-store@4
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
    'src/threadline/relayIngressHistory.ts', // inbound relay-socket gate-passed (server.ts delegates here)
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

  it('the relay-SOCKET inbound path (server.ts gate-passed handler) records through the funnel via the shared step, after classification and BEFORE the waiter and every routing branch', () => {
    // The cross-machine relay consumer is the site the original enumeration missed
    // (Luna 1.3.1725: 8 decrypted inbound rows in the HMAC inbox, 0 in the log).
    // Behavior of the shared step + factory is proven by the unit, integration and
    // E2E tiers (relay-ingress-canonical-history*); this pins that server.ts USES them.
    const server = read('src/commands/server.ts');
    const step = read('src/threadline/relayIngressHistory.ts');
    const factory = read('src/threadline/createThreadMessageRecorder.ts');
    expect(step).toContain('recordThreadMessage(');
    expect(step).toMatch(/recordThreadMessage.*from '\.\/recordThreadMessage\.js'/s);
    expect(step).toMatch(/direction: 'inbound'/);
    expect(server).toMatch(/import \{ classifyRelayIngress, recordGatePassedIngress \} from '\.\.\/threadline\/relayIngressHistory\.js'/);
    const start = server.indexOf('async function handleGatePassedRelayMessage(');
    expect(start).toBeGreaterThan(-1);
    const body = server.slice(start);
    const cls = body.indexOf('const relayIngress = classifyRelayIngress(msg);');
    const call = body.indexOf('recordGatePassedIngress(threadMessageRecorder, decision, relayIngress,');
    const waiter = body.indexOf('waiter.resolve(textContent)');
    const ackStage = body.indexOf('runRelayAckStage(relayAckDeps, relayAckInput)');
    const inbox = body.indexOf('listenerManager.appendCanonicalInboxEntry(');
    expect(cls).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(cls);
    expect(call).toBeLessThan(waiter);
    expect(call).toBeLessThan(ackStage);
    expect(call).toBeLessThan(inbox);
    // The ack stage reuses the SAME classification (no second inline parse that could drift).
    expect(body.slice(0, inbox)).toContain('kindedAck: relayIngress.kindedAck,');
    expect(body.slice(0, inbox)).not.toContain('parseKindedAck(');
    // The ONE recorder the server builds comes from the shared factory, which backs
    // over-cap bodies with the real MessageStore and attaches the contact hook.
    expect(server).toMatch(/const threadMessageRecorder = createThreadMessageRecorder\(\{[\s\S]*?messageStore,[\s\S]*?onContact:[\s\S]*?\}\);/);
    expect(server).not.toMatch(/new ThreadMessageRecorder\(/);
    expect(factory).toMatch(/bodyStore: opts\.messageStore/);
    expect(factory).toMatch(/attachPeerContactHook\(recorder, opts\.onContact\)/);
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
