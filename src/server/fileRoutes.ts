/**
 * File viewer API routes for the dashboard.
 *
 * Phase 1: List directories and read files within allowed paths.
 * Phase 2: Inline editing with optimistic concurrency and audit logging.
 *
 * All paths are relative to the project root. Security is defense-in-depth:
 * normalize, reject absolute, reject .., check allowedPaths, symlink resolution,
 * blocked filenames, never-editable enforcement.
 */

import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { IDENTITY_AUTO_ACCEPT_PROTECTED_PATHS, isRemoteIdentityAuthorityPath } from '../core/IdentityStore.js';
import { KEY_MATERIAL_DYNAMIC_DIRS, KEY_MATERIAL_FILES, KEY_MATERIAL_NEVER_SERVED_PREFIXES, KEY_MATERIAL_ROOT_NAME_PREFIXES } from '../core/keyMaterialPaths.js';
import type { InstarConfig, FileViewerConfig } from '../core/types.js';
import { mergeDefaults } from '../core/mergeDefaults.js';

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_FILE_VIEWER_CONFIG: FileViewerConfig = {
  enabled: true,
  allowedPaths: ['./'],
  editablePaths: ['./'],
  maxFileSize: 1_048_576, // 1MB
  maxEditableFileSize: 204_800, // 200KB
  blockedFilenames: [
    '.env', '.env.*', '*.key', '*.pem', '*.p12', 'secrets.*',
    'credentials.*', '*.secret', 'id_rsa', 'id_ed25519', '*.pfx',
    '*.jks', 'token.json',
  ],
};

// ── Blocked filename matching ────────────────────────────────────────

/**
 * Check if a filename matches any blocked pattern.
 * Supports: exact match, prefix glob (*.ext), suffix glob (prefix.*), combined (prefix.*)
 */
function isBlockedFilename(filename: string, patterns: string[]): boolean {
  const lower = filename.toLowerCase();
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (p === lower) return true;
    if (p.startsWith('*.')) {
      // *.ext — match any file ending with that extension
      const ext = p.slice(1); // e.g., ".key"
      if (lower.endsWith(ext)) return true;
    } else if (p.endsWith('.*')) {
      // prefix.* — match any file starting with that prefix followed by a dot
      const prefix = p.slice(0, -1); // e.g., ".env."
      if (lower.startsWith(prefix)) return true;
    }
  }
  return false;
}

// ── Binary detection ─────────────────────────────────────────────────

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flac', '.wav', '.ogg',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.sqlite', '.db', '.sqlite3',
]);

function isBinaryFile(filePath: string, buffer?: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  // Check first 512 bytes for null bytes
  if (buffer) {
    const check = buffer.subarray(0, 512);
    for (let i = 0; i < check.length; i++) {
      if (check[i] === 0) return true;
    }
  }
  return false;
}

// ── Never-served paths (security invariant — read + edit deny) ───────

/**
 * Paths that are NEVER served over HTTP regardless of config — list, read,
 * download, link, edit, and any proxy that lands on this machine's file routes
 * (ownership-gated-spawn-and-judgment-within-floors spec §3.5).
 *
 * Distinct from NEVER_EDITABLE_PREFIXES (edit-only) and from
 * `blockedFilenames` (config-mutable via PATCH /api/files/config): this list
 * is HARDCODED and config-immune, and it is enforced inside validatePath
 * against the FULLY-RESOLVED (realpath) project-relative path, so a symlink
 * inside an allowed path cannot evade it. A never-served path is also
 * never-editable by construction (isNeverEditable consults this list too —
 * a confused session must not be able to poison provenance rows that the
 * graded-review job replays into bench batteries).
 */
