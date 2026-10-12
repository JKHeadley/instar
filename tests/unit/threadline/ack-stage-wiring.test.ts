/**
 * Wiring-integrity — the ack stage sits FIRST on every inbound path
 * (docs/specs/a2a-ack-never-acked.md).
 *
 * The relay handler (`handleGatePassedRelayMessage`) is a closure inside the
 * server boot and cannot be imported, so its order is pinned on the source: the
 * ack stage must run, and return on an ack, BEFORE the inbox append, the
 * Telegram mirror, the warrants gate and every router. A future edit that moves
 * a side effect above the stage, or reintroduces a `chat` ack, fails here.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');

describe('relay handler (src/commands/server.ts)', () => {
  const src = read('src/commands/server.ts');
  const start = src.indexOf('async function handleGatePassedRelayMessage(');
  const end = src.indexOf('// Relay client is passed to AgentServer', start);
  const handler = src.slice(start, end);

  it('the handler is found and bounded', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('recognises acks structurally through the shared helper; the prefix test only spares the reply waiter', () => {
    expect(handler).toContain('isAutoAckInbound({ type: msgType, text: textContent })');
    expect(handler).not.toMatch(/textContent\.startsWith\('Message received/);
    expect(handler).toContain('if (waiter && !isAutoAck && !looksLikeAutoAckText(textContent))');
    // The loose test is used exactly once in the handler, and never to stop a message.
    expect(handler.split('looksLikeAutoAckText(').length - 1).toBe(1);
  });

  it('runs the ack stage before every side effect and every router', () => {
    const stage = handler.indexOf('runRelayAckStage(');
    expect(stage).toBeGreaterThan(-1);
    for (const later of [
      'appendCanonicalInboxEntry(',
      '.mirrorInbound(',
      'evaluateAndRecordInbound(warrantsReplyGate',
      'pipeSpawner.spawn(',
      'listenerManager.writeToInbox(',
      'threadlineRouter.handleInboundMessage(',
    ]) {
      const idx = handler.indexOf(later);
      expect(idx, `${later} must exist`).toBeGreaterThan(-1);
      expect(idx, `${later} must come after the ack stage`).toBeGreaterThan(stage);
    }
  });

  it('returns as soon as the stage consumed an ack', () => {
    const stage = handler.indexOf('runRelayAckStage(');
    const inbox = handler.indexOf('appendCanonicalInboxEntry(');
    expect(handler.slice(stage, inbox)).toMatch(/if \(ackStage === 'ack-consumed'\) \{[\s\S]*?return;\s*\}/);
  });

  it('gives the stage the ledger ticket and the real delivery recorder', () => {
    // The stage's deps/input are built just above the call (ACT-091 reuses
    // them for the deferred ack), so the window starts at their declaration.
    const stage = handler.indexOf('const relayAckDeps = {');
    expect(stage).toBeGreaterThan(-1);
    const call = handler.slice(stage, handler.indexOf("if (ackStage === 'ack-consumed')"));
    expect(call).toContain('runRelayAckStage(relayAckDeps, relayAckInput)');
    expect(call).toContain('ticket: ledgerTicket');
    expect(call).toContain('recordDelivery: recordRelayDelivery');
    expect(handler).toMatch(/const recordRelayDelivery = \(\) => recordInboundAck\(/);
  });

  it('ACT-091: EVERY inbound defers its ack (not only a topic-bound reply) and the settler is built before the stage', () => {
    const stage = handler.indexOf('runRelayAckStage(relayAckDeps, relayAckInput)');
    const decl = handler.slice(handler.indexOf('const relayAckInput = {'), stage);
    expect(decl).toContain('deferSend: true');
    expect(decl).not.toContain('deferSend: isTopicBoundReply');
    expect(decl).toContain('const relayAck = createRelayAckSettler(relayAckDeps, relayAckInput);');
    // The pre-routing send is gone from the handler: only the settler acks.
    expect(handler).not.toContain('settleDeferredRelayAck(');
  });

  it('ACT-091: the router exit settles with the router\'s own delivered report, after the last router call', () => {
    const router = handler.lastIndexOf('threadlineRouter.handleInboundMessage(');
    const settle = handler.indexOf("relayAck.settle(result.delivered === true ? 'router-delivered' : 'router-undelivered')");
    expect(settle).toBeGreaterThan(router);
    // Unconditional: no `if (deferSend)` / topic-bound guard between the router and the settle.
    expect(handler.slice(router, settle)).not.toMatch(/if \(relayAckInput\.deferSend\)|if \(isTopicBoundReply\)/);
    // A queued capacity refusal is logged as queued, through the tested helper.
    expect(handler.slice(settle)).toContain('— ${describeUndeliveredRouterResult(result)}`');
  });

  it('ACT-091: the warrants-gate suppress exit (no-reply verdict or loop budget) settles as no-reply BEFORE it returns', () => {
    const suppress = handler.indexOf('if (decision.suppress) {');
    expect(suppress).toBeGreaterThan(-1);
    const branch = handler.slice(suppress, handler.indexOf('return; // short-circuit ALL three routing branches', suppress));
    expect(branch).toContain("relayAck.settle('no-reply');");
    expect(branch).toContain('decision.verdict.budgetExhausted'); // the loop-gate exit shares this branch
  });

  it('ACT-091: the pipe exit settles as delivered only inside `if (result.spawned)`', () => {
    const spawned = handler.indexOf('if (result.spawned) {', handler.indexOf('pipeSpawner.spawn('));
    const settle = handler.indexOf("relayAck.settle('pipe-spawned');");
    expect(spawned).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(spawned);
    expect(handler.slice(spawned, settle)).not.toMatch(/^\s*\}/m); // same block as the spawned check
  });

  it('ACT-091: the listener path is taken only on ListenerSessionManager\'s own decision, and its ack follows the reader\'s liveness', () => {
    // The "is a live reader proven?" decision lives in the manager, not inline here.
    expect(handler).toContain('if (listenerManager && listenerManager.shouldUseListener(trustLevel, textContent.length) && !isTopicBoundReply) {');
    expect(handler.split('listenerManager.writeToInbox(').length - 1).toBe(1);
    const cond = handler.indexOf('listenerManager.shouldUseListener(');
    const write = handler.indexOf('listenerManager.writeToInbox(');
    const settle = handler.indexOf("relayAck.settle(listenerManager.hasLiveReader() ? 'listener-delivered' : 'listener-queued')");
    expect(write).toBeGreaterThan(cond);
    expect(settle).toBeGreaterThan(write);
    expect(handler.slice(write, settle)).not.toMatch(/return;/);
    // The router call comes after the listener branch: it is the fall-through.
    expect(handler.indexOf('threadlineRouter.handleInboundMessage(')).toBeGreaterThan(settle);
  });

  it('the manager refuses the listener path without a proven reader (source of the decision)', () => {
    const mgr = read('src/threadline/ListenerSessionManager.ts');
    const fn = mgr.slice(mgr.indexOf('shouldUseListener(trustLevel: string'), mgr.indexOf('// ── Reader liveness'));
    expect(fn).toContain('if (!this.hasLiveReader(now)) return false;');
    // Construction no longer claims a listener is ready, and only a heartbeat flips it.
    expect(mgr).toContain("this.state = 'starting';");
    expect(mgr.split("this.state = 'listening'").length - 1).toBe(1);
    expect(mgr).toMatch(/markReaderAlive\(now: number = Date\.now\(\)\): void \{\s*this\.lastReaderHeartbeatAt = now;\s*if \(this\.state === 'starting'\) this\.state = 'listening';/);
  });

  it('nothing in the server marks a listener reader alive (no listener session exists to do it)', () => {
    expect(src).not.toContain('.markReaderAlive(');
    expect(read('src/server/routes.ts')).not.toContain('.markReaderAlive(');
  });

  it('ACT-091: no exit after the ack stage leaves without settling (the audit, pinned)', () => {
    const stage = handler.indexOf('runRelayAckStage(relayAckDeps, relayAckInput)');
    const afterStage = handler.slice(stage);
    // Cut the rest of the handler at every bare `return;`: each piece is the
    // code that runs between one exit and the next.
    const pieces = afterStage.split(/\breturn;/);
    // ack-consumed, gate suppress, pipe spawned, listener — then the router exit, the function's end.
    expect(pieces).toHaveLength(5);
    const count = (piece: string) => piece.split('relayAck.settle(').length - 1;
    // The inbound-ack exit is the one deliberate non-settle: an ack is never acked.
    expect(pieces[0]).toContain("if (ackStage === 'ack-consumed')");
    expect(count(pieces[0])).toBe(0);
    // Every other exit, the final one included, settles exactly once on the way out.
    for (const piece of pieces.slice(1)) expect(count(piece)).toBe(1);
    // Four call sites in all: one per routed exit.
    expect(count(afterStage)).toBe(4);
  });

  it('sends its own ack only as a typed ack — never as a chat message', () => {
    expect(handler).toContain('threadlineRelayClient!.sendAck(');
    expect(handler).not.toContain('threadlineRelayClient!.sendPlaintext(');
  });

  it('keeps the per-sender ack rate limiter (flood protection)', () => {
    expect(src).toMatch(/const isAckRateLimited = createAckRateLimiter\(config\.threadline\?\.ackRateLimit \?\? 5, 60 \* 1000\)/);
  });
});

describe('/messages/relay-agent (src/server/routes.ts)', () => {
  const src = read('src/server/routes.ts');
  const start = src.indexOf("router.post('/messages/relay-agent'");
  const route = src.slice(start, start + 30_000);

  it('stops on an inbound ack before the message store, the gate and the router — after auth, loop check and ledger commit', () => {
    const ledgerCommit = route.indexOf('relayLedger.admit(');
    const ack = route.indexOf('isAutoAckBody(envelope.message?.body)');
    const store = route.indexOf("ctx.messageRouter.relay(envelope, 'agent')");
    const gate = route.indexOf('evaluateAndRecordInbound(ctx.warrantsReplyGate');
    const router = route.indexOf('.handleInboundMessage(envelope');
    expect(route.indexOf('verifyAgentToken(')).toBeGreaterThan(-1);
    expect(route.indexOf('verifyAgentToken(')).toBeLessThan(ack);
    expect(route.indexOf('isRelayChainLoop(')).toBeLessThan(ack);
    expect(ledgerCommit).toBeGreaterThan(-1);
    expect(ack).toBeGreaterThan(ledgerCommit);
    expect(store).toBeGreaterThan(ack);
    expect(gate).toBeGreaterThan(ack);
    expect(router).toBeGreaterThan(ack);
    const block = route.slice(ack, store);
    expect(block).toContain('recordInboundAck(');
    expect(block).toContain('ledgerTicket?.recordNoReply()');
    expect(block).toMatch(/return;/);
  });
});

describe('POST /threadline/messages/receive (src/threadline/ThreadlineEndpoints.ts)', () => {
  const src = read('src/threadline/ThreadlineEndpoints.ts');
  const start = src.indexOf("router.post('/threadline/messages/receive'");
  const route = src.slice(start, src.indexOf("router.post('/threadline/threads/backfill'"));

  it('stops on an inbound ack after recording delivery, before the router', () => {
    const delivery = route.indexOf('recordInboundAck(');
    const ack = route.indexOf('isAutoAckBody(body.message?.body)');
    const router = route.indexOf('threadlineRouter.handleInboundMessage(');
    expect(delivery).toBeGreaterThan(-1);
    expect(ack).toBeGreaterThan(delivery);
    expect(router).toBeGreaterThan(ack);
    expect(route.slice(ack, router)).toContain('ticket?.recordNoReply()');
    expect(route.slice(ack, router)).toMatch(/return;/);
  });
});

describe('the unknown-sender decode and the client share one wire format', () => {
  it('ThreadlineBootstrap decodes with decodePlaintextPayload; the client encodes with encodePlaintextPayload', () => {
    expect(read('src/threadline/ThreadlineBootstrap.ts')).toContain('decodePlaintextPayload(envelope.payload)');
    expect(read('src/threadline/client/ThreadlineClient.ts')).toContain('encodePlaintextPayload(content, type, resend)');
  });
});
