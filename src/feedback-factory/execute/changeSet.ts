/**
 * The session's only output, read as plain bytes (docs/specs/feedback-triage-and-execution.md
 * §4 step 8, "Change set", "Diff gate", "Secret gate", `spec-drafted`).
 *
 * Trusted code walks the session workspace with lstat and never follows a link; it runs no git
 * and no tool there. Any symlink, device or other special file that is not byte-identical to
 * the publish clone fails the attempt (`special-file`). The change set is compared against the
 * publish clone (a tree the session can neither read nor write) and capped at 200 files / 2 MB.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scrubForStore } from '../../core/durableSecretScrub.js';
import { CHANGESET_MAX_BYTES, CHANGESET_MAX_FILES, EVIDENCE_FILE, RESULT_FILE, isToolingPath } from './executePolicy.js';

export interface ChangeEntry {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  /** File bytes for added/modified; absent for deleted. */
  bytes?: Buffer;
  executable?: boolean;
}

export interface ChangeSet {
  entries: ChangeEntry[];
  totalBytes: number;
}

export class ChangeSetError extends Error {
  constructor(readonly reason: 'special-file' | 'changeset-too-large' | 'sandbox-breach' | 'unreadable', detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'ChangeSetError';
  }
}

/** Root entries never part of a change set. `.claude/` is removed before spawn and write-denied. */
const ROOT_SKIP = new Set(['.git', 'node_modules', EVIDENCE_FILE, RESULT_FILE]);
/** Build and cache output the session's own runs may leave behind (never published). */
const OUTPUT_SKIP = [/^dist\//, /^coverage\//, /(^|\/)\.vitest\//, /(^|\/)\.DS_Store$/, /\.tsbuildinfo$/, /(^|\/)\.eslintcache$/, /\.log$/];

/**
 * A name git would treat as `.git` on a case-insensitive or Unicode-normalising filesystem
 * (HFS+/APFS default, NTFS): case-folded, with the code points HFS ignores removed.
 */
export function isGitDirName(name: string): boolean {
  return name.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g, '').toLowerCase().replace(/[. ]+$/, '') === '.git';
}

interface Walked { kind: 'file' | 'link'; mode: number; size: number; linkTarget?: string }

