#!/usr/bin/env node
/**
 * release-cut-diff — recognise a RELEASE CUT diff (the "chore: release vX" commit
 * that publish.yml produces, or one cut by hand on a workstation) so the pre-push gate's
 * §3b release-fragment check can exempt it, and nothing else.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 * §3b refuses a push whose diff touches a release-relevant file without adding
 * an upgrades/next/<slug>.md fragment. Its comment said the release cut "never
 * trips this" — true while §3b looked only at src/. When release-relevance
 * moved to the shared predicate (scripts/release-relevant-paths.mjs), which
 * counts package.json and package-lock.json, EVERY release cut began tripping
 * it: a cut bumps both files and CONSUMES the fragments instead of adding one.
 * publish.yml never noticed because its commit step runs with HUSKY=0. A
 * release cut pushed from a workstation with hooks on is refused.
 *
 * ── The rule (exact) ──────────────────────────────────────────────────
 * The diff (merge-base → HEAD, with rename detection OFF so a fragment that
 * became the versioned guide shows as one D plus one A) is a release cut iff
 * EVERY entry is one of:
 *   - M package.json        — parsed as JSON on both sides; the ONLY difference
 *                             is the top-level "version" field, and it INCREASED
 *                             (numeric X.Y.Z compare; equal or lower is not a cut).
 *                             REQUIRED.
 *   - M package-lock.json   — parsed as JSON on both sides; the only differences
 *                             are the top-level "version" and packages[""].version,
 *                             each equal to the new package.json version.
 *                             Optional.
 *   - A upgrades/<X.Y.Z>.md — exactly one, where X.Y.Z is the new version.
 *                             REQUIRED.
 *   - D upgrades/next/<name>.md, D upgrades/NEXT.md — the consumed release
 *                             notes. Any number, including none.
 * Anything else — another file, another status, a dependency change, a second
 * guide, unparseable JSON, a git read that fails — and it is NOT a cut, so the
 * gate behaves exactly as it did before. Every uncertainty resolves toward
 * "not a cut", which is the strict direction.
 *
 * Pure `classifyReleaseCut` is exported for unit testing; `detectReleaseCut`
 * does the git I/O.
 */
import { execFileSync } from 'node:child_process';

const SEMVER = /^\d+\.\d+\.\d+$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Compare two X.Y.Z versions numerically: <0, 0 or >0. */
export function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** Structural deep equality for JSON values. */
export function jsonEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Classify a diff as a release cut or not.
 *
 * @param {{
 *   entries: Array<{ status: string, path: string }>,
 *   readBase: (p: string) => (string|null),
 *   readHead: (p: string) => (string|null),
 * }} input  entries from `git diff --name-status --no-renames`; readers return
 *           the file text at the merge-base / HEAD, or null when unreadable.
 * @returns {{ isCut: boolean, version: string|null, reason: string }}
 */
export function classifyReleaseCut({ entries, readBase, readHead }) {
  const no = (reason) => ({ isCut: false, version: null, reason });
  if (!Array.isArray(entries) || entries.length === 0) return no('empty diff');

  let pkgEntry = null;
  let lockEntry = null;
  const added = [];
  for (const e of entries) {
    const status = String(e && e.status || '');
    const p = String(e && e.path || '');
    if (p === 'package.json') {
      if (status !== 'M' || pkgEntry) return no(`package.json has status ${status}`);
      pkgEntry = e;
    } else if (p === 'package-lock.json') {
      if (status !== 'M' || lockEntry) return no(`package-lock.json has status ${status}`);
      lockEntry = e;
    } else if (status === 'A' && /^upgrades\/[^/]+\.md$/.test(p)) {
      added.push(p);
    } else if (status === 'D' && (/^upgrades\/next\/[^/]+\.md$/.test(p) || p === 'upgrades/NEXT.md')) {
      // consumed release notes — allowed
    } else {
      return no(`${status} ${p} is not part of a release cut`);
    }
  }
  if (!pkgEntry) return no('package.json is not modified');

  const pkgBase = parseJson(readBase('package.json'));
  const pkgHead = parseJson(readHead('package.json'));
  if (!pkgBase || !pkgHead) return no('package.json could not be parsed on both sides');
  const oldVersion = pkgBase.version;
  const newVersion = pkgHead.version;
  if (typeof newVersion !== 'string' || !SEMVER.test(newVersion)) return no(`new version ${JSON.stringify(newVersion)} is not X.Y.Z`);
  if (typeof oldVersion !== 'string' || !SEMVER.test(oldVersion)) return no(`old version ${JSON.stringify(oldVersion)} is not X.Y.Z`);
  if (compareSemver(newVersion, oldVersion) <= 0) return no(`version ${oldVersion} → ${newVersion} does not increase`);
  {
    const a = { ...pkgBase };
    const b = { ...pkgHead };
    delete a.version;
    delete b.version;
    if (!jsonEqual(a, b)) return no('package.json changes more than the "version" field');
  }

  if (lockEntry) {
    const lockBase = parseJson(readBase('package-lock.json'));
    const lockHead = parseJson(readHead('package-lock.json'));
    if (!lockBase || !lockHead) return no('package-lock.json could not be parsed on both sides');
    if (lockHead.version !== newVersion) return no('package-lock.json top-level version does not match package.json');
    const rootHead = isPlainObject(lockHead.packages) ? lockHead.packages[''] : undefined;
    const rootBase = isPlainObject(lockBase.packages) ? lockBase.packages[''] : undefined;
    if (rootHead !== undefined || rootBase !== undefined) {
      if (!isPlainObject(rootHead) || !isPlainObject(rootBase)) return no('package-lock.json root package entry changed shape');
      if (rootHead.version !== newVersion) return no('package-lock.json packages[""].version does not match package.json');
    }
    const strip = (lock) => {
      const c = { ...lock };
      delete c.version;
      if (isPlainObject(c.packages) && isPlainObject(c.packages[''])) {
        const root = { ...c.packages[''] };
        delete root.version;
        c.packages = { ...c.packages, '': root };
      }
      return c;
    };
    if (!jsonEqual(strip(lockBase), strip(lockHead))) return no('package-lock.json changes more than its version fields');
  }

  const expectedGuide = `upgrades/${newVersion}.md`;
  if (added.length !== 1 || added[0] !== expectedGuide) {
    return no(`expected exactly one added guide ${expectedGuide}, found ${added.length ? added.join(', ') : 'none'}`);
  }

  return { isCut: true, version: newVersion, reason: `release cut v${newVersion}` };
}

/**
 * Run git and classify the three-dot diff `baseRef...HEAD` in `cwd`.
 * Any git failure → not a cut.
 * @param {{ cwd: string, baseRef: string }} opts
 */
export function detectReleaseCut({ cwd, baseRef }) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  try {
    const mergeBase = git(['merge-base', baseRef, 'HEAD']).trim();
    const raw = git(['diff', '--name-status', '--no-renames', `${mergeBase}`, 'HEAD']);
    const entries = raw.split('\n').filter(Boolean).map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status.trim(), path: rest.join('\t').trim() };
    });
    const read = (rev) => (p) => {
      try { return git(['show', `${rev}:${p}`]); } catch { return null; }
    };
    return classifyReleaseCut({ entries, readBase: read(mergeBase), readHead: read('HEAD') });
  } catch (err) {
    return { isCut: false, version: null, reason: `git failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` };
  }
}

// ── CLI: `node scripts/release-cut-diff.mjs [baseRef]` prints the verdict ──
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const baseRef = process.argv[2] || 'origin/main';
  const verdict = detectReleaseCut({ cwd: process.cwd(), baseRef });
  process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
}
