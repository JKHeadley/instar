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
 * A boundary does not have that problem. If exactly one function may reach the network with a body,
 * then "is the payload checked" stops being a question about six call sites and becomes a question
 * about one — and the lint's job changes from "find the guard in each sender" (which needs binding
 * resolution it does not do) to "no one else calls fetch on this host with a body" (which needs only
 * a URL and the presence of a body).
 *
 * WHAT IT CHECKS, and why here rather than earlier. It reads the SERIALIZED BODY — the exact bytes
 * about to go on the wire. Every earlier placement checked a representation that something later
 * could still change: the caller's text, then the formatter's output, then the object handed to
 * fetch. This is the last one. Nothing transforms it after this line, so a check that passes here
 * cannot be undone by a transform nobody looked at, which is the failure that produced pass 33.
 */
import { assertOutgoingPayloadVisible } from './invisible-payload.js';

/** Any Bot API URL — `api.telegram.org/bot<token>/<method>`. The file-download host carries no body. */
const BOT_API_URL = /^https:\/\/api\.telegram\.org\/bot[^/]+\/([A-Za-z]+)/;

/**
 * Recover the API method from the URL rather than trusting a caller-supplied label.
 *
 * A caller that passes the wrong method name would select the wrong reader-visible field and the
 * check would silently examine nothing — the same shape as a guard that runs on the wrong string.
 * The URL is what Telegram itself dispatches on, so it is the only description of the request that
 * cannot disagree with the request.
 */
export function methodFromTelegramUrl(url: string): string | null {
  const m = BOT_API_URL.exec(url);
  return m ? m[1] : null;
}

export class TelegramEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramEgressError';
  }
}

/**
 * Send to the Telegram Bot API. The ONLY place in this codebase permitted to call `fetch` on the Bot
 * API host with a request body; `scripts/lint-telegram-egress-boundary.mjs` enforces that.
 *
 * The visibility check runs on the parsed wire body. A body that is not JSON is refused rather than
 * skipped: the Bot API takes JSON for every body-carrying method, so a non-JSON body here is a
 * programming error, and silently passing it through would create exactly the unchecked door this
 * module exists to close.
 */
export async function telegramFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = methodFromTelegramUrl(url);
  const body = init.body;

  if (method !== null && typeof body === 'string' && body.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new TelegramEgressError(
        `telegram egress: ${method} was given a non-JSON body, so its payload cannot be checked for `
        + 'reader-visible content. Send an object serialised with JSON.stringify.',
      );
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      assertOutgoingPayloadVisible(method, parsed as Record<string, unknown>);
    }
  }

  return fetch(url, init);
}
