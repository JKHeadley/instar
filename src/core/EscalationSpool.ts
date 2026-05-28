/**
 * EscalationSpool — a durable, machine-level queue of outage pages the fleet
 * watchdog (or the migrator) needs delivered to the user.
 *
 * Spec: docs/specs/macos26-launchd-tcc-runtime-relocation.md (Scope C).
 *
 * WHY IT LIVES IN ~/.instar (not the agent's state dir): when a Documents-
 * resident agent is dead on macOS 26, neither the launchd-spawned watchdog nor
 * the dead agent can write into the TCC-locked `.instar`. `~/.instar` is outside
 * every TCC-protected folder, so the watchdog can ALWAYS append here, and any
 * consented context (a Claude SessionStart hook, `instar relocate`/`doctor`) can
 * drain it. The spool entries carry NO secret — just routing + cause + the
 * actionable remediation text. The token needed to actually send lives in the
 * per-agent credential (separate), or is read by a consented drainer from the
 * agent's own config.
 *
 * Dedup is one-shot PER OUTAGE EPISODE keyed on a STABLE id
 * (`label + firstDetectedDownEpoch`) — never a per-tick id (the tunnel-spam-209
 * lesson: a per-cycle key produces a flood). The first-detected-down marker also
 * lives here in ~/.instar so it survives even when the agent's state dir is
 * locked.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Machine-level instar dir — outside any TCC-protected folder. */
export function instarMachineDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.instar');
}

export function spoolPath(homeDir: string = os.homedir()): string {
  return path.join(instarMachineDir(homeDir), 'watchdog-escalations.jsonl');
}

export function episodeMarkerPath(label: string, homeDir: string = os.homedir()): string {
  return path.join(instarMachineDir(homeDir), 'escalation-episodes', `${sanitizeLabel(label)}.json`);
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]/g, '_');
}

export type EscalationCause =
  | 'tcc-spawn-blocked'
  | 'relocate-blocked'
  | 'relocate-needs-network'
  | 'heal-failed'
  | 'crash-loop';

export interface EscalationEntry {
  /** launchd label, e.g. ai.instar.b2lead-insights */
  label: string;
  projectDir: string;
  cause: EscalationCause;
  /** Epoch ms of when the outage was first detected — the STABLE dedup anchor. */
  firstDetectedDown: number;
  /** Plain-English, actionable remediation for the user. */
  remediation: string;
  /** When this entry was appended. */
  ts: string;
  /** Set true by a drainer once the page was delivered. */
  delivered?: boolean;
}

/** The stable dedup key for an outage episode. */
export function episodeKey(label: string, firstDetectedDown: number): string {
  return `${label}@${firstDetectedDown}`;
}

/**
 * Record (or read) when an agent was first detected down, so the dedup key is
 * stable across watchdog ticks. Returns the persisted firstDetectedDown epoch,
 * creating it (= now) on first sighting. `now` is injectable for tests.
 */
export function firstDetectedDown(label: string, now: number = Date.now(), homeDir: string = os.homedir()): number {
  const markerPath = episodeMarkerPath(label, homeDir);
  try {
    const existing = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    if (typeof existing.firstDetectedDown === 'number') return existing.firstDetectedDown;
  } catch { /* no marker yet */ }
  ensureDir(path.dirname(markerPath));
  atomicWrite(markerPath, JSON.stringify({ label, firstDetectedDown: now }), 0o600);
  return now;
}

/** Clear an agent's episode marker on recovery, so the next outage is a new
 *  episode (and pages again). */
export function clearEpisode(label: string, homeDir: string = os.homedir()): void {
  try { fs.rmSync(episodeMarkerPath(label, homeDir)); } catch { /* none */ }
}

/**
 * Append an escalation to the spool, deduped one-shot per episode. Returns true
 * if a NEW entry was written, false if this episode was already spooled (so the
 * caller doesn't re-page every tick).
 */
export function appendEscalation(entry: EscalationEntry, homeDir: string = os.homedir()): boolean {
  const key = episodeKey(entry.label, entry.firstDetectedDown);
  const existing = readEscalations(homeDir);
  if (existing.some((e) => episodeKey(e.label, e.firstDetectedDown) === key)) {
    return false; // already spooled this episode — dedup
  }
  const file = spoolPath(homeDir);
  ensureDir(path.dirname(file));
  // Append a single JSON line. Best-effort fsync via append mode.
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return true;
}

/** Read all spool entries (undelivered + delivered). Tolerates partial/garbage
 *  lines (skips them). */
export function readEscalations(homeDir: string = os.homedir()): EscalationEntry[] {
  const file = spoolPath(homeDir);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  const out: EscalationEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as EscalationEntry;
      if (e && typeof e.label === 'string' && typeof e.firstDetectedDown === 'number') out.push(e);
    } catch { /* skip malformed line */ }
  }
  return out;
}

/** Mark an episode's spool entry delivered (rewrites the file). Idempotent. */
export function markDelivered(label: string, firstDetectedDownEpoch: number, homeDir: string = os.homedir()): void {
  const key = episodeKey(label, firstDetectedDownEpoch);
  const entries = readEscalations(homeDir);
  let changed = false;
  for (const e of entries) {
    if (episodeKey(e.label, e.firstDetectedDown) === key && !e.delivered) {
      e.delivered = true;
      changed = true;
    }
  }
  if (!changed) return;
  const file = spoolPath(homeDir);
  atomicWrite(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 0o600);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function atomicWrite(file: string, contents: string, mode: number): void {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', mode); // mode-at-creation (umask-safe)
  try {
    fs.writeFileSync(fd, contents);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
