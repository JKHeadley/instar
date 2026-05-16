/**
 * Unit tests for TelegramConfirmer (Phase 5b.3).
 *
 * Verifies the prompt-shape, the four shorthand paths, the LLM-backed
 * free-text fallback, and the timeout / default-no-reply path. Uses a
 * stub ConfirmationTransport and stub OverrideDetector — no real
 * Telegram bot, no real LLM.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  TelegramConfirmer,
  formatConfirmationPrompt,
  type ConfirmationPrompt,
  type ConfirmationTransport,
  type ConfirmationResult,
} from '../../../../src/providers/uxConfirm/TelegramConfirmer.js';
import {
  OverrideDetector,
} from '../../../../src/providers/uxConfirm/OverrideDetector.js';
import type { IntelligenceProvider } from '../../../../src/core/types.js';

function makeProvider(reply: string): IntelligenceProvider {
  return { evaluate: async () => reply };
}

function makeDetector(reply: string): OverrideDetector {
  return new OverrideDetector({
    intelligence: makeProvider(reply),
    knownFrameworks: ['claude-code', 'codex-cli'],
    knownModels: ['opus-4.7', 'gpt-5.3-codex', 'gemini'],
  });
}

function stubTransport(opts: { reply: string | null }): ConfirmationTransport & {
  sentMessages: Array<{ topicId: string; text: string }>;
} {
  const sentMessages: Array<{ topicId: string; text: string }> = [];
  return {
    sentMessages,
    send: async ({ topicId, text }) => {
      sentMessages.push({ topicId, text });
    },
    awaitReply: async () => opts.reply,
  };
}

const PROMPT: ConfirmationPrompt = {
  topicId: '9984',
  taskDescription: 'refactor the imessage adapter',
  taskPattern: 'code-refactor-typescript',
  proposedFramework: 'claude-code',
  proposedModel: 'opus-4.7',
  confidence: 'HIGH',
  reason: 'new-pattern',
};

describe('formatConfirmationPrompt', () => {
  it('produces the documented multi-line shape', () => {
    const text = formatConfirmationPrompt(PROMPT);
    expect(text).toContain('About to run this task with claude-code + opus-4.7');
    expect(text).toContain('Task: refactor the imessage adapter');
    expect(text).toContain('Pattern: code-refactor-typescript (confidence: HIGH)');
    expect(text).toContain('Reason for asking: new pattern');
    expect(text).toContain('ok / c / 👍');
    expect(text).toContain('/route reset');
    expect(text).toContain('one-shot / once');
  });

  it('appends reasonDetail when provided', () => {
    const text = formatConfirmationPrompt({
      ...PROMPT,
      reason: 'cost-shift',
      reasonDetail: 'sdk-credit-crossed-below-safety-margin',
    });
    expect(text).toContain('Reason for asking: cost / quota state changed materially');
    expect(text).toContain('— sdk-credit-crossed-below-safety-margin');
  });

  it('uses the right reason text for each reason kind', () => {
    expect(formatConfirmationPrompt({ ...PROMPT, reason: 'new-pattern' })).toContain('new pattern');
    expect(formatConfirmationPrompt({ ...PROMPT, reason: 'cost-shift' })).toContain('cost / quota');
    expect(formatConfirmationPrompt({ ...PROMPT, reason: 'low-confidence' })).toContain('catalog confidence');
  });
});

describe('TelegramConfirmer.confirm', () => {
  it('sends the prompt before awaiting a reply', async () => {
    const transport = stubTransport({ reply: 'ok' });
    const c = new TelegramConfirmer({
      transport,
      overrideDetector: makeDetector('{"override":false}'),
    });
    await c.confirm(PROMPT);
    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.sentMessages[0]!.topicId).toBe('9984');
    expect(transport.sentMessages[0]!.text).toContain('About to run this task');
  });

  it('returns default-no-reply when the transport times out', async () => {
    const transport = stubTransport({ reply: null });
    const c = new TelegramConfirmer({
      transport,
      overrideDetector: makeDetector('{"override":false}'),
    });
    const result = await c.confirm(PROMPT);
    expect(result.kind).toBe('default-no-reply');
  });

  it('passes the configured timeoutMs through to the transport', async () => {
    const awaitReply = vi.fn(async () => null);
    const transport: ConfirmationTransport = {
      send: async () => {},
      awaitReply,
    };
    const c = new TelegramConfirmer({
      transport,
      overrideDetector: makeDetector('{"override":false}'),
      timeoutMs: 1234,
    });
    await c.confirm(PROMPT);
    expect(awaitReply.mock.calls[0]?.[0].timeoutMs).toBe(1234);
  });

  it('defaults timeoutMs to 5 minutes', async () => {
    const awaitReply = vi.fn(async () => null);
    const transport: ConfirmationTransport = { send: async () => {}, awaitReply };
    const c = new TelegramConfirmer({
      transport,
      overrideDetector: makeDetector('{"override":false}'),
    });
    await c.confirm(PROMPT);
    expect(awaitReply.mock.calls[0]?.[0].timeoutMs).toBe(5 * 60 * 1000);
  });
});

describe('TelegramConfirmer.parseReply — shorthand paths', () => {
  const c = new TelegramConfirmer({
    transport: stubTransport({ reply: null }),
    overrideDetector: makeDetector('{"override":false}'),
  });

  for (const shorthand of ['ok', 'c', 'yes', 'y', 'go', 'OK', '  ok  ', '👍']) {
    it(`treats "${shorthand}" as confirm-with-cache`, async () => {
      const r = await c.parseReply(shorthand, PROMPT);
      expect(r.kind).toBe('confirmed');
      if (r.kind === 'confirmed') {
        expect(r.cache).toBe(true);
        expect(r.framework).toBe('claude-code');
        expect(r.model).toBe('opus-4.7');
      }
    });
  }

  for (const shorthand of ['one-shot', 'oneshot', 'once', 'ONCE']) {
    it(`treats "${shorthand}" as confirm-no-cache`, async () => {
      const r = await c.parseReply(shorthand, PROMPT);
      expect(r.kind).toBe('confirmed');
      if (r.kind === 'confirmed') {
        expect(r.cache).toBe(false);
      }
    });
  }

  for (const shorthand of ['/route reset', 'route reset', '/ROUTE  RESET', 'route   reset']) {
    it(`treats "${shorthand}" as reset`, async () => {
      const r = await c.parseReply(shorthand, PROMPT);
      expect(r.kind).toBe('reset');
    });
  }

  for (const shorthand of ['no', 'n', 'No', ' N ']) {
    it(`treats "${shorthand}" as overridden-scope-this-task with no named pick`, async () => {
      const r = await c.parseReply(shorthand, PROMPT);
      expect(r.kind).toBe('overridden');
      if (r.kind === 'overridden') {
        expect(r.scope).toBe('this-task');
        expect(r.framework).toBeUndefined();
        expect(r.model).toBeUndefined();
      }
    });
  }
});

describe('TelegramConfirmer.parseReply — free-text via OverrideDetector', () => {
  it('returns overridden when the detector finds an override', async () => {
    const c = new TelegramConfirmer({
      transport: stubTransport({ reply: null }),
      overrideDetector: makeDetector(
        '{"override":true, "framework":null, "model":"gemini", "scope":"this-task"}',
      ),
    });
    const r = (await c.parseReply('use Gemini for this one', PROMPT)) as Extract<
      ConfirmationResult,
      { kind: 'overridden' }
    >;
    expect(r.kind).toBe('overridden');
    expect(r.model).toBe('gemini');
    expect(r.scope).toBe('this-task');
  });

  it('preserves this-pattern scope from the detector', async () => {
    const c = new TelegramConfirmer({
      transport: stubTransport({ reply: null }),
      overrideDetector: makeDetector(
        '{"override":true, "framework":"codex-cli", "model":null, "scope":"this-pattern"}',
      ),
    });
    const r = (await c.parseReply('always use codex-cli for refactors', PROMPT)) as Extract<
      ConfirmationResult,
      { kind: 'overridden' }
    >;
    expect(r.scope).toBe('this-pattern');
    expect(r.framework).toBe('codex-cli');
  });

  it('returns overridden-scope-this-task when detector says not-an-override (ambiguous free-text)', async () => {
    const c = new TelegramConfirmer({
      transport: stubTransport({ reply: null }),
      overrideDetector: makeDetector('{"override":false}'),
    });
    const r = await c.parseReply('hmm not sure', PROMPT);
    expect(r.kind).toBe('overridden');
    if (r.kind === 'overridden') {
      expect(r.scope).toBe('this-task');
      expect(r.framework).toBeUndefined();
      expect(r.model).toBeUndefined();
    }
  });
});
