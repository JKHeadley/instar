/**
 * AutonomousSessions — multi-session autonomy control surface.
 *
 * Each autonomous job has its own state file at
 * `<stateDir>/autonomous/<topicId>.local.md`. A legacy single-file job at
 * `<stateDir>/autonomous-state.local.md` is also recognized for back-compat.
 *
 * This module is the read/control layer over those files: list active jobs,
 * enforce the concurrency cap + quota at start, and stop jobs (all or one).
 * The stop hook (`autonomous-stop-hook.sh`) is the per-session enforcer; this
 * module is what the server routes, the start path, and the stop-everything
 * path call. It never traps a session itself — it only reports and clears state.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { JobPriority } from './types.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

/** Default concurrent autonomous-job cap when config doesn't specify one. */
export const DEFAULT_MAX_CONCURRENT_AUTONOMOUS = 5;

export interface AutonomousJobSummary {
  topic: string | null;        // null for a legacy single-file job
  file: string;
  active: boolean;
  paused: boolean;
  goal: string | null;
  iteration: number | null;
  startedAt: string | null;
  /** duration_seconds front-matter field; null when absent/unparseable (unbounded run). */
  durationSeconds: number | null;
  reportChannel: string | null;
}

function autonomousDir(stateDir: string): string {
  return path.join(stateDir, 'autonomous');
}
function legacyFile(stateDir: string): string {
  return path.join(stateDir, 'autonomous-state.local.md');
}

