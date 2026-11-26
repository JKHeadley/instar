/**
 * The pure parts of what a helper accepts (docs/specs/local-verify-borrowed-slices-count.md, C
 * items 2 and 5): GitHub's verdict on a head commit turned into a named refusal, and the
 * install-inputs comparison between the merge tree and `baseSha`.
 *
 * Every unknown value refuses (invariant, basis: irreversible-consequence: code that has run on a
 * personal machine cannot be un-run, and an install step runs with internet access).
 *
 * Pure: the caller reads the trees.
 */
import path from 'node:path';
import { installInputsHash, isInstallStepPath, type InstallInputFiles } from '../installInputs.js';
import type { HeadVerdict, TreeEntry } from './hostTree.js';
import type { HelperRefusal } from './helperProtocol.js';

/** The refusal for each way a head commit is not ours, or null when it is. */
export function headRefusal(v: HeadVerdict): HelperRefusal | null {
  switch (v) {
    case 'ours': return null;
    case 'fork': return 'head-fork';
    case 'closed': return 'head-pr-closed';
    case 'moved': return 'head-moved';
    case 'no-head-repo': return 'head-repo-missing';
    case 'not-listed': return 'head-not-ours';
    case 'rate-limited': return 'head-rate-limited';
    case 'unreachable': return 'head-unknown';
    default: return 'head-unknown';
  }
}

/** Whether a tree carries its own top-level `node_modules` (a file, a link or a folder): the helper's packages go there. */
export function treeHasNodeModules(entries: readonly TreeEntry[]): boolean {
  return entries.some((e) => e.path === 'node_modules' || e.path.startsWith('node_modules/'));
}

/** Read one tree's install inputs through `read` (which returns null for a file the tree lacks). */
export async function readInstallInputs(entries: readonly TreeEntry[], read: (file: string) => Promise<string | null>): Promise<InstallInputFiles> {
  const has = new Set(entries.map((e) => e.path));
  const get = async (f: string): Promise<string | null> => (has.has(f) ? read(f) : null);
  const stepFiles: Array<{ path: string; content: string }> = [];
  for (const e of entries) {
    if (!isInstallStepPath(e.path)) continue;
    const content = await read(e.path);
    // A listed file that cannot be read is hashed as a marker no real content equals, so the
    // comparison differs (refuse) unless the other side fails the same way on the same object.
    stepFiles.push({ path: e.path, content: content ?? `\u0000unreadable:${e.object}` });
  }
  return { packageJson: await get('package.json'), packageLock: await get('package-lock.json'), npmrc: await get('.npmrc'), stepFiles };
}

/**
 * The repository folder (or file) one declared local-path package points at, or null when it
 * cannot be named inside the repository (an absolute or home path, a path that leaves the
 * repository, a workspace pattern). Reads the strings `installInputsHash` returns in `localPaths`.
 */
export function localPackagePath(declared: string): string | null | 'none' {
  const parts = declared.split(' ');
  let spec: string | null = null;
  if (parts[0] === 'package-lock.json' && parts[1] === 'packages') spec = parts.slice(2).join(' ');
  // A link's target has its own `packages` entry in the lock; the link itself names no further folder.
  else if (parts[0] === 'package-lock.json' && parts[1] === 'link') return 'none';
  else if (parts[0] === 'package-lock.json' && parts[1] === 'resolved') spec = parts[parts.length - 1];
  else if (parts[0] === 'package.json' && parts[1] === 'workspaces') return null;
  else if (parts[0] === 'package.json' && parts.length >= 4) spec = parts[parts.length - 1];
  if (spec === null) return null;
  const m = /^(?:file:|link:|portal:)(.*)$/.exec(spec);
  let p = m ? m[1] : spec;
  if (p.startsWith('workspace:') || p.startsWith('/') || p.startsWith('~') || p.includes('\\')) return null;
  p = path.posix.normalize(p).replace(/\/+$/, '');
  if (p === '' || p === '.' || p === '..' || p.startsWith('../')) return null;
  return p;
}

const under = (entries: readonly TreeEntry[], p: string): string[] =>
  entries.filter((e) => e.path === p || e.path.startsWith(`${p}/`)).map((e) => `${e.mode} ${e.object} ${e.path}`).sort();

/**
 * Whether every linked or local-path package the install inputs declare is present at `baseSha`
 * and byte-for-byte the same in the merge tree. The install-inputs hash covers the declarations
 * only; this covers what they point at.
 */
export function localPackagesUnchanged(localPaths: readonly string[], baseEntries: readonly TreeEntry[], mergeEntries: readonly TreeEntry[]): boolean {
  for (const d of localPaths) {
    const p = localPackagePath(d);
    if (p === 'none') continue;
    if (p === null) return false;
    const b = under(baseEntries, p);
    const m = under(mergeEntries, p);
    if (b.length === 0 || b.length !== m.length || b.some((x, i) => x !== m[i])) return false;
  }
  return true;
}

export type InstallVerdict =
  | { ok: true; hash: string }
  /** `why` is for the audit row; the refusal is always `install-inputs-changed`. */
  | { ok: false; why: string };

/**
 * C item 5. The merge tree's install inputs must hash equal to `baseSha`'s: the change leaves the
 * install inputs as `main` has them. What the helper may once have installed plays no part, so a
 * change that restores an older package list is refused like any other difference. A file that
 * does not parse refuses; so does a linked or local-path package that is missing at `baseSha` or
 * differs in the merge tree.
 */
export function judgeInstallInputs(o: {
  base: InstallInputFiles; merged: InstallInputFiles;
  baseEntries: readonly TreeEntry[]; mergeEntries: readonly TreeEntry[];
  /** `headSha` equals `baseSha`: the merge tree IS the merged commit's tree. */
  sameCommit: boolean;
}): InstallVerdict {
  const base = installInputsHash(o.base);
  if (!base.ok) return { ok: false, why: `base:${base.refusal}` };
  if (o.sameCommit) return { ok: true, hash: base.hash };
  const merged = installInputsHash(o.merged);
  if (!merged.ok) return { ok: false, why: `merge-tree:${merged.refusal}` };
  if (merged.hash !== base.hash) return { ok: false, why: 'hash-differs' };
  const declaredAtBase = new Set(base.localPaths);
  if (merged.localPaths.some((d) => !declaredAtBase.has(d))) return { ok: false, why: 'local-package-not-at-base' };
  if (!localPackagesUnchanged(merged.localPaths, o.baseEntries, o.mergeEntries)) return { ok: false, why: 'local-package-changed' };
  return { ok: true, hash: base.hash };
}
