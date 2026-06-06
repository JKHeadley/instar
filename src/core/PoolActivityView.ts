/**
 * PoolActivityView — P4.1 of multi-machine coherence: the pool-wide fold
 * behind `GET /parallel-work/activities?scope=pool` — "what is every machine
 * of mine working on, and is anything overlapping?".
 *
 * Spec: docs/specs/POOL-WIDE-PARALLEL-WORK-SPEC.md §3.
 *
 * Rules (all round-1-earned):
 *  - NET-NEW code on the reader's raw query() path (readOwnAutonomousRuns is
 *    own-stream-only by construction; no lifecycle helper exists).
 *  - The pool response is a DISCRIMINATED union (`kind: 'local'|'remote'`);
 *    absent fields are NAMED nulls, never fabricated.
 *  - `running` provenance asymmetry is structural: local rows are live
 *    in-memory truth; remote rows are replica-derived, staleness-tagged.
 *  - Remote `running` is derived PER INSTANCE (per sessionId / runId) then
 *    aggregated — a later terminal for session B never masks a
 *    still-running session A.
 *  - A `running:true` from a fold that hit a read bound carries
 *    `lowConfidence: true` (staleness measures recency, not completeness).
 *  - `possibleOverlap` flags EVERY machine pair showing the same topicId
 *    running (local↔remote and remote↔remote), annotated
 *    `recentMove: true` when the answer-complete placement stream shows an
 *    epoch change within the post-transfer closeout window.
 *  - SIGNAL ONLY: the view never gates, moves, or kills.
 */

import type { CoherenceJournalReader, ReaderEntry } from './CoherenceJournalReader.js';

export const RECENT_MOVE_WINDOW_MS = 10 * 60 * 1000;

export interface LocalActivityRow {
  kind: 'local';
  topicId: string;
  machineId: string;
  focus: string | null;
  tags: string[];
  refCount: number | null;
  updatedAt: string | null;
  nickname: string | null;
  running: boolean;
  stalenessMs: 0;
  intentVisibility: 'local';
  possibleOverlap?: string[];
  recentMove?: boolean;
}

export interface RemoteActivityRow {
  kind: 'remote';
  topicId: string;
  machineId: string;
  focus: null;
  tags: [];
  refCount: null;
  updatedAt: null;
  nickname: null;
  running: boolean;
  lastEventAt: string | null;
  lastEventKind: string | null;
  stalenessMs: number;
  artifactsKnown: boolean;
  intentVisibility: 'machine-local';
  lowConfidence?: boolean;
  possibleOverlap?: string[];
  recentMove?: boolean;
}

export type PoolActivityRow = LocalActivityRow | RemoteActivityRow;

export interface PoolViewDeps {
  ownMachineId: string;
  /** Today's local rows (ParallelActivityIndex.activities() shape). */
  local: Array<{ topicId: number; focus: string | null; tags: string[]; refCount: number; updatedAt: number | null; nickname: string | null; running: boolean }>;
  reader: CoherenceJournalReader;
  limit?: number;
}

export interface PoolViewResult {
  rows: PoolActivityRow[];
  pool: { selfMachineId: string; replicasRead: number; boundHit: boolean };
}

