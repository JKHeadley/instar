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
  readerVisibleFieldsFor,
  NO_READER_VISIBLE_FIELD_TELEGRAM_METHODS,
} from './invisible-payload.js';

/**
 * Any Bot API URL — `api.telegram.org/bot<token>/<method>`. Case-INSENSITIVE: a hostname is
 * case-insensitive by RFC and Telegram accepts method names in any case. A matcher stricter than the
 * dispatcher it models produces requests Telegram honours and this file never sees.
 */
const BOT_API_HOST = 'api.telegram.org';
/**
 * STATED OPEN — a self-hosted Bot API server is invisible to this door.
 *
 * Telegram supports replacing the cloud endpoint with a local server, and both this recogniser and
 * `scripts/lint-telegram-egress-boundary.mjs` hard-code the host above. An agent configured against a
 * local server would have EVERY send classified as non-Telegram and pass unchecked, and the lint would
 * print clean over it.
 *
 * Confirmed open by review passes 47 and 48. Recorded here rather than only in the review archive
 * because a reader arriving at this constant is the person who needs to know it, and an open item that
 * lives only in an archive is one nobody meets. Closing it means taking the host from configuration,
 * in BOTH the runtime and the lint, so the two cannot drift apart.
 */
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
    // @silent-fallback-ok: a string `URL` cannot parse is not a Bot API URL, and `fetch` will reject
    // it too — so classifying it as "not ours" is the accurate answer, not a swallowed failure. The
    // request never reaches Telegram either way; there is no degraded delivery to report.
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // A terminal dot is the DNS root and denotes the SAME host; `new URL()` preserves it while an exact
  // string compare rejects it, so the request reached Telegram and the door returned null (pass 39 F2).
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host !== BOT_API_HOST) return null;
  let pathname = parsed.pathname;
  // @silent-fallback-ok: a malformed percent-escape is judged in its RAW form rather than dropped.
  // Refusing here would skip every check on a request Telegram still dispatches, which is the exact
  // bypass shape this door exists to close — so the fallback is toward MORE checking, not less.
  try { pathname = decodeURIComponent(pathname); } catch { /* judge the raw form */ }

  // Model Telegram's extraction rather than pattern-matching a shape: it strips an optional `test`
  // segment and treats the ENTIRE remaining path as the method name (pass 40 F1/F4). The previous regex
  // consumed only an alphabetic PREFIX, and its optional group backtracked so that `/bot<token>/test/`
  // resolved to the method `test` — which then refused as unclassified, hiding the root case entirely.
  const afterToken = /^\/bot[^/]+\/(.*)$/.exec(pathname);
  if (!afterToken) return null;
  let rest = afterToken[1].replace(/^test(?:\/|$)/, '').replace(/\/+$/, '');
  if (rest === '') return null;
  return CANONICAL_METHOD.get(rest.toLowerCase()) ?? rest;
}

/** A Bot API URL whose path carries a token but NO method segment — the shape Telegram resolves from a
 *  `method` argument instead. */
