/**
 * The install-inputs hash (docs/specs/local-verify-borrowed-slices-count.md, C item 5).
 *
 * A helper installs packages only from merged code. A waiting change gets help only when it leaves
 * the files installation is declared to use exactly as `main` has them: the helper hashes those
 * files in the merge tree and at the verify's `baseSha`, and refuses (`install-inputs-changed`)
 * when the two hashes differ. The same hash is the key of the helper's cache of installed packages.
 *
 * The inputs:
 *  - `package.json` and `package-lock.json`, parsed, with the project's own version fields set to
 *    the empty string (INSTALL_VERSION_FIELDS: every release changes them and nothing else);
 *  - `.npmrc` (an absent file hashes as an empty one);
 *  - every file at or under INSTALL_STEP_PATHS: what `package.json`'s install steps run.
 *
 * RESIDUAL (the spec's): an install script that reads some other repository file is not covered.
 *
 * Pure: the caller reads the files; nothing here touches a disk, and nothing throws.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../core/appMediaTypes.js';

/** The `package.json` scripts npm runs during `npm ci` in the project itself. */
export const INSTALL_SCRIPT_NAMES = Object.freeze(['preinstall', 'install', 'postinstall', 'prepare'] as const);

/**
 * The repository paths the install steps run. An entry ending in `/` is a folder (every file under
 * it is an input); any other entry is one file.
 *
 *  - `scripts/fix-better-sqlite3.cjs`: the `postinstall` step.
 *  - `scripts/resolve-node-binary.cjs`: required by it.
 *  - `.husky/`: the `prepare` step (`husky`) installs the hooks in this folder.
 *
 * tests/unit/localVerify/installInputs.test.ts fails when `package.json` gains an install step
 * that names a path, or uses a command, this list and INSTALL_STEP_COMMANDS do not cover.
 */
export const INSTALL_STEP_PATHS: readonly string[] = Object.freeze([
  'scripts/fix-better-sqlite3.cjs',
  'scripts/resolve-node-binary.cjs',
  '.husky/',
]);

/**
 * The commands an install step may start with, and the repository paths each one reads without
 * naming them. A command that is not here is not understood, so the coverage check reports it.
 */
export const INSTALL_STEP_COMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  node: Object.freeze([] as string[]),
  husky: Object.freeze(['.husky/']),
});

/**
 * The JSON paths set to `""` before hashing, when present. Nothing else is changed.
 *  - `package.json`: `version`.
 *  - `package-lock.json`: `version` and `packages[""].version`.
 */
export const INSTALL_VERSION_FIELDS = Object.freeze({
  'package.json': Object.freeze([Object.freeze(['version'])]),
  'package-lock.json': Object.freeze([Object.freeze(['version']), Object.freeze(['packages', '', 'version'])]),
} as const);

/** First line of the hashed text; a change to the canonical form changes it. */
export const INSTALL_INPUTS_DOMAIN = 'instar-lv-install-inputs-v1';

const STEP_PATH_RE = /^[A-Za-z0-9._@+/-]+$/;

