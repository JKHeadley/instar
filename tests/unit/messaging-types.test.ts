/**
 * Unit tests for messaging type definitions and constants.
 *
 * Tests:
 * - VALID_TRANSITIONS table correctness
 * - Default TTL and retention values per message type
 * - Rate limit configuration completeness
 * - Size limit constants
 * - ALLOWED_INJECTION_PROCESSES whitelist
 * - Clock skew tolerance configuration
 */

import { describe, it, expect } from 'vitest';
import {
  VALID_TRANSITIONS,
  DEFAULT_TTL,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_RATE_LIMITS,
  ALLOWED_INJECTION_PROCESSES,
  CLOCK_SKEW_TOLERANCE,
  MAX_BODY_SIZE,
  MAX_PAYLOAD_SIZE,
  MAX_SUBJECT_LENGTH,
  PAYLOAD_INLINE_THRESHOLD,
  THREAD_MAX_DEPTH,
  THREAD_STALE_MINUTES,
} from '../../src/messaging/types.js';
import type {
  DeliveryPhase,
  MessageType,
  AgentMessage,
  MessageEnvelope,
  DeliveryState,
  BroadcastState,
  SignedPayload,
  InjectionSafety,
  MessageThread,
} from '../../src/messaging/types.js';

// ── VALID_TRANSITIONS ────────────────────────────────────────────

describe('VALID_TRANSITIONS', () => {
  it('includes all forward transitions from the spec', () => {
    const expected: Array<[DeliveryPhase, DeliveryPhase]> = [
      ['created', 'sent'],
      ['sent', 'received'],
      ['received', 'queued'],
      ['received', 'delivered'],
      ['queued', 'delivered'],
      ['delivered', 'read'],
      ['received', 'expired'],
      ['queued', 'expired'],
      ['expired', 'dead-lettered'],
      ['failed', 'dead-lettered'],
    ];

    for (const [from, to] of expected) {
      const found = VALID_TRANSITIONS.some(([f, t]) => f === from && t === to);
      expect(found, `Missing transition: ${from} → ${to}`).toBe(true);
    }
  });

  it('includes the crash-watchdog exception: delivered → queued', () => {
    const found = VALID_TRANSITIONS.some(
      ([f, t]) => f === 'delivered' && t === 'queued',
    );
    expect(found).toBe(true);
  });

  it('includes failure transitions from active phases', () => {
    const activePhases: DeliveryPhase[] = ['created', 'sent', 'received', 'queued', 'delivered'];
    for (const phase of activePhases) {
      const found = VALID_TRANSITIONS.some(([f, t]) => f === phase && t === 'failed');
      expect(found, `Missing failure transition from ${phase}`).toBe(true);
    }
  });

  it('does not allow regress from read to any earlier phase', () => {
    const regressions = VALID_TRANSITIONS.filter(
      ([f]) => f === 'read',
    );
    // read is a terminal-ish phase — only transition should be none, or to dead-lettered at most
    for (const [, to] of regressions) {
      expect(['dead-lettered', 'failed']).toContain(to);
    }
  });

  it('does not allow dead-lettered to transition anywhere', () => {
    const fromDeadLetter = VALID_TRANSITIONS.filter(([f]) => f === 'dead-lettered');
    expect(fromDeadLetter).toHaveLength(0);
  });
});

// ── DEFAULT_TTL ──────────────────────────────────────────────────

describe('DEFAULT_TTL', () => {
  const allTypes: MessageType[] = [
    'info', 'sync', 'alert', 'request', 'query',
    'response', 'handoff', 'wellness', 'system',
  ];

  it('defines TTL for every message type', () => {
    for (const type of allTypes) {
      expect(DEFAULT_TTL[type], `Missing TTL for type: ${type}`).toBeDefined();
      expect(typeof DEFAULT_TTL[type]).toBe('number');
      expect(DEFAULT_TTL[type]).toBeGreaterThan(0);
    }
  });

  it('wellness has the shortest TTL (5 min)', () => {
    expect(DEFAULT_TTL.wellness).toBe(5);
    for (const type of allTypes) {
      expect(DEFAULT_TTL[type]).toBeGreaterThanOrEqual(DEFAULT_TTL.wellness);
    }
  });

  it('handoff has the longest TTL (480 min)', () => {
    expect(DEFAULT_TTL.handoff).toBe(480);
    for (const type of allTypes) {
      expect(DEFAULT_TTL[type]).toBeLessThanOrEqual(DEFAULT_TTL.handoff);
    }
  });

  it('alert and request have longer TTLs than info', () => {
    expect(DEFAULT_TTL.alert).toBeGreaterThan(DEFAULT_TTL.info);
    expect(DEFAULT_TTL.request).toBeGreaterThan(DEFAULT_TTL.info);
  });
});

