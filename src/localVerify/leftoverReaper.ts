/**
 * leftoverReaper — find and end the test processes a Local Verify run left behind
 * (docs/specs/machine-memory-care.md §2).
 *
 * Why: a run's lanes are killed by process group, but a test can start a process
 * that leaves the group (a detached tmux server, a daemonized helper). On the M5
 * (2026-11-14) 36 such helpers sat in a stopped state for up to 18 days, 6.6 GB in
 * 66 processes, while the machine ran out of swap.
 *
 * Ownership is decided by WHERE an ORPHANED process points: its command line names
 * one of the run's own folders (`<agentHome>/.worktrees/.verify/runs/…`, the
 * diagnosis folders, or a run temp folder `<tmp>/lv-…`), or it is a tmux server whose
 * socket lives in a run temp folder (the lanes set TMUX_TMPDIR there); plus every
 * process running under such an orphan. A process that still has its real parent
 * (an agent session whose prompt names a run path, a developer's own test run in a
 * kept checkout) is never a root. Never another user's process, never this process
 * or its ancestors, never a zombie.
 *
 * A stopped process cannot act on SIGTERM, so a leftover is sent SIGCONT then SIGKILL.
 */

/* @self-action-controller: local-verify-leftover-reaper */
import { execFile } from 'node:child_process';

export interface ProcRow {
  pid: number;
  ppid: number;
  uid: number;
  stat: string;
  /** Seconds since the process started (ps `etime`); null when unreadable. */
  ageS: number | null;
  command: string;
}

/** One ownership rule: a folder prefix, and how old a match must be before it is a leftover. */
export interface LeftoverPrefix {
  /**
   * A path prefix, matched as plain text: a process matches when its command line contains
   * it, or one of its tmux sockets starts with it. Pass a folder with a trailing `/`
   * (`…/.verify/runs/`) or a name prefix (`/private/tmp/lv-`).
   */
  prefix: string;
  /** 0 = any age. */
  minAgeS: number;
}

export interface ReapOptions {
  /**
   * Wall-clock ms when the caller decided to sweep. A process younger than the time since
   * then (plus 2 s slack) started after that decision and is never a leftover: a run that
   * starts while the table is read keeps its processes.
   */
  startedBeforeMs?: number;
  now?: () => number;
}

export interface ReapResult {
  matched: number;
  killed: number;
  /** True when tmux sockets could not be read (no lsof): orphaned tmux servers were not considered. */
  socketsUnreadable?: boolean;
  /** Up to five matched rows, for the audit line (pid, state, age, first 120 chars). */
  sample: Array<{ pid: number; stat: string; ageS: number | null; command: string }>;
}

/** ps `etime`: `[[dd-]hh:]mm:ss` → seconds, or null. */
export function parseEtime(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [d, h, mi, se] = [m[1], m[2], m[3], m[4]].map((x) => (x === undefined ? 0 : Number(x)));
  return ((d * 24 + h) * 60 + mi) * 60 + se;
}

/** Rows of `ps -A -ww -o pid=,ppid=,uid=,stat=,etime=,command=`. Unparseable lines are skipped. */
export function parsePsRows(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), stat: m[4], ageS: parseEtime(m[5]), command: m[6] });
  }
  return rows;
}

/** `lsof -F pn` output → pid → the paths it has open (unix-socket paths for `-U`). */
export function parseLsofPaths(out: string): Map<number, string[]> {
  const map = new Map<number, string[]>();
  let pid: number | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) { const n = Number(line.slice(1)); pid = Number.isFinite(n) ? n : null; continue; }
    if (line.startsWith('n') && pid !== null && line.length > 1) {
      const list = map.get(pid) ?? [];
      list.push(line.slice(1));
      map.set(pid, list);
    }
  }
  return map;
}

