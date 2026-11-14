// safe-git-allow: open-PR overlap signal — READ-ONLY git only (remote get-url,
//   rev-parse --abbrev-ref HEAD), each an execFileSync ARGV ARRAY. Never a
//   destructive git verb.

/**
 * open-pr-overlap.mjs — "is another session's open PR changing the files I am
 * committing?" Run automatically by scripts/instar-dev-precommit.js on every
 * commit in the instar repo, so no session has to remember to ask.
 *
 * Why (Echo Bugs topic 10000002588, 2026-11-11): two Echo sessions on two
 * machines changed the same reply-delivery code for a day without knowing.
 * The only overlap check (`instar dev:claim-check`) runs when a session
 * remembers to run it; the M5 session never did. Open pull requests on GitHub
 * are the one list every machine already writes to, so comparing the staged
 * files against every other open PR makes cross-machine overlap visible at
 * the moment a session commits — with no new shared state.
 *
 * SIGNAL ONLY (docs/signal-vs-authority.md): a path match is brittle evidence
 * (two PRs can share a file without conflicting), so this never blocks a
 * commit. It prints a loud notice naming each overlapping PR; the session
 * decides what to do. Fail-open: gh missing, signed out, slow or malformed
 * output → one quiet line and the commit continues.
 *
 * Off-switch: INSTAR_PR_OVERLAP_CHECK=off. Skipped when CI is set, and in any
 * checkout whose origin is not the instar repo (test sandboxes, forks).
 */

import { execFileSync } from 'node:child_process';

export const DEFAULT_REPO = 'JKHeadley/instar';
export const OPEN_PR_LIMIT = 300;
export const GH_TIMEOUT_MS = 8_000;
/** Most files a notice lists per PR before summarising. */
export const MAX_FILES_SHOWN = 6;


/**
 * Files nearly every PR touches for bookkeeping. A match on these says nothing
 * about two sessions doing the same work, so they never count as overlap.
 */
export function isBookkeepingPath(file) {
  if (file === 'package.json' || file === 'package-lock.json' || file === 'pnpm-lock.yaml') return true;
  if (file === 'CHANGELOG.md') return true;
  if (file.startsWith('upgrades/')) return true;
  if (file.startsWith('.instar/')) return true;
  return false;
}

/** Open PRs untouched for longer than this are not active efforts. */
export const ACTIVE_DAYS = 14;
/**
 * A file changed by at least this many ACTIVE open PRs (counted across all of
 * them, not only the ones that overlap this commit) is a wiring hub
 * (server.ts, routes, the CLAUDE.md template): sharing it says little about
 * two sessions doing the same work, so hub-only matches get one summary line
 * instead of a full listing. Never silent: hub-only matches still print.
 */
export const HUB_PR_COUNT = 6;
/** Most PRs a notice lists in full. */
export const MAX_PRS_SHOWN = 8;

/**
 * Pure: which active open PRs (other than the one for `ownBranch`) change any
 * of `stagedFiles`? Exact path match; bookkeeping paths ignored.
 *
 * Returns `overlaps` (PRs sharing at least one non-hub file, most shared
 * first) and `hubOnly` (PRs sharing only hub files, with the hub files).
 *
 * @param {string[]} stagedFiles
 * @param {Array<{number:number,title?:string,headRefName?:string,updatedAt?:string,files?:Array<{path:string}>}>} prs
 * @param {string|null} ownBranch
 * @param {{now?:number, activeDays?:number, hubPrCount?:number}} [opts]
 */
export function findOpenPrOverlaps(stagedFiles, prs, ownBranch, opts = {}) {
  const now = opts.now ?? Date.now();
  const activeDays = opts.activeDays ?? ACTIVE_DAYS;
  const hubPrCount = opts.hubPrCount ?? HUB_PR_COUNT;
  const norm = (p) => String(p).replace(/\\/g, '/');
  const mine = new Set(stagedFiles.map(norm).filter((f) => f && !isBookkeepingPath(f)));
  const empty = { overlaps: [], hubOnly: [], hubFiles: [] };
  if (mine.size === 0) return empty;

  const cutoff = now - activeDays * 24 * 60 * 60 * 1000;
  const active = [];
  const allActive = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (!pr || typeof pr.number !== 'number') continue;
    const t = Date.parse(pr.updatedAt ?? '');
    if (Number.isFinite(t) && t < cutoff) continue; // stale: not an active effort
    const prFiles = [...new Set((Array.isArray(pr.files) ? pr.files : []).map((f) => norm(f && f.path)))];
    allActive.push(prFiles);
    if (ownBranch && pr.headRefName === ownBranch) continue;
    const shared = prFiles.filter((f) => mine.has(f)).sort();
    if (shared.length > 0) active.push({ pr, shared });
  }

  // Hub = a file many active PRs change, counted over ALL active PRs (allActive),
  // so several sessions colliding on one ordinary file is never mistaken for a hub
  // just because they all overlap this commit.
  const perFile = new Map();
  for (const files of allActive) for (const f of files) if (mine.has(f)) perFile.set(f, (perFile.get(f) ?? 0) + 1);
  const hubs = new Set([...perFile].filter(([, n]) => n >= hubPrCount).map(([f]) => f));

  const overlaps = [];
  const hubOnly = [];
  for (const { pr, shared } of active) {
    const row = {
      number: pr.number,
      title: String(pr.title ?? ''),
      branch: String(pr.headRefName ?? '?'),
      updatedAt: String(pr.updatedAt ?? '?'),
      files: shared.filter((f) => !hubs.has(f)),
      hubFiles: shared.filter((f) => hubs.has(f)),
    };
    (row.files.length > 0 ? overlaps : hubOnly).push(row);
  }
  overlaps.sort((a, b) => b.files.length - a.files.length || b.number - a.number);
  hubOnly.sort((a, b) => b.number - a.number);
  return { overlaps, hubOnly, hubFiles: [...hubs].sort() };
}

