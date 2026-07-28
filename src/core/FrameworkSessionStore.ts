/**
 * FrameworkSessionStore — resolve a session's transcript file path for the
 * runtime that produced it.
 *
 * Portability audit Gap 3. PreCompactionFlush and ResumeValidator hardcoded
 * Claude Code's transcript convention (`~/.claude/projects/<encoded-cwd>/
 * <sessionId>.jsonl`). A Codex session is never found there, so compaction
 * flush and resume validation silently no-op for Codex agents.
 *
 * Codex's layout was determined empirically from a live ~/.codex/ (Codex CLI
 * 0.78.0), NOT guessed:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601-dashes>-<uuid>.jsonl
 * where the trailing <uuid> equals the session id (and the first JSONL line
 * is a `session_meta` record whose payload.id is that same uuid). Sessions
 * are date-partitioned, NOT cwd-keyed, so a Codex lookup globs by id across
 * the date tree rather than building a deterministic path.
 *
 * Pure path resolution + filesystem lookup. No mutation, no network.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findGeminiSessionFileSync } from '../providers/adapters/gemini-cli/observability/sessionPaths.js';

export type SessionFramework = 'claude-code' | 'codex-cli' | 'gemini-cli' | 'pi-cli';

export interface ResolveTranscriptOptions {
  framework: SessionFramework;
  sessionId: string;
  /** Project working directory (used by the Claude Code cwd-encoded path). */
  projectDir: string;
  /** Home dir override (testing). Defaults to os.homedir(). */
  homeDir?: string;
  /**
   * Root override (testing). For claude-code this replaces
   * `<home>/.claude/projects`; for codex-cli it replaces
   * `<home>/.codex/sessions`; for gemini-cli it replaces `<home>/.gemini`.
   */
  rootOverride?: string;
}

/**
 * Claude Code: deterministic path
 * `<home>/.claude/projects/<cwd with [/.] → ->/<sessionId>.jsonl`.
 * This mirrors the exact pre-Gap-3 logic in PreCompactionFlush so the
 * Claude path is byte-for-byte unchanged.
 */
function claudeTranscriptPath(opts: ResolveTranscriptOptions): string {
  const home = opts.homeDir ?? os.homedir();
  const root = opts.rootOverride ?? path.join(home, '.claude', 'projects');
  const encoded = opts.projectDir.replace(/[\/.]/g, '-');
  return path.join(root, encoded, `${opts.sessionId}.jsonl`);
}

/**
 * Codex CLI: glob `<home>/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`.
 * Empirically the filename ends with `-<sessionId>.jsonl`. Returns the
 * first match (a session id is unique), or '' when not found.
 */
function codexTranscriptPath(opts: ResolveTranscriptOptions): string {
  const home = opts.homeDir ?? os.homedir();
  const root = opts.rootOverride ?? path.join(home, '.codex', 'sessions');
  if (!fs.existsSync(root)) return '';
  const suffix = `-${opts.sessionId}.jsonl`;
  // sessions/YYYY/MM/DD/<file>. Walk at most 3 levels deep.
  const years = safeReaddir(root);
  for (const y of years) {
    const yDir = path.join(root, y);
    for (const m of safeReaddir(yDir)) {
      const mDir = path.join(yDir, m);
      for (const d of safeReaddir(mDir)) {
        const dDir = path.join(mDir, d);
        for (const f of safeReaddir(dDir)) {
          if (f.startsWith('rollout-') && f.endsWith(suffix)) {
            return path.join(dDir, f);
          }
        }
      }
    }
  }
  return '';
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Resolve the transcript path for a session under the given framework.
 * Returns '' when it cannot be resolved (no session id, or — for Codex —
 * no matching file on disk yet). Callers already treat '' / missing-file
 * as "nothing to flush/validate", so the failure mode is a safe no-op,
 * identical to the pre-Gap-3 Claude behavior.
 */
/**
 * Gemini CLI: `<home>/.gemini/tmp/<projectHash>/chats/session-*-<short8>.json[l]`.
 * Resolved by session UUID through the gemini adapter's sessionPaths helper
 * (the single source of gemini-layout truth — apprenticeship Step 2 §4.0.1).
 * Returns the matched file path, or '' when not found / not a gemini tree.
 */
function geminiTranscriptPath(opts: ResolveTranscriptOptions): string {
  const home = opts.homeDir ?? os.homedir();
  // rootOverride, when given, replaces `<home>/.gemini`; findGeminiSessionFileSync
  // takes the geminiHome (the `.gemini` dir) directly.
  const geminiHome = opts.rootOverride ?? path.join(home, '.gemini');
  return findGeminiSessionFileSync(opts.sessionId, geminiHome) ?? '';
}

export function resolveFrameworkTranscriptPath(opts: ResolveTranscriptOptions): string {
  if (!opts.sessionId) return '';
  switch (opts.framework) {
    case 'codex-cli':
      return codexTranscriptPath(opts);
    case 'gemini-cli':
      return geminiTranscriptPath(opts);
    case 'claude-code':
    default:
      return claudeTranscriptPath(opts);
  }
}
