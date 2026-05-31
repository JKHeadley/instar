/**
 * Wiring-integrity test for the Multi-Machine Session Pool ACTIVATION (§L4).
 * The live-ingress interception is the single highest-blast-radius change in the
 * feature (it sits in the inbound message-dispatch path), so its safety invariants
 * are pinned structurally: it is GATED on a non-dark rollout stage (default dark →
 * inert → byte-identical to single-machine dispatch), it FAILS SAFE (try/catch →
 * local dispatch), and the SessionRouter is constructed with the real registry +
 * ownership + placement + outbound mesh client. A regression that removes the gate
 * would activate cross-machine routing unconditionally — this test guards that.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SERVER = path.join(process.cwd(), 'src/commands/server.ts');

describe('Session Pool activation wiring (§L4)', () => {
  const src = fs.readFileSync(SERVER, 'utf-8');

  it('the inbound interception is GATED on a non-dark rollout stage (default-dark → inert)', () => {
    expect(src).toContain("_sessionRouter && _sessionPoolStage() !== 'dark'");
    // The stage getter defaults to dark until startServer wires it to liveConfig.
    expect(src).toContain("let _sessionPoolStage: () => string = () => 'dark'");
  });

  it('the interception FAILS SAFE — any route error falls back to local dispatch', () => {
    const idx = src.indexOf("_sessionRouter && _sessionPoolStage() !== 'dark'");
    const block = src.slice(idx, idx + 2200);
    expect(block).toContain('try {');
    expect(block).toContain('await _sessionRouter.route(');
    expect(block).toContain('falling back to local dispatch');
    // Only a remote-handled outcome short-circuits; everything else falls through.
    // (bug #8: remote 'spawned'/'owner-dead-replaced' must short-circuit too — the
    // decision is the pure isRemotelyHandled() helper, unit-tested in SessionRouter.test.ts.)
    expect(block).toContain('isRemotelyHandled(outcome, _meshSelfId)');
  });

  it('the SessionRouter is constructed with the real registry/ownership/placement + outbound mesh client', () => {
    const idx = src.indexOf('new routerMod.SessionRouter({');
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 2000);
    expect(block).toContain('machineRegistry: () => machinePoolRegistry?.getCapacities()');
    expect(block).toContain('resolveOwnership:');
    expect(block).toContain('casClaimOwnership:');
    expect(block).toContain('deliverMessage:'); // outbound via MeshRpcClient
    expect(src).toContain('new clientMod.MeshRpcClient({');
  });

  it('the router is shared via a module-level ref (inbound handler is defined above startServer)', () => {
    expect(src).toContain("let _sessionRouter: import('../core/SessionRouter.js').SessionRouter | null = null");
    expect(src).toContain('_sessionRouter = new routerMod.SessionRouter(');
  });

  it('the owner-side bridge resumes the local session on a forwarded message, gated + fail-safe', () => {
    const idx = src.indexOf('onAccepted: (cmd) => {');
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 1500);
    // Gated on a non-dark stage + only with Telegram present.
    expect(block).toContain("_sessionPoolStage() === 'dark' || !telegram");
    // Bridges to the existing local spawn/resume path for the topic.
    expect(block).toContain('spawnSessionForTopic(sessionManager, tg, sessionName, topicId, text');
    // Fire-and-forget + fail-safe (the receipt is already durably ACKed before this).
    expect(block).toContain('owner-side resume failed');
  });
});
