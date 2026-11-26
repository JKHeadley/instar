/**
 * ParallelActivityIndex — a thin CROSS-topic read aggregator over the EXISTING
 * Topic-Intent Layer (docs/specs/parallel-activity-coherence.md, Phase A).
 *
 * It does NOT introduce a new per-topic store (convergence: that would duplicate
 * TopicIntentStore/TopicIntentCapture/briefing/decay). It only READS the existing
 * per-topic intent files and presents a cross-topic view — "all my topics + what
 * each is currently working on" — which is the thing that genuinely did not exist.
 * This view feeds the GET /parallel-work/activities surface and (Phase B) the
 * ParallelWorkSentinel's overlap comparison. Signal-only; never gates or mutates.
 */

import fs from 'node:fs';
import path from 'node:path';
import { TopicIntentStore, type EstablishedRef } from './TopicIntent.js';
import { describeActionNote, type ActionNote, type TopicActionNoteStore } from './TopicActionNoteStore.js';

/** Action notes older than this no longer shape a topic's focus/tags (default 24h). */
export const ACTION_NOTE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A topic's current parallel-work snapshot, derived from its intent refs. */
export interface TopicActivity {
  topicId: number;
  /** One-line current focus: the highest-tier goal, else the latest decision, else null. */
  focus: string | null;
  /** High-specificity tokens (entities/files/identifiers) for cheap overlap matching. */
  tags: string[];
  /** Count of established refs at/above the 'tentative' tier (how "settled" the topic is). */
  refCount: number;
  /** Most recent reinforcement across the topic's refs OR action note (freshness; null if unknown). */
  updatedAt: number | null;
  /**
   * The latest ACTION-derived note for the topic (CMT-810): what this topic last
   * claimed it would do, or asked the operator to approve — written automatically
   * by the action-claim observer, so it is current even while the conversational
   * intent refs lag. Null when no note is within the window.
   */
  lastAction: { kind: ActionNote['kind']; verb: string; excerpt: string; at: number } | null;
}

/** Generic instar/domain boilerplate that must NOT count as overlap specificity. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'be',
  'this', 'that', 'it', 'we', 'i', 'you', 'will', 'should', 'add', 'use', 'using', 'make',
  'fix', 'fixing', 'test', 'tests', 'testing', 'config', 'configure', 'pr', 'spec', 'topic',
  'sentinel', 'hook', 'session', 'sessions', 'migration', 'migrate', 'work', 'working',
  'build', 'building', 'change', 'changes', 'update', 'updates', 'wire', 'wiring', 'run',
  'running', 'check', 'checks', 'new', 'task', 'feature', 'code', 'agent', 'instar',
]);

/**
 * Extract high-specificity tokens from free text: identifiers, file paths, branch-ish
 * names, camelCase/kebab/snake words, and rare ≥4-char words — minus boilerplate. Bare
 * generic words are dropped so two topics that merely both say "fix the test" don't match.
 */
/**
 * Which topics currently have a live session, resolved the SAME way the HTTP
 * layer resolves a session's topic: from the tmux session name, through the
 * messaging adapter's registry.
 *
 * Earned 2026-08-14. The caller in AgentServer read `s.topicId` off the running
 * sessions, behind the cast `as Array<{ topicId?: number | null }>`. A `Session`
 * declares NO topic field at all (see types.ts) and nothing attaches one at
 * runtime — so the guard `typeof s.topicId === 'number'` was ALWAYS false, the
 * set was ALWAYS empty, and `running` came back false for every topic forever.
 * The cast is what let it ship: it asserted a field the type does not have, so
 * the compiler could never object.
 *
 * The index's own unit tests passed throughout, because they inject a stub
 * `isRunning`. That is why this lives here as a pure, directly-testable
 * function rather than inline at the wiring site: the bug was in the WIRING,
 * and only a test that feeds it real-shaped Session objects can catch it.
 */
export function runningTopicIds(
  sessions: ReadonlyArray<{ tmuxSession?: string | null }>,
  resolveTopic: (tmuxSession: string) => number | null | undefined,
): Set<number> {
  const ids = new Set<number>();
  for (const s of sessions) {
    const name = typeof s?.tmuxSession === 'string' ? s.tmuxSession : '';
    if (!name) continue;
    let topicId: number | null | undefined;
    try {
      topicId = resolveTopic(name);
    } catch {
      continue; // one unresolvable session must not blind the whole set
    }
    if (typeof topicId === 'number' && Number.isFinite(topicId)) ids.add(topicId);
  }
  return ids;
}

export function extractTags(text: string): string[] {
  const out = new Set<string>();
  if (!text) return [];
  // Path-ish / identifier-ish tokens (contain / . _ - or camelCase) are high-specificity.
  const specific = text.match(/[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]/g) ?? [];
  for (const raw of specific) {
    const tok = raw.toLowerCase();
    const isCompound = /[._/-]/.test(raw) || /[a-z][A-Z]/.test(raw); // path/identifier/camelCase
    if (isCompound && tok.length >= 3) { out.add(tok); continue; }
    // plain word: keep only if rare-ish (≥4 chars) and not boilerplate
    if (tok.length >= 4 && !STOPWORDS.has(tok)) out.add(tok);
  }
  return [...out];
}

