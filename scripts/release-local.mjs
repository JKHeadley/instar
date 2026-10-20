#!/usr/bin/env node
/**
 * release-local — run the publish job of .github/workflows/publish.yml on this
 * machine, in the same order, with the same scripts, failing closed at every
 * step.
 *
 * Why: GitHub's runners have been starved for days at a time, and a merged
 * change does not reach anyone until publish.yml gets a runner. Releasing from
 * a workstation is the default when CI is starved (Justin, 2026-10-20). This
 * script is that path as one command, so a local release is the same release
 * CI would have made rather than a hand-run approximation of it.
 *
 * Usage:
 *   npm run release:local -- [--dry-run] [--userconfig <path>] [--remote <name>]
 *   node scripts/release-local.mjs --dry-run
 *
 *   --dry-run          every step up to (not including) npm publish, the
 *                      commit and the push; reports the version it would
 *                      publish, then restores the tree.
 *   --userconfig PATH  npm config file holding the publish auth (passed to
 *                      npm as --userconfig). Without it npm uses your normal
 *                      config. This script never reads or prints a token.
 *   --remote NAME      git remote for main (default: origin).
 *
 * Steps, mirroring publish.yml's `publish` job one for one:
 *   0. preflight: clean tree, HEAD == <remote>/main after a fetch (a --dry-run
 *      only warns, so a branch can be rehearsed), HEAD is not
 *      a [skip ci] commit (the job's `if:`), npm auth works (real run only)
 *   1. npm ci (dev deps included)        2. npm run build
 *   3. assemble-next-md                  4. NEXT.md content check (skip rules)
 *      4b. on skip: release-skip-annotate (signal only), then stop
 *   5. resolve-release-tier (skip / error exactly as CI)
 *   6. resolve-publish-version + npm version
 *   7. rename NEXT.md, delete consumed upgrades/next/*.md
 *   8. check-upgrade-guide
 *   9. prepublishOnly's gates, run up front so --dry-run covers them:
 *      verify-codex-stage-b-release-evidence + check-contract-evidence
 *  10. npm publish --access public   (NOT --provenance: that needs CI's OIDC)
 *  11. post-publish-smoke
 *  12. commit "chore: release vX [skip ci]" WITH hooks, then push commit and
 *      tag vX in ONE `git push --atomic`, with publish.yml's rebase-retry loop
 *      (retried only when the remote main actually moved; a hook refusal fails
 *      at once). If npm publish exits non-zero, the registry is asked whether
 *      the version landed anyway before deciding which failure it was.
 *
 * Before publish, any failure restores package.json, package-lock.json and
 * upgrades/ to HEAD (the tree was required clean at the start, so only this
 * script's own edits are undone). After publish, nothing is undone: the
 * version is on npm and the release commit has to land.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  refreshGateBaseRefs,
  pushReleaseAtomically,
  pushTagThenMain,
  publishedStateAfterFailure,
  isReleaseCutCommit,
  workingTreeReleaseCut,
  viewRetryDelayMs,
  npmPendingNotice,
  smokeFailureVerdict,
  otpRequirement,
  activePublishRuns,
  dirtyToolFilesOnly,
  ciGateAction,
} from './lib/release-local-steps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+$/;
// prepublishOnly rebuilds before uploading; 20 min is far above a normal publish.
const PUBLISH_TIMEOUT_MS = 20 * 60 * 1000;
// Spacing of the npm re-queries after a failed publish (~30s over 3 retries).
// INSTAR_RELEASE_LOCAL_VIEW_DELAY_MS exists so tests need not wait: unset or
// empty means the default, and any value is capped at the default, so it can
// only shorten the wait. The number of re-queries is fixed.
const VIEW_RETRY_DELAY_MS = viewRetryDelayMs(process.env.INSTAR_RELEASE_LOCAL_VIEW_DELAY_MS);

// ── args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = {
  dryRun: false,
  userconfig: null,
  remote: 'origin',
  otpCommand: null,       // command that prints a fresh npm OTP, run right before publish
  tokenSkipsOtp: false,   // caller asserts the npm token publishes without an OTP
  allowUnverifiedCi: false, // proceed when gh cannot say whether publish.yml is running
  pushOnly: false,        // resume: push an already-published release commit
  allowDirtyToolFiles: false, // --dry-run only: tolerate uncommitted edits to this tool's own files
  keepTagOnPublished: false, // with --push-only: tag stays on the published commit, main is rebased
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--userconfig') opts.userconfig = argv[++i];
  else if (a.startsWith('--userconfig=')) opts.userconfig = a.slice('--userconfig='.length);
  else if (a === '--remote') opts.remote = argv[++i];
  else if (a.startsWith('--remote=')) opts.remote = a.slice('--remote='.length);
  else if (a === '--otp-command') opts.otpCommand = argv[++i];
  else if (a.startsWith('--otp-command=')) opts.otpCommand = a.slice('--otp-command='.length);
  else if (a === '--token-skips-otp') opts.tokenSkipsOtp = true;
  else if (a === '--allow-unverified-ci') opts.allowUnverifiedCi = true;
  else if (a === '--push-only') opts.pushOnly = true;
  else if (a === '--allow-dirty-tool-files') opts.allowDirtyToolFiles = true;
  else if (a === '--keep-tag-on-published') opts.keepTagOnPublished = true;
  else if (a === '--help' || a === '-h') {
    console.log('Usage: node scripts/release-local.mjs [--dry-run] [--userconfig <npmrc path>] [--remote <name>]\n' +
      '         [--otp-command "<cmd printing a fresh OTP>"] [--token-skips-otp] [--allow-unverified-ci]\n' +
      '       node scripts/release-local.mjs --push-only [--keep-tag-on-published] [--remote <name>] [--userconfig <path>]');
    process.exit(0);
  } else {
    console.error(`release-local: unknown argument ${a}`);
    process.exit(2);
  }
}
if (opts.userconfig !== null) {
  if (!opts.userconfig) { console.error('release-local: --userconfig needs a path'); process.exit(2); }
  opts.userconfig = path.resolve(opts.userconfig);
  if (!fs.existsSync(opts.userconfig)) { console.error(`release-local: --userconfig file not found: ${opts.userconfig}`); process.exit(2); }
}
if (!opts.remote) { console.error('release-local: --remote needs a name'); process.exit(2); }
if (opts.otpCommand !== null && !opts.otpCommand) { console.error('release-local: --otp-command needs a command'); process.exit(2); }
if (opts.keepTagOnPublished && !opts.pushOnly) { console.error('release-local: --keep-tag-on-published only applies with --push-only'); process.exit(2); }
if (opts.allowDirtyToolFiles && !opts.dryRun) { console.error('release-local: --allow-dirty-tool-files is for --dry-run only — a real release needs a clean tree'); process.exit(2); }
if (opts.pushOnly && opts.dryRun) { console.error('release-local: --push-only and --dry-run cannot be combined'); process.exit(2); }
const npmAuthArgs = opts.userconfig ? ['--userconfig', opts.userconfig] : [];

// ── helpers ───────────────────────────────────────────────────────────
let stepNo = 0;
let touchedTree = false; // set once this script edits tracked files
let published = false;
let committed = false; // the release commit exists (set after `git commit` succeeds)
let VERSION_FOR_MSG = null; // the version being released, for recovery messages
let npmPending = false; // published (or claimed published) but npm has not shown it yet — maybe in review
let publishUnknown = false; // npm publish failed and the registry could not confirm either way
let START_SHA = null; // origin/main when the release began (the merge being shipped)
let SLUG = null;      // owner/repo of the remote, for the gh run check
let CI_UNVERIFIED = false; // set when --allow-unverified-ci let a run proceed unchecked

function step(title) {
  stepNo += 1;
  console.log(`\n── [${stepNo}] ${title}`);
}

/** Run a command. stdio inherited unless capture; returns {status, stdout, stderr}. */
function run(cmd, args, { capture = false, env = process.env, quiet = false, noStdin = false, timeoutMs = undefined } = {}) {
  if (!quiet) console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    env,
    encoding: 'utf-8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : [noStdin ? 'ignore' : 'inherit', 'inherit', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
  });
  if (r.error) return { status: 1, stdout: '', stderr: String(r.error.message), timedOut: r.error.code === 'ETIMEDOUT' };
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function must(cmd, args, o = {}) {
  const r = run(cmd, args, o);
  if (r.status !== 0) fail(`\`${cmd} ${args.join(' ')}\` exited ${r.status}${r.stderr ? `: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
  return r;
}

/** run() with captured output and no echo — the shape release-local-steps expects. */
function quietRun(cmd, args) {
  return run(cmd, args, { capture: true, quiet: true });
}

function restoreTree() {
  if (!touchedTree) return;
  console.log('\nRestoring package.json, package-lock.json and upgrades/ to HEAD (this script\'s own edits only; the tree was clean at the start).');
  run('git', ['checkout', 'HEAD', '--', 'package.json', 'package-lock.json', 'upgrades'], { quiet: true });
  // Untracked files under upgrades/ can only be ours (NEXT.md, <version>.md):
  // the preflight refused to start with any untracked file present.
  run('git', ['clean', '-fq', '--', 'upgrades'], { quiet: true });
  touchedTree = false;
}

function fail(msg) {
  console.error(`\n✗ release-local FAILED: ${msg}`);
  if (npmPending) {
    console.error(`    node scripts/release-local.mjs --push-only --remote ${opts.remote}${opts.userconfig ? ` --userconfig ${opts.userconfig}` : ''}`);
    console.error('  Nothing was undone and nothing will be re-published.');
  } else if (publishUnknown) {
    console.error('  It is UNKNOWN whether this version reached npm. The tree was NOT restored.');
    console.error('  If `npm view` shows it, land the release commit by hand; if not, re-run.');
  } else if (published && !committed) {
    const v = VERSION_FOR_MSG || '<version>';
    console.error(`  The version IS on npm, but the release commit was NOT made. Nothing was undone: the`);
    console.error('  working tree still holds the release cut (package.json, package-lock.json, upgrades/).');
    console.error('  Fix the cause, then let --push-only commit the cut (hooks on) and push it — it never re-publishes:');
    console.error(`    node scripts/release-local.mjs --push-only --remote ${opts.remote}${opts.userconfig ? ` --userconfig ${opts.userconfig}` : ''}`);
    console.error('  Or by hand:');
    console.error(`    git add package.json package-lock.json upgrades/ && git commit -m "chore: release v${v} [skip ci]"`);
    console.error(`    node scripts/release-local.mjs --push-only --remote ${opts.remote}`);
  } else if (published) {
    console.error('  The version IS on npm. Nothing was undone. Keep the local release commit and tag.');
    console.error(`  Fix the cause, then resume the push only (no re-publish):`);
    console.error(`    node scripts/release-local.mjs --push-only --remote ${opts.remote}${opts.userconfig ? ` --userconfig ${opts.userconfig}` : ''}`);
    console.error('  If main moved with code since the release was cut, add --keep-tag-on-published: the tag is');
    console.error('  pushed on the published commit, and the release commit is rebased onto main without it.');
  } else {
    restoreTree();
    console.error('  Nothing was published.');
  }
  process.exit(1);
}

function stopCleanly(msg) {
  console.log(`\n■ ${msg}`);
  restoreTree();
  process.exit(0);
}

function readPkgVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
}

