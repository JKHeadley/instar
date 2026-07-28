/**
 * CollaborationSurfacer — the single funnel for making Threadline activity
 * visible to the operator WITHOUT spawning a topic per event (CMT-509 §2 +
 * CMT-519 notification routing).
 *
 * Routing spine (operator directives 2026-05-25):
 *  - A conversation WITH a parent topic surfaces THERE via TopicLinkageHandler —
 *    this surfacer does NOT touch its *content* (real replies).
 *  - A PARENTLESS conversation (a peer reached out cold) surfaces to a SINGLE
 *    dedicated "Threadline" Telegram topic — created on demand once and reused,
 *    NEVER the generic attention list, NEVER a per-thread/per-event topic.
 *  - STATUS / housekeeping notices (loop-gate wind-down, etc. — `notify()`) go to
 *    that SAME silent hub, NEVER the parent topic the operator is working in (D1).
 *
 * Near-silent by design (D2): the hub is SILENT — agent-to-agent activity does
 * not buzz the operator and is never framed as "waiting for you" (it isn't the
 * operator's job by default). The hub is a calm, browsable record; the operator
 * engages it on their own schedule ("open this" / "tie this to <topic>"). The
 * only thing that breaks silence is a genuine user-facing escalation, which
 * surfaces normally via its parent topic — not through this surfacer.
 *
 * One post per parentless conversation (`surface()` dedupes per thread). Never
 * emits raw envelope/JSON.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface SurfacerTelegram {
  findOrCreateForumTopic(name: string, iconColor?: number, opts?: { origin?: 'user' | 'system' | 'auto'; label?: string }): Promise<{ topicId: number; name: string; reused: boolean }>;
  sendToTopic(topicId: number, text: string, options?: { silent?: boolean; skipStallClear?: boolean }): Promise<unknown>;
}

export interface CollaborationSurfacerConfig {
  telegram: SurfacerTelegram;
  stateDir: string;
  /** Override the state filename (tests). */
  stateFilename?: string;
  /** Dedicated topic display name. */
  topicName?: string;
  log?: { warn: (m: string) => void };
}

export interface SurfaceInput {
  threadId: string;
  senderName: string;
  text: string;
  /** True if the conversation is bound to a parent topic (→ surfaced elsewhere). */
  hasParentTopic: boolean;
  /** The warrants-a-reply gate verdict (substantive content). */
  warrants: boolean;
}

export interface SurfaceResult {
  surfaced: boolean;
  reason: string;
  topicId?: number;
}

/** A STATUS / housekeeping notice (loop-gate, etc.) — hub-only, never parent. */
export interface NotifyInput {
  threadId: string;
  title: string;
  body: string;
  peerName?: string;
}

/** Per-conversation record in the hub (replaces the legacy string[] of threadIds). */
export interface SurfacedThreadRecord {
  threadId: string;
  peerName: string;
  subject?: string;
  surfacedAt: string; // ISO
  bound: boolean;     // true once "open this" / "tie this to X" bound it to a topic
}

interface SurfaceState {
  dedicatedTopicId?: number;
  surfaced: SurfacedThreadRecord[];
}

const MAX_GIST_LEN = 240;
const MAX_SURFACED = 500; // bound the record list

export class CollaborationSurfacer {
  private telegram: SurfacerTelegram;
  private filePath: string;
  private topicName: string;
  private log: { warn: (m: string) => void };

