import { describe, it, expect, vi, afterEach } from 'vitest';
import { telegramFetch, methodFromTelegramUrl, TelegramEgressError } from '../../src/messaging/telegram-egress.js';
import { InvisiblePayloadRefusedError, setInvisiblePayloadRefusalSink } from '../../src/messaging/invisible-payload.js';

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

    it('CHECKS a multipart body — it is iterable without being consumed', async () => {
      // Review pass 37 finding 5: this was refused wholesale on the premise that reading it would
      // consume the caller's body. False for FormData, which iterates freely — and refusing it
      // rejected legitimate multipart sends carrying visible text. Only a one-shot stream is
      // genuinely unreadable here.
      const f = arm();
      const fd = new FormData();
      fd.append('chat_id', '1');
      fd.append('text', '\u200b');
      await expect(telegramFetch(api('sendMessage'), { method: 'POST', body: fd }))
        .rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f).not.toHaveBeenCalled();
    });

    it('DELIVERS a multipart body carrying visible text', async () => {
      const f = arm();
      const fd = new FormData();
      fd.append('chat_id', '1');
      fd.append('text', 'hello');
      await telegramFetch(api('sendMessage'), { method: 'POST', body: fd });
      expect(f, 'a checkable multipart send must not be refused').toHaveBeenCalledTimes(1);
    });

    it('refuses a body it genuinely cannot read without consuming', async () => {
      const f = arm();
      const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
      await expect(telegramFetch(api('sendMessage'), { method: 'POST', body: stream as unknown as BodyInit }))
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

  describe('the request Telegram will actually dispatch (review pass 37)', () => {
    it('honours Telegram precedence: on a conflict the QUERY value is the one sent', async () => {
      // Telegram appends URL arguments before body arguments and its accessor returns the FIRST
      // match, so the query wins. The first version let the body overwrite the query, which meant it
      // inspected a visible value Telegram would never send while the invisible one went out.
      const f = arm();
      await expect(telegramFetch(`${api('sendMessage')}?text=%E2%80%8B`, post({ chat_id: 1, text: 'visible' })))
        .rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f, 'the value Telegram would send is invisible').not.toHaveBeenCalled();
    });

    it('takes the FIRST value of a repeated key, as Telegram does', async () => {
      // Found by self-audit against Telegram's documented accessor rather than by a reading. Iterating
      // URLSearchParams yields every occurrence, so assigning in loop order kept the LAST — and that
      // was wrong in BOTH directions at once: an invisible-then-visible pair was SENT while Telegram
      // would send the invisible value, and a visible-then-invisible pair was REFUSED while Telegram
      // would send the visible one. One bypass and one destroyed message from a single line.
      const f = arm();
      await expect(telegramFetch(`${api('sendMessage')}?chat_id=1&text=%E2%80%8B&text=visible`, { method: 'POST' }))
        .rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f, 'Telegram would send the FIRST value, which is invisible').not.toHaveBeenCalled();

      const f2 = arm();
      await telegramFetch(`${api('sendMessage')}?chat_id=1&text=visible&text=%E2%80%8B`, { method: 'POST' });
      expect(f2, 'Telegram would send the FIRST value, which is visible').toHaveBeenCalledTimes(1);
    });

    it('covers EVERY encoding for repeated keys, not just the one the last fix reached', async () => {
      // Pass 38 finding 1: the first-match repair covered query and form encoding and skipped JSON and
      // multipart, and the test asserted the general rule while exercising one encoding. Both now.
      const f = arm();
      const fd = new FormData();
      fd.append('chat_id', '1');
      fd.append('text', '\u200b');
      fd.append('text', 'visible');
      await expect(telegramFetch(api('sendMessage'), { method: 'POST', body: fd }))
        .rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f, 'multipart: Telegram sends the FIRST value, which is invisible').not.toHaveBeenCalled();

      // JSON duplicates are REFUSED rather than resolved: JSON.parse keeps the last, Telegram keeps the
      // first, and an ambiguous effective value is a closed door.
      const f2 = arm();
      await expect(telegramFetch(api('sendMessage'),
        { method: 'POST', body: '{"chat_id":1,"text":"\u200b","text":"visible"}' }))
        .rejects.toThrow(TelegramEgressError);
      expect(f2).not.toHaveBeenCalled();

      // and an ordinary JSON body is untouched by the scanner
      const f3 = arm();
      await telegramFetch(api('sendMessage'), post({ chat_id: 1, text: 'hello', parse_mode: 'HTML' }));
      expect(f3, 'no duplicate keys — must still deliver').toHaveBeenCalledTimes(1);
    });

    it('classifies the documented TEST-ENVIRONMENT path and a percent-encoded one', () => {
      // Pass 38 finding 2, wrong in both directions from one regex: a percent-encoded octet made this
      // return null while Telegram dispatched the decoded method, and Telegram's documented
      // `/bot<token>/test/<method>` form was classified as the method `test` and refused.
      expect(methodFromTelegramUrl(`https://api.telegram.org/bot${TOKEN}/test/sendMessage`)).toBe('sendMessage');
      expect(methodFromTelegramUrl(`https://api.telegram.org/bot${TOKEN}/send%4Dessage`)).toBe('sendMessage');
    });

    it('refuses a Request object, whose body cannot be inspected here', async () => {
      // The type said `string`; the runtime accepts more, and JavaScript callers are not bound by the
      // signature (pass 38 finding 3). A URL object is normalised and checked; a Request is refused.
      const f = arm();
      await expect(telegramFetch(
        new Request(api('sendMessage'), { method: 'POST', body: '{"text":"\u200b"}' }) as unknown as string,
      )).rejects.toThrow(TelegramEgressError);
      expect(f).not.toHaveBeenCalled();

      const f2 = arm();
      await expect(telegramFetch(new URL(api('sendMessage')), post({ chat_id: 1, text: '\u200b' })))
        .rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f2, 'a URL object is checked, not waved through').not.toHaveBeenCalled();
    });

    it('checks a request whose METHOD lives in a parameter, not the path', async () => {
      // Pass 39 F1: Telegram falls back to the first `method` argument when the path carries none, so a
      // request to the token root dispatched normally while the door returned null and skipped everything.
      const f = arm();
      await expect(telegramFetch(`https://api.telegram.org/bot${TOKEN}/?method=sendMessage&text=%E2%80%8B`,
        { method: 'POST' })).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f).not.toHaveBeenCalled();

      // and a root request whose method is nowhere is undecidable, not benign
      const f2 = arm();
      await expect(telegramFetch(`https://api.telegram.org/bot${TOKEN}/`, { method: 'POST' }))
        .rejects.toThrow(TelegramEgressError);
      expect(f2).not.toHaveBeenCalled();
    });

    it('checks a TEST-ENVIRONMENT root whose method is a parameter', async () => {
      // Pass 40 F1: the tests covered test-paths WITH a method and production roots WITH a parameter
      // method, never the intersection — which is exactly where the bypass lived. Telegram strips the
      // test segment and then resolves the method from a parameter as usual.
      const f = arm();
      await expect(telegramFetch(`https://api.telegram.org/bot${TOKEN}/test/?method=sendMessage&text=%E2%80%8B`,
        { method: 'POST' })).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f).not.toHaveBeenCalled();
    });

    it('sends the bytes it CHECKED, not whatever the caller mutates afterwards', async () => {
      // Pass 40 F2: the door read init.body, checked that value, then handed the caller's original
      // mutable object to fetch — so a getter could show visible content to the check and invisible
      // content to the network, falsifying this file's central claim.
      const f = arm();
      let reads = 0;
      const init: RequestInit = { method: 'POST' };
      Object.defineProperty(init, 'body', {
        configurable: true,
        get() { reads += 1; return reads === 1 ? JSON.stringify({ chat_id: 1, text: 'visible' }) : JSON.stringify({ chat_id: 1, text: '\u200b' }); },
      });
      await telegramFetch(api('sendMessage'), init);
      const sent = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
      expect(sent.text, 'the wire body must be the one that was inspected').toBe('visible');
    });

    it('freezes a MUTABLE body at capture, not just reads it once', async () => {
      // Pass 41: reading once was not enough. A string IS its bytes, but URLSearchParams and FormData are
      // captured by REFERENCE — so a caller mutating the same object after the check still changed what
      // went on the wire. The value inspected and the value sent must be the same immutable bytes.
      const f = arm();
      const body = new URLSearchParams({ chat_id: '1', text: 'visible' });
      const p = telegramFetch(api('sendMessage'), { method: 'POST', body });
      body.set('text', '\u200b');       // mutate the very object the caller handed us
      await p;
      const sent = new URLSearchParams((f.mock.calls[0][1] as { body: string }).body);
      expect(sent.get('text'), 'the wire body must be what was inspected').toBe('visible');
    });

    it('never re-reads the body — a second read cannot reach the wire', async () => {
      // Pass 42: the outgoing init was built by SPREADING the caller's object, which re-reads `body`.
      // When the captured value was undefined no override followed, so the second read's value went out.
      const f = arm();
      let reads = 0;
      const init: RequestInit = { method: 'POST' };
      Object.defineProperty(init, 'body', {
        configurable: true,
        get() { reads += 1; return reads === 1 ? undefined : JSON.stringify({ chat_id: 1, text: '\u200b' }); },
      });
      await telegramFetch(`${api('sendMessage')}?chat_id=1&text=hello`, init);
      const sentBody = (f.mock.calls[0][1] as { body: unknown }).body;
      expect(sentBody, 'a later read must not become the wire body').toBeNull();
    });

    it('checks EVERY reader-visible field, not just the first', async () => {
      // Pass 43: editMessageText also accepts `rich_message`. Checking only `text` meant an edit whose
      // content arrived in the other field returned silently and was sent unexamined.
      const f = arm();
      await expect(telegramFetch(api('editMessageText'),
        post({ chat_id: 1, message_id: 9, rich_message: '\u200b' })))
        .rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f).not.toHaveBeenCalled();

      // and the dedicated rich-message methods are classified, not refused as unknown
      const f2 = arm();
      await telegramFetch(api('sendRichMessage'), post({ chat_id: 1, rich_message: 'hello' }));
      expect(f2, 'a legitimate rich-message send must deliver').toHaveBeenCalledTimes(1);
    });

    it('inspects STRUCTURED rich content at its leaves, not as a string', async () => {
      // Pass 44: rich_message is an InputRichMessage object whose content sits under html, markdown, or
      // an array of blocks. Pass 43 named the field correctly and then checked it with a string test,
      // which returns early for an object — so the table listed it and nothing ever looked inside.
      const f = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [{ type: 'paragraph', text: '\u200b' }, { type: 'footer', text: '\u200b' }] },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f, 'every leaf is invisible — the reader receives nothing').not.toHaveBeenCalled();

      // one visible leaf is enough to deliver
      const f2 = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [{ type: 'paragraph', text: '\u200b' }, { type: 'paragraph', text: 'hello' }] },
      }));
      expect(f2).toHaveBeenCalledTimes(1);

      // and the html/markdown carriers
      const f3 = arm();
      await expect(telegramFetch(api('editMessageText'), post({
        chat_id: 1, message_id: 9, rich_message: { html: '<b>\u200b</b>' },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f3).not.toHaveBeenCalled();
    });

    it('treats a trailing DNS root dot as the same host', async () => {
      // Pass 39 F2: `new URL()` preserves the terminal dot, so an exact compare rejected an equivalent
      // hostname — the request reached Telegram and the door returned null.
      expect(methodFromTelegramUrl(`https://api.telegram.org./bot${TOKEN}/sendMessage`)).toBe('sendMessage');
      const f = arm();
      await expect(telegramFetch(`https://api.telegram.org./bot${TOKEN}/sendMessage`,
        post({ chat_id: 1, text: '\u200b' }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f).not.toHaveBeenCalled();
    });

    it('detects a duplicate key written with an ESCAPED spelling', async () => {
      // Pass 39 F3: the scanner compared raw source characters, so `text` and `\u0074ext` — the same key
      // to JSON.parse and to Telegram — read as distinct and the duplicate went undetected.
      const f = arm();
      await expect(telegramFetch(api('sendMessage'),
        { method: 'POST', body: '{"chat_id":1,"text":"\u200b","\\u0074ext":"visible"}' }))
        .rejects.toThrow(TelegramEgressError);
      expect(f).not.toHaveBeenCalled();
    });

    it('ignores the URL FRAGMENT, which never goes on the wire', async () => {
      // `fetch` strips the fragment. Counting it as payload let visible fragment text mask an
      // invisible query value.
      const f = arm();
      await expect(telegramFetch(`${api('sendMessage')}?chat_id=1&text=%E2%80%8B#looks-visible`, { method: 'POST' }))
        .rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f).not.toHaveBeenCalled();
    });

    it('recognises URL spellings that fetch normalises before dispatch', () => {
      // A regex anchored to the literal host missed these; Telegram received them and the door
      // skipped every check.
      expect(methodFromTelegramUrl(`https://api.telegram.org:443/bot${TOKEN}/sendMessage`)).toBe('sendMessage');
      expect(methodFromTelegramUrl(`  https://API.Telegram.ORG/bot${TOKEN}/sendMessage  `)).toBe('sendMessage');
      expect(methodFromTelegramUrl(`https://api.telegram.org/bot${TOKEN}/sendMessage?x=1#f`)).toBe('sendMessage');
      // and still refuses to claim a method for something else entirely
      expect(methodFromTelegramUrl('https://api.telegram.org.evil.invalid/bot9/sendMessage')).toBeNull();
    });

    it('records the door\'s OWN refusals in the decision stream', async () => {
      // Pass 37 finding 6: "I do not understand this request" was the one refusal class invisible to
      // the stream, while the tests and spec both claimed every refusal is recorded.
      arm();
      const seen: Array<{ rule: string }> = [];
      const prev = setInvisiblePayloadRefusalSink((d) => seen.push(d as { rule: string }));
      await expect(telegramFetch(`https://api.telegram.org/bot${TOKEN}/sendBrandNewThing`, post({ text: 'hi' })))
        .rejects.toThrow(TelegramEgressError);
      await expect(telegramFetch(api('sendMessage'), { method: 'POST', body: '<<unparseable>>' }))
        .rejects.toThrow(TelegramEgressError);
      // and the Request-object refusal, which sat upstream of both emit sites and produced nothing
      await expect(telegramFetch(new Request(api('sendMessage')) as unknown as string))
        .rejects.toThrow(TelegramEgressError);
      setInvisiblePayloadRefusalSink(prev);
      expect(seen.map((d) => d.rule))
        .toEqual(['unclassified-method', 'unreadable-request', 'unreadable-request']);
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
