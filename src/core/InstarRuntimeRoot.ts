/**
 * InstarRuntimeRoot — where an agent's runtime artifacts live so launchd can
 * always reach them.
 *
 * Background (spec: docs/specs/macos26-launchd-tcc-runtime-relocation.md):
 * On macOS 26.x the kernel enforces TCC on the launchd spawn path. An agent
 * whose `.instar/` lives under a protected folder (~/Documents, ~/Desktop,
 * ~/Downloads, iCloud Drive) can no longer be started by launchd after a
 * reboot — `posix_spawn` returns EPERM (exit 78). The fix is to relocate the
 * runtime out of the protected folder into a location launchd can always
 * reach: `~/Library/Application Support/instar/<name>-<hash>/` on macOS,
 * `~/.local/share/instar/<name>-<hash>/` on Linux.
 *
 * This module is PURE path computation + protected-location detection. It has
 * no filesystem side effects (it never moves anything) — the relocation
 * itself lives in PostUpdateMigrator.migrateRuntimeRoot(). Keeping the math
 * here makes both the migrator and the boot path resolve the same root
 * deterministically, and makes the logic unit-testable without touching disk.
 *
 * IMPORTANT (convergence NEW-6): the `<hash>` suffix disambiguates two agents
 * that share a projectName (e.g. ~/Documents/Projects/foo and ~/Desktop/foo).
 * It is computed once at first relocation and PERSISTED in relocate.json — the
 * migrator reads the stored root rather than recomputing on every boot, so a
 * later projectDir-string change can't orphan live state. `computeRuntimeRoot`
 * is the first-relocation computation; resolved-root reads go through the
 * persisted value (see `readPersistedRuntimeRoot`).
 */

import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';

/** Env var the launchd boot path uses to point at the runtime root WITHOUT
 *  traversing a (possibly TCC-locked) Documents-resident `.instar` symlink.
 *  Set from the `--runtime-root` CLI arg in server.ts / listener.ts. */
export const RUNTIME_ROOT_ENV = 'INSTAR_RUNTIME_ROOT';

/** Filename of the completion sentinel written (last) into the runtime root. */
export const RELOCATE_SENTINEL = 'relocate.json';

/** Current relocate.json schema version. Bump only on a breaking layout change
 *  that requires re-migration. */
export const RELOCATE_SCHEMA_VERSION = 1;

export interface RelocateRecord {
  schemaVersion: number;
  completed: boolean;
  runtimeRoot: string;
  projectDir: string;
  projectDirHash: string;
  projectName: string;
  relocatedAt: string;
}

/**
 * The set of TCC-protected user folders that launchd cannot spawn from on
 * macOS 26.x. Detection is by path containment, broadened beyond the obvious
 * three to include iCloud Drive (convergence adversarial M4).
 *
 * Exposed for testing with an injected home dir.
 */
export function tccProtectedRoots(homeDir: string = os.homedir()): string[] {
  return [
    path.join(homeDir, 'Documents'),
    path.join(homeDir, 'Desktop'),
    path.join(homeDir, 'Downloads'),
    // iCloud Drive — also TCC-gated.
    path.join(homeDir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'),
  ];
}

/**
 * Is `dir` inside a TCC-protected user folder? Pure prefix containment with a
 * path-boundary guard (so `~/DocumentsFoo` doesn't match `~/Documents`).
 *
 * NOTE: external/network volumes are also effectively protected on 26.x, but
 * those are not reliably detectable by path alone — the watchdog's exit-78
 * classifier (Scope B) is the backstop for "spawn-path-under-anything-launchd-
 * cannot-reach" cases the path heuristic misses.
 */
export function isUnderTccProtectedRoot(dir: string, homeDir: string = os.homedir()): boolean {
  const normalized = path.resolve(dir);
  for (const root of tccProtectedRoots(homeDir)) {
    if (normalized === root) return true;
    if (normalized.startsWith(root + path.sep)) return true;
  }
  return false;
}

/**
 * The base directory that holds all instar runtime roots on this machine.
 * macOS: ~/Library/Application Support/instar  (never TCC-prompted for the
 *        user's own launchd jobs).
 * Linux: ~/.local/share/instar  (XDG data dir).
 */
export function runtimeRootBase(platform: NodeJS.Platform = process.platform, homeDir: string = os.homedir()): string {
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'instar');
  }
  return path.join(homeDir, '.local', 'share', 'instar');
}

/**
 * Short, stable hash of the absolute projectDir — disambiguates same-named
 * projects. 8 hex chars of sha256 is collision-safe for a single machine's
 * agent count.
 */
export function projectDirHash(projectDir: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectDir)).digest('hex').slice(0, 8);
}

/**
 * Compute the runtime root for an agent AT FIRST RELOCATION. Do NOT call this
 * on every boot to "find" the root — read the persisted value via
 * `readPersistedRuntimeRoot` instead (convergence NEW-6: recomputing would
 * orphan state if projectDir ever changes).
 */
export function computeRuntimeRoot(
  projectName: string,
  projectDir: string,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  const safeName = sanitizeName(projectName) || 'agent';
  return path.join(runtimeRootBase(platform, homeDir), `${safeName}-${projectDirHash(projectDir)}`);
}

