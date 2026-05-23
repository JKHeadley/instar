/**
 * Unit tests for the Telegram consent wire-up (PR 6 of the
 * tunnel-failure-resilience chain).
 *
 * Spec: specs/dev-failure-resilience.md Part 3 (consent UX).
 *
 * Covers the integration seam between TunnelManager's consent state
 * machine (PR 5) and the Telegram inline-button UX:
 *   - attachTelegram registers a tunnel-consent handler with the
 *     adapter and (when an adapter capable of sendOwnerConsentPrompt
 *     is present) routes the consent prompt through the button path.
 *   - On Tier-1 exhaustion → awaiting-consent, the manager calls
 *     adapter.sendOwnerConsentPrompt(text, nonce) with the live nonce.
 *   - The registered handler, invoked with ('grant', nonce), drives
 *     grantConsent → relay-active. With ('decline', nonce) → exhausted.
 *   - The consent prompt is suppressed from the notifier's owner-DM
 *     path (no double send).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { TunnelManager, type TunnelMessagingAdapter } from '../../src/tunnel/TunnelManager.js';
import type {
  TunnelProvider,
  TunnelProviderHandle,
  ProviderName,
  ProviderTier,
} from '../../src/tunnel/TunnelProvider.js';

function tmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-consent-tg-'));
}

function mockProvider(opts: { name: ProviderName; tier?: ProviderTier; available?: boolean; startResult?: 'success' | { error: string }; url?: string }): TunnelProvider {
  return {
    name: opts.name,
    tier: opts.tier ?? 1,
    isAvailable: vi.fn(async () => opts.available !== false),
    start: vi.fn(async (): Promise<TunnelProviderHandle> => {
      if (opts.startResult && typeof opts.startResult === 'object') throw new Error(opts.startResult.error);
      return { url: opts.url ?? `https://${opts.name}.example`, stop: async () => undefined };
    }),
  };
}

/** Mock adapter that captures the consent prompt + the registered handler. */
function mockAdapter() {
  let consentHandler: ((action: 'grant' | 'decline', nonce: string) => Promise<string>) | null = null;
  const consentPrompts: { text: string; nonce: string }[] = [];
  const ownerDms: string[] = [];
  const groupMsgs: { topicId: number; text: string }[] = [];
  const adapter: TunnelMessagingAdapter = {
    sendToTopic: vi.fn(async (topicId: number, text: string) => { groupMsgs.push({ topicId, text }); }),
    sendToOwnerDM: vi.fn(async (text: string) => { ownerDms.push(text); }),
    getDashboardTopicId: () => 42,
    getLifelineTopicId: () => 43,
    sendOwnerConsentPrompt: vi.fn(async (text: string, nonce: string) => {
      consentPrompts.push({ text, nonce });
      return 1001;
    }),
    setTunnelConsentHandler: (fn) => { consentHandler = fn; },
  };
  return {
    adapter,
    consentPrompts,
    ownerDms,
    groupMsgs,
    invoke: (action: 'grant' | 'decline', nonce: string) => {
      if (!consentHandler) throw new Error('handler not registered');
      return consentHandler(action, nonce);
    },
    hasHandler: () => consentHandler !== null,
  };
}

const okFetch = vi.fn(async () => new Response('ok', { status: 200 }));
const baseConfig = { enabled: true, type: 'quick' as const, port: 4040, stateDir: '' };

let stateDir: string;
beforeEach(() => { stateDir = tmpStateDir(); });
afterEach(() => {
  try {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/tunnel-consent-telegram.test.ts:cleanup' });
  } catch { /* ignore */ }
});

describe('TunnelManager + Telegram consent wire-up', () => {
  it('attachTelegram registers a tunnel-consent handler with the adapter', () => {
    const m = mockAdapter();
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [mockProvider({ name: 'cloudflare-quick', url: 'https://q.example' })], fetch: okFetch },
    );
    mgr.attachTelegram(m.adapter, () => '123456');
    expect(m.hasHandler()).toBe(true);
  });

  it('sends the button-bearing consent prompt with the live nonce on awaiting-consent', async () => {
    const m = mockAdapter();
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited: 1015' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true, url: 'https://relay.loca.lt' });
    const mgr = new TunnelManager({ ...baseConfig, stateDir }, { providers: [tier1, tier2], fetch: okFetch });
    mgr.attachTelegram(m.adapter, () => '123456');

    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    expect(m.consentPrompts.length).toBe(1);
    const pc = mgr.pendingConsent;
    expect(pc).not.toBeNull();
    expect(m.consentPrompts[0]!.nonce).toBe(pc!.nonce);
    // The prompt text is honest about third-party exposure + rotation.
    expect(m.consentPrompts[0]!.text).toMatch(/third-party relay/);
    expect(m.consentPrompts[0]!.text).toMatch(/rotate your PIN/);
  });

  it('does NOT double-send the consent prompt via the owner-DM text path', async () => {
    const m = mockAdapter();
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true });
    const mgr = new TunnelManager({ ...baseConfig, stateDir }, { providers: [tier1, tier2], fetch: okFetch });
    mgr.attachTelegram(m.adapter, () => '123456');

    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    // The button prompt went out once; the plain-text owner DM (the
    // notifier's consent message) was suppressed.
    expect(m.consentPrompts.length).toBe(1);
    const consentTextDms = m.ownerDms.filter((d) => d.includes('third-party relay'));
    expect(consentTextDms.length).toBe(0);
  });

  it('the registered handler grants consent → relay-active', async () => {
    const m = mockAdapter();
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true, url: 'https://relay.loca.lt' });
    const mgr = new TunnelManager({ ...baseConfig, stateDir }, { providers: [tier1, tier2], fetch: okFetch });
    mgr.attachTelegram(m.adapter, () => '123456');
    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    const nonce = mgr.pendingConsent!.nonce;
    const status = await m.invoke('grant', nonce);
    expect(status).toMatch(/approved/i);
    expect(mgr.lifecycleState.lastState).toBe('relay-active');
    expect(mgr.url).toBe('https://relay.loca.lt');
  });

  it('the registered handler declines consent → exhausted', async () => {
    const m = mockAdapter();
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true });
    const mgr = new TunnelManager({ ...baseConfig, stateDir }, { providers: [tier1, tier2], fetch: okFetch });
    mgr.attachTelegram(m.adapter, () => '123456');
    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    const nonce = mgr.pendingConsent!.nonce;
    const status = await m.invoke('decline', nonce);
    expect(status).toMatch(/cloudflare/i);
    expect(mgr.lifecycleState.lastState).toBe('exhausted');
    expect(mgr.lifecycleState.consentCooldown.consecutiveRefusals).toBe(1);
  });

  it('the handler reports "no longer active" for a stale nonce', async () => {
    const m = mockAdapter();
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true, url: 'https://relay.loca.lt' });
    const mgr = new TunnelManager({ ...baseConfig, stateDir }, { providers: [tier1, tier2], fetch: okFetch });
    mgr.attachTelegram(m.adapter, () => '123456');
    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    const status = await m.invoke('grant', 'ffffffffffffffffffffffffffffffff');
    expect(status).toMatch(/no longer active/i);
    expect(mgr.lifecycleState.lastState).toBe('awaiting-consent'); // unchanged
  });
});

