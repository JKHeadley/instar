/**
 * The ContextBudgetSentinel's production dependencies (context-budget-layered-
 * summaries §7.8, §9.3), in one place so server.ts and the e2e test build the
 * sentinel through the same closures: the topic's live sessions as candidates,
 * their transcripts, a THREE-STATE tmux probe, and the kill.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { resolveFrameworkTranscriptPath } from '../core/FrameworkSessionStore.js';
import type { Session } from '../core/types.js';
import type { ContextBudgetSentinelDeps, FoldCandidate } from './ContextBudgetSentinel.js';
import type { CanarySession } from './compactionCanary.js';

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

/**
 * The canary's scope (§9.1): topic-bound sessions whose engine and transcript
 * are known. Today Claude Code; another engine joins when its adapter's
 * transcript channel is verified (task 11 / Phase 1).
 */
export function productionCanarySessions(o: { sessions: SentinelSessionSource; projectDir: string }): () => CanarySession[] {
  return () => o.sessions.listRunningSessions()
    .filter((s) => typeof s.telegramTopicId === 'number' && !!s.claudeSessionId && s.framework === 'claude-code')
    .map((s) => {
      const configHome = typeof o.sessions.configHomeForSession === 'function' ? o.sessions.configHomeForSession(s.tmuxSession) : undefined;
      const transcriptPath = resolveFrameworkTranscriptPath({ framework: 'claude-code', sessionId: s.claudeSessionId as string, projectDir: (s as { cwd?: string }).cwd ?? o.projectDir, ...(configHome ? { configHome } : {}) });
      return { topicKey: String(s.telegramTopicId), claudeSessionId: s.claudeSessionId as string, transcriptPath, engine: 'claude-code' };
    })
    .filter((x) => x.transcriptPath !== '');
}

/**
 * The adapter verification suite's production trigger (§9.6): the retained
 * engine binary's version (cached for an hour), and a run in its OWN process
 * (`adapterSuiteCli.js` beside this module) so the suite's ~30 s of engine
 * calls never block the server; killed after 10 minutes.
 */
export function productionAdapterSuite(o: {
  stateDir: string; machine: string; claudePath: string; now?: () => number;
  /** The command that runs the suite entry (default: this Node with the compiled `adapterSuiteCli.js` beside this module). */
  cli?: string[];
}): NonNullable<ContextBudgetSentinelDeps['adapterSuite']> {
  const now = o.now ?? Date.now;
  // Refreshed asynchronously (never blocks the server's event loop); null until the first answer.
  let cached: { at: number; version: string | null } | null = null;
  let probing = false;
  const refresh = () => {
    if (probing) return;
    probing = true;
    execFile(o.claudePath, ['--version'], { timeout: 10_000, encoding: 'utf-8' }, (err, stdout) => {
      probing = false;
      cached = { at: now(), version: err ? null : (/(\d+\.\d+\.\d+)/.exec(stdout ?? '') ?? [])[1] ?? null };
    });
  };
  return {
    currentVersion: () => {
      if (!cached || now() - cached.at >= 60 * 60_000) refresh();
      return cached?.version ?? null;
    },
    run: () => new Promise<void>((resolve, reject) => {
      const cmd = o.cli ?? [process.execPath, fileURLToPath(new URL('./adapterSuiteCli.js', import.meta.url))];
      // Its own process GROUP (detached), so the 10-minute kill also ends the engine calls under it.
      const child = spawn(cmd[0], [...cmd.slice(1), o.stateDir, o.machine, o.claudePath], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, INSTAR_ADAPTER_SUITE_CLI: '1' } });
      let out = ''; let err = '';
      child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
      child.stderr.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-2_000); });
      const kill = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* @silent-fallback-ok — already gone */ } }, 10 * 60_000); kill.unref?.();
      child.on('error', (e) => { clearTimeout(kill); reject(e); });
      child.on('exit', (code) => { clearTimeout(kill); if (code === 0) resolve(); else reject(new Error(`adapter suite exited ${code}: ${(out.trim() || err.trim()).slice(0, 300)}`)); });
    }),
  };
}
