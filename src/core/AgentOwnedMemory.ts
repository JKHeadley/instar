/**
 * AgentOwnedMemory — an agent's Claude Code auto-memory belongs to the AGENT,
 * never to a subscription login.
 *
 * Operator rule (2026-09-25): "We should NEVER have anything dependent on a
 * specific login. Those accounts are for token/quota access ONLY, NOT for data
 * storage."
 *
 * Claude Code keeps auto-memory at `<config home>/projects/<key>/memory/`, and
 * every login has its own config home (`~/.claude`, `~/.claude-followme-*`).
 * Left alone, each login grows its own slice of the agent's memory and a
 * session moved to another login loses its standing instructions. The fix:
 * `<config home>/projects/<key>/memory` (for the agent's own project) is a
 * symlink to `<agent home>/.instar/agent-memory`. Credentials and quota stay per login.
 *
 * `ensureAgentOwnedMemory` is idempotent and never deletes anything: a real
 * memory folder already sitting under a login is merged into the agent-owned
 * folder (newest copy wins, differing older copies go to `_superseded/`,
 * MEMORY.md indexes are merged by linked filename) and then renamed to
 * `memory.pre-shared` before the link is made.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code hashes project keys longer than this; we do not guess the hash. */
const MAX_KEY_LENGTH = 200;
const SUPERSEDED_DIR = '_superseded';
const INDEX_FILE = 'MEMORY.md';

export type AgentMemoryAction =
  | 'linked'          // no memory folder existed; the link was created
  | 'already-linked'  // the link was already correct; nothing touched
  | 'migrated'        // a real folder (or a foreign link) was merged, set aside, and linked
  | 'skipped';        // not applicable (see reason)

export interface AgentMemoryResult {
  action: AgentMemoryAction;
  reason?: string;
  /** `<config home>/projects/<key>/memory` */
  linkPath?: string;
  /** The agent-owned folder the link points to. */
  ownedDir?: string;
  /** Where the old folder was set aside (action 'migrated'). */
  setAsidePath?: string;
  /** Files copied / superseded during a merge (action 'migrated'). */
  merged?: { added: number; replaced: number; superseded: number; unchanged: number };
}

/** Claude Code's project-folder name for a directory: every non-alphanumeric → '-'. */
export function claudeProjectKey(root: string): string | null {
  const key = root.replace(/[^a-zA-Z0-9]/g, '-');
  return key.length <= MAX_KEY_LENGTH ? key : null;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // @silent-fallback-ok — a path that does not exist yet keeps its given form.
    return path.resolve(p);
  }
}

/**
 * The folder Claude Code keys memory on for a session started in `cwd`: the
 * main checkout of the enclosing git repository (a worktree resolves to its
 * main checkout), else `cwd` itself. Paths are real paths, as the CLI sees them.
 */
export function canonicalProjectRoot(cwd: string): string {
  const start = realpathOr(cwd);
  let dir = start;
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st: fs.Stats | null = null;
    try { st = fs.statSync(dotGit); } catch { /* @silent-fallback-ok — keep walking up */ }
    if (st?.isDirectory()) return dir;
    if (st?.isFile()) {
      try {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!m) return dir;
        const gitDir = path.resolve(dir, m[1].trim());
        const commondirFile = path.join(gitDir, 'commondir');
        if (!fs.existsSync(commondirFile)) return dir; // submodule: its own root
        const common = realpathOr(path.resolve(gitDir, fs.readFileSync(commondirFile, 'utf8').trim()));
        return path.dirname(common);
      } catch {
        // @silent-fallback-ok — an unreadable .git file: the enclosing dir is the root.
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** The agent-owned memory folder: `<agent home>/.instar/agent-memory`. */
export function agentOwnedMemoryDir(agentHome: string): string {
  return path.join(agentHome, '.instar', 'agent-memory');
}

function isInside(p: string, dir: string): boolean {
  const a = realpathOr(p);
  const d = realpathOr(dir);
  return a === d || a.startsWith(d + path.sep);
}

export function defaultClaudeConfigHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Every Claude config home on this host: `~/.claude` and `~/.claude-*` directories. */
export function listClaudeConfigHomes(home: string = os.homedir()): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(home);
  } catch {
    // @silent-fallback-ok — an unreadable HOME has no config homes to list.
    return [];
  }
  return names
    .filter((n) => n === '.claude' || n.startsWith('.claude-'))
    .map((n) => path.join(home, n))
    .filter((p) => {
      try { return fs.lstatSync(p).isDirectory(); } catch { return false; /* @silent-fallback-ok — a vanished entry is not a config home */ }
    });
}