/**
 * Adapter-side coverage of the security-load-bearing callback path in
 * TelegramAdapter.processCallbackQuery (reached in production via the
 * poll loop AND via handleForwardedCallback when the Lifeline forwards
 * callbacks in send-only mode — which is exactly the tunnel-down case).
 *
 * The GPT external review's CRITICAL finding: only the OWNER principal
 * may approve routing private traffic through a third-party relay. These
 * tests cover both sides of that boundary plus malformed callback_data.
 */
describe('TelegramAdapter tunnel-consent callback (owner-principal gate)', () => {
  const OWNER = 777;
  const NONCE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 32 hex
  let adapter: TelegramAdapter;
  let tmpDir: string;
  let calls: { method: string; body: Record<string, unknown> }[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-consent-cbq-'));
    adapter = new TelegramAdapter(
      { token: 'test-token', chatId: '-100999', ownerUserId: OWNER },
      tmpDir,
    );
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: { body: string }) => {
      calls.push({ method: String(url).split('/').pop()!, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) } as unknown as Response;
    }));
  });

  afterEach(async () => {
    await adapter.stop();
    vi.unstubAllGlobals();
    try {
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/tunnel-consent-telegram.test.ts:cbq-cleanup' });
    } catch { /* ignore */ }
  });

  const answerText = () => calls.find((c) => c.method === 'answerCallbackQuery')?.body.text;
  const editCall = () => calls.find((c) => c.method === 'editMessageText');

  it('owner grant click → handler invoked with (grant, nonce), keyboard cleared in the OWNER DM chat', async () => {
    const handler = vi.fn(async () => 'Backup approved — bringing it up now');
    adapter.setTunnelConsentHandler(handler);

    await adapter.handleForwardedCallback({
      id: 'cbq-1', from: { id: OWNER }, data: `tc:g:${NONCE}`, message: { message_id: 555, chat: { id: OWNER } },
    });

    expect(handler).toHaveBeenCalledWith('grant', NONCE);
    expect(answerText()).toBe('Backup approved — bringing it up now');
    expect(editCall()?.body.text).toBe('✅ Backup approved.');
    // The edit must target the owner's private chat (where the buttons
    // live), NOT config.chatId (the group). Regression guard for the
    // hardcoded-chat_id bug.
    expect(editCall()?.body.chat_id).toBe(OWNER);
  });

  it('owner decline click → handler invoked with (decline, nonce)', async () => {
    const handler = vi.fn(async () => 'Okay — staying on Cloudflare');
    adapter.setTunnelConsentHandler(handler);

    await adapter.handleForwardedCallback({
      id: 'cbq-2', from: { id: OWNER }, data: `tc:d:${NONCE}`, message: { message_id: 556, chat: { id: OWNER } },
    });

    expect(handler).toHaveBeenCalledWith('decline', NONCE);
    expect(editCall()?.body.text).toBe('❌ Backup declined.');
  });

  it('NON-owner click → handler NOT invoked, callback preserved for the real owner', async () => {
    const handler = vi.fn(async () => 'should not run');
    adapter.setTunnelConsentHandler(handler);

    await adapter.handleForwardedCallback({
      id: 'cbq-3', from: { id: 999 }, data: `tc:g:${NONCE}`, message: { message_id: 557, chat: { id: OWNER } },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(answerText()).toBe('Only the owner can approve this');
    // The button is NOT consumed (no keyboard edit) — the real owner can still tap it.
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(false);
  });

  it('malformed tc: callback_data → rejected without invoking the handler', async () => {
    const handler = vi.fn(async () => 'should not run');
    adapter.setTunnelConsentHandler(handler);

    await adapter.handleForwardedCallback({
      id: 'cbq-4', from: { id: OWNER }, data: 'tc:x:not-a-valid-nonce', message: { message_id: 558 },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(answerText()).toBe('Invalid consent button');
  });
});
