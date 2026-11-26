import type { ConnectViewerSession } from './ConnectViewerSession.js';

/** Stores at most one frame. The sink writes synchronously or drops the frame. */
export class ConnectViewerFrameQueue {
  #frame?: Buffer;
  readonly #discard = () => { this.#frame = undefined; };

  constructor(private readonly session: ConnectViewerSession, private readonly lifetime: AbortSignal) {
    lifetime.addEventListener('abort', this.#discard, { once: true });
  }

  offer(frame: Buffer): boolean {
    if (this.lifetime.aborted || frame.length === 0 || frame.length > 1024 * 1024) return false;
    this.#frame = Buffer.from(frame);
    return true;
  }

  flush(write: (frame: Buffer) => void): boolean {
    const frame = this.#frame;
    this.#frame = undefined;
    if (!frame || this.lifetime.aborted) return false;
    return this.session.dispatchFrame(() => write(frame));
  }

  close(): void {
    this.#discard();
    this.lifetime.removeEventListener('abort', this.#discard);
    this.session.stop();
  }
}
