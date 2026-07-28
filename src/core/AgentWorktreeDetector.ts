// safe-git-allow: detector reads worktree list against a pre-validated
//   instar repo via execFileSync. SafeGitExecutor.readSync would invoke
//   the source-tree guard which refuses operations targeting the instar
//   source tree — exactly the path the detector is here to inspect. The
//   call is bounded (read-only verb, fixed args, 2s timeout, validated
//   repo path) so direct execFileSync is the right level here.

/**
 * AgentWorktreeDetector — Layer 4 of the agent worktree convention.
 *
 * Runs once per agent startup as part of the lifeline health-check surface.
 * Inspects the canonical instar repo's worktree list and emits AT MOST ONE
 * aggregated AttentionItem (or, when no Telegram adapter is configured, one
 * JSONL fallback line) summarizing every worktree that lives outside an
 * agent's `<agent_home>/.worktrees/` area. Never one item per worktree —
 * per-element emission is a notification flood by construction (the
 * 2026-06-05 incident: 110 false-positive items in one boot).
 *
 * Signal-only by design. Never blocks, never moves, never deletes. The
 * operator decides what to do with each surfaced item — `git worktree
 * move` to the safe location or accept the residual.
 *
 * Spec: docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md §"Layer 4 — Lifeline
 * detector (in v1, signal only)".
 *
 * Signal vs authority: the detector's only decision rule is path-based
 * (`worktree_path` starts with `realpath(<agent_home>/.worktrees)` for
 * some registered agent). The audit ledger from Layer 1 is **not**
 * consumed as an allowlist — the rule lives here and only here, so future
 * maintainers can't drift it into ledger-membership.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInstarRepo } from './InstarWorktreeManager.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface DetectorOptions {
  /** Absolute path to the canonical instar repo. Required — Layer 4 reads
   *  this from `worktree.repoPath` config or the default fallback chain;
   *  resolution lives in the caller so this class stays I/O-pure for tests. */
  instarRepo: string;
  /** Agent's stateDir — used for the JSONL fallback location and for
   *  attributing the audit entry. */
  stateDir: string;
  /** Roots considered "safe" worktree locations. Each entry is the
   *  realpath of `<agent_home>/.worktrees` for some registered agent.
   *  Detector emits an item for any worktree whose path is NOT under one
   *  of these. */
  safeRoots: ReadonlyArray<string>;
  /** Attention emitter — when present, the detector creates AttentionItems
   *  via this callback (typically `telegramAdapter.createAttentionItem`).
   *  When absent, the detector falls back to JSONL append. */
  emitAttention?: (item: AttentionItemInput) => Promise<void> | void;
  /** Override `git worktree list --porcelain` timeout. Spec default 2s. */
  gitTimeoutMs?: number;
  /** Override the JSONL fallback path (defaults to
   *  `<stateDir>/audit/worktree-detector.jsonl`). */
  fallbackPath?: string;
}

export interface AttentionItemInput {
  /** Stable id used for AttentionQueue dedupe — `worktree-misplaced-summary:<set-hash>`. */
  id: string;
  title: string;
  summary: string;
  description?: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sourceContext?: string;
}

export interface DetectorResult {
  /** Total worktree entries enumerated (including main checkout + bare). */
  enumerated: number;
  /** Entries skipped because they were the main checkout / bare / stale. */
  skipped: number;
  /** Misplaced worktrees found (the count INSIDE the single aggregated item). */
  misplacedCount: number;
  /** Items emitted (Telegram path or JSONL path) — at most 1 per run. */
  emitted: number;
  /** Items deduped against the 24h fallback-file window (JSONL path only). */
  deduped: number;
  /** Set true when `git worktree list` exceeded `gitTimeoutMs`. */
  timedOut: boolean;
}

interface WorktreeListEntry {
  path: string;
  bare: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const DEFAULT_GIT_TIMEOUT_MS = 2000;
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const AUDIT_DIR_NAME = 'audit';
const FALLBACK_BASENAME = 'worktree-detector.jsonl';

function realpathOrInput(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // @silent-fallback-ok — git's worktree list reports stale entries; we
    //   return the raw path so the caller's filter (existsSync below) can
    //   classify them as stale and skip them.
    return p;
  }
}