function sameBytes(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    // @silent-fallback-ok — unreadable counts as different, so the copy is kept, never dropped.
    return false;
  }
}

function copyPreservingTimes(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  const st = fs.statSync(src);
  fs.utimesSync(dst, st.atime, st.mtime);
}

/** A free path under `_superseded/` for an older copy of `rel`. */
function supersededPath(ownedDir: string, rel: string, label: string, mtimeMs: number): string {
  const stamp = new Date(mtimeMs).toISOString().replace(/[:.]/g, '-');
  const base = path.join(ownedDir, SUPERSEDED_DIR, `${rel}.${label}.${stamp}`);
  let candidate = base;
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = `${base}.${n}`;
  return candidate;
}

/** Regular files under `dir` (relative paths), skipping symlinks and `_superseded`. */
function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    // @silent-fallback-ok — an unreadable folder contributes no files.
    return out;
  }
  for (const e of entries) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

const LINK_RE = /\]\(([^)\s]+)\)/;

/** The filename an index line links to, or null for headings / prose. */
function indexKey(line: string): string | null {
  const m = LINK_RE.exec(line);
  return m ? m[1] : null;
}

/**
 * Merge two MEMORY.md indexes, keyed by linked filename. The owned index keeps
 * its order; entries only the incoming index has are appended. When the
 * incoming copy of a linked file won the merge, its index line wins too.
 * Unlinked lines (headings, prose) are appended only if not already present.
 */
export function mergeMemoryIndex(owned: string, incoming: string, incomingWon: Set<string> = new Set()): string {
  const ownedLines = owned.split('\n');
  const incomingByKey = new Map<string, string>();
  for (const line of incoming.split('\n')) {
    const k = indexKey(line);
    if (k && !incomingByKey.has(k)) incomingByKey.set(k, line);
  }
  const seen = new Set<string>();
  const result = ownedLines.map((line) => {
    const k = indexKey(line);
    if (!k) return line;
    seen.add(k);
    return incomingWon.has(k) && incomingByKey.has(k) ? incomingByKey.get(k)! : line;
  });
  while (result.length > 0 && result[result.length - 1] === '') result.pop();
  const present = new Set(ownedLines);
  for (const line of incoming.split('\n')) {
    const k = indexKey(line);
    if (k ? seen.has(k) : (line.trim() === '' || present.has(line))) continue;
    if (k) seen.add(k);
    result.push(line);
    present.add(line);
  }
  return result.join('\n') + '\n';
}

/**
 * Merge every file of `srcDir` into `ownedDir`. Never deletes: a losing copy
 * that differs is kept under `_superseded/`.
 */
