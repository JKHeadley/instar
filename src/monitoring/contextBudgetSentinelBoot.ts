/**
 * The ContextBudgetSentinel's production dependencies (context-budget-layered-
 * summaries §7.8, §9.3), in one place so server.ts and the e2e test build the
 * sentinel through the same closures: the topic's live sessions as candidates,
 * their transcripts, a THREE-STATE tmux probe, and the kill.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { applyClaudeChildAuth } from '../core/claudeChildAuth.js';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFrameworkTranscriptPath } from '../core/FrameworkSessionStore.js';
import type { Session } from '../core/types.js';
import type { ContextBudgetSentinelDeps, FoldCandidate, HoldCarrierEntry, HoldCarrierSource } from './ContextBudgetSentinel.js';
import { MALFORMED_HOLD_FOLD, type FoldHoldStore } from './FoldHoldStore.js';
import { foldMarkerCarrier, listFoldMarkers, removeFoldMarkers, TORN_MARKER_KEY } from './foldMarker.js';
import type { CanarySession } from './compactionCanary.js';
import { RECOVERY_MARKER } from './compactionCanary.js';
import { buildHealReseedPayload, prepareHealInjectionText } from '../messaging/shared/compactionResumePayload.js';
import { pressTargetRefusal, pressTopicKey, type PressCandidate, type PressTargetChecks } from './syntheticPress.js';

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
 * A Codex session's `CODEX_HOME` (the account home its rollouts live under),
 * read from its tmux environment; `undefined` when unset or unreadable (the
 * caller then uses the process default). Only that one key is read.
 */
export function codexHomeForTmuxSession(name: string, run: typeof spawnSync = spawnSync, tmuxPath = 'tmux'): string | undefined {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(name)) return undefined;
  const r = run(tmuxPath, ['show-environment', '-t', `=${name}`, 'CODEX_HOME'], { encoding: 'utf-8', timeout: 2_000 });
  if (r.error || r.status !== 0) return undefined;
  const out = String(r.stdout ?? '').trim();
  if (!out.startsWith('CODEX_HOME=')) return undefined;
  const v = out.slice('CODEX_HOME='.length).trim();
  return path.isAbsolute(v) ? v : undefined;
}

/** Newest-first day directories under a Codex `sessions` root, at most `limit`. */
function recentCodexDayDirs(root: string, limit: number): string[] {
  const ls = (d: string) => { try { return fs.readdirSync(d).filter((x) => /^\d+$/.test(x)).sort().reverse(); } catch { return []; } }; // @silent-fallback-ok — an unreadable level has no rollouts to offer
  const out: string[] = [];
  for (const y of ls(root)) for (const m of ls(path.join(root, y))) for (const d of ls(path.join(root, y, m))) {
    out.push(path.join(root, y, m, d));
    if (out.length >= limit) return out;
  }
  return out;
}

/**
 * Find a Codex rollout by session id: the newest 7 day directories first (a
 * running session's rollout is almost always there), then the full walk at
 * most once an hour per session (a root of ~90K rollouts is not walked every tick).
 */
export function makeCodexRolloutFinder(o: { now?: () => number; fullWalk?: (sessionId: string, sessionsRoot: string, projectDir: string) => string } = {}): (sessionId: string, codexHome: string, projectDir: string) => string {
  const now = o.now ?? Date.now;
  const found = new Map<string, string>();
  const lastFullWalk = new Map<string, number>();
  const fullWalk = o.fullWalk ?? ((sid, root, projectDir) => resolveFrameworkTranscriptPath({ framework: 'codex-cli', sessionId: sid, projectDir, rootOverride: root }));
  return (sessionId, codexHome, projectDir) => {
    const key = `${codexHome}\u0000${sessionId}`;
    const hit = found.get(key);
    if (hit && fs.existsSync(hit)) return hit;
    const root = path.join(codexHome, 'sessions');
    const suffix = `-${sessionId}.jsonl`;
    for (const dir of recentCodexDayDirs(root, 7)) {
      let files: string[] = [];
      try { files = fs.readdirSync(dir); } catch { continue; } // @silent-fallback-ok — an unreadable day has nothing to offer
      const f = files.find((x) => x.startsWith('rollout-') && x.endsWith(suffix));
      if (f) { const p = path.join(dir, f); found.set(key, p); return p; }
    }
    const last = lastFullWalk.get(key) ?? -Infinity;
    if (now() - last < 60 * 60_000) return '';
    lastFullWalk.set(key, now());
    const p = fullWalk(sessionId, root, projectDir);
    if (p) found.set(key, p);
    return p;
  };
}

