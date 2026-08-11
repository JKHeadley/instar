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
 *
 * WHAT THIS DOOR DOES NOT COVER, decided rather than missed (review pass 38 finding 4). A non-Bot URL
 * that REDIRECTS into a Bot API method is classified once, on the initial URL, and `fetch` follows the
 * redirect without a second decision. Manual redirect handling would close it and would also break the
 * file-download callers that legitimately redirect.
 *
 * It is left open because it is outside this guard's purpose: the guarantee is that THIS AGENT does not
 * send a message a reader receives as nothing. A redirect crossing into the Bot API requires an actor
 * who already controls a response this agent fetches — at which point the invisible-payload guard is not
 * the control that matters. Stated so the next reader can disagree with the judgment rather than
 * discover the gap.
 */
import {
  assertOutgoingPayloadVisible,
  emitInvisiblePayloadRefusal,
  READER_VISIBLE_TELEGRAM_PARAMS,
  NO_READER_VISIBLE_FIELD_TELEGRAM_METHODS,
} from './invisible-payload.js';

/**
 * Any Bot API URL — `api.telegram.org/bot<token>/<method>`. Case-INSENSITIVE: a hostname is
 * case-insensitive by RFC and Telegram accepts method names in any case. A matcher stricter than the
 * dispatcher it models produces requests Telegram honours and this file never sees.
 */
const BOT_API_HOST = 'api.telegram.org';
/**
 * `/bot<token>/<method>`, and Telegram's documented TEST-ENVIRONMENT form `/bot<token>/test/<method>`.
 * The path is percent-DECODED first, because Telegram decodes before extracting the method — matching
 * the raw text meant a percent-encoded octet made this return null while Telegram dispatched the
 * decoded method, and it also meant a legitimate test-environment call was classified as the method
 * `test` and refused (review pass 38 finding 2, wrong in both directions from one regex).
 */
const BOT_PATH = /^\/bot[^/]+\/(?:test\/)?([A-Za-z]+)/;

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
  // Parse rather than pattern-match the raw text. Review pass 37 finding 3: a regex anchored to the
  // literal host missed spellings `fetch` normalises before dispatch — an explicit `:443`, leading
  // whitespace, a percent-encoded or upper-case host. Telegram received those requests; the door
  // returned null and skipped every check. Whatever `fetch` will send is what must be inspected, so
  // the parser `fetch` uses is the one that decides.
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.hostname.toLowerCase() !== BOT_API_HOST) return null;
  let pathname = parsed.pathname;
  try { pathname = decodeURIComponent(pathname); } catch { /* malformed escape: judge the raw form */ }
  const m = BOT_PATH.exec(pathname);
  if (!m) return null;
  return CANONICAL_METHOD.get(m[1].toLowerCase()) ?? m[1];
}

export class TelegramEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramEgressError';
  }
}

/**
 * Name a duplicated TOP-LEVEL key in a JSON object body, or null. Deliberately a scanner rather than a
 * parser: it only needs to answer "is the effective value ambiguous here", and a wrong answer in the
 * ambiguous direction costs a refusal rather than a delivery.
 */
function duplicateTopLevelJsonKey(body: string): string | null {
  const seen = new Set<string>();
  let depth = 0;
  let inString = false;
  let escaped = false;
  let key: string | null = null;
  let buf = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (inString) {
      if (escaped) { escaped = false; buf += c; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = false; key = buf; buf = ''; continue; }
      buf += c;
      continue;
    }
    if (c === '"') { inString = true; buf = ''; continue; }
    if (c === '{' || c === '[') { depth += 1; continue; }
    if (c === '}' || c === ']') { depth -= 1; continue; }
    if (c === ':' && depth === 1 && key !== null) {
      if (seen.has(key)) return key;
      seen.add(key);
      key = null;
    }
  }
  return null;
}