export function mergeMemoryFolder(srcDir: string, ownedDir: string, label: string): NonNullable<AgentMemoryResult['merged']> {
  const stats = { added: 0, replaced: 0, superseded: 0, unchanged: 0 };
  const incomingWon = new Set<string>();
  let incomingIndex: string | null = null;
  fs.mkdirSync(ownedDir, { recursive: true });
  for (const rel of listFiles(srcDir)) {
    const src = path.join(srcDir, rel);
    if (rel === INDEX_FILE) { incomingIndex = fs.readFileSync(src, 'utf8'); continue; }
    const dst = path.join(ownedDir, rel);
    if (!fs.existsSync(dst)) { copyPreservingTimes(src, dst); stats.added += 1; continue; }
    if (sameBytes(src, dst)) { stats.unchanged += 1; continue; }
    const srcM = fs.statSync(src).mtimeMs;
    const dstM = fs.statSync(dst).mtimeMs;
    if (srcM > dstM) {
      // Incoming is newer: the owned copy steps aside, the incoming copy takes its place.
      fs.mkdirSync(path.join(ownedDir, SUPERSEDED_DIR), { recursive: true });
      const aside = supersededPath(ownedDir, rel, 'agent', dstM);
      fs.mkdirSync(path.dirname(aside), { recursive: true });
      fs.renameSync(dst, aside);
      copyPreservingTimes(src, dst);
      incomingWon.add(rel.split(path.sep).join('/'));
      stats.replaced += 1;
    } else {
      copyPreservingTimes(src, supersededPath(ownedDir, rel, label, srcM));
      stats.superseded += 1;
    }
  }
  if (incomingIndex !== null) {
    const ownedIndexPath = path.join(ownedDir, INDEX_FILE);
    if (!fs.existsSync(ownedIndexPath)) {
      fs.writeFileSync(ownedIndexPath, incomingIndex);
      stats.added += 1;
    } else {
      const current = fs.readFileSync(ownedIndexPath, 'utf8');
      const next = mergeMemoryIndex(current, incomingIndex, incomingWon);
      if (next !== current) {
        // Keep the index as it was before this merge, like any other replaced file.
        const aside = supersededPath(ownedDir, INDEX_FILE, 'agent', fs.statSync(ownedIndexPath).mtimeMs);
        fs.mkdirSync(path.dirname(aside), { recursive: true });
        copyPreservingTimes(ownedIndexPath, aside);
        fs.writeFileSync(ownedIndexPath, next);
        stats.replaced += 1;
      } else stats.unchanged += 1;
    }
  }
  return stats;
}

function freeSetAsidePath(linkPath: string): string {
  const base = `${linkPath}.pre-shared`;
  if (!fs.existsSync(base) && !isSymlink(base)) return base;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let candidate = `${base}-${stamp}`;
  for (let n = 2; fs.existsSync(candidate) || isSymlink(candidate); n += 1) candidate = `${base}-${stamp}.${n}`;
  return candidate;
}

/** Under the OS temp folder (test fixtures, throwaway deploys). */
function isThrowaway(p: string): boolean {
  const target = realpathOr(p);
  return [os.tmpdir(), '/tmp'].map(realpathOr).some((t) => target === t || target.startsWith(t + path.sep));
}

function isSymlink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; /* @silent-fallback-ok — nothing there is not a link */ }
}

function linkPointsAt(linkPath: string, ownedDir: string): boolean {
  try {
    return fs.realpathSync(linkPath) === fs.realpathSync(ownedDir);
  } catch {
    // @silent-fallback-ok — no link (or a dangling one) is "not linked"; the caller then links.
    return false;
  }
}

export interface EnsureAgentMemoryOptions {
  /** The agent's home (the `.instar` parent). */
  agentHome: string;
  /** The Claude config home the session will run under. */
  configHome: string;
  /** The session's working directory (defaults to the agent home). */
  cwd?: string;
}

/**
 * Make `<configHome>/projects/<key>/memory` a link to the agent-owned folder.
 * Safe to call before every spawn: an already-correct link is left alone.
 * Only acts for a real agent (`<agentHome>/.instar/config.json`) and an
 * existing config home — it never creates a login's config home.
 */