  constructor(config: CollaborationSurfacerConfig) {
    this.telegram = config.telegram;
    const dir = path.join(config.stateDir, 'threadline');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, config.stateFilename ?? 'collaboration-surface.json');
    this.topicName = config.topicName ?? 'Threadline';
    this.log = config.log ?? console;
  }

  /**
   * Surface a PARENTLESS first-contact conversation to the silent hub. Idempotent
   * per thread. Never throws (best-effort; must not break the inbound path).
   */
  async surface(input: SurfaceInput): Promise<SurfaceResult> {
    try {
      if (input.hasParentTopic) return { surfaced: false, reason: 'has-parent-topic' };
      if (!input.warrants) return { surfaced: false, reason: 'not-warranted' };

      const state = this.load();
      if (state.surfaced.some(r => r.threadId === input.threadId)) {
        return { surfaced: false, reason: 'already-surfaced' };
      }

      const topicId = await this.ensureHubTopic(state);
      const gist = this.readableGist(input.text);
      const peer = this.readablePeer(input.senderName);
      const body = `🧵 ${peer} started a Threadline conversation:\n${gist}\n\n(reply in-thread, or say "open this" to give it its own topic)`;
      await this.telegram.sendToTopic(topicId, body, { silent: true });

      state.surfaced.push({
        threadId: input.threadId,
        peerName: peer,
        subject: gist.slice(0, 80),
        surfacedAt: new Date().toISOString(),
        bound: false,
      });
      this.trimAndSave(state);
      return { surfaced: true, reason: 'posted', topicId };
    } catch (err) {
      this.log.warn(`[CollaborationSurfacer] surface failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return { surfaced: false, reason: 'error' };
    }
  }

  /**
   * Post a STATUS / housekeeping notice to the SILENT hub. Used by threadline
   * subsystems (loop-gate wind-down, etc.) INSTEAD of `createAttentionItem` —
   * so they never spawn a per-event topic and never clutter the parent topic
   * the operator is working in (D1). Silent (D2). Never throws.
   */
  async notify(input: NotifyInput): Promise<SurfaceResult> {
    try {
      const state = this.load();
      const topicId = await this.ensureHubTopic(state);
      const peer = input.peerName ? this.readablePeer(input.peerName) : undefined;
      const head = peer ? `🧵 ${input.title} — ${peer}` : `🧵 ${input.title}`;
      const body = `${head}\n${this.readableGist(input.body)}`;
      await this.telegram.sendToTopic(topicId, body, { silent: true });
      // Persist the hub-topic id if we just created it; status notices are not
      // per-thread-deduped (a status can legitimately recur).
      this.trimAndSave(state);
      return { surfaced: true, reason: 'notified', topicId };
    } catch (err) {
      this.log.warn(`[CollaborationSurfacer] notify failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return { surfaced: false, reason: 'error' };
    }
  }

  /** The dedicated hub topic id, if one has been created. */
  getHubTopicId(): number | undefined {
    return this.load().dedicatedTopicId;
  }

  /**
   * The most-recently-surfaced conversation not yet bound to its own topic —
   * the default target for a bare "open this" in the hub. Returns null when the
   * choice is ambiguous (>1 unbound) so the caller can ask the operator which.
   */
  mostRecentUnbound(): { record: SurfacedThreadRecord | null; ambiguous: boolean } {
    const unbound = this.load().surfaced.filter(r => !r.bound);
    if (unbound.length === 0) return { record: null, ambiguous: false };
    const sorted = [...unbound].sort((a, b) => b.surfacedAt.localeCompare(a.surfacedAt));
    return { record: sorted[0], ambiguous: unbound.length > 1 };
  }

  /** Mark a surfaced conversation as bound (after "open this" / "tie this to X"). */
  markBound(threadId: string): void {
    const state = this.load();
    const rec = state.surfaced.find(r => r.threadId === threadId);
    if (rec && !rec.bound) {
      rec.bound = true;
      this.trimAndSave(state);
    }
  }

  /** Post a one-line note into the hub (e.g. "Opened → topic <name>"). */
  async noteInHub(text: string): Promise<void> {
    try {
      const state = this.load();
      const topicId = await this.ensureHubTopic(state);
      await this.telegram.sendToTopic(topicId, text, { silent: true });
      this.trimAndSave(state);
    } catch (err) {
      this.log.warn(`[CollaborationSurfacer] noteInHub failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── internals ──────────────────────────────────────────────────

  private async ensureHubTopic(state: SurfaceState): Promise<number> {
    if (typeof state.dedicatedTopicId === 'number') return state.dedicatedTopicId;
    const t = await this.telegram.findOrCreateForumTopic(this.topicName, undefined, { label: 'collaboration-surfacer' });
    state.dedicatedTopicId = t.topicId;
    return t.topicId;
  }

  /** A readable, capped gist — NEVER raw envelope/JSON. */
  private readableGist(text: string): string {
    let t = (text ?? '').trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        const parsed = JSON.parse(t);
        const extracted = (parsed && (parsed.text ?? parsed.content ?? parsed.body ?? parsed.message));
        t = typeof extracted === 'string' && extracted.trim() ? extracted.trim() : '(structured message)';
      } catch {
        t = '(message)';
      }
    }
    t = t.replace(/\s+/g, ' ').trim();
    if (!t) return '(no preview)';
    return t.length > MAX_GIST_LEN ? t.slice(0, MAX_GIST_LEN - 1) + '…' : t;
  }

  private readablePeer(name: string): string {
    const n = (name ?? '').trim();
    if (!n) return 'An agent';
    if (/^[a-f0-9]{16,}$/i.test(n)) return n.slice(0, 8);
    return n;
  }

  /**
   * Load state with a READ-TIME MIGRATION from the legacy `surfacedThreads:
   * string[]` shape to the `surfaced: SurfacedThreadRecord[]` shape. A legacy
   * file's threadIds become bound:false records with an unknown peer.
   */
  private load(): SurfaceState {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (data && typeof data === 'object') {
          if (Array.isArray(data.surfaced)) {
            return { dedicatedTopicId: data.dedicatedTopicId, surfaced: data.surfaced as SurfacedThreadRecord[] };
          }
          if (Array.isArray(data.surfacedThreads)) {
            // Legacy → records. The legacy array is append-ordered (newest last),
            // so stamp surfacedAt by INDEX (not a constant epoch) to preserve that
            // ordering — otherwise mostRecentUnbound() can't tell legacy entries
            // apart (D3). index+1 ms keeps them all in 1970 (older than any real
            // `new Date()` surfacing) while ordering them by original arrival.
            const surfaced: SurfacedThreadRecord[] = (data.surfacedThreads as string[]).map((threadId, index) => ({
              threadId,
              peerName: 'An agent',
              surfacedAt: new Date(index + 1).toISOString(),
              bound: false,
            }));
            return { dedicatedTopicId: data.dedicatedTopicId, surfaced };
          }
          if (typeof data.dedicatedTopicId === 'number') {
            return { dedicatedTopicId: data.dedicatedTopicId, surfaced: [] };
          }
        }
      }
    } catch { /* corrupt — start fresh */ }
    return { surfaced: [] };
  }

  private trimAndSave(state: SurfaceState): void {
    if (state.surfaced.length > MAX_SURFACED) {
      state.surfaced = state.surfaced.slice(-MAX_SURFACED);
    }
    try {
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      this.log.warn(`[CollaborationSurfacer] state persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
