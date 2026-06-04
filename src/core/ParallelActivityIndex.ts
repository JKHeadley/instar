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

/** A topic's current parallel-work snapshot, derived from its intent refs. */
export interface TopicActivity {
  topicId: number;
  /** One-line current focus: the highest-tier goal, else the latest decision, else null. */
  focus: string | null;
  /** High-specificity tokens (entities/files/identifiers) for cheap overlap matching. */
  tags: string[];
  /** Count of established refs at/above the 'tentative' tier (how "settled" the topic is). */
  refCount: number;
  /** Most recent reinforcement across the topic's refs (freshness; null if unknown). */
  updatedAt: number | null;
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
}

export class ParallelActivityIndex {
  private readonly store: TopicIntentStore;
  private readonly intentDir: string;

  constructor(private readonly opts: ParallelActivityIndexOptions) {
    this.store = new TopicIntentStore(opts.stateDir);
    this.intentDir = path.join(opts.stateDir, 'topic-intent');
  }

  /** Enumerate every topic that has an intent file. */
  listTopicIds(): number[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.intentDir);
    } catch {
      return []; // no intent dir yet ⇒ no activities
    }
    const ids: number[] = [];
    for (const n of names) {
      const m = n.match(/^(\d+)\.json$/);
      if (m) ids.push(Number(m[1]));
    }
    return ids.sort((a, b) => a - b);
  }

  /** Build the cross-topic snapshot. nowMs lets tests pin time; defaults to live. */
  activities(nowMs: number = Date.now()): Array<TopicActivity & { nickname: string | null; running: boolean }> {
    return this.listTopicIds().map((topicId) => {
      const refs = this.safeRefs(topicId, nowMs);
      const focus = this.deriveFocus(refs, topicId);
      const updatedAt = refs.reduce<number | null>((acc, r) => {
        const ms = tsOf(r);
        return ms !== null && (acc === null || ms > acc) ? ms : acc;
      }, null);
      const tagSet = new Set<string>();
      for (const r of refs) for (const t of extractTags(r.text)) tagSet.add(t);
      const purpose = this.opts.purposeFor?.(topicId);
      if (purpose) for (const t of extractTags(purpose)) tagSet.add(t);
      return {
        topicId,
        focus,
        tags: [...tagSet],
        refCount: refs.length,
        updatedAt,
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

  /** Focus = most-recently-reinforced goal text, else the latest decision, else purpose, else null. */
  private deriveFocus(refs: EstablishedRef[], topicId: number): string | null {
    const latestByKind = (kind: EstablishedRef['kind']): string | null => {
      const matching = refs.filter((r) => r.kind === kind && r.text);
      if (!matching.length) return null;
      const latest = matching.reduce((a, b) => ((tsOf(b) ?? 0) > (tsOf(a) ?? 0) ? b : a));
      return latest.text;
    };
    return latestByKind('goal') ?? latestByKind('decision') ?? this.opts.purposeFor?.(topicId) ?? null;
  }
}

/** Parse an EstablishedRef's ISO lastReinforcedAt to epoch ms; null if unparseable. */
function tsOf(ref: EstablishedRef): number | null {
  const ms = Date.parse(ref.lastReinforcedAt);
  return Number.isNaN(ms) ? null : ms;
}
