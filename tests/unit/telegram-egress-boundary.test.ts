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

    it('walks the REAL RichText grammar — the WIRE discriminators, not internal class names', async () => {
      // Pass 47 finding 4: the previous version of this test used `richTexts`, `richTextBold`,
      // `richTextPlain` and block type `math`. Those are internal class names that never appear on the
      // wire — Telegram's parser rejects every one of them — so the test proved only that a key-blind
      // walk finds nested strings, while its title claimed it exercised the grammar. The values below are
      // transcribed from the server's own request parser: a SEQUENCE is a bare array (there is no `texts`
      // key anywhere in the API), a literal is a bare string, and the wrappers are `bold`, `italic`,
      // `url`, `mathematical_expression`.
      const f = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: {
          blocks: [
            { type: 'paragraph', text: [
              { type: 'bold', text: { type: 'italic', text: '\u200b' } },
              { type: 'url', url: 'https://example.com/VISIBLE-IN-URL-ONLY', text: '\u200b' },
            ] },
            // an anchor's name is a jump TARGET, not rendered text (pass 46) — it must NOT count
            { type: 'anchor', name: 'VISIBLE-LOOKING-TARGET' },
          ],
        },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f, 'a URL destination is not what a reader sees — the label is').not.toHaveBeenCalled();

      // one visible literal three wrappers deep is enough to deliver
      const f2 = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [{ type: 'paragraph', text: [
          { type: 'bold', text: '\u200b' },
          { type: 'italic', text: { type: 'underline', text: 'hello' } },
        ] }] },
      }));
      expect(f2).toHaveBeenCalledTimes(1);

      // a media-only rich message legitimately carries no text and must NOT be refused
      const f3 = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [{ type: 'photo', photo: { file_id: 'abc' } }, { type: 'divider' }] },
      }));
      expect(f3, 'a photo-only rich message is valid and text-free').toHaveBeenCalledTimes(1);

      // block carriers the inline layer does not have: a details summary, and table cells
      const f4 = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [
          { type: 'details', summary: '\u200b', blocks: [{ type: 'paragraph', text: '\u200b' }] },
          { type: 'table', caption: '\u200b', cells: [[{ text: '\u200b' }, { text: '\u200b' }]] },
        ] },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f4).not.toHaveBeenCalled();

      // ...and the same shape delivers the moment one cell renders
      const f5 = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [
          { type: 'table', caption: '\u200b', cells: [[{ text: '\u200b' }, { text: 'total' }]] },
        ] },
      }));
      expect(f5).toHaveBeenCalledTimes(1);
    });

    it('honours the METHOD\'s field precedence — a lower field cannot waive an unreadable body', async () => {
      // The third instance today of one shape: alternatives that are really a PRIORITY union. Telegram's
      // editMessageText handler branches on whether `rich_message` is PRESENT and only otherwise reads
      // `text`. So a visible `?text=` beside an unreadable body waived the refusal while the body was
      // free to carry the rich_message that actually got sent.
      const f = arm();
      await expect(telegramFetch(api('editMessageText') + '?chat_id=1&message_id=9&text=LOOKS%20VISIBLE', {
        method: 'POST',
        body: new ReadableStream(),
      })).rejects.toThrow(TelegramEgressError);
      expect(f, 'text is outranked by rich_message — it cannot vouch for an unreadable body').not.toHaveBeenCalled();

      // The HIGHEST-precedence field still waives, because nothing a body carries can outrank it.
      const f2 = arm();
      await telegramFetch(
        api('editMessageText') + '?chat_id=1&message_id=9&rich_message=' + encodeURIComponent(JSON.stringify({ markdown: 'hello' })),
        { method: 'POST', body: new ReadableStream() },
      );
      expect(f2, 'rich_message is what the method reads — checked, and it wins').toHaveBeenCalledTimes(1);
    });

    it('judges the ONE field the method will read — not every field present', async () => {
      // The over-refusal that sat beside the under-refusal above. An edit carrying a visible rich_message
      // beside a leftover invisible `text` was refused for content Telegram discards.
      const f = arm();
      await telegramFetch(api('editMessageText'), post({
        chat_id: 1, message_id: 9,
        rich_message: { blocks: [{ type: 'paragraph', text: 'the real content' }] },
        text: '\u200b',
      }));
      expect(f, 'rich_message is read; the leftover text is discarded').toHaveBeenCalledTimes(1);

      // ...and the same shape refuses when the field that WINS is the invisible one.
      const f2 = arm();
      await expect(telegramFetch(api('editMessageText'), post({
        chat_id: 1, message_id: 9,
        rich_message: { blocks: [{ type: 'paragraph', text: '\u200b' }] },
        text: 'VISIBLE BUT NEVER READ',
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f2).not.toHaveBeenCalled();
    });

    it('reads the body EXACTLY ONCE — the claim the file makes about itself', async () => {
      // The door's own comment said it stopped spreading `init` because spreading re-reads `body`.
      // It still spread. The outcome was safe — the spread's value was overwritten by the captured one
      // — so every test of the SENT bytes passed either way, which is precisely why no reading caught
      // it and why this test counts reads instead of contents.
      const f = arm();
      let reads = 0;
      const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' } };
      Object.defineProperty(init, 'body', {
        enumerable: true,
        get() { reads += 1; return JSON.stringify({ chat_id: 1, text: 'visible' }); },
      });
      await telegramFetch(api('sendMessage'), init);
      expect(f).toHaveBeenCalledTimes(1);
      expect(reads, 'a getter with side effects must not run twice').toBe(1);
    });

    it('reads only the fields the discriminator declares — a discarded member cannot vouch', async () => {
      // Pass 47 finding 2. Telegram reads `type`, extracts that variant's declared fields, and DISCARDS
      // every other member of the object. The previous walk descended every object-valued property, so a
      // member the server throws away could make an invisible payload look visible.
      const f = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [{ type: 'paragraph', text: {
          type: 'bold',
          text: '\u200b',
          // `bold` consumes `text` alone. Everything below is discarded by the server.
          caption: { text: 'LOOKS VISIBLE BUT IS DISCARDED' },
          summary: 'ALSO DISCARDED',
        } }] },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f, 'a member the server discards must not license a send').not.toHaveBeenCalled();

      // Same at block level: `paragraph` consumes `text`, so a stray sibling cannot vouch either.
      const f2 = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [{ type: 'paragraph', text: '\u200b', credit: 'DISCARDED ON A PARAGRAPH' }] },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f2).not.toHaveBeenCalled();

      // ...but a field the variant DOES declare still counts: `pullquote` reads text AND credit.
      const f3 = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [{ type: 'pullquote', text: '\u200b', credit: 'a real credit line' }] },
      }));
      expect(f3, 'pullquote declares credit — it renders').toHaveBeenCalledTimes(1);
    });

    it('does not let a LaTeX source vouch in the markdown or html arms either', async () => {
      // Pass 48 finding 1. The OPAQUE treatment for formulas reached only the explicit block variant, so
      // the SAME formula written in markdown or html still had its raw source counted as visible. One
      // repair, one of three representations — the sweep failure this window has now recorded four times.
      // Syntax from the live reference: markdown `$inline$`, `$$block$$`, a ```math fence; html <tg-math>.
      const f = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1, rich_message: { markdown: '\u200b $\\hspace{1cm}$' },
      }));
      expect(f, 'a formula renders — this is not PROVEN invisible').toHaveBeenCalledTimes(1);

      // The direction that matters: strip the formula and the rest must still be judged on its own.
      const f2 = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1, rich_message: { markdown: '\u200b\u200b' },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f2).not.toHaveBeenCalled();

      // ...and the html arm carries the same grammar under a different tag.
      const f3 = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1, rich_message: { html: '<b>\u200b</b><tg-math>x^2</tg-math>' },
      }));
      expect(f3).toHaveBeenCalledTimes(1);

      // A formula written out of NOTHING is not an undecidable formula — it is the original incident
      // wearing one. Removing formula regions without this line would have ALLOWED a payload the
      // previous code refused; the negative control for this repair is what caught it.
      const f4 = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1, rich_message: { html: '<tg-math>\u200b</tg-math>' },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f4, 'an invisible body inside a formula tag renders nothing').not.toHaveBeenCalled();

      const f5 = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1, rich_message: { markdown: '$\u200b$' },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f5).not.toHaveBeenCalled();

      // Pass 49 finding 2: the empty-body test above reached the markdown and html arms and NOT the
      // explicit structured discriminators, so the identical formula written as a block or an inline
      // wrapper was allowed while the markdown spelling was refused. All three now share one function.
      // The fix stops the formula VOUCHING, which is what finding 2 named. It does NOT refuse a
      // structure whose only content is that formula: an empty-bodied formula yields no leaves at all,
      // and the no-leaf rule allows. That is the separate stated-open item — this walk cannot yet tell
      // "understood, and renders nothing" apart from "not understood", and both return the same state.
      // Asserted as it ACTUALLY behaves, because a test written to the behaviour I wish it had would be
      // a red test I would then be tempted to satisfy by weakening something real.
      const f6 = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1, rich_message: { blocks: [{ type: 'mathematical_expression', expression: '\u200b' }] },
      }));
      expect(f6, 'formula-only: no leaves, so the no-leaf rule allows — the residual, pinned honestly')
        .toHaveBeenCalledTimes(1);

      const f7 = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [{ type: 'paragraph', text: [
          { type: 'bold', text: '\u200b' },
          { type: 'mathematical_expression', expression: '' },
        ] }] },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f7, 'an inline formula with an empty body cannot vouch either').not.toHaveBeenCalled();

      // ...and a real formula in either structured position still delivers.
      const f8 = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [
          { type: 'paragraph', text: '\u200b' },
          { type: 'mathematical_expression', expression: 'E = mc^2' },
        ] },
      }));
      expect(f8).toHaveBeenCalledTimes(1);
    });

    it('requires the SOURCE to reference a media entry — a declaration does not vouch', async () => {
      // Pass 48 finding 2, and it was mine from one increment earlier: treating any non-empty `media`
      // array as proof recreated the discarded-member-vouching defect one layer ABOVE the discriminator
      // table, in the very change that closed it below. The API defines the array as media SPECIFIED IN
      // the source using tg://photo?id= / tg://video?id= / tg://audio?id= links.
      const f = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { markdown: '\u200b', media: [{ id: 'never-referenced', media: { type: 'photo' } }] },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f, 'an unreferenced declaration renders nothing').not.toHaveBeenCalled();

      // A referenced entry DOES render, and must not be refused.
      const f2 = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: {
          markdown: '![](tg://photo?id=pic1)\u200b',
          media: [{ id: 'pic1', media: { type: 'photo' } }],
        },
      }));
      expect(f2, 'the photo the source references is the content').toHaveBeenCalledTimes(1);

      // Pass 50: the reference must sit in an EMBEDDING position, not merely appear in the source.
      //
      // My first test for this asserted the wrong thing — a bare `tg://photo?id=x` sitting in ordinary
      // text IS visible, because the URL's own characters render. Probing the matcher directly rather
      // than trusting my mental model gave the real cases: positions where the id appears and NOTHING
      // renders. An HTML comment, and an attribute that embeds nothing.
      const fComment = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: {
          html: '<!-- tg://photo?id=pic1 --><b>\u200b</b>',
          media: [{ id: 'pic1', media: { type: 'photo' } }],
        },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(fComment, 'an id in a comment embeds nothing').not.toHaveBeenCalled();

      const fAttr = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: {
          html: '<a title="tg://photo?id=pic1">\u200b</a>',
          media: [{ id: 'pic1', media: { type: 'photo' } }],
        },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(fAttr, 'only src embeds — a title attribute renders no photo').not.toHaveBeenCalled();

      // ...and the genuinely embedded form still delivers.
      const fHtml = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: {
          html: '<img src="tg://photo?id=pic1"/><b>\u200b</b>',
          media: [{ id: 'pic1', media: { type: 'photo' } }],
        },
      }));
      expect(fHtml, 'an embedded photo renders').toHaveBeenCalledTimes(1);

      // A reference to an id that was never declared is not a rendered photo either.
      const f3 = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { markdown: '![](tg://photo?id=ghost)\u200b', media: [{ id: 'pic1', media: {} }] },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f3).not.toHaveBeenCalled();
    });

    it('strips HTML inside rich MARKDOWN — tag bytes are markup, not content', async () => {
      // Pass 51 finding 1. Rich Markdown may carry arbitrary HTML and Telegram parses those tags as
      // Rich HTML, so a tag name or attribute is markup here exactly as in the html arm. Counting those
      // bytes as content let a markdown source whose only rendered text is invisible pass as visible.
      const f = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1, rich_message: { markdown: '<b>\u200b</b>' },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f, 'the tag name is markup — the reader sees the label').not.toHaveBeenCalled();

      // ...and an attribute cannot vouch either.
      const f2 = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1, rich_message: { markdown: '<a href="https://example.com/VISIBLE">\u200b</a>' },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f2).not.toHaveBeenCalled();

      // Real text beside the markup still delivers.
      const f3 = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1, rich_message: { markdown: '<b>hello</b>' },
      }));
      expect(f3).toHaveBeenCalledTimes(1);
    });

    it('strips a tag whose quoted attribute contains a > byte', async () => {
      // Pass 52 finding 1, in its own words: the regex is not a tokenizer. `/<[^>]*>/g` stopped at the
      // first `>` even inside a quoted attribute, so the rest of the attribute source stayed in the leaf
      // and counted as visible — while Telegram parses the whole quoted attribute as markup.
      const f = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1, rich_message: { html: '<a title="a > b VISIBLE">\u200b</a>' },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f, 'attribute source is markup, however many angle brackets it holds').not.toHaveBeenCalled();

      // The same in the markdown arm, which shares the reduction.
      const f2 = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1, rich_message: { markdown: '<b data="x > y LOOKS VISIBLE">\u200b</b>' },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f2).not.toHaveBeenCalled();

      // Real text outside the tag still delivers — the scanner must not eat content.
      const f3 = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1, rich_message: { html: '<a title="a > b">hello</a>' },
      }));
      expect(f3, 'the label is content; only the tag is markup').toHaveBeenCalledTimes(1);
    });

    it('recognises video and audio media, not only images', async () => {
      // Pass 52 recorded this as an OVER-refusal and deliberately did not count it, because it destroys
      // visible sends rather than leaking invisible ones. I introduced it in this window, in the exact
      // failure direction I had just written that this class fails in.
      for (const tag of ['video', 'audio', 'img'] as const) {
        const f = arm();
        await telegramFetch(api('sendRichMessage'), post({
          chat_id: 1, rich_message: { html: `<${tag} src="https://example.com/m"/>\u200b` },
        }));
        expect(f, `${tag} is media — a ${tag}-only rich message is a real message`).toHaveBeenCalledTimes(1);
      }
    });

    it('matches a declared media id EXACTLY, not as a prefix', async () => {
      // Pass 51 finding 2. `id=<declared>[^)]*` is a PREFIX match, so a declared `pic1` vouched for a
      // reference to `pic1EXTRA` — a different, undeclared media that renders nothing.
      const f = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: {
          markdown: '![](tg://photo?id=pic1EXTRA)\u200b',
          media: [{ id: 'pic1', media: { type: 'photo' } }],
        },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f, 'a longer id is a different reference').not.toHaveBeenCalled();

      // The exact id still counts, including when other parameters follow it.
      const f2 = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: {
          markdown: '![](tg://photo?id=pic1&size=large)\u200b',
          media: [{ id: 'pic1', media: { type: 'photo' } }],
        },
      }));
      expect(f2, 'an exact id followed by another parameter still renders').toHaveBeenCalledTimes(1);
    });

    it('takes the container arm Telegram takes — blocks, ELSE markdown, ELSE html', async () => {
      // Found by reading the parser rather than handed over by a reading. The container is a PRIORITY
      // union: if `blocks` is present the other arms are never read. The previous walk collected all
      // three, so invisible blocks beside a visible html sibling read as visible here and rendered as
      // nothing there.
      const f = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: {
          blocks: [{ type: 'paragraph', text: '\u200b' }],
          html: '<b>THIS ARM IS NEVER READ</b>',
          markdown: '**NOR THIS ONE**',
        },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f, 'blocks wins — the html sibling is not what the reader gets').not.toHaveBeenCalled();

      // markdown outranks html for the same reason
      const f2 = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { markdown: '\u200b', html: '<b>NEVER READ</b>' },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f2).not.toHaveBeenCalled();
    });

    it('does not let an unreadable rendering vouch for an invisible message — or destroy a real one', async () => {
      // Pass 47 finding 3. A mathematical expression is LaTeX SOURCE; its source characters are not its
      // rendered glyphs, so counting them as visible let a spacing-only formula license a send. It is now
      // OPAQUE: it cannot prove visibility, and it cannot be proven invisible either.
      const f = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [
          { type: 'paragraph', text: '\u200b' },
          { type: 'mathematical_expression', expression: 'E = mc^2' },
        ] },
      }));
      expect(f, 'a formula renders — this message is not proven invisible').toHaveBeenCalledTimes(1);

      // The direction that matters: the formula no longer VOUCHES on the strength of its source. With no
      // unreadable content present, the same invisible paragraph is still refused.
      const f2 = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1, rich_message: { blocks: [{ type: 'paragraph', text: '\u200b' }] },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f2).not.toHaveBeenCalled();

      // A photo beside an invisible caption is a valid message and must survive — the case the old
      // all-or-nothing leaf rule destroyed.
      const f3 = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [{ type: 'photo', photo: { file_id: 'abc' }, caption: { text: '\u200b' } }] },
      }));
      expect(f3, 'the photo is the content; the caption is not the message').toHaveBeenCalledTimes(1);
    });

    it('walks the RichText UNION — a bare string in an array is still content', async () => {
      // The authoritative type definitions say RichText is a union: a bare STRING, an ARRAY of RichText,
      // or a wrapper interface. The bare-string arm is what a key-based walk loses — an array element
      // sits under no key at all, so every earlier version returned early on it.
      const f = arm();
      await telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [{ type: 'paragraph', text: ['hello', { type: 'bold', text: '\u200b' }] }] },
      }));
      expect(f, 'a bare string in the array IS the content').toHaveBeenCalledTimes(1);

      // and the all-invisible version of the same shape must still refuse
      const f2 = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1,
        rich_message: { blocks: [{ type: 'paragraph', text: ['\u200b', { type: 'bold', text: '\u200b' }] }] },
      }))).rejects.toThrow(InvisiblePayloadRefusedError);
      expect(f2).not.toHaveBeenCalled();

      // `summary` on a details block is a RichText carrier too
      const f3 = arm();
      await expect(telegramFetch(api('sendRichMessage'), post({
        chat_id: 1, rich_message: { blocks: [{ type: 'details', summary: '\u200b' }] },
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
