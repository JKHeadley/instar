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
    const stage = handler.indexOf('runRelayAckStage(');
    const call = handler.slice(stage, handler.indexOf("if (ackStage === 'ack-consumed')"));
    expect(call).toContain('ticket: ledgerTicket');
    expect(call).toContain('recordDelivery: recordRelayDelivery');
    expect(handler).toMatch(/const recordRelayDelivery = \(\) => recordInboundAck\(/);
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