function repoSlug(remote) {
  const url = run('git', ['remote', 'get-url', remote], { capture: true, quiet: true }).stdout.trim();
  const m = /github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return { url, slug: m ? m[1] : null };
}

/**
 * Refuse while a publish.yml run for the merge being released is queued or in
 * progress (two publishers racing). If gh cannot answer, a real run stops
 * unless --allow-unverified-ci was given; a dry run only reports.
 */
function checkCiRuns(slug, when) {
  const verdict = activePublishRuns(quietRun, slug);
  const action = ciGateAction({ state: verdict.state, dryRun: opts.dryRun, allowUnverified: opts.allowUnverifiedCi });
  const cancel = `gh run cancel -R ${slug} <id>   (for each of: ${verdict.ids.join(', ')})`;
  const what = verdict.state === 'active'
    ? `publish.yml run(s) ${verdict.ids.join(', ')} are queued or in progress on ${slug}. publish.yml publishes whatever main is when it gets a runner (ref: main, concurrency: publish), so it would race this release. Cancel first:\n  ${cancel}`
    : `could not query publish.yml runs on ${slug || '(unknown repo)'} (gh missing, not authed, or unreadable). Not assuming none: fix gh (gh auth status) or pass --allow-unverified-ci`;
  if (action === 'proceed') { console.log(`publish.yml runs on ${slug}: none queued or in progress, for any commit (${when})`); return; }
  if (action === 'warn') { console.log(`WARNING (a real run would stop here): ${what}`); return; }
  if (action === 'proceed-unverified') { console.log(`WARNING: ${what.split('. Not assuming')[0]}; proceeding (--allow-unverified-ci).`); CI_UNVERIFIED = true; return; }
  fail(what);
}

