/**
 * ProjectDigestCache — writes a sanitized JSON snapshot of active projects
 * to `.instar/projects-digest.cache` for cheap, no-HTTP consumption by
 * session-start and compaction-recovery hooks.
 *
 * Spec source: PROJECT-SCOPE-SPEC.md § Phase 1.9 (session-start + compaction
 * recovery hooks). The hooks have a ≤50ms budget — pure file read, no HTTP.
 *
 * Invariants:
 *   - Top 5 active projects by `lastTouchedAt` (desc) are included; the
 *     `truncated` flag + `totalActiveProjects` count make over-limit visible.
 *   - Every string field that lands in the cache is sanitized at write time:
 *     control chars (incl. newline + CR) stripped, and the result capped at
 *     80 characters. The hooks ALSO sanitize on read (defense in depth),
 *     so direct cache-file poisoning can't smuggle an unprintable string
 *     into orientation output.
 *   - Atomic on-disk write (temp file + rename) — readers never observe a
 *     partial file. Matches the pattern `InitiativeTracker.saveToDisk()`
 *     uses for its own persistence.
 *
 * This module is the **read side** of the invalidator hook PR 1 added on
 * InitiativeTracker (`setDigestCacheInvalidator`). The server wires
 * `writeDigestCache()` as the invalidator at boot, so every successful
 * project mutation re-renders the file. Mutations on `kind:'task'`
 * initiatives also trigger a rewrite — the function filters internally to
 * `kind:'project' && status:'active'`, so the side effect is a no-op when
 * no project state changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { InitiativeTracker, Initiative } from './InitiativeTracker.js';

/** Where the digest lands. Hooks read this exact path. */
export const DIGEST_CACHE_FILENAME = 'projects-digest.cache';

/** Max projects rendered into `digestLines`. Top-N by `lastTouchedAt`. */
export const MAX_PROJECTS_IN_DIGEST = 5;

/** Max characters per sanitized string (titles, round names). */
export const MAX_STRING_LENGTH = 80;

/** JSON shape that the hooks deserialize. */
export interface ProjectDigestCacheFile {
  /** ISO timestamp when this snapshot was written. */
  generatedAt: string;
  /** One sanitized one-liner per active project, top-N by `lastTouchedAt`. */
  digestLines: string[];
  /** Total active projects in the tracker (independent of truncation). */
  totalActiveProjects: number;
  /** True iff `totalActiveProjects > MAX_PROJECTS_IN_DIGEST`. */
  truncated: boolean;
}

/**
 * Strip control chars (incl. \n, \r, \t), then collapse runs of internal
 * whitespace to single spaces and cap at `cap` chars.
 *
 * Exported so the hooks (well, their JS-side helpers) and tests can apply
 * the same rule on read. The bash hooks themselves use a `tr`-based
 * equivalent — the literal regex below is the canonical implementation.
 */
export function sanitizeDigestString(input: unknown, cap = MAX_STRING_LENGTH): string {
  const raw = typeof input === 'string' ? input : input == null ? '' : String(input);
  // Strip ASCII control chars (0x00-0x1F) and DEL (0x7F).
  // Replaces with a single space so words don't collide.
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x1F\x7F]/g, ' ');
  // Collapse internal whitespace runs, trim ends.
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= cap) return collapsed;
  return collapsed.slice(0, cap);
}

/**
 * Render one digest line for a single project. Pure function — caller
 * provides the project; sanitization happens inside.
 */
export function formatProjectDigestLine(project: Initiative): string {
  const id = sanitizeDigestString(project.id, MAX_STRING_LENGTH);
  const rounds = Array.isArray(project.rounds) ? project.rounds : [];
  const total = rounds.length;
  const done = rounds.filter(
    (r) => r && (r.status === 'complete' || r.status === 'complete-with-skips')
  ).length;

  // Next round: first non-complete round in order. Falls through to "(none)"
  // when every round is done.
  const next = rounds.find(
    (r) =>
      r &&
      r.status !== 'complete' &&
      r.status !== 'complete-with-skips' &&
      r.status !== 'failed'
  );
  const nextLabel = next
    ? sanitizeDigestString(next.name || '(unnamed round)', MAX_STRING_LENGTH)
    : '(none — all rounds complete)';

  return `Project [${id}]: ${done} of ${total} done. Next round: ${nextLabel}.`;
}

/**
 * Sort projects by `lastTouchedAt` descending. Ties broken by `id` ascending
 * so the output is stable.
 */
function sortByLastTouched(a: Initiative, b: Initiative): number {
  const at = a.lastTouchedAt ?? '';
  const bt = b.lastTouchedAt ?? '';
  if (at === bt) return a.id.localeCompare(b.id);
  return bt.localeCompare(at);
}

/**
 * ProjectDigestCache — single-responsibility writer. Construct once at
 * server boot; pass `writeDigestCache.bind(this)` as the invalidator on
 * `InitiativeTracker.setDigestCacheInvalidator(fn)`.
 */
export class ProjectDigestCache {
  private readonly filePath: string;
  private readonly tracker: InitiativeTracker;
  /** Bound to `process.pid` so concurrent writers (test sandbox + main
   *  process) don't trample one another's temp files. */
  private readonly tmpSuffix: string;

  constructor(stateDir: string, tracker: InitiativeTracker) {
    this.filePath = path.join(stateDir, DIGEST_CACHE_FILENAME);
    this.tracker = tracker;
    this.tmpSuffix = `.${process.pid}.tmp`;
  }

  /** Absolute path to the cache file. Exposed for diagnostics. */
  getCachePath(): string {
    return this.filePath;
  }

  /**
   * Snapshot all active projects, render the top-N digest lines, and write
   * the result atomically. Synchronous on purpose — runs in the
   * invalidator hot path (every project mutation calls it once).
   *
   * Best-effort: any thrown error is swallowed after logging, so a hiccup
   * writing the cache never blocks a successful mutation.
   */
  writeDigestCache(): void {
    try {
      const all = this.tracker.list({ kind: 'project', status: 'active' });
      // `list()` already sorts by `lastTouchedAt` desc; re-sort defensively
      // in case the contract changes underneath us.
      const sorted = [...all].sort(sortByLastTouched);
      const total = sorted.length;
      const truncated = total > MAX_PROJECTS_IN_DIGEST;
      const top = sorted.slice(0, MAX_PROJECTS_IN_DIGEST);
      const digestLines = top.map((p) => formatProjectDigestLine(p));

      const payload: ProjectDigestCacheFile = {
        generatedAt: new Date().toISOString(),
        digestLines,
        totalActiveProjects: total,
        truncated,
      };

      this.atomicWrite(JSON.stringify(payload, null, 2));
    } catch (err) {
      console.warn(
        `[ProjectDigestCache] writeDigestCache failed (non-fatal): ${
          err instanceof Error ? err.message : err
        }`
      );
    }
  }

  private atomicWrite(contents: string): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}${this.tmpSuffix}`;
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, this.filePath);
  }
}
