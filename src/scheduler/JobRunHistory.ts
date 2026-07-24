/**
 * JobRunHistory — Persistent, searchable history of every job execution.
 *
 * History is memory. Memory should never be lost.
 *
 * Records the full lifecycle of each job run: trigger → completion,
 * with duration, result, error context, model used, output summary,
 * and LLM reflection. This is the single source of truth for
 * "what did this job do, what did it learn, and when?"
 *
 * Storage: JSONL at {stateDir}/ledger/job-runs.jsonl
 * Retention: PERMANENT. No deletion, ever. Completed runs are kept forever.
 *   On startup, the file is compacted: duplicate entries (pending → completed
 *   pairs for the same runId) are collapsed to just the final state.
 *   This saves space without losing any information.
 * Query: by slug, result, date range, with pagination
 */

import fs from 'node:fs';
import path from 'node:path';
import { capacityOutcome, type CapacityEnforcementResult } from '../core/CapacityEnforcement.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

// capacity-enforcement-contract: job-run-history-row@1

export interface JobRunReflection {
  /** High-level summary of what the job did */
  summary: string;
  /** What went well */
  strengths: string[];
  /** What could improve */
  improvements: string[];
  /** Deviation analysis — why did deviations happen? */
  deviationAnalysis: string | null;
  /** Is the job evolving toward a different purpose? */
  purposeDrift: string | null;
  /** Suggested changes to the job definition */
  suggestedChanges: string[];
}

export interface JobRun {
  /** Unique run ID (slug + timestamp hash) */
  runId: string;
  /** Job slug */
  slug: string;
  /** Session ID that executed this run */
  sessionId: string;
  /** What triggered the run (scheduled, manual, missed, queued:scheduled, etc.) */
  trigger: string;
  /** When the job was triggered */
  startedAt: string;
  /** When the job completed (null if still running) */
  completedAt?: string;
  /** Duration in seconds (computed on completion) */
  durationSeconds?: number;
  /** Result of the run */
  result: 'pending' | 'success' | 'failure' | 'timeout' | 'spawn-error';
  /** Error message if failed */
  error?: string;
  /** Model tier used */
  model?: string;
  /** Machine ID that ran this job (multi-machine) */
  machineId?: string;
  /** Condensed output from the session (last ~1000 chars) */
  outputSummary?: string;
  /** LLM reflection on what happened and what was learned */
  reflection?: JobRunReflection;
  /** Handoff notes for the next execution — human-readable continuity */
  handoffNotes?: string;
  /** Structured state snapshot for the next execution */
  stateSnapshot?: Record<string, unknown>;
  // ── Phase 1b observability (jobs-as-agentmd spec §"Run-record observability") ──
  /** Where the job came from. "legacy" = traditional jobs.json entry,
   *  "instar" or "user" = per-slug manifest entry with the matching origin. */
  origin?: 'instar' | 'user' | 'legacy';
  /** Absolute path the agentmd body was resolved from; null for non-agentmd. */
  resolvedPath?: string | null;
  /** SHA-256 of the cached body. null for non-agentmd. */
  bodyHash?: string | null;
  /** SHA-256 of the canonicalized frontmatter object. null for non-agentmd. */
  frontmatterHash?: string | null;
  /** Monotonic counter from the per-slug manifest. null when absent. */
  manifestVersion?: number | null;
  /** Tool allowlist as resolved at spawn time. Array of names, or "*" when
   *  the unrestricted-tools two-flag guard passed, or null when no
   *  allowlist applies (legacy entries). */
  toolAllowlist?: string[] | '*' | null;
  /** Whether the manifest declared unrestricted tools. */
  unrestrictedTools?: boolean;
  /** Whether the resolver clamped the requested allowlist to [Read]
   *  because the unrestricted-tools two-flag guard failed. */
  clampedAllowlist?: boolean;
  /** When the row exceeded the 2 KB cap, non-essential fields are
   *  truncated and this flag is set. */
  truncated?: boolean;
}