/** Parameters Telegram will read, gathered from BOTH places it accepts them. */
function collectParams(url: string, body: RequestInit['body']): {
  params: Record<string, unknown>;
  uncheckable: string | null;
} {
  const params: Record<string, unknown> = {};

  // The query string is a first-class way to pass Bot API parameters. The first version of this door
  // ignored it completely, so `sendMessage?text=<invisible>` was never examined.
  //
  // Two corrections from review pass 37. The FRAGMENT never goes on the wire — `fetch` strips it — so
  // reading it as payload let visible fragment text mask an invisible query value (finding 2). And
  // Telegram appends URL arguments BEFORE body arguments while its accessor returns the FIRST match,
  // so on a conflict the QUERY value is the one that gets sent; the first version let the body
  // overwrite it and inspected a value Telegram would never use (finding 1). Query is therefore
  // collected LAST here, with `queryKeys` marking what must not be overwritten.
  let search = '';
  try {
    search = new URL(url.trim()).search;
  } catch {
    const q = url.indexOf('?');
    const h = url.indexOf('#');
    if (q >= 0) search = h > q ? url.slice(q, h) : url.slice(q);
  }
  const queryParams = new URLSearchParams(search);

  /**
   * Overlay the query LAST: on a conflicting key, the value Telegram sends is the query's.
   *
   * And take the FIRST occurrence of a repeated key, not the last. Telegram's accessor returns the
   * first match; iterating `URLSearchParams` yields every occurrence, so assigning in loop order left
   * the LAST one in the object. Measured before this fix, both directions were wrong:
   * `?text=<invisible>&text=visible` was SENT while Telegram would have sent the invisible value, and
   * `?text=visible&text=<invisible>` was REFUSED while Telegram would have sent the visible one. One
   * bypass and one destroyed message from a single line. `URLSearchParams.get` returns the first.
   */
  const done = (uncheckable: string | null) => {
    for (const k of new Set(queryParams.keys())) {
      const first = queryParams.get(k);
      if (first !== null) params[k] = first;
    }
    return { params, uncheckable };
  };

  if (body === null || body === undefined) return done(null);

  if (typeof body === 'string') {
    if (body.length === 0) return done(null);
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // `JSON.parse` keeps the LAST of a duplicated key; Telegram's parser preserves order and its
        // accessor returns the FIRST. Rather than reimplement a JSON parser to recover the first, this
        // REFUSES a body with duplicate top-level keys — the value Telegram would use cannot be
        // determined here, and an undecidable request is a closed door (pass 38 finding 1).
        // `JSON.stringify` never emits duplicates, so no ordinary sender is affected.
        const dup = duplicateTopLevelJsonKey(body);
        if (dup !== null) {
          return done(`a JSON body with a duplicated "${dup}" key, whose effective value is ambiguous`);
        }
        Object.assign(params, parsed as Record<string, unknown>);
        return done(null);
      }
      return done('a JSON body that is not an object');
    } catch {
      // Form encoding is a supported Bot API encoding, not a mistake. Accept it when it looks like
      // one, and refuse anything else rather than guess.
      if (/^[^=&\s]+=/.test(body)) {
        // Same first-match rule as the query above — a repeated key in a form body resolves to its
        // FIRST value at Telegram, so it must here too.
        const form = new URLSearchParams(body);
        for (const k of new Set(form.keys())) {
          const first = form.get(k);
          if (first !== null) params[k] = first;
        }
        return done(null);
      }
      return done('a body that is neither JSON nor form encoding');
    }
  }

  if (body instanceof URLSearchParams) {
    for (const k of new Set(body.keys())) {
      const first = body.get(k);
      if (first !== null) params[k] = first;
    }
    return done(null);
  }

  // F5: FormData is ITERABLE without consuming it, so it is read rather than refused. The previous
  // version grouped it with one-shot streams under "cannot read without consuming", which was false
  // and rejected legitimate multipart sends carrying visible text.
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    // First occurrence wins here too (pass 38 finding 1: the repair covered query and form encoding
    // and skipped this one, so multipart still resolved a repeated key to its LAST value).
    for (const [k, v] of body as unknown as Iterable<[string, unknown]>) {
      if (typeof v === 'string' && !(k in params)) params[k] = v;
    }
    return done(null);
  }

  // Blob, ArrayBuffer, TypedArray, ReadableStream. These are not parameter encodings the Bot API
  // accepts for a reader-visible field, and a stream genuinely is one-shot — reading it here would
  // consume the one the caller is about to send. Refused, which is the safe direction.
  return done(`a ${body.constructor?.name ?? 'non-string'} body`);
}

