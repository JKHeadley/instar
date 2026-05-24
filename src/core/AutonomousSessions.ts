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
  return {
    topic: readField(content, 'report_topic') || topicFromName,
    file,
    active: readField(content, 'active') === 'true',
    paused: readField(content, 'paused') === 'true',
    goal: readField(content, 'goal'),
    iteration: iterRaw && /^\d+$/.test(iterRaw) ? parseInt(iterRaw, 10) : null,
    startedAt: readField(content, 'started_at'),
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
export function stopAutonomousTopic(stateDir: string, topic: string): boolean {
  const f = path.join(autonomousDir(stateDir), `${topic}.local.md`);
  if (fs.existsSync(f)) {
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
export function stopAllAutonomousJobs(stateDir: string): StopAllResult {
  const stoppedTopics: string[] = [];
  const dir = autonomousDir(stateDir);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.local.md')) continue;
      SafeFsExecutor.safeRmSync(path.join(dir, name), { force: true, operation: 'AutonomousSessions.stopAllAutonomousJobs' });
      stoppedTopics.push(name.replace(/\.local\.md$/, ''));
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
