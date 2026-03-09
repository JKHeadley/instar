/**
 * A2AGateway Unit Tests
 *
 * Tests the A2A Gateway translation layer between A2A protocol and Threadline.
 * Uses mock dependencies for all Threadline components.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { A2AGateway, A2A_ERROR_CODES } from '../../../src/threadline/A2AGateway.js';
import type {
  A2AGatewayConfig,
  A2AGatewayDeps,
  GatewaySendParams,
  GatewayResponse,
} from '../../../src/threadline/A2AGateway.js';

// ── Mock Factories ──────────────────────────────────────────────────

function createMockAgentCard() {
  return {
    generate: vi.fn().mockReturnValue({
      card: {
        name: 'test-agent',
        description: 'Test agent',
        url: 'https://test.example.com',
        version: '1.0.0',
        capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [{
          id: 'conversation',
          name: 'Conversation',
          description: 'Test conversation skill',
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
        }],
        provider: { organization: 'Test', url: 'https://test.example.com' },
      },
      signature: 'mock-signature-hex',
      canonicalJson: '{"name":"test-agent"}',
    }),
    getPublicCard: vi.fn().mockReturnValue({ name: 'test-agent' }),
    getExtendedCard: vi.fn().mockReturnValue({ name: 'test-agent', extensions: {} }),
  };
}

function createMockContextThreadMap() {
  const map = new Map<string, { threadId: string; agentIdentity: string }>();
  return {
    getThreadId: vi.fn((contextId: string, agentIdentity: string) => {
      const entry = map.get(contextId);
      if (!entry) return null;
      if (entry.agentIdentity !== agentIdentity) return null;
      return entry.threadId;
    }),
    getContextId: vi.fn((_threadId: string) => null),
    set: vi.fn((contextId: string, threadId: string, agentIdentity: string) => {
      map.set(contextId, { threadId, agentIdentity });
    }),
    delete: vi.fn(),
    deleteByThreadId: vi.fn(),
    size: vi.fn(() => map.size),
    cleanup: vi.fn(() => 0),
    clear: vi.fn(),
    persist: vi.fn(),
    reload: vi.fn(),
  };
}

function createMockComputeMeter() {
  return {
    check: vi.fn().mockReturnValue({
      allowed: true,
      remaining: { hourlyTokens: 10000, dailyTokens: 50000, globalDailyTokens: 5000000, sessions: 10 },
    }),
    record: vi.fn().mockReturnValue({
      allowed: true,
      remaining: { hourlyTokens: 9000, dailyTokens: 49000, globalDailyTokens: 4999000, sessions: 10 },
    }),
    getBudget: vi.fn(),
    getAgentState: vi.fn(() => null),
    getGlobalState: vi.fn(() => ({ dailyTokens: 0, dayWindowStart: new Date().toISOString(), lastUpdated: new Date().toISOString() })),
    incrementSessions: vi.fn(() => true),
    decrementSessions: vi.fn(),
    reset: vi.fn(),
    persist: vi.fn(),
    reload: vi.fn(),
  };
}

function createMockSessionLifecycle() {
  return {
    activate: vi.fn().mockReturnValue({ canActivate: true }),
    touch: vi.fn(),
    incrementMessages: vi.fn(),
    get: vi.fn(() => null),
    getByAgent: vi.fn(() => []),
    getStats: vi.fn(() => ({ active: 0, parked: 0, archived: 0, evicted: 0, total: 0 })),
    transitionState: vi.fn(() => true),
    runMaintenance: vi.fn(async () => 0),
    remove: vi.fn(() => true),
    clear: vi.fn(),
    size: vi.fn(() => 0),
    persist: vi.fn(),
    reload: vi.fn(),
  };
}

function createMockTrustManager() {
  return {
    getProfile: vi.fn(() => ({ level: 'untrusted' })),
    setTrustLevel: vi.fn(),
    recordInteraction: vi.fn(),
    getAuditTrail: vi.fn(() => []),
  };
}

function createMockRateLimiter() {
  return {
    checkLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 29, resetAt: Date.now() + 60000 }),
    recordEvent: vi.fn(),
    isLimited: vi.fn(() => false),
    getStatus: vi.fn(() => []),
  };
}

function createMockCircuitBreaker() {
  return {
    getState: vi.fn(() => ({ state: 'closed' })),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    reset: vi.fn(),
  };
}

function createDefaultConfig(): A2AGatewayConfig {
  return {
    agentName: 'test-agent',
    sendMessage: vi.fn(async (params: GatewaySendParams): Promise<GatewayResponse> => ({
      message: `Echo: ${params.message}`,
      tokenCount: params.message.length * 2,
    })),
  };
}

function createDefaultDeps(): A2AGatewayDeps {
  return {
    agentCard: createMockAgentCard() as any,
    contextThreadMap: createMockContextThreadMap() as any,
    computeMeter: createMockComputeMeter() as any,
    sessionLifecycle: createMockSessionLifecycle() as any,
    trustManager: createMockTrustManager() as any,
    rateLimiter: createMockRateLimiter() as any,
    circuitBreaker: createMockCircuitBreaker() as any,
  };
}

function createA2ARequest(method: string, params: Record<string, unknown> = {}, id: number = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
}

function createSendMessageRequest(text: string, contextId?: string) {
  return createA2ARequest('message/send', {
    message: {
      role: 'user',
      parts: [{ kind: 'text', text }],
      kind: 'message',
      messageId: crypto.randomUUID(),
    },
    ...(contextId ? { configuration: { contextId } } : {}),
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('A2AGateway', () => {
  let config: A2AGatewayConfig;
  let deps: A2AGatewayDeps;
  let gateway: A2AGateway;

  beforeEach(() => {
    config = createDefaultConfig();
    deps = createDefaultDeps();
    gateway = new A2AGateway(config, deps);
  });

  // ── Constructor ──────────────────────────────────────────────

  describe('constructor', () => {
    it('creates gateway with config and deps', () => {
      expect(gateway).toBeInstanceOf(A2AGateway);
    });

    it('generates agent card on construction', () => {
      expect(deps.agentCard.generate).toHaveBeenCalled();
    });

    it('accepts custom task duration and max tasks options', () => {
      const gw = new A2AGateway(config, deps, {
        maxTaskDurationMs: 60000,
        maxActiveTasksPerAgent: 5,
      });
      expect(gw).toBeInstanceOf(A2AGateway);
    });
  });

  // ── Agent Card ───────────────────────────────────────────────

  describe('getAgentCard', () => {
    it('returns card with signature and headers', () => {
      const result = gateway.getAgentCard();
      expect(result.card).toBeDefined();
      expect(result.card.name).toBe('test-agent');
      expect(result.signature).toBe('mock-signature-hex');
      expect(result.headers['Content-Type']).toBe('application/json');
      expect(result.headers['X-Threadline-Card-Signature']).toBe('mock-signature-hex');
    });
  });

  // ── Handle Request ───────────────────────────────────────────

  describe('handleRequest', () => {
    it('handles agent card request', async () => {
      const request = createA2ARequest('agent/getAgentCard');
      const result = await gateway.handleRequest(request);
      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('application/json');
    });

    it('returns error for invalid JSON-RPC', async () => {
      const result = await gateway.handleRequest({ invalid: true });
      // SDK handles this as internal error
      expect(result.statusCode).toBe(200); // JSON-RPC errors are still 200
    });

    it('includes Retry-After header on rate limit', async () => {
      (deps.rateLimiter!.checkLimit as any).mockReturnValue({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 30000,
      });

      const request = createSendMessageRequest('Hello');
      const result = await gateway.handleRequest(request, { agentIdentity: 'agent-1' });
      expect(result.statusCode).toBe(429);
      expect(result.headers['Retry-After']).toBeDefined();
    });

    it('returns error when circuit breaker is open', async () => {
      (deps.circuitBreaker!.getState as any).mockReturnValue({ state: 'open' });

      const request = createSendMessageRequest('Hello');
      const result = await gateway.handleRequest(request, { agentIdentity: 'agent-1' });
      expect(result.statusCode).toBe(503);
    });

    it('passes through when no agentIdentity in context', async () => {
      const request = createA2ARequest('agent/getAgentCard');
      const result = await gateway.handleRequest(request);
      // Should not run preflight checks
      expect(deps.rateLimiter!.checkLimit).not.toHaveBeenCalled();
      expect(result.statusCode).toBe(200);
    });
  });

  // ── Preflight Checks ────────────────────────────────────────

  describe('preflight checks', () => {
    it('allows request when all checks pass', async () => {
      const request = createA2ARequest('agent/getAgentCard');
      const result = await gateway.handleRequest(request, { agentIdentity: 'agent-1' });
      expect(result.statusCode).toBe(200);
    });

    it('blocks when rate limited', async () => {
      (deps.rateLimiter!.checkLimit as any).mockReturnValue({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 60000,
      });

      const request = createSendMessageRequest('test');
      const result = await gateway.handleRequest(request, { agentIdentity: 'agent-1' });
      expect(result.statusCode).toBe(429);
      const body = result.body as any;
      expect(body.error.code).toBe(A2A_ERROR_CODES.RATE_LIMITED);
    });

    it('blocks when circuit breaker open', async () => {
      (deps.circuitBreaker!.getState as any).mockReturnValue({ state: 'open' });

      const request = createSendMessageRequest('test');
      const result = await gateway.handleRequest(request, { agentIdentity: 'agent-1' });
      expect(result.statusCode).toBe(503);
      const body = result.body as any;
      expect(body.error.code).toBe(A2A_ERROR_CODES.AGENT_UNAVAILABLE);
    });

    it('allows half-open circuit breaker', async () => {
      (deps.circuitBreaker!.getState as any).mockReturnValue({ state: 'half-open' });

      const request = createA2ARequest('agent/getAgentCard');
      const result = await gateway.handleRequest(request, { agentIdentity: 'agent-1' });
      expect(result.statusCode).toBe(200);
    });

    it('blocks when max concurrent tasks exceeded', async () => {
      // Create a gateway with maxActiveTasksPerAgent = 0
      const gw = new A2AGateway(config, deps, { maxActiveTasksPerAgent: 0 });
      const request = createSendMessageRequest('test');
      const result = await gw.handleRequest(request, { agentIdentity: 'agent-1' });
      expect(result.statusCode).toBe(429);
    });
  });

  // ── Metrics ──────────────────────────────────────────────────

  describe('getMetrics', () => {
    it('returns Prometheus-format string', () => {
      const metrics = gateway.getMetrics();
      expect(typeof metrics).toBe('string');
      expect(metrics).toContain('threadline_handshakes_total');
      expect(metrics).toContain('threadline_active_sessions');
    });

    it('tracks request counts after handling', async () => {
      await gateway.handleRequest(createA2ARequest('agent/getAgentCard'));
      const metrics = gateway.getMetrics();
      expect(metrics).toContain('threadline_a2a_requests_total');
    });
  });

  // ── Compute Data ─────────────────────────────────────────────

  describe('getComputeData', () => {
    it('returns global and per-agent data', () => {
      const data = gateway.getComputeData();
      expect(data.global).toBeDefined();
      expect(data.agents).toBeDefined();
    });
  });

  // ── Audit Log ────────────────────────────────────────────────

  describe('getAuditLog', () => {
    it('returns empty array initially', () => {
      expect(gateway.getAuditLog()).toEqual([]);
    });

    it('captures rate limit events', async () => {
      (deps.rateLimiter!.checkLimit as any).mockReturnValue({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 60000,
      });
      await gateway.handleRequest(createSendMessageRequest('test'), { agentIdentity: 'agent-1' });

      const log = gateway.getAuditLog();
      expect(log.length).toBeGreaterThan(0);
      expect(log[0].event).toBe('rate_limited');
      expect(log[0].agentIdentity).toBe('agent-1');
    });

    it('respects limit parameter', async () => {
      // Generate multiple audit events
      (deps.rateLimiter!.checkLimit as any).mockReturnValue({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 60000,
      });
      for (let i = 0; i < 5; i++) {
        await gateway.handleRequest(createSendMessageRequest('test'), { agentIdentity: `agent-${i}` });
      }

      const limited = gateway.getAuditLog(2);
      expect(limited.length).toBe(2);
    });
  });

  // ── Active Tasks ─────────────────────────────────────────────

  describe('getActiveTaskCount', () => {
    it('returns 0 initially', () => {
      expect(gateway.getActiveTaskCount('agent-1')).toBe(0);
    });
  });

  // ── Maintenance ──────────────────────────────────────────────

  describe('runMaintenance', () => {
    it('runs session lifecycle maintenance', async () => {
      const result = await gateway.runMaintenance();
      expect(result.sessionTransitions).toBe(0);
      expect(result.expiredTasks).toBe(0);
      expect(deps.sessionLifecycle.runMaintenance).toHaveBeenCalled();
    });
  });

  // ── Error Code Mapping ───────────────────────────────────────

  describe('error codes', () => {
    it('has all required A2A error codes', () => {
      expect(A2A_ERROR_CODES.INVALID_REQUEST).toBe(-32600);
      expect(A2A_ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
      expect(A2A_ERROR_CODES.INVALID_PARAMS).toBe(-32602);
      expect(A2A_ERROR_CODES.RATE_LIMITED).toBe(-32000);
      expect(A2A_ERROR_CODES.AUTH_FAILED).toBe(-32001);
      expect(A2A_ERROR_CODES.AGENT_UNAVAILABLE).toBe(-32002);
      expect(A2A_ERROR_CODES.COMPUTE_EXCEEDED).toBe(-32003);
      expect(A2A_ERROR_CODES.TASK_TIMEOUT).toBe(-32004);
      expect(A2A_ERROR_CODES.TRUST_INSUFFICIENT).toBe(-32005);
    });
  });

  // ── Error Handling ───────────────────────────────────────────

  describe('error handling', () => {
    it('handles null input gracefully', async () => {
      const result = await gateway.handleRequest(null);
      // SDK handles null as invalid JSON-RPC — still returns 200 with JSON-RPC error
      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('application/json');
    });
  });

  // ── Headers ──────────────────────────────────────────────────

  describe('response headers', () => {
    it('includes Content-Type', async () => {
      const result = await gateway.handleRequest(createA2ARequest('agent/getAgentCard'));
      expect(result.headers['Content-Type']).toBe('application/json');
    });

    it('includes X-Threadline-Card-Signature', async () => {
      const result = await gateway.handleRequest(createA2ARequest('agent/getAgentCard'));
      expect(result.headers['X-Threadline-Card-Signature']).toBe('mock-signature-hex');
    });
  });
});