export const NEVER_SERVED_PREFIXES = [
  // machine-self-assertion FD9: this manifest is the single mechanical list of
  // identity/evidence inputs whose bearer readability or writability would
  // collapse the auto-accept boundary. isNeverEditable delegates to this list.
  ...IDENTITY_AUTO_ACCEPT_PROTECTED_PATHS,
  // Registry may converge only through the purpose-built registry merge path;
  // generic bearer file reads/writes remain forbidden.
  '.instar/machines/registry.json',
  // Judgment-call provenance rows: full decision context, machine-local only
  // (0700/0600, gitignored, backup-excluded). The HTTP read surface for this
  // data is GET /judgment-provenance (redacted rows only) — never the files.
  // DUAL-ROOT (llm-decision-quality-meter spec §5.3, SEC r4): this list matches
  // PROJECTDIR-relative paths while the log lives under <projectDir>/.instar/
  // state/ (stateDir), so the bare 'state/' literal never matches a production
  // path — it stays only as a legacy-layout regression pin.
  'state/judgment-provenance/',
  '.instar/state/judgment-provenance/',
  // External-hog decision store: grading GROUND TRUTH (llm-decision-quality-
  // meter spec §5.3) — the dashboard file editor must not read or rewrite it
  // (serve-deny implies edit-deny via isNeverEditable).
  '.instar/state/external-hog-decisions.json',
  // Machine-bound subscription authority: active directory, witness,
  // candidates, rollbacks, and atomic temp siblings. Dual-root is required:
  // production paths include `.instar/`, legacy/test paths may not.
  'state/subscription-pool',
  '.instar/state/subscription-pool',
  'state/subscription-login-ledger',
  '.instar/state/subscription-login-ledger',
  'state/subscription-relogin',
  '.instar/state/subscription-relogin',
  'state/claim-verification/',
  '.instar/state/claim-verification/',
  // The agent's own config: round-13 fenced it as never-EDITABLE because it
  // selects which executable a session spawns. Round-17 (security) found the
  // read half open — the same Bearer token that cannot write this file could
  // GET it and read `dashboardPin` and `authToken` verbatim. Every PIN-gated
  // lever deliberately reserved for an operator act on the machine was then
  // one HTTP GET away, which makes the write fence worth nothing. Serve-deny
  // implies edit-deny via isNeverEditable, so this one entry closes read,
  // download, link, list AND edit. A redacted read surface, if ever wanted,
  // belongs behind a route that strips the credentials — not the raw file.
  '.instar/config.json',
  // Key material (a2a-single-agent-identity §5.1): the agent identity (and its
  // superseded/invalid/temp siblings), the legacy routing mirror, the
  // threadline HMAC/invitation/token files, the dedicated SSH keys, the
  // headless key vault, origin-session credentials and the bind-token secret.
  // ONE list (src/core/keyMaterialPaths.ts) also feeds backup, gitignore and
  // the sync classifier, so the four surfaces cannot drift apart.
  ...KEY_MATERIAL_NEVER_SERVED_PREFIXES,
];

export function isNeverServed(relativePath: string): boolean {
  // Case-folded for the same reason as isNeverEditable (round-14 security): on
  // a case-insensitive filesystem a capitalised request reaches the same file.
  const normalized = path.normalize(relativePath).toLowerCase();
  return isRemoteIdentityAuthorityPath(normalized) || NEVER_SERVED_PREFIXES.some(prefix => {
    const p = prefix.toLowerCase();
    return normalized.startsWith(p) || normalized === p.replace(/\/$/, '');
  });
}

// ── Path validation (6-layer defense) ────────────────────────────────

interface PathValidationResult {
  valid: boolean;
  error?: string;
  status?: number;
  resolvedPath?: string; // absolute path after validation
  /**
   * Project-relative path AFTER symlink resolution (round-14 security). The
   * edit chokepoints must deny on THIS, not on the requested path: a symlink
   * inside an allowed directory pointing at `.instar/config.json` (or into
   * `.claude/hooks/`) was accepted, because `isNeverEditable` saw only the
   * alias while the write went to the resolved target. Verified end-to-end
   * against the real route before the fix: 200, and the real file rewritten.
   * `isNeverServed` already had this post-realpath re-check and says in its own
   * comment that it exists so "a symlink cannot evade it" — the edit list
   * simply never got the same treatment.
   */
  relativeAfterResolve?: string;
  /**
   * `stat` of the resolved path taken AT validation time (§5.2). `read` and
   * `download` open the file, `fstat` the descriptor, and refuse unless its
   * device+inode equals THIS — the file that was checked is the file that is
   * served, even if the symlink was swapped between the check and the open.
   */
  resolvedStat?: fs.Stats;
}

/**
 * Layers 1–4 of the path defense, as one shared pure pre-check: normalize,
 * reject absolute, reject traversal, never-served deny, allowedPaths match
 * (with the '.'/'./' project-root convention and segment-boundary matching).
 *
 * Exported as the SINGLE source of truth for "is this relative path within
 * the allowed directories". The /api/files/link route used to carry its own
 * inline duplicate of this policy, which drifted: it never learned the
 * project-root convention (so the DEFAULT config `allowedPaths: ['./']`
 * 403'd every link), matched prefixes without a segment boundary, and
 * skipped the absolute/traversal rejections. One helper, no drift.
 */
export function checkRelativePathAllowed(
  requestedPath: string,
  config: FileViewerConfig,
): { ok: true; normalized: string } | { ok: false; error: string; status: number } {
  // Layer 1: Normalize
  const normalized = path.normalize(requestedPath);

  // Layer 2: Reject absolute paths
  if (path.isAbsolute(normalized)) {
    return { ok: false, error: 'Absolute paths are not allowed', status: 403 };
  }

  // Layer 3: Reject path traversal
  if (normalized.includes('..')) {
    return { ok: false, error: 'Path traversal not allowed', status: 403 };
  }

  // Layer 3b: Never-served deny (fast path — validatePath's load-bearing
  // check re-runs post-realpath at Layer 5e so a symlink cannot evade it).
  if (isNeverServed(normalized)) {
    return { ok: false, error: 'Access to this path is not permitted', status: 403 };
  }

  // Layer 4: Check against allowedPaths
  // Strip trailing slashes for comparison — path.normalize() may or may not
  // preserve them depending on Node version, causing false 403s.
  const stripTrailing = (p: string) => p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
  const normalizedClean = stripTrailing(normalized);
  const allowed = config.allowedPaths.some(ap => {
    const normalizedAllowed = stripTrailing(path.normalize(ap));
    // '.' means project root — allow everything within the project
    if (normalizedAllowed === '.') return true;
    return normalizedClean === normalizedAllowed ||
           normalizedClean.startsWith(normalizedAllowed + '/');
  });
  if (!allowed) {
    return { ok: false, error: 'Path not in allowed directories', status: 403 };
  }
  return { ok: true, normalized };
}