// ── push-only resume ──────────────────────────────────────────────────
if (opts.pushOnly) {
  console.log('release-local --push-only (resume: push an already-published release commit; never publishes)');
  published = true; // by precondition below; makes every failure message say so
  step('Check the release commit and that its version is on npm');
  const dirty = must('git', ['status', '--porcelain', '--untracked-files=all'], { capture: true, quiet: true }).stdout.trim();
  if (dirty) {
    // A release that failed after `npm publish` but before its commit (smoke
    // test, pre-commit hook) leaves the release cut in the working tree. Commit
    // it here — only when the dirty paths are EXACTLY a release cut, HEAD is on
    // main's history, and that version is already on npm.
    const readWorktree = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf-8'); } catch { return null; } };
    const cut = workingTreeReleaseCut(quietRun, readWorktree);
    if (!cut.isCut) { published = false; fail(`the working tree is not clean and is not exactly a release cut (${cut.reason}):\n${dirty.split('\n').slice(0, 10).join('\n')}`); }
    must('git', ['fetch', '--quiet', opts.remote, 'main']);
    if (run('git', ['merge-base', '--is-ancestor', 'HEAD', `${opts.remote}/main`], { capture: true, quiet: true }).status !== 0) {
      published = false;
      fail(`HEAD is not on ${opts.remote}/main's history — refusing to commit a release cut on top of it`);
    }
    VERSION_FOR_MSG = cut.version;
    const st = publishedStateAfterFailure({ run: quietRun, name: 'instar', version: cut.version, npmArgs: npmAuthArgs, delayMs: VIEW_RETRY_DELAY_MS });
    if (st !== 'published') {
      published = false;
      // `unknown` (npm could not answer) is publishUnknown here, NOT pending —
      // deliberately different from the smoke path below. --push-only has no
      // evidence the upload was ever accepted, so it must not claim npm is
      // reviewing it. Both outcomes stop and neither re-publishes.
      if (st === 'unknown') publishUnknown = true;
      else npmPending = true;
      fail(`the working tree holds a release cut for ${cut.version}, but instar@${cut.version} is ${st === 'absent' ? 'NOT visible' : 'not confirmed'} on npm — --push-only never publishes and refuses until npm shows it.${st === 'absent' ? `\n${npmPendingNotice('instar', cut.version, { pushOnly: true })}` : ''}`);
    }
    console.log(`The working tree is exactly the release cut for v${cut.version}, which is on npm — committing it (hooks on).`);
    must('git', ['add', 'package.json', 'package-lock.json', 'upgrades/']);
    must('git', ['commit', '-m', `chore: release v${cut.version} [skip ci]`]);
    committed = true;
  } else {
    committed = true;
  }
  const subject = must('git', ['log', '-1', '--format=%s', 'HEAD'], { capture: true, quiet: true }).stdout.trim();
  const m = /^chore: release v(\d+\.\d+\.\d+) \[skip ci\]$/.exec(subject);
  if (!m) { published = false; fail(`HEAD is not a release commit ("${subject}")`); }
  const version = m[1];
  if (!isReleaseCutCommit(quietRun, 'HEAD')) { published = false; fail('HEAD is not purely a release cut (version fields, one guide, consumed fragments)'); }
  if (readPkgVersion() !== version) { published = false; fail(`package.json says ${readPkgVersion()}, the commit says ${version}`); }
  const state = publishedStateAfterFailure({ run: quietRun, name: 'instar', version, npmArgs: npmAuthArgs, delayMs: VIEW_RETRY_DELAY_MS });
  if (state !== 'published') {
    published = false;
    // As above: `unknown` is publishUnknown in --push-only (no evidence of an
    // accepted upload), pending only on the smoke path. Both stop safely.
    if (state === 'unknown') publishUnknown = true;
    else npmPending = true;
    fail(`instar@${version} is ${state === 'absent' ? 'NOT visible' : 'not confirmed'} on npm — --push-only only lands a version npm shows, and refuses until then.${state === 'absent' ? `\n${npmPendingNotice('instar', version, { pushOnly: true })}` : ''}`);
  }
  if (run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`], { capture: true, quiet: true }).status !== 0) {
    must('git', ['tag', `v${version}`]);
  }
  step('Refresh the pre-push gate base refs (each from its own remote)');
  const refs = refreshGateBaseRefs(quietRun);
  if (!refs.ok) fail(`cannot refresh ${refs.failed.map((f) => `${f.ref} (${f.detail})`).join(', ')}`);
  step(opts.keepTagOnPublished ? `Push tag v${version} (stays on the published commit), then the release commit to main` : `Push release commit + tag v${version} atomically`);
  const push = opts.keepTagOnPublished ? pushTagThenMain : pushReleaseAtomically;
  const res = push({ run: quietRun, remote: opts.remote, version, log: (x) => console.log(x) });
  if (!res.ok) fail(`${res.reason}${res.output ? `\n--- push output ---\n${res.output}` : ''}`);
  if (opts.keepTagOnPublished) {
    console.log(`\nNOTE: tag v${version} is on the published commit, which is NOT in main's history. Tools that read`);
    console.log('      reachable tags only (scripts/release-skip-annotate.mjs uses `git describe --tags --abbrev=0`)');
    console.log(`      will see the previous tag as the last release and report v${version}'s work as unreleased.`);
  }
  console.log(`\n══ LANDED release v${version} ══ (main ${run('git', ['rev-parse', 'HEAD'], { capture: true, quiet: true }).stdout.trim().slice(0, 10)}, tag v${version})`);
  process.exit(0);
}