function parseWorktreeListPorcelain(output: string): WorktreeListEntry[] {
  // Format:
  //   worktree /abs/path
  //   HEAD <sha> | branch <ref>
  //   [bare]
  //   <blank>
  // Each record ends with a blank line; the last record may not.
  const entries: WorktreeListEntry[] = [];
  const lines = output.split('\n');
  let current: WorktreeListEntry | null = null;
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim(), bare: false };
    } else if (line.trim() === 'bare' && current) {
      current.bare = true;
    } else if (line.trim() === '' && current) {
      entries.push(current);
      current = null;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function isUnderAnySafeRoot(worktreeReal: string, safeRoots: ReadonlyArray<string>): boolean {
  for (const root of safeRoots) {
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (worktreeReal === root || worktreeReal.startsWith(rootWithSep)) return true;
  }
  return false;
}

function appendFallback(fallbackPath: string, line: object): void {
  const dir = path.dirname(fallbackPath);
  fs.mkdirSync(dir, { recursive: true });
  const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY |
    fs.constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = fs.openSync(fallbackPath, flags, 0o600);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ELOOP') {
      throw new Error(`detector fallback: ${fallbackPath} is a symlink — refused`);
    }
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    const euid = process.geteuid?.() ?? -1;
    if (euid !== -1 && st.uid !== euid) {
      throw new Error(`detector fallback: ${fallbackPath} owner uid ${st.uid} != euid ${euid}`);
    }
    if ((st.mode & 0o077) !== 0) {
      throw new Error(
        `detector fallback: ${fallbackPath} mode 0${(st.mode & 0o777).toString(8)} grants group/other access`,
      );
    }
    fs.writeSync(fd, JSON.stringify(line) + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

function readRecentDedupeKeys(fallbackPath: string): Set<string> {
  if (!fs.existsSync(fallbackPath)) return new Set();
  const keys = new Set<string>();
  const cutoff = Date.now() - DEDUPE_WINDOW_MS;
  let content: string;
  try {
    content = fs.readFileSync(fallbackPath, 'utf-8');
  } catch {
    // @silent-fallback-ok — unreadable fallback file means we lose dedupe
    //   for this run, which is acceptable (worst case: a duplicate JSONL
    //   line for an outage event). Returning empty Set is the safe fallback.
    return keys;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { ts?: string; dedupeKey?: string };
      if (!parsed.dedupeKey || !parsed.ts) continue;
      const ts = Date.parse(parsed.ts);
      if (Number.isNaN(ts) || ts < cutoff) continue;
      keys.add(parsed.dedupeKey);
    } catch {
      // @silent-fallback-ok — tolerate torn last line per spec; skip it.
    }
  }
  return keys;
}

// ── Detector entrypoint ──────────────────────────────────────────────────

export async function runDetection(opts: DetectorOptions): Promise<DetectorResult> {
  const result: DetectorResult = {
    enumerated: 0,
    skipped: 0,
    misplacedCount: 0,
    emitted: 0,
    deduped: 0,
    timedOut: false,
  };

  let output: string;
  try {
    // safe-git-allow: detector reads worktree list against a pre-validated
    //   instar repo; SafeGitExecutor.readSync would also work but adds the
    //   source-tree check (which would refuse the very repo we're inspecting).
    //   The repo path is validated by the caller via resolveInstarRepo.
    output = execFileSync('git', ['-C', opts.instarRepo, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    }).trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { signal?: string };
    if (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
      result.timedOut = true;
      // Surface a single attention item so the timeout is observable.
      await emitOrFallback(
        {
          id: 'worktree-detector-timeout',
          title: 'Worktree detector skipped',
          summary: `git worktree list against ${opts.instarRepo} did not return within ${opts.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS}ms`,
          category: 'worktree-misplaced',
          priority: 'LOW',
          sourceContext: 'agent-worktree-detector',
        },
        opts,
        result,
        true, // skip dedupe — timeouts are short-lived events
      );
      return result;
    }
    throw err;
  }

  const entries = parseWorktreeListPorcelain(output);
  result.enumerated = entries.length;

  const instarRepoReal = realpathOrInput(opts.instarRepo);
  const safeRootsReal = opts.safeRoots.map((r) => realpathOrInput(r));

  const misplaced: string[] = [];
  for (const entry of entries) {
    const entryReal = realpathOrInput(entry.path);
    // Skip the main checkout entry.
    if (entryReal === instarRepoReal) { result.skipped++; continue; }
    // Skip bare entries.
    if (entry.bare) { result.skipped++; continue; }
    // Skip stale (no longer on disk).
    if (!fs.existsSync(entry.path)) { result.skipped++; continue; }
    // Properly-placed under some agent home — skip.
    if (isUnderAnySafeRoot(entryReal, safeRootsReal)) { result.skipped++; continue; }

    misplaced.push(entryReal);
  }
  result.misplacedCount = misplaced.length;

  // AGGREGATE EMISSION (2026-06-05 flood lesson): the detector emits at most
  // ONE attention item per run, no matter how many worktrees are misplaced.
  // The pre-fix per-worktree emission turned a transiently-wrong safe-root
  // list (the agent registry's lost-update race returned a list without this
  // agent) into 110 false-positive items in a single boot — 8 leaked forum
  // topics + a 103-ping coalesced topic. A detector that loops over a
  // collection MUST aggregate; per-element notification is a flood by
  // construction. See docs/STANDARDS-REGISTRY.md "Bounded Notification
  // Surface".
  if (misplaced.length > 0) {
    const sorted = [...misplaced].sort();
    // The id hashes the SET of misplaced paths: the same set never re-notifies
    // (AttentionQueue id-collision dedupe); a changed set is one new item.
    const setHash = crypto.createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16);
    const sample = sorted.slice(0, 3).join(', ');
    const listed = sorted.slice(0, 20).map((p) => `• ${p}`).join('\n');
    const emptyRootsCaveat = safeRootsReal.length === 0
      ? ' NOTE: the safe-root list was EMPTY for this run — if agent homes exist on disk, treat this as a detector input problem, not a placement problem.'
      : '';
    await emitOrFallback(
      {
        id: `worktree-misplaced-summary:${setHash}`,
        title: `${misplaced.length} worktree(s) placed outside agent homes`,
        summary: `${sample}${misplaced.length > 3 ? ` … and ${misplaced.length - 3} more` : ''} — sandbox-revoke risk.${emptyRootsCaveat}`,
        description:
          'Per docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md, worktrees of the shared instar repo should live at <agent_home>/.worktrees/<slug>/. ' +
          'Use `instar worktree create <branch>` for new worktrees, or `git worktree move <old> <new>` to relocate. ' +
          'The detector does not move or delete anything.\n' +
          listed +
          (sorted.length > 20 ? `\n… and ${sorted.length - 20} more` : ''),
        category: 'worktree-misplaced',
        priority: 'LOW',
        // STABLE feature-scoped source key. The pre-fix code put each
        // worktree's own path here, which made the flood guard's per-source
        // budget unable to trip (every item was its own "source").
        sourceContext: 'agent-worktree-detector',
      },
      opts,
      result,
      false,
    );
  }

  return result;
}

