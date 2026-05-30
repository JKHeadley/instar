/**
 * TopicPlacementPinStore (Multi-Machine Session Pool §L4 — the "move this to
 * <nickname>" pin).
 *
 * `PlacementExecutor.decide()` honors a per-topic `TopicPlacement`
 * (`{preferredMachine, pinned}`) with ordering `['hard-constraint','pin','sticky',
 * 'least-loaded']` — but nothing persisted that pin, and `SessionRouter.route()`
 * was called with NO `topicMetadata`, so placement always fell back to
 * least-loaded. This store is the missing piece: it durably records the pin a
 * user sets via "move/run this on <nickname>", keyed by topic, so the next
 * placement for that topic lands on the named machine and stays there.
 *
 * Durable (atomic JSON write) + injectable clock so it's unit-testable. Keyed by
 * the topic's session key (the topic id as a string — the same key
 * `SessionRouter.route()` uses). A pin is a HARD pin (pinned:true) per §L4: set
 * by an explicit relocation command, cleared on `clear()`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TopicPlacement } from './PlacementExecutor.js';

/** One persisted pin: the resolved target machine + when it was set. */
export interface TopicPin {
  preferredMachine: string;
  pinned: boolean;
  updatedAt: string;
}

export interface TopicPlacementPinStoreDeps {
  /** File the pins persist to (JSON). */
  filePath: string;
  /** Wall clock — injectable for tests. Defaults to `Date`. */
  now?: () => Date;
}

export class TopicPlacementPinStore {
  private readonly d: TopicPlacementPinStoreDeps;
  private pins: Record<string, TopicPin> = {};
  private loaded = false;

  constructor(deps: TopicPlacementPinStoreDeps) {
    this.d = deps;
  }

  private load(): void {
    if (this.loaded) return;
    try {
      if (fs.existsSync(this.d.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.d.filePath, 'utf-8'));
        if (raw && typeof raw === 'object' && raw.pins && typeof raw.pins === 'object') {
          this.pins = raw.pins as Record<string, TopicPin>;
        }
      }
    } catch {
      this.pins = {}; // corrupt file → start clean (the pin is advisory, not authoritative)
    }
    this.loaded = true;
  }

  private persist(): void {
    const dir = path.dirname(this.d.filePath);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const tmp = `${this.d.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pins: this.pins }, null, 2));
    fs.renameSync(tmp, this.d.filePath); // atomic swap
  }

  /** Pin a topic to a machine (a hard pin). Idempotent; refreshes `updatedAt`. */
  set(sessionKey: string, preferredMachine: string, pinned = true): void {
    this.load();
    const now = (this.d.now ?? (() => new Date()))().toISOString();
    this.pins[sessionKey] = { preferredMachine, pinned, updatedAt: now };
    this.persist();
  }

  /** The current pin for a topic, or null if unpinned. */
  get(sessionKey: string): TopicPin | null {
    this.load();
    return this.pins[sessionKey] ?? null;
  }

  /**
   * The pin as a `TopicPlacement` for `PlacementExecutor.decide({ topicMetadata })`,
   * or undefined if unpinned (so the caller passes `topicMetadata: undefined`).
   */
  asTopicMetadata(sessionKey: string): TopicPlacement | undefined {
    const pin = this.get(sessionKey);
    return pin ? { preferredMachine: pin.preferredMachine, pinned: pin.pinned } : undefined;
  }

  /** When the topic's pin was last set (ms epoch), or null if unpinned — feeds the transfer rate-limit guard. */
  lastUpdatedAtMs(sessionKey: string): number | null {
    const pin = this.get(sessionKey);
    if (!pin) return null;
    const ms = Date.parse(pin.updatedAt);
    return Number.isFinite(ms) ? ms : null;
  }

  /** Remove a topic's pin (e.g. the user unpins, or the target is decommissioned). */
  clear(sessionKey: string): void {
    this.load();
    if (this.pins[sessionKey]) {
      delete this.pins[sessionKey];
      this.persist();
    }
  }

  /** All current pins (for diagnostics / GET surfaces). */
  all(): Record<string, TopicPin> {
    this.load();
    return { ...this.pins };
  }
}
