/**
 * Harness-changing and protected-path classification for local-verify (spec
 * local-verify-merge-authority.md §2 "Harness-changing PRs").
 *
 * Inputs are the name-only merge-base→head diff computed in the verifier's bare
 * clone (never GitHub's truncated file list) plus base/head text of
 * package.json and package-lock.json. Any read failure (a null input where the
 * file changed) classifies the PR as harness-changing: the safe direction.
 */

import { matchesAny, normalizePath } from './glob.js';

/** Globs whose change routes a PR to the operator. */
export const HARNESS_GLOBS: readonly string[] = Object.freeze([
  'scripts/local-verify.mjs',
  'scripts/safe-merge.mjs',
  // The merge authority's own server side: floor selection, verify queue and
  // orchestrator wrapper, completion path, index, status projection.
  'src/localVerify/**',
  // Watcher pre-filter and the merge machinery.
  'src/**/greenPrLogic.ts',
  'src/**/GreenPrAutoMerger.ts',
  'src/**/MergeRunner.ts',
  'src/**/greenPrAutomergeWiring.ts',
  // Test harness.
  'vitest*.config.ts',
  'tests/setup/**',
  'tests/vitest-setup.ts',
  '.npmrc',
  'patches/**',
  'tsconfig*.json',
  // Files a package.json lifecycle script runs today (more are derived from package.json below).
  'scripts/fix-better-sqlite3.cjs',
]);

/**
 * Packages whose version change in a manifest or lockfile is a test-toolchain change.
 * `typescript-native` is the alias the build and lint scripts run the TypeScript 7
 * compiler under; its per-platform binaries are the `@typescript/` scope.
 */
export const TOOLCHAIN_PACKAGES: readonly string[] = Object.freeze(['vitest', 'typescript', 'typescript-native', 'tsx']);
export const TOOLCHAIN_SCOPES: readonly string[] = Object.freeze(['@vitest/', '@typescript/']);

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare', 'prepublish'];

export function isToolchainPackage(name: string): boolean {
  return TOOLCHAIN_PACKAGES.includes(name) || TOOLCHAIN_SCOPES.some((s) => name.startsWith(s));
}

export interface TextPair {
  /** null = absent at that side OR unreadable; treated as a read failure when the file changed. */
  base: string | null;
  head: string | null;
}

export interface HarnessInput {
  /** Name-only diff, merge-base→head. null = the diff itself could not be read. */
  changedPaths: readonly string[] | null;
  packageJson?: TextPair;
  packageLock?: TextPair;
  /** Extra globs (e.g. the pinned required-context file, the protected-path list file). */
  extraGlobs?: readonly string[];
}

export interface HarnessVerdict {
  harnessChanging: boolean;
  reasons: string[];
}

