/**
 * CodexResumeMap — per-topic Codex rollout-id capture-at-kill,
 * TOPIC-PROFILE-SPEC §7 (prerequisite sub-task).
 *
 * `TopicResumeMap` + the `beforeSessionKill` listener capture only Claude
 * JSONL UUIDs; nothing captured Codex's rollout id from ~/.codex/sessions —
 * so the "Codex resume = none-loss" swap row would be a lie without this
 * (round-1 adversarial, CRITICAL). Scope: the per-topic sessionId
 * capture-at-kill only — `FrameworkSessionStore` already resolves a rollout
 * path GIVEN a sessionId, and `codex resume <id>` launch support exists.
 *
 * Capture is TIME-FENCED DISCOVERY scoped to the spawned session (Codex has
 * no hook, and a naive newest-rollout mtime scan is the wrong-conversation
 * class §8 brands worse than disclosed loss):
 *  - record the spawn timestamp + pane cwd at launch;
 *  - accept only a rollout file created after spawn whose recorded session
 *    cwd matches the topic's session;
 *  - THE FENCE IS ZERO-OR-ONE: if more than one candidate passes, capture
 *    NOTHING — the swap row degrades to recent-only, disclosed (round-5).
 *  - ambiguity-discards are counted separately from fence-validation
 *    failures (only genuine validation failures feed the L5 drift signal —
 *    round-6: ambient same-dir ambiguity must not fire false "codex CLI
 *    format drifted" signals or mask real drift).
 *
 * Entries are framework-tagged + provenance-tagged ('fence'), and support
 * PARKING (§8 — a fresh respawn parks rather than deletes, so the §10.4
 * breaker revert / §10.3 undo can un-park and resume the surviving
 * transcript). Read/write discipline per §5.1: in-memory authoritative,
 * atomic tmp+rename flush.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  codexHomeFromConfig,
  findRolloutFileSync,
  listAllRollouts,
} from '../providers/adapters/openai-codex/observability/sessionPaths.js';

export interface CodexResumeEntry {
  rolloutId: string;
  savedAt: string;
  sessionName: string;
  framework: 'codex-cli';
  provenance: 'fence';
  /** §8 — parked entries are ignored by resolution but recoverable. */
  parked: string | null;
}

export interface CodexSpawnFence {
  /** Epoch ms the codex session was spawned. */
  spawnedAt: number;
  /** The pane cwd recorded at launch. */
  cwd: string;
}

/** Entries older than 24 hours are pruned (mirrors TopicResumeMap). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How many newest rollouts to inspect for fence candidates. */
const FENCE_SCAN_LIMIT = 24;

export interface FenceCaptureResult {
  outcome: 'captured' | 'ambiguous' | 'none' | 'validation-failed';
  rolloutId?: string;
  candidateCount: number;
}

export class CodexResumeMap {
  private readonly filePath: string;
  private readonly codexHome?: string;
  private entries: Record<string, CodexResumeEntry> = {};

  /** Per-(machine,framework) consecutive fence-validation failures (§7 L5 drift). */
  private consecutiveValidationFailures = 0;
  /** Distinct non-drift metric: multi-candidate discards (§7 round-6). */
  private ambiguityDiscards = 0;

  constructor(stateDir: string, codexHome?: string) {
    this.filePath = path.join(stateDir, 'codex-resume-map.json');
    this.codexHome = codexHome;
    this.load();
  }

  /**
   * Capture the rollout id for a topic's codex session at kill time, against
   * the spawn fence. Zero-or-one: multiple passing candidates capture
   * nothing. Returns the structured outcome so the §8 kill path can disclose
   * the real loss class and the drift counters stay honest.
   */
  async captureAtKill(
    topicKey: number | string,
    sessionName: string,
    fence: CodexSpawnFence,
  ): Promise<FenceCaptureResult> {
    let candidates: Array<{ path: string; mtime: number }>;
    try {
      const all = await listAllRollouts(this.codexHome, FENCE_SCAN_LIMIT);
      candidates = all.filter((r) => r.mtime >= fence.spawnedAt);
    } catch {
      this.consecutiveValidationFailures += 1;
      return { outcome: 'validation-failed', candidateCount: 0 };
    }

    // Validate each post-spawn rollout against the fence: created after
    // spawn (creation ≈ the timestamp embedded in the filename ordering —
    // mtime is the upper bound we filtered on) AND the recorded session cwd
    // matches.
    const passing: Array<{ rolloutId: string }> = [];
    let sawParseFailure = false;
    for (const candidate of candidates) {
      const meta = readRolloutMeta(candidate.path);
      if (meta === 'unreadable') {
        sawParseFailure = true;
        continue;
      }
      if (meta === null) continue; // readable but not a session-meta rollout — not ours
      if (!cwdMatches(meta.cwd, fence.cwd)) continue;
      if (meta.createdAtMs !== null && meta.createdAtMs < fence.spawnedAt) continue;
      const rolloutId = rolloutIdFromFilename(candidate.path);
      if (!rolloutId) {
        sawParseFailure = true;
        continue;
      }
      passing.push({ rolloutId });
    }

    if (passing.length === 1) {
      this.consecutiveValidationFailures = 0;
      this.save(topicKey, passing[0].rolloutId, sessionName);
      return { outcome: 'captured', rolloutId: passing[0].rolloutId, candidateCount: 1 };
    }
    if (passing.length > 1) {
      // Zero-or-one rule — counted SEPARATELY from validation failures.
      this.ambiguityDiscards += 1;
      return { outcome: 'ambiguous', candidateCount: passing.length };
    }
    if (sawParseFailure) {
      // Genuine validation failure (format/location mismatch) — feeds drift.
      this.consecutiveValidationFailures += 1;
      return { outcome: 'validation-failed', candidateCount: 0 };
    }
    // No candidates at all (e.g. session never wrote a rollout). Not drift.
    return { outcome: 'none', candidateCount: 0 };
  }