export interface JobRunStats {
  slug: string;
  totalRuns: number;
  successes: number;
  failures: number;
  successRate: number;
  avgDurationSeconds: number;
  lastRun?: JobRun;
  longestRun?: { durationSeconds: number; runId: string; startedAt: string };
  /** Runs per day over the stats window */
  runsPerDay: number;
  /** Completed rows that were intentionally condensed to the storage budget. */
  budgetCondensedRuns: number;
}

/** Monotonic counter to ensure unique runIds even within the same millisecond */
let runCounter = 0;

/** Per-row size cap from spec §"Run-record observability". When a row's
 *  serialized JSON exceeds this many bytes, non-essential fields are
 *  condensed and the row carries durable outcome telemetry. The essential set —
 *  runId, slug, sessionId, trigger, startedAt, result, origin — is
 *  always preserved so query results remain coherent. */
const ROW_SIZE_CAP_BYTES = 2 * 1024;
const ERROR_OMISSION_MARKER_PREFIX = '\n...[omitted ';
const ERROR_OMISSION_MARKER_SUFFIX = ' bytes to fit JobRunHistory row cap]...\n';

/** Fields that are dropped first when a row exceeds the size cap.
 *  Ordered loosely by user-visibility: bulky outputs first, summaries last. */
const TRUNCATABLE_FIELDS = [
  'outputSummary',
  'stateSnapshot',
  'handoffNotes',
  'reflection',
] as const;

export class JobRunHistory {
  private ledgerDir: string;
  private file: string;
  private machineId: string | null = null;

  // ── Event-loop-freeze fix: incremental in-memory cache of parsed runs ──
  //
  // job-runs.jsonl is an append-only ledger that grows to tens of MB. Every
  // read operation (findRun, recordCompletion, recordReflection, recordHandoff,
  // query, stats, allStats, getLastHandoff) used to call readLines(), which did
  // a SYNCHRONOUS full-file readFileSync + per-line JSON.parse on every call.
  // The scheduler calls these on every job completion, on the wake-reaper tick,
  // and on every job spawn — and the dashboard polls history routes — so a
  // 13MB ledger blocked the event loop for 13-16s, repeatedly. A live
  // /usr/bin/sample caught ~39% of main-thread time in JsonParser.
  //
  // The ledger is single-writer-per-process for JobRun rows (this instance),
  // but a SECOND writer exists in-process — MigrationLedger.appendMigrationEvent
  // appends `migration.*` rows to the SAME file. So the cache is validated
  // against the file's (size, mtimeMs) and, when the file only GREW with an
  // intact prefix, only the appended TAIL is read+parsed (O(delta), not O(13MB)).
  // A shrink/truncation (compaction by another path, or external rewrite) falls
  // back to a full re-read. This preserves the existing "JSONL append-only,
  // dedup last-entry-per-runId, skip torn lines" semantics exactly — it only
  // removes the per-call full parse.
  private cachedRuns: JobRun[] | null = null;
  private cachedSize = 0;
  private cachedMtimeMs = 0;

  constructor(stateDir: string) {
    this.ledgerDir = path.join(stateDir, 'ledger');
    this.file = path.join(this.ledgerDir, 'job-runs.jsonl');
    this.ensureDirectory();
    this.compact();
  }

  setMachineId(machineId: string): void {
    this.machineId = machineId;
  }

  /**
   * Record that a job was triggered. Returns the runId for later completion.
   */
  recordStart(opts: {
    slug: string;
    sessionId: string;
    trigger: string;
    model?: string;
    // Phase 1b observability extensions (jobs-as-agentmd spec)
    origin?: 'instar' | 'user' | 'legacy';
    resolvedPath?: string | null;
    bodyHash?: string | null;
    frontmatterHash?: string | null;
    manifestVersion?: number | null;
    toolAllowlist?: string[] | '*' | null;
    unrestrictedTools?: boolean;
    clampedAllowlist?: boolean;
  }): string {
    const runId = `${opts.slug}-${Date.now().toString(36)}-${(runCounter++).toString(36)}`;
    const run: JobRun = {
      runId,
      slug: opts.slug,
      sessionId: opts.sessionId,
      trigger: opts.trigger,
      startedAt: new Date().toISOString(),
      result: 'pending',
      model: opts.model,
      machineId: this.machineId ?? undefined,
      origin: opts.origin,
      resolvedPath: opts.resolvedPath ?? null,
      bodyHash: opts.bodyHash ?? null,
      frontmatterHash: opts.frontmatterHash ?? null,
      manifestVersion: opts.manifestVersion ?? null,
      toolAllowlist: opts.toolAllowlist ?? null,
      unrestrictedTools: opts.unrestrictedTools ?? false,
      clampedAllowlist: opts.clampedAllowlist ?? false,
    };
    this.appendLine(run);
    return runId;
  }

