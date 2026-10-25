/**
 * TopicActionNoteStore — durable, action-derived activity notes per topic
 * (CMT-810; extends docs/specs/parallel-activity-coherence.md Phase A).
 *
 * WHY THIS EXISTS. The cross-topic activity index was a pure read over topic-intent
 * refs, and those refs come ONLY from conversation extraction. So the index was stale
 * exactly when a session was busy doing something important: on 2026-10-14 topic
 * 102965 asked the operator to approve a Mac Studio restart at 14:34, while its index
 * entry still read a 14:13 goal about idle cleanup — and read it two hours later. A
 * sibling session in topic 61449 had told the operator to hold off on that same
 * restart, and at 16:19 said it did not know who had restarted the machine.
 *
 * This store is the ACTION-derived write path: when the action-claim observer
 * classifies a concrete action claim ("I'll restart it") or an operator-approval
 * request ("may I restart the Studio?") for a topic, it records ONE small note here,
 * automatically, at the moment the turn finishes (Structure > Willpower — no session
 * has to remember to post an update). ParallelActivityIndex reads these notes and
 * surfaces the latest one as the topic's focus + tags, so a second session asking
 * "what are my other hands doing?" sees the pending restart immediately.
 *
 * Deliberately NOT written into TopicIntentStore: intent refs carry a confidence /
 * decay model and feed the session briefing; an action note is a timestamped fact,
 * not a proposition to reinforce, and must not pollute the briefing's intent arcs.
 *
 * Posture: machine-local BY DESIGN, like the topic-intent files it sits beside — the
 * index is a local read; the pool view (?scope=pool) carries local rows outward.
 * Signal-only: nothing reads these notes to gate, block, or mutate anything.
 * Never throws out of its public API (a failed write must never break the Stop hook
 * path that feeds it).
 */

import fs from 'node:fs';
import path from 'node:path';

export type ActionNoteKind = 'action-claim' | 'approval-request';

export interface ActionNote {
  kind: ActionNoteKind;
  /** Canonical lemma of the action (restart / reboot / push / …). */
  verb: string;
  /** Bounded, secret-scrubbed sentence containing the match (≤ 200 chars). */
  excerpt: string;
  /** Epoch ms when the note was recorded. */
  atMs: number;
  /** Which observer wrote it (audit). */
  source: string;
}

interface TopicActionNoteFile {
  topicId: number;
  notes: ActionNote[];
}

export interface TopicActionNoteStoreOptions {
  stateDir: string;
  /** Max notes retained per topic (oldest dropped). Default 20. */
  maxNotesPerTopic?: number;
  /** A note identical (kind+verb+excerpt) to the latest one within this window is
   *  a dedupe, not a new note (two Stop hooks can observe the same turn). Default 10 min. */
  dedupeWindowMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

export const ACTION_NOTE_EXCERPT_MAX = 200;

export class TopicActionNoteStore {
  private readonly dir: string;
  private readonly maxNotes: number;
  private readonly dedupeWindowMs: number;
  private readonly now: () => number;

  constructor(opts: TopicActionNoteStoreOptions) {
    this.dir = path.join(opts.stateDir, 'topic-action-notes');
    this.maxNotes = Math.max(1, opts.maxNotesPerTopic ?? 20);
    this.dedupeWindowMs = Math.max(0, opts.dedupeWindowMs ?? 10 * 60 * 1000);
    this.now = opts.now ?? (() => Date.now());
  }

  /** Where this store writes (tests + diagnostics). */
  get directory(): string {
    return this.dir;
  }