/** The pids that must never be signalled: this process and every ancestor of it. */
export function protectedPids(rows: ProcRow[], selfPid: number): Set<number> {
  const parent = new Map(rows.map((r) => [r.pid, r.ppid] as const));
  const out = new Set<number>([selfPid]);
  let cur = parent.get(selfPid);
  for (let i = 0; i < 64 && cur !== undefined && cur > 1 && !out.has(cur); i++) {
    out.add(cur);
    cur = parent.get(cur);
  }
  return out;
}

/** True for a tmux binary (any install path). */
function isTmux(command: string): boolean {
  const exe = command.trimStart().split(/\s+/, 1)[0] ?? '';
  return exe === 'tmux' || exe.endsWith('/tmux');
}

/**
 * An orphan: re-parented to init (pid 1), or to a per-user subreaper (`systemd --user`,
 * Linux). A detached leftover is an orphan by definition; a live session, a helper the
 * server spawned or a developer's own test run still has its real parent.
 */
function isOrphan(row: ProcRow, byPid: Map<number, ProcRow>): boolean {
  if (row.ppid === 1) return true;
  const parent = byPid.get(row.ppid);
  return !!parent && /(^|\/)systemd\s+--user\b/.test(parent.command);
}

/**
 * Pure: which rows are leftovers (spec §2). A ROOT is an orphan of this user that points
 * into a run folder under a prefix whose age rule it meets: a tmux server only through its
 * socket (a tmux command line can carry any session's prompt text), anything else through
 * its command line. Every live descendant of a root (a tmux server's pane shells, a stopped
 * worker under its orphaned parent) goes with it. Never another user, a zombie, or this
 * process and its ancestors.
 */
export function selectLeftovers(
  rows: ProcRow[],
  sockets: Map<number, string[]>,
  o: { prefixes: LeftoverPrefix[]; selfPid: number; uid: number; minAgeFloorS?: number },
): ProcRow[] {
  const floor = Math.max(0, o.minAgeFloorS ?? 0);
  const prot = protectedPids(rows, o.selfPid);
  // A prefix shorter than 6 characters ("/", "/tmp") could name anything: never a rule.
  const rules = o.prefixes.filter((p) => typeof p.prefix === 'string' && p.prefix.length >= 6);
  if (rules.length === 0) return [];
  const byPid = new Map(rows.map((r) => [r.pid, r] as const));
  // pid 0/1 (the kernel, init) are never candidates: every orphan on the machine is under init.
  const eligible = (row: ProcRow) => row.pid > 1 && row.uid === o.uid && !prot.has(row.pid) && !row.stat.startsWith('Z');
  const roots = rows.filter((row) => {
    if (!eligible(row) || !isOrphan(row, byPid)) return false;
    const socks = sockets.get(row.pid) ?? [];
    const tmux = isTmux(row.command);
    return rules.some((r) => {
      const hit = tmux ? socks.some((x) => x.startsWith(r.prefix)) : row.command.includes(r.prefix);
      if (!hit) return false;
      const min = Math.max(r.minAgeS, floor);
      return min <= 0 || (row.ageS !== null && row.ageS >= min);
    });
  });
  const children = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const list = children.get(r.ppid) ?? [];
    list.push(r);
    children.set(r.ppid, list);
  }
  const out = new Map<number, ProcRow>();
  const stack = [...roots];
  while (stack.length) {
    const r = stack.pop()!;
    if (out.has(r.pid) || !eligible(r)) continue;
    // A descendant is held to the same start-time floor: never one that began after the sweep decided.
    if (!roots.includes(r) && floor > 0 && (r.ageS === null || r.ageS < floor)) continue;
    out.set(r.pid, r);
    for (const c of children.get(r.pid) ?? []) stack.push(c);
  }
  return rows.filter((r) => out.has(r.pid));
}

export interface ReapDeps {
  /** Raw `ps` output (see parsePsRows), or null when it cannot be read. */
  listProcesses(): Promise<string | null>;
  /** Raw `lsof -F pn` output for tmux unix sockets, or null (no lsof, or unreadable). */
  listTmuxSockets(): Promise<string | null>;
  kill(pid: number, signal: 'SIGCONT' | 'SIGKILL'): void;
  selfPid: number;
  uid: number;
}