// ── DEFAULT_RETENTION_DAYS ───────────────────────────────────────

describe('DEFAULT_RETENTION_DAYS', () => {
  const allTypes: MessageType[] = [
    'info', 'sync', 'alert', 'request', 'query',
    'response', 'handoff', 'wellness', 'system',
  ];

  it('defines retention for every message type', () => {
    for (const type of allTypes) {
      expect(DEFAULT_RETENTION_DAYS[type], `Missing retention for type: ${type}`).toBeDefined();
      expect(DEFAULT_RETENTION_DAYS[type]).toBeGreaterThan(0);
    }
  });

  it('handoff has the longest retention (90 days)', () => {
    expect(DEFAULT_RETENTION_DAYS.handoff).toBe(90);
  });

  it('wellness has the shortest retention (1 day)', () => {
    expect(DEFAULT_RETENTION_DAYS.wellness).toBe(1);
  });

  it('retention is always >= TTL (in comparable units)', () => {
    // Retention is in days, TTL is in minutes. retention days * 24 * 60 should be > TTL minutes
    for (const type of allTypes) {
      const retentionMinutes = DEFAULT_RETENTION_DAYS[type] * 24 * 60;
      expect(retentionMinutes).toBeGreaterThanOrEqual(DEFAULT_TTL[type]);
    }
  });
});

// ── DEFAULT_RATE_LIMITS ──────────────────────────────────────────

describe('DEFAULT_RATE_LIMITS', () => {
  it('defines all required rate limit scopes', () => {
    const requiredScopes = [
      'session-send',
      'session-receive',
      'agent-total',
      'broadcast',
      'cross-machine',
      'inbound-triggered',
    ];

    for (const scope of requiredScopes) {
      expect(DEFAULT_RATE_LIMITS[scope], `Missing rate limit scope: ${scope}`).toBeDefined();
      expect(DEFAULT_RATE_LIMITS[scope].maxMessages).toBeGreaterThan(0);
      expect(DEFAULT_RATE_LIMITS[scope].windowMs).toBeGreaterThan(0);
    }
  });

  it('inbound-triggered is the most restrictive', () => {
    const inbound = DEFAULT_RATE_LIMITS['inbound-triggered'];
    expect(inbound.maxMessages).toBeLessThanOrEqual(5);
    expect(inbound.windowMs).toBeLessThanOrEqual(60_000);
  });

  it('broadcast is more restrictive than general sending', () => {
    expect(DEFAULT_RATE_LIMITS['broadcast'].maxMessages)
      .toBeLessThan(DEFAULT_RATE_LIMITS['session-send'].maxMessages);
  });
});

// ── Size Limits ──────────────────────────────────────────────────

describe('size limits', () => {
  it('MAX_BODY_SIZE is 4KB', () => {
    expect(MAX_BODY_SIZE).toBe(4096);
  });

  it('MAX_PAYLOAD_SIZE is 16KB', () => {
    expect(MAX_PAYLOAD_SIZE).toBe(16_384);
  });

  it('MAX_SUBJECT_LENGTH is 200', () => {
    expect(MAX_SUBJECT_LENGTH).toBe(200);
  });

  it('PAYLOAD_INLINE_THRESHOLD is less than MAX_PAYLOAD_SIZE', () => {
    expect(PAYLOAD_INLINE_THRESHOLD).toBeLessThan(MAX_PAYLOAD_SIZE);
  });
});

// ── ALLOWED_INJECTION_PROCESSES ──────────────────────────────────

describe('ALLOWED_INJECTION_PROCESSES', () => {
  it('includes standard shells', () => {
    expect(ALLOWED_INJECTION_PROCESSES).toContain('bash');
    expect(ALLOWED_INJECTION_PROCESSES).toContain('zsh');
    expect(ALLOWED_INJECTION_PROCESSES).toContain('fish');
    expect(ALLOWED_INJECTION_PROCESSES).toContain('sh');
    expect(ALLOWED_INJECTION_PROCESSES).toContain('dash');
  });

  it('includes claude', () => {
    expect(ALLOWED_INJECTION_PROCESSES).toContain('claude');
  });

  it('does not include editors or REPLs', () => {
    expect(ALLOWED_INJECTION_PROCESSES).not.toContain('vim');
    expect(ALLOWED_INJECTION_PROCESSES).not.toContain('nano');
    expect(ALLOWED_INJECTION_PROCESSES).not.toContain('emacs');
    expect(ALLOWED_INJECTION_PROCESSES).not.toContain('python');
    expect(ALLOWED_INJECTION_PROCESSES).not.toContain('node');
  });

  it('is an array with the expected length', () => {
    // ReadonlyArray is a compile-time constraint; runtime check verifies it's a real array
    expect(Array.isArray(ALLOWED_INJECTION_PROCESSES)).toBe(true);
    expect(ALLOWED_INJECTION_PROCESSES.length).toBe(6);
  });
});