async function validatePath(
  requestedPath: string,
  projectDir: string,
  config: FileViewerConfig,
): Promise<PathValidationResult> {
  // Layers 1–4 via the shared pre-check (single source of truth).
  const pre = checkRelativePathAllowed(requestedPath, config);
  if (!pre.ok) {
    return { valid: false, error: pre.error, status: pre.status };
  }
  const normalized = pre.normalized;

  // Layer 5: Symlink resolution
  const absolutePath = path.resolve(projectDir, normalized);
  try {
    // 5a: Check if it exists
    await fs.promises.lstat(absolutePath);
    // 5b: Resolve all symlinks
    const realPath = await fs.promises.realpath(absolutePath);
    // 5c: Post-dereference project root check
    const realProjectDir = await fs.promises.realpath(projectDir);
    if (!realPath.startsWith(realProjectDir + path.sep) && realPath !== realProjectDir) {
      return { valid: false, error: 'Path resolves outside project root', status: 403 };
    }
    // 5d: Post-dereference re-check against allowedPaths
    const relativAfterResolve = path.relative(realProjectDir, realPath);
    const allowedAfterResolve = config.allowedPaths.some(ap => {
      const normalizedAllowed = path.normalize(ap);
      // '.' means project root — allow everything within the project
      if (normalizedAllowed === '.' || normalizedAllowed === './') return true;
      return relativAfterResolve === normalizedAllowed.replace(/\/$/, '') ||
             relativAfterResolve.startsWith(normalizedAllowed.endsWith('/') ? normalizedAllowed : normalizedAllowed + '/') ||
             // Handle exact match with the allowed path itself (e.g. listing .claude/)
             (normalizedAllowed.replace(/\/$/, '') === relativAfterResolve);
    });
    if (!allowedAfterResolve) {
      return { valid: false, error: 'Resolved path not in allowed directories', status: 403 };
    }
    // Layer 5e: Never-served deny against the FULLY-RESOLVED project-relative
    // path — a symlink inside an allowed path that dereferences into a
    // never-served prefix is refused here (config-immune, spec §3.5).
    if (isNeverServed(relativAfterResolve)) {
      return { valid: false, error: 'Access to this path is not permitted', status: 403 };
    }
    // Layer 5f: `blockedFilenames` on the RESOLVED name too (§5.2) — the
    // requested-name check in each route sees only the alias; a symlink named
    // `notes.md` pointing at `.env` was served before this.
    const resolvedStat = await fs.promises.stat(realPath);
    return { valid: true, resolvedPath: realPath, relativeAfterResolve: relativAfterResolve, resolvedStat };
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { valid: false, error: 'Path not found', status: 404 };
    }
    // A `realpath` that fails for any other reason (ELOOP, EACCES, a dangling
    // link that lstat saw) REFUSES (§5.2) — never a 500 that invites a retry
    // and never a fall-through to the requested path.
    return { valid: false, error: 'Path could not be resolved', status: 403 };
  }
}

/**
 * Open the checked file and prove the descriptor IS the checked file (§5.2).
 *
 * `validatePath` resolves and denies on a PATH. Between that check and a
 * by-path re-open, a symlink can be swapped at a key file (check-then-serve
 * race). So the routes open FIRST, `fstat` the descriptor, and serve from that
 * descriptor only when its device+inode equals the `stat` taken at validation.
 *
 * A hard link is the other way an inode escapes a prefix check: a link OUTSIDE
 * `.instar/` carries a key's inode under an innocent name, and no path-based
 * list can see it. When the descriptor reports `nlink > 1` its device+inode is
 * compared against every listed key file (a dozen `stat` calls, per request —
 * only on the rare multi-link file) and refused on a match.
 *
 * Returns the open handle (the caller closes it) or `null` with the refusal
 * reason. Exported for the unit test that swaps the target between the check
 * and the open — the only way to exercise the race deterministically.
 */
