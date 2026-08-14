/**
 * Unit tests for ParallelActivityIndex + extractTags
 * (docs/specs/parallel-activity-coherence.md, Phase A).
 *
 * extractTags is a pure function (no fixtures). The index is tested with a temp
 * topic-intent dir (for enumeration) + an injected getRefs seam (so we control
 * the refs without fighting projectConfidence).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  ParallelActivityIndex,
  extractTags,
  runningTopicIds,
} from '../../src/core/ParallelActivityIndex.js';
import type { Session } from '../../src/core/types.js';
import type { EstablishedRef } from '../../src/core/TopicIntent.js';

function ref(partial: Partial<EstablishedRef> & { kind: EstablishedRef['kind']; text: string }): EstablishedRef {
  return {
    refId: partial.refId ?? 'r1',
    arcId: 'arc',
    topicId: partial.topicId ?? 1,
    kind: partial.kind,
    text: partial.text,
    confidence: 0.9,
    evidence: [],
    lastReinforcedAt: partial.lastReinforcedAt ?? '2026-06-04T00:00:00.000Z',
    status: 'active' as EstablishedRef['status'],
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
  };
}

describe('extractTags', () => {
  it('keeps high-specificity tokens (paths, identifiers, camelCase, rare words)', () => {
    const tags = extractTags('Wire ResourceLedger CPU sampling in src/monitoring/ResourceSampler.ts on branch echo/foo');
    expect(tags).toContain('resourceledger');
    expect(tags).toContain('src/monitoring/resourcesampler.ts');
    expect(tags).toContain('echo/foo');
    expect(tags).toContain('sampling');
  });
  it('drops generic boilerplate so two "fix the test" topics do not match', () => {
    const tags = extractTags('fix the test config for this PR session');
    // every token here is boilerplate/short ⇒ no specificity
    expect(tags).toEqual([]);
  });
  it('two topics overlap on a shared specific token, not on generic words', () => {
    const a = new Set(extractTags('improve cpu-sampling cadence in ResourceSampler'));
    const b = new Set(extractTags('reduce load from cpu-sampling in the reaper'));
    const shared = [...a].filter((t) => b.has(t));
    expect(shared).toContain('cpu-sampling'); // the genuine, specific overlap
    expect(shared).not.toContain('cadence');  // not shared
  });
});

describe('extractTags specificity boundary', () => {
  it("treats 'cpu' (3-char plain word) as NOT specific, but 'cpu-sampling' as specific", () => {
    expect(extractTags('cpu work')).toEqual([]);                  // 'cpu' too short, 'work' boilerplate
    expect(extractTags('cpu-sampling work')).toContain('cpu-sampling'); // compound ⇒ specific
  });
});

describe('ParallelActivityIndex', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-')); fs.mkdirSync(path.join(tmp, 'topic-intent')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/parallel-activity-index.test.ts' }); });

  function writeTopicFiles(ids: number[]) {
    for (const id of ids) fs.writeFileSync(path.join(tmp, 'topic-intent', `${id}.json`), JSON.stringify({ topicId: id, refs: {} }));
  }

  it('empty intent dir ⇒ no activities', () => {
    const idx = new ParallelActivityIndex({ stateDir: tmp });
    expect(idx.activities()).toEqual([]);
  });

  it('enumerates topics, derives focus (goal>decision), extracts tags, marks running', () => {
    writeTopicFiles([100, 200]);
    const refsByTopic: Record<number, EstablishedRef[]> = {
      100: [
        ref({ topicId: 100, kind: 'decision', text: 'use SQLite', lastReinforcedAt: '2026-06-04T01:00:00.000Z' }),
        ref({ topicId: 100, kind: 'goal', text: 'ship ResourceLedger CPU sampling', lastReinforcedAt: '2026-06-04T02:00:00.000Z' }),
      ],
      200: [
        ref({ topicId: 200, kind: 'decision', text: 'route sentinels to codex-cli', lastReinforcedAt: '2026-06-04T01:30:00.000Z' }),
      ],
    };
    const idx = new ParallelActivityIndex({
      stateDir: tmp,
      getRefs: (topicId) => refsByTopic[topicId] ?? [],
      isRunning: (t) => t === 100,
      nicknameFor: (t) => (t === 100 ? 'resource-work' : null),
    });
    const acts = idx.activities();
    expect(acts.map((a) => a.topicId)).toEqual([100, 200]);

    const t100 = acts.find((a) => a.topicId === 100)!;
    expect(t100.focus).toBe('ship ResourceLedger CPU sampling'); // goal beats decision
    expect(t100.tags).toContain('resourceledger');
    expect(t100.tags).toContain('sampling');
    expect(t100.running).toBe(true);
    expect(t100.nickname).toBe('resource-work');
    expect(t100.refCount).toBe(2);
    expect(t100.updatedAt).toBe(Date.parse('2026-06-04T02:00:00.000Z'));

    const t200 = acts.find((a) => a.topicId === 200)!;
    expect(t200.focus).toBe('route sentinels to codex-cli'); // only a decision
    expect(t200.tags).toContain('codex-cli');
    expect(t200.running).toBe(false);
  });

  it('falls back to purposeFor when a topic has no goal/decision refs', () => {
    writeTopicFiles([300]);
    const idx = new ParallelActivityIndex({
      stateDir: tmp,
      getRefs: () => [],
      purposeFor: () => 'investigating the lifeline restart loop',
    });
    const t = idx.activities()[0];
    expect(t.focus).toBe('investigating the lifeline restart loop');
    expect(t.tags).toContain('investigating');
  });
});

// ── runningTopicIds — the WIRING, not the index ───────────────────────────
// Earned 2026-08-14. The index's `running` flag was correct and its tests
// passed, because they inject a stub `isRunning`. Production wired an
// `isRunning` that read `s.topicId` off the live sessions — a field a Session
// does not declare and nothing sets — behind a cast that asserted it existed.
// The set was therefore ALWAYS empty and every topic reported running:false
// since the surface shipped. These tests feed REAL-SHAPED Session objects, so
// they fail if the resolution ever goes back to reading a field off a Session.

describe('runningTopicIds (wiring integrity)', () => {
  /** A Session shaped like the real thing: a tmux name, and NO topic field. */
  const session = (tmuxSession: string): Session =>
    ({ id: tmuxSession, name: tmuxSession, status: 'running', tmuxSession, startedAt: '' } as unknown as Session);

  it('THE DEFECT: resolves the topic from the tmux name — a Session carries no topic field', () => {
    const sessions = [session('echo-llm-pathway'), session('echo-observer')];
    const registry: Record<string, number> = { 'echo-llm-pathway': 29723, 'echo-observer': 36966 };
    const ids = runningTopicIds(sessions, (n) => registry[n] ?? null);
    // The old wiring produced an EMPTY set here, because these objects have no
    // `topicId` — which is exactly what a real Session looks like.
    expect([...ids].sort((a, b) => a - b)).toEqual([29723, 36966]);
  });

  it('CONTROL: a session the registry cannot place is NOT counted (no invented topics)', () => {
    const ids = runningTopicIds([session('job-health-check'), session('bob-server')], () => null);
    expect(ids.size).toBe(0);
  });

  it('CONTROL: an empty session list yields an empty set — a real zero stays zero', () => {
    expect(runningTopicIds([], () => 29723).size).toBe(0);
  });

  it('one unresolvable session does not blind the rest', () => {
    const ids = runningTopicIds(
      [session('a'), session('boom'), session('c')],
      (n) => {
        if (n === 'boom') throw new Error('registry read failed');
        return n === 'a' ? 1 : 2;
      },
    );
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('ignores sessions with no tmux name and non-finite topic ids', () => {
    const ids = runningTopicIds(
      [{ tmuxSession: '' }, { tmuxSession: null }, session('nan')],
      () => Number.NaN,
    );
    expect(ids.size).toBe(0);
  });

});
