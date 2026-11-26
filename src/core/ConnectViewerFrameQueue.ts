import type { ConnectViewerSession } from './ConnectViewerSession.js';

/** Stores at most one frame. The sink writes synchronously or drops the frame. */
export class ConnectViewerFrameQueue {
  #frame?: Buffer;
  readonly #discard = () => { this.#frame = undefined; };

  constructor(private readonly session: ConnectViewerSession) {
    session.signal.addEventListener('abort', this.#discard, { once: true });
  }

  offer(frame: Buffer): boolean {
    if (this.session.signal.aborted || frame.length === 0 || frame.length > 1024 * 1024) return false;
    this.#frame = Buffer.from(frame);
    return true;
  }

  flush(write: (frame: Buffer) => void): boolean {
    const frame = this.#frame;
    this.#frame = undefined;
    if (!frame || this.session.signal.aborted) return false;
    return this.session.dispatchFrame(() => write(frame));
  }

  close(): void {
    this.#discard();
    this.session.signal.removeEventListener('abort', this.#discard);
    this.session.stop();
  }
}
