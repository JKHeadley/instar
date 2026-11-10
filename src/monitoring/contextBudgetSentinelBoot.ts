/**
 * The ContextBudgetSentinel's production dependencies (context-budget-layered-
 * summaries §7.8, §9.3), in one place so server.ts and the e2e test build the
 * sentinel through the same closures: the topic's live sessions as candidates,
 * their transcripts, a THREE-STATE tmux probe, and the kill.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { resolveFrameworkTranscriptPath } from '../core/FrameworkSessionStore.js';
import type { Session } from '../core/types.js';
import type { ContextBudgetSentinelDeps, FoldCandidate } from './ContextBudgetSentinel.js';

/**
 * Is a tmux session alive? `true` / `false` only on a definite answer; a
 * timeout, a missing binary or any other error is `'unknown'`, which the
 * sentinel never reads as "gone".
 */
export function tmuxHasSession(name: string, run: typeof spawnSync = spawnSync, tmuxPath = 'tmux'): boolean | 'unknown' {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(name)) return 'unknown';
  const r = run(tmuxPath, ['has-session', '-t', `=${name}`], { encoding: 'utf-8', timeout: 5_000 });
  if (r.error) return 'unknown';
  if (r.status === 0) return true;
  const err = String(r.stderr ?? '');
  // tmux exits 1 with one of these when the session (or the whole server) does not exist.
  // A socket that does not exist or refuses connections means no server; a PERMISSION error does not.
  if (r.status === 1 && (/can't find session|no server running/i.test(err) || /error connecting to .*\((No such file or directory|Connection refused)\)/i.test(err))) return false;
  return 'unknown';
}

export interface SentinelSessionSource {
  listRunningSessions(): Session[];
  killSessionByTmuxName(tmuxSession: string): boolean;
  configHomeForSession?(tmuxSession: string): string | undefined;
}

/** The session-facing half of the sentinel's dependencies. */
export function productionSentinelSessionDeps(o: {
  sessions: SentinelSessionSource;
  projectDir: string;
  /** The configured tmux binary (SessionManager's `tmuxPath`). */
  tmuxPath?: string;
  tmuxProbe?: (name: string) => boolean | 'unknown';
}): Pick<ContextBudgetSentinelDeps, 'candidates' | 'tmuxAlive' | 'kill' | 'fileBytes'> {
  const topicSessions = (topicKey: string) => o.sessions.listRunningSessions().filter((s) => String(s.telegramTopicId ?? '') === topicKey);
  return {
    candidates: (topicKey): FoldCandidate[] => topicSessions(topicKey).map((s) => {
      const configHome = s.framework === 'claude-code' && typeof o.sessions.configHomeForSession === 'function' ? o.sessions.configHomeForSession(s.tmuxSession) : undefined;
      const tp = s.claudeSessionId && s.framework
        ? resolveFrameworkTranscriptPath({ framework: s.framework, sessionId: s.claudeSessionId, projectDir: (s as { cwd?: string }).cwd ?? o.projectDir, ...(configHome ? { configHome } : {}) })
        : '';
      return { tmuxSession: s.tmuxSession, transcriptPath: tp || null };
    }),
    tmuxAlive: o.tmuxProbe ?? ((t) => tmuxHasSession(t, spawnSync, o.tmuxPath ?? 'tmux')),
    kill: (t) => {
      // A refused kill (protected session, no matching row) leaves it alive: not verified, so the ladder escalates.
      if (!o.sessions.killSessionByTmuxName(t)) throw new Error(`kill refused for ${t}`);
    },
    fileBytes: (fp) => { try { return fs.statSync(fp).size; } catch { return null; } }, // @silent-fallback-ok — an unreadable transcript is "no evidence of quiet": containment stays
  };
}