/** Pipefail-safe single-field read from a state file's frontmatter. */
function readField(content: string, key: string): string | null {
  const m = content.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?\\s*$`, 'm'));
  return m ? m[1].trim() : null;
}

function summarize(file: string, topicFromName: string | null): AutonomousJobSummary | null {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const iterRaw = readField(content, 'iteration');
  const durRaw = readField(content, 'duration_seconds');
  return {
    topic: readField(content, 'report_topic') || topicFromName,
    file,
    active: readField(content, 'active') === 'true',
    paused: readField(content, 'paused') === 'true',
    goal: readField(content, 'goal'),
    iteration: iterRaw && /^\d+$/.test(iterRaw) ? parseInt(iterRaw, 10) : null,
    startedAt: readField(content, 'started_at'),
    durationSeconds: durRaw && /^\d+$/.test(durRaw) ? parseInt(durRaw, 10) : null,
    reportChannel: readField(content, 'report_channel'),
  };
}

/** All autonomous jobs (per-topic files + a legacy single file if present). */
export function listAutonomousJobs(stateDir: string): AutonomousJobSummary[] {
  const out: AutonomousJobSummary[] = [];
  const dir = autonomousDir(stateDir);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.local.md')) continue;
      const topic = name.replace(/\.local\.md$/, '');
      const s = summarize(path.join(dir, name), topic);
      if (s) out.push(s);
    }
  } catch {
    /* dir absent — no per-topic jobs */
  }
  const legacy = legacyFile(stateDir);
  if (fs.existsSync(legacy)) {
    const s = summarize(legacy, null);
    if (s) out.push(s);
  }
  return out;
}

/** Active (and not paused) autonomous jobs — what counts against the cap. */
export function activeAutonomousJobs(stateDir: string): AutonomousJobSummary[] {
  return listAutonomousJobs(stateDir).filter((j) => j.active && !j.paused);
}

export interface CanStartDeps {
  stateDir: string;
  maxConcurrent: number;
  quotaCanStart?: (priority?: JobPriority) => { allowed: boolean; reason: string };
  priority?: JobPriority;
}

export interface CanStartResult {
  allowed: boolean;
  reason: string;
  activeCount: number;
  maxConcurrent: number;
}

/**
 * Decide whether a new autonomous job may start: concurrency cap first
 * (refuse-new at the cap), then quota (refuse-new under budget pressure).
 * Never preempts a running job — that's the pause path, handled elsewhere.
 */
export function canStartAutonomousJob(deps: CanStartDeps): CanStartResult {
  const active = activeAutonomousJobs(deps.stateDir);
  const activeCount = active.length;
  if (activeCount >= deps.maxConcurrent) {
    const topics = active.map((j) => j.topic ?? 'legacy').join(', ');
    return {
      allowed: false,
      activeCount,
      maxConcurrent: deps.maxConcurrent,
      reason: `concurrency cap reached (${activeCount}/${deps.maxConcurrent}); running: ${topics}`,
    };
  }
  if (deps.quotaCanStart) {
    const q = deps.quotaCanStart(deps.priority);
    if (!q.allowed) {
      return { allowed: false, activeCount, maxConcurrent: deps.maxConcurrent, reason: `quota: ${q.reason}` };
    }
  }
  return { allowed: true, activeCount, maxConcurrent: deps.maxConcurrent, reason: 'ok' };
}

/** Stop exactly one topic's job (removes its state file). Returns true if removed. */
/**
 * Minimal journal seam (COHERENCE-JOURNAL-SPEC §3.3): the stop funnels emit
 * `stopped` directly when a handle is threaded by the caller. Callers without
 * the handle still get coverage from the journal scanner's observed-stopped
 * (≤ one scan interval later); op-key dedupe collapses the two.
 */
export interface AutonomousJournalSeam {
  emitAutonomousRun(topic: number, data: { action: 'started' | 'stopped'; runId: string; artifactPaths: string[] }): void;
}

/** The stable runId formula shared by the scanner and the stop funnels. */
export function autonomousRunId(startedAt: string | null, topic: string): string {
  return `${startedAt ?? 'unknown'}:${topic}`;
}

function emitStopped(journal: AutonomousJournalSeam | undefined, stateDir: string, topic: string, file: string): void {
  if (!journal) return;
  try {
    const topicNum = Number(topic);
    if (!Number.isFinite(topicNum)) return;
    // Read startedAt BEFORE the file is removed so the runId matches the
    // scanner's started emit (op-key dedupe depends on the same formula).
    const job = listAutonomousJobs(stateDir).find((j) => j.topic === topic);
    journal.emitAutonomousRun(topicNum, {
      action: 'stopped',
      runId: autonomousRunId(job?.startedAt ?? null, topic),
      artifactPaths: [file],
    });
  } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
    /* observability never endangers the observed */
  }
}

/**
 * WS1.4 (MULTI-MACHINE-SEAMLESSNESS-SPEC): suspend a topic's autonomous run
 * for a CONFIRMED topic move — distinct from stop in exactly one way: the
 * state file SURVIVES so it can ride the working-set carrier to the new
 * owner. Setting `active: false` makes the stop hook release the session at
 * its next turn boundary (the spec's "stops at a turn boundary"); the
 * `moved_to` + `move_suspended_at` markers are the honest breadcrumb for
 * whoever resumes it. The rewrite is ATOMIC (temp + fsync + rename) so the
 * carrier can never ship a half-rewritten file, and the journal `stopped`
 * emit is what re-fires the receiving machine's working-set pull
 * (WorkingSetManifest §3.4 liveSource re-fire).
 *
 * Idempotent: re-suspending an already-suspended file refreshes the markers
 * and returns true; a missing file returns false.
 */
export function suspendAutonomousTopicForMove(
  stateDir: string,
  topic: string,
  targetMachine: string,
  journal?: AutonomousJournalSeam,
): { suspended: boolean; file?: string } {
  const f = path.join(autonomousDir(stateDir), `${topic}.local.md`);
  let content: string;
  try {
    content = fs.readFileSync(f, 'utf8');
  } catch {
    return { suspended: false };
  }
  // Same tolerance as readField (quoted forms included) — the reader and the
  // flip MUST agree on what counts as a live run, or a run the veto saw as
  // live could survive the flip and be reported suspended (second-pass
  // finding, 2026-06-13: silent false success).
  const wasActive = readField(content, 'active') === 'true';
  const alreadyMoveSuspended = /^moved_to:/m.test(content);
  if (!wasActive && !alreadyMoveSuspended) {
    // Nothing to suspend (not live, not a prior move-suspend to refresh) —
    // honest no-op, never a claimed success.
    return { suspended: false };
  }
  const stamp = new Date().toISOString();
  let next = wasActive ? content.replace(/^active:\s*"?true"?\s*$/m, 'active: false') : content;
  if (readField(next, 'active') === 'true') {
    // The flip did not land (an active-line shape the reader accepts but the
    // rewrite does not) — report failure rather than a torn half-suspend.
    return { suspended: false };
  }
  // Refresh-or-insert the move markers (idempotent across re-suspends),
  // anchored to the (now false) active line.
  for (const [key, val] of [
    ['move_suspended_at', `"${stamp}"`],
    ['moved_to', `"${targetMachine}"`],
  ] as const) {
    const line = `${key}: ${val}`;
    next = new RegExp(`^${key}:`, 'm').test(next)
      ? next.replace(new RegExp(`^${key}:.*$`, 'm'), line)
      : next.replace(/^active:.*$/m, (m) => `${m}\n${line}`);
  }
  // Journal the stop ONLY for a genuinely-live run being suspended (a marker
  // refresh re-emits nothing; the scanner's op-key dedupe would collapse it
  // anyway). Before the rewrite, so listAutonomousJobs reads the live file.
  if (wasActive) emitStopped(journal, stateDir, topic, f);
  // Atomic snapshot: temp file in the SAME directory, fsync'd, renamed over.
  const tmp = `${f}.tmp-move`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, next, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, f);
  return { suspended: true, file: f };
}

/**
 * Stamp a (move-suspended) run file `interrupted_mid_task: true` — the honest
 * marker that the drain bound forced the close before the session reached a
 * turn boundary (WS1.2). The resuming machine surfaces it so the run knows its
 * final turn may be partial. Idempotent; missing file is a no-op (the drain
 * may have closed a session with no run).
 */
export function markAutonomousInterruptedMidTask(stateDir: string, topic: string): boolean {
  const f = path.join(autonomousDir(stateDir), `${topic}.local.md`);
  let content: string;
  try {
    content = fs.readFileSync(f, 'utf8');
  } catch {
    return false;
  }
  const line = 'interrupted_mid_task: true';
  const next = /^interrupted_mid_task:/m.test(content)
    ? content.replace(/^interrupted_mid_task:.*$/m, line)
    : content.replace(/^active:.*$/m, (m) => `${m}\n${line}`);
  if (next === content) return /^interrupted_mid_task:\s*true\s*$/m.test(content);
  const tmp = `${f}.tmp-interrupt`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, next, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, f);
  return true;
}

export function stopAutonomousTopic(stateDir: string, topic: string, journal?: AutonomousJournalSeam): boolean {
  const f = path.join(autonomousDir(stateDir), `${topic}.local.md`);
  if (fs.existsSync(f)) {
    emitStopped(journal, stateDir, topic, f);
    SafeFsExecutor.safeRmSync(f, { force: true, operation: 'AutonomousSessions.stopAutonomousTopic' });
    return true;
  }
  return false;
}

export interface StopAllResult {
  stoppedTopics: string[];
  stoppedLegacy: boolean;
}

/**
 * Stop every autonomous job. Removes all per-topic files + the legacy file and
 * writes the emergency-stop flag so any session whose hook fires before its file
 * is gone also stands down. The flag is the belt; removing files is the suspenders.
 */
export function stopAllAutonomousJobs(stateDir: string, journal?: AutonomousJournalSeam): StopAllResult {
  const stoppedTopics: string[] = [];
  const dir = autonomousDir(stateDir);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.local.md')) continue;
      const topic = name.replace(/\.local\.md$/, '');
      emitStopped(journal, stateDir, topic, path.join(dir, name));
      SafeFsExecutor.safeRmSync(path.join(dir, name), { force: true, operation: 'AutonomousSessions.stopAllAutonomousJobs' });
      stoppedTopics.push(topic);
    }
  } catch {
    /* dir absent */
  }
  let stoppedLegacy = false;
  const legacy = legacyFile(stateDir);
  if (fs.existsSync(legacy)) {
    SafeFsExecutor.safeRmSync(legacy, { force: true, operation: 'AutonomousSessions.stopAllAutonomousJobs(legacy)' });
    stoppedLegacy = true;
  }
  try {
    fs.writeFileSync(path.join(stateDir, 'autonomous-emergency-stop'), `stopped-all ${new Date().toISOString()}\n`);
  } catch {
    /* best-effort flag */
  }
  return { stoppedTopics, stoppedLegacy };
}

/** Pause one topic's job (hook will allow exit until resumed). Returns true if updated. */
export function pauseAutonomousTopic(stateDir: string, topic: string): boolean {
  const f = path.join(autonomousDir(stateDir), `${topic}.local.md`);
  if (!fs.existsSync(f)) return false;
  let content = fs.readFileSync(f, 'utf8');
  if (/^paused:/m.test(content)) {
    content = content.replace(/^paused:.*$/m, 'paused: true');
  } else {
    content = content.replace(/^(active:.*)$/m, '$1\npaused: true');
  }
  fs.writeFileSync(f, content);
  return true;
}