/**
 * The canary's scope (§9.1): topic-bound sessions whose engine and transcript
 * are known. Claude Code always; Codex (`codex-cli`, its rollout as the
 * transcript channel, §9.6) only while `codex.enabled()` — the
 * `contextBudget.enabled` dev gate. With it off the scope is exactly Claude Code's.
 */
export function productionCanarySessions(o: {
  sessions: SentinelSessionSource; projectDir: string;
  /** §9.1 synthetic press: throwaway Claude sessions the press may target also join the canary. */
  pressChecks?: PressTargetChecks;
  codex?: { enabled: () => boolean; homeForSession?: (tmuxSession: string) => string | undefined; findRollout?: (sessionId: string, codexHome: string, projectDir: string) => string };
}): () => CanarySession[] {
  const findRollout = o.codex?.findRollout ?? makeCodexRolloutFinder();
  // A session's CODEX_HOME does not change while it runs: one tmux read per session, not per tick.
  const homes = new Map<string, string>();
  const homeFor = (tmux: string, sessionId: string) => {
    // Keyed on the session too (a respawn under the same tmux name may use another account home);
    // only a real answer is cached, so a failed read is retried next tick.
    const key = `${tmux}\u0000${sessionId}`;
    const hit = homes.get(key);
    if (hit) return hit;
    const read = o.codex?.homeForSession?.(tmux);
    if (read) { homes.set(key, read); if (homes.size > 500) homes.delete(homes.keys().next().value as string); return read; }
    return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  };
  return () => {
    const codexOn = o.codex?.enabled() === true;
    return o.sessions.listRunningSessions()
      .filter((s) => !!s.claudeSessionId && (s.framework === 'claude-code' || (codexOn && s.framework === 'codex-cli')))
      .map((s): CanarySession | null => {
        const projectDir = (s as { cwd?: string }).cwd ?? o.projectDir;
        if (s.framework === 'codex-cli') {
          // Codex: topic-bound sessions only (the synthetic press targets Claude throwaways).
          if (typeof s.telegramTopicId !== 'number') return null;
          const home = homeFor(s.tmuxSession, s.claudeSessionId as string);
          return { topicKey: String(s.telegramTopicId), claudeSessionId: s.claudeSessionId as string, transcriptPath: findRollout(s.claudeSessionId as string, home, projectDir), engine: 'codex-cli' };
        }
        // In scope (§9.1): topic-bound sessions, plus the throwaway sessions the synthetic press targets.
        const topicKey = typeof s.telegramTopicId === 'number' ? String(s.telegramTopicId)
          : pressTargetRefusal(s as PressCandidate, o.pressChecks ?? {}) === null ? pressTopicKey(s.id) : null;
        if (!topicKey) return null;
        const configHome = typeof o.sessions.configHomeForSession === 'function' ? o.sessions.configHomeForSession(s.tmuxSession) : undefined;
        const transcriptPath = resolveFrameworkTranscriptPath({ framework: 'claude-code', sessionId: s.claudeSessionId as string, projectDir, ...(configHome ? { configHome } : {}) });
        return { topicKey, claudeSessionId: s.claudeSessionId as string, transcriptPath, engine: 'claude-code' };
      })
      .filter((x): x is CanarySession => x !== null && x.transcriptPath !== '');
  };
}

/**
 * Is the compaction hook family installed (§9.1 heal ladder, rung 1's cause)?
 * The settings entries that run Instar's SessionStart(compact) and PostCompact
 * hooks, and the current scripts behind them: the session-start hook with its
 * seeded-marker writer and the output fitter, the recovery script that prints
 * the recovery marker, the fitter itself and the PostCompact script.
 */