async function emitOrFallback(
  item: AttentionItemInput,
  opts: DetectorOptions,
  result: DetectorResult,
  skipDedupe: boolean,
): Promise<void> {
  if (opts.emitAttention) {
    // AttentionQueue owns dedupe via item.id collision.
    await opts.emitAttention(item);
    result.emitted++;
    return;
  }
  const fallbackPath = opts.fallbackPath ?? path.join(opts.stateDir, AUDIT_DIR_NAME, FALLBACK_BASENAME);
  if (!skipDedupe) {
    const recent = readRecentDedupeKeys(fallbackPath);
    if (recent.has(item.id)) {
      result.deduped++;
      return;
    }
  }
  appendFallback(fallbackPath, {
    ts: new Date().toISOString(),
    dedupeKey: item.id,
    category: item.category,
    priority: item.priority,
    title: item.title,
    summary: item.summary,
    description: item.description,
    sourceContext: item.sourceContext,
  });
  result.emitted++;
}

// ── Public helper: enumerate safe roots from the agents directory ────────

/**
 * Enumerates safe roots by scanning `~/.instar/agents/<name>/.worktrees`
 * directories DIRECTLY on disk — NOT via the agent registry.
 *
 * 2026-06-05 flood root cause: the previous implementation iterated
 * `loadRegistry().entries`. The registry is rewritten concurrently by every
 * agent/lifeline on the machine, and a reader that catches a lost-update
 * window (or any parse failure, which `loadRegistry` silently maps to an
 * EMPTY entry list) sees a registry without this agent — so this agent's own
 * `.worktrees/` stopped being a safe root and every properly-placed worktree
 * was flagged as misplaced (110 false positives in one boot).
 *
 * The disk IS the ground truth here: a safe root is "an agent home's
 * `.worktrees` directory", and those are directly observable. No shared
 * mutable file in the read path → the transient-empty failure class is gone.
 */