  /**
   * Record that a job run completed. Updates the existing pending entry
   * by appending a completion record (JSONL is append-only — queries
   * deduplicate by taking the last entry per runId).
   *
   * Idempotent: if the run already has a non-pending result, this is a
   * no-op. This closes the wake-reaper race where a tmux session ends
   * during sleep and its completion callback fires after the reaper has
   * already written 'timeout' — first writer wins, late writers are
   * silently dropped with a debug log.
   */
  recordCompletion(opts: {
    runId: string;
    result: 'success' | 'failure' | 'timeout';
    error?: string;
    outputSummary?: string;
  }): void {
    // Find the pending entry to get start time
    const pending = this.findRun(opts.runId);
    if (!pending) {
      console.warn(`[JobRunHistory] No pending run found for ${opts.runId}`);
      return;
    }
    if (pending.result !== 'pending') {
      // Already completed — first writer wins.
      console.debug(`[JobRunHistory] recordCompletion no-op for ${opts.runId}: already ${pending.result}`);
      return;
    }

    const completedAt = new Date().toISOString();
    const durationSeconds = Math.round(
      (new Date(completedAt).getTime() - new Date(pending.startedAt).getTime()) / 1000
    );

    const completed: JobRun = {
      ...pending,
      completedAt,
      durationSeconds,
      result: opts.result,
      error: opts.error,
      outputSummary: opts.outputSummary,
    };
    this.appendLine(completed);
  }

  /**
   * Attach an LLM reflection to a completed run.
   * Appends a new version of the run record with the reflection field set.
   * Called asynchronously after the reflection LLM call completes.
   */
  recordReflection(runId: string, reflection: JobRunReflection): void {
    const run = this.findRun(runId);
    if (!run) {
      console.warn(`[JobRunHistory] No run found for reflection: ${runId}`);
      return;
    }

    const enriched: JobRun = {
      ...run,
      reflection,
    };
    this.appendLine(enriched);
  }

  /**
   * Record a spawn error (job never made it to a session).
   */
  recordSpawnError(opts: {
    slug: string;
    trigger: string;
    error: string;
    model?: string;
  }): string {
    const runId = `${opts.slug}-${Date.now().toString(36)}-${(runCounter++).toString(36)}`;
    const now = new Date().toISOString();
    const run: JobRun = {
      runId,
      slug: opts.slug,
      sessionId: '',
      trigger: opts.trigger,
      startedAt: now,
      completedAt: now,
      durationSeconds: 0,
      result: 'spawn-error',
      error: opts.error,
      model: opts.model,
      machineId: this.machineId ?? undefined,
    };
    this.appendLine(run);
    return runId;
  }

  /**
   * Query job run history with filters and pagination.
   */
  query(opts?: {
    slug?: string;
    result?: JobRun['result'];
    sinceHours?: number;
    limit?: number;
    offset?: number;
  }): { runs: JobRun[]; total: number } {
    const all = this.getDeduplicatedRuns();
    const cutoff = opts?.sinceHours
      ? new Date(Date.now() - opts.sinceHours * 60 * 60 * 1000).toISOString()
      : undefined;

    const filtered = all.filter(r => {
      if (opts?.slug && r.slug !== opts.slug) return false;
      if (opts?.result && r.result !== opts.result) return false;
      if (cutoff && r.startedAt < cutoff) return false;
      return true;
    });

    // Sort by startedAt descending (most recent first)
    filtered.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    const total = filtered.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    const runs = filtered.slice(offset, offset + limit);

    return { runs, total };
  }

