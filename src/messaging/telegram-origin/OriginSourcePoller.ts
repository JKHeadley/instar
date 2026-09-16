import { stat } from 'node:fs/promises';

/** @self-action-controller: telegram-origin-source-poller
 * Fixed-rate, close-bounded metadata observation; it never mutates a source. */
/**
 * Bounded source invalidation without native FSWatcher ownership.
 *
 * macOS can synchronously stall for tens of seconds while closing an
 * FSWatcher under aggregate load. These authority sources already refresh on
 * a five-second cadence, so a short stat cadence preserves prompt revocation
 * while making close() an immediate, deterministic timer cancellation.
 */
export class OriginSourcePoller {
  readonly #fingerprints = new Map<string, string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling = false;
  #closed = false;

  constructor(
    readonly paths: readonly string[],
    readonly onChanged: () => void,
    readonly intervalMs = 250,
  ) {}

  async start(): Promise<void> {
    if (this.#closed || this.#timer) return;
    for (const filename of this.paths) this.#fingerprints.set(filename, await this.#fingerprint(filename));
    if (this.#closed || this.#timer) return;
    this.#timer = setInterval(() => void this.#poll(), this.intervalMs);
    this.#timer.unref();
  }

  async #poll(): Promise<void> {
    if (this.#closed || this.#polling) return;
    this.#polling = true;
    let changed = false;
    try {
      for (const filename of this.paths) {
        const next = await this.#fingerprint(filename);
        if (this.#closed) return;
        if (this.#fingerprints.get(filename) !== next) changed = true;
        this.#fingerprints.set(filename, next);
      }
      if (changed && !this.#closed) this.onChanged();
    } finally {
      this.#polling = false;
    }
  }

  async #fingerprint(filename: string): Promise<string> {
    try {
      const value = await stat(filename);
      return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' ? 'missing' : `unreadable:${code ?? 'unknown'}`;
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#fingerprints.clear();
  }
}
