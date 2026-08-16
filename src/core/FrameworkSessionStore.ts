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

export type SessionFramework = 'claude-code' | 'codex-cli' | 'gemini-cli' | 'pi-cli' | 'grok-build';

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
    // Round-11 (lessons): grok-build fell through `default` to the CLAUDE
    // transcript path — a file that never exists for a grok session. Read-only
    // consumers fail safe (an unprobeable transcript → ambiguous → KEEP), but
    // `SessionManager.isTranscriptRecentlyActive` returns FALSE on an
    // unprobeable path, so the age-kill liveness protection added after the
    // 2026-06-13 "killed mid-work while doing tool work outside the pane's
    // process tree" incident was a structural no-op for grok while APPEARING
    // wired. Returning '' is the honest answer — the caller already treats an
    // empty path as "no transcript evidence", which is true here, rather than
    // silently probing another framework's file. A grok-native transcript
    // location is a real follow-up once one is identified.
    case 'grok-build':
      return '';
    // Round-17 (integration): pi-cli had the SAME defect round-11 fixed for
    // grok — it fell through `default` to the CLAUDE transcript path, so a pi
    // session probed a file belonging to another framework. Found by widening
    // the drift canary to cover every union member instead of the three it
    // had been hand-listing; the fix above had been applied to grok only, and
    // the neighbour it shared a root with was never swept. Same honest answer:
    // no mapped layout means no transcript evidence, not another framework's
    // file. A pi-native location is the same open follow-up as grok's.
    case 'pi-cli':
      return '';
    case 'claude-code':
      return claudeTranscriptPath(opts);
    default:
      // NOT dead code, and NOT the same case as the two above.
      //
      // Round-17 correction to my own round-17 change: I first made this
      // branch return '' with a `never` exhaustiveness guard, which broke the
      // documented behaviour for a genuinely-UNKNOWN framework string — a
      // typo or legacy value arriving from raw JSON config. Those two cases
      // are different and must not be conflated:
      //
      //   KNOWN but unmapped (grok-build, pi-cli): we know it is NOT claude,
      //     so returning a claude path would probe another framework's file.
      //     '' is the honest answer — handled explicitly above.
      //   UNKNOWN string: we know nothing. On the overwhelmingly common
      //     claude-primary agent the claude layout is the right guess, and
      //     returning '' instead would silently disable the age-kill liveness
      //     protection for a session whose framework name is merely misspelled.
      //
      // The union is covered by the explicit cases above, so a NEW framework
      // still cannot reach here by accident — it fails typecheck at every
      // OTHER exhaustive switch over IntelligenceFramework first.
      return claudeTranscriptPath(opts);
  }
}