export function compactionHookInstallCheck(projectDir: string, stateDir: string): { installed: boolean; missing: string[] } {
  const missing: string[] = [];
  const hooksDir = path.join(stateDir, 'hooks', 'instar');
  const read = (f: string): string | null => { try { return fs.readFileSync(path.join(hooksDir, f), 'utf-8'); } catch { return null; } }; // @silent-fallback-ok — an unreadable script counts as missing
  const ss = read('session-start.sh');
  if (ss === null) missing.push('session-start.sh');
  else {
    if (!ss.includes("'_seeded'")) missing.push('session-start.sh: seeded-marker writer');
    if (!ss.includes('fit-recovery-output.mjs')) missing.push('session-start.sh: output fitter call');
  }
  const cr = read('compaction-recovery.sh');
  if (cr === null || !cr.includes(RECOVERY_MARKER)) missing.push('compaction-recovery.sh');
  if (read('fit-recovery-output.mjs') === null) missing.push('fit-recovery-output.mjs');
  if (read('post-compact.sh') === null) missing.push('post-compact.sh');
  let hooks: Record<string, unknown> = {};
  try { hooks = ((JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'settings.json'), 'utf-8')) as { hooks?: Record<string, unknown> }).hooks ?? {}); } catch { missing.push('.claude/settings.json'); } // @silent-fallback-ok — unreadable settings counts as not installed
  const runs = (event: string, script: string, matchers: Array<string | undefined>): boolean => {
    const entries = Array.isArray(hooks[event]) ? hooks[event] as Array<{ matcher?: string; hooks?: Array<{ command?: unknown }> }> : [];
    return entries.some((e) => matchers.includes(e.matcher ?? undefined) && Array.isArray(e.hooks) && e.hooks.some((h) => typeof h.command === 'string' && h.command.includes(script)));
  };
  if (!runs('SessionStart', 'session-start.sh', ['compact', '', undefined])) missing.push('settings: SessionStart(compact) → session-start.sh');
  if (!runs('PostCompact', 'post-compact.sh', ['', undefined, 'auto', 'manual'])) missing.push('settings: PostCompact → post-compact.sh');
  return { installed: missing.length === 0, missing };
}

/** The running sessions as synthetic-press candidates (the press itself refuses all but a throwaway). */
export function productionPressCandidates(sessions: SentinelSessionSource): () => PressCandidate[] {
  return () => sessions.listRunningSessions().map((s) => ({
    id: s.id, name: s.name, tmuxSession: s.tmuxSession, framework: s.framework,
    telegramTopicId: s.telegramTopicId, slackChannelId: s.slackChannelId, jobSlug: s.jobSlug, claudeSessionId: s.claudeSessionId,
  }));
}

/**
 * The adapter verification suite's production trigger (§9.6): the retained
 * engine binary's version (cached for an hour), and a run in its OWN process
 * (`adapterSuiteCli.js` beside this module) so the suite's ~30 s of engine
 * calls never block the server; killed after 10 minutes.
 */
export function productionAdapterSuite(o: {
  stateDir: string; machine: string; claudePath: string; now?: () => number;
  /** The engine measured (default Claude Code). Codex (S17): `claudePath` is then the codex binary. */
  engine?: 'claude-code' | 'codex-cli';
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
      const codex = o.engine === 'codex-cli';
      const args = codex ? [o.stateDir, o.machine, '--engine=codex-cli', `--codex-bin=${o.claudePath}`] : [o.stateDir, o.machine, o.claudePath];
      const env = codex ? { ...process.env, INSTAR_ADAPTER_SUITE_CLI: '1' } : applyClaudeChildAuth({ ...process.env, INSTAR_ADAPTER_SUITE_CLI: '1' });
      const child = spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env });
      let out = ''; let err = '';
      child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
      child.stderr.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-2_000); });
      const kill = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* @silent-fallback-ok — already gone */ } }, 10 * 60_000); kill.unref?.();
      child.on('error', (e) => { clearTimeout(kill); reject(e); });
      child.on('exit', (code) => { clearTimeout(kill); if (code === 0) resolve(); else reject(new Error(`adapter suite exited ${code}: ${(out.trim() || err.trim()).slice(0, 300)}`)); });
    }),
  };
}

/** This machine's live topic sessions, as fold topic keys (the freshness and eligible-without-fold population). */
export function productionLiveTopics(o: { sessions: SentinelSessionSource }): () => string[] {
  return () => [...new Set(o.sessions.listRunningSessions()
    .filter((s) => typeof s.telegramTopicId === 'number' && Number.isSafeInteger(s.telegramTopicId) && s.telegramTopicId > 0)
    .map((s) => String(s.telegramTopicId)))];
}

