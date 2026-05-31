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
    const block = src.slice(idx, idx + 4200);
    // Gated on a non-dark stage + only with Telegram present.
    expect(block).toContain("_sessionPoolStage() === 'dark' || !telegram");
    // Bridges to the existing local spawn/resume path for the topic (now wrapped in an
    // async IIFE that first fetches the moved topic's history from the router — bug #2).
    // The spawn name is a clean topic-derived name, NOT the prefixed getSessionForTopic
    // value (bug #13 — re-prefixing it spawned a duplicate per follow-up).
    expect(block).toContain('spawnSessionForTopic(sessionManager, tg, spawnName, topicId, text');
    // Fire-and-forget + fail-safe (the receipt is already durably ACKed before this).
    expect(block).toContain('owner-side resume failed');
  });

  it('bug #13: a forwarded follow-up to an already-running moved session INJECTS, never re-spawns', () => {
    const idx = src.indexOf('onAccepted: (cmd) => {');
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 4200);
    // A live session for the topic short-circuits to injection BEFORE the spawn IIFE.
    const injectIdx = block.indexOf('sessionManager.isSessionAlive(existing)');
    const spawnIdx = block.indexOf('spawnSessionForTopic(sessionManager, tg, spawnName');
    expect(injectIdx).toBeGreaterThan(0);
    expect(spawnIdx).toBeGreaterThan(injectIdx); // inject decision precedes spawn
    // Injection uses the Telegram-aware path (adds the [telegram:N …] prefix the moved
    // session needs to reply) and tracks the injection for stall detection.
    expect(block).toContain('sessionManager.injectTelegramMessage(existing, topicId, text');
    expect(block).toContain('tg.trackMessageInjection(topicId, existing, text)');
    // The spawn name must NOT be the prefixed session name (the double-prefix defect).
    expect(block).toContain('const spawnName = `topic-${topicId}`');
    expect(block).not.toContain('const sessionName = tg.getSessionForTopic(topicId)');
  });
});