/** List, select, signal. Never throws; an unreadable process table reaps nothing. */
export async function reapLeftovers(deps: ReapDeps, prefixes: LeftoverPrefix[], opts: ReapOptions = {}): Promise<ReapResult> {
  const none: ReapResult = { matched: 0, killed: 0, sample: [] };
  if (prefixes.length === 0) return none;
  const [ps, lsof] = await Promise.all([
    deps.listProcesses().catch(() => null),
    deps.listTmuxSockets().catch(() => null),
  ]);
  if (!ps) return none;
  const now = (opts.now ?? Date.now)();
  const minAgeFloorS = typeof opts.startedBeforeMs === 'number' ? Math.ceil(Math.max(0, now - opts.startedBeforeMs) / 1000) + 2 : 0;
  const leftovers = selectLeftovers(parsePsRows(ps), lsof ? parseLsofPaths(lsof) : new Map(), { prefixes, selfPid: deps.selfPid, uid: deps.uid, minAgeFloorS });
  let killed = 0;
  for (const row of leftovers) {
    try { deps.kill(row.pid, 'SIGCONT'); } catch { /* @silent-fallback-ok: a process that is not stopped (or already gone) needs no continue */ }
    try { deps.kill(row.pid, 'SIGKILL'); killed++; } catch { /* @silent-fallback-ok: already gone; counted as matched, not killed */ }
  }
  return {
    matched: leftovers.length,
    killed,
    ...(lsof === null ? { socketsUnreadable: true } : {}),
    sample: leftovers.slice(0, 5).map((r) => ({ pid: r.pid, stat: r.stat, ageS: r.ageS, command: r.command.slice(0, 120) })),
  };
}

/** `okOnError`: lsof exits 1 when nothing matched, and its output is still the answer. */
const READ_MAX_BUFFER = 64 * 1024 * 1024;

function execOut(cmd: string, args: string[], opts: { timeoutMs: number; maxBuffer: number; okOnError?: boolean }): Promise<string | null> {
  const okOnError = opts.okOnError === true;
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf-8', timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer }, (err, stdout) => {
      // A missing binary or a timeout is unreadable; only a plain non-zero exit is an answer.
      const exitedNonZero = !!err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' && !(err as { killed?: boolean }).killed;
      if (err && !(okOnError && exitedNonZero)) { resolve(null); return; }
      resolve(typeof stdout === 'string' ? stdout : null);
    });
  });
}

/**
 * The prefixes that name Local Verify's own run folders on this machine: the agent's
 * run worktrees, its failed-file diagnosis worktrees, and the run temp folders (`<tmp>/lv-…`, both the real path and the
 * `/tmp` spelling macOS commands also show).
 */
export function localVerifyRunPrefixes(agentHome: string, tempRoot: string): { runs: string; diagnosis: string; temp: string[] } {
  const verify = `${agentHome.replace(/\/+$/, '')}/.worktrees/.verify`;
  const runs = `${verify}/runs/`;
  const diagnosis = `${verify}/diagnosis/`;
  const root = tempRoot.replace(/\/+$/, '');
  const temp = [`${root}/lv-`];
  if (root.startsWith('/private/')) temp.push(`${root.slice('/private'.length)}/lv-`);
  return { runs, diagnosis, temp };
}

/** The real process-table readers and signal sender (POSIX). */
export function realReapDeps(): ReapDeps {
  return {
    listProcesses: () => execOut('ps', ['-A', '-ww', '-o', 'pid=,ppid=,uid=,stat=,etime=,command='], { timeoutMs: 10_000, maxBuffer: READ_MAX_BUFFER }),
    listTmuxSockets: () => execOut('lsof', ['-nP', '-a', '-U', '-c', 'tmux', '-F', 'pn'], { timeoutMs: 10_000, maxBuffer: READ_MAX_BUFFER, okOnError: true }),
    kill: (pid, signal) => { process.kill(pid, signal); },
    selfPid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
  };
}