function cleanPath(p: string): string | null {
  const s = p.replace(/^\.\//, '');
  if (!s || s.startsWith('/') || !STEP_PATH_RE.test(s)) return null;
  if (s.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
  return s;
}

/** Whether a repository file path is one of the install-step inputs (a listed file, or under a listed folder). */
export function isInstallStepPath(file: string, list: readonly string[] = INSTALL_STEP_PATHS): boolean {
  const p = cleanPath(file);
  if (p === null) return false;
  return list.some((e) => (e.endsWith('/') ? p.startsWith(e) : p === e));
}

/** Whether an install step may name this path: a listed file, a listed folder, or a file under one. */
function stepArgCovered(arg: string, list: readonly string[]): boolean {
  const p = cleanPath(arg.replace(/\/+$/, ''));
  if (p === null) return false;
  return list.some((e) => (e.endsWith('/') ? p === e.slice(0, -1) || p.startsWith(e) : p === e));
}

const PATH_LIKE_RE = /\/|\.(?:[cm]?js|ts|sh|json)$/;

/**
 * What `package.json`'s install-time scripts use that the in-code lists do not cover. Empty means
 * covered. Each problem is `<script>: <what>`.
 *
 * It reads the script strings only: a step is a list of commands joined by `&&`, `||`, `;` or `|`;
 * each must start with a command in `commands` (after any `NAME=value` settings), and every
 * argument that looks like a repository path must be covered by `paths`. Shell it cannot read
 * (substitution, redirection, a background `&`) is reported, not guessed at.
 */
export function uncoveredInstallSteps(
  scripts: unknown,
  paths: readonly string[] = INSTALL_STEP_PATHS,
  commands: Readonly<Record<string, readonly string[]>> = INSTALL_STEP_COMMANDS,
): string[] {
  const out: string[] = [];
  if (scripts === undefined || scripts === null) return out;
  if (typeof scripts !== 'object' || Array.isArray(scripts)) return ['scripts: not an object'];
  const s = scripts as Record<string, unknown>;
  for (const name of INSTALL_SCRIPT_NAMES) {
    const text = s[name];
    if (text === undefined) continue;
    if (typeof text !== 'string') { out.push(`${name}: not a string`); continue; }
    if (/[`<>$()]/.test(text)) { out.push(`${name}: shell syntax the check cannot read`); continue; }
    for (const segment of text.split(/&&|\|\||;|\|/)) {
      if (segment.includes('&')) { out.push(`${name}: shell syntax the check cannot read`); continue; }
      const tokens = segment.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^(['"])(.*)\1$/, '$2'));
      while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
      if (tokens.length === 0) { out.push(`${name}: an empty command`); continue; }
      const cmd = tokens[0];
      if (!Object.prototype.hasOwnProperty.call(commands, cmd)) { out.push(`${name}: command ${cmd} is not in INSTALL_STEP_COMMANDS`); continue; }
      for (const implied of commands[cmd]) {
        if (!paths.includes(implied)) out.push(`${name}: ${cmd} reads ${implied}, which is not in INSTALL_STEP_PATHS`);
      }
      for (const arg of tokens.slice(1)) {
        if (arg.startsWith('-') || !PATH_LIKE_RE.test(arg)) continue;
        if (!stepArgCovered(arg, paths)) out.push(`${name}: path ${arg} is not in INSTALL_STEP_PATHS`);
      }
    }
  }
  return out;
}

/** The file contents the hash is taken over, as the caller read them from one tree. */
export interface InstallInputFiles {
  /** `package.json`'s text, or null when the tree has none. */
  packageJson: string | null;
  /** `package-lock.json`'s text, or null when the tree has none. */
  packageLock: string | null;
  /** `.npmrc`'s bytes, or null when the tree has none (hashes exactly as an empty file). */
  npmrc: string | Uint8Array | null;
  /** Every file of the tree at or under INSTALL_STEP_PATHS, in any order. A listed file the tree lacks is simply not here. */
  stepFiles: ReadonlyArray<{ path: string; content: string | Uint8Array }>;
}

export type InstallInputsRefusal =
  | 'package-json-missing' | 'package-json-malformed'
  | 'package-lock-missing' | 'package-lock-malformed'
  /** A step file outside INSTALL_STEP_PATHS, or with a path that is not a plain repository path. */
  | 'step-file-not-listed'
  | 'step-file-duplicate';

export type InstallInputsResult =
  | {
    ok: true;
    /** 64 lowercase hex characters. */
    hash: string;
    /**
     * Linked or local-path packages the two JSON files declare (sorted, unique). The hash covers
     * the declarations, not the contents of the folders they point at: a caller that finds any
     * must check those folders against the merged commit itself, or refuse.
     */
    localPaths: string[];
  }
  | { ok: false; refusal: InstallInputsRefusal };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObject = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

function parseObject(text: string): Record<string, Json> | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; } // @silent-fallback-ok: the caller turns null into a refusal value
  return isObject(v) ? v : null;
}

const LOCAL_SPEC_RE = /^(?:file:|link:|workspace:|portal:|\.{1,2}\/|\/|~\/)/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function localPathsOf(pkg: Record<string, Json>, lock: Record<string, Json>): string[] {
  const out = new Set<string>();
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!isObject(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) if (typeof spec === 'string' && LOCAL_SPEC_RE.test(spec)) out.add(`package.json ${field} ${name} ${spec}`);
  }
  const walkOverrides = (v: Json, where: string): void => {
    if (typeof v === 'string') { if (LOCAL_SPEC_RE.test(v)) out.add(`package.json overrides ${where} ${v}`); return; }
    if (isObject(v)) for (const [k, x] of Object.entries(v)) walkOverrides(x, where ? `${where}>${k}` : k);
  };
  if (pkg.overrides !== undefined) walkOverrides(pkg.overrides, '');
  if (pkg.workspaces !== undefined) out.add('package.json workspaces');
  const packages = lock.packages;
  if (isObject(packages)) {
    for (const [key, entry] of Object.entries(packages)) {
      if (key === '') continue;
      const e = isObject(entry) ? entry : {};
      // A key outside node_modules is a folder of the repository installed as a package.
      if (!/(?:^|\/)node_modules\//.test(key)) out.add(`package-lock.json packages ${key}`);
      else if (e.link === true) out.add(`package-lock.json link ${key}`);
      else if (typeof e.resolved === 'string' && LOCAL_SPEC_RE.test(e.resolved)) out.add(`package-lock.json resolved ${key} ${e.resolved}`);
    }
  }
  return [...out].sort();
}

const bytesOf = (v: string | Uint8Array): Uint8Array => (typeof v === 'string' ? Buffer.from(v, 'utf8') : v);

/**
 * The install-inputs hash of one tree, or a refusal value. Never throws.
 *
 * CANONICAL FORM. The hashed bytes are the line `instar-lv-install-inputs-v1\n`, then one frame per
 * input, in this order:
 *   1. `package.json`: parsed; `version` set to `""` when present; serialised with `canonicalJson`
 *      (object keys sorted by UTF-16 code unit at every depth, arrays in order, no whitespace), UTF-8.
 *   2. `package-lock.json`: parsed; `version` and `packages[""].version` set to `""` when present;
 *      serialised the same way.
 *   3. `.npmrc`: its bytes as they are; no bytes when the file is absent.
 *   4. each step file, sorted by path (UTF-16 code unit), labelled `step:<path>`, its bytes as they are.
 * A frame is `<label>\n<byte length in decimal>\n<bytes>\n`. The hash is SHA-256 in lowercase hex.
 *
 * Refusals: a missing or unparseable `package.json` / `package-lock.json`, one whose top level is
 * not an object, a lock whose `packages` or `packages[""]` is present and not an object, a step
 * file outside INSTALL_STEP_PATHS, or the same step path twice.
 */
export function installInputsHash(files: InstallInputFiles): InstallInputsResult {
  if (files.packageJson === null) return { ok: false, refusal: 'package-json-missing' };
  if (files.packageLock === null) return { ok: false, refusal: 'package-lock-missing' };
  const pkg = parseObject(files.packageJson);
  if (!pkg) return { ok: false, refusal: 'package-json-malformed' };
  const lock = parseObject(files.packageLock);
  if (!lock) return { ok: false, refusal: 'package-lock-malformed' };
  if (lock.packages !== undefined && !isObject(lock.packages)) return { ok: false, refusal: 'package-lock-malformed' };
  const packages = lock.packages as Record<string, Json> | undefined;
  if (packages && Object.prototype.hasOwnProperty.call(packages, '') && !isObject(packages[''])) return { ok: false, refusal: 'package-lock-malformed' };

  const steps = new Map<string, Uint8Array>();
  for (const f of files.stepFiles) {
    const p = typeof f.path === 'string' ? cleanPath(f.path) : null;
    if (p === null || !isInstallStepPath(p)) return { ok: false, refusal: 'step-file-not-listed' };
    if (steps.has(p)) return { ok: false, refusal: 'step-file-duplicate' };
    steps.set(p, bytesOf(f.content));
  }

  const localPaths = localPathsOf(pkg, lock);

  // Blank the version fields on shallow copies: the caller's parsed values are not ours to change.
  const pkgBlank: Record<string, Json> = { ...pkg };
  if (Object.prototype.hasOwnProperty.call(pkgBlank, 'version')) pkgBlank.version = '';
  const lockBlank: Record<string, Json> = { ...lock };
  if (Object.prototype.hasOwnProperty.call(lockBlank, 'version')) lockBlank.version = '';
  if (packages && isObject(packages[''])) {
    const root: Record<string, Json> = { ...(packages[''] as Record<string, Json>) };
    if (Object.prototype.hasOwnProperty.call(root, 'version')) root.version = '';
    lockBlank.packages = { ...packages, '': root };
  }

  const h = crypto.createHash('sha256');
  h.update(`${INSTALL_INPUTS_DOMAIN}\n`, 'utf8');
  const frame = (label: string, bytes: Uint8Array): void => {
    h.update(`${label}\n${bytes.length}\n`, 'utf8');
    h.update(bytes);
    h.update('\n', 'utf8');
  };
  frame('package.json', bytesOf(canonicalJson(pkgBlank)));
  frame('package-lock.json', bytesOf(canonicalJson(lockBlank)));
  frame('.npmrc', files.npmrc === null ? new Uint8Array(0) : bytesOf(files.npmrc));
  for (const p of [...steps.keys()].sort()) frame(`step:${p}`, steps.get(p)!);
  return { ok: true, hash: h.digest('hex'), localPaths };
}
