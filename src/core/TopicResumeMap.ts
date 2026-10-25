/**
 * TopicResumeMap — Persistent mapping from Telegram topic IDs to Claude session UUIDs.
 *
 * Before killing an idle interactive session, the system persists the Claude
 * session UUID so it can be resumed when the next message arrives on that topic.
 * This avoids cold-starting sessions (rebuilding context from topic history)
 * and provides seamless conversational continuity.
 *
 * Storage: {stateDir}/topic-resume-map.json
 * Entries auto-prune after 24 hours.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { findRolloutFileSync } from '../providers/adapters/openai-codex/observability/sessionPaths.js';
import { findGeminiSessionFileSync } from '../providers/adapters/gemini-cli/observability/sessionPaths.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { claudeConfigHomes } from './claudeResumeTranscript.js';
import { withSyncOp } from './InFlightSyncOpMarker.js';

/** §8 provenance tag — gates the none-loss claim (TOPIC-PROFILE-SPEC §7/§8). */
export type ResumeProvenance = 'hook' | 'mtime-fallback';

export interface ResumeEntry {
  uuid: string;
  savedAt: string;
  sessionName: string;
  /**
   * §8 framework tag. Untagged legacy entries are grandfathered as
   * 'claude-code' (provably safe — this map has only ever captured Claude
   * JSONL UUIDs) and tagged lazily on the next write.
   */
  framework?: string;
  /** Untagged legacy entries grandfather as 'hook' (same provable basis). */
  provenance?: ResumeProvenance;
  /**
   * §8 — "remove" means PARK, not delete: parked entries are ignored by
   * resolution (get() returns null) but recoverable by the §10.4 breaker
   * revert / §10.3 undo via unpark(). Holds the parking reason.
   */
  parked?: string | null;
}

interface ResumeMap {
  [topicId: string]: ResumeEntry;
}

/**
 * §8 resume-writer gate (TOPIC-PROFILE-SPEC round-3 adversarial): EVERY
 * writer — the beforeSessionKill listener, the 60s heartbeat
 * (refreshResumeMappings), the 8s post-spawn proactive save, and the
 * shutdown/refresh-route saves — funnels through save()/refreshResumeMappings,
 * so a single gate at this chokepoint covers all four structurally. The gate
 * refuses a write for a topic whose resolved profile framework is not
 * claude-code, or whose topic is under an active mid-framework-switch
 * suppression marker. Without it, the heartbeat would re-poison the map
 * within a minute of a framework switch.
 */
export type ResumeWriteGate = (topicId: number) => { allowed: boolean; reason?: string };

