/** In-process evidence only: minted immediately before the native fetch call,
 * with no intervening await. Never infer this from an AbortError or a signal's
 * reason after invoking fetch; that request might already have reached Telegram. */
export class OriginTransportCancelledBeforeNetwork extends Error {
  constructor() {
    super('telegram-request-cancelled-before-network');
    this.name = 'OriginTransportCancelledBeforeNetwork';
  }
}

/**
 * The native request failed while CONNECTING: name resolution failed, or the
 * TCP connect was refused, unreachable or timed out. No connection existed, so
 * no request byte can have reached Telegram and the send is safe to retry.
 * Only connect-phase evidence qualifies; a reset or timeout after the
 * connection opened stays "outcome unknown".
 */
export class OriginTransportUnsent extends Error {
  constructor(readonly code: string) {
    super(`telegram-connect-failed:${code}`);
    this.name = 'OriginTransportUnsent';
  }
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_NODATA']);
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'EADDRNOTAVAIL']);

/** The error code a failed fetch carries (fetch wraps the network error in `cause`). */
export function fetchFailureCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  let e: unknown = error;
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The connect-phase proof, or null. DNS failures and undici's connect timeout
 * qualify by code; socket codes qualify only when the failing call was
 * `connect` (every attempt of a multi-address connect must be a connect
 * failure).
 */
export function provedUnsentCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  let e: unknown = error;
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e);
    const { code, syscall, errors } = e as { code?: unknown; syscall?: unknown; errors?: unknown };
    if (typeof code === 'string') {
      if (DNS_CODES.has(code) || code === 'UND_ERR_CONNECT_TIMEOUT') return code;
      if (CONNECT_CODES.has(code) && syscall === 'connect') return code;
      if (Array.isArray(errors) && errors.length > 0 && errors.every(x => provedUnsentCode(x) !== null)) return code;
      return null;
    }
    if (Array.isArray(errors) && errors.length > 0 && errors.every(x => provedUnsentCode(x) !== null)) return 'ECONNECT-ALL';
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}