export async function openCheckedDescriptor(
  realPath: string,
  checkedStat: fs.Stats,
  projectDir: string,
): Promise<{ handle: fs.promises.FileHandle; stat: fs.Stats } | { handle: null; reason: string }> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(realPath, 'r');
  } catch {
    return { handle: null, reason: 'Path could not be opened' };
  }
  try {
    const opened = await handle.stat();
    if (opened.dev !== checkedStat.dev || opened.ino !== checkedStat.ino) {
      await handle.close();
      return { handle: null, reason: 'File changed between check and open' };
    }
    if (opened.nlink > 1) {
      const stateDir = path.join(projectDir, '.instar');
      for (const abs of await keyInodeCandidates(stateDir)) {
        let keyStat: fs.Stats;
        try {
          keyStat = await fs.promises.stat(abs);
        } catch {
          continue; // that key file does not exist on this agent
        }
        if (keyStat.dev === opened.dev && keyStat.ino === opened.ino) {
          await handle.close();
          return { handle: null, reason: 'Access to this path is not permitted' };
        }
      }
    }
    return { handle, stat: opened };
  } catch {
    await handle.close().catch(() => { /* already failing */ });
    return { handle: null, reason: 'Path could not be opened' };
  }
}

/**
 * The key files whose inode a hard link could carry (§5.2): the static list
 * plus the generation-named keys under `machine-ssh/` and the
 * `origin-sessions-<digest>` files at the stateDir root, which a static list
 * cannot name. Two `readdir`s, only on the rare multi-link path.
 */
async function keyInodeCandidates(stateDir: string): Promise<string[]> {
  const out = KEY_MATERIAL_FILES.map((rel) => path.join(stateDir, rel));
  for (const dir of KEY_MATERIAL_DYNAMIC_DIRS) {
    try {
      for (const name of await fs.promises.readdir(path.join(stateDir, dir))) out.push(path.join(stateDir, dir, name));
    } catch { /* directory absent on this agent — nothing to enumerate */ }
  }
  try {
    for (const name of await fs.promises.readdir(stateDir)) {
      if (KEY_MATERIAL_ROOT_NAME_PREFIXES.some((p) => name.startsWith(p))) out.push(path.join(stateDir, name));
    }
  } catch { /* stateDir absent — nothing to enumerate */ }
  return out;
}

/**
 * Per-entry admission for `list` (§5.2): an entry is OMITTED — never listed,
 * never 403'd by name — when it is never-served by its requested path, when
 * its `realpath` fails (a dangling symlink), when it resolves outside the
 * project root, when its RESOLVED path is never-served, or when either the
 * requested or the resolved basename matches `blockedFilenames`. A symlink
 * with an innocent name pointing at a key file is therefore hidden, matching
 * the route's existing skip-on-stat-failure shape.
 */
async function resolveListEntry(
  dirAbs: string,
  entryName: string,
  entryRelPath: string,
  realProjectDir: string,
  config: FileViewerConfig,
): Promise<{ realPath: string; stat: fs.Stats } | null> {
  if (isNeverServed(entryRelPath)) return null;
  if (isBlockedFilename(entryName, config.blockedFilenames)) return null;
  try {
    const realPath = await fs.promises.realpath(path.join(dirAbs, entryName));
    if (!realPath.startsWith(realProjectDir + path.sep) && realPath !== realProjectDir) return null;
    const resolvedRel = path.relative(realProjectDir, realPath);
    if (isNeverServed(resolvedRel)) return null;
    if (isBlockedFilename(path.basename(realPath), config.blockedFilenames)) return null;
    const stat = await fs.promises.stat(realPath);
    return { realPath, stat };
  } catch {
    return null;
  }
}

// Layer 6: Blocked filename check (applied separately for files)
function checkBlockedFilename(filePath: string, config: FileViewerConfig): string | null {
  const basename = path.basename(filePath);
  if (isBlockedFilename(basename, config.blockedFilenames)) {
    return 'Access to this file is blocked for security reasons';
  }
  return null;
}

// ── Check if a path is editable ──────────────────────────────────────

function isEditable(relativePath: string, config: FileViewerConfig): boolean {
  const normalized = path.normalize(relativePath);
  return config.editablePaths.some(ep => {
    const normalizedEditable = path.normalize(ep);
    // '.' means project root — everything is editable
    if (normalizedEditable === '.' || normalizedEditable === './') return true;
    return normalized === normalizedEditable ||
           normalized.startsWith(normalizedEditable.endsWith('/') ? normalizedEditable : normalizedEditable + '/');
  });
}

// ── Never-editable paths (security invariant) ────────────────────────

/**
 * Paths that are NEVER editable regardless of config.
 * A PIN compromise must never result in arbitrary code execution.
 */
