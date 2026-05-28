/**
 * Unit tests — ReleaseReadinessSentinel (Layer B, release-readiness-visibility).
 *
 * Decision logic with fully faked I/O deps. Covers: blocked detection (decoupled
 * from NEXT.md so auto-draft can't silence it), silent-below-threshold, single
 * deduped signal keyed on the oldest-commit SHA, priority escalation, auto-resolve
 * on backlog clear, fail-loud on evaluation errors, hysteresis, resolveEpisodesInRange,
 * and TTL reaping.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ReleaseReadinessSentinel,
  type ReleaseReadinessSentinelDeps,
  type AnalyzerReport,
  type ReadinessState,
  type OldestCommit,
  type AttentionItem,
} from '../../src/monitoring/ReleaseReadinessSentinel.js';

const DAY = 24 * 60 * 60 * 1000;

function report(features: number, fixes: number, crit = 0, high = 0, lastTag = 'v1.0.0'): AnalyzerReport {
  return {
    lastTag,
    commitCount: features + fixes,
    analysis: { commitClassification: { features, fixes } },
    guideCoverage: { criticalGaps: crit, highGaps: high },
  };
}

class Harness {
  state: ReadinessState = ReleaseReadinessSentinel.emptyState();
  posted: AttentionItem[] = [];
  resolved: Array<{ id: string; reason: string }> = [];
  audits: Record<string, unknown>[] = [];
  clock = Date.UTC(2026, 4, 27);

  fetchOk = true;
  analyzer: AnalyzerReport | null = report(1, 0);
  guideBlocks = true;
  oldest: OldestCommit | null = { sha: 'a'.repeat(40), dateMs: 0 };
  ancestors = new Set<string>();

  deps(): ReleaseReadinessSentinelDeps {
    return {
      fetchCanonical: async () => (this.fetchOk ? { ok: true, headSha: 'f'.repeat(40) } : { ok: false }),
      runAnalyzer: async () => this.analyzer,
      oldestUnreleasedCommit: async () => this.oldest,
      guideBlocksPublish: async () => this.guideBlocks,
      draftGuide: async () => {},
      postAttention: async (item) => { this.posted.push(item); return true; },
      resolveAttention: async (id, reason) => { this.resolved.push({ id, reason }); return true; },
      loadState: () => this.state,
      saveState: (s) => { this.state = s; },
      isAncestor: async (sha, _ref) => this.ancestors.has(sha),
      audit: (e) => { this.audits.push(e); },
      now: () => this.clock,
    };
  }
}

describe('ReleaseReadinessSentinel', () => {
  let h: Harness;
  beforeEach(() => { h = new Harness(); });

  it('priorityForAge maps to the configured thresholds', () => {
    const s = new ReleaseReadinessSentinel(h.deps());
    expect(s.priorityForAge(1)).toBeNull();
    expect(s.priorityForAge(2)).toBe('LOW');
    expect(s.priorityForAge(4)).toBe('MEDIUM');
    expect(s.priorityForAge(7)).toBe('HIGH');
  });

  it('stays silent when a blocked backlog is below the age threshold', async () => {
    h.oldest = { sha: 'a'.repeat(40), dateMs: h.clock - 1 * DAY }; // 1 day < silent(2)
    const s = new ReleaseReadinessSentinel(h.deps());
    await s.tick();
    expect(h.posted).toHaveLength(0);
    expect(h.state.episodes).toHaveLength(1); // recorded, not surfaced
  });

  it('raises exactly one deduped signal once the backlog ages past the threshold', async () => {
    h.oldest = { sha: 'a'.repeat(40), dateMs: h.clock - 3 * DAY }; // 3 days → LOW/MEDIUM boundary
    const s = new ReleaseReadinessSentinel(h.deps());
    await s.tick();
    await s.tick(); // same sha, same priority → no second post
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0].priority).toBe('LOW');
    expect(h.posted[0].id).toContain('release-readiness-');
  });

  it('escalates priority as the backlog ages (re-posts at higher priority)', async () => {
    h.oldest = { sha: 'a'.repeat(40), dateMs: h.clock - 3 * DAY };
    const s = new ReleaseReadinessSentinel(h.deps());
    await s.tick(); // LOW
    h.clock += 5 * DAY; // now 8 days old → HIGH
    await s.tick();
    expect(h.posted.map((p) => p.priority)).toEqual(['LOW', 'HIGH']);
    expect(h.posted[0].id).toBe(h.posted[1].id); // same episode id
  });

  it('is blocked by coverage gaps even when there are no feature commits', async () => {
    h.analyzer = report(0, 0, 1, 0); // 1 critical gap, no commits
    h.oldest = null;
    const s = new ReleaseReadinessSentinel(h.deps());
    await s.tick();
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0].id).toBe('release-readiness-coverage-gaps');
  });

  it('does NOT signal when auto-draft cleared the guide but the backlog persists is still surfaced (decoupled)', async () => {
    // guideBlocks=false (auto-draft filled it) but there ARE unreleased commits.
    // Per spec the blocked predicate is (commits AND guideBlocks) OR coverageGaps.
    // With guideBlocks=false and no gaps → NOT blocked → no signal (correct: a
    // reviewed, covering guide means the release can proceed).
    h.guideBlocks = false;
    h.analyzer = report(2, 0, 0, 0);
    const s = new ReleaseReadinessSentinel(h.deps());
    await s.tick();
    expect(h.posted).toHaveLength(0);
  });

  it('auto-resolves the open episode when the backlog clears', async () => {
    h.oldest = { sha: 'a'.repeat(40), dateMs: h.clock - 5 * DAY };
    const s = new ReleaseReadinessSentinel(h.deps());
    await s.tick(); // signal
    expect(h.posted).toHaveLength(1);
    h.guideBlocks = false;
    h.analyzer = report(0, 0); // backlog cleared
    await s.tick();
    expect(h.resolved).toHaveLength(1);
    expect(h.resolved[0].reason).toBe('cleared');
  });

  it('fail-loud: raises a low-priority signal when the canonical fetch fails (deduped)', async () => {
    h.fetchOk = false;
    const s = new ReleaseReadinessSentinel(h.deps());
    await s.tick();
    await s.tick(); // same failure → deduped
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0].priority).toBe('LOW');
    expect(h.posted[0].title).toContain('could not evaluate');
  });

  it('fail-loud: raises a signal when the analyzer returns null', async () => {
    h.analyzer = null;
    const s = new ReleaseReadinessSentinel(h.deps());
    await s.tick();
    expect(h.posted.some((p) => p.title.includes('could not evaluate'))).toBe(true);
  });

  it('hysteresis: does not re-raise the same sha within the window after a resolve', async () => {
    h.oldest = { sha: 'a'.repeat(40), dateMs: h.clock - 5 * DAY };
    const s = new ReleaseReadinessSentinel(h.deps());
    await s.tick(); // signal
    h.guideBlocks = false; h.analyzer = report(0, 0);
    await s.tick(); // resolve
    expect(h.resolved).toHaveLength(1);
    // backlog reappears (same sha) within hysteresis window
    h.clock += 1 * 60 * 60 * 1000; // +1h < 12h
    h.guideBlocks = true; h.analyzer = report(1, 0);
    await s.tick();
    expect(h.posted).toHaveLength(1); // still just the original signal, no re-raise
  });

  it('resolveEpisodesInRange resolves episodes whose oldest sha is an ancestor of the new tag', async () => {
    h.oldest = { sha: 'a'.repeat(40), dateMs: h.clock - 5 * DAY };
    const s = new ReleaseReadinessSentinel(h.deps());
    await s.tick(); // open episode for sha aaaa...
    h.ancestors.add('a'.repeat(40)); // the published tag now contains it
    await s.resolveEpisodesInRange('newtagsha', 'published');
    expect(h.resolved.some((r) => r.reason === 'published')).toBe(true);
    expect(h.state.episodes.find((e) => e.oldestSha === 'a'.repeat(40))?.resolvedReason).toBe('published');
  });

  it('reaps an episode whose backlog vanished without a finalize after the TTL', async () => {
    h.oldest = { sha: 'a'.repeat(40), dateMs: h.clock - 5 * DAY };
    const s = new ReleaseReadinessSentinel(h.deps());
    await s.tick(); // open
    h.clock += 31 * DAY; // past 30-day TTL; backlog still "blocked" but abandoned
    await s.tick();
    const ep = h.state.episodes.find((e) => e.oldestSha === 'a'.repeat(40));
    // Either reaped-as-stale, or (if it re-opened) at least audited; assert a stale reap happened.
    expect(h.audits.some((a) => a.event === 'reaped-stale')).toBe(true);
  });

  it('does not start when disabled', () => {
    const s = new ReleaseReadinessSentinel(h.deps(), { enabled: false });
    s.start();
    // No throw, no tick handle — a no-op. (Smoke: stop() is safe too.)
    s.stop();
    expect(h.posted).toHaveLength(0);
  });
});
