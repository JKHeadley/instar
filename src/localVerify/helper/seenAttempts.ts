/**
 * Single-use request ids for the helper routes (docs/specs/local-verify-borrowed-unit-slices.md, C
 * "Replay"). An attemptId already seen is refused; the set persists across helper restarts for
 * 10 min (`state/local-verify/helper-seen-attempts.json`), longer than any request lives (60 s + 30 s).
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { HELPER_LIMITS } from './helperProtocol.js';

/** Bounded: far above the requests a helper can receive in 10 min. */
const SEEN_MAX = 20_000;

export class HelperSeenAttempts {
  private readonly file: string;
  private seen = new Map<string, number>();

  constructor(stateDir: string, private readonly now: () => number = () => Date.now()) {
    this.file = path.join(stateDir, 'state', 'local-verify', 'helper-seen-attempts.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw ?? {})) if (typeof v === 'number' && Number.isFinite(v)) this.seen.set(k, v);
    } catch { /* @silent-fallback-ok: absent on first start; an unreadable file also starts empty, but only requests that expired before the restart could replay and those are refused as expired */ }
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - HELPER_LIMITS.seenAttemptMs;
    for (const [k, at] of this.seen) if (at < cutoff) this.seen.delete(k);
  }

  has(attemptId: string): boolean {
    this.prune();
    return this.seen.has(attemptId);
  }

  /**
   * Record an id durably BEFORE anything runs for it. Throws when the file cannot be written: the
   * caller refuses (`state-unwritable`) rather than run a request it could not mark as used.
   */
  add(attemptId: string): void {
    this.prune();
    this.seen.set(attemptId, this.now());
    if (this.seen.size > SEEN_MAX) {
      const sorted = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
      this.seen = new Map(sorted.slice(sorted.length - SEEN_MAX));
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    SafeFsExecutor.atomicWriteJsonSync(this.file, Object.fromEntries(this.seen), { operation: 'local-verify:helper-seen-attempts' });
  }
}