const NEVER_EDITABLE_PREFIXES = [
  '.claude/hooks/',
  '.claude/scripts/',
  'node_modules/',
  // INSTAR-JOBS-AS-AGENTMD spec §Decision Points: the .instar/jobs/instar/
  // namespace is owned by the update process; the Dashboard editor MUST NOT
  // permit edits here. Operators who want to customize a shipped default
  // must Fork it (writes to .instar/jobs/user/ via the override flow);
  // direct edits to instar/ would be overwritten on next update and risk
  // breaking the signed lock-file's body-hash verification.
  '.instar/jobs/instar/',
  // Round-13 (security, grok-build spec §2.1): `.instar/config.json` selects
  // WHICH EXECUTABLE a session spawns (`sessions.frameworkBinaryPaths`), which
  // credentials a lane uses, and which features are enabled. `PATCH /config`
  // was fenced against the executable key — and that fence was incomplete
  // while the same Bearer token could write the whole file through the editor,
  // so the stated boundary ("an operator act on the machine") was not held. It
  // is a machine-local operator surface, not a document to edit from a phone;
  // the conversational config path and a raw file edit remain.
  '.instar/config.json',
];

/**
 * Exported for the round-14 bypass tests: the case-folding and resolved-path
 * behaviour must be asserted against THIS predicate, not a sibling that merely
 * shares the fix — a proxy assertion is the "narrower than what it certifies"
 * class this branch has been catching all night.
 */
export function isNeverEditable(relativePath: string): boolean {
  // CASE-FOLDED (round-14 security). macOS APFS and Windows are
  // case-INSENSITIVE, so a case-sensitive comparison here was bypassable by
  // asking for `.instar/Config.json` — verified end-to-end against the real
  // route: 403 for the exact case, 200 (and the real file rewritten) for a
  // capitalised one. The sibling `isBlockedFilename` in this same file already
  // lower-cases both sides; this list did not, and the entries it guards are
  // the ones whose invariant is "a PIN compromise must never result in
  // arbitrary code execution" (`.claude/hooks/`, `.claude/scripts/`).
  const normalized = path.normalize(relativePath).toLowerCase();
  // A never-served path is never-editable by construction (spec §3.5): the
  // serve-deny implies the edit-deny at every chokepoint that consults this.
  if (isNeverServed(normalized)) return true;
  return NEVER_EDITABLE_PREFIXES.some(prefix => {
    const p = prefix.toLowerCase();
    return normalized.startsWith(p) || normalized === p.replace(/\/$/, '');
  });
}

// ── Audit log ────────────────────────────────────────────────────────

