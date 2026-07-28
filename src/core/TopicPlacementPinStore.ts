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

/**
 * U4.1 §2F (Know Your Principal): WHO set the pin — LOCAL-ONLY provenance.
 * `operator` = resolved from the topic's auto-bound VERIFIED operator
 * (TopicOperatorStore) when the authenticated request carried one; `agent` =
 * a Bearer-authed agent-initiated pin (a legitimate pin author). NEVER
 * replicated — the replicated `topic-pin-record` stays deliberately non-PII.
 * Serve-time length-clamped on the Bearer-gated read surface.
 */
export type TopicPinnedBy =
  | { kind: 'operator'; platform: string; uid: string }
  | { kind: 'agent'; sessionRef: string };

/** One persisted pin: the resolved target machine + when it was set. */
export interface TopicPin {
  preferredMachine: string;
  pinned: boolean;
  updatedAt: string;
  /**
   * Cross-machine convergence (Fix #2 / Finding N3): the HLC stamped when this pin was
   * set, so the reconciler can HLC-ORDER the local pin against a replicated advisory pin
   * (a skew-PROOF comparison, never wall-clock). Absent on pre-Fix-#2 pins → the reconciler
   * derives a fallback HLC from `updatedAt` on read (the documented migration). Structural
   * type (not the HlcTimestamp import) to keep this low-level store dependency-free.
   */
  hlc?: { physical: number; logical: number; node: string };
  /** U4.1 §2F: local-only pin provenance (never replicated; see TopicPinnedBy). */
  pinnedBy?: TopicPinnedBy;
}

export interface TopicPlacementPinStoreDeps {
  /** File the pins persist to (JSON). */
  filePath: string;
  /** Wall clock — injectable for tests. Defaults to `Date`. */
  now?: () => Date;
  /**
   * U4.1 §2C loud durability: fired when a CORRUPT pin file is quarantined
   * aside (the aside path + the parse error). The caller raises the ONE
   * deduped `u41:pin-corrupt:<storeFilePath>` attention item. Optional —
   * absence never gates the quarantine itself.
   */
  onCorrupt?: (asidePath: string, error: string) => void;
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
    } catch (err) {
      // U4.1 §2C (fixes defect 3): THIS store is the AUTHORITATIVE local record
      // of operator placement intent (the replicated `topic-pin-record` is the
      // advisory one) — which is exactly why the old wipe-and-persist here was
      // success-shaped TOTAL LOSS. A corrupt file is QUARANTINED ASIDE
      // (preserved, never overwritten), reported loudly via onCorrupt (the ONE
      // deduped `u41:pin-corrupt:<path>` item), and the store resolves to
      // UNKNOWN (no pins) until the operator re-pins or restores.
      const aside = `${this.d.filePath}.corrupt-${Date.now()}`;
      try { fs.renameSync(this.d.filePath, aside); } catch { /* rename best-effort — the report below still fires; a later persist() only lands on the (now absent) canonical path */ }
      try { this.d.onCorrupt?.(aside, err instanceof Error ? err.message : String(err)); } catch { /* the report is observability — never gates the load */ }
      this.pins = {};
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

  /** Pin a topic to a machine (a hard pin). Idempotent; refreshes `updatedAt`.
   *  `hlc` (Fix #2) is the skew-proof ordering stamp; pass the same HLC that the
   *  replicated `topic-pin-record` carried so local and replicated pins compare
   *  cleanly (the U4.1 one-HLC funnel `setPinWithOneHlc` does exactly this).
   *  `pinnedBy` (U4.1 §2F) is local-only provenance — never replicated. */
  set(sessionKey: string, preferredMachine: string, pinned = true, hlc?: { physical: number; logical: number; node: string }, pinnedBy?: TopicPinnedBy): void {
    this.load();
    const now = (this.d.now ?? (() => new Date()))().toISOString();
    this.pins[sessionKey] = { preferredMachine, pinned, updatedAt: now, ...(hlc ? { hlc } : {}), ...(pinnedBy ? { pinnedBy } : {}) };
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