export function buildPoolActivityView(deps: PoolViewDeps): PoolViewResult {
  const rows: PoolActivityRow[] = deps.local.map((a) => ({
    kind: 'local' as const,
    topicId: String(a.topicId),
    machineId: deps.ownMachineId,
    focus: a.focus ?? null,
    tags: a.tags ?? [],
    refCount: a.refCount ?? null,
    updatedAt: a.updatedAt != null ? new Date(a.updatedAt).toISOString() : null,
    nickname: a.nickname ?? null,
    running: a.running,
    stalenessMs: 0 as const,
    intentVisibility: 'local' as const,
  }));

  // Replica folds: per-machine per-topic instance states from BOTH kinds.
  const limit = deps.limit ?? 500;
  const lifecycle = deps.reader.query({ kind: 'session-lifecycle', limit });
  const runs = deps.reader.query({ kind: 'autonomous-run', limit });
  const boundHit = lifecycle.truncated || runs.truncated;

  // (machine, topic) → instance maps. Entries arrive newest-first: the
  // FIRST entry seen per instance is its latest state.
  interface TopicAgg {
    instances: Map<string, boolean>; // instanceId → active
    lastEventAt: string | null;
    lastEventKind: string | null;
    stalenessMs: number;
    artifactsKnown: boolean;
  }
  const remote = new Map<string, TopicAgg>(); // `${machine}::${topic}`
  const replicaMachines = new Set<string>();

  const TERMINAL_LIFECYCLE = new Set(['completed', 'killed', 'reaped', 'failed']);

  function aggFor(machine: string, topic: number, staleness: number): TopicAgg {
    const key = `${machine}::${topic}`;
    let agg = remote.get(key);
    if (!agg) {
      agg = { instances: new Map(), lastEventAt: null, lastEventKind: null, stalenessMs: staleness, artifactsKnown: false };
      remote.set(key, agg);
    }
    return agg;
  }

  for (const e of lifecycle.entries as ReaderEntry[]) {
    if (e.source !== 'replica' || typeof e.topic !== 'number') continue;
    replicaMachines.add(e.machine);
    const d = e.data as { sessionId?: string; status?: string };
    if (!d.sessionId || !d.status) continue;
    const staleness = lifecycle.streams[`${e.machine}.session-lifecycle`]?.stalenessMs ?? 0;
    const agg = aggFor(e.machine, e.topic, staleness);
    if (!agg.lastEventAt) {
      agg.lastEventAt = e.ts;
      agg.lastEventKind = `session-${d.status}`;
    }
    if (!agg.instances.has(`s:${d.sessionId}`)) {
      agg.instances.set(`s:${d.sessionId}`, !TERMINAL_LIFECYCLE.has(d.status));
    }
  }
  for (const e of runs.entries as ReaderEntry[]) {
    if (e.source !== 'replica' || typeof e.topic !== 'number') continue;
    replicaMachines.add(e.machine);
    const d = e.data as { runId?: string; action?: string; artifactPaths?: unknown[] };
    if (!d.runId || !d.action) continue;
    const staleness = runs.streams[`${e.machine}.autonomous-run`]?.stalenessMs ?? 0;
    const agg = aggFor(e.machine, e.topic, staleness);
    if (!agg.lastEventAt || e.ts > agg.lastEventAt) {
      agg.lastEventAt = e.ts;
      agg.lastEventKind = `run-${d.action}`;
    }
    if (Array.isArray(d.artifactPaths) && d.artifactPaths.length > 0) agg.artifactsKnown = true;
    if (!agg.instances.has(`r:${d.runId}`)) {
      agg.instances.set(`r:${d.runId}`, d.action === 'started');
    }
  }

  for (const [key, agg] of remote) {
    const [machine, topic] = key.split('::');
    const running = [...agg.instances.values()].some(Boolean); // ANY active instance
    rows.push({
      kind: 'remote',
      topicId: topic,
      machineId: machine,
      focus: null,
      tags: [],
      refCount: null,
      updatedAt: null,
      nickname: null,
      running,
      lastEventAt: agg.lastEventAt,
      lastEventKind: agg.lastEventKind,
      stalenessMs: agg.stalenessMs,
      artifactsKnown: agg.artifactsKnown,
      intentVisibility: 'machine-local',
      ...(running && boundHit ? { lowConfidence: true } : {}),
    });
  }

  annotateOverlaps(rows, deps.reader);
  return { rows, pool: { selfMachineId: deps.ownMachineId, replicasRead: replicaMachines.size, boundHit } };
}

/** Every machine PAIR running the same topicId (local↔remote AND remote↔remote). */
function annotateOverlaps(rows: PoolActivityRow[], reader: CoherenceJournalReader): void {
  const running = rows.filter((r) => r.running);
  const byTopic = new Map<string, PoolActivityRow[]>();
  for (const r of running) {
    (byTopic.get(r.topicId) ?? byTopic.set(r.topicId, []).get(r.topicId)!).push(r);
  }
  for (const [topicId, group] of byTopic) {
    const machines = new Set(group.map((g) => g.machineId));
    if (machines.size < 2) continue;
    // Known benign transient: a recent placement epoch change (the
    // post-transfer closeout window) — annotate, don't cry wolf.
    let recentMove = false;
    try {
      const p = reader.query({ kind: 'topic-placement', topic: Number(topicId), limit: 1 }).entries[0];
      if (p && Date.now() - new Date(p.ts).getTime() < RECENT_MOVE_WINDOW_MS) recentMove = true;
    } catch { /* @silent-fallback-ok: missing placement evidence just means no recentMove annotation — the overlap flag still surfaces (POOL-WIDE-PARALLEL-WORK-SPEC §2) */
    }
    for (const r of group) {
      r.possibleOverlap = group.filter((g) => g !== r).map((g) => g.machineId);
      if (recentMove) r.recentMove = true;
    }
  }
}
