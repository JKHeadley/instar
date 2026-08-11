import { describe, it, expect, vi, afterEach } from 'vitest';
import { telegramFetch, methodFromTelegramUrl, TelegramEgressError } from '../../src/messaging/telegram-egress.js';
import { InvisiblePayloadRefusedError } from '../../src/messaging/invisible-payload.js';

const TOKEN = '123:AAErandomtokenvalue';
const api = (m: string) => `https://api.telegram.org/bot${TOKEN}/${m}`;
const post = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

let fetchMock: ReturnType<typeof vi.fn>;
const arm = () => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
afterEach(() => vi.unstubAllGlobals());

describe('telegram egress boundary — the single door', () => {
  describe('the method comes from the URL, not from a caller label', () => {
    it('reads the method Telegram itself dispatches on', () => {
      expect(methodFromTelegramUrl(api('sendMessage'))).toBe('sendMessage');
      expect(methodFromTelegramUrl(api('editMessageText'))).toBe('editMessageText');
    });

    it('does not claim a method for a non-Bot-API URL', () => {
      // The file-download host carries no body and no reader-visible field.
      expect(methodFromTelegramUrl(`https://api.telegram.org/file/bot${TOKEN}/photo.jpg`)).toBeNull();
      expect(methodFromTelegramUrl('http://127.0.0.1:4042/internal/telegram-forward')).toBeNull();
    });
  });

  describe('refusal', () => {
    it('refuses an invisible body and never reaches the network', async () => {
      const f = arm();
      await expect(telegramFetch(api('sendMessage'), post({ chat_id: 1, text: '​​' })))
        .rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f, 'a refused payload must not be sent').not.toHaveBeenCalled();
    });

    it('refuses a link whose label is invisible — the payload the earlier guards missed', async () => {
      const f = arm();
      await expect(telegramFetch(api('sendMessage'), post({
        chat_id: 1, text: '<a href="https://example.com/x">​</a>', parse_mode: 'HTML',
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f).not.toHaveBeenCalled();
    });

    it('refuses an invisible forum-topic name, which is a different field', async () => {
      const f = arm();
      await expect(telegramFetch(api('createForumTopic'), post({ chat_id: 1, name: 'ㅤ' })))
        .rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f).not.toHaveBeenCalled();
    });

    it('refuses a body that is not JSON rather than skipping the check', async () => {
      const f = arm();
      await expect(telegramFetch(api('sendMessage'), { method: 'POST', body: 'chat_id=1&text=hi' }))
        .rejects.toThrow(TelegramEgressError);
      expect(f, 'an uncheckable body is a closed door, not an open one').not.toHaveBeenCalled();
    });
  });

  describe('delivery — an over-refusal here destroys real messages, so pin the passing side hard', () => {
    it('sends ordinary text', async () => {
      const f = arm();
      await telegramFetch(api('sendMessage'), post({ chat_id: 1, text: 'hello' }));
      expect(f).toHaveBeenCalledTimes(1);
    });

    it('sends a genuine link with a genuine label', async () => {
      const f = arm();
      await telegramFetch(api('sendMessage'), post({
        chat_id: 1, text: '<a href="https://example.com/x">read this</a>', parse_mode: 'HTML',
      }));
      expect(f).toHaveBeenCalledTimes(1);
    });

    it('passes a bodyless request straight through', async () => {
      const f = arm();
      await telegramFetch(api('getUpdates') + '?timeout=0', { method: 'GET' });
      expect(f).toHaveBeenCalledTimes(1);
    });

    it('passes a method that carries no reader-visible field', async () => {
      const f = arm();
      await telegramFetch(api('deleteMessage'), post({ chat_id: 1, message_id: 9 }));
      expect(f).toHaveBeenCalledTimes(1);
    });

    it('passes a file download, which is not a Bot API method call', async () => {
      const f = arm();
      await telegramFetch(`https://api.telegram.org/file/bot${TOKEN}/photos/x.jpg`, { method: 'GET' });
      expect(f).toHaveBeenCalledTimes(1);
    });
  });

  it('forwards the caller init unchanged, so no sender loses its headers or signal', async () => {
    const f = arm();
    const ac = new AbortController();
    const init = { ...post({ chat_id: 1, text: 'hi' }), signal: ac.signal };
    await telegramFetch(api('sendMessage'), init);
    const [url, passed] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(api('sendMessage'));
    expect(passed.signal).toBe(ac.signal);
    expect((passed.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });
});