export function ensureAgentOwnedMemory(opts: EnsureAgentMemoryOptions): AgentMemoryResult {
  const { agentHome, configHome } = opts;
  if (!fs.existsSync(path.join(agentHome, '.instar', 'config.json'))) {
    return { action: 'skipped', reason: 'not an agent home (no .instar/config.json)' };
  }
  if (isThrowaway(agentHome) && !isThrowaway(configHome)) {
    return { action: 'skipped', reason: 'a throwaway (temp-dir) agent never links into a real login' };
  }
  let homeIsDir = false;
  try { homeIsDir = fs.statSync(configHome).isDirectory(); } catch { /* @silent-fallback-ok — checked below */ }
  if (!homeIsDir) return { action: 'skipped', reason: `config home ${configHome} does not exist` };

  const root = canonicalProjectRoot(opts.cwd ?? agentHome);
  const key = claudeProjectKey(root);
  if (!key) return { action: 'skipped', reason: `project path too long for a plain key: ${root}` };

  // Only the agent's own project (its home, or a worktree/subfolder that resolves
  // to it). Another project's memory folder may belong to another agent on this
  // host or to a person running `claude` there — not ours to take over.
  if (realpathOr(root) !== realpathOr(agentHome)) {
    return { action: 'skipped', reason: `not this agent's project: ${root}` };
  }
  const ownedDir = agentOwnedMemoryDir(agentHome);
  const linkPath = path.join(configHome, 'projects', key, 'memory');
  fs.mkdirSync(ownedDir, { recursive: true });

  if (linkPointsAt(linkPath, ownedDir)) return { action: 'already-linked', linkPath, ownedDir };

  let setAsidePath: string | undefined;
  let merged: AgentMemoryResult['merged'];
  let existing: fs.Stats | null = null;
  try { existing = fs.lstatSync(linkPath); } catch { /* @silent-fallback-ok — nothing there yet */ }
  if (existing?.isSymbolicLink()) {
    // A link that resolves outside this agent's home was placed by someone else
    // (another agent, or the operator by hand): leave it alone. A dangling link,
    // or one into this agent's home, is ours to replace.
    let target: string | null = null;
    try { target = fs.realpathSync(linkPath); } catch { /* @silent-fallback-ok — dangling */ }
    if (target && !isInside(target, agentHome)) {
      return { action: 'skipped', reason: `memory already links outside this agent: ${target}`, linkPath, ownedDir };
    }
  }
  if (existing) {
    const label = path.basename(configHome).replace(/^\./, '') || 'login';
    // A real folder, or a stale link of our own: merge what it holds (read
    // through a link), then set the entry aside — renaming never deletes data.
    let isDir = false;
    try { isDir = fs.statSync(linkPath).isDirectory(); } catch { /* @silent-fallback-ok — dangling link */ }
    if (isDir) merged = mergeMemoryFolder(linkPath, ownedDir, label);
    setAsidePath = freeSetAsidePath(linkPath);
    fs.renameSync(linkPath, setAsidePath);
  }

  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.symlinkSync(ownedDir, linkPath, 'dir');
  } catch (err) {
    // A concurrent spawn may have made the same link a moment ago.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST' && linkPointsAt(linkPath, ownedDir)) {
      return { action: existing ? 'migrated' : 'already-linked', linkPath, ownedDir, setAsidePath, merged };
    }
    throw err;
  }
  return existing
    ? { action: 'migrated', linkPath, ownedDir, setAsidePath, merged }
    : { action: 'linked', linkPath, ownedDir };
}

/**
 * Link the agent-owned memory into every Claude config home on this host, for
 * the agent's own project. Used by the update migrator and at enrollment so a
 * login that has never spawned a session is already correct.
 */
export function ensureAgentOwnedMemoryAllHomes(agentHome: string, home: string = os.homedir()): Array<{ configHome: string; result?: AgentMemoryResult; error?: string }> {
  return listClaudeConfigHomes(home).map((configHome) => {
    try {
      return { configHome, result: ensureAgentOwnedMemory({ agentHome, configHome }) };
    } catch (err) {
      return { configHome, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
