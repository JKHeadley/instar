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

    it('refuses a body it can neither parse nor recognise', async () => {
      const f = arm();
      await expect(telegramFetch(api('sendMessage'), { method: 'POST', body: '<<not a payload>>' }))
        .rejects.toThrow(TelegramEgressError);
      expect(f, 'an uncheckable body is a closed door, not an open one').not.toHaveBeenCalled();
    });

    // ── Review pass 36 finding 1: the door was ONE ENCODING WIDE ────────────────────────────────
    // Telegram accepts parameters in the query string, as form encoding, and as multipart. The first
    // version of this door examined only a non-empty JSON STRING body, so a reader-visible method
    // sent any other supported way reached the network with no check at all.

    it('checks parameters passed in the QUERY STRING', async () => {
      const f = arm();
      await expect(telegramFetch(`${api('sendMessage')}?chat_id=1&text=%E2%80%8B`, { method: 'POST' }))
        .rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f).not.toHaveBeenCalled();
    });

    it('checks a FORM-ENCODED body, which the Bot API accepts', async () => {
      const f = arm();
      await expect(telegramFetch(api('sendMessage'), { method: 'POST', body: 'chat_id=1&text=%E2%80%8B' }))
        .rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f).not.toHaveBeenCalled();
    });

    it('checks a URLSearchParams body', async () => {
      const f = arm();
      const body = new URLSearchParams({ chat_id: '1', text: '\u200b' });
      await expect(telegramFetch(api('sendMessage'), { method: 'POST', body }))
        .rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f).not.toHaveBeenCalled();
    });

    it('REFUSES a multipart body rather than forwarding it unchecked', async () => {
      // Reading a FormData/stream here would consume the one the caller is about to send, so it
      // cannot be checked. Telegram takes captions this way, so this is a real shape, not a
      // hypothetical — and an unreadable payload is a closed door.
      const f = arm();
      const fd = new FormData();
      fd.append('chat_id', '1');
      fd.append('text', '\u200b');
      await expect(telegramFetch(api('sendMessage'), { method: 'POST', body: fd }))
        .rejects.toThrow(TelegramEgressError);
      expect(f).not.toHaveBeenCalled();
    });

    // ── Review pass 36 findings 2 and 3 ────────────────────────────────────────────────────────

    it('checks a CASE-VARIANT method, which Telegram dispatches and the field map missed', async () => {
      const f = arm();
      await expect(telegramFetch(`https://api.telegram.org/bot${TOKEN}/sendmessage`, post({
        chat_id: 1, text: '\u200b',
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f).not.toHaveBeenCalled();
    });

    it('REFUSES an unclassified method instead of silently passing it', async () => {
      // The field map returns undefined for an unknown method and the visibility check returns
      // silently — which is right for a method KNOWN to carry no reader-visible field and wrong for
      // one nobody has classified. Only the door can tell those apart.
      const f = arm();
      await expect(telegramFetch(`https://api.telegram.org/bot${TOKEN}/sendSomethingNew`, post({
        chat_id: 1, text: 'hello',
      }))).rejects.toThrow(TelegramEgressError);
      expect(f, 'an unclassified method has an unknown content decision').not.toHaveBeenCalled();
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