function stable(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Repo-relative files referenced by a package.json's lifecycle scripts. */
export function lifecycleScriptFiles(pkg: Record<string, unknown> | null): string[] {
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== 'object') return [];
  const out = new Set<string>();
  for (const name of LIFECYCLE_SCRIPTS) {
    const cmd = (scripts as Record<string, unknown>)[name];
    if (typeof cmd !== 'string') continue;
    for (const m of cmd.matchAll(/(?:^|[\s"'=])((?:\.\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:c?m?js|ts|sh))\b/g)) {
      out.add(normalizePath(m[1]));
    }
  }
  return [...out];
}

function manifestToolchain(pkg: Record<string, unknown>): string {
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  const picked: Record<string, unknown> = {};
  for (const s of sections) {
    const deps = pkg[s];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, ver] of Object.entries(deps as Record<string, unknown>)) {
      if (isToolchainPackage(name)) picked[`${s}:${name}`] = ver;
    }
  }
  return stable(picked);
}

/** Toolchain signature of a lockfile (v1 `dependencies` and v2/v3 `packages`). */
function lockToolchain(lock: Record<string, unknown>): string {
  const picked: Record<string, unknown> = {};
  const pkgs = lock.packages;
  if (pkgs && typeof pkgs === 'object') {
    for (const [key, entry] of Object.entries(pkgs as Record<string, unknown>)) {
      if (key === '') {
        // Root manifest copy.
        if (entry && typeof entry === 'object') picked['root'] = manifestToolchain(entry as Record<string, unknown>);
        continue;
      }
      const idx = key.lastIndexOf('node_modules/');
      const name = idx >= 0 ? key.slice(idx + 'node_modules/'.length) : key;
      if (!isToolchainPackage(name)) continue;
      const e = (entry ?? {}) as Record<string, unknown>;
      picked[`p:${key}`] = stable({ version: e.version, resolved: e.resolved, integrity: e.integrity });
    }
  }
  const deps = lock.dependencies;
  if (deps && typeof deps === 'object') {
    const walk = (d: Record<string, unknown>, prefix: string) => {
      for (const [name, entry] of Object.entries(d)) {
        const e = (entry ?? {}) as Record<string, unknown>;
        if (isToolchainPackage(name)) {
          picked[`d:${prefix}${name}`] = stable({ version: e.version, resolved: e.resolved, integrity: e.integrity });
        }
        if (e.dependencies && typeof e.dependencies === 'object') {
          walk(e.dependencies as Record<string, unknown>, `${prefix}${name}>`);
        }
      }
    };
    walk(deps as Record<string, unknown>, '');
  }
  return stable(picked);
}

export function classifyHarness(input: HarnessInput): HarnessVerdict {
  const reasons: string[] = [];
  if (input.changedPaths == null) {
    return { harnessChanging: true, reasons: ['diff-unreadable'] };
  }
  const paths = input.changedPaths.map(normalizePath);
  const globs = [...HARNESS_GLOBS, ...(input.extraGlobs ?? [])];

  let basePkg: Record<string, unknown> | null = null;
  let headPkg: Record<string, unknown> | null = null;
  const pkgChanged = paths.includes('package.json');
  if (pkgChanged) {
    const pj = input.packageJson;
    basePkg = pj?.base != null ? parseJson(pj.base) : null;
    headPkg = pj?.head != null ? parseJson(pj.head) : null;
    if (!basePkg || !headPkg) {
      reasons.push('package.json:unreadable');
    } else {
      if (stable(basePkg.scripts) !== stable(headPkg.scripts)) reasons.push('package.json:scripts');
      if (stable(basePkg.overrides) !== stable(headPkg.overrides)) reasons.push('package.json:overrides');
      if (manifestToolchain(basePkg) !== manifestToolchain(headPkg)) reasons.push('package.json:toolchain');
    }
  } else if (input.packageJson?.head != null) {
    headPkg = parseJson(input.packageJson.head);
  }

  // Lifecycle-script files are derived from both revisions of package.json.
  const lifecycle = new Set([...lifecycleScriptFiles(basePkg), ...lifecycleScriptFiles(headPkg)]);

  for (const p of paths) {
    if (matchesAny(p, globs)) reasons.push(`path:${p}`);
    else if (lifecycle.has(p)) reasons.push(`lifecycle-script:${p}`);
  }

  if (paths.includes('package-lock.json')) {
    const pl = input.packageLock;
    const b = pl?.base != null ? parseJson(pl.base) : null;
    const h = pl?.head != null ? parseJson(pl.head) : null;
    if (!b || !h) reasons.push('package-lock.json:unreadable');
    else if (lockToolchain(b) !== lockToolchain(h)) reasons.push('package-lock.json:toolchain');
  }

  return { harnessChanging: reasons.length > 0, reasons };
}

/**
 * Protected-path check against the watcher's existing protected-path list
 * (passed in). Entries follow the existing `PROTECTED_PATH_PREFIXES`
 * semantics (exact match, or prefix — a trailing `/` names a directory);
 * an entry containing `*` or `?` is matched as a glob. A null diff is
 * unmeasurable and counts as protected.
 */
export function protectedPath(changedPaths: readonly string[] | null, protectedList: readonly string[]): boolean {
  if (changedPaths == null) return true;
  return protectedPathMatches(changedPaths, protectedList).length > 0;
}

/** The changed paths that match the protected list (the paths an independent review must cover). */
export function protectedPathMatches(changedPaths: readonly string[], protectedList: readonly string[]): string[] {
  return changedPaths.map(normalizePath).filter((f) =>
    protectedList.some((p) => (/[*?]/.test(p) ? matchesAny(f, [p]) : f === p || f.startsWith(p))),
  );
}

/**
 * The paths a harness verdict names: `path:X` and `lifecycle-script:X` give X,
 * a `package.json:` / `package-lock.json:` reason gives that file. null when a
 * reason names no path (`diff-unreadable`): the flagged set is then unknown.
 */
export function harnessReasonPaths(reasons: readonly string[]): string[] | null {
  const out = new Set<string>();
  for (const r of reasons) {
    const m = /^(?:path|lifecycle-script):(.+)$/.exec(r);
    if (m) { out.add(m[1]); continue; }
    if (r.startsWith('package.json:')) { out.add('package.json'); continue; }
    if (r.startsWith('package-lock.json:')) { out.add('package-lock.json'); continue; }
    return null;
  }
  return [...out];
}