/** Entries older than 24 hours are pruned */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class TopicResumeMap {
  private filePath: string;
  private projectDir: string;
  private tmuxPath: string;
  private writeGate: ResumeWriteGate | null = null;

  constructor(stateDir: string, projectDir: string, tmuxPath?: string) {
    this.filePath = path.join(stateDir, 'topic-resume-map.json');
    this.projectDir = projectDir;
    this.tmuxPath = tmuxPath || 'tmux';
  }

  /**
   * Compute the Claude Code project directory name for this project.
   * Claude Code hashes the project path by replacing '/' with '-' and
   * stripping dots — e.g. /Users/foo/.bar/baz → -Users-foo--bar-baz
   */
  private claudeProjectDirName(): string {
    return this.projectDir.replace(/[\/\.]/g, '-');
  }

  /**
   * Get the full path to this project's Claude JSONL directory.
   */
  private claudeProjectJsonlDir(): string {
    return path.join(os.homedir(), '.claude', 'projects', this.claudeProjectDirName());
  }

  /**
   * Discover the Claude session UUID from the most recent JSONL file
   * in THIS project's .claude/projects/ directory.
   *
   * Scoped to the current project to avoid cross-project UUID contamination.
   */
  findClaudeSessionUuid(): string | null {
    const projectJsonlDir = this.claudeProjectJsonlDir();

    if (!fs.existsSync(projectJsonlDir)) return null;

    try {
      let latestFile: { name: string; mtime: number } | null = null;

      const files = fs.readdirSync(projectJsonlDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = path.join(projectJsonlDir, file);
        try {
          const fileStat = fs.statSync(filePath);
          if (!latestFile || fileStat.mtimeMs > latestFile.mtime) {
            latestFile = { name: file, mtime: fileStat.mtimeMs };
          }
        } catch {
          // Skip inaccessible files
        }
      }

      if (!latestFile) return null;

      // Extract UUID from filename (format: {uuid}.jsonl)
      const basename = path.basename(latestFile.name, '.jsonl');
      // Validate UUID format (8-4-4-4-12)
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(basename)) {
        return basename;
      }
    } catch {
      // Silent failure — can't read Claude projects dir
    }

    return null;
  }

  /**
   * Find the Claude session UUID for a specific tmux session.
   *
   * Only uses the authoritative claudeSessionId from hook events.
   * The mtime-based heuristic was removed because it causes cross-topic
   * contamination when multiple sessions are active — it always picks
   * the most recent JSONL file regardless of which session it belongs to.
   */
  findUuidForSession(tmuxSession: string, claudeSessionId?: string, framework?: string): string | null {
    if (claudeSessionId && this.jsonlExists(claudeSessionId, framework)) {
      return claudeSessionId;
    }

    // No authoritative source — refuse to guess. Better to fall back
    // to thread history than resume the wrong conversation.
    return null;
  }

  /**
   * Install the §8 profile write-gate (TOPIC-PROFILE-SPEC). All writers are
   * gated at this single chokepoint — the heartbeat, the kill listener, the
   * post-spawn save and the shutdown saves all land in save()/
   * refreshResumeMappings. No gate installed ⇒ today's behavior (ungated).
   */
  setWriteGate(gate: ResumeWriteGate | null): void {
    this.writeGate = gate;
  }

  private gateAllows(topicId: number): boolean {
    if (!this.writeGate) return true;
    try {
      return this.writeGate(topicId).allowed;
    } catch {
      // A broken gate must not silence resume capture (the safe direction
      // for an ungateable read is today's behavior).
      return true;
    }
  }

  /**
   * Persist a resume mapping before killing an idle session.
   * Entries are framework-tagged ('claude-code' — this map only ever holds
   * Claude JSONL UUIDs) and provenance-tagged (§8). A refused (gated) write
   * is a silent no-op — the gate's caller owns disclosure.
   */
  save(topicId: number, uuid: string, sessionName: string, provenance: ResumeProvenance = 'hook'): void {
    if (!this.gateAllows(topicId)) return;
    const map = this.load();

    map[String(topicId)] = {
      uuid,
      savedAt: new Date().toISOString(),
      sessionName,
      framework: 'claude-code',
      provenance,
    };

    // Prune old entries
    const now = Date.now();
    for (const key of Object.keys(map)) {
      const entry = map[key];
      if (now - new Date(entry.savedAt).getTime() > MAX_AGE_MS) {
        delete map[key];
      }
    }

    try {
      fs.writeFileSync(this.filePath, JSON.stringify(map, null, 2));
    } catch (err) {
      console.error(`[TopicResumeMap] Failed to save: ${err}`);
    }
  }

  /**
   * Look up a resume UUID for a topic. Returns null if not found,
   * expired, or the JSONL file no longer exists.
   */
  get(topicId: number): string | null {
    const map = this.load();
    const entry = map[String(topicId)];
    if (!entry) return null;

    // §8 — parked entries are ignored by resolution (recoverable via unpark).
    if (entry.parked) return null;
    // Resume Follows the Account §3.3: a pointer saved by the removed
    // newest-file guess was never trustworthy (it resumed internal one-shot
    // transcripts on sagemind 2026-09-16). Ignore it; it expires on its own.
    if (entry.provenance === 'mtime-fallback') return null;

    // Check age
    if (Date.now() - new Date(entry.savedAt).getTime() > MAX_AGE_MS) {
      return null;
    }

    // Verify the transcript still exists — in the layout of the framework the
    // entry was recorded for. Untagged legacy entries grandfather as
    // 'claude-code' (this map has only ever captured Claude JSONL UUIDs), so a
    // Claude entry is never sent into the Codex or Gemini archive discovery.
    if (!this.jsonlExists(entry.uuid, entry.framework ?? 'claude-code')) {
      return null;
    }

    return entry.uuid;
  }

  /**
   * §8 last-line guard: the spawn path REFUSES a resume id whose framework
   * tag mismatches the resolved framework, falling to CONTINUATION with
   * disclosure. Untagged legacy entries grandfather as 'claude-code'.
   */
  getForFramework(topicId: number, resolvedFramework: string): string | null {
    const entry = this.load()[String(topicId)];
    if (!entry) return null;
    const tag = entry.framework ?? 'claude-code';
    if (tag !== resolvedFramework) return null;
    return this.get(topicId);
  }

  /**
   * §8 provenance read — the none-loss rows require HOOK provenance; an
   * mtime-fallback-only entry classifies as CONTINUATION-class loss.
   * Untagged legacy entries grandfather as 'hook' (provably safe).
   */
  getProvenance(topicId: number): ResumeProvenance | null {
    const entry = this.load()[String(topicId)];
    if (!entry || entry.parked) return null;
    return entry.provenance ?? 'hook';
  }

  /** Raw entry (parked included) for the §8 park/un-park machinery. */
  getEntryRaw(topicId: number): ResumeEntry | null {
    return this.load()[String(topicId)] ?? null;
  }

  /** §8 — "remove" means PARK, not delete (deletion destroys the cheap recovery). */
  park(topicId: number, reason: string): void {
    const map = this.load();
    const entry = map[String(topicId)];
    if (!entry || entry.parked) return;
    entry.parked = reason;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(map, null, 2));
    } catch (err) {
      console.error(`[TopicResumeMap] Failed to park: ${err}`);
      DegradationReporter.getInstance().report({
        feature: 'TopicResumeMap.park',
        primary: "Park a topic's resume entry so resolution ignores it (§8 mid-framework-switch suppression)",
        fallback: 'The entry stays live on disk — resolution keeps returning the old resume UUID',
        reason: `Park write failed: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'A framework switch may resume the previous framework\'s transcript on the next spawn (the exact poisoning the park exists to prevent)',
      });
    }
  }

  /** §10.4 revert / §10.3 undo — un-park the entry. Returns true when un-parked. */
  unpark(topicId: number): boolean {
    const map = this.load();
    const entry = map[String(topicId)];
    if (!entry?.parked) return false;
    entry.parked = null;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(map, null, 2));
    } catch (err) {
      // @silent-fallback-ok: not silent — the write failure is logged and
      // SURFACED to the caller via the boolean return; the §10.4 revert /
      // §10.3 undo paths own disclosure of an undo that did not land.
      console.error(`[TopicResumeMap] Failed to unpark: ${err}`);
      return false;
    }
    return true;
  }

  /**
   * Remove an entry after successful resume (prevents stale reuse).
   */
  remove(topicId: number): void {
    const map = this.load();
    delete map[String(topicId)];
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(map, null, 2));
    } catch {
      // Best effort
    }
  }

  /**
   * Proactive resume heartbeat: update the topic→UUID mapping for all active
   * topic-linked sessions. Called periodically (e.g., every 60s).
   *
   * Records only the authoritative Claude session ID reported through hooks.
   * The former single-session "newest JSONL by mtime" guess is removed: on a
   * busy agent the newest transcript is an internal one-shot classifier call,
   * which poisoned resume pointers (Resume Follows the Account §3.3).
   *
   * @param topicSessions - Map of topicId → { sessionName, claudeSessionId? }
   */
  refreshResumeMappings(topicSessions: Map<number, { sessionName: string; claudeSessionId?: string; framework?: string }>): void {
    try {
      if (!topicSessions || topicSessions.size === 0) return;

      const map = this.load();
      let updated = 0;

      // Count how many sessions have known UUIDs vs unknown
      const activeSessions: Array<{ topicId: number; sessionName: string; claudeSessionId?: string; framework?: string }> = [];
      for (const [topicId, info] of topicSessions) {
        // Verify Claude is actually running in the pane. A crashed Claude keeps
        // its tmux session (remain-on-exit failed), so `has-session` alone
        // counted dead panes as live. One display-message call reads both.
        // Measured on tmux 3.6a: a MISSING session exits 0 with empty fields,
        // so an empty pane id means gone; pane_dead `1` means the process exited.
        const probe = withSyncOp(() => spawnSync(this.tmuxPath, ['display-message', '-t', `=${info.sessionName}:`, '-p', '#{pane_id}||#{pane_dead}'], {
          encoding: 'utf-8',
          timeout: 5000,
        }));
        if (probe.status !== 0) continue;
        const [paneId, paneDead] = String(probe.stdout ?? '').trim().split('||');
        if (!paneId || paneDead === '1') continue;
        activeSessions.push({ topicId, sessionName: info.sessionName, claudeSessionId: info.claudeSessionId, framework: info.framework });
      }

      if (activeSessions.length === 0) return;

      for (const { topicId, sessionName, claudeSessionId, framework } of activeSessions) {
        // §8 writer gate — the heartbeat MUST NOT write a Claude JSONL UUID
        // for a topic whose resolved profile framework is not claude-code,
        // or that is mid-framework-switch (TOPIC-PROFILE-SPEC §8: this is
        // the writer that would otherwise re-poison the map within a minute
        // of a switch).
        if (!this.gateAllows(topicId)) continue;

        // Authoritative only: Claude Code reported its own session ID via hooks
        // and its transcript exists. No guess when it is missing — the existing
        // mapping is KEPT (never deleted, never replaced by the newest file).
        // The check runs in the session's OWN framework layout: a session known
        // to be claude-code looks at Claude transcripts only. Before this, a
        // stale Claude id fell through into the Codex archive walk every minute
        // (2026-10-13 server-loop freeze).
        if (!claudeSessionId || !this.jsonlExists(claudeSessionId, framework)) continue;
        const uuid: string = claudeSessionId;
        const provenance: ResumeProvenance = 'hook';

        const topicKey = String(topicId);
        const existingEntry = map[topicKey];

        // Update if UUID changed, entry doesn't exist, or entry is stale (>2 hours)
        const entryAge = existingEntry ? Date.now() - new Date(existingEntry.savedAt).getTime() : Infinity;
        if (!existingEntry || existingEntry.uuid !== uuid || entryAge > 2 * 60 * 60 * 1000) {
          map[topicKey] = {
            uuid,
            savedAt: new Date().toISOString(),
            sessionName,
            framework: 'claude-code',
            provenance,
          };
          updated++;
        }
      }

      if (updated > 0) {
        // Prune entries older than 24 hours that aren't active
        const activeTopicKeys = new Set(activeSessions.map(s => String(s.topicId)));
        for (const key of Object.keys(map)) {
          if (!activeTopicKeys.has(key) && Date.now() - new Date(map[key].savedAt).getTime() > MAX_AGE_MS) {
            delete map[key];
          }
        }

        try {
          fs.writeFileSync(this.filePath, JSON.stringify(map, null, 2));
        } catch (err) {
          console.error(`[TopicResumeMap] Failed to save heartbeat: ${err}`);
        }
      }
    } catch (err) {
      console.error('[TopicResumeMap] Resume heartbeat error:', err);
    }
  }

  private load(): ResumeMap {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch {
      // Corrupted file — start fresh
    }
    return {};
  }

  /**
   * Check if a JSONL file exists for the given UUID in this project's directory.
   * Public alias for use by the resume heartbeat (Slack channel resume writes).
   */
  jsonlExistsPublic(uuid: string, framework?: string): boolean {
    return this.jsonlExists(uuid, framework);
  }

  /**
   * Does a transcript exist for this id? `framework` selects the layout:
   * 'claude-code' checks Claude transcripts ONLY, 'codex-cli' the Codex rollout
   * archive only, 'gemini-cli' the Gemini session files only. With no framework
   * (an untagged caller) every layout is tried in the legacy order — Claude,
   * then the (now bounded, never-walking) Codex lookup, then Gemini.
   * A miss is an honest miss: the caller keeps its mapping and never
   * substitutes another transcript.
   */
  private jsonlExists(uuid: string, framework?: string): boolean {
    if (!uuid) return false;
    const known = framework === 'claude-code' || framework === 'codex-cli' || framework === 'gemini-cli';
    if (!known || framework === 'claude-code') {
      if (this.claudeTranscriptExists(uuid)) return true;
      if (framework === 'claude-code') return false;
    }
    if (!known || framework === 'codex-cli') {
      // Codex: date-partitioned $CODEX_HOME/sessions/.../rollout-<ts>-<uuid>.jsonl.
      // Without this every codex session looks expired/missing and resume breaks
      // fleet-wide for codex agents (codex-compat root).
      try {
        if (findRolloutFileSync(uuid) !== null) return true;
      } catch {
        // Can't check the codex layout — treat as not found.
      }
      if (framework === 'codex-cli') return false;
    }
    // Gemini: ~/.gemini/tmp/<projectHash>/chats/session-<ts>-<short8>.json[l].
    // Without this every gemini session looks expired/missing and resume breaks
    // fleet-wide for gemini agents (the gemini analog of the codex-compat resume
    // root — apprenticeship Step 2 §4.0.1; the parallel TopicResumeMap the
    // harvest names alongside ThreadResumeMap).
    try {
      if (findGeminiSessionFileSync(uuid) !== null) return true;
    } catch {
      // Can't check the gemini layout — treat as not found.
    }
    return false;
  }

  /** Claude layouts only: this project's ~/.claude transcript dir, then every pooled login home. */
  private claudeTranscriptExists(uuid: string): boolean {
    // Claude: flat <project-jsonl-dir>/<uuid>.jsonl.
    const jsonlPath = path.join(this.claudeProjectJsonlDir(), `${uuid}.jsonl`);
    try {
      if (fs.existsSync(jsonlPath)) return true;
    } catch (err) {
      // Can't check the Claude layout — try the pooled homes, but say so: a
      // transcript that exists yet reads as missing is how a live session's
      // resume entry gets expired out from under it.
      DegradationReporter.getInstance().report(
        this.transcriptCheckFailure('this project\'s ~/.claude transcript dir', err),
      );
    }
    // Claude, pooled logins: a session launched under a subscription-pool account
    // writes under ~/.claude-*/projects/<slug>/ (Resume Follows the Account §3.3).
    // Checking only ~/.claude made every pooled session look missing and sent
    // its id into the Codex archive walk.
    try {
      for (const home of claudeConfigHomes()) {
        if (fs.existsSync(path.join(home, 'projects', this.claudeProjectDirName(), `${uuid}.jsonl`))) return true;
      }
    } catch (err) {
      // Can't enumerate login folders — not found, and reported (same risk as above).
      DegradationReporter.getInstance().report(
        this.transcriptCheckFailure('the pooled ~/.claude-* login homes', err),
      );
    }
    return false;
  }

  /**
   * The degradation event for a Claude transcript check that ERRORS (not merely
   * misses): the caller reads the miss as "transcript gone" and may expire a live
   * session's resume entry. DegradationReporter applies a per-feature alert
   * cooldown, so a heartbeat-rate failure surfaces once an hour, never as a flood.
   */
  private transcriptCheckFailure(layout: string, err: unknown): Parameters<DegradationReporter['report']>[0] {
    return {
      feature: 'TopicResumeMap.claudeTranscriptExists',
      primary: `Confirm a Claude session transcript exists by checking ${layout}`,
      fallback: 'The check is treated as a miss (transcript not found)',
      reason: `Transcript lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      impact: 'A live Claude session can read as missing — its resume entry may be expired, and the next spawn would start a fresh conversation instead of resuming',
    };
  }
}
