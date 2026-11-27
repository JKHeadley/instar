/** ACT-115: an authority-bearing button with no known owner refuses the tap, on both sides of the boundary. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OWNER = 777;
const NONCE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

describe('authority-bearing buttons fail closed', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;
  let calls: { method: string; body: Record<string, unknown> }[];
  const answerText = () => calls.find((c) => c.method === 'answerCallbackQuery')?.body.text;
  const tap = (from: number, data: string) => adapter.handleForwardedCallback({
    id: 'cbq', from: { id: from }, data, message: { message_id: 1, chat: { id: from } },
  } as never);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-closed-'));
    adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100999' }, tmpDir);
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: { body: string }) => {
      calls.push({ method: String(url).split('/').pop()!, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) } as unknown as Response;
    }));
  });

  afterEach(async () => {
    await adapter.stop();
    vi.unstubAllGlobals();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/callback-owner-fails-closed.test.ts' });
  });

  describe('tunnel consent', () => {
    it('refuses everyone when no owner is known', async () => {
      const handler = vi.fn(async () => 'should not run');
      adapter.setTunnelConsentHandler(handler);
      await tap(999, `tc:g:${NONCE}`);
      expect(handler).not.toHaveBeenCalled();
      expect(answerText()).toBe('Only the owner can approve this');
    });

    it('does not accept an inferred operator, because the prompt only ever goes to a configured owner', async () => {
      const handler = vi.fn(async () => 'should not run');
      adapter.setTunnelConsentHandler(handler);
      adapter.setCallbackApproverResolver(() => OWNER);
      await tap(OWNER, `tc:g:${NONCE}`);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('prompt gate', () => {
    it('refuses everyone when no owner is known', async () => {
      await tap(999, 'pg:anything');
      expect(answerText()).toContain("I can't confirm who my owner is");
    });

    it('refuses when the resolver throws', async () => {
      adapter.setCallbackApproverResolver(() => { throw new Error('store down'); });
      await tap(OWNER, 'pg:anything');
      expect(answerText()).toContain("I can't confirm who my owner is");
    });

    it('lets the verified operator past the owner check', async () => {
      adapter.setCallbackApproverResolver(() => OWNER);
      await tap(OWNER, 'pg:anything');
      expect(answerText()).not.toBe('Only the session owner can respond to prompts');
    });
  });

  describe('typed reply to a prompt', () => {
    const PROMPT_MESSAGE = 55;
    const reply = (from: number) => (adapter as unknown as {
      handlePendingPromptReply(topicId: number, msg: unknown): boolean;
    }).handlePendingPromptReply(9, {
      message_id: 2, from: { id: from }, text: 'yes', reply_to_message: { message_id: PROMPT_MESSAGE },
    });

    beforeEach(() => {
      (adapter as unknown as { pendingPromptReply: Map<number, unknown> }).pendingPromptReply.set(9, {
        prompt: { sessionName: 's', id: 'p' }, relayMessageId: PROMPT_MESSAGE, createdAt: Date.now(),
      });
    });

    it('is not taken as the answer when no owner is known', () => {
      expect(reply(999)).toBe(false);
    });

    it('is taken only from the verified operator', () => {
      adapter.setCallbackApproverResolver(() => OWNER);
      expect(reply(999)).toBe(false);
      expect(reply(OWNER)).toBe(true);
    });
  });

  describe('a configured owner id stored as text', () => {
    beforeEach(async () => {
      await adapter.stop();
      adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100999', ownerUserId: String(OWNER) as never }, tmpDir);
    });

    it('still lets the owner answer tunnel consent, and nobody else', async () => {
      const handler = vi.fn(async () => 'ok');
      adapter.setTunnelConsentHandler(handler);
      await tap(999, `tc:g:${NONCE}`);
      expect(handler).not.toHaveBeenCalled();
      await tap(OWNER, `tc:g:${NONCE}`);
      expect(handler).toHaveBeenCalledWith('grant', NONCE);
    });

    it('still lets the owner past the prompt check', async () => {
      await tap(OWNER, 'pg:anything');
      expect(answerText()).not.toBe('Only the session owner can respond to prompts');
    });
  });

  it('a blank configured owner falls back to the verified operator', async () => {
    await adapter.stop();
    adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100999', ownerUserId: '' as never }, tmpDir);
    adapter.setCallbackApproverResolver(() => OWNER);
    await tap(OWNER, 'pg:anything');
    expect(answerText()).not.toContain("I can't confirm who my owner is");
    expect(answerText()).not.toBe('Only the session owner can respond to prompts');
  });

  it('does not widen who gets owner messages', () => {
    adapter.setCallbackApproverResolver(() => OWNER);
    expect(adapter.getOwnerUserId()).toBeUndefined();
  });
});
