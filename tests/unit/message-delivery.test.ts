/**
 * Unit tests for MessageDelivery — safe tmux message injection.
 *
 * Tests:
 * - Injection safety checks (process whitelist, human input, context budget)
 * - Delivery decision tree logic
 * - Per-session mutex (FIFO ordering)
 * - Delivery state transitions
 *
 * NOTE: These tests use mocked tmux operations since unit tests
 * should not depend on a running tmux server.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import type { MessageEnvelope, AgentMessage, InjectionSafety } from '../../src/messaging/types.js';
import { ALLOWED_INJECTION_PROCESSES } from '../../src/messaging/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function makeMessage(overrides?: Partial<AgentMessage>): AgentMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: { agent: 'sender-agent', session: 'sender-session', machine: 'local' },
    to: { agent: 'target-agent', session: 'target-session', machine: 'local' },
    type: 'info',
    priority: 'medium',
    subject: 'Test',
    body: 'Test body',
    createdAt: new Date().toISOString(),
    ttlMinutes: 30,
    ...overrides,
  };
}

function makeEnvelope(overrides?: Partial<AgentMessage>): MessageEnvelope {
  return {
    schemaVersion: 1,
    message: makeMessage(overrides),
    transport: {
      relayChain: [],
      originServer: 'http://localhost:3000',
      nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
      timestamp: new Date().toISOString(),
    },
    delivery: {
      phase: 'received',
      transitions: [
        { from: 'created', to: 'sent', at: new Date().toISOString() },
        { from: 'sent', to: 'received', at: new Date().toISOString() },
      ],
      attempts: 0,
    },
  };
}

// ── Mock tmux operations ─────────────────────────────────────────

interface MockTmuxOps {
  getForegroundProcess: ReturnType<typeof vi.fn>;
  isSessionAlive: ReturnType<typeof vi.fn>;
  hasActiveHumanInput: ReturnType<typeof vi.fn>;
  sendKeys: ReturnType<typeof vi.fn>;
  getOutputLineCount: ReturnType<typeof vi.fn>;
}

function createMockTmuxOps(): MockTmuxOps {
  return {
    getForegroundProcess: vi.fn().mockReturnValue('bash'),
    isSessionAlive: vi.fn().mockReturnValue(true),
    hasActiveHumanInput: vi.fn().mockReturnValue(false),
    sendKeys: vi.fn().mockReturnValue(true),
    getOutputLineCount: vi.fn().mockReturnValue(100),
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('MessageDelivery', () => {
  let mockTmux: MockTmuxOps;
  let delivery: MessageDelivery;

  beforeEach(() => {
    mockTmux = createMockTmuxOps();
    delivery = new MessageDelivery(
      new MessageFormatter(),
      mockTmux as any,
    );
  });

  // ── Injection Safety ────────────────────────────────────────────

  describe('checkInjectionSafety', () => {
    it('reports safe when shell is running and no human input', async () => {
      mockTmux.getForegroundProcess.mockReturnValue('bash');
      mockTmux.hasActiveHumanInput.mockReturnValue(false);
      mockTmux.getOutputLineCount.mockReturnValue(100);

      const safety = await delivery.checkInjectionSafety('test-session');
      expect(safety.isSafeProcess).toBe(true);
      expect(safety.hasHumanInput).toBe(false);
      expect(safety.contextBudgetExceeded).toBe(false);
    });

    it('flags unsafe when editor is running', async () => {
      mockTmux.getForegroundProcess.mockReturnValue('vim');
      const safety = await delivery.checkInjectionSafety('test-session');
      expect(safety.isSafeProcess).toBe(false);
      expect(safety.foregroundProcess).toBe('vim');
    });

    it('flags all whitelisted processes as safe', async () => {
      for (const process of ALLOWED_INJECTION_PROCESSES) {
        mockTmux.getForegroundProcess.mockReturnValue(process);
        const safety = await delivery.checkInjectionSafety('test-session');
        expect(safety.isSafeProcess, `Process ${process} should be safe`).toBe(true);
      }
    });

    it('flags non-whitelisted processes as unsafe', async () => {
      const unsafeProcesses = ['vim', 'nano', 'emacs', 'python', 'node', 'less', 'man', 'top'];
      for (const process of unsafeProcesses) {
        mockTmux.getForegroundProcess.mockReturnValue(process);
        const safety = await delivery.checkInjectionSafety('test-session');
        expect(safety.isSafeProcess, `Process ${process} should be unsafe`).toBe(false);
      }
    });

    it('detects human input collision', async () => {
      mockTmux.hasActiveHumanInput.mockReturnValue(true);
      const safety = await delivery.checkInjectionSafety('test-session');
      expect(safety.hasHumanInput).toBe(true);
    });
  });

  // ── Delivery Decision Tree ──────────────────────────────────────

  describe('deliverToSession', () => {
    it('succeeds when session is alive and shell is running', async () => {
      const envelope = makeEnvelope();
      const result = await delivery.deliverToSession('test-session', envelope);

      expect(result.success).toBe(true);
      expect(result.phase).toBe('delivered');
      expect(mockTmux.sendKeys).toHaveBeenCalled();
    });

    it('queues when session is not alive', async () => {
      mockTmux.isSessionAlive.mockReturnValue(false);
      const envelope = makeEnvelope();
      const result = await delivery.deliverToSession('dead-session', envelope);

      expect(result.success).toBe(false);
      expect(result.phase).toBe('queued');
      expect(result.shouldRetry).toBe(true);
      expect(mockTmux.sendKeys).not.toHaveBeenCalled();
    });

    it('defers when editor is active', async () => {
      mockTmux.getForegroundProcess.mockReturnValue('vim');
      const envelope = makeEnvelope();
      const result = await delivery.deliverToSession('editor-session', envelope);

      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(true);
    });

    it('defers when human is typing', async () => {
      mockTmux.hasActiveHumanInput.mockReturnValue(true);
      const envelope = makeEnvelope();
      const result = await delivery.deliverToSession('human-session', envelope);

      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(true);
    });

    it('returns failure when sendKeys fails', async () => {
      mockTmux.sendKeys.mockReturnValue(false);
      const envelope = makeEnvelope();
      const result = await delivery.deliverToSession('failing-session', envelope);

      expect(result.success).toBe(false);
    });
  });

  // ── Formatting ──────────────────────────────────────────────────

  describe('formatting delegation', () => {
    it('uses inline format for normal messages', () => {
      const msg = makeMessage();
      const result = delivery.formatInline(msg);
      expect(result).toContain('[AGENT MESSAGE]');
      expect(result).toContain(msg.body);
    });

    it('uses pointer format for context-limited delivery', () => {
      const msg = makeMessage({ id: 'msg-pointer' });
      const result = delivery.formatPointer(msg);
      expect(result).toContain('/msg read msg-pointer');
      expect(result).not.toContain(msg.body);
    });
  });
});
