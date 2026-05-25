/**
 * CollaborationSurfacer — makes PARENTLESS Threadline conversations visible to
 * the operator (CMT-509 §2).
 *
 * Routing spine (operator directive 2026-05-25):
 *  - A conversation WITH a parent topic (it was started from / is bound to a
 *    Telegram topic) surfaces THERE via TopicLinkageHandler — this surfacer does
 *    NOT touch it.
 *  - A PARENTLESS conversation (a peer reached out cold, no topic association)
 *    surfaces to a SINGLE dedicated "Threadline" Telegram topic — created on
 *    demand once and reused, NEVER the generic attention list, NEVER a per-thread
 *    topic.
 *
 * Near-silent by design: surfaces only a warranted (per the warrants-a-reply
 * gate) FIRST contact, exactly ONE post per conversation (follow-ups on an
 * already-surfaced thread do not re-post). Never emits raw envelope/JSON.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface SurfacerTelegram {
  findOrCreateForumTopic(name: string, iconColor?: number): Promise<{ topicId: number; name: string; reused: boolean }>;
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

interface SurfaceState {
  dedicatedTopicId?: number;
  surfacedThreads: string[];
}

const MAX_GIST_LEN = 240;
const MAX_SURFACED_THREADS = 500; // bound the dedupe list

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
   * Decide + surface a parentless conversation. Idempotent per thread. Never
   * throws to the caller (surfacing is best-effort; a failure must not break the
   * inbound path) — returns a structured result.
   */
  async surface(input: SurfaceInput): Promise<SurfaceResult> {
    try {
      if (input.hasParentTopic) return { surfaced: false, reason: 'has-parent-topic' };
      if (!input.warrants) return { surfaced: false, reason: 'not-warranted' };

      const state = this.load();
      if (state.surfacedThreads.includes(input.threadId)) {
        return { surfaced: false, reason: 'already-surfaced' };
      }

      let topicId = state.dedicatedTopicId;
      if (typeof topicId !== 'number') {
        const t = await this.telegram.findOrCreateForumTopic(this.topicName);
        topicId = t.topicId;
        state.dedicatedTopicId = topicId;
      }

      const gist = this.readableGist(input.text);
      const peer = this.readablePeer(input.senderName);
      const body = `🧵 ${peer} started a Threadline conversation:\n${gist}\n\n(reply in-thread, or say "open this" to engage)`;
      await this.telegram.sendToTopic(topicId, body, { silent: true });

      state.surfacedThreads.push(input.threadId);
      if (state.surfacedThreads.length > MAX_SURFACED_THREADS) {
        state.surfacedThreads = state.surfacedThreads.slice(-MAX_SURFACED_THREADS);
      }
      this.save(state);
      return { surfaced: true, reason: 'posted', topicId };
    } catch (err) {
      this.log.warn(`[CollaborationSurfacer] surface failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return { surfaced: false, reason: 'error' };
    }
  }

  /** A readable, capped gist of the peer's message — NEVER raw envelope/JSON. */
  private readableGist(text: string): string {
    let t = (text ?? '').trim();
    // Defend against the funnel's JSON.stringify(content) path reaching the user.
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        const parsed = JSON.parse(t);
        const extracted =
          (parsed && (parsed.text ?? parsed.content ?? parsed.body ?? parsed.message));
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
    // Fingerprint-looking → shorten.
    if (/^[a-f0-9]{16,}$/i.test(n)) return n.slice(0, 8);
    return n;
  }

  private load(): SurfaceState {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (data && Array.isArray(data.surfacedThreads)) return data as SurfaceState;
      }
    } catch { /* corrupt — start fresh */ }
    return { surfacedThreads: [] };
  }

  private save(state: SurfaceState): void {
    try {
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      this.log.warn(`[CollaborationSurfacer] state persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