/** Pure: the notice text for a findOpenPrOverlaps result (empty when no overlap). */
export function formatOverlapNotice(result) {
  const { overlaps, hubOnly, hubFiles } = result;
  const hubList = `${hubFiles.slice(0, 3).join(', ')}${hubFiles.length > 3 ? ', …' : ''}`;
  if (overlaps.length === 0) {
    if (hubOnly.length === 0) return '';
    return `[instar-dev-precommit] open-PR overlap: ${hubOnly.length} other active PR(s) also change busy wiring file(s) you are committing (${hubList}): ${hubOnly.slice(0, 10).map((o) => `#${o.number}`).join(' ')}${hubOnly.length > 10 ? ' …' : ''}.`;
  }
  const lines = [
    '',
    '┌─ OPEN PR OVERLAP ─────────────────────────────────────────────────┐',
    `  ${overlaps.length} other active open PR(s) change files you are committing.`,
    '  Another session, possibly on another machine, may be doing the',
    '  same work. Not blocked — but before building further:',
    '    1. read each PR below (gh pr view <n>);',
    '    2. if it overlaps your work, agree an order with that session',
    '       (its PR names the topic), or say in your PR why it does not.',
  ];
  for (const o of overlaps.slice(0, MAX_PRS_SHOWN)) {
    lines.push('');
    lines.push(`  #${o.number} ${o.title}`.slice(0, 110));
    lines.push(`     branch ${o.branch}, updated ${o.updatedAt}`);
    for (const f of o.files.slice(0, MAX_FILES_SHOWN)) lines.push(`     ↳ ${f}`);
    if (o.files.length > MAX_FILES_SHOWN) lines.push(`     ↳ …and ${o.files.length - MAX_FILES_SHOWN} more`);
  }
  if (overlaps.length > MAX_PRS_SHOWN) {
    lines.push('');
    lines.push(`  …and ${overlaps.length - MAX_PRS_SHOWN} more PR(s) (instar dev:claim-check <files> lists them all).`);
  }
  if (hubOnly.length > 0) {
    lines.push('');
    lines.push(`  ${hubOnly.length} more share only busy wiring files (${hubList}): not listed.`);
  }
  lines.push('');
  lines.push('  (signal only — off-switch: INSTAR_PR_OVERLAP_CHECK=off)');
  lines.push('└───────────────────────────────────────────────────────────────────┘');
  lines.push('');
  return lines.join('\n');
}

/** Default `gh` reader — throws on any failure (the caller fails open). */
function defaultListOpenPrs(repo, cwd) {
  const raw = execFileSync(
    'gh',
    ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(OPEN_PR_LIMIT),
      '--json', 'number,title,headRefName,updatedAt,files'],
    { cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
  if (raw === '') throw new Error('gh returned no output');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('gh returned no PR list');
  return parsed;
}

/** Is `cwd` a clone of `repo` (origin remote)? Test sandboxes and forks are not. */
function defaultIsRepoClone(repo, cwd) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd, encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return url.replace(/\.git$/, '').toLowerCase().endsWith(repo.toLowerCase());
  } catch {
    return false;
  }
}

function defaultCurrentBranch(cwd) {
  try {
    const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}

/**
 * Run the check and write any notice. Never throws; returns what it found so
 * callers and tests can inspect it.
 *
 * @returns {{status:'skipped'|'degraded'|'clear'|'hub-only'|'overlap', overlaps:Array<object>, reason?:string}}
 */
export function checkOpenPrOverlap({
  stagedFiles,
  cwd = process.cwd(),
  env = process.env,
  repo = DEFAULT_REPO,
  listOpenPrs = defaultListOpenPrs,
  currentBranch = defaultCurrentBranch,
  isRepoClone = defaultIsRepoClone,
  write = (t) => process.stderr.write(`${t}\n`),
} = {}) {
  try {
    const mode = String(env.INSTAR_PR_OVERLAP_CHECK ?? '').toLowerCase();
    if (mode === 'off' || mode === '0' || mode === 'false') return { status: 'skipped', overlaps: [], reason: 'off' };
    if (env.CI) return { status: 'skipped', overlaps: [], reason: 'ci' };
    const files = (stagedFiles ?? []).filter((f) => f && !isBookkeepingPath(f));
    if (files.length === 0) return { status: 'skipped', overlaps: [], reason: 'no-files' };
    if (!isRepoClone(repo, cwd)) return { status: 'skipped', overlaps: [], reason: 'not-repo-clone' };

    let prs;
    try {
      prs = listOpenPrs(repo, cwd);
    } catch (err) {
      const msg = (err && err.message ? err.message : String(err)).split('\n')[0].slice(0, 160);
      write(`[instar-dev-precommit] open-PR overlap check could not run (${msg}) — overlap with other sessions' PRs is UNKNOWN for this commit.`);
      return { status: 'degraded', overlaps: [], reason: msg };
    }
    const result = findOpenPrOverlaps(files, prs, currentBranch(cwd));
    const notice = formatOverlapNotice(result);
    if (notice) write(notice);
    if (result.overlaps.length === 0) return { status: result.hubOnly.length ? 'hub-only' : 'clear', overlaps: [], hubOnly: result.hubOnly };
    return { status: 'overlap', overlaps: result.overlaps, hubOnly: result.hubOnly };
  } catch (err) {
    // Fail-open: a bug here must never break a commit.
    return { status: 'degraded', overlaps: [], reason: err && err.message ? err.message : String(err) };
  }
}
