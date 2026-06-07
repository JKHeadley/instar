/**
 * Unit tests for InboundMessageGate — the 7-layer security pre-filter
 * for relay inbound messages.
 *
 * Covers: payload size limits, probe vs message classification,
 * trust-level-aware rate limiting, operation permission checks,
 * interaction recording, and metrics.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InboundMessageGate } from '../../src/threadline/InboundMessageGate.js';
import type { AgentTrustLevel, AgentTrustProfile, AgentTrustHistory } from '../../src/threadline/AgentTrustManager.js';
import type { ReceivedMessage } from '../../src/threadline/client/ThreadlineClient.js';

// ── Mock Factories ────────────────────────────────────────────────

function createMockTrustManager(overrides: Partial<{
  trustLevel: AgentTrustLevel;
  allowedOps: string[];
}> = {}) {
  const trustLevel = overrides.trustLevel ?? 'verified';
  const allowedOps = overrides.allowedOps ?? ['message'];
  return {
    getTrustLevelByFingerprint: vi.fn().mockReturnValue(trustLevel),
    getAllowedOperationsByFingerprint: vi.fn().mockReturnValue(allowedOps),
    recordMessageReceivedByFingerprint: vi.fn(),
  };
}

function createMockRouter() {
  return {} as any;
}

function createMessage(overrides: Partial<ReceivedMessage> = {}): ReceivedMessage {
  return {
    from: overrides.from ?? 'abc123fingerprint',
    content: overrides.content ?? 'Hello from another agent',
    threadId: overrides.threadId ?? 'thread-1',
    timestamp: overrides.timestamp ?? Date.now(),
    ...overrides,
  } as ReceivedMessage;
}

// ── Tests ─────────────────────────────────────────────────────────

describe('InboundMessageGate', () => {
  let gate: InboundMessageGate;
  let trustManager: ReturnType<typeof createMockTrustManager>;
  let router: ReturnType<typeof createMockRouter>;

  beforeEach(() => {
    trustManager = createMockTrustManager();
    router = createMockRouter();
    gate = new InboundMessageGate(trustManager as any, router, {});
  });

  // ── Layer 0: Payload Size ──────────────────────────────────────

  describe('payload size check', () => {
    it('passes messages under size limit', async () => {
      const msg = createMessage({ content: 'short message' });
      const decision = await gate.evaluate(msg);
      expect(decision.action).toBe('pass');
    });

    it('blocks messages over default 64KB limit', async () => {
      const bigContent = 'x'.repeat(70 * 1024); // 70KB
      const msg = createMessage({ content: bigContent });
      const decision = await gate.evaluate(msg);
      expect(decision.action).toBe('block');
      expect(decision.reason).toBe('payload_too_large');
    });

    it('respects custom payload size limit', async () => {
      const customGate = new InboundMessageGate(trustManager as any, router, {
        maxPayloadBytes: 100,
      });
      const msg = createMessage({ content: 'x'.repeat(200) });
      const decision = await customGate.evaluate(msg);
      expect(decision.action).toBe('block');
      expect(decision.reason).toBe('payload_too_large');
      customGate.shutdown();
    });

    it('tracks blocked-by-size in metrics', async () => {
      const bigContent = 'x'.repeat(70 * 1024);
      const msg = createMessage({ content: bigContent });
      await gate.evaluate(msg);
      const metrics = gate.getMetrics();
      expect(metrics.blockedBySize).toBe(1);
      expect(metrics.blocked).toBe(1);
    });
  });

  // ── Layer 1: Probe Classification ──────────────────────────────

  describe('probe classification', () => {
    it('classifies ping as a probe', async () => {
      const msg = createMessage({ content: { type: 'ping' } as any });
      const decision = await gate.evaluate(msg);
      expect(decision.action).toBe('pass');
      expect(decision.reason).toBe('probe');
    });

    it('classifies health as a probe', async () => {
      const msg = createMessage({ content: { type: 'health' } as any });
      const decision = await gate.evaluate(msg);
      expect(decision.action).toBe('pass');
      expect(decision.reason).toBe('probe');
    });

    it('tracks probes in metrics', async () => {
      const msg = createMessage({ content: { type: 'ping' } as any });
      await gate.evaluate(msg);
      const metrics = gate.getMetrics();
      expect(metrics.probesHandled).toBe(1);
    });

    it('rate-limits excessive probes', async () => {
      // Default untrusted: 5 probes/hour
      trustManager = createMockTrustManager({ trustLevel: 'untrusted' });
      gate = new InboundMessageGate(trustManager as any, router, {});

      const msg = createMessage({ content: { type: 'ping' } as any });

      for (let i = 0; i < 5; i++) {
        const decision = await gate.evaluate(msg);
        expect(decision.action).toBe('pass');
      }

      // 6th probe should be rate-limited
      const decision = await gate.evaluate(msg);
      expect(decision.action).toBe('block');
      expect(decision.reason).toBe('probe_rate_limited');
    });
  });

  // ── Layer 2: Trust Check ───────────────────────────────────────

  describe('trust-based access control', () => {
    it('blocks messages from untrusted senders (0 messages/hr)', async () => {
      trustManager = createMockTrustManager({
        trustLevel: 'untrusted',
        allowedOps: [], // untrusted gets no operations
      });
      gate = new InboundMessageGate(trustManager as any, router, {});

      const msg = createMessage();
      const decision = await gate.evaluate(msg);
      expect(decision.action).toBe('block');
      expect(decision.reason).toBe('insufficient_trust');
    });

    it('passes messages from verified senders with message permission', async () => {
      trustManager = createMockTrustManager({
        trustLevel: 'verified',
        allowedOps: ['message'],
      });
      gate = new InboundMessageGate(trustManager as any, router, {});

      const msg = createMessage();
      const decision = await gate.evaluate(msg);
      expect(decision.action).toBe('pass');
    });

    it('blocks messages when operation not in allowed list', async () => {
      trustManager = createMockTrustManager({
        trustLevel: 'verified',
        allowedOps: ['probe'], // message not allowed
      });
      gate = new InboundMessageGate(trustManager as any, router, {});

      const msg = createMessage();
      const decision = await gate.evaluate(msg);
      expect(decision.action).toBe('block');
      expect(decision.reason).toBe('insufficient_trust');
    });

    it('tracks blocked-by-trust in metrics', async () => {
      trustManager = createMockTrustManager({
        trustLevel: 'verified',
        allowedOps: [],
      });
      gate = new InboundMessageGate(trustManager as any, router, {});

      await gate.evaluate(createMessage());
      const metrics = gate.getMetrics();
      expect(metrics.blockedByTrust).toBe(1);
    });
  });

  // ── Layer 3: Rate Limiting ─────────────────────────────────────

  describe('rate limiting', () => {
    it('rate-limits hourly messages for verified senders', async () => {
      trustManager = createMockTrustManager({
        trustLevel: 'verified',
        allowedOps: ['message'],
      });
      gate = new InboundMessageGate(trustManager as any, router, {});

      // verified: 10 messages/hour
      for (let i = 0; i < 10; i++) {
        const decision = await gate.evaluate(createMessage());
        expect(decision.action).toBe('pass');
      }

      // 11th should be rate-limited
      const decision = await gate.evaluate(createMessage());
      expect(decision.action).toBe('block');
      expect(decision.reason).toBe('rate_limited_hourly');
    });

    it('tracks different senders independently', async () => {
      trustManager = createMockTrustManager({
        trustLevel: 'verified',
        allowedOps: ['message'],
      });
      gate = new InboundMessageGate(trustManager as any, router, {});

      // 10 from sender A
      for (let i = 0; i < 10; i++) {
        await gate.evaluate(createMessage({ from: 'senderA' }));
      }
      // Sender A is now rate-limited
      const decisionA = await gate.evaluate(createMessage({ from: 'senderA' }));
      expect(decisionA.action).toBe('block');

      // Sender B should still be fine
      const decisionB = await gate.evaluate(createMessage({ from: 'senderB' }));
      expect(decisionB.action).toBe('pass');
    });

    it('respects custom rate limits', async () => {
      trustManager = createMockTrustManager({
        trustLevel: 'verified',
        allowedOps: ['message'],
      });
      gate = new InboundMessageGate(trustManager as any, router, {
        rateLimits: {
          verified: { probesPerHour: 10, messagesPerHour: 2, messagesPerDay: 5 },
        },
      });

      // Custom: 2 messages/hour
      await gate.evaluate(createMessage());
      await gate.evaluate(createMessage());
      const decision = await gate.evaluate(createMessage());
      expect(decision.action).toBe('block');
      expect(decision.reason).toBe('rate_limited_hourly');
    });

    it('tracks blocked-by-rate in metrics', async () => {
      trustManager = createMockTrustManager({
        trustLevel: 'verified',
        allowedOps: ['message'],
      });
      gate = new InboundMessageGate(trustManager as any, router, {
        rateLimits: {
          verified: { probesPerHour: 10, messagesPerHour: 1, messagesPerDay: 5 },
        },
      });

      await gate.evaluate(createMessage());
      await gate.evaluate(createMessage()); // rate-limited
      const metrics = gate.getMetrics();
      expect(metrics.blockedByRate).toBe(1);
    });
  });

  // ── Layer 4: Interaction Recording ─────────────────────────────

  describe('interaction recording', () => {
    it('records message received for passed messages', async () => {
      const msg = createMessage();
      await gate.evaluate(msg);
      expect(trustManager.recordMessageReceivedByFingerprint).toHaveBeenCalledWith('abc123fingerprint');
    });

    it('does not record for blocked messages', async () => {
      trustManager = createMockTrustManager({
        trustLevel: 'untrusted',
        allowedOps: [],
      });
      gate = new InboundMessageGate(trustManager as any, router, {});

      await gate.evaluate(createMessage());
      expect(trustManager.recordMessageReceivedByFingerprint).not.toHaveBeenCalled();
    });

    it('does not record for probes', async () => {
      const msg = createMessage({ content: { type: 'ping' } as any });
      await gate.evaluate(msg);
      expect(trustManager.recordMessageReceivedByFingerprint).not.toHaveBeenCalled();
    });
  });

  // ── Metrics ────────────────────────────────────────────────────

  describe('metrics', () => {
    it('starts with zeroed metrics', () => {
      const metrics = gate.getMetrics();
      expect(metrics.passed).toBe(0);
      expect(metrics.blocked).toBe(0);
      expect(metrics.blockedByTrust).toBe(0);
      expect(metrics.blockedByRate).toBe(0);
      expect(metrics.blockedBySize).toBe(0);
      expect(metrics.probesHandled).toBe(0);
    });

    it('accumulates passed count', async () => {
      await gate.evaluate(createMessage());
      await gate.evaluate(createMessage());
      const metrics = gate.getMetrics();
      expect(metrics.passed).toBe(2);
    });

    it('returns a copy (not a reference)', () => {
      const metrics = gate.getMetrics();
      metrics.passed = 999;
      expect(gate.getMetrics().passed).toBe(0);
    });
  });

  // ── Shutdown ───────────────────────────────────────────────────

  describe('shutdown', () => {
    it('cleans up interval timer', () => {
      // Should not throw
      gate.shutdown();
      // Double shutdown should also not throw
      gate.shutdown();
    });
  });

  // ── Operation Type Classification ──────────────────────────────

  describe('operation classification', () => {
    it('classifies typed content by type field', async () => {
      trustManager = createMockTrustManager({
        trustLevel: 'trusted',
        allowedOps: ['code-review'],
      });
      gate = new InboundMessageGate(trustManager as any, router, {});

      const msg = createMessage({ content: { type: 'code-review', data: {} } as any });
      const decision = await gate.evaluate(msg);
      expect(decision.action).toBe('pass');
    });

    it('defaults string content to "message" type', async () => {
      trustManager = createMockTrustManager({
        trustLevel: 'trusted',
        allowedOps: ['message'],
      });
      gate = new InboundMessageGate(trustManager as any, router, {});

      const msg = createMessage({ content: 'plain text message' });
      const decision = await gate.evaluate(msg);
      expect(decision.action).toBe('pass');
    });
  });

  // ── Trust Level Escalation ─────────────────────────────────────

  describe('trust level behavior', () => {
    it('autonomous trust gets high rate limits', async () => {
      trustManager = createMockTrustManager({
        trustLevel: 'autonomous',
        allowedOps: ['message'],
      });
      gate = new InboundMessageGate(trustManager as any, router, {});

      // autonomous: 500 messages/hour — send 100 and verify all pass
      const results = await Promise.all(
        Array.from({ length: 100 }, () => gate.evaluate(createMessage()))
      );
      expect(results.every(r => r.action === 'pass')).toBe(true);
    });

    it('includes trust level in pass decision', async () => {
      trustManager = createMockTrustManager({
        trustLevel: 'trusted',
        allowedOps: ['message'],
      });
      gate = new InboundMessageGate(trustManager as any, router, {});

      const decision = await gate.evaluate(createMessage());
      expect(decision.trustLevel).toBe('trusted');
    });

    it('includes fingerprint in block decision', async () => {
      trustManager = createMockTrustManager({
        trustLevel: 'untrusted',
        allowedOps: [],
      });
      gate = new InboundMessageGate(trustManager as any, router, {});

      const decision = await gate.evaluate(createMessage({ from: 'blocked-fp' }));
      expect(decision.fingerprint).toBe('blocked-fp');
    });
  });

  // ── Late-Binding Router ────────────────────────────────────────

  describe('setRouter (late binding)', () => {
    it('accepts null router at construction', () => {
      const nullGate = new InboundMessageGate(trustManager as any, null, {});
      expect(nullGate).toBeDefined();
      nullGate.shutdown();
    });

    it('evaluates messages with null router', async () => {
      const nullGate = new InboundMessageGate(trustManager as any, null, {});
      const decision = await nullGate.evaluate(createMessage());
      expect(decision.action).toBe('pass');
      nullGate.shutdown();
    });

    it('setRouter updates the router reference', () => {
      const nullGate = new InboundMessageGate(trustManager as any, null, {});
      const mockRouter = createMockRouter();
      nullGate.setRouter(mockRouter);
      // No error means it worked — router is stored for later use
      nullGate.shutdown();
    });
  });

  // ── Block-decision observability (PR4a) ─────────────────────────
  // A blocked inbound was previously SILENT — the verdict lived only in the
  // returned GateDecision + in-memory metric counters, never the log. That is
  // exactly how the Echo↔Dawn remote-relay leg went dark for ~1.5 days with no
  // trace. The gate now logs every eval + verdict (fingerprint truncated, no
  // payload content), surfacing the RESOLVED trust level so a fingerprint/trust
  // mismatch (trusted peer resolving 'untrusted' → insufficient_trust) is
  // diagnosable from server.log alone.

  describe('block-decision observability', () => {
    it('logs a BLOCK line with reason + fingerprint + resolved trust when an op is not permitted', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const untrusted = createMockTrustManager({ trustLevel: 'untrusted', allowedOps: [] });
      const g = new InboundMessageGate(untrusted as any, router, {});
      const decision = await g.evaluate(createMessage({ from: 'deadbeefcafefingerprint' }));
      expect(decision.action).toBe('block');
      expect(decision.reason).toBe('insufficient_trust');
      const logged = spy.mock.calls.map(c => String(c[0]));
      expect(logged.some(l => l.includes('[inbound-gate] BLOCK insufficient_trust') && l.includes('deadbeefcafe'))).toBe(true);
      // the resolved trust level is surfaced so a fp/trust mismatch is diagnosable
      expect(logged.some(l => l.includes('trust=untrusted'))).toBe(true);
      spy.mockRestore();
      g.shutdown();
    });

    it('logs an eval line and a PASS line for an allowed message', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const decision = await gate.evaluate(createMessage({ from: 'feedfacefeedfacefingerprint' }));
      expect(decision.action).toBe('pass');
      const logged = spy.mock.calls.map(c => String(c[0]));
      expect(logged.some(l => l.startsWith('[inbound-gate] eval from=feedfacefeed'))).toBe(true);
      expect(logged.some(l => l.startsWith('[inbound-gate] PASS from=feedfacefeed'))).toBe(true);
      spy.mockRestore();
    });

    it('logs a BLOCK line for an oversized payload (pre-trust check)', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const g = new InboundMessageGate(trustManager as any, router, { maxPayloadBytes: 100 });
      await g.evaluate(createMessage({ from: 'bignaughtypayloadfp', content: 'x'.repeat(500) }));
      const logged = spy.mock.calls.map(c => String(c[0]));
      expect(logged.some(l => l.includes('[inbound-gate] BLOCK payload_too_large'))).toBe(true);
      spy.mockRestore();
      g.shutdown();
    });
  });
});