  /**
   * Get aggregated stats for a specific job.
   */
  stats(slug: string, sinceHours?: number): JobRunStats {
    const { runs } = this.query({ slug, sinceHours, limit: 10000 });

    const completed = runs.filter(r => r.result !== 'pending');
    const successes = completed.filter(r => r.result === 'success').length;
    const failures = completed.filter(r => r.result !== 'success').length;
    const budgetCondensedRuns = completed.filter(r => r.truncated === true).length;
    const withDuration = completed.filter(r => r.durationSeconds != null && r.durationSeconds > 0);
    const totalDuration = withDuration.reduce((sum, r) => sum + (r.durationSeconds ?? 0), 0);

    // Calculate runs per day
    let runsPerDay = 0;
    if (completed.length >= 2) {
      const oldest = new Date(completed[completed.length - 1].startedAt).getTime();
      const newest = new Date(completed[0].startedAt).getTime();
      const daySpan = Math.max(1, (newest - oldest) / (24 * 60 * 60 * 1000));
      runsPerDay = Math.round((completed.length / daySpan) * 10) / 10;
    } else if (completed.length === 1) {
      runsPerDay = completed.length;
    }

    // Find longest run
    let longestRun: JobRunStats['longestRun'];
    if (withDuration.length > 0) {
      const longest = withDuration.reduce((max, r) =>
        (r.durationSeconds ?? 0) > (max.durationSeconds ?? 0) ? r : max
      );
      longestRun = {
        durationSeconds: longest.durationSeconds!,
        runId: longest.runId,
        startedAt: longest.startedAt,
      };
    }

    return {
      slug,
      totalRuns: completed.length,
      successes,
      failures,
      successRate: completed.length > 0 ? Math.round((successes / completed.length) * 1000) / 10 : 0,
      avgDurationSeconds: withDuration.length > 0 ? Math.round(totalDuration / withDuration.length) : 0,
      lastRun: runs[0],
      longestRun,
      runsPerDay,
      budgetCondensedRuns,
    };
  }

  /**
   * Get stats for ALL jobs at once.
   */
  allStats(sinceHours?: number): JobRunStats[] {
    const { runs } = this.query({ sinceHours, limit: 100000 });

    // Group by slug
    const bySlug = new Map<string, JobRun[]>();
    for (const run of runs) {
      const existing = bySlug.get(run.slug) ?? [];
      existing.push(run);
      bySlug.set(run.slug, existing);
    }

    // Generate stats per slug
    const result: JobRunStats[] = [];
    for (const slug of bySlug.keys()) {
      result.push(this.stats(slug, sinceHours));
    }

    // Sort by most recent run
    result.sort((a, b) => {
      const aTime = a.lastRun?.startedAt ?? '';
      const bTime = b.lastRun?.startedAt ?? '';
      return bTime.localeCompare(aTime);
    });

    return result;
  }

  /**
   * Record handoff notes for the next execution.
   * Called when a job session completes and wants to leave context for the next run.
   */
  recordHandoff(runId: string, handoffNotes: string, stateSnapshot?: Record<string, unknown>): void {
    const run = this.findRun(runId);
    if (!run) {
      console.warn(`[JobRunHistory] No run found for handoff: ${runId}`);
      return;
    }

    const updated: JobRun = {
      ...run,
      handoffNotes,
      stateSnapshot,
    };
    this.appendLine(updated);
  }

  /**
   * Get the most recent handoff notes for a job slug.
   * Returns notes from the last completed execution that left handoff data.
   * This is the primary continuity mechanism between job executions.
   *
   * Scans the raw JSONL in reverse (newest entries last) to correctly handle
   * runs that start within the same millisecond.
   */
  getLastHandoff(slug: string): { handoffNotes: string; stateSnapshot?: Record<string, unknown>; fromRunId: string; fromSession: string; completedAt: string } | null {
    // Read all lines and deduplicate (last entry per runId wins)
    const all = this.readLines();
    const byId = new Map<string, JobRun>();
    for (const run of all) {
      byId.set(run.runId, run);
    }

    // Convert to array and scan in reverse append order (most recent last in file)
    const deduped = Array.from(byId.values());

    // Reverse so we check most recently appended first
    for (let i = deduped.length - 1; i >= 0; i--) {
      const run = deduped[i];
      if (run.slug === slug && run.handoffNotes && run.result !== 'pending') {
        return {
          handoffNotes: run.handoffNotes,
          stateSnapshot: run.stateSnapshot,
          fromRunId: run.runId,
          fromSession: run.sessionId,
          completedAt: run.completedAt ?? run.startedAt,
        };
      }
    }

    return null;
  }