/**
 * The hold-health row's carriers (§10, §17): the egress fold hold (the SAME
 * FoldHoldStore instance the outbound chokepoints read, so a release also
 * drops its in-memory known hold) and the per-session fold markers, one entry
 * per (topic, fold) with the YOUNGEST marker's write time. Unattributable
 * files (a malformed hold, a torn marker) are listed with an unknown age:
 * the sentinel reports them and leaves them to the boot sweep.
 */
export function productionHoldCarriers(o: { stateDir: string; holds: FoldHoldStore | null }): HoldCarrierSource[] {
  const out: HoldCarrierSource[] = [];
  const holds = o.holds;
  if (holds) {
    out.push({
      kind: 'fold-hold',
      list: (): HoldCarrierEntry[] => [
        ...holds.list().map((h) => ({ topicKey: h.topicKey, foldId: h.foldId, writtenAt: h.writtenAt })),
        ...holds.malformed().map((topicKey) => ({ topicKey, foldId: MALFORMED_HOLD_FOLD, writtenAt: null })),
      ],
      release: (topicKey, foldId) => holds.release(topicKey, foldId),
    });
  }
  out.push({
    kind: 'fold-marker',
    list: (): HoldCarrierEntry[] => {
      const byFold = new Map<string, HoldCarrierEntry>();
      for (const m of listFoldMarkers(o.stateDir)) {
        const k = `${m.topicKey}/${m.foldId}`;
        const prev = byFold.get(k);
        const at = Number.isFinite(m.writtenAt) ? m.writtenAt : null;
        // The youngest marker sets the age (a re-stamped marker restarts the grace); an unknown age wins.
        const writtenAt = !prev ? at : prev.writtenAt === null || at === null ? null : Math.max(prev.writtenAt, at);
        byFold.set(k, { topicKey: m.topicKey, foldId: m.foldId, writtenAt });
      }
      const torn = foldMarkerCarrier(o.stateDir).list().some((e) => e.topicKey === TORN_MARKER_KEY);
      return [...byFold.values(), ...(torn ? [{ topicKey: TORN_MARKER_KEY, foldId: TORN_MARKER_KEY, writtenAt: null }] : [])];
    },
    release: (topicKey, foldId) => removeFoldMarkers(o.stateDir, topicKey, foldId),
  });
  return out;
}

/** What the production heal ladder and synthetic press need from the server (one place, shared with the e2e test). */
export interface HealAndPressWiring {
  stateDir: string;
  projectDir: string;
  machineId: string;
  canary: import('./compactionCanary.js').CompactionCanary;
  sessions: SentinelSessionSource & {
    getProtectedSessions?(): string[];
    isSessionActivelyWorking?(tmuxSession: string): boolean;
    classifyPaneState?(tmuxSession: string): string | null;
    injectInternalControlCommand?(tmuxSession: string, conversationId: string, command: '/compact' | '/clear'): boolean;
  };
  /** The Telegram topic the adapter maps to a tmux session, if any. */
  topicForSession?(tmuxSession: string): number | null | undefined;
  /** Pool placement live ⇒ ownership is the pool's to decide (the ladder refuses: `unknown`). */
  poolLive(): boolean;
  compactionSentinel(): Pick<import('./CompactionSentinel.js').CompactionSentinel, 'healReinject'> | null;
  /** The topic's re-staged, verified standing packet as the session would get it, or null. */
  reseedText(topicId: number): string | null;
  /** Re-run the hook and settings migration (PostUpdateMigrator.repairCompactionRecoveryHooks). */
  repairHooks(): { upgraded: string[]; errors: string[] };
  readMarker(claudeSessionId: string): import('./compactionSeedMarker.js').SeedMarker | null;
  attention: import('./canaryHealLadder.js').CanaryHealDeps['attention'];
  healAdmit: import('../core/SelfHealGate.js').SelfHealGateDeps['admit'];
  pressAdmit: import('../core/SelfHealGate.js').SelfHealGateDeps['admit'];
  consumeToken: import('../core/SelfHealGate.js').SelfHealGateDeps['consumeToken'];
  audit?: (e: { event: string; reason?: string }) => void;
}

