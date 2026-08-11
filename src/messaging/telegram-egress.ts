/**
 * The single door to the Telegram Bot API for anything carrying a reader-visible body.
 *
 * WHY THIS EXISTS, in the order the reasons were learned:
 *
 * Review passes 29 through 35 each found the same shape by a different route. A guard was placed on
 * one send path and the path was called guarded; a second egress existed (pass 29); the guard ran
 * before a formatter that changed the representation (pass 33); the lint that policed the guard could
 * not prove its own claims about call resolution or method classification (passes 34, 35). Six
 * patterns, one class: the guarantee was distributed across senders, so proving it meant proving a
 * property of every sender, and every proof was weaker than it read.
 *
 * A boundary does not have that problem. If exactly one function may reach the network, then "is the
 * payload checked" stops being a question about six call sites and becomes a question about one.
 *
 * WHAT IT CHECKS, and why here rather than earlier. It reads the request as Telegram will read it —
 * the query string and the serialised body, the exact bytes about to go on the wire. Every earlier
 * placement checked a representation that something later could still change: the caller's text, then
 * the formatter's output, then the object handed to fetch. This is the last one.
 *
 * WHAT PASS 36 FOUND, because moving a boundary is not the same as closing a class:
 *
 *   1. The door checked ONLY a non-empty string body. Telegram accepts parameters in the URL query,
 *      as form encoding, and as multipart — so a reader-visible method sent any of those other ways
 *      reached the network unchecked. The door was one encoding wide.
 *   2. Method and host recognition were case-SENSITIVE while Telegram's dispatch is not. `sendmessage`
 *      is dispatched by Telegram and missed the field map, which returns silently on an unknown key.
 *   3. Moving the boundary DELETED the closed-world method check the previous per-sender lint
 *      performed. A newly-used reader-visible method passed through the approved door, received no
 *      decision, and left while the lint stayed clean — a guard that nothing guards, which is the
 *      exact defect this file's own header claimed to have eliminated.
 *
 * All three share one root: the door treated what it could not check as fine. The rule below is the
 * opposite, and it is the only rule here that matters — AN UNCHECKABLE REQUEST IS A CLOSED DOOR.
 */
import {
  assertOutgoingPayloadVisible,
  READER_VISIBLE_TELEGRAM_PARAMS,
  NO_READER_VISIBLE_FIELD_TELEGRAM_METHODS,
} from './invisible-payload.js';

/**
 * Any Bot API URL — `api.telegram.org/bot<token>/<method>`. Case-INSENSITIVE: a hostname is
 * case-insensitive by RFC and Telegram accepts method names in any case. A matcher stricter than the
 * dispatcher it models produces requests Telegram honours and this file never sees.
 */
const BOT_API_URL = /^https:\/\/api\.telegram\.org\/bot[^/]+\/([A-Za-z]+)/i;

/** Lowercased method → canonical spelling, so lookup matches Telegram's case-insensitive dispatch. */
const CANONICAL_METHOD: ReadonlyMap<string, string> = new Map(
  [...Object.keys(READER_VISIBLE_TELEGRAM_PARAMS), ...NO_READER_VISIBLE_FIELD_TELEGRAM_METHODS]
    .map((m) => [m.toLowerCase(), m] as const),
);

/**
 * Recover the API method from the URL rather than trusting a caller-supplied label.
 *
 * A caller passing the wrong method name would select the wrong reader-visible field, and the check
 * would silently examine nothing. The URL is what Telegram dispatches on, so it is the only
 * description of the request that cannot disagree with the request.
 *
 * Returns the CANONICAL spelling when the method is known, so a case variant cannot slip past a
 * case-sensitive field map; returns the raw spelling when unknown, which `telegramFetch` refuses.
 */
export function methodFromTelegramUrl(url: string): string | null {
  const m = BOT_API_URL.exec(url);
  if (!m) return null;
  return CANONICAL_METHOD.get(m[1].toLowerCase()) ?? m[1];
}

export class TelegramEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramEgressError';
  }
}

/** Parameters Telegram will read, gathered from BOTH places it accepts them. */
function collectParams(url: string, body: RequestInit['body']): {
  params: Record<string, unknown>;
  uncheckable: string | null;
} {
  const params: Record<string, unknown> = {};

  // The query string is a first-class way to pass Bot API parameters. The previous version of this
  // door ignored it completely, so `sendMessage?text=<invisible>` was never examined.
  const q = url.indexOf('?');
  if (q >= 0) {
    for (const [k, v] of new URLSearchParams(url.slice(q + 1))) params[k] = v;
  }

  if (body === null || body === undefined) return { params, uncheckable: null };

  if (typeof body === 'string') {
    if (body.length === 0) return { params, uncheckable: null };
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(params, parsed as Record<string, unknown>);
        return { params, uncheckable: null };
      }
      return { params, uncheckable: 'a JSON body that is not an object' };
    } catch {
      // Form encoding is a supported Bot API encoding, not a mistake. Accept it when it looks like
      // one, and refuse anything else rather than guess.
      if (/^[^=&\s]+=/.test(body)) {
        for (const [k, v] of new URLSearchParams(body)) params[k] = v;
        return { params, uncheckable: null };
      }
      return { params, uncheckable: 'a body that is neither JSON nor form encoding' };
    }
  }

  if (body instanceof URLSearchParams) {
    for (const [k, v] of body) params[k] = v;
    return { params, uncheckable: null };
  }

  // FormData, Blob, ArrayBuffer, ReadableStream. Multipart is how Telegram takes file uploads and a
  // caption travels with them, so this is not a hypothetical shape. It is refused rather than parsed,
  // because reading a stream here would consume the one the caller is about to send.
  return { params, uncheckable: `a ${body.constructor?.name ?? 'non-string'} body` };
}

/**
 * Send to the Telegram Bot API. The ONLY place in this codebase permitted to call `fetch` on the Bot
 * API host; `scripts/lint-telegram-egress-boundary.mjs` enforces that.
 *
 * Refuses rather than forwards whenever it cannot decide: an unknown method (whether it carries
 * reader-visible content is unknown, so "no field" cannot be told apart from "not checked"), an
 * unparseable body, and a body shape that cannot be read without consuming it.
 */
export async function telegramFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = methodFromTelegramUrl(url);

  if (method !== null) {
    // CLOSED WORLD. `assertOutgoingPayloadVisible` returns silently for a method it has no field for,
    // which is right for a method KNOWN to carry no reader-visible field and wrong for one nobody has
    // classified. Only this door can tell those apart, so only this door can refuse.
    if (!CANONICAL_METHOD.has(method.toLowerCase())) {
      throw new TelegramEgressError(
        `telegram egress: "${method}" is not a classified Bot API method, so whether it carries `
        + 'reader-visible content is unknown and this request cannot be checked. Add it to '
        + 'READER_VISIBLE_TELEGRAM_PARAMS (with its field) or to '
        + 'NO_READER_VISIBLE_FIELD_TELEGRAM_METHODS (deliberately, having read the Bot API docs).',
      );
    }

    const { params, uncheckable } = collectParams(url, init.body);
    if (uncheckable !== null) {
      throw new TelegramEgressError(
        `telegram egress: ${method} was given ${uncheckable}, so its payload cannot be checked for `
        + 'reader-visible content. Pass parameters as JSON, form encoding, or query string.',
      );
    }
    assertOutgoingPayloadVisible(method, params);
  }

  return fetch(url, init);
}