async function appendAuditLog(
  projectDir: string,
  entry: { operation: string; path: string; sourceIp: string; size: number; success: boolean },
): Promise<void> {
  const logDir = path.join(projectDir, '.instar');
  const logPath = path.join(logDir, 'file-viewer-audit.jsonl');
  try {
    await fs.promises.mkdir(logDir, { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    await fs.promises.appendFile(logPath, line);
  } catch {
    // Audit log failure must not block the save operation
  }
}

// ── Route factory ────────────────────────────────────────────────────

export function createFileRoutes(options: { config: InstarConfig; liveConfig?: { set(path: string, value: unknown): void } }): Router {
  const router = Router();
  const projectDir = options.config.projectDir;
  const config: FileViewerConfig = mergeDefaults(DEFAULT_FILE_VIEWER_CONFIG, options.config.dashboard?.fileViewer);

  const liveConfig = options.liveConfig ?? null;

  // If file viewer is disabled, return empty router
  if (!config.enabled) return router;

  // ── GET /api/files/list ────────────────────────────────────────

  router.get('/api/files/list', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';

    // If no path specified, return the root allowed directories
    if (!requestedPath) {
      // If allowedPaths includes './' (project root), list the project directory directly
      const hasProjectRoot = config.allowedPaths.some(ap => {
        const normalized = path.normalize(ap).replace(/\/$/, '');
        return normalized === '.';
      });

      if (hasProjectRoot) {
        // List the project root directory contents directly
        try {
          const dirEntries = await fs.promises.readdir(projectDir, { withFileTypes: true });
          const sorted = dirEntries.sort((a, b) => {
            const aDir = a.isDirectory() ? 0 : 1;
            const bDir = b.isDirectory() ? 0 : 1;
            if (aDir !== bDir) return aDir - bDir;
            return a.name.localeCompare(b.name);
          });
          const entries: Array<{ name: string; type: string; size?: number; modified?: string }> = [];
          const realProjectDir = await fs.promises.realpath(projectDir);
          for (const entry of sorted.slice(0, 500)) {
            // §5.2: every entry (directories and symlinks included) is
            // resolved and admitted by the same rules as a direct request.
            const resolved = await resolveListEntry(projectDir, entry.name, entry.name, realProjectDir, config);
            if (!resolved) continue;
            if (resolved.stat.isDirectory()) {
              entries.push({ name: entry.name, type: 'directory' });
            } else if (resolved.stat.isFile()) {
              entries.push({ name: entry.name, type: 'file', size: resolved.stat.size, modified: resolved.stat.mtime.toISOString() });
            }
          }
          res.json({ path: '', entries });
        } catch {
          res.status(500).json({ error: 'Failed to list project root' });
        }
        return;
      }

      const roots: Array<{ name: string; type: string }> = [];
      for (const ap of config.allowedPaths) {
        const normalizedAp = path.normalize(ap).replace(/\/$/, '');
        const absPath = path.resolve(projectDir, normalizedAp);
        try {
          const stat = await fs.promises.lstat(absPath);
          if (stat.isDirectory()) {
            roots.push({ name: normalizedAp, type: 'directory' });
          }
        } catch {
          // Silently skip non-existent allowed paths
        }
      }
      res.json({ path: '', entries: roots });
      return;
    }

    // Validate the requested path
    const validation = await validatePath(requestedPath, projectDir, config);
    if (!validation.valid) {
      res.status(validation.status || 403).json({ error: validation.error });
      return;
    }

    const absPath = validation.resolvedPath!;

    try {
      const stat = await fs.promises.stat(absPath);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' });
        return;
      }

      const entries: Array<{
        name: string;
        type: 'file' | 'directory';
        size?: number;
        modified?: string;
      }> = [];

      const dirEntries = await fs.promises.readdir(absPath, { withFileTypes: true });

      // Sort: directories first, then alphabetically
      const sorted = dirEntries.sort((a, b) => {
        const aDir = a.isDirectory() ? 0 : 1;
        const bDir = b.isDirectory() ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a.name.localeCompare(b.name);
      });

      // Limit to 500 entries
      const limited = sorted.slice(0, 500);

      const realProjectDir = await fs.promises.realpath(projectDir);
      for (const entry of limited) {
        const entryRelPath = path.join(path.normalize(requestedPath), entry.name);
        // §5.2: resolve EACH entry and omit one whose realpath fails or is
        // denied (requested OR resolved path never-served; requested OR
        // resolved basename blocked). A symlink with an innocent name that
        // points at a key file is hidden, not listed.
        const resolved = await resolveListEntry(absPath, entry.name, entryRelPath, realProjectDir, config);
        if (!resolved) continue;

        if (resolved.stat.isDirectory()) {
          entries.push({ name: entry.name, type: 'directory' });
        } else if (resolved.stat.isFile()) {
          entries.push({
            name: entry.name,
            type: 'file',
            size: resolved.stat.size,
            modified: resolved.stat.mtime.toISOString(),
          });
        }
      }

      const result: Record<string, unknown> = {
        path: path.normalize(requestedPath),
        entries,
      };

      if (sorted.length > 500) {
        result.truncated = true;
        result.totalEntries = sorted.length;
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list directory' });
    }
  });

  // ── GET /api/files/read ────────────────────────────────────────

  router.get('/api/files/read', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    // Validate the path
    const validation = await validatePath(requestedPath, projectDir, config);
    if (!validation.valid) {
      res.status(validation.status || 403).json({ error: validation.error });
      return;
    }

    // Check blocked filenames — on the requested AND the resolved name (§5.2).
    const blocked = checkBlockedFilename(requestedPath, config) ?? checkBlockedFilename(validation.resolvedPath!, config);
    if (blocked) {
      res.status(403).json({ error: blocked });
      return;
    }

    const absPath = validation.resolvedPath!;

    try {
      const checkedStat = validation.resolvedStat!;

      if (checkedStat.isDirectory()) {
        res.status(400).json({ error: 'Path is a directory, use /api/files/list instead' });
        return;
      }

      // Size check
      if (checkedStat.size > config.maxFileSize) {
        res.status(413).json({
          error: 'File too large',
          size: checkedStat.size,
          maxSize: config.maxFileSize,
        });
        return;
      }

      // §5.2: open FIRST, prove the descriptor is the checked inode, then read
      // FROM THAT DESCRIPTOR — a by-path re-open would reintroduce the
      // check-then-serve race.
      const opened = await openCheckedDescriptor(absPath, checkedStat, projectDir);
      if (!opened.handle) {
        res.status(403).json({ error: opened.reason });
        return;
      }
      const stat = opened.stat;
      let buffer: Buffer;
      try {
        buffer = await opened.handle.readFile();
      } finally {
        await opened.handle.close();
      }

      if (isBinaryFile(absPath, buffer)) {
        res.json({
          path: path.normalize(requestedPath),
          binary: true,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
        return;
      }

      const content = buffer.toString('utf-8');
      // Round-17 (security): `isEditable` alone answers "is this in an allowed
      // path", not "may this be written". A never-editable file was advertised
      // as editable=true, so the dashboard rendered an editor whose every save
      // then 403'd. Consult BOTH the requested and the post-realpath path, for
      // the same reason the save route does — a symlink is otherwise editable
      // in the listing and refused on write.
      const editable =
        isEditable(requestedPath, config) &&
        !isNeverEditable(requestedPath) &&
        !(validation.relativeAfterResolve && isNeverEditable(validation.relativeAfterResolve));

      res.json({
        path: path.normalize(requestedPath),
        content,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        editable,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read file' });
    }
  });

  // ── POST /api/files/save ─────────────────────────────────────

  router.post('/api/files/save', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    // CSRF protection: require custom header
    if (req.headers['x-instar-request'] !== '1') {
      res.status(403).json({ error: 'Missing CSRF header' });
      return;
    }

    const { path: requestedPath, content, expectedModified } = req.body || {};
    const sourceIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';

    if (typeof requestedPath !== 'string' || !requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Missing content parameter' });
      return;
    }

    // Check content size against editable limit
    const contentSize = Buffer.byteLength(content, 'utf-8');
    if (contentSize > config.maxEditableFileSize) {
      res.status(413).json({
        error: 'Content too large for editing',
        size: contentSize,
        maxSize: config.maxEditableFileSize,
      });
      return;
    }

    // Validate path (same 6-layer defense as read)
    const validation = await validatePath(requestedPath, projectDir, config);
    if (!validation.valid) {
      res.status(validation.status || 403).json({ error: validation.error });
      return;
    }

    // Check blocked filenames
    const blocked = checkBlockedFilename(requestedPath, config);
    if (blocked) {
      res.status(403).json({ error: blocked });
      return;
    }

    // Never-editable enforcement (security invariant).
    // Round-14 (security): deny on the RESOLVED path as well as the requested
    // one. A symlink inside an allowed directory pointing at a never-editable
    // target was accepted, because this saw only the alias while the write went
    // to `validation.resolvedPath`. Verified end-to-end before the fix: 200,
    // and the real file rewritten — including a `.claude/hooks/` body, which
    // breaks that list's stated invariant that a PIN compromise must never
    // yield arbitrary code execution.
    if (isNeverEditable(requestedPath)
        || (validation.relativeAfterResolve && isNeverEditable(validation.relativeAfterResolve))) {
      res.status(403).json({ error: 'This path is never editable for security reasons' });
      return;
    }

    // Editable path check
    if (!isEditable(requestedPath, config)) {
      res.status(403).json({ error: 'This file is not in an editable path' });
      return;
    }

    const absPath = validation.resolvedPath!;

    try {
      const stat = await fs.promises.stat(absPath);

      if (stat.isDirectory()) {
        res.status(400).json({ error: 'Cannot write to a directory' });
        return;
      }

      // Binary check
      if (isBinaryFile(absPath)) {
        res.status(400).json({ error: 'Cannot edit binary files' });
        return;
      }

      // Optimistic concurrency: check if file was modified since client loaded it
      if (typeof expectedModified === 'string') {
        const currentModified = stat.mtime.toISOString();
        if (currentModified !== expectedModified) {
          await appendAuditLog(projectDir, {
            operation: 'write_conflict',
            path: requestedPath,
            sourceIp,
            size: contentSize,
            success: false,
          });
          res.status(409).json({
            error: 'File was modified since you loaded it',
            currentModified,
            expectedModified,
          });
          return;
        }
      }

      // Write the file
      await fs.promises.writeFile(absPath, content, 'utf-8');

      // Get updated stats
      const newStat = await fs.promises.stat(absPath);

      await appendAuditLog(projectDir, {
        operation: 'write',
        path: requestedPath,
        sourceIp,
        size: contentSize,
        success: true,
      });

      res.json({
        path: path.normalize(requestedPath),
        size: newStat.size,
        modified: newStat.mtime.toISOString(),
        success: true,
      });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File was deleted between validation and write — create it
        try {
          await fs.promises.writeFile(absPath, content, 'utf-8');
          const newStat = await fs.promises.stat(absPath);
          await appendAuditLog(projectDir, {
            operation: 'create',
            path: requestedPath,
            sourceIp,
            size: contentSize,
            success: true,
          });
          res.json({
            path: path.normalize(requestedPath),
            size: newStat.size,
            modified: newStat.mtime.toISOString(),
            success: true,
          });
        } catch {
          await appendAuditLog(projectDir, {
            operation: 'write',
            path: requestedPath,
            sourceIp,
            size: contentSize,
            success: false,
          });
          res.status(500).json({ error: 'Failed to save file' });
        }
        return;
      }
      await appendAuditLog(projectDir, {
        operation: 'write',
        path: requestedPath,
        sourceIp,
        size: contentSize,
        success: false,
      });
      res.status(500).json({ error: 'Failed to save file' });
    }
  });

  // ── GET /api/files/config ──────────────────────────────────────

  router.get('/api/files/config', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      enabled: config.enabled,
      allowedPaths: config.allowedPaths,
      editablePaths: config.editablePaths,
      maxFileSize: config.maxFileSize,
      maxEditableFileSize: config.maxEditableFileSize,
    });
  });

  // ── PATCH /api/files/config ─────────────────────────────────────
  // Phase 3: Conversational config updates — agent can add/remove paths

  router.patch('/api/files/config', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    if (req.headers['x-instar-request'] !== '1') {
      res.status(403).json({ error: 'Missing CSRF header' });
      return;
    }

    if (!liveConfig) {
      res.status(501).json({ error: 'Config updates not available (no LiveConfig)' });
      return;
    }

    const { allowedPaths, editablePaths } = req.body || {};

    // Validate allowedPaths
    if (allowedPaths !== undefined) {
      if (!Array.isArray(allowedPaths) || !allowedPaths.every((p: unknown) => typeof p === 'string')) {
        res.status(400).json({ error: 'allowedPaths must be an array of strings' });
        return;
      }
      // Reject paths that try to escape project root
      for (const p of allowedPaths) {
        const normalized = path.normalize(p);
        if (normalized.startsWith('/') || normalized.includes('..')) {
          res.status(400).json({ error: `Invalid path: ${p} — must be relative without ..` });
          return;
        }
      }
    }

    // Validate editablePaths
    if (editablePaths !== undefined) {
      if (!Array.isArray(editablePaths) || !editablePaths.every((p: unknown) => typeof p === 'string')) {
        res.status(400).json({ error: 'editablePaths must be an array of strings' });
        return;
      }
      for (const p of editablePaths) {
        const normalized = path.normalize(p);
        if (normalized.startsWith('/') || normalized.includes('..')) {
          res.status(400).json({ error: `Invalid path: ${p} — must be relative without ..` });
          return;
        }
        // Never-editable enforcement
        if (isNeverEditable(normalized)) {
          res.status(400).json({ error: `Path ${p} is never editable for security reasons` });
          return;
        }
      }
    }

    // Apply updates
    if (allowedPaths !== undefined) {
      config.allowedPaths = allowedPaths;
      liveConfig.set('dashboard.fileViewer.allowedPaths', allowedPaths);
    }
    if (editablePaths !== undefined) {
      config.editablePaths = editablePaths;
      liveConfig.set('dashboard.fileViewer.editablePaths', editablePaths);
    }

    res.json({
      allowedPaths: config.allowedPaths,
      editablePaths: config.editablePaths,
      updated: true,
    });
  });

  // ── GET /api/files/download ──────────────────────────────────────

  router.get('/api/files/download', async (req: Request, res: Response) => {
    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    const validation = await validatePath(requestedPath, projectDir, config);
    if (!validation.valid) {
      res.status(validation.status || 403).json({ error: validation.error });
      return;
    }

    // Blocked filenames on the requested AND the resolved name (§5.2).
    const blocked = checkBlockedFilename(requestedPath, config) ?? checkBlockedFilename(validation.resolvedPath!, config);
    if (blocked) {
      res.status(403).json({ error: blocked });
      return;
    }

    const absPath = validation.resolvedPath!;

    try {
      const checkedStat = validation.resolvedStat!;
      if (checkedStat.isDirectory()) {
        res.status(400).json({ error: 'Cannot download a directory' });
        return;
      }

      if (checkedStat.size > config.maxFileSize) {
        res.status(413).json({ error: 'File too large', size: checkedStat.size, maxSize: config.maxFileSize });
        return;
      }

      // §5.2: open first, prove the descriptor is the checked inode, stream
      // FROM THAT DESCRIPTOR (never a by-path createReadStream).
      const opened = await openCheckedDescriptor(absPath, checkedStat, projectDir);
      if (!opened.handle) {
        res.status(403).json({ error: opened.reason });
        return;
      }
      const stat = opened.stat;

      const filename = path.basename(absPath);
      res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '\\"')}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);

      const stream = opened.handle.createReadStream({ autoClose: true });
      stream.pipe(res);
      stream.on('error', () => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream file' });
        }
      });
    } catch {
      res.status(500).json({ error: 'Failed to download file' });
    }
  });

  // ── GET /api/files/link ─────────────────────────────────────────
  // Phase 3: Generate a deep link URL for a file in the dashboard

  router.get('/api/files/link', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!filePath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    // §5.2: RESOLVE before minting — the full validatePath (lstat, realpath,
    // post-dereference root/allowed/never-served checks), not just the
    // pre-check on the requested spelling. A link to a symlink that
    // dereferences into key material is refused; a realpath failure refuses.
    const validation = await validatePath(filePath, projectDir, config);
    if (!validation.valid) {
      res.status(validation.status || 403).json({ error: validation.error });
      return;
    }
    const normalized = path.normalize(filePath);
    const blocked = checkBlockedFilename(normalized, config) ?? checkBlockedFilename(validation.resolvedPath!, config);
    if (blocked && !validation.resolvedStat!.isDirectory()) {
      res.status(403).json({ error: blocked });
      return;
    }

    const encodedPath = encodeURIComponent(normalized);
    const relativePath = `/dashboard?tab=files&path=${encodedPath}`;

    res.json({
      path: normalized,
      relative: relativePath,
      // Round-17 (security): same conjunction as the read route — a link must
      // not advertise an editor for a path whose save is fenced.
      editable:
        isEditable(normalized, config) &&
        !isNeverEditable(normalized) &&
        !(validation.relativeAfterResolve && isNeverEditable(validation.relativeAfterResolve)),
    });
  });

  return router;
}