// ── 0. preflight ──────────────────────────────────────────────────────
console.log(`release-local${opts.dryRun ? ' (DRY RUN — no publish, no commit, no push)' : ''}`);
console.log(`node ${process.version} (publish.yml uses node 20); repo ${ROOT}`);

step('Preflight: clean tree on an up-to-date main');
{
  const top = must('git', ['rev-parse', '--show-toplevel'], { capture: true, quiet: true }).stdout.trim();
  if (fs.realpathSync(top) !== fs.realpathSync(ROOT)) fail(`run this from the repo that contains it (git top-level is ${top})`);
  const dirty = must('git', ['status', '--porcelain', '--untracked-files=all'], { capture: true, quiet: true }).stdout.trim();
  if (dirty) {
    const check = dirtyToolFilesOnly(dirty);
    if (opts.allowDirtyToolFiles && check.ok) {
      console.log(`WARNING (--dry-run --allow-dirty-tool-files): tolerating uncommitted edits to this tool's own files: ${check.paths.join(', ')}`);
    } else {
      fail(`the working tree is not clean${opts.allowDirtyToolFiles ? ` (not just the tool's own files: ${check.others.join(', ')})` : ''}:\n${dirty.split('\n').slice(0, 10).join('\n')}`);
    }
  }
  must('git', ['fetch', '--quiet', opts.remote, 'main']);
  const head = must('git', ['rev-parse', 'HEAD'], { capture: true, quiet: true }).stdout.trim();
  const remoteMain = must('git', ['rev-parse', `${opts.remote}/main`], { capture: true, quiet: true }).stdout.trim();
  if (head !== remoteMain && opts.dryRun) {
    // A dry run publishes nothing, so it may rehearse a branch (e.g. a PR that
    // changes the release path). A real run may not.
    console.log(`WARNING: HEAD (${head.slice(0, 10)}) is not ${opts.remote}/main (${remoteMain.slice(0, 10)}). ` +
      'Allowed for --dry-run only; a real release refuses this.');
  } else if (head !== remoteMain) {
    fail(`HEAD (${head.slice(0, 10)}) is not ${opts.remote}/main (${remoteMain.slice(0, 10)}). ` +
      `A release is cut from main exactly as it is on the remote: git checkout --detach ${opts.remote}/main`);
  }
  // The release push runs the pre-push gate, which diffs against the first of
  // JKHeadley/main, origin/main, upstream/main that exists here. Refresh every
  // one that exists; a stale one that cannot be refreshed would make the gate
  // judge the release commit against the wrong base, so stop before publishing.
  const refs = refreshGateBaseRefs(quietRun);
  if (!refs.ok) fail(`cannot refresh ${refs.failed.map((f) => `${f.ref} (${f.detail})`).join(', ')} — the pre-push gate would diff against a stale base`);
  console.log(`refreshed gate base refs: ${refs.refreshed.join(', ') || '(none)'}`);
  const { url, slug } = repoSlug(opts.remote);
  console.log(`HEAD = ${opts.remote}/main = ${head.slice(0, 10)} (${url})`);
  // The job's `if: !contains(head_commit.message, '[skip ci]')`.
  const subject = must('git', ['log', '-1', '--format=%B', 'HEAD'], { capture: true, quiet: true }).stdout;
  if (subject.includes('[skip ci]')) {
    // publish.yml skips [skip ci] pushes to stop its own release commit from
    // re-triggering it. Locally there is no loop, and "is there anything to
    // release?" is answered by step 4 (no fragments → skip). Stopping here
    // would strand work that merged BEFORE a release cut was rebased on top of
    // it (exactly main's state after the 1.3.1359 cut landed over #2222).
    console.log('NOTE: HEAD is a [skip ci] commit (a release cut). publish.yml would not run for this push; whether anything');
    console.log('      is left to release is decided by the fragment check below.');
  }
  START_SHA = head;
  SLUG = slug;
  checkCiRuns(slug, 'preflight');
}

{
  // A dry run does these too, so it proves what a real run would do; it warns
  // where a real run stops.
  const stopOrWarn = (msg) => { if (opts.dryRun) console.log(`WARNING (a real run would stop here): ${msg}`); else fail(msg); };
  step('Preflight: npm auth (npm whoami)');
  const who = run('npm', ['whoami', ...npmAuthArgs], { capture: true });
  if (who.status !== 0) stopOrWarn('npm is not authenticated for publishing. Log in (npm login) or pass --userconfig <npmrc with the publish token>.');
  else console.log(`npm user: ${who.stdout.trim()}`);

  step('Preflight: will npm publish need a one-time password?');
  // Decided BEFORE anything is mutated: an OTP prompt at step 10 would hang
  // (or fail) after the build, the version bump and the guide rename.
  const prof = run('npm', ['profile', 'get', '--json', ...npmAuthArgs], { capture: true, quiet: true });
  const need = otpRequirement(prof.status === 0 ? prof.stdout : null);
  console.log(`account two-factor requirement for publish: ${need}`);
  if (need !== 'not-required' && !opts.otpCommand && !opts.tokenSkipsOtp) {
    stopOrWarn(`npm publish ${need === 'required' ? 'needs' : 'may need'} a one-time password. Either pass --otp-command "<a command that prints a fresh code>" ` +
      '(it runs right before publish; a code typed at the start would expire during the build), or use a granular/automation ' +
      'token that bypasses 2FA for publish and pass --token-skips-otp.');
  }
}

// ── 1-2. install + build ──────────────────────────────────────────────
step('npm ci (dev dependencies included)');
// publish.yml runs a plain `npm ci` on a runner where dev deps install by
// default. A workstation may carry NODE_ENV=production / omit=dev, which makes a
// plain `npm ci` skip tsc and friends — so force the CI-equivalent install.
must('npm', ['ci', '--include=dev'], { env: { ...process.env, NODE_ENV: 'development' } });

step('npm run build');
// Same environment as the install: a workstation NODE_ENV=production must not
// change what the build does relative to CI.
must('npm', ['run', 'build'], { env: { ...process.env, NODE_ENV: 'development' } });

// ── 3-4. release notes ────────────────────────────────────────────────
step('Assemble release-note fragments (scripts/assemble-next-md.mjs)');
touchedTree = true;
must('node', ['scripts/assemble-next-md.mjs']);

step('Check if NEXT.md has content to publish');
{
  const nextPath = path.join(ROOT, 'upgrades', 'NEXT.md');
  let skipReason = null;
  if (!fs.existsSync(nextPath)) {
    skipReason = 'No NEXT.md found — nothing to publish';
  } else {
    const content = fs.readFileSync(nextPath, 'utf-8');
    if (content.includes('[Feature name]') && content.includes('[Capability]')) {
      skipReason = 'NEXT.md is still a template — nothing to publish';
    } else if (content.split('\n').some((line) => /<!--[ \t\v\f\r]*auto-draft-unreviewed/.test(line))) {
      skipReason = 'NEXT.md still has auto-draft-unreviewed markers — awaiting human review, not publishing';
    }
  }
  if (skipReason) {
    console.log(skipReason);
    step('Loud-skip annotation (scripts/release-skip-annotate.mjs — signal only)');
    run('git', ['fetch', '--quiet', '--tags', opts.remote, 'main']);
    run('node', ['scripts/release-skip-annotate.mjs']);
    stopCleanly(`Publish skipped: ${skipReason}`);
  }
  console.log('NEXT.md has content — proceeding');
}

// ── 5. release-tier gate ──────────────────────────────────────────────
step('Release-tier gate (scripts/resolve-release-tier.mjs)');
function npmPublishedVersion() {
  const r = run('npm', ['view', 'instar', 'version'], { capture: true });
  const v = r.stdout.trim();
  // publish.yml falls back to "0.0.0" when `npm view` fails. Locally that would
  // resolve the version from package.json alone, so fail closed instead.
  if (r.status !== 0 || !SEMVER.test(v)) fail(`could not read the published instar version from npm (npm view exited ${r.status}: ${r.stderr.trim().split('\n').pop() || v})`);
  return v;
}
{
  const npmVersion = npmPublishedVersion();
  const localVersion = readPkgVersion();
  console.log(`npm has:      ${npmVersion}\npackage.json: ${localVersion}`);
  const r = run('node', ['scripts/resolve-release-tier.mjs', localVersion, npmVersion], { capture: true });
  const decision = r.stdout.trim();
  const reason = r.stderr.trim();
  console.log(`tier reason: ${reason}`);
  if (r.status !== 0) fail(`release-tier: ${reason}`);
  if (decision === 'skip') stopCleanly(`Publish skipped — release-tier gate: ${reason}. To resume publishing, edit .instar/release-tier.json.`);
  if (decision !== 'allow') fail(`release-tier printed an unexpected decision ${JSON.stringify(decision)}`);
}

// ── 6. version ────────────────────────────────────────────────────────
step('Determine next version (scripts/resolve-publish-version.mjs + npm version)');
let VERSION;
{
  const npmVersion = npmPublishedVersion();
  const localVersion = readPkgVersion();
  console.log(`npm has:        ${npmVersion}\npackage.json:   ${localVersion}`);
  VERSION = must('node', ['scripts/resolve-publish-version.mjs', localVersion, npmVersion], { capture: true }).stdout.trim();
  if (!SEMVER.test(VERSION)) fail(`resolve-publish-version printed ${JSON.stringify(VERSION)}, not X.Y.Z`);
  console.log(`resolved:       ${VERSION}`);
  VERSION_FOR_MSG = VERSION;
  must('npm', ['version', VERSION, '--no-git-tag-version', '--allow-same-version']);
  if (readPkgVersion() !== VERSION) fail(`npm version did not set package.json to ${VERSION}`);
}

// ── 7. rename + consume fragments ─────────────────────────────────────
step(`Rename NEXT.md to upgrades/${VERSION}.md; remove consumed fragments`);
{
  const nextPath = path.join(ROOT, 'upgrades', 'NEXT.md');
  const guidePath = path.join(ROOT, 'upgrades', `${VERSION}.md`);
  if (fs.existsSync(nextPath)) {
    fs.renameSync(nextPath, guidePath);
    console.log(`Renamed upgrades/NEXT.md → upgrades/${VERSION}.md`);
  } else {
    console.log('No upgrades/NEXT.md found — check-upgrade-guide will enforce');
  }
  const nextDir = path.join(ROOT, 'upgrades', 'next');
  const frags = fs.existsSync(nextDir) ? fs.readdirSync(nextDir).filter((f) => f.endsWith('.md')) : [];
  for (const f of frags) fs.unlinkSync(path.join(nextDir, f));
  if (frags.length) console.log(`Removed ${frags.length} consumed release-note fragment(s) from upgrades/next/`);
}

// ── 8. upgrade guide ──────────────────────────────────────────────────
step('Check upgrade guide (scripts/check-upgrade-guide.js)');
must('node', ['scripts/check-upgrade-guide.js']);

// ── 9. prepublishOnly gates, up front ─────────────────────────────────
step('Publish gates from prepublishOnly (Stage-B release evidence, contract evidence)');
// npm publish runs prepublishOnly again (build + these + check:upgrade-guide);
// running them here first means a --dry-run proves them too.
must('node', ['scripts/verify-codex-stage-b-release-evidence.mjs']);
must('node', ['scripts/check-contract-evidence.js']);

// Re-check right before publish (a dry run reports it here too).
step('publish.yml runs, again (any commit)');
checkCiRuns(SLUG, 'just before publish');

if (opts.dryRun) {
  const guide = `upgrades/${VERSION}.md`;
  console.log('\n══ DRY RUN COMPLETE ══');
  console.log(`Would publish:  instar@${VERSION}  (npm publish --access public, without --provenance)`);
  console.log(`Would commit:   "chore: release v${VERSION} [skip ci]" (package.json, package-lock.json, ${guide}, consumed fragments) with hooks`);
  console.log(`Would push:     git push --atomic ${opts.remote} HEAD:main v${VERSION} (rebase-retry ×5, only when ${opts.remote}/main moved)`);
  stopCleanly('Dry run: tree restored. Nothing was published, committed or pushed.');
}

// ── 10. publish ───────────────────────────────────────────────────────
step(`npm publish instar@${VERSION}`);
console.log('NOTE: publishing WITHOUT --provenance. npm provenance needs the GitHub Actions OIDC');
console.log('      token, which only exists inside a CI run. This release will carry no provenance');
console.log('      attestation; everything else matches publish.yml.');
{
  const otpArgs = [];
  if (opts.otpCommand) {
    // Runs now so the code is fresh. Its output is a secret: never printed.
    const o = spawnSync('sh', ['-c', opts.otpCommand], { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    const code = (o.stdout || '').trim();
    if (o.status !== 0 || !/^\d{6,8}$/.test(code)) fail(`--otp-command did not print a 6-8 digit code (exit ${o.status})`);
    otpArgs.push('--otp', code);
  }
  // stdin closed: npm can never sit waiting on an OTP prompt. A missing OTP
  // becomes an EOTP failure, resolved against the registry below.
  console.log(`$ npm publish --access public${npmAuthArgs.length ? ' --userconfig <path>' : ''}${otpArgs.length ? ' --otp <hidden>' : ''}`);
  // npm 11's otplease rethrows EOTP at once when stdin is not a TTY, so the
  // web-auth URL-and-poll flow never starts (verified against the installed
  // npm by tests/unit/release-local-steps.test.ts). The timeout is the backstop
  // for an npm that ever polls anyway; a timeout is resolved against the
  // registry like any other failure.
  const pub = run('npm', ['publish', '--access', 'public', ...npmAuthArgs, ...otpArgs], { noStdin: true, quiet: true, timeoutMs: PUBLISH_TIMEOUT_MS });
  if (pub.timedOut) console.log(`npm publish did not finish within ${PUBLISH_TIMEOUT_MS / 60000} min and was stopped.`);
  if (pub.status === 0) {
    published = true;
  } else {
    // npm can exit non-zero after the upload landed (timeout, flaky network).
    // Ask the registry before deciding which failure this is.
    const state = publishedStateAfterFailure({ run: quietRun, name: 'instar', version: VERSION, npmArgs: npmAuthArgs, timedOut: Boolean(pub.timedOut), delayMs: VIEW_RETRY_DELAY_MS });
    if (state === 'published') {
      published = true;
      console.log(`npm publish exited ${pub.status}, but instar@${VERSION} IS on npm — continuing down the published path.`);
    } else if (state === 'absent') {
      fail(`npm publish exited ${pub.status} and instar@${VERSION} is not on npm`);
    } else {
      publishUnknown = true;
      fail(`npm publish exited ${pub.status} and npm could not say whether instar@${VERSION} exists (check: npm view instar@${VERSION} version)`);
    }
  }
}

// ── 11. smoke ─────────────────────────────────────────────────────────
step('Post-publish smoke test (scripts/post-publish-smoke.mjs)');
{
  const smoke = run('node', ['scripts/post-publish-smoke.mjs', VERSION]);
  if (smoke.status !== 0) {
    // One registry read decides what the failure means. Not visible → npm may be
    // holding it in review (PENDING); visible → the tarball failed the smoke test.
    const seen = publishedStateAfterFailure({ run: quietRun, name: 'instar', version: VERSION, npmArgs: npmAuthArgs, retries: 0 });
    // `unknown` counts as PENDING here, deliberately unlike --push-only (where
    // it is publishUnknown): the smoke step only runs after `npm publish` was
    // accepted, so a version npm cannot confirm is most likely still in review.
    // Both treatments stop, keep the tree, and never re-publish.
    const verdict = smokeFailureVerdict(seen, 'instar', VERSION);
    if (verdict.pending) npmPending = true;
    fail(verdict.message);
  }
}

// ── 12. commit, push, tag ─────────────────────────────────────────────
step(`Commit "chore: release v${VERSION} [skip ci]" (hooks run) and push to main`);
must('git', ['add', 'package.json', 'package-lock.json', 'upgrades/']);
must('git', ['commit', '-m', `chore: release v${VERSION} [skip ci]`]);
committed = true;
{
  const refs = refreshGateBaseRefs(quietRun);
  if (!refs.ok) fail(`cannot refresh ${refs.failed.map((f) => f.ref).join(', ')} before the push — the pre-push gate would diff against a stale base`);
  // Commit and tag go up in ONE atomic push, so main and the tag can never
  // disagree. The retry loop only rebases when the remote really moved.
  // quietRun captures stdout, which the push logic needs (rev-parse); push
  // output is returned in res.output on failure.
  const res = pushReleaseAtomically({ run: quietRun, remote: opts.remote, version: VERSION, log: (m) => console.log(m) });
  if (!res.ok) fail(`${res.reason}${res.output ? `\n--- push output ---\n${res.output}` : ''}`);
}

const releaseSha = run('git', ['rev-parse', 'HEAD'], { capture: true, quiet: true }).stdout.trim();
const startSha = START_SHA;
const slug = SLUG || '<owner>/<repo>';
console.log(`\n══ RELEASED instar@${VERSION} ══  (release commit ${releaseSha.slice(0, 10)}, tag v${VERSION})`);
console.log(CI_UNVERIFIED
  ? `publish.yml runs were NOT verified (--allow-unverified-ci). Check: gh run list -R ${slug} --workflow publish.yml`
  : `publish.yml runs on ${slug} (any commit) were checked before publish: none active. Shipped merge: ${startSha.slice(0, 10)}.`);
