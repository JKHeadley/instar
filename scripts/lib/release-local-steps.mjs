/**
 * release-local-steps — the post-publish decisions of scripts/release-local.mjs,
 * extracted so they can be tested against real git repos.
 *
 * Every function takes a `run(cmd, args)` that returns { status, stdout, stderr }
 * (the caller decides whether output is echoed), so tests drive real git in a
 * scratch dir and the script drives it in the repo.
 */

import { classifyReleaseCut, compareSemver } from '../release-cut-diff.mjs';

/** The remotes whose `<remote>/main` pre-push-gate.js's pickRef may choose, in its order. */
export const GATE_BASE_REMOTES = ['JKHeadley', 'origin', 'upstream'];

/**
 * Refresh every `<remote>/main` ref the pre-push gate could diff against, so
 * the gate never compares the release commit to a stale base. Each ref is
 * fetched from ITS OWN remote (`git fetch JKHeadley main` for JKHeadley/main),
 * never from the release's --remote. A ref that does
 * not exist locally is skipped (pickRef will not pick it). A ref that exists
 * but cannot be fetched is a failure: pickRef would still pick it, stale.
 * @returns {{ ok: boolean, refreshed: string[], failed: Array<{ref: string, detail: string}> }}
 */
export function refreshGateBaseRefs(run) {
  const refreshed = [];
  const failed = [];
  for (const remote of GATE_BASE_REMOTES) {
    const ref = `${remote}/main`;
    if (run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`]).status !== 0) continue;
    const f = run('git', ['fetch', '--quiet', remote, 'main']);
    if (f.status === 0) refreshed.push(ref);
    else failed.push({ ref, detail: (f.stderr || f.stdout || '').trim().split('\n').pop() || `exit ${f.status}` });
  }
  return { ok: failed.length === 0, refreshed, failed };
}

/** The sha a remote's tag points at (peeled when annotated), or null. */
export function remoteTagSha(run, remote, tag) {
  const r = run('git', ['ls-remote', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  if (r.status !== 0) return null;
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
  const peeled = lines.find((l) => l[1] === `refs/tags/${tag}^{}`);
  const plain = lines.find((l) => l[1] === `refs/tags/${tag}`);
  return (peeled || plain || [null])[0];
}

/**
 * Does HEAD already contain `<remote>/main`? If so, a refused push was a
 * fast-forward that something refused (a hook, a permission, an existing tag);
 * if not, main has commits HEAD lacks. This replaces comparing the tracking
 * ref before vs after the push, which misreads a refusal whenever the tracking
 * ref was stale (or was refreshed just before the push).
 */
export function headContainsRemoteMain(run, remote) {
  return run('git', ['merge-base', '--is-ancestor', `refs/remotes/${remote}/main`, 'HEAD']).status === 0;
}

/**
 * Explain a `vX` that already exists on the remote on another commit. Two
 * publishers are possible: a publish.yml run, or an earlier
 * `--keep-tag-on-published` run of THIS tool (which leaves the tag on the
 * published commit while HEAD is the rebased release commit). Cheaply checks
 * whether the remote tag's commit is itself the release cut for vX and says so.
 */
export function describeExistingTag(run, remote, tag, version, remoteSha) {
  const ref = 'refs/release-local/remote-tag';
  let holdsCut = null;
  if (run('git', ['fetch', '--quiet', '--no-tags', remote, `+refs/tags/${tag}:${ref}`]).status === 0) {
    const subj = run('git', ['log', '-1', '--format=%s', ref]);
    holdsCut = subj.status === 0 && subj.stdout.trim() === `chore: release ${tag} [skip ci]` && isReleaseCutCommit(run, ref);
    run('git', ['update-ref', '-d', ref]);
  }
  const head = `${remote} already has tag ${tag} on a different commit (${remoteSha.slice(0, 10)}). Nothing was pushed (atomic).`;
  if (holdsCut === true) {
    return `${head} That commit IS the release cut for v${version}, so ${tag} was already pushed for this release, most likely by an ` +
      `earlier --keep-tag-on-published run of this tool (or by a publish.yml run). If it was this tool, re-run with ` +
      `--push-only --keep-tag-on-published: it sees the tag already on ${remote} and pushes main only.`;
  }
  const what = holdsCut === false ? ' That commit is NOT a release cut for this version.' : '';
  return `${head}${what} Another publisher released this version: most likely a publish.yml run, or an earlier ` +
    `--keep-tag-on-published run of this tool; if it was this tool, re-run with --push-only --keep-tag-on-published.`;
}

/**
 * Spacing of the npm re-queries after a failed publish. Unset or empty → the
 * 10s default. A value can only LOWER it (it is capped at the default), so the
 * override exists for tests that must not wait and cannot stretch a release.
 */
export function viewRetryDelayMs(envValue, def = 10_000) {
  if (envValue === undefined || envValue === null || String(envValue).trim() === '') return def;
  const n = Number(envValue);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, def);
}

function revParse(run, ref) {
  const r = run('git', ['rev-parse', '--verify', '--quiet', ref]);
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Is commit `sha` (vs its first parent) a release cut — only version fields,
 * one added versioned guide, deleted fragments? A merge, a root commit or any
 * read failure is NOT a cut.
 */
export function isReleaseCutCommit(run, sha) {
  const parents = run('git', ['rev-list', '--parents', '-n', '1', sha]);
  if (parents.status !== 0) return false;
  const ids = parents.stdout.trim().split(/\s+/);
  if (ids.length !== 2) return false; // root or merge
  const parent = ids[1];
  const d = run('git', ['diff', '--name-status', '--no-renames', parent, sha]);
  if (d.status !== 0) return false;
  const entries = d.stdout.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status: status.trim(), path: rest.join('\t').trim() };
  });
  const read = (rev) => (p) => {
    const r = run('git', ['show', `${rev}:${p}`]);
    return r.status === 0 ? r.stdout : null;
  };
  return classifyReleaseCut({ entries, readBase: read(parent), readHead: read(sha) }).isCut;
}

/**
 * The commits on `<remote>/main` that HEAD does not have, and whether every one
 * is a release cut. A release cut carries no code, so rebasing over it keeps
 * the published tree; anything else would put code npm never got under the tag.
 */
export function incomingCommits(run, remote) {
  const r = run('git', ['rev-list', '--reverse', `HEAD..refs/remotes/${remote}/main`]);
  if (r.status !== 0) return { ok: false, commits: [], nonCut: [] };
  const commits = r.stdout.split('\n').filter(Boolean);
  const nonCut = commits.filter((c) => !isReleaseCutCommit(run, c));
  return { ok: true, commits, nonCut };
}

/**
 * Push the release commit and its tag in ONE atomic push, with publish.yml's
 * rebase-retry loop — but only retry when the remote really moved. A refused
 * push whose remote main did not move was refused by a hook (or a permission),
 * and rebasing cannot fix that, so it fails at once with the push output.
 *
 * @param {{ run: Function, remote: string, version: string, maxAttempts?: number, log?: Function }} o
 * @returns {{ ok: boolean, attempts: number, reason?: string, output?: string }}
 */
export function pushReleaseAtomically({ run, remote, version, maxAttempts = 5, log = () => {} }) {
  const tag = `v${version}`;
  const tagHere = () => {
    run('git', ['tag', '-d', tag]); // absent on the first pass; harmless
    const t = run('git', ['tag', tag]);
    return t.status === 0;
  };
  if (!tagHere()) return { ok: false, attempts: 0, reason: `could not create tag ${tag}` };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Fetch first: --remote need not be one of the gate remotes refreshed in
    // preflight, so its tracking ref may be stale.
    run('git', ['fetch', '--quiet', remote, 'main']);
    const before = revParse(run, `refs/remotes/${remote}/main`);
    const p = run('git', ['push', '--atomic', remote, 'HEAD:main', tag]);
    if (p.status === 0) return { ok: true, attempts: attempt };
    const output = `${p.stdout || ''}${p.stderr || ''}`.trim();

    const f = run('git', ['fetch', '--quiet', remote, 'main']);
    if (f.status !== 0) {
      return { ok: false, attempts: attempt, reason: `push refused and ${remote} could not be fetched to tell why`, output };
    }
    const after = revParse(run, `refs/remotes/${remote}/main`);
    const fastForward = headContainsRemoteMain(run, remote);
    const remoteTag = remoteTagSha(run, remote, tag);
    if (remoteTag && remoteTag !== revParse(run, `refs/tags/${tag}^{commit}`)) {
      return {
        ok: false,
        attempts: attempt,
        code: 'tag-exists',
        reason: describeExistingTag(run, remote, tag, version, remoteTag),
        output,
      };
    }
    if (fastForward) {
      return {
        ok: false,
        attempts: attempt,
        reason: `push refused although it was a fast-forward (HEAD already contains ${remote}/main ${(after || 'none').slice(0, 10)}) — a hook or permission refused it; rebasing would not help`,
        output,
      };
    }
    // Main moved. Rebasing is only safe over commits that carry no code (other
    // release cuts): the tag must point at the tree npm actually got.
    const incoming = incomingCommits(run, remote);
    if (!incoming.ok || incoming.nonCut.length > 0) {
      return {
        ok: false,
        attempts: attempt,
        code: 'main-moved-with-code',
        reason: `${remote}/main moved by ${incoming.commits.length} commit(s), ${incoming.ok ? incoming.nonCut.length : 'unknown number'} of them not release cuts ` +
          `(${incoming.nonCut.slice(0, 5).map((c) => c.slice(0, 10)).join(', ')}). Rebasing would put v${version} on a tree with code npm never got, so this stops.`,
        output,
      };
    }
    log(`push rejected — ${remote}/main moved ${String(before).slice(0, 10)} → ${String(after).slice(0, 10)} by release cut(s) only; rebasing and retrying (attempt ${attempt})`);
    if (run('git', ['rebase', `${remote}/main`]).status !== 0) {
      run('git', ['rebase', '--abort']);
      return { ok: false, attempts: attempt, reason: 'the release commit could not be rebased cleanly onto main (conflict) — aborted rather than force-pushing', output };
    }
    if (!tagHere()) return { ok: false, attempts: attempt, reason: `could not move tag ${tag} onto the rebased commit` };
  }
  return { ok: false, attempts: maxAttempts, reason: `could not push the release commit after ${maxAttempts} rebase-retries` };
}

/** Synchronous sleep (the CLI is a synchronous sequence). */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function viewOnce(run, name, version, npmArgs) {
  // --prefer-online: never answer from npm's local cache, which right after a
  // failed publish can still hold "no such version".
  const r = run('npm', ['view', `${name}@${version}`, 'version', '--prefer-online', ...npmArgs]);
  const out = (r.stdout || '').trim();
  if (r.status === 0 && out === version) return 'published';
  // Absent: exit 0 with no output (some npm versions) or E404.
  if (r.status === 0 && out === '') return 'absent';
  if (r.status !== 0 && /E404|404 Not Found|is not in this registry/i.test(`${r.stderr || ''}${r.stdout || ''}`)) return 'absent';
  // Anything else (network, auth, a different version) is not evidence of absence.
  return 'unknown';
}

/**
 * After `npm publish` exits non-zero (or times out), decide whether the
 * version is on npm anyway. An "absent" answer straight after a publish can be
 * registry lag, so it is re-queried `retries` times `delayMs` apart (~30s by
 * default). If the publish TIMED OUT and npm still says absent, the answer is
 * 'unknown': a timed-out upload may still land, and calling it absent would
 * restore the tree and orphan the real version.
 * @returns {'published'|'absent'|'unknown'}
 */
export function publishedStateAfterFailure({ run, name, version, npmArgs = [], timedOut = false, retries = 3, delayMs = 10_000, sleep = sleepSync }) {
  let state = viewOnce(run, name, version, npmArgs);
  for (let i = 0; i < retries && state === 'absent'; i++) {
    sleep(delayMs);
    state = viewOnce(run, name, version, npmArgs);
  }
  if (state === 'absent' && timedOut) return 'unknown';
  return state;
}

/**
 * Is the WORKING TREE (vs HEAD) exactly a release cut? This is the state left
 * when a release fails after `npm publish` but before its commit (the smoke
 * test, or a pre-commit hook refusal). Tracked changes come from `git diff
 * --name-status --no-renames HEAD`, untracked files count as added, and the
 * head side is read from disk. The same #2222 rule decides.
 * @param {Function} run
 * @param {(p: string) => (string|null)} readWorktree
 */
export function workingTreeReleaseCut(run, readWorktree) {
  const d = run('git', ['diff', '--name-status', '--no-renames', 'HEAD']);
  const u = run('git', ['ls-files', '--others', '--exclude-standard']);
  if (d.status !== 0 || u.status !== 0) return { isCut: false, version: null, reason: 'git failed' };
  const entries = d.stdout.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status: status.trim(), path: rest.join('\t').trim() };
  });
  for (const f of u.stdout.split('\n').filter(Boolean)) entries.push({ status: 'A', path: f.trim() });
  const readBase = (f) => {
    const r = run('git', ['show', `HEAD:${f}`]);
    return r.status === 0 ? r.stdout : null;
  };
  return classifyReleaseCut({ entries, readBase, readHead: readWorktree });
}

/**
 * Resume path for a release whose main moved WITH code (or whenever the tag
 * must stay on the published commit): push the tag alone, pointing at the
 * commit npm was built from, then land the release commit on main, rebasing
 * over whatever moved main (the tag does NOT move). Hook refusals still stop
 * at once.
 * @returns {{ ok: boolean, attempts: number, reason?: string, output?: string }}
 */
export function pushTagThenMain({ run, remote, version, maxAttempts = 5, log = () => {} }) {
  const tag = `v${version}`;
  const head = revParse(run, 'HEAD');
  const tagged = revParse(run, `refs/tags/${tag}^{commit}`);
  if (!tagged) return { ok: false, attempts: 0, reason: `local tag ${tag} does not exist` };
  const remoteTag = remoteTagSha(run, remote, tag);
  if (remoteTag && remoteTag !== tagged) {
    return { ok: false, attempts: 0, code: 'tag-exists', reason: `${remote} already has tag ${tag} on a different commit (${remoteTag.slice(0, 10)}) — another publisher released this version` };
  }
  // Resumable: once the tag is on the remote (a previous keep-tag run pushed it
  // and then the MAIN push was refused after a rebase), HEAD has legitimately
  // moved off the tag. Only a FIRST run requires the tag to be on HEAD.
  if (!remoteTag) {
    if (tagged !== head) return { ok: false, attempts: 0, reason: `local tag ${tag} is not on HEAD — run this from the published release commit` };
    const t = run('git', ['push', remote, `refs/tags/${tag}`]);
    if (t.status !== 0) {
      return { ok: false, attempts: 0, reason: `could not push tag ${tag}`, output: `${t.stdout || ''}${t.stderr || ''}`.trim() };
    }
  } else {
    log(`${remote} already has ${tag} on the published commit ${tagged.slice(0, 10)} — resuming with the main push only`);
  }
  const recovery = (why) => {
    const now = String(revParse(run, 'HEAD'));
    return `${why}\n` +
      `  Tag ${tag} is on ${remote} at the published commit ${tagged.slice(0, 10)} and stays there.\n` +
      `  HEAD (${now.slice(0, 10)}) is the release commit${now === tagged ? '' : ', rebased onto main'}.\n` +
      `  Fix the cause, then re-run: node scripts/release-local.mjs --push-only --keep-tag-on-published --remote ${remote}\n` +
      `  (it sees ${tag} already on ${remote} and only pushes HEAD:main), or by hand: git push ${remote} HEAD:main`;
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    run('git', ['fetch', '--quiet', remote, 'main']);
    const before = revParse(run, `refs/remotes/${remote}/main`);
    const p = run('git', ['push', remote, 'HEAD:main']);
    if (p.status === 0) return { ok: true, attempts: attempt };
    const output = `${p.stdout || ''}${p.stderr || ''}`.trim();
    if (run('git', ['fetch', '--quiet', remote, 'main']).status !== 0) {
      return { ok: false, attempts: attempt, reason: recovery(`push refused and ${remote} could not be fetched to tell why`), output };
    }
    if (headContainsRemoteMain(run, remote)) {
      return { ok: false, attempts: attempt, reason: recovery(`push refused although it was a fast-forward (HEAD already contains ${remote}/main) — a hook or permission refused it`), output };
    }
    log(`main moved (${String(before).slice(0, 10)} → ${String(revParse(run, `refs/remotes/${remote}/main`)).slice(0, 10)}); rebasing the release commit (tag ${tag} stays on the published commit) (attempt ${attempt})`);
    if (run('git', ['-c', 'merge.renames=false', 'rebase', `${remote}/main`]).status !== 0) {
      run('git', ['rebase', '--abort']);
      return { ok: false, attempts: attempt, reason: recovery('the release commit could not be rebased cleanly onto main (conflict) — aborted rather than force-pushing'), output };
    }
  }
  return { ok: false, attempts: maxAttempts, reason: recovery(`could not push the release commit after ${maxAttempts} rebase-retries`) };
}

/**
 * Would `npm publish` need a one-time password? Decided BEFORE anything is
 * mutated. `profileJson` is the stdout of `npm profile get --json` (null when
 * that command failed — granular tokens often cannot read the profile).
 * @returns {'not-required'|'required'|'unknown'}
 */
export function otpRequirement(profileJson) {
  if (profileJson == null) return 'unknown';
  let p;
  try { p = JSON.parse(profileJson); } catch { return 'unknown'; }
  if (!p || typeof p !== 'object' || p.error) return 'unknown';
  if (!('tfa' in p)) return 'unknown';
  const tfa = p.tfa;
  if (!tfa || tfa.pending) return 'not-required';
  if (tfa.mode === 'auth-only') return 'not-required';
  if (tfa.mode === 'auth-and-writes') return 'required';
  return 'unknown';
}

/**
 * Parse one `gh run list --json databaseId,status,headSha` answer.
 * `listJson` is null when gh failed or is missing.
 * @returns {{ state: 'clear'|'active'|'unknown', ids: number[] }}
 */
export function ciRunState(listJson) {
  if (listJson == null) return { state: 'unknown', ids: [] };
  let runs;
  try { runs = JSON.parse(listJson); } catch { return { state: 'unknown', ids: [] }; }
  if (!Array.isArray(runs)) return { state: 'unknown', ids: [] };
  const active = runs.filter((r) => r && r.status !== 'completed');
  return active.length ? { state: 'active', ids: active.map((r) => r.databaseId) } : { state: 'clear', ids: [] };
}

/**
 * Every not-yet-finished state `gh run list --status` accepts (gh 2.64:
 * queued|in_progress|requested|waiting|action_required are the unfinished
 * ones; `pending` is NOT accepted and made every query fail — caught by the
 * first real dry run, which correctly read that failure as UNKNOWN).
 * `action_required` is a run waiting for approval, which can still publish.
 */
export const ACTIVE_RUN_STATUSES = ['queued', 'in_progress', 'waiting', 'requested', 'action_required'];

/**
 * Is ANY publish.yml run on the repo queued or in progress — for ANY commit?
 * publish.yml checks out `ref: main` (not its triggering sha) and waits in
 * `concurrency: publish` without cancelling, so a run queued for an EARLIER
 * merge publishes whatever main is when it gets a runner. That races a local
 * release on the same version. So no `--commit` filter. One query per active
 * status (so an old queued run is never pushed out of a recent-runs page); any
 * query that fails or is unreadable makes the whole answer unknown.
 * @returns {{ state: 'clear'|'active'|'unknown', ids: number[] }}
 */
export function activePublishRuns(run, slug) {
  if (!slug) return { state: 'unknown', ids: [] };
  const ids = [];
  for (const status of ACTIVE_RUN_STATUSES) {
    const r = run('gh', ['run', 'list', '-R', slug, '--workflow', 'publish.yml', '--status', status, '--limit', '100', '--json', 'databaseId,status,headSha']);
    const v = ciRunState(r.status === 0 ? r.stdout : null);
    if (v.state === 'unknown') return { state: 'unknown', ids: [] };
    ids.push(...v.ids);
  }
  return ids.length ? { state: 'active', ids: [...new Set(ids)] } : { state: 'clear', ids: [] };
}

/**
 * What the release does with a publish.yml-run verdict.
 *   clear → 'proceed'. active → 'stop' (a dry run only 'warn's).
 *   unknown → 'stop' unless --allow-unverified-ci ('proceed-unverified');
 *   a dry run 'warn's. Unknown is never treated as clear.
 * @param {{ state: 'clear'|'active'|'unknown', dryRun: boolean, allowUnverified: boolean }} o
 * @returns {'proceed'|'warn'|'stop'|'proceed-unverified'}
 */
export function ciGateAction({ state, dryRun, allowUnverified }) {
  if (state === 'clear') return 'proceed';
  if (dryRun) return 'warn';
  if (state === 'active') return 'stop';
  return allowUnverified ? 'proceed-unverified' : 'stop';
}

/**
 * The tool's own files — the only paths `--dry-run --allow-dirty-tool-files`
 * tolerates as uncommitted. Deliberately EXCLUDES package.json,
 * package-lock.json and upgrades/: the dry run edits and then restores those
 * from HEAD, which would silently discard an uncommitted edit there.
 */
export const TOOL_OWN_FILES = [
  'scripts/release-local.mjs',
  'scripts/lib/release-local-steps.mjs',
  'tests/unit/release-local-steps.test.ts',
  'tests/unit/release-local-parity.test.ts',
  'scripts/lint-no-direct-destructive.js',
  'CONTRIBUTING.md',
  'docs/specs/local-release.md',
  'docs/specs/local-release.eli16.md',
];

/**
 * Given `git status --porcelain` output, are the ONLY dirty paths the tool's own?
 * @returns {{ ok: boolean, paths: string[], others: string[] }}
 */
export function dirtyToolFilesOnly(porcelain) {
  // `XY <path>`; tolerate a caller that trimmed the output, which turns the
  // first line's ` M path` into `M path`.
  const paths = String(porcelain || '').split('\n').filter((l) => l.trim()).map((l) => {
    const m = /^[ MADRCUT?!]{2} (.+)$/.exec(l) || /^[MADRCUT?!] (.+)$/.exec(l);
    return (m ? m[1] : l).trim().replace(/^"|"$/g, '');
  });
  const flat = paths.flatMap((p) => (p.includes(' -> ') ? p.split(' -> ') : [p]));
  const others = flat.filter((p) => !TOOL_OWN_FILES.includes(p));
  return { ok: flat.length > 0 && others.length === 0, paths: flat, others };
}

/**
 * What to tell the maintainer when an accepted `npm publish` is not yet
 * visible. Seen on the first real local release (1.3.1360, 2026-10-20): npm
 * accepted the upload but held the version in "Validating" ("Automated review
 * hasn't finished. The version will remain unavailable until review
 * completes.") for 40+ minutes, visible only to the owner. That is PENDING,
 * never a failed publish, and never a reason to publish again.
 * @returns {string}
 */
export function npmPendingNotice(name, version, { pushOnly = false } = {}) {
  return [
    `npm has not shown ${name}@${version} yet. An accepted publish can sit in npm's "Validating" review`,
    `("Automated review hasn't finished") for well over the smoke window; the registry returns 404 until it ends.`,
    `Check as the package owner: https://www.npmjs.com/package/${name}?activeTab=versions`,
    // --push-only cannot tell "accepted, under review" from "never published"
    // (both read absent). The smoke path can: it only runs after npm accepted
    // the upload, so it needs no such caveat.
    ...(pushOnly
      ? [`If ${name}@${version} was never published (for example the publish step itself failed), --push-only cannot land it:`,
         `do not use --push-only; re-run release-local normally from a clean, up-to-date main.`]
      : []),
    // With the never-published caveat above, the last line needs its condition said out loud, or
    // "re-run release-local normally" and "Do NOT publish again" read as contradictory (Echo, #2228).
    `${pushOnly ? 'Otherwise (published, still in review): ' : ''}Do NOT publish again. Re-run later; --push-only lands it once \`npm view ${name}@${version} version\` shows it:`,
  ].join('\n');
}

/**
 * After the post-publish smoke test fails, decide what the failure means from
 * one registry read. Not visible (absent or unknown) → the version may be in
 * npm's review: PENDING. Visible → the smoke test itself failed on a real
 * tarball.
 * @param {'published'|'absent'|'unknown'} viewState
 * @returns {{ pending: boolean, message: string }}
 */
export function smokeFailureVerdict(viewState, name, version) {
  if (viewState === 'published') {
    return { pending: false, message: `the post-publish smoke test failed, and ${name}@${version} IS visible on npm — the published tarball itself failed the smoke test` };
  }
  return { pending: true, message: `the post-publish smoke test failed: ${name}@${version} is not visible on npm yet (${viewState}).\n${npmPendingNotice(name, version)}` };
}

/**
 * Is npm AHEAD of main? `latest` is `npm view <name> version`; `local` is
 * main's package.json version. npm ahead means a release was published and its
 * release commit never landed (1.3.1362, 2026-10-20: published by a session
 * that never ran --push-only; main stayed at 1.3.1361). Not a bump to make
 * silently: the version on npm has notes and consumed fragments that main
 * still lacks.
 */
export function npmAheadOfMain(latest, local) {
  const SEMVER = /^\d+\.\d+\.\d+$/;
  if (!SEMVER.test(String(latest)) || !SEMVER.test(String(local))) return false;
  return compareSemver(latest, local) > 0;
}

/** The refusal text for an unfinished release, naming both remedies. */
export function unfinishedReleaseMessage(name, latest, local, remote = 'origin') {
  return [
    `${name}@${latest} is on npm but main's package.json is ${local}: release v${latest} was published and its`,
    `release commit never landed on main. Finish it before cutting a new release, by either:`,
    `  1. running --push-only from the worktree that still holds the v${latest} cut:`,
    `       node scripts/release-local.mjs --push-only --remote ${remote}`,
    `  2. or, if that worktree is gone, rebuilding the cut from the published tarball and landing it:`,
    `       node scripts/release-local.mjs --reconcile ${latest} --remote ${remote}`,
    `     (upgrades/${latest}.md verbatim from the tarball; the fragments that existed at its gitHead deleted;`,
    `      package.json and package-lock.json bumped; committed with hooks on and pushed like --push-only).`,
  ].join('\n');
}

/** The release-note fragments present under upgrades/next/ at `commit`. */
export function consumedFragmentsAt(run, commit) {
  const r = run('git', ['ls-tree', '--name-only', `${commit}:upgrades/next`]);
  if (r.status !== 0) return { ok: false, paths: [] };
  return { ok: true, paths: r.stdout.split('\n').filter((f) => f.endsWith('.md')).map((f) => `upgrades/next/${f}`) };
}

/**
 * Set the version in package.json / package-lock.json text. The lock's root
 * package entry is bumped too. 2-space JSON plus a newline, which is how npm
 * writes both files (a round-trip of the current files is byte-identical).
 */
export function bumpVersionJson(text, version, { lock = false } = {}) {
  const o = JSON.parse(text);
  o.version = version;
  if (lock && o.packages && o.packages['']) o.packages[''].version = version;
  return JSON.stringify(o, null, 2) + '\n';
}

/**
 * Does a fragment's text appear in the released guide? assemble-next-md
 * replaces the H1 title and merges section bodies under one H2 each (keeping
 * every H2 title), so the check is: every line of the fragment that is not its
 * H1 title, an HTML comment or blank appears as a line of the guide. A fragment
 * that fails this was never released, so --reconcile must not delete it.
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function fragmentReleasedIn(fragmentText, guideText) {
  const guideLines = new Set(String(guideText).split('\n').map((l) => l.trim()));
  const content = String(fragmentText).split('\n').map((l) => l.trim())
    .filter((l) => l && !/^#\s/.test(l) && !/^<!--.*-->$/.test(l));
  const missing = content.filter((l) => !guideLines.has(l));
  return { ok: missing.length === 0, missing };
}

/**
 * The highest vX.Y.Z tag in `git ls-remote --tags <remote>` output, if it is
 * AHEAD of main's package.json version — a secondary unfinished-release
 * signal that does not depend on npm visibility. Returns the version or null.
 */
export function remoteTagAheadOf(lsRemoteOutput, local) {
  let best = null;
  for (const line of String(lsRemoteOutput || '').split('\n')) {
    const m = /refs\/tags\/v(\d+\.\d+\.\d+)(\^\{\})?$/.exec(line.trim());
    if (!m) continue;
    if (!best || compareSemver(m[1], best) > 0) best = m[1];
  }
  return best && /^\d+\.\d+\.\d+$/.test(String(local)) && compareSemver(best, local) > 0 ? best : null;
}

/** The refusal for a release left in flight on THIS clone (marker present). */
export function inflightRefusal(marker, remote = 'origin') {
  const v = marker && marker.version ? marker.version : '<unknown>';
  return [
    `A release of v${v} is in flight from this clone (started ${marker && marker.startedAt ? marker.startedAt : 'at an unknown time'}` +
      `${marker && marker.worktree ? ` in ${marker.worktree}` : ''}). It was about to publish, or published, and never landed.`,
    `npm may still be holding it in "Validating", so \`npm view\` can show the old latest. Finish it first:`,
    `  node scripts/release-local.mjs --push-only --remote ${remote}   (from ${marker && marker.worktree ? marker.worktree : 'the worktree that holds the cut'})`,
    `  or, once npm shows it and that worktree is gone: node scripts/release-local.mjs --reconcile ${v} --remote ${remote}`,
    `Both clear the marker when they land the release.`,
  ].join('\n');
}

/**
 * After a failure, may the in-flight marker be cleared? Only if THIS run wrote
 * it and nothing can have reached npm (publish confirmed absent, or never
 * attempted). Pending, unknown and published all keep it.
 */
export function shouldClearInflightOnFailure({ wroteMarker, published, publishUnknown, npmPending }) {
  return Boolean(wroteMarker) && !published && !publishUnknown && !npmPending;
}