/** Filesystem-safe form of a project name for use as a directory component.
 *  Neutralizes path-traversal `..` runs (a single `.` is allowed, e.g. for
 *  version-like names) and trims separator runs. */
function sanitizeName(name: string): string {
  return name
    .replace(/[^A-Za-z0-9._-]/g, '-') // non-allowed chars → dash
    .replace(/\.{2,}/g, '-')          // collapse `..`/`...` (traversal) → dash
    .replace(/-+/g, '-')              // collapse dash runs
    .replace(/^[-.]+|[-.]+$/g, '');   // trim leading/trailing dash or dot
}

/**
 * Read the persisted runtime root for an agent, if it has been relocated.
 * Returns the stored `runtimeRoot` from `<runtimeRoot>/relocate.json` only when
 * the record is complete and the schema version matches.
 *
 * Resolution of WHERE relocate.json lives, without recomputing the hash:
 * the project's `.instar` (a whole-dir symlink after relocation) is followed
 * transparently by the OS, so `<projectDir>/.instar/relocate.json` resolves to
 * the file in the runtime root. This read happens from a CONSENTED context
 * (the boot path uses RUNTIME_ROOT_ENV instead and never calls this).
 *
 * Returns `null` when not relocated / unreadable / stale-schema.
 */
export function readPersistedRuntimeRoot(projectDir: string): string | null {
  const rec = readRelocateRecord(projectDir);
  if (!rec) return null;
  if (!rec.completed) return null;
  if (rec.schemaVersion !== RELOCATE_SCHEMA_VERSION) return null;
  return rec.runtimeRoot;
}

/** Read + validate the relocate.json record via the (possibly symlinked)
 *  project `.instar` dir. Returns null on any read/parse failure. */
export function readRelocateRecord(projectDir: string): RelocateRecord | null {
  const sentinelPath = path.join(projectDir, '.instar', RELOCATE_SENTINEL);
  try {
    const raw = fs.readFileSync(sentinelPath, 'utf-8');
    const parsed = JSON.parse(raw) as RelocateRecord;
    if (typeof parsed.runtimeRoot !== 'string' || typeof parsed.schemaVersion !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Resolve the state dir for THIS process, honoring the two-layer pointer:
 *
 *  1. Boot layer — if `INSTAR_RUNTIME_ROOT` is set (the launchd-spawned
 *     server/lifeline parses `--runtime-root` into it), use it directly. This
 *     path NEVER touches the Documents-resident `.instar` symlink (a readlink
 *     under Documents EPERMs on macOS 26).
 *  2. Consented layer — otherwise `<projectDir>/.instar`. If the agent was
 *     relocated, this is a whole-dir symlink the OS follows transparently
 *     (works from a consented context that has a TCC key); if not relocated,
 *     it's the real directory.
 *
 * This is the single funnel the spec's CI grep-gate protects: production code
 * constructs state paths from the returned value, never by re-joining
 * `projectDir + '.instar'` ad hoc.
 */
export function resolveStateDir(projectDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const bootRoot = env[RUNTIME_ROOT_ENV];
  if (bootRoot && bootRoot.trim()) {
    return bootRoot.trim();
  }
  return path.join(projectDir, '.instar');
}

/** The decision the migrator's relocation orchestrator makes, given gathered
 *  facts. Pure + exhaustively testable — the orchestrator just gathers the
 *  inputs (platform, relocated?, in-TCC?, source-readable?) and acts on the
 *  verdict, so the gate/guard ordering can't drift. */
export type RelocationAction =
  | 'skip-not-macos'        // Linux / Windows — no TCC issue
  | 'skip-already-relocated' // relocate.json present + complete + current schema
  | 'skip-not-tcc'          // projectDir not under a TCC-protected folder (e.g. Echo)
  | 'blocked-tcc-blind'     // would relocate, but the source is unreadable (launchd-spawned TCC-blind context) → escalate, do NOT partial-move
  | 'relocate';             // consented context, in a TCC folder, not yet relocated → do it

export interface RelocationFacts {
  platform: NodeJS.Platform;
  alreadyRelocated: boolean;
  underTccProtectedRoot: boolean;
  sourceReadable: boolean;
}

/**
 * The relocation decision. ORDER IS LOAD-BEARING (convergence NEW-R1):
 *   1. already-relocated short-circuit FIRST — so an already-relocated agent
 *      re-running migrate from a launchd/TCC-blind context never attempts a move
 *      (it read relocate.json from the Library root, which is readable).
 *   2. macOS gate.
 *   3. TCC-folder gate.
 *   4. source-readable guard — readable ⇒ consented context ⇒ relocate;
 *      unreadable ⇒ launchd-spawned TCC-blind ⇒ blocked (escalate, no move).
 */
export function classifyRelocation(facts: RelocationFacts): RelocationAction {
  if (facts.alreadyRelocated) return 'skip-already-relocated';
  if (facts.platform !== 'darwin') return 'skip-not-macos';
  if (!facts.underTccProtectedRoot) return 'skip-not-tcc';
  return facts.sourceReadable ? 'relocate' : 'blocked-tcc-blind';
}
