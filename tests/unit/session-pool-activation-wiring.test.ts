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
    // Window 6500 (was 5200): the silent-loss-refusal-conservation `rejected`
    // outcome branch (a first-class refusal short-circuit added before the
    // isRemotelyHandled check) sits inside this block and pushed the
    // fail-safe fallback log line further down.
    const block = src.slice(idx, idx + 6500);
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
    // Window 5000 (was 4000, 3200, 2000): the coherence-journal emitPlacement
    // pairing (spec §3.3), the TOPIC-PROFILE-SPEC §5.3 acquire seam, and then
    // the WS1.1 ownerSupportsForward skew gate (MULTI-MACHINE-SEAMLESSNESS-SPEC)
    // added lines inside the construction, pushing the later assertions out
    // (deliverMessage: now sits ~4200 chars in).
    const block = src.slice(idx, idx + 5000);
    // The registry dep filters suspect machines from placement candidates
    // (owner-suspect breaker, P19) with an all-suspect unfiltered fallback —
    // still sourced from the REAL machinePoolRegistry capacities.
    expect(block).toContain('machinePoolRegistry?.getCapacities() ?? []');
    expect(block).toContain('ownerSuspectBreaker.isSuspect(c.machineId)');
    expect(block).toContain('resolveOwnership:');
    expect(block).toContain('casClaimOwnership:');
    expect(block).toContain('deliverMessage:'); // outbound via MeshRpcClient
    expect(src).toContain('new clientMod.MeshRpcClient({');
  });

  it('the owner-suspect breaker is wired into BOTH halves (mark + responsive) and the aliveness check', () => {
    const idx = src.indexOf('new routerMod.SessionRouter({');
    const block = src.slice(idx, idx + 3000);
    expect(block).toContain('markOwnerSuspect: (m) => ownerSuspectBreaker.markSuspect(m)');
    expect(block).toContain('onOwnerResponsive: (m) => ownerSuspectBreaker.recordSuccess(m)');
    expect(block).toContain('!ownerSuspectBreaker.isSuspect(m)');
  });

  it('the router is shared via a module-level ref (inbound handler is defined above startServer)', () => {
    expect(src).toContain("let _sessionRouter: import('../core/SessionRouter.js').SessionRouter | null = null");
    expect(src).toContain('_sessionRouter = new routerMod.SessionRouter(');
  });

  it('the owner-side bridge resumes the local session on a forwarded message, gated + fail-safe', () => {
    const idx = src.indexOf('onAccepted: (cmd) => {');
    expect(idx).toBeGreaterThan(0);
    // Window widened 4200→5000: the working-set move trigger (WORKING-SET-HANDOFF §3.3)
    // now prefixes the onAccepted body before the stage gate.
    const block = src.slice(idx, idx + 7500);
    // Gated on a non-dark stage (early return), then the Telegram arm requires
    // Telegram present. (WS1.1 split the combined gate so a Slack routing key
    // branches between the two: dark-gate stays shared, the !telegram gate now
    // applies only to the numeric/Telegram arm.)
    expect(block).toContain("_sessionPoolStage() === 'dark'");
    expect(block).toContain('if (!telegram) return;');
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
    // Window widened 4200→5000: the working-set move trigger (WORKING-SET-HANDOFF §3.3)
    // now prefixes the onAccepted body before the stage gate.
    const block = src.slice(idx, idx + 7500);
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
