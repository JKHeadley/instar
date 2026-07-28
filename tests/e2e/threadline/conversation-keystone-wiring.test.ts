/**
 * Wiring-integrity / feature-alive test — Threadline Phase 1 keystone.
 *
 * The warrants-a-reply gate + ConversationStore live inside the relay inbound
 * funnel (the relay client's onMessage handler in server.ts), which is process-
 * internal and not reachable over HTTP. The dead-code failure mode this guards
 * against (cf. the PR #334 "shipped as dead code with a false 'wired in' claim"
 * lesson) is a feature that compiles + unit-tests green but is never actually
 * constructed or invoked on the production boot path.
 *
 * This test proves, against the real server source, that:
 *  - ConversationStore + WarrantsReplyGate are CONSTRUCTED at boot;
 *  - the funnel CALLS evaluateAndRecordInbound;
 *  - the gate runs UPSTREAM of all three routing branches (pipe / listener /
 *    cold-spawn) so a no-reply verdict short-circuits ALL of them;
 *  - the helper itself is exported and importable (it is — see the static import).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { evaluateAndRecordInbound, WarrantsReplyGate } from '../../../src/threadline/WarrantsReplyGate.js';
import { ConversationStore } from '../../../src/threadline/ConversationStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.resolve(__dirname, '../../../src/commands/server.ts'), 'utf-8');
const routesSrc = fs.readFileSync(path.resolve(__dirname, '../../../src/server/routes.ts'), 'utf-8');

describe('Threadline keystone — wiring integrity (feature alive)', () => {
  it('imports the keystone modules into the server', () => {
    expect(serverSrc).toMatch(/import\s*\{[^}]*ConversationStore[^}]*\}\s*from\s*['"]\.\.\/threadline\/ConversationStore\.js['"]/);
    expect(serverSrc).toMatch(/import\s*\{[^}]*WarrantsReplyGate[^}]*evaluateAndRecordInbound[^}]*\}\s*from\s*['"]\.\.\/threadline\/WarrantsReplyGate\.js['"]/);
  });

  it('constructs ConversationStore and WarrantsReplyGate at boot', () => {
    expect(serverSrc).toMatch(/new ConversationStore\(/);
    expect(serverSrc).toMatch(/new WarrantsReplyGate\(/);
  });

  it('invokes the gate via evaluateAndRecordInbound in the relay funnel', () => {
    expect(serverSrc).toMatch(/evaluateAndRecordInbound\(\s*warrantsReplyGate\s*,\s*conversationStore/);
  });

  it('runs the gate UPSTREAM of all three routing branches', () => {
    const gateIdx = serverSrc.indexOf('evaluateAndRecordInbound(warrantsReplyGate');
    const pipeIdx = serverSrc.indexOf('Phase 2a: Pipe-mode session');
    const listenerIdx = serverSrc.indexOf('Phase 2b: Route to warm listener');
    const coldIdx = serverSrc.indexOf('Route through ThreadlineRouter (cold-spawn path)');
    expect(gateIdx).toBeGreaterThan(0);
    expect(pipeIdx).toBeGreaterThan(gateIdx);
    expect(listenerIdx).toBeGreaterThan(gateIdx);
    expect(coldIdx).toBeGreaterThan(gateIdx);
  });

  it('short-circuits with a return on a suppress verdict', () => {
    // The funnel must `return` (short-circuit) inside the suppress branch.
    const block = serverSrc.slice(
      serverSrc.indexOf('evaluateAndRecordInbound(warrantsReplyGate'),
      serverSrc.indexOf('Phase 2a: Pipe-mode session'),
    );
    expect(block).toMatch(/if\s*\(\s*decision\.suppress\s*\)/);
    expect(block).toMatch(/return;\s*\/\/ short-circuit/);
  });

  it('ALSO gates the local co-located path (/messages/relay-agent), upstream of handleInboundMessage', () => {
    // The local-delivery path bypasses the relay funnel — without gating here a
    // same-machine agent (the original echo↔codey loop) would never be gated.
    // This was caught in test-as-self; the assertion guards against regression.
    const relayAgentIdx = routesSrc.indexOf("router.post('/messages/relay-agent'");
    expect(relayAgentIdx).toBeGreaterThan(0);
    // Window sized to span the route body up to the handleInboundMessage spawn.
    // Widened from 12000 → 16000 after Robustness Phase 2 added the canonical-log
    // append funnel + threadSync honoring to this inbound path (the spawn moved to
    // ~13.2k); the gate-before-spawn ORDER this test guards is unchanged.
    const route = routesSrc.slice(relayAgentIdx, relayAgentIdx + 16000);
    const gateIdx = route.indexOf('evaluateAndRecordInbound(ctx.warrantsReplyGate, ctx.conversationStore');
    // Match the call by method+first-arg so the assertion survives formatting of
    // the `ctx.threadlineRouter` receiver AND extra args (the local-attribution fix
    // passes `handleInboundMessage(envelope, undefined, { inboundSenderFingerprint })`).
    // The gate still runs BEFORE this spawn call — which is what this guards.
    const routerIdx = route.indexOf('handleInboundMessage(envelope');
    expect(gateIdx).toBeGreaterThan(0);
    expect(routerIdx).toBeGreaterThan(gateIdx); // gate runs BEFORE the spawn
    expect(route.slice(gateIdx, routerIdx)).toMatch(/if\s*\(\s*decision\.suppress\s*\)/);
  });

  it('the funnel helper is exported, importable, and operates end-to-end', async () => {
    // Not just present in source — actually runnable against the real store.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-alive-'));
    try {
      const store = new ConversationStore(tmp);
      const gate = new WarrantsReplyGate();
      const first = await evaluateAndRecordInbound(gate, store, {
        threadId: 'alive', text: 'hello, can you check the build?', senderFingerprint: 'fp', senderName: 'codey', trustLevel: 'verified', humanInLoop: false,
      });
      expect(first.suppress).toBe(false);
      expect(store.get('alive')?.messageCount).toBe(1);
    } finally {
      SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/threadline/conversation-keystone-wiring.test.ts:cleanup' });
    }
  });
});