function walk(root: string, opts: { skipClaude: boolean }): Map<string, Walked> {
  const out = new Map<string, Walked>();
  const visit = (relDir: string) => {
    let names: string[];
    try { names = fs.readdirSync(path.join(root, relDir)); } catch (error) {
      throw new ChangeSetError('unreadable', `${relDir || '.'}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    for (const name of names.sort()) {
      const rel = relDir ? `${relDir}/${name}` : name;
      if (!relDir && ROOT_SKIP.has(name)) continue;
      if (!relDir && name === '.claude' && opts.skipClaude) continue;
      if (isGitDirName(name)) throw new ChangeSetError('special-file', `${rel} (nested git directory)`);
      const full = path.join(root, rel);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) { out.set(rel, { kind: 'link', mode: st.mode, size: 0, linkTarget: fs.readlinkSync(full) }); continue; }
      if (st.isDirectory()) { visit(rel); continue; }
      if (!st.isFile()) throw new ChangeSetError('special-file', rel);
      // A hard link shares its bytes with a file elsewhere (possibly one the sandbox denies
      // reading): never publish one, whatever its name.
      if (st.nlink > 1) throw new ChangeSetError('special-file', `${rel} (hard link)`);
      out.set(rel, { kind: 'file', mode: st.mode, size: st.size });
    }
  };
  visit('');
  return out;
}

/** Read a regular file without following a link swapped in after the walk. */
function readNoFollow(full: string): Buffer {
  const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new ChangeSetError('special-file', path.basename(full));
    if (st.nlink > 1) throw new ChangeSetError('special-file', `${path.basename(full)} (hard link)`);
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

/**
 * Build the change set: workspace bytes vs the publish clone. Throws ChangeSetError for a
 * special file, an over-cap set, or a `.claude/` entry in the workspace (it was removed before
 * spawn and writes there are denied, so its presence means the confinement did not hold).
 */
export function buildChangeSet(workspace: string, publishClone: string): ChangeSet {
  if (fs.existsSync(path.join(workspace, '.claude'))) throw new ChangeSetError('sandbox-breach', '.claude/ reappeared in the session workspace');
  const ws = walk(workspace, { skipClaude: true });
  const base = walk(publishClone, { skipClaude: true });
  const entries: ChangeEntry[] = [];
  let totalBytes = 0;
  const skipOutput = (rel: string) => OUTPUT_SKIP.some((re) => re.test(rel));
  for (const [rel, w] of ws) {
    const b = base.get(rel);
    if (w.kind === 'link') {
      if (b && b.kind === 'link' && b.linkTarget === w.linkTarget) continue;
      throw new ChangeSetError('special-file', `${rel} (symlink)`);
    }
    if (skipOutput(rel) && !b) continue;
    const bytes = readNoFollow(path.join(workspace, rel));
    const executable = (w.mode & 0o111) !== 0;
    if (b && b.kind === 'file') {
      const before = readNoFollow(path.join(publishClone, rel));
      if (before.equals(bytes) && ((b.mode & 0o111) !== 0) === executable) continue;
      entries.push({ path: rel, kind: 'modified', bytes, executable });
    } else {
      if (b && b.kind === 'link') throw new ChangeSetError('special-file', `${rel} (replaced a symlink)`);
      entries.push({ path: rel, kind: 'added', bytes, executable });
    }
    totalBytes += bytes.length;
    if (entries.length > CHANGESET_MAX_FILES || totalBytes > CHANGESET_MAX_BYTES) {
      throw new ChangeSetError('changeset-too-large', `more than ${CHANGESET_MAX_FILES} files or ${CHANGESET_MAX_BYTES} bytes`);
    }
  }
  for (const [rel, b] of base) {
    if (ws.has(rel)) continue;
    if (b.kind === 'link') throw new ChangeSetError('special-file', `${rel} (symlink removed)`);
    entries.push({ path: rel, kind: 'deleted' });
    if (entries.length > CHANGESET_MAX_FILES) throw new ChangeSetError('changeset-too-large', `more than ${CHANGESET_MAX_FILES} files`);
  }
  return { entries: entries.sort((a, b) => a.path.localeCompare(b.path)), totalBytes };
}

/** Diff gate: the tooling/protected paths a change set touches (empty → publishable). */
export function toolingPathsTouched(changeSet: ChangeSet): string[] {
  return changeSet.entries.filter((e) => isToolingPath(e.path)).map((e) => e.path);
}

const SCAN_CHUNK = 64 * 1024;
const SCAN_OVERLAP = 512;

/** True when the credential-exposure pattern set matches anywhere in `text` (chunked, overlapping). */
export function credentialShaped(text: string): boolean {
  for (let start = 0; start < Math.max(1, text.length); start += SCAN_CHUNK - SCAN_OVERLAP) {
    const chunk = text.slice(start, start + SCAN_CHUNK);
    const result = scrubForStore(chunk, { maxBytes: SCAN_CHUNK + 1 });
    // A scrub that fails cannot vouch for the text: treat it as a match (hold, never publish).
    if (result.error) return true;
    if ((result.redactions ?? []).some((r) => r.kind !== 'oversize' && r.kind !== 'scrub-error')) return true;
    if (start + SCAN_CHUNK >= text.length) break;
  }
  return false;
}

/**
 * Secret gate over every changed file, the result notes and the PR title and body. Returns the
 * matched FILE NAMES (and pseudo-names for notes/title/body) — never the matched text.
 */
export function secretGate(changeSet: ChangeSet, extra: { notes: string; prTitle: string; prBody: string }): string[] {
  const matched: string[] = [];
  for (const entry of changeSet.entries) {
    if (!entry.bytes) continue;
    if (credentialShaped(entry.bytes.toString('utf8')) || credentialShaped(entry.bytes.toString('latin1'))) matched.push(entry.path);
  }
  if (credentialShaped(extra.notes)) matched.push('(result notes)');
  if (credentialShaped(extra.prTitle)) matched.push('(pull request title)');
  if (credentialShaped(extra.prBody)) matched.push('(pull request body)');
  return matched;
}

/** Frontmatter keys a session-drafted spec may not carry (they belong to the trusted convergence path). */
const FORBIDDEN_SPEC_KEYS = /^(review-[\w-]*|approved[\w-]*|converged[\w-]*|cross-model-review|single-run-completable|frontloaded-decisions|contested-then-cleared|cheap-to-change-tags)\s*:/m;

/** `spec-drafted` shape: exactly one new file docs/specs/feedback-<initiative-id>.md, no approval/convergence tags. */
export function checkSpecDraft(changeSet: ChangeSet, expectedPath: string): { ok: true } | { ok: false; reason: string } {
  if (changeSet.entries.length !== 1) return { ok: false, reason: `expected exactly one new file, found ${changeSet.entries.length} changes` };
  const [entry] = changeSet.entries;
  if (entry.kind !== 'added' || entry.path !== expectedPath) return { ok: false, reason: `the only change must be a new ${expectedPath}` };
  const text = entry.bytes?.toString('utf8') ?? '';
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fm && FORBIDDEN_SPEC_KEYS.test(fm[1])) return { ok: false, reason: 'the draft carries approval or convergence tags' };
  return { ok: true };
}

/** The changed files the base-check clone receives: test files and test-support helpers under tests/. */
export function testEntries(changeSet: ChangeSet): ChangeEntry[] {
  return changeSet.entries.filter((e) => e.kind !== 'deleted' && e.path.startsWith('tests/'));
}

/** Source files (non-test) the change set adds or modifies — a missing export/module there is an allowed base failure. */
export function sourcePaths(changeSet: ChangeSet): string[] {
  return changeSet.entries.filter((e) => e.kind !== 'deleted' && !e.path.startsWith('tests/')).map((e) => e.path);
}

/**
 * Write a change set into a tree trusted code owns (the publish clone or the base-check clone).
 * Paths are re-validated (no absolute, no `..`, no `.git` segment) and never written through a
 * link: an existing entry at the target that is a symlink refuses.
 */
export function applyChangeSet(targetRoot: string, entries: ChangeEntry[], opts: { removeFile: (full: string) => void }): void {
  const root = path.resolve(targetRoot);
  for (const entry of entries) {
    const rel = entry.path;
    if (path.isAbsolute(rel) || rel.split('/').some((seg) => seg === '..' || isGitDirName(seg) || seg === '')) throw new ChangeSetError('special-file', `unsafe path ${rel}`);
    const full = path.resolve(root, rel);
    if (!full.startsWith(`${root}${path.sep}`)) throw new ChangeSetError('special-file', `path escapes ${rel}`);
    // Every existing ancestor must be a real directory, never a link.
    let cursor = path.dirname(full);
    while (cursor.startsWith(root) && cursor !== root) {
      try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new ChangeSetError('special-file', `link ancestor ${path.relative(root, cursor)}`); } catch (error) {
        if (error instanceof ChangeSetError) throw error;
        // @silent-fallback-ok: an ancestor that does not exist yet is created by mkdirSync below.
      }
      cursor = path.dirname(cursor);
    }
    let existing: fs.Stats | null = null;
    try { existing = fs.lstatSync(full); } catch { existing = null; } // @silent-fallback-ok: absent target is the normal add case
    if (existing && !existing.isFile()) throw new ChangeSetError('special-file', `${rel} target is not a regular file`);
    if (entry.kind === 'deleted') {
      if (existing) opts.removeFile(full);
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = `${full}.feedback-tmp-${process.pid}`;
    fs.writeFileSync(tmp, entry.bytes ?? Buffer.alloc(0), { mode: entry.executable ? 0o755 : 0o644, flag: 'wx' });
    fs.renameSync(tmp, full);
  }
}