/**
 * Send to the Telegram Bot API. The ONLY place in this codebase permitted to call `fetch` on the Bot
 * API host; `scripts/lint-telegram-egress-boundary.mjs` enforces that.
 *
 * Refuses rather than forwards whenever it cannot decide: an unknown method (whether it carries
 * reader-visible content is unknown, so "no field" cannot be told apart from "not checked"), an
 * unparseable body, and a body shape that cannot be read without consuming it.
 */
export async function telegramFetch(
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  // The TYPE said `string`; the RUNTIME is what ships. Native `fetch` also accepts `URL` and `Request`
  // objects, and JavaScript callers are not bound by the signature — review pass 38 finding 3. A `URL`
  // is normalised to its string form and checked exactly like any other. A `Request` is REFUSED: its
  // body lives on the object rather than in `init`, so no parameter collection is possible and
  // forwarding it would be the unchecked door this module exists to close.
  if (typeof url !== 'string' && !(url instanceof URL)) {
    throw new TelegramEgressError(
      'telegram egress: a Request object carries its own body, which cannot be inspected here. Pass a '
      + 'URL string (or URL) with the parameters in `init`.',
    );
  }
  const href = typeof url === 'string' ? url : url.href;
  const method = methodFromTelegramUrl(href);

  if (method !== null) {
    // CLOSED WORLD. `assertOutgoingPayloadVisible` returns silently for a method it has no field for,
    // which is right for a method KNOWN to carry no reader-visible field and wrong for one nobody has
    // classified. Only this door can tell those apart, so only this door can refuse.
    if (!CANONICAL_METHOD.has(method.toLowerCase())) {
      // Recorded before it is thrown (pass 37 finding 6): "I do not understand this request" is the
      // refusal class most worth seeing in the decision stream, and it was the only one absent from it.
      emitInvisiblePayloadRefusal({
        guard: 'invisible-payload',
        outcome: 'refused',
        method,
        field: '(unknown)',
        rule: 'unclassified-method',
        valueLength: 0,
        engine: process.version,
        unicode: process.versions.unicode ?? 'unknown',
      });
      throw new TelegramEgressError(
        `telegram egress: "${method}" is not a classified Bot API method, so whether it carries `
        + 'reader-visible content is unknown and this request cannot be checked. Add it to '
        + 'READER_VISIBLE_TELEGRAM_PARAMS (with its field) or to '
        + 'NO_READER_VISIBLE_FIELD_TELEGRAM_METHODS (deliberately, having read the Bot API docs).',
      );
    }

    const { params, uncheckable } = collectParams(href, init.body);
    if (uncheckable !== null) {
      emitInvisiblePayloadRefusal({
        guard: 'invisible-payload',
        outcome: 'refused',
        method,
        field: '(unreadable)',
        rule: 'unreadable-request',
        valueLength: 0,
        engine: process.version,
        unicode: process.versions.unicode ?? 'unknown',
      });
      throw new TelegramEgressError(
        `telegram egress: ${method} was given ${uncheckable}, so its payload cannot be checked for `
        + 'reader-visible content. Pass parameters as JSON, form encoding, or query string.',
      );
    }
    assertOutgoingPayloadVisible(method, params);
  }

  return fetch(href, init);
}