  /**
   * Find a specific run by ID.
   */
  findRun(runId: string): JobRun | null {
    const all = this.readLines();
    // Last entry for this runId wins (append-only dedup)
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].runId === runId) return all[i];
    }
    return null;
  }

  /**
   * Read all entries and deduplicate by runId (last entry wins).
   */
  private getDeduplicatedRuns(): JobRun[] {
    const all = this.readLines();
    const byId = new Map<string, JobRun>();
    for (const run of all) {
      byId.set(run.runId, run);
    }
    return Array.from(byId.values());
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.ledgerDir)) {
      fs.mkdirSync(this.ledgerDir, { recursive: true });
    }
  }

  /**
   * Compact the JSONL file on startup: deduplicate entries so each runId
   * has exactly one record (the final state). This collapses pending → completed
   * pairs without losing any completed data. Nothing is ever deleted.
   */
  private compact(): void {
    if (!fs.existsSync(this.file)) return;

    const lines = this.readLines();
    if (lines.length === 0) return;

    const byId = new Map<string, JobRun>();
    for (const run of lines) {
      byId.set(run.runId, run);
    }

    const deduped = Array.from(byId.values());
    const removed = lines.length - deduped.length;

    if (removed > 0) {
      // Sort by startedAt to preserve chronological order in the file
      deduped.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const content = deduped.map(l => JSON.stringify(l)).join('\n') + '\n';
      fs.writeFileSync(this.file, content);
      // The rewrite invalidates the (size, mtime) readLines() just cached.
      // Seed the cache with the deduped set and the post-rewrite stat so the
      // first read after boot is a no-IO cache hit, not a full 13MB re-parse.
      try {
        const stat = fs.statSync(this.file);
        this.cachedRuns = deduped;
        this.cachedSize = stat.size;
        this.cachedMtimeMs = stat.mtimeMs;
      } catch {
        // @silent-fallback-ok — if the post-compaction stat fails, drop the cache
        // so the next read re-reads the freshly-written file from disk. The
        // compaction itself already succeeded (writeFileSync above); this only
        // governs whether we seed the in-memory cache or rebuild it lazily.
        this.cachedRuns = null;
        this.cachedSize = 0;
        this.cachedMtimeMs = 0;
      }
      console.log(`[JobRunHistory] Compacted ${removed} duplicate entries (${deduped.length} unique runs preserved)`);
    }
  }

  private appendLine(data: JobRun): void {
    try {
      const outcome = this.applyRowSizeCap(data);
      if (outcome.kind === 'invariant-failure') {
        this.reportCapacityInvariantFailure(data, outcome);
        return;
      }
      const capped = outcome.value;
      const serialized = JSON.stringify(capped) + '\n';
      fs.appendFileSync(this.file, serialized);
      // Keep the in-memory cache coherent with our own append so the read that
      // typically follows a completion does NOT have to re-stat+tail-read. If
      // the cache isn't populated yet, leave it null — the next read builds it.
      if (this.cachedRuns !== null) {
        this.cachedRuns.push(capped);
        try {
          const stat = fs.statSync(this.file);
          this.cachedSize = stat.size;
          this.cachedMtimeMs = stat.mtimeMs;
        } catch {
          // @silent-fallback-ok — if we can't stat after writing, drop the cache
          // so the NEXT read does a fresh full re-read rather than trusting a
          // stale (size,mtime). This is a self-correcting fail-safe (the data is
          // already durably on disk via appendFileSync), not a lost write.
          this.cachedRuns = null;
          this.cachedSize = 0;
          this.cachedMtimeMs = 0;
        }
      }
    } catch (error) {
      console.error(`[JobRunHistory] Failed to write:`, error);
    }
  }

  /**
   * Enforce the 2 KB per-row cap from spec §"Run-record observability".
   * If the serialized row exceeds the cap, non-essential fields are
   * progressively dropped (longest first by TRUNCATABLE_FIELDS order).
   * Essential fields are always preserved. Successful budget enforcement is
   * recorded durably on the row (`truncated: true`) and in aggregate stats; it
   * is not a degradation because the bounded write path completed as designed.
   */
  private applyRowSizeCap(row: JobRun): CapacityEnforcementResult<JobRun> {
    const initialSize = Buffer.byteLength(JSON.stringify(row), 'utf-8');
    if (initialSize <= ROW_SIZE_CAP_BYTES) {
      return capacityOutcome({
        value: row,
        originalBytes: initialSize,
        storedBytes: initialSize,
        capBytes: ROW_SIZE_CAP_BYTES,
        condensed: false,
      });
    }

    const limited: JobRun = { ...row, ["truncated"]: true };
    for (const field of TRUNCATABLE_FIELDS) {
      if (limited[field] === undefined) continue;
      delete (limited as unknown as Record<string, unknown>)[field];
      if (Buffer.byteLength(JSON.stringify(limited), 'utf-8') <= ROW_SIZE_CAP_BYTES) {
        break;
      }
    }

    const originalError = limited.error;
    if (Buffer.byteLength(JSON.stringify(limited), 'utf-8') > ROW_SIZE_CAP_BYTES &&
        typeof originalError === 'string') {
      const fitted = this.fitStringFieldToRowCap(limited, 'error', originalError);
      if (fitted !== null) {
        limited.error = fitted;
      }
    }

    const finalSize = Buffer.byteLength(JSON.stringify(limited), 'utf-8');
    if (finalSize > ROW_SIZE_CAP_BYTES && limited.error !== undefined) {
      delete (limited as unknown as Record<string, unknown>).error;
    }
    const storedSize = Buffer.byteLength(JSON.stringify(limited), 'utf-8');
    return capacityOutcome({
      value: limited,
      originalBytes: initialSize,
      storedBytes: storedSize,
      capBytes: ROW_SIZE_CAP_BYTES,
      condensed: true,
    });
  }

  private reportCapacityInvariantFailure(
    row: JobRun,
    outcome: Extract<CapacityEnforcementResult<JobRun>, { kind: 'invariant-failure' }>,
  ): void {
    const safeSlug = row.slug.slice(0, 120);
    // @unexpected-capacity-degradation contract=job-run-history-row@1
    DegradationReporter.getInstance().report({
      feature: 'JobRunHistory.appendLine',
      primary: `Store a run-history row at or below ${outcome.capBytes}B`,
      fallback: 'Refuse the over-budget row; no partial or oversized JSONL write was made',
      reason: `Capacity invariant failed for slug=${safeSlug}: essential row remained ${outcome.storedBytes}B after condensing (${outcome.originalBytes}B original)`,
      impact: 'This run-history transition was not persisted; the failure is explicit and operator-visible',
    });
  }

  private fitStringFieldToRowCap(row: JobRun, field: 'error', value: string): string | null {
    let low = 0;
    let high = value.length;
    let best: string | null = null;

    while (low <= high) {
      const keepChars = Math.floor((low + high) / 2);
      const candidate = this.headTailFit(value, keepChars);
      const candidateRow = { ...row, [field]: candidate };
      if (Buffer.byteLength(JSON.stringify(candidateRow), 'utf-8') <= ROW_SIZE_CAP_BYTES) {
        best = candidate;
        low = keepChars + 1;
      } else {
        high = keepChars - 1;
      }
    }

    return best;
  }

  private headTailFit(value: string, keepChars: number): string {
    if (keepChars >= value.length) return value;
    const headChars = Math.ceil(keepChars / 2);
    const tailChars = Math.floor(keepChars / 2);
    const omittedBytes = Buffer.byteLength(value.slice(headChars, value.length - tailChars), 'utf-8');
    const marker = `${ERROR_OMISSION_MARKER_PREFIX}${omittedBytes}${ERROR_OMISSION_MARKER_SUFFIX}`;
    return `${value.slice(0, headChars)}${marker}${tailChars > 0 ? value.slice(value.length - tailChars) : ''}`;
  }

  /**
   * Parse a JSONL string into JobRun rows, skipping torn/corrupt lines
   * (matches the long-standing readLines convention — a corrupt line reads as
   * absent and is repaired on the next compaction/append).
   */
  private parseJsonl(content: string): JobRun[] {
    const trimmed = content.trim();
    if (!trimmed) return [];
    return trimmed.split('\n').map(line => {
      try {
        return JSON.parse(line) as JobRun;
      } catch {
        // @silent-fallback-ok — a torn/corrupt JSONL line reads as absent; the
        // next compaction/append repairs it. This is the long-standing readLines
        // convention (moved here unchanged), not a new degradation.
        return null;
      }
    }).filter(Boolean) as JobRun[];
  }

  /**
   * Read all entries — cache-aware. Returns the parsed rows in file (append)
   * order. The result is the SAME as a full readFileSync+parse, but the
   * per-call cost is O(bytes-appended-since-last-read), not O(file-size):
   *
   *   - file unchanged (size + mtime match the cache) → return the cache, no IO.
   *   - file grew with an intact prefix → read ONLY the appended tail and merge.
   *   - file shrank / was rewritten (compaction, external truncation) → one
   *     full re-read (rare).
   *
   * On any read error the cache is cleared and an empty list is returned (the
   * historical fail-safe).
   */
  private readLines(): JobRun[] {
    if (!fs.existsSync(this.file)) {
      this.cachedRuns = [];
      this.cachedSize = 0;
      this.cachedMtimeMs = 0;
      return [];
    }

    try {
      const stat = fs.statSync(this.file);
      const size = stat.size;
      const mtimeMs = stat.mtimeMs;

      // Fast path: nothing changed on disk since the last read.
      if (this.cachedRuns !== null && size === this.cachedSize && mtimeMs === this.cachedMtimeMs) {
        return this.cachedRuns;
      }

      // Incremental tail-read: the file only grew and our cached prefix is
      // still valid (no truncation/rewrite). Read just the new bytes.
      if (this.cachedRuns !== null && size > this.cachedSize && this.cachedSize > 0) {
        const fd = fs.openSync(this.file, 'r');
        try {
          const tailLen = size - this.cachedSize;
          const buf = Buffer.allocUnsafe(tailLen);
          fs.readSync(fd, buf, 0, tailLen, this.cachedSize);
          const tail = buf.toString('utf-8');
          // The cached prefix ended on a newline boundary IFF the byte at
          // cachedSize-1 was '\n'. appendLine always writes a trailing '\n',
          // so a grow that begins mid-line means the previous write was torn;
          // parseJsonl drops that torn fragment safely. Merge the new rows.
          const newRuns = this.parseJsonl(tail);
          if (newRuns.length > 0) this.cachedRuns = this.cachedRuns.concat(newRuns);
          this.cachedSize = size;
          this.cachedMtimeMs = mtimeMs;
          return this.cachedRuns;
        } finally {
          fs.closeSync(fd);
        }
      }

      // Full re-read: first read, or the file shrank / was rewritten.
      const content = fs.readFileSync(this.file, 'utf-8');
      const runs = this.parseJsonl(content);
      this.cachedRuns = runs;
      this.cachedSize = size;
      this.cachedMtimeMs = mtimeMs;
      return runs;
    } catch (error) {
      console.error(`[JobRunHistory] Failed to read:`, error);
      DegradationReporter.getInstance().report({
        feature: 'JobRunHistory.readLines',
        primary: 'Read job run history ledger',
        fallback: 'Return empty — no historical data',
        reason: `Failed to read ledger: ${error instanceof Error ? error.message : String(error)}`,
        impact: 'Job history queries return empty results',
      });
      // Clear the cache so a transient error doesn't pin a stale view.
      this.cachedRuns = null;
      this.cachedSize = 0;
      this.cachedMtimeMs = 0;
      return [];
    }
  }
}