// ── CLOCK_SKEW_TOLERANCE ─────────────────────────────────────────

describe('CLOCK_SKEW_TOLERANCE', () => {
  it('defines tolerance for relay-machine (5 min)', () => {
    expect(CLOCK_SKEW_TOLERANCE['relay-machine']).toBe(5 * 60_000);
  });

  it('has null (no check) for same-machine transports', () => {
    expect(CLOCK_SKEW_TOLERANCE['relay-agent']).toBeNull();
    expect(CLOCK_SKEW_TOLERANCE['drop']).toBeNull();
  });

  it('has null for offline transports', () => {
    expect(CLOCK_SKEW_TOLERANCE['git-sync']).toBeNull();
    expect(CLOCK_SKEW_TOLERANCE['outbound-queue']).toBeNull();
  });
});

// ── Thread Constants ─────────────────────────────────────────────

describe('thread constants', () => {
  it('THREAD_MAX_DEPTH is 50', () => {
    expect(THREAD_MAX_DEPTH).toBe(50);
  });

  it('THREAD_STALE_MINUTES is 30', () => {
    expect(THREAD_STALE_MINUTES).toBe(30);
  });
});

// ── Type Shape Validation ────────────────────────────────────────

describe('type shape validation', () => {
  it('AgentMessage shape has all required fields', () => {
    const msg: AgentMessage = {
      id: 'msg-123',
      from: { agent: 'test-agent', session: 'test-session', machine: 'test-machine' },
      to: { agent: 'target-agent', session: 'best', machine: 'local' },
      type: 'query',
      priority: 'medium',
      subject: 'Test message',
      body: 'Hello, world!',
      createdAt: new Date().toISOString(),
      ttlMinutes: 30,
    };

    expect(msg.id).toBe('msg-123');
    expect(msg.from.agent).toBe('test-agent');
    expect(msg.to.session).toBe('best');
    expect(msg.type).toBe('query');
  });

  it('MessageEnvelope wraps AgentMessage with transport', () => {
    const envelope: MessageEnvelope = {
      schemaVersion: 1,
      message: {
        id: 'msg-456',
        from: { agent: 'a', session: 's', machine: 'm' },
        to: { agent: 'b', session: 'best', machine: 'local' },
        type: 'info',
        priority: 'low',
        subject: 'Test',
        body: 'Body',
        createdAt: new Date().toISOString(),
        ttlMinutes: 30,
      },
      transport: {
        relayChain: [],
        originServer: 'http://localhost:3000',
        nonce: 'abc:2026-02-28T00:00:00Z',
        timestamp: new Date().toISOString(),
      },
      delivery: {
        phase: 'created',
        transitions: [],
        attempts: 0,
      },
    };

    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.transport.relayChain).toHaveLength(0);
    expect(envelope.delivery.phase).toBe('created');
  });

  it('BroadcastState tracks per-recipient phases', () => {
    const state: BroadcastState = {
      totalRecipients: 3,
      recipients: {
        'session-1': { phase: 'delivered' },
        'session-2': { phase: 'queued', lastAttempt: new Date().toISOString() },
        'session-3': { phase: 'failed', failureReason: 'session dead' },
      },
      aggregate: 'partial',
    };

    expect(state.totalRecipients).toBe(3);
    expect(Object.keys(state.recipients)).toHaveLength(3);
    expect(state.aggregate).toBe('partial');
  });

  it('SignedPayload includes transport fields, not delivery', () => {
    const payload: SignedPayload = {
      message: {
        id: 'msg-789',
        from: { agent: 'a', session: 's', machine: 'm' },
        to: { agent: 'b', session: 'best', machine: 'remote' },
        type: 'alert',
        priority: 'high',
        subject: 'Security alert',
        body: 'Something happened',
        createdAt: new Date().toISOString(),
        ttlMinutes: 60,
      },
      relayChain: ['machine-1'],
      originServer: 'http://machine-1:3000',
      nonce: 'uuid:timestamp',
      timestamp: new Date().toISOString(),
    };

    // SignedPayload should NOT have a delivery field
    expect('delivery' in payload).toBe(false);
    // But should have relayChain, originServer, nonce, timestamp
    expect(payload.relayChain).toBeDefined();
    expect(payload.originServer).toBeDefined();
    expect(payload.nonce).toBeDefined();
    expect(payload.timestamp).toBeDefined();
  });
});