  /** Persist a fence-validated mapping. */
  save(topicKey: number | string, rolloutId: string, sessionName: string): void {
    this.entries[String(topicKey)] = {
      rolloutId,
      savedAt: new Date().toISOString(),
      sessionName,
      framework: 'codex-cli',
      provenance: 'fence',
      parked: null,
    };
    this.prune();
    this.persist();
  }

  /**
   * Resume id for a topic — null when absent, parked, expired, or the
   * rollout file no longer exists on THIS machine (§5.3 transcript locality).
   */
  get(topicKey: number | string): string | null {
    const entry = this.entries[String(topicKey)];
    if (!entry || entry.parked) return null;
    if (Date.now() - new Date(entry.savedAt).getTime() > MAX_AGE_MS) return null;
    if (findRolloutFileSync(entry.rolloutId, this.codexHome) === null) return null;
    return entry.rolloutId;
  }

  /** Raw entry (parked included) for §8 park/un-park machinery. */
  getEntry(topicKey: number | string): CodexResumeEntry | null {
    return this.entries[String(topicKey)] ?? null;
  }

  /** §8 — "remove" means PARK, not delete (deletion destroys the cheap recovery). */
  park(topicKey: number | string, reason: string): void {
    const entry = this.entries[String(topicKey)];
    if (entry && !entry.parked) {
      entry.parked = reason;
      this.persist();
    }
  }

  /** §10.4 revert / §10.3 undo — un-park the matching-framework entry. */
  unpark(topicKey: number | string): boolean {
    const entry = this.entries[String(topicKey)];
    if (entry?.parked) {
      entry.parked = null;
      this.persist();
      return true;
    }
    return false;
  }

  /** Hard removal (successful resume consumption / stale-id clear). */
  remove(topicKey: number | string): void {
    if (this.entries[String(topicKey)]) {
      delete this.entries[String(topicKey)];
      this.persist();
    }
  }

  /** §7 drift signal inputs — read by the L5 canary plumbing. */
  driftCounters(): { consecutiveValidationFailures: number; ambiguityDiscards: number } {
    return {
      consecutiveValidationFailures: this.consecutiveValidationFailures,
      ambiguityDiscards: this.ambiguityDiscards,
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const key of Object.keys(this.entries)) {
      if (now - new Date(this.entries[key].savedAt).getTime() > MAX_AGE_MS) {
        delete this.entries[key];
      }
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Record<string, CodexResumeEntry>;
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) {
          if (value && typeof value.rolloutId === 'string' && typeof value.savedAt === 'string') {
            this.entries[key] = {
              rolloutId: value.rolloutId,
              savedAt: value.savedAt,
              sessionName: typeof value.sessionName === 'string' ? value.sessionName : '',
              framework: 'codex-cli',
              provenance: 'fence',
              parked: typeof value.parked === 'string' ? value.parked : null,
            };
          }
        }
      }
    } catch (err) {
      console.warn(`[CodexResumeMap] Failed to load ${this.filePath}: ${err}`);
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 2), 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error(`[CodexResumeMap] Failed to persist: ${err}`);
    }
  }
}

/** Extract the rollout UUID from `rollout-<ts>-<uuid>.jsonl`. */
export function rolloutIdFromFilename(rolloutPath: string): string | null {
  const base = path.basename(rolloutPath, '.jsonl');
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(base);
  return m ? m[1] : null;
}

/**
 * Read the session metadata (cwd + creation time) from a rollout file's
 * first line. Codex writes a `session_meta` record first, carrying the
 * session's cwd. Returns:
 *  - the meta when parsed,
 *  - null when the file parses but carries no session meta (not a session
 *    rollout we can attribute — skip silently),
 *  - 'unreadable' on read/parse failure (feeds the drift counter).
 */
function readRolloutMeta(
  rolloutPath: string,
): { cwd: string | null; createdAtMs: number | null } | null | 'unreadable' {
  let firstLine: string;
  try {
    // Rollout first lines are small; read a bounded prefix.
    const fd = fs.openSync(rolloutPath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytes).toString('utf-8');
      const nl = text.indexOf('\n');
      firstLine = nl === -1 ? text : text.slice(0, nl);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // @silent-fallback-ok: returns the 'unreadable' SENTINEL, not a default —
    // the fence-capture caller COUNTS unreadable rollouts and degrades to the
    // zero-or-one rule (refuse the capture) instead of blind-capturing.
    return 'unreadable';
  }
  if (!firstLine.trim()) return 'unreadable';
  try {
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    // Layouts seen across codex versions: { type:'session_meta', payload:{ cwd, timestamp } }
    // or a flat { cwd, timestamp }-bearing meta record.
    const payload = (parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : parsed) as Record<string, unknown>;
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
    const ts = typeof payload.timestamp === 'string' ? Date.parse(payload.timestamp) : NaN;
    if (cwd === null && Number.isNaN(ts)) return null;
    return { cwd, createdAtMs: Number.isNaN(ts) ? null : ts };
  } catch {
    // @silent-fallback-ok: a malformed first rollout line yields the same
    // 'unreadable' SENTINEL as a read failure — counted by the fence-capture
    // caller, which refuses the capture under the zero-or-one rule rather
    // than guessing a session id from a corrupt meta record.
    return 'unreadable';
  }
}

function cwdMatches(recorded: string | null, fenceCwd: string): boolean {
  if (recorded === null) return false;
  return path.resolve(recorded) === path.resolve(fenceCwd);
}

export { codexHomeFromConfig };