export function enumerateSafeRoots(agentsDir?: string): string[] {
  const base = agentsDir ?? path.join(os.homedir(), '.instar', 'agents');
  let agentNames: string[] = [];
  try {
    agentNames = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    // @silent-fallback-ok — no agents dir on this machine (project-bound-only
    //   install). No agent homes → no safe roots to enumerate.
    return [];
  }
  const roots: string[] = [];
  for (const name of agentNames) {
    // Only agents that live under ~/.instar/agents/<name>/ qualify — those
    // are the ones the convention applies to. Project-bound agents have
    // worktrees in the project dir, which the lifeline detector doesn't
    // police.
    const candidate = path.join(base, name, '.worktrees');
    try {
      const real = fs.realpathSync(candidate);
      roots.push(real);
    } catch {
      // @silent-fallback-ok — agent's .worktrees/ doesn't exist yet (no
      //   `instar worktree create` calls or no Layer 3 migrator run).
      //   Skip — there's nothing under it to be a "safe root" for.
    }
  }
  return roots;
}

// ── Public helper: resolve the canonical instar repo for the detector ────

export interface ResolveDetectorRepoOptions {
  /** Path to user config (defaults to `~/.instar/config.json`). */
  configPath?: string;
  /** Override the fallback chain order (for tests). */
  fallbackChain?: ReadonlyArray<string>;
  /** Override the home directory used for default fallbacks. */
  homeDir?: string;
  /**
   * Override `process.cwd()` for current-checkout discovery (for tests —
   * without this seam the tests silently depend on whether the machine
   * running them has an allowlisted checkout at cwd).
   */
  cwd?: string;
}

/**
 * Per spec: the detector uses a deterministic source (config or default
 * chain), NOT `INSTAR_REPO` env var, because env vars can differ between
 * lifeline boot and interactive sessions and the detector wants
 * consistent results across both.
 */
export function resolveDetectorInstarRepo(opts: ResolveDetectorRepoOptions = {}): string | null {
  // Read worktree.repoPath from config (deterministic operator-supplied path).
  const resolved = opts.configPath ?? path.join(os.homedir(), '.instar', 'config.json');
  let configRepoPath: string | null = null;
  if (fs.existsSync(resolved)) {
    try {
      const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as Record<string, unknown>;
      const wt = raw.worktree as { repoPath?: unknown } | undefined;
      if (wt && typeof wt.repoPath === 'string' && wt.repoPath.trim()) {
        configRepoPath = wt.repoPath.trim();
      }
    } catch {
      // @silent-fallback-ok — config malformed; fall through to default chain.
    }
  }

  const candidateChain: string[] = [];
  if (configRepoPath) candidateChain.push(configRepoPath);
  if (opts.fallbackChain) {
    candidateChain.push(...opts.fallbackChain);
  } else {
    const home = opts.homeDir ?? os.homedir();
    candidateChain.push(path.join(home, 'Documents', 'Projects', 'instar'));
    candidateChain.push(path.join(home, 'instar'));
  }

  // Reuse the same integrity validation Layer 1 uses for INSTAR_REPO so
  // the detector and the CLI never disagree about what "the instar repo"
  // is. Skip the env-var path by passing an empty `env`.
  try {
    const repo = resolveInstarRepo({
      env: {},
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      fallbackChain: candidateChain,
      configPath: resolved,
    });
    return repo.repoPath;
  } catch {
    // @silent-fallback-ok — no validated instar repo reachable; detector
    //   simply doesn't run this tick. Caller decides whether to log/skip.
    return null;
  }
}
