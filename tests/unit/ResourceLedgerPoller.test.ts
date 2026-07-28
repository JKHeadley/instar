import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ResourceLedger } from '../../src/monitoring/ResourceLedger.js';
import { ResourceLedgerPoller } from '../../src/monitoring/ResourceLedgerPoller.js';
import { LlmCircuitBreaker } from '../../src/core/LlmCircuitBreaker.js';

describe('ResourceLedgerPoller — capture→persist (Phase A, wiring integrity)', () => {
  let ledger: ResourceLedger | null = null;
  let poller: ResourceLedgerPoller | null = null;
  afterEach(() => { poller?.stop(); ledger?.close(); ledger = null; poller = null; });

  it('a REAL breaker trip lands a durable circuit-open row', () => {
    let t = 10_000;
    ledger = new ResourceLedger({ dbPath: ':memory:' });
    const breaker = new LlmCircuitBreaker({ openMs: 1000, now: () => t });
    poller = new ResourceLedgerPoller({ ledger, breaker, now: () => t });
    poller.start();

    breaker.onRateLimited('429 rate limited', 60_000); // real trip → real emit → poller → ledger

    const rows = ledger.rateLimitEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'circuit-open', source: 'circuit-breaker', reason: '429 rate limited' });
    expect(ledger.rateLimitSummary(t, 3_600_000).circuitOpenCount).toBe(1);
  });

  it('records recover on open→closed', () => {
    let t = 1000;
    ledger = new ResourceLedger({ dbPath: ':memory:' });
    const breaker = new LlmCircuitBreaker({ openMs: 1000, now: () => t });
    poller = new ResourceLedgerPoller({ ledger, breaker, now: () => t });
    poller.start();
    breaker.onRateLimited('429');
    breaker.onResolved();
    const s = ledger.rateLimitSummary(t, 3_600_000);
    expect(s.circuitOpenCount).toBe(1);
    expect(s.circuitRecoverCount).toBe(1);
  });

  it('records session-sentinel detections separately (source-tagged)', () => {
    let t = 5_000;
    ledger = new ResourceLedger({ dbPath: ':memory:' });
    const breaker = new LlmCircuitBreaker({ openMs: 1000, now: () => t });
    const sentinel = new EventEmitter();
    poller = new ResourceLedgerPoller({ ledger, breaker, rateLimitSentinel: sentinel, now: () => t });
    poller.start();

    sentinel.emit('rate-limit:detected', { sessionName: 'sess-a', reason: 'server is temporarily limiting requests' });
    sentinel.emit('rate-limit:detected', { sessionName: 'sess-b', reason: 'repeated 529 overloaded errors' });

    const s = ledger.rateLimitSummary(t, 3_600_000);
    expect(s.sentinelCount).toBe(2);
    expect(s.circuitOpenCount).toBe(0);
    const byKind = ledger.rateLimitByKind(t, 3_600_000);
    expect(byKind.find(k => k.kind === '529')?.count).toBe(1);
    expect(byKind.find(k => k.kind === 'throttle')?.count).toBe(1);
  });

  it('stop() unsubscribes — no rows after stop', () => {
    let t = 1000;
    ledger = new ResourceLedger({ dbPath: ':memory:' });
    const breaker = new LlmCircuitBreaker({ openMs: 1000, now: () => t });
    poller = new ResourceLedgerPoller({ ledger, breaker, now: () => t });
    poller.start();
    poller.stop();
    breaker.onRateLimited('429');
    expect(ledger.rateLimitEvents()).toHaveLength(0);
  });
});