/**
 * The production heal ladder (§9.1) and synthetic press, built from the
 * server's own pieces. Both are inert unless the sentinel ticks them, which it
 * does only while compaction recovery is on.
 */
export async function productionCanaryHealAndPress(w: HealAndPressWiring): Promise<{ heal: import('./canaryHealLadder.js').CanaryHealLadder; press: import('./syntheticPress.js').SyntheticPress }> {
  const { CanaryHealLadder } = await import('./canaryHealLadder.js');
  const { SyntheticPress } = await import('./syntheticPress.js');
  const checks: PressTargetChecks = {
    channelFor: (t) => w.topicForSession?.(t) ?? null,
    isProtected: (t) => (w.sessions.getProtectedSessions?.() ?? []).includes(t),
  };
  const byEngine = (cid: string) => w.sessions.listRunningSessions().find((s) => s.claudeSessionId === cid);
  const idle = (t: string) => w.sessions.isSessionActivelyWorking?.(t) === false && w.sessions.classifyPaneState?.(t) === 'ready';
  const heal = new CanaryHealLadder({
    stateDir: w.stateDir, machineId: w.machineId, canary: w.canary,
    installCheck: () => compactionHookInstallCheck(w.projectDir, w.stateDir),
    rerunMigration: () => { const r = w.repairHooks(); return { ok: r.errors.length === 0, ...(r.errors.length ? { detail: r.errors.join('; ').slice(0, 300) } : {}) }; },
    ready: () => w.compactionSentinel() !== null,
    liveSession: (cid) => {
      const s = byEngine(cid);
      if (!s) return null;
      const topic = typeof s.telegramTopicId === 'number' ? s.telegramTopicId : (w.topicForSession?.(s.tmuxSession) ?? null);
      if (typeof topic === 'number' && topic > 0) return { tmuxSession: s.tmuxSession, topicKey: String(topic), reseedable: true };
      return { tmuxSession: s.tmuxSession, topicKey: s.slackChannelId ? `slack-${s.slackChannelId}` : (pressTopicKey(s.id) ?? ''), reseedable: false };
    },
    ownsSession: (cid) => (w.poolLive() ? 'unknown' : !!byEngine(cid)),
    readMarker: (cid) => w.readMarker(cid),
    reinject: async (t) => {
      const cs = w.compactionSentinel();
      if (!cs) return 'unsupported';
      const topicId = Number(t.topicKey);
      const text = Number.isInteger(topicId) && topicId > 0 ? w.reseedText(topicId) : null;
      if (!text) return 'no-packet';
      return cs.healReinject(t.tmuxSession, { epoch: t.epoch, boundaryAt: t.boundaryAt, text });
    },
    attention: w.attention,
    admit: w.healAdmit, consumeToken: w.consumeToken,
    audit: w.audit,
  });
  const press = new SyntheticPress({
    stateDir: w.stateDir, machineId: w.machineId, canary: w.canary,
    switchOn: () => true, // the sentinel ticks it only with compaction recovery on
    candidates: productionPressCandidates(w.sessions),
    checks,
    isIdle: idle,
    // The adapter's control-command path: the closed `/compact | /clear` union, fenced and pane-locked.
    press: (t) => w.sessions.injectInternalControlCommand?.(t, t, '/compact') === true,
    admit: w.pressAdmit, consumeToken: w.consumeToken,
    audit: w.audit,
  });
  return { heal, press };
}

/** The press-target checks the canary scope uses (same as the press's own). */
export function productionPressChecks(o: { topicForSession?(tmuxSession: string): number | null | undefined; protectedSessions?(): string[] }): PressTargetChecks {
  return { channelFor: (t) => o.topicForSession?.(t) ?? null, isProtected: (t) => (o.protectedSessions?.() ?? []).includes(t) };
}

/**
 * The heal re-seed's text as typed into the session (§9.1 heal rung 2): the
 * heal preamble + the conversation's standing context, filed when large under a
 * HEAL stub (never the resume stub that tells a session to answer the latest
 * message), tagged with its topic so InputGuard accepts it.
 */
export function healReseedText(topicId: number, contextBlock: string, opts?: { tmpDir?: string }): string {
  return `[telegram:${topicId}] ${prepareHealInjectionText(buildHealReseedPayload(contextBlock), topicId, opts)}`;
}
