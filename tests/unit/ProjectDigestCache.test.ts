/**
 * ProjectDigestCache unit tests (Phase 1a PR 3).
 *
 * Covers:
 *   - empty case → 0 lines, total=0, truncated=false
 *   - 3 projects → 3 lines, ordered by lastTouchedAt desc
 *   - 7 projects → 5 lines + truncated=true + totalActiveProjects=7
 *   - sanitization: control chars + newlines stripped from titles/round names
 *   - 80-char cap on each sanitized field
 *   - cache invalidator hook: every mutation through InitiativeTracker
 *     triggers a writeDigestCache() call
 *   - atomic write: no partial file ever visible
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  InitiativeTracker,
  type InitiativeCreateInput,
} from '../../src/core/InitiativeTracker.js';
import {
  ProjectDigestCache,
  DIGEST_CACHE_FILENAME,
  MAX_PROJECTS_IN_DIGEST,
  MAX_STRING_LENGTH,
  sanitizeDigestString,
  formatProjectDigestLine,
  type ProjectDigestCacheFile,
} from '../../src/core/ProjectDigestCache.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let tracker: InitiativeTracker;
let cache: ProjectDigestCache;

function projectInput(
  id: string,
  overrides: Partial<InitiativeCreateInput> = {}
): InitiativeCreateInput {
  return {
    id,
    title: `Project ${id}`,
    description: 'test project',
    phases: [{ id: 'p1', name: 'Phase 1' }],
    kind: 'project',
    rounds: [
      { name: 'Round 1', itemIds: [], status: 'complete' },
      { name: 'Round 2', itemIds: [], status: 'ready' },
      { name: 'Round 3', itemIds: [], status: 'pending' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-digest-cache-'));
  tracker = new InitiativeTracker(tmpDir);
  cache = new ProjectDigestCache(tmpDir, tracker);
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/ProjectDigestCache.test.ts',
  });
});

function readCacheFile(): ProjectDigestCacheFile {
  const raw = fs.readFileSync(path.join(tmpDir, DIGEST_CACHE_FILENAME), 'utf-8');
  return JSON.parse(raw) as ProjectDigestCacheFile;
}

// ─── Empty case ────────────────────────────────────────────────────────────

describe('writeDigestCache — empty', () => {
  it('writes 0 digestLines and totalActiveProjects=0 when no projects exist', () => {
    cache.writeDigestCache();
    const c = readCacheFile();
    expect(c.digestLines).toEqual([]);
    expect(c.totalActiveProjects).toBe(0);
    expect(c.truncated).toBe(false);
    expect(typeof c.generatedAt).toBe('string');
    // ISO timestamp shape
    expect(c.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('skips kind:"task" initiatives (only kind:"project" are counted)', async () => {
    await tracker.create({
      id: 'task-only',
      title: 'A Task',
      description: 'leaf',
      phases: [{ id: 'p', name: 'P' }],
      // kind defaults to 'task' when omitted
    });
    cache.writeDigestCache();
    expect(readCacheFile().totalActiveProjects).toBe(0);
  });

  it('skips non-active projects (archived, paused, halted)', async () => {
    await tracker.create(projectInput('proj-archived'));
    await tracker.update('proj-archived', { status: 'archived' });
    await tracker.create(projectInput('proj-paused'));
    await tracker.update('proj-paused', { status: 'paused' });
    cache.writeDigestCache();
    const c = readCacheFile();
    expect(c.totalActiveProjects).toBe(0);
    expect(c.digestLines).toEqual([]);
  });
});

// ─── 3 projects ────────────────────────────────────────────────────────────

describe('writeDigestCache — under MAX_PROJECTS_IN_DIGEST', () => {
  it('writes one digestLine per active project, no truncation', async () => {
    await tracker.create(projectInput('proj-a'));
    await tracker.create(projectInput('proj-b'));
    await tracker.create(projectInput('proj-c'));
    cache.writeDigestCache();
    const c = readCacheFile();
    expect(c.digestLines).toHaveLength(3);
    expect(c.totalActiveProjects).toBe(3);
    expect(c.truncated).toBe(false);
  });

  it('includes round progress + next round name in each line', async () => {
    await tracker.create(projectInput('proj-x'));
    cache.writeDigestCache();
    const c = readCacheFile();
    expect(c.digestLines[0]).toContain('Project [proj-x]');
    // 1 of 3 rounds is `complete`, so "1 of 3 done"
    expect(c.digestLines[0]).toContain('1 of 3 done');
    // first non-complete round is "Round 2"
    expect(c.digestLines[0]).toContain('Next round: Round 2');
  });

  it('marks "(none — all rounds complete)" when every round is done', async () => {
    await tracker.create(
      projectInput('proj-done', {
        rounds: [
          { name: 'R1', itemIds: [], status: 'complete' },
          { name: 'R2', itemIds: [], status: 'complete-with-skips' },
        ],
      })
    );
    cache.writeDigestCache();
    const c = readCacheFile();
    expect(c.digestLines[0]).toContain('2 of 2 done');
    expect(c.digestLines[0]).toContain('Next round: (none — all rounds complete)');
  });
});

// ─── 7 projects (truncation) ───────────────────────────────────────────────

describe('writeDigestCache — over MAX_PROJECTS_IN_DIGEST', () => {
  it('caps digestLines at MAX, sets truncated=true, exposes total count', async () => {
    for (let i = 0; i < 7; i++) {
      await tracker.create(projectInput(`proj-${i}`));
    }
    cache.writeDigestCache();
    const c = readCacheFile();
    expect(c.digestLines).toHaveLength(MAX_PROJECTS_IN_DIGEST); // 5
    expect(c.totalActiveProjects).toBe(7);
    expect(c.truncated).toBe(true);
  });

  it('keeps the most-recently-touched projects, drops the oldest', async () => {
    // Create with manually-controlled lastTouchedAt by interleaving updates.
    // tracker writes `lastTouchedAt = now()` on every successful mutation,
    // so the LAST one touched should be first in the digest.
    for (let i = 0; i < 7; i++) {
      await tracker.create(projectInput(`p${i}`));
    }
    // On fast CI hardware, all 7 creates can resolve in the same millisecond,
    // tying their lastTouchedAt timestamps. The subsequent update must land
    // in a strictly later millisecond to be reliably-greatest under sort.
    // Without this gap, sort order is unstable (observed flake on node 22
    // shard 4/4, attempt 1 of PR #155 CI).
    await new Promise((r) => setTimeout(r, 5));
    // Touch p3 last — should appear in the digest even though it was
    // created 4th of 7.
    await tracker.update('p3', { blockers: ['marker'] });
    cache.writeDigestCache();
    const c = readCacheFile();
    const ids = c.digestLines.map((ln) => {
      const m = ln.match(/Project \[(.+?)\]/);
      return m ? m[1] : '';
    });
    expect(ids[0]).toBe('p3'); // most recently touched
    expect(ids).toHaveLength(5);
  });
});

// ─── Sanitization ──────────────────────────────────────────────────────────

describe('sanitizeDigestString', () => {
  it('strips control chars and newlines, returns a single-line string', () => {
    expect(sanitizeDigestString('hello\nworld')).toBe('hello world');
    expect(sanitizeDigestString('a\x00b\x01c\x1Fd\x7Fe')).toBe('a b c d e');
    expect(sanitizeDigestString('tab\there')).toBe('tab here');
  });

  it('collapses runs of whitespace', () => {
    expect(sanitizeDigestString('a    b\t\tc')).toBe('a b c');
  });

  it('caps at the requested length', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeDigestString(long, 80)).toHaveLength(80);
  });

  it('handles non-string input safely', () => {
    expect(sanitizeDigestString(undefined)).toBe('');
    expect(sanitizeDigestString(null)).toBe('');
    expect(sanitizeDigestString(42)).toBe('42');
  });
});

describe('writeDigestCache — sanitization at write time', () => {
  it('strips newlines and control chars from project ids and round names', async () => {
    // Slug rules forbid control chars in `id`, so inject via round name.
    await tracker.create(
      projectInput('proj-evil', {
        rounds: [
          { name: 'Round\nWith\x00Newlines\tEverywhere', itemIds: [], status: 'ready' },
        ],
      })
    );
    cache.writeDigestCache();
    const c = readCacheFile();
    expect(c.digestLines[0]).not.toMatch(/[\x00-\x1F\x7F]/);
    expect(c.digestLines[0]).toContain('Round With Newlines Everywhere');
  });

  it('caps round names at MAX_STRING_LENGTH (80 chars)', async () => {
    const longName = 'x'.repeat(200);
    await tracker.create(
      projectInput('proj-long', {
        rounds: [{ name: longName, itemIds: [], status: 'ready' }],
      })
    );
    cache.writeDigestCache();
    const c = readCacheFile();
    // 200-char name must be capped to 80 before landing in the digest
    const line = c.digestLines[0];
    expect(line).toContain('Project [proj-long]:');
    // The cap is on each sanitized field, not the whole rendered line;
    // verify the round-name substring length doesn't exceed 80.
    const m = line.match(/Next round: (.+?)\.$/);
    expect(m).not.toBeNull();
    expect(m![1].length).toBeLessThanOrEqual(MAX_STRING_LENGTH);
  });
});

// ─── Cache invalidator hook ────────────────────────────────────────────────

describe('setDigestCacheInvalidator wiring', () => {
  it('every mutation through InitiativeTracker triggers a cache rewrite', async () => {
    let invalidations = 0;
    tracker.setDigestCacheInvalidator(() => {
      invalidations++;
      cache.writeDigestCache();
    });
    expect(invalidations).toBe(0);
    await tracker.create(projectInput('proj-1'));
    expect(invalidations).toBe(1);
    await tracker.update('proj-1', { blockers: ['x'] });
    expect(invalidations).toBe(2);
    await tracker.update('proj-1', { status: 'archived' });
    expect(invalidations).toBe(3);
    // Cache file reflects the most recent state on disk.
    const c = readCacheFile();
    expect(c.totalActiveProjects).toBe(0); // proj-1 is archived
  });

  it('rewriting reflects the latest project set on every mutation', async () => {
    tracker.setDigestCacheInvalidator(() => cache.writeDigestCache());
    await tracker.create(projectInput('a'));
    expect(readCacheFile().totalActiveProjects).toBe(1);
    await tracker.create(projectInput('b'));
    expect(readCacheFile().totalActiveProjects).toBe(2);
    await tracker.update('a', { status: 'archived' });
    expect(readCacheFile().totalActiveProjects).toBe(1);
  });
});

// ─── Atomic write ──────────────────────────────────────────────────────────

describe('writeDigestCache — atomic write', () => {
  it('uses temp-file + rename so readers never see a partial file', () => {
    // Implementation invariant: no .tmp file remains after a successful
    // write. The cache file itself must be complete-and-parseable
    // immediately after the call returns.
    cache.writeDigestCache();
    const dir = fs.readdirSync(tmpDir);
    const tmpFiles = dir.filter((n) => n.startsWith(DIGEST_CACHE_FILENAME) && n.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
    // Parseability: full JSON document on disk.
    expect(() => readCacheFile()).not.toThrow();
  });

  it('repeated writes never leak partial state — every read is well-formed', async () => {
    // Write a bunch in quick succession, parse the file every time.
    tracker.setDigestCacheInvalidator(() => cache.writeDigestCache());
    for (let i = 0; i < 10; i++) {
      await tracker.create(projectInput(`p${i}`));
      const c = readCacheFile();
      expect(c.totalActiveProjects).toBe(i + 1);
    }
  });
});

// ─── formatProjectDigestLine pure function ─────────────────────────────────

describe('formatProjectDigestLine', () => {
  it('handles empty rounds gracefully', () => {
    const line = formatProjectDigestLine({
      id: 'no-rounds',
      title: 't',
      description: 'd',
      status: 'active',
      phases: [],
      currentPhaseIndex: 0,
      lastTouchedAt: '2026-05-11T00:00:00.000Z',
      needsUser: false,
      blockers: [],
      links: [],
      createdAt: '',
      updatedAt: '',
      kind: 'project',
      rounds: [],
    });
    expect(line).toContain('Project [no-rounds]');
    expect(line).toContain('0 of 0 done');
    expect(line).toContain('(none — all rounds complete)');
  });
});
