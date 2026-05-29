// safe-git-allow: pre-push bootstrap helpers — read-only git only.
import { execFileSync } from 'node:child_process';

export const DEFAULT_SMOKE_LIMITS = Object.freeze({
  maxChangedFiles: 200,
  maxTestFiles: 80,
  maxTestCases: 1000,
});

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts.env ?? process.env,
  }).trim();
}

function tryGit(args, opts = {}) {
  try {
    const out = (opts.git ?? git)(args, opts);
    return out ? String(out).trim() : '';
  } catch {
    return '';
  }
}

function remoteRef(remote, branch = 'main') {
  if (!remote) return '';
  return `refs/remotes/${remote}/${branch}`;
}

function refExists(ref, opts = {}) {
  if (!ref) return false;
  return Boolean(tryGit(['rev-parse', '--verify', ref], opts));
}

function addCandidate(candidates, seen, ref, reason, opts) {
  if (!ref || seen.has(ref)) return;
  seen.add(ref);
  if (refExists(ref, opts)) candidates.push({ ref, reason });
}

function shortRemoteRef(ref) {
  return ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : ref;
}

export function resolvePrePushBase(opts = {}) {
  const candidates = [];
  const seen = new Set();
  const branch = tryGit(['branch', '--show-current'], opts);
  const upstream = tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], opts);

  if (upstream) {
    const parts = upstream.split('/');
    const upstreamRemote = parts[0];
    const upstreamBranch = parts.slice(1).join('/');
    if (upstreamBranch === 'main') {
      addCandidate(candidates, seen, `refs/remotes/${upstream}`, 'branch upstream', opts);
    } else {
      addCandidate(candidates, seen, remoteRef(upstreamRemote), 'branch upstream remote main', opts);
    }
  }

  const pushRemote =
    (branch && tryGit(['config', `branch.${branch}.pushRemote`], opts)) ||
    tryGit(['config', 'remote.pushDefault'], opts);
  addCandidate(candidates, seen, remoteRef(pushRemote), 'push remote main', opts);

  const branchRemote = branch ? tryGit(['config', `branch.${branch}.remote`], opts) : '';
  addCandidate(candidates, seen, remoteRef(branchRemote), 'branch remote main', opts);

  addCandidate(candidates, seen, 'refs/remotes/JKHeadley/main', 'fallback JKHeadley/main', opts);
  addCandidate(candidates, seen, 'refs/remotes/upstream/main', 'fallback upstream/main', opts);
  addCandidate(candidates, seen, 'refs/remotes/origin/main', 'fallback origin/main', opts);

  if (candidates.length > 0) {
    return { ref: shortRemoteRef(candidates[0].ref), reason: candidates[0].reason };
  }

  const previousCommit = tryGit(['rev-parse', 'HEAD~1'], opts);
  if (previousCommit) return { ref: previousCommit, reason: 'fallback HEAD~1' };

  return { ref: 'HEAD', reason: 'fallback HEAD' };
}

export function changedFilesSince(baseRef, opts = {}) {
  const out = (opts.git ?? git)(['diff', '--name-only', `${baseRef}...HEAD`], opts);
  return String(out)
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

export function readSmokeLimits(env = process.env) {
  return {
    maxChangedFiles: Number.parseInt(env.INSTAR_PRE_PUSH_SMOKE_MAX_CHANGED_FILES ?? '', 10) || DEFAULT_SMOKE_LIMITS.maxChangedFiles,
    maxTestFiles: Number.parseInt(env.INSTAR_PRE_PUSH_SMOKE_MAX_TEST_FILES ?? '', 10) || DEFAULT_SMOKE_LIMITS.maxTestFiles,
    maxTestCases: Number.parseInt(env.INSTAR_PRE_PUSH_SMOKE_MAX_TEST_CASES ?? '', 10) || DEFAULT_SMOKE_LIMITS.maxTestCases,
  };
}

export function evaluateSmokeBreadth({ changedFileCount, testFileCount, testCaseCount }, limits = DEFAULT_SMOKE_LIMITS) {
  if (changedFileCount > limits.maxChangedFiles) {
    return {
      skip: true,
      reason: `changed file count ${changedFileCount} exceeds local smoke cap ${limits.maxChangedFiles}`,
    };
  }
  if (testFileCount > limits.maxTestFiles) {
    return {
      skip: true,
      reason: `affected test file count ${testFileCount} exceeds local smoke cap ${limits.maxTestFiles}`,
    };
  }
  if (testCaseCount > limits.maxTestCases) {
    return {
      skip: true,
      reason: `affected test case count ${testCaseCount} exceeds local smoke cap ${limits.maxTestCases}`,
    };
  }
  return { skip: false, reason: 'within local smoke caps' };
}

export function summarizeVitestList(stdout) {
  const tests = String(stdout)
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  const files = new Set(tests.map(line => line.split(' > ')[0]).filter(Boolean));
  return { testCaseCount: tests.length, testFileCount: files.size };
}