export function isBotApiRoot(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch {
    // @silent-fallback-ok: same reasoning as the classifier above — an unparseable string is not a Bot
    // API root, and a degradation report about a request that never happens is noise, not signal.
    return false;
  }
  if (parsed.hostname.toLowerCase().replace(/\.$/, '') !== BOT_API_HOST) return false;
  let pathname = parsed.pathname;
  try { pathname = decodeURIComponent(pathname); } catch {
    // @silent-fallback-ok: judged in its RAW form rather than dropped, exactly as in the classifier —
    // the fallback is toward MORE checking, since refusing here would skip every check on a request
    // Telegram still dispatches.
  }
  // The test-environment form `/bot<token>/test/` is ALSO a root: Telegram strips the `test` segment
  // and then resolves the method from a parameter exactly as it does for production (pass 40 F1 — the
  // tests covered test-paths-with-a-method and production-roots-with-a-parameter, never the
  // intersection, which is where the bypass lived).
  return /^\/bot[^/]+\/(?:test\/?)?$/.test(pathname);
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
      // Compare DECODED keys: `text` and `\u0074ext` are the SAME key to `JSON.parse` and to Telegram,
      // and the first version appended raw source characters, so an escaped spelling read as distinct
      // and the duplicate went undetected (pass 39 F3).
      if (escaped) {
        escaped = false;
        if (c === 'u') { buf += JSON.parse(`"\\u${body.slice(i + 1, i + 5)}"`); i += 4; continue; }
        buf += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[c] ?? c;
        continue;
      }
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
  /**
   * STATED OPEN — the body's encoding is inferred from its JavaScript WRAPPER, never from `Content-Type`.
   *
   * Everything below branches on what kind of JS value the body is — a string, `URLSearchParams`,
   * `FormData`, a stream. Telegram decides from the request's media type. A caller sending a JSON
   * string under a form content type, or the reverse, is read one way here and another way there, and
   * the field this door checks is then not the field Telegram reads.
   *
   * Confirmed open by review passes 47 and 48, and recorded at the function that carries it rather than
   * only in the review archive. Closing it means reading the header and letting it govern, with the
   * wrapper as a fallback — not adding another wrapper case.
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
    // Emitted BEFORE the throw (pass 39 F7): this refusal sat upstream of both emit sites, so the one
    // shape that arrives already-opaque produced no record at all and a catcher could erase it entirely.
    emitInvisiblePayloadRefusal({
      guard: 'invisible-payload',
      outcome: 'refused',
      method: '(request-object)',
      field: '(unreadable)',
      rule: 'unreadable-request',
      valueLength: 0,
      engine: process.version,
      unicode: process.versions.unicode ?? 'unknown',
    });
    throw new TelegramEgressError(
      'telegram egress: a Request object carries its own body, which cannot be inspected here. Pass a '
      + 'URL string (or URL) with the parameters in `init`.',
    );
  }
  const href = typeof url === 'string' ? url : url.href;
  // Read the body ONCE, and FREEZE it. Reading once was not enough (pass 41): for a string the value IS
  // the bytes, but `URLSearchParams` and `FormData` are captured by REFERENCE, so a caller could mutate
  // the same object after the check and change what goes on the wire. Serialise those to a string here,
  // so the value inspected below and the value sent at the end are the same immutable bytes.
  const rawBody = init.body;
  const checkedBody: RequestInit['body'] = rawBody instanceof URLSearchParams
    ? rawBody.toString()
    : (typeof FormData !== 'undefined' && rawBody instanceof FormData)
      ? new URLSearchParams(
        [...(rawBody as unknown as Iterable<[string, unknown]>)]
          .filter((e): e is [string, string] => typeof e[1] === 'string'),
      ).toString()
      : rawBody;

  let method = methodFromTelegramUrl(href);

  // F1 (pass 39): when the path carries NO method, Telegram falls back to the first `method` ARGUMENT.
  // The door returned null for those and skipped every check, so a request to the token root carrying
  // `method=sendMessage&text=<invisible>` dispatched normally and was never inspected. Recover the
  // method from the parameters in exactly the case Telegram does.
  if (method === null && isBotApiRoot(href)) {
    const { params } = collectParams(href, checkedBody);
    const fromParams = typeof params.method === 'string' ? params.method : null;
    if (fromParams !== null) {
      method = CANONICAL_METHOD.get(fromParams.toLowerCase()) ?? fromParams;
    } else {
      // A Bot API root request whose method cannot be determined is undecidable, not benign.
      emitInvisiblePayloadRefusal({
        guard: 'invisible-payload',
        outcome: 'refused',
        method: '(unresolved)',
        field: '(unknown)',
        rule: 'unclassified-method',
        valueLength: 0,
        engine: process.version,
        unicode: process.versions.unicode ?? 'unknown',
      });
      throw new TelegramEgressError(
        'telegram egress: this is a Bot API request whose method is in neither the path nor a `method` '
        + 'parameter, so what it will do cannot be determined and its payload cannot be checked.',
      );
    }
  }

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

    const { params, uncheckable } = collectParams(href, checkedBody);
    // F6 (pass 39): an unreadable body is only undecidable if the reader-visible field is not ALREADY
    // supplied by the query — and query values win, so when one is present the body cannot change what
    // Telegram sends. Refusing anyway destroyed a decidable, deliverable message.
    // EVERY reader-visible field, not just the first: a method can carry more than one (pass 43), and
    // an unreadable body is only harmless if the query already supplies ALL of them.
    // The reader-visible fields of a method are ALTERNATIVES, not simultaneous requirements — a send
    // carries `text` OR the rich structure. Requiring the query to supply ALL of them (pass 44) treated
    // an either-or as an and, so my repair for one over-refusal introduced another one layer up.
    //
    // But ANY of them (pass 45's repair) was wrong in the other direction, and this is the third place
    // today the same shape has bitten: the alternatives are a PRIORITY union, not a free choice.
    // `editMessageText` reads `rich_message` whenever that key is present ANYWHERE in the request and
    // only otherwise reads `text`. So a visible `?text=` in the query beside an UNREADABLE body waived
    // the refusal — and the body was free to carry the `rich_message` that actually got sent.
    //
    // The waiver therefore requires the query to supply the method's HIGHEST-PRECEDENCE field. Nothing a
    // body can carry outranks it, and a same-key body value loses to the query one, so what Telegram
    // sends is the value just checked. For a single-field method this is exactly the previous rule.
    const fields = readerVisibleFieldsFor(method);
    const fieldSuppliedByQuery = fields.length > 0 && typeof params[fields[0]] === 'string';
    if (uncheckable !== null && !fieldSuppliedByQuery) {
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

  // F2 (pass 40): the door read `init.body`, checked THAT value, and then handed the caller's original
  // mutable object to `fetch`. A getter, or any mutation between the read and the send, could show
  // visible content to the check and different content to the network — which falsifies the claim this
  // file makes about checking the exact bytes that go on the wire.
  //
  // So send a request built from the body that was actually inspected. `checkedBody` is read once,
  // above, and reused here; the caller's object can no longer decide what leaves.
  // Build the outgoing init EXPLICITLY. Spreading `init` re-reads `body` — a SECOND read (pass 42) — and
  // when the captured value was `undefined` no override followed, so whatever that second read returned
  // is what went on the wire. `body` is now always set from the captured value, never re-read.
  const outgoing: RequestInit = { ...init };
  outgoing.body = checkedBody ?? null;
  return fetch(href, outgoing);
}