export interface ParallelActivityIndexOptions {
  stateDir: string;
  /** Optional: resolve a topic's one-line purpose (e.g. TopicMemory.purpose) as a focus fallback. */
  purposeFor?: (topicId: number) => string | null | undefined;
  /** Optional: is a session/autonomous job live on this topic right now? */
  isRunning?: (topicId: number) => boolean;
  /** Optional: a human nickname for the topic. */
  nicknameFor?: (topicId: number) => string | null | undefined;
  /**
   * Optional refs provider seam (testability + wiring-integrity). Defaults to the
   * real TopicIntentStore.getRefsAtOrAbove(topicId,'tentative'). Production never
   * sets this; tests inject controlled refs without fighting projectConfidence.
   */
  getRefs?: (topicId: number, nowMs: number) => EstablishedRef[];
  /**
   * Action-derived notes (CMT-810). When provided, the index unions note-bearing
   * topics into its topic list, lets a note newer than the latest goal/decision
   * ref become the topic's focus, and folds the note's words into the tag set.
   */
  actionNotes?: Pick<TopicActionNoteStore, 'latest' | 'listTopicIds'> | null;
  /** How long an action note keeps shaping focus/tags (default ACTION_NOTE_WINDOW_MS). */
  actionNoteWindowMs?: number;
}

export class ParallelActivityIndex {
  private readonly store: TopicIntentStore;
  private readonly intentDir: string;

  constructor(private readonly opts: ParallelActivityIndexOptions) {
    this.store = new TopicIntentStore(opts.stateDir);
    this.intentDir = path.join(opts.stateDir, 'topic-intent');
  }

  /** Enumerate every topic that has an intent file OR an action note. */
  listTopicIds(): number[] {
    const ids = new Set<number>();
    try {
      for (const n of fs.readdirSync(this.intentDir)) {
        const m = n.match(/^(\d+)\.json$/);
        if (m) ids.add(Number(m[1]));
      }
    } catch {
      /* no intent dir yet — action notes may still name topics */
    }
    try {
      for (const id of this.opts.actionNotes?.listTopicIds() ?? []) ids.add(id);
    } catch {
      /* a broken notes dir must not blind the intent-backed topics */
    }
    return [...ids].sort((a, b) => a - b);
  }

  /** Build the cross-topic snapshot. nowMs lets tests pin time; defaults to live. */
  activities(nowMs: number = Date.now()): Array<TopicActivity & { nickname: string | null; running: boolean }> {
    return this.listTopicIds().map((topicId) => {
      const refs = this.safeRefs(topicId, nowMs);
      const note = this.safeLatestNote(topicId, nowMs);
      const refsUpdatedAt = refs.reduce<number | null>((acc, r) => {
        const ms = tsOf(r);
        return ms !== null && (acc === null || ms > acc) ? ms : acc;
      }, null);
      const focus = this.deriveFocus(refs, topicId, note);
      const updatedAt =
        note && (refsUpdatedAt === null || note.atMs > refsUpdatedAt) ? note.atMs : refsUpdatedAt;
      const tagSet = new Set<string>();
      for (const r of refs) for (const t of extractTags(r.text)) tagSet.add(t);
      if (note) {
        tagSet.add(note.verb);
        for (const t of extractTags(note.excerpt)) tagSet.add(t);
      }
      const purpose = this.opts.purposeFor?.(topicId);
      if (purpose) for (const t of extractTags(purpose)) tagSet.add(t);
      return {
        topicId,
        focus,
        tags: [...tagSet],
        refCount: refs.length,
        updatedAt,
        lastAction: note ? { kind: note.kind, verb: note.verb, excerpt: note.excerpt, at: note.atMs } : null,
        nickname: this.opts.nicknameFor?.(topicId) ?? null,
        running: this.opts.isRunning?.(topicId) ?? false,
      };
    });
  }

  private safeRefs(topicId: number, nowMs: number): EstablishedRef[] {
    try {
      if (this.opts.getRefs) return this.opts.getRefs(topicId, nowMs);
      return this.store.getRefsAtOrAbove(topicId, 'tentative', nowMs);
    } catch {
      return [];
    }
  }

  private safeLatestNote(topicId: number, nowMs: number): ActionNote | null {
    try {
      return this.opts.actionNotes?.latest(topicId, nowMs, this.opts.actionNoteWindowMs ?? ACTION_NOTE_WINDOW_MS) ?? null;
    } catch {
      // @silent-fallback-ok: a broken notes provider must not blind the intent-backed
      // row (same contract as safeRefs); the row is served without its action note.
      return null;
    }
  }

  /**
   * Focus = the action note when it is NEWER than every goal/decision ref (what the
   * topic is doing right now beats what it said it wanted earlier — the 14:34 restart
   * request must outrank the 14:13 goal), else the most-recently-reinforced goal, else
   * the latest decision, else purpose, else null.
   */
  private deriveFocus(refs: EstablishedRef[], topicId: number, note: ActionNote | null): string | null {
    const latestOfKind = (kind: EstablishedRef['kind']): EstablishedRef | null => {
      const matching = refs.filter((r) => r.kind === kind && r.text);
      if (!matching.length) return null;
      return matching.reduce((a, b) => ((tsOf(b) ?? 0) > (tsOf(a) ?? 0) ? b : a));
    };
    const goal = latestOfKind('goal');
    const decision = latestOfKind('decision');
    const newestRefMs = Math.max(goal ? tsOf(goal) ?? 0 : 0, decision ? tsOf(decision) ?? 0 : 0);
    if (note && note.atMs > newestRefMs) return describeActionNote(note);
    return goal?.text ?? decision?.text ?? this.opts.purposeFor?.(topicId) ?? null;
  }
}

/** Parse an EstablishedRef's ISO lastReinforcedAt to epoch ms; null if unparseable. */
function tsOf(ref: EstablishedRef): number | null {
  const ms = Date.parse(ref.lastReinforcedAt);
  return Number.isNaN(ms) ? null : ms;
}