  /**
   * Record a note for a topic. Returns the stored note, or null when it was a
   * dedupe of the latest note or the input was invalid. Never throws.
   */
  record(
    topicId: number,
    input: { kind: ActionNoteKind; verb: string; excerpt: string; source: string; atMs?: number },
  ): { note: ActionNote; deduped: false } | { note: ActionNote; deduped: true } | null {
    if (!Number.isSafeInteger(topicId)) return null;
    if (!input || (input.kind !== 'action-claim' && input.kind !== 'approval-request')) return null;
    const verb = String(input.verb ?? '').trim().toLowerCase().slice(0, 40);
    if (!verb) return null;
    const excerpt = String(input.excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, ACTION_NOTE_EXCERPT_MAX);
    const atMs = typeof input.atMs === 'number' && Number.isFinite(input.atMs) ? input.atMs : this.now();
    const note: ActionNote = { kind: input.kind, verb, excerpt, atMs, source: String(input.source ?? 'unknown').slice(0, 60) };
    try {
      const file = this.read(topicId);
      const latest = file.notes[file.notes.length - 1];
      if (
        latest &&
        latest.kind === note.kind &&
        latest.verb === note.verb &&
        latest.excerpt === note.excerpt &&
        atMs - latest.atMs < this.dedupeWindowMs
      ) {
        return { note: latest, deduped: true };
      }
      file.notes.push(note);
      if (file.notes.length > this.maxNotes) file.notes.splice(0, file.notes.length - this.maxNotes);
      this.write(file);
      return { note, deduped: false };
    } catch {
      // @silent-fallback-ok: observability-only write on the Stop-hook path — a disk
      // error here must never break the turn that fed it; the missed note is the
      // honest outcome (the index simply does not show it), never a corrupt file.
      return null;
    }
  }

  /** All retained notes for a topic, oldest first. Empty on any read failure. */
  notes(topicId: number): ActionNote[] {
    try {
      return this.read(topicId).notes;
    } catch {
      // @silent-fallback-ok: a corrupt per-topic note file reads as "no notes" so the
      // cross-topic index keeps answering for every other topic; the next record()
      // rewrites the file whole.
      return [];
    }
  }

  /** The newest note for a topic that is at most `windowMs` old (null if none). */
  latest(topicId: number, nowMs: number = this.now(), windowMs: number = Number.POSITIVE_INFINITY): ActionNote | null {
    const all = this.notes(topicId);
    for (let i = all.length - 1; i >= 0; i--) {
      const n = all[i];
      if (nowMs - n.atMs <= windowMs) return n;
    }
    return null;
  }

  /** Every topic that has at least one note. */
  listTopicIds(): number[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      // @silent-fallback-ok: no notes directory yet (nothing observed) ⇒ no note-bearing
      // topics — the correct answer, not a degraded one.
      return [];
    }
    const ids: number[] = [];
    for (const n of names) {
      const m = n.match(/^(-?\d+)\.json$/);
      if (m) ids.push(Number(m[1]));
    }
    return ids.sort((a, b) => a - b);
  }

  private filePath(topicId: number): string {
    return path.join(this.dir, `${topicId}.json`);
  }

  private read(topicId: number): TopicActionNoteFile {
    const p = this.filePath(topicId);
    if (!fs.existsSync(p)) return { topicId, notes: [] };
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<TopicActionNoteFile>;
    const notes = Array.isArray(raw.notes)
      ? raw.notes.filter(
          (n): n is ActionNote =>
            !!n &&
            (n.kind === 'action-claim' || n.kind === 'approval-request') &&
            typeof n.verb === 'string' &&
            typeof n.excerpt === 'string' &&
            typeof n.atMs === 'number' &&
            Number.isFinite(n.atMs),
        )
      : [];
    return { topicId, notes };
  }

  private write(file: TopicActionNoteFile): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const p = this.filePath(file.topicId);
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  }
}

/** Human-readable focus line for an action note (what a second session reads). */
export function describeActionNote(note: ActionNote): string {
  const head =
    note.kind === 'approval-request'
      ? `Asked the operator to approve: ${note.verb}`
      : `Acting: ${note.verb}`;
  return note.excerpt ? `${head} — "${note.excerpt}"` : head;
}
