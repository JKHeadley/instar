/**
 * SessionResumeIndex — provider-side index of resumable sessions.
 *
 * Maps to:
 *   - Claude: `~/.claude/projects/<encoded-path>/<uuid>.jsonl` files, flat
 *     by UUID
 *   - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
 *     date-partitioned, plus SQLite index at `sqlite_home`. Codex also
 *     has `codex resume` picker, `--last`, `--all`, and `codex fork`.
 *
 * The abstraction surfaces a uniform "find this session and resume it"
 * interface without exposing the underlying directory layout. Adapters
 * resolve via their native index.
 *
 * Used by Instar's TopicResumeMap (server/routes.ts) and ThreadResumeMap
 * (threadline/). The fields `claudeSessionId` in those modules become
 * `providerSessionId` post-migration; the resume index handles the lookup.
 */

import type { CancellationOptions, ProviderSpecific, SessionHandle } from '../../types.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface SessionResumeIndex {
  readonly capability: typeof CapabilityFlag.SessionResumeIndex;

  /** Find a resumable session by provider-side ID. */
  findById(
    providerSessionId: string,
    options?: CancellationOptions,
  ): Promise<ResumableSession | null>;

  /**
   * Find the most recent resumable session(s). Optionally scoped to a
   * project root (Codex's `--last` semantics, when scope provided).
   */
  findRecent(
    options?: FindRecentOptions,
  ): Promise<ReadonlyArray<ResumableSession>>;

  /**
   * List all resumable sessions in a project scope. Returns metadata only;
   * use the SessionRpc / AgenticSession* primitives to actually resume.
   */
  listByProject(
    projectRoot: string,
    options?: CancellationOptions,
  ): Promise<ReadonlyArray<ResumableSession>>;

  /**
   * Resume a session. Returns a new SessionHandle representing the
   * resumed session.
   */
  resume(
    providerSessionId: string,
    options?: ResumeOptions,
  ): Promise<SessionHandle>;
}

export interface FindRecentOptions extends CancellationOptions {
  limit?: number;
  /** Scope to a specific project root. */
  projectRoot?: string;
  /** Max age in milliseconds. Older sessions filtered out. */
  maxAgeMs?: number;
}

export interface ResumeOptions extends CancellationOptions {
  /**
   * Resume from a specific turn rather than the latest. Codex's
   * `thread/rollback` and Claude's --resume-from-checkpoint support this;
   * adapters that don't throw UnsupportedCapabilityError when set.
   */
  fromTurnIndex?: number;
  /**
   * Optional working-directory override. Defaults to the session's
   * recorded working directory.
   */
  workingDirectory?: string;
}

export interface ResumableSession {
  providerSessionId: string;
  /** Best-effort project root the session belonged to. */
  projectRoot?: string;
  /** ISO 8601 UTC, when the session was last active. */
  lastActiveAt: string;
  /** Total turn count, if known. */
  turnCount?: number;
  /** Brief summary of what the session was working on, if known. */
  summary?: string;
  providerSpecific?: ProviderSpecific;
}
