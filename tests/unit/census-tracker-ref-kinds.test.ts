/**
 * Tier 1 — census tracker refs are typed by KIND, and the fleet-stable kind
 * resolves against a SHIPPED SOURCE CONSTANT.
 *
 * Spec: docs/specs/census-tracker-ref-kinds.md
 *
 * The defect: all 49 pending census entries carried `pending:ACT-1193`, an
 * evolution-action id. That id is MACHINE-LOCAL; PROVENANCE_COVERAGE is a
 * shipped constant identical on every install. So the debt check could only
 * ever answer "I don't know" anywhere but the one machine that minted it.
 *
 * THE TRAP THIS FILE GUARDS (the reason the design changed mid-flight): the
 * intuitive fix — anchor to a spec DOCUMENT path and check the file exists —
 * is WORSE than the status quo, because `docs/` is excluded from the published
 * package. It would have converted 49 honest `unverifiable` into 49 fleet-wide
 * false `dead`. `packaging invariant` below is the test that makes that
 * regression impossible to reintroduce silently.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTrackerRef,
  adjudicatePendingTracker,
  type LiveEvolutionActs,
} from '../../src/server/routes.js';
import {
  BACKLOG_TRACKERS,
  backlogTrackerExists,
  PROVENANCE_COVERAGE,
} from '../../src/data/provenanceCoverage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const acts = (alive: string[], highWater: number): LiveEvolutionActs => ({
  alive: new Set(alive),
  highWater,
});

describe('parseTrackerRef — kinds, and only these kinds', () => {
  it('classifies a machine-local evolution-action id as the act kind', () => {
    expect(parseTrackerRef('ACT-1193')).toEqual({ kind: 'act', id: 'ACT-1193' });
    expect(parseTrackerRef('ACT-1')).toEqual({ kind: 'act', id: 'ACT-1' });
  });

  it('classifies a fleet-stable registry key as the backlog kind', () => {
    expect(parseTrackerRef('backlog:decision-quality-enrolment')).toEqual({
      kind: 'backlog',
      key: 'decision-quality-enrolment',
    });
  });

  it('tolerates surrounding whitespace without inventing a kind', () => {
    expect(parseTrackerRef('  ACT-7  ')).toEqual({ kind: 'act', id: 'ACT-7' });
    expect(parseTrackerRef(' backlog:a ')).toEqual({ kind: 'backlog', key: 'a' });
  });

  it('refuses garbage as unknown rather than guessing — a typo must stay visible', () => {
    for (const bad of [
      '',
      '   ',
      'ACT-',
      'ACT-abc',
      'act-1193', // case matters: the queue mints uppercase
      'backlog:',
      'backlog:Decision-Quality', // uppercase is not the key charset
      'backlog:-leading-dash',
      'backlog:has_underscore',
      'backlog:a/b', // no separators — a key is not a path
      'backlog:../escape',
      'spec:llm-decision-quality-meter#5.6', // the REJECTED design; not a kind
      'PR-1618',
      'https://example.invalid/x',
    ]) {
      expect(parseTrackerRef(bad), `'${bad}' must not parse to a known kind`).toEqual({
        kind: 'unknown',
      });
    }
  });

  it('is total over hostile input (null/undefined reach it as any in JS callers)', () => {
    expect(parseTrackerRef(undefined as unknown as string)).toEqual({ kind: 'unknown' });
    expect(parseTrackerRef(null as unknown as string)).toEqual({ kind: 'unknown' });
  });
});

describe('adjudicatePendingTracker — backlog kind (the fleet-stable path)', () => {
  it('a registered key is ALIVE', () => {
    expect(adjudicatePendingTracker('backlog:decision-quality-enrolment', acts([], 0))).toBe('alive');
  });

  it('a key absent from the registry is DEAD — a removed tracker is a real deletion', () => {
    expect(adjudicatePendingTracker('backlog:no-such-backlog', acts([], 0))).toBe('dead');
  });

  it('resolves identically with NO evolution queue at all — the whole point', () => {
    // This is the fleet install: no action-queue.json on disk. The old callsite
    // skipped adjudication entirely in this case; a fleet-stable ref must not
    // depend on machine-local state to be answerable.
    expect(adjudicatePendingTracker('backlog:decision-quality-enrolment', null)).toBe('alive');
    expect(adjudicatePendingTracker('backlog:no-such-backlog', null)).toBe('dead');
  });

  it('NEVER answers unverifiable — unreachable for this kind by construction', () => {
    for (const ref of ['backlog:decision-quality-enrolment', 'backlog:nope', 'backlog:x']) {
      for (const live of [acts([], 0), acts(['ACT-1'], 99), null]) {
        expect(adjudicatePendingTracker(ref, live)).not.toBe('unverifiable');
      }
    }
  });

  it('ignores the local evolution queue entirely (no cross-talk between kinds)', () => {
    // A machine whose queue happens to contain a similarly-named entry must not
    // change the verdict: the registry is the only authority for this kind.
    const noisy = acts(['backlog:decision-quality-enrolment', 'ACT-1193'], 9999);
    expect(adjudicatePendingTracker('backlog:no-such-backlog', noisy)).toBe('dead');
  });
});

describe('adjudicatePendingTracker — act kind stays byte-for-byte as it was', () => {
  it('a live id is ALIVE', () => {
    expect(adjudicatePendingTracker('ACT-500', acts(['ACT-500'], 900))).toBe('alive');
  });

  it('an id below the high-water mark and not alive is DEAD (a real local deletion)', () => {
    expect(adjudicatePendingTracker('ACT-500', acts(['ACT-501'], 900))).toBe('dead');
  });

  it('an id ABOVE the high-water mark is UNVERIFIABLE — minted on a peer, not deleted', () => {
    expect(adjudicatePendingTracker('ACT-1193', acts(['ACT-1'], 900))).toBe('unverifiable');
  });

  it('an unreadable queue is UNVERIFIABLE, never dead', () => {
    expect(adjudicatePendingTracker('ACT-500', null)).toBe('unverifiable');
  });

  it('a malformed ref is DEAD — it must surface, not hide in the unverifiable bucket', () => {
    expect(adjudicatePendingTracker('nonsense', acts([], 0))).toBe('dead');
    expect(adjudicatePendingTracker('spec:some-doc', acts([], 0))).toBe('dead');
  });
});

describe('the packaging invariant — why the anchor is a constant and not a doc', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    files?: string[];
  };

  it('src/data IS published, so BACKLOG_TRACKERS reaches every install', () => {
    // The registry lives in src/data/provenanceCoverage.ts and compiles to dist.
    const published = pkg.files ?? [];
    expect(
      published.some((f) => f === 'dist' || f === 'src/data' || f.startsWith('src/data')),
      'BACKLOG_TRACKERS must ship — otherwise a backlog ref cannot resolve on a fleet install',
    ).toBe(true);
  });

  it('docs/ is NOT published — a doc-path anchor would be false-dead fleet-wide', () => {
    // This is the finding that inverted the design (external review, 2026-07-25).
    // If someone later adds docs/ to files[], THIS test is where the reasoning
    // is recorded — re-read the spec before treating doc paths as resolvable.
    const published = pkg.files ?? [];
    expect(
      published.some((f) => f === 'docs' || f.startsWith('docs/')),
      'docs/ is excluded from the package; an existence check against a doc path resolves false on every fleet install',
    ).toBe(false);
  });

  it('no census entry anchors to a doc path', () => {
    for (const e of PROVENANCE_COVERAGE) {
      if (!e.status.startsWith('pending:')) continue;
      const ref = e.status.slice('pending:'.length);
      expect(ref.startsWith('spec:'), `${e.decisionPoint}: doc-path anchors do not ship`).toBe(false);
    }
  });
});

describe('registry integrity', () => {
  it('every key is self-consistent and charset-clean', () => {
    for (const [k, v] of Object.entries(BACKLOG_TRACKERS)) {
      expect(k).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(v.key, 'the record key must match its map key').toBe(k);
      expect(v.owner.length, 'owner must point a reader somewhere real').toBeGreaterThan(10);
      expect(v.summary.length, 'summary must argue what the backlog is').toBeGreaterThanOrEqual(40);
    }
  });

  it('backlogTrackerExists answers both sides, and is not fooled by prototype keys', () => {
    expect(backlogTrackerExists('decision-quality-enrolment')).toBe(true);
    expect(backlogTrackerExists('nope')).toBe(false);
    // A plain `key in obj` / `obj[key]` check would answer true here.
    expect(backlogTrackerExists('constructor')).toBe(false);
    expect(backlogTrackerExists('toString')).toBe(false);
    expect(backlogTrackerExists('__proto__')).toBe(false);
  });

  it('every record declares a CLOSURE CONDITION — "alive" must not decay into "still listed"', () => {
    // External review, 2026-07-25: a registry key nobody ever retires makes the
    // debt check pass forever while the work rots. The closure condition is what
    // makes a stale key visible to a human reading the registry.
    for (const [k, v] of Object.entries(BACKLOG_TRACKERS)) {
      expect(v.closureCondition.length, `${k}: must state when this key is deleted`).toBeGreaterThanOrEqual(40);
    }
  });

  it('has NO ORPHANED keys — every registered backlog is actually referenced', () => {
    // The other direction of the same rot: a key whose last reference was wired
    // away but which was never deleted. Its own closureCondition says the key
    // goes when the last reference does; this is that rule, enforced.
    const referenced = new Set(
      PROVENANCE_COVERAGE.filter((e) => e.status.startsWith('pending:'))
        .map((e) => e.status.slice('pending:'.length))
        .filter((r) => r.startsWith('backlog:'))
        .map((r) => r.slice('backlog:'.length)),
    );
    for (const k of Object.keys(BACKLOG_TRACKERS)) {
      expect(
        referenced.has(k),
        `backlog key '${k}' is registered but referenced by no pending entry — delete it (its closure condition says so) or point the work at it`,
      ).toBe(true);
    }
  });

  it('the pending refs are exactly ONE deliberate key, not a spray of near-misses', () => {
    // Aggregate counts can look healthy while refs drift apart (e.g. a typo'd
    // second key that happens to be registered). Assert the distribution.
    const dist = new Map<string, number>();
    for (const e of PROVENANCE_COVERAGE) {
      if (!e.status.startsWith('pending:')) continue;
      const ref = e.status.slice('pending:'.length);
      dist.set(ref, (dist.get(ref) ?? 0) + 1);
    }
    expect(
      [...dist.keys()].sort(),
      'the enrolment backlog is one body of work; a second ref here is either a real new backlog (register it deliberately) or a typo',
    ).toEqual(['backlog:decision-quality-enrolment']);
    expect(dist.get('backlog:decision-quality-enrolment')).toBe(
      PROVENANCE_COVERAGE.filter((e) => e.status.startsWith('pending:')).length,
    );
  });

  it('every pending census entry resolves against the registry RIGHT NOW', () => {
    const pending = PROVENANCE_COVERAGE.filter((e) => e.status.startsWith('pending:'));
    expect(pending.length, 'the backlog should not silently empty').toBeGreaterThan(0);
    for (const e of pending) {
      const verdict = adjudicatePendingTracker(e.status.slice('pending:'.length), null);
      expect(verdict, `${e.decisionPoint}: pending ref must resolve on a queue-less install`).toBe(
        'alive',
      );
    }
  });
});
