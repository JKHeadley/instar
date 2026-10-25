/** In-process evidence only: minted immediately before the native fetch call,
 * with no intervening await. Never infer this from an AbortError or a signal's
 * reason after invoking fetch; that request might already have reached Telegram. */
export class OriginTransportCancelledBeforeNetwork extends Error {
  constructor() {
    super('telegram-request-cancelled-before-network');
    this.name = 'OriginTransportCancelledBeforeNetwork';
  }
}
