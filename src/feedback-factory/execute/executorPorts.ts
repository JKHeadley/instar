/**
 * The executor's external boundaries (docs/specs/feedback-triage-and-execution.md §4): trusted
 * git in its OWN clones, GitHub through `gh` and `safe-merge`, and the attempt directories.
 * Production implementations live here; tests replace each port with a scripted fake.
 *
 * Trusted git never runs in the session workspace except to CREATE it (a clone + detached
 * checkout before the session ever touches it). All commits and pushes happen in the publish
 * clone with hooks, fsmonitor, external diff/textconv and every global/system config disabled
 * (SafeGitExecutor injects GIT_CONFIG_GLOBAL/SYSTEM=/dev/null), `--no-verify`, and an explicit
 * GitHub remote URL.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SafeGitExecutor } from '../../core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import type { PrReview, RepoInfo } from './reviewGate.js';

const execFileAsync = promisify(execFile);

/** `-c` overrides every trusted git command in an attempt clone carries. */
export const HARDENED_GIT_CONFIG = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat',
  '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.file.allow=never',
  '-c', 'submodule.recurse=false', '-c', 'core.sshCommand=false', '-c', 'core.protectHFS=true', '-c', 'core.protectNTFS=true',
] as const;

export interface AttemptGit {
  /** Fetch origin/main in the trusted source checkout and return its SHA. */
  fetchBase(sourceRepoPath: string): Promise<string>;
  /** Create a standalone clone of `sourceRepoPath` at `sha` (detached), before anything else touches it. */
  createClone(sourceRepoPath: string, dest: string, sha: string): Promise<void>;
  /** In the publish clone: stage everything, commit, push to `remoteUrl` as `branch`; returns the pushed head SHA. */
  commitAndPush(publishClone: string, input: { branch: string; message: string; remoteUrl: string; authorName: string; authorEmail: string; credentialHelper: string | null }): Promise<string>;
  /** `owner/name` and an https URL of the source checkout's GitHub origin, or null. */
  githubRemote(sourceRepoPath: string): Promise<{ slug: string; url: string } | null>;
  /**
   * The first release tag (`vX.Y.Z`) whose commit contains `commit`, with that tag commit's date;
   * `'none'` when no release contains it yet; null when it cannot be determined.
   */
  firstReleaseContaining(sourceRepoPath: string, commit: string): Promise<{ tag: string; taggedAt: number } | 'none' | null>;
}

export interface GitHubGateway {
  repoInfo(slug: string): Promise<RepoInfo | null>;
  viewerLogin(): Promise<string | null>;
  /** Every github.com account `gh` holds a login for (active or not); null when any is unreadable. */
  authAccounts(): Promise<string[] | null>;
  createPr(input: { slug: string; head: string; base: string; title: string; body: string; label: string }): Promise<{ number: number } | null>;
  prState(slug: string, pr: number): Promise<{ state: string; mergedAt: string | null; headRefOid: string; mergeCommit: string | null; author: string | null; headRefName: string } | null>;
  reviews(slug: string, pr: number): Promise<PrReview[] | null>;
  removeLabel(slug: string, pr: number, label: string): Promise<boolean>;
  disableAuto(slug: string, pr: number): Promise<boolean>;
  safeMerge(slug: string, pr: number, sha: string): Promise<{ exitCode: number | null; stdout: string }>;
}

function gitEnv(): NodeJS.ProcessEnv {
  return { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '', SSH_ASKPASS: '' };
}

export class SafeAttemptGit implements AttemptGit {
  async fetchBase(sourceRepoPath: string): Promise<string> {
    SafeGitExecutor.execSync([...HARDENED_GIT_CONFIG, 'fetch', 'origin', 'main', '--no-tags', '--no-recurse-submodules', '--quiet'],
      { cwd: sourceRepoPath, operation: 'feedback-execute fetch base', sourceTreeReadOk: true, timeout: 120_000, env: gitEnv() });
    const sha = SafeGitExecutor.readSync(['rev-parse', 'origin/main'], { cwd: sourceRepoPath, operation: 'feedback-execute base sha', sourceTreeReadOk: true }).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('base-sha-unreadable');
    return sha;
  }

  async createClone(sourceRepoPath: string, dest: string, sha: string): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('invalid base sha');
    if (fs.existsSync(dest)) throw new Error(`clone destination exists: ${path.basename(dest)}`);
    // cwd is a neutral temp directory; the destination is a fresh feedback attempt clone.
    // Cloning from the trusted local checkout is a "file" transport; it is allowed for this one
    // command (the later -c wins) and stays off everywhere else (no submodule or alternate fetches).
    SafeGitExecutor.execSync([...HARDENED_GIT_CONFIG, '-c', 'protocol.file.allow=always', 'clone', '--no-hardlinks', '--no-checkout', '--quiet', '--no-recurse-submodules', sourceRepoPath, dest],
      { cwd: os.tmpdir(), operation: 'feedback-execute create attempt clone', timeout: 300_000, env: gitEnv() });
    SafeGitExecutor.execSync([...HARDENED_GIT_CONFIG, 'checkout', '--detach', '--quiet', sha],
      { cwd: dest, operation: 'feedback-execute checkout base', feedbackAttemptCloneOk: true, timeout: 300_000, env: gitEnv() });
  }

  async commitAndPush(publishClone: string, input: { branch: string; message: string; remoteUrl: string; authorName: string; authorEmail: string; credentialHelper: string | null }): Promise<string> {
    if (!/^feedback\/[a-z0-9-]+-a\d+$/.test(input.branch)) throw new Error('invalid feedback branch');
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(input.remoteUrl)) throw new Error('remote must be an explicit https GitHub URL');
    const opts = { cwd: publishClone, feedbackAttemptCloneOk: true, env: gitEnv(), timeout: 120_000 } as const;
    SafeGitExecutor.execSync([...HARDENED_GIT_CONFIG, 'add', '-A', '--', '.'], { ...opts, operation: 'feedback-execute stage change set' });
    // Identity as env (it outranks any inherited or injected identity): the resolved commit identity, never an invented one.
    const identityEnv = { GIT_AUTHOR_NAME: input.authorName, GIT_AUTHOR_EMAIL: input.authorEmail, GIT_COMMITTER_NAME: input.authorName, GIT_COMMITTER_EMAIL: input.authorEmail };
    SafeGitExecutor.execSync([...HARDENED_GIT_CONFIG, '-c', `user.name=${input.authorName}`, '-c', `user.email=${input.authorEmail}`, 'commit', '--no-verify', '--quiet', '-F', '-'],
      { ...opts, env: { ...opts.env, ...identityEnv }, operation: 'feedback-execute commit change set', input: input.message });
    const helper = input.credentialHelper ? ['-c', 'credential.helper=', '-c', `credential.helper=${input.credentialHelper}`] : ['-c', 'credential.helper='];
    SafeGitExecutor.execSync([...HARDENED_GIT_CONFIG, ...helper, 'push', '--no-verify', '--quiet', input.remoteUrl, `HEAD:refs/heads/${input.branch}`],
      { ...opts, operation: 'feedback-execute push feedback branch' });
    const head = SafeGitExecutor.readSync(['rev-parse', 'HEAD'], { cwd: publishClone, operation: 'feedback-execute pushed head', feedbackAttemptCloneOk: true }).trim();
    if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('pushed-head-unreadable');
    return head;
  }

  async githubRemote(sourceRepoPath: string): Promise<{ slug: string; url: string } | null> {
    try {
      const raw = SafeGitExecutor.readSync(['remote', 'get-url', 'origin'], { cwd: sourceRepoPath, operation: 'feedback-execute origin url', sourceTreeReadOk: true }).trim();
      const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(\.git)?$/.exec(raw);
      return m ? { slug: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}.git` } : null;
    } catch { return null; } // @silent-fallback-ok: an unreadable origin makes the executor report no-source-repo
  }

  async firstReleaseContaining(sourceRepoPath: string, commit: string): Promise<{ tag: string; taggedAt: number } | 'none' | null> {
    if (!/^[0-9a-f]{7,40}$/.test(commit)) return null;
    const read = (args: string[], operation: string) => SafeGitExecutor.readSync(args, { cwd: sourceRepoPath, operation, sourceTreeReadOk: true, timeout: 60_000 });
    try {
      // Release tags point at release commits on main, which fetchBase already brought in, so no
      // tag refs are written: ls-remote lists them and merge-base checks ancestry locally.
      const listed = read(['ls-remote', '--tags', 'origin', 'refs/tags/v*'], 'feedback-execute list release tags');
      const peeled = new Map<string, string>();
      for (const row of listed.split('\n')) {
        const m = /^([0-9a-f]{40})\s+refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/.exec(row.trim());
        if (!m) continue;
        if (m[3] || !peeled.has(m[2])) peeled.set(m[2], m[1]);
      }
      const tags = [...peeled.keys()].sort(compareVersionTags);
      const contains = (tag: string): boolean => {
        try { read(['merge-base', '--is-ancestor', commit, peeled.get(tag)!], 'feedback-execute release ancestry'); return true; } catch { return false; } // exit 1 = not an ancestor
      };
      if (tags.length === 0 || !contains(tags[tags.length - 1])) return 'none';
      let lo = 0, hi = tags.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (contains(tags[mid])) hi = mid; else lo = mid + 1; }
      const date = read(['log', '-1', '--format=%cI', peeled.get(tags[lo])!], 'feedback-execute release date').trim();
      const taggedAt = Date.parse(date);
      return Number.isFinite(taggedAt) ? { tag: tags[lo], taggedAt } : null;
    } catch { return null; } // @silent-fallback-ok: undeterminable → verify stays pending (spec §4 step 9)
  }
}

function compareVersionTags(a: string, b: string): number {
  const pa = a.slice(1).split('.').map(Number);
  const pb = b.slice(1).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export class GhGateway implements GitHubGateway {
  constructor(private readonly opts: { ghPath?: string; cwd: string; safeMergeScript: string; nodePath?: string }) {}

  private async gh(args: string[], timeout = 30_000): Promise<string> {
    const { stdout } = await execFileAsync(this.opts.ghPath ?? 'gh', args, { cwd: this.opts.cwd, timeout, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  // RULE 3: EXEMPT — every parse below reads gh's documented --json / REST output (a stable, versioned data contract).
  async repoInfo(slug: string): Promise<RepoInfo | null> {
    try {
      const raw = JSON.parse(await this.gh(['api', `repos/${slug}`])) as { owner?: { login?: string; type?: string }; allow_auto_merge?: boolean };
      if (!raw.owner?.login) return null;
      return { ownerLogin: raw.owner.login, ownerType: raw.owner.type ?? 'User', allowAutoMerge: raw.allow_auto_merge === true };
    } catch { return null; } // @silent-fallback-ok: a gh error leaves executor state unchanged and is reported as unknown
  }

  async viewerLogin(): Promise<string | null> {
    try { return (JSON.parse(await this.gh(['api', 'user'])) as { login?: string }).login ?? null; } catch { return null; } // @silent-fallback-ok: unreadable login counts as NOT independent
  }

  async authAccounts(): Promise<string[] | null> {
    let raw: string;
    try { raw = await this.gh(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']); } catch (error) {
      // @silent-fallback-ok: gh exits non-zero when one account has a problem; the JSON on stdout still lists them (unparseable → null below)
      raw = String((error as { stdout?: string }).stdout ?? '');
    }
    try {
      const hosts = (JSON.parse(raw) as { hosts?: Record<string, Array<{ login?: string }>> }).hosts ?? {};
      const entries = hosts['github.com'];
      if (!Array.isArray(entries)) return null;
      const logins = entries.map((e) => String(e.login ?? ''));
      // An entry whose login cannot be read could be the approver: the whole set is unreadable.
      return logins.some((l) => l === '') ? null : [...new Set(logins)];
    } catch { return null; } // @silent-fallback-ok: unreadable accounts count as NOT independent
  }

  async createPr(input: { slug: string; head: string; base: string; title: string; body: string; label: string }): Promise<{ number: number } | null> {
    const bodyFile = path.join(os.tmpdir(), `feedback-pr-body-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(bodyFile, input.body, { mode: 0o600, flag: 'wx' });
    try {
      const out = await this.gh(['pr', 'create', '--repo', input.slug, '--head', input.head, '--base', input.base, '--title', input.title, '--body-file', bodyFile, '--label', input.label], 60_000);
      const m = /\/pull\/(\d+)/.exec(out);
      return m ? { number: Number(m[1]) } : null;
    } finally {
      try { SafeFsExecutor.safeUnlinkSync(bodyFile, { operation: 'feedback-execute PR body temp cleanup' }); } catch { /* @silent-fallback-ok: a leftover temp body holds only the published PR text */ }
    }
  }

  async prState(slug: string, pr: number): Promise<{ state: string; mergedAt: string | null; headRefOid: string; mergeCommit: string | null; author: string | null; headRefName: string } | null> {
    try {
      const raw = JSON.parse(await this.gh(['pr', 'view', String(pr), '--repo', slug, '--json', 'state,mergedAt,headRefOid,mergeCommit,author,headRefName'])) as {
        state?: string; mergedAt?: string | null; headRefOid?: string; mergeCommit?: { oid?: string } | null; author?: { login?: string } | null; headRefName?: string };
      if (!raw.headRefOid) return null;
      return { state: String(raw.state ?? ''), mergedAt: raw.mergedAt ?? null, headRefOid: raw.headRefOid, mergeCommit: raw.mergeCommit?.oid ?? null, author: raw.author?.login ?? null, headRefName: String(raw.headRefName ?? '') };
    } catch { return null; } // @silent-fallback-ok: gh error → state unchanged, reported unknown
  }

  async reviews(slug: string, pr: number): Promise<PrReview[] | null> {
    try {
      const raw = JSON.parse(await this.gh(['api', '--paginate', '--slurp', `repos/${slug}/pulls/${pr}/reviews`])) as Array<Array<{ user?: { login?: string }; state?: string; commit_id?: string; submitted_at?: string }>>;
      return raw.flat().map((r) => ({ login: String(r.user?.login ?? ''), state: String(r.state ?? ''), commitId: String(r.commit_id ?? ''), submittedAt: String(r.submitted_at ?? '') }));
    } catch { return null; } // @silent-fallback-ok: gh error → state unchanged, reported unknown
  }

  async removeLabel(slug: string, pr: number, label: string): Promise<boolean> {
    try { await this.gh(['api', '-X', 'DELETE', `repos/${slug}/issues/${pr}/labels/${encodeURIComponent(label)}`]); return true; } catch { return false; } // @silent-fallback-ok: caller records the failure
  }

  /**
   * Idempotent: a PR with no auto-merge request (never armed, already disarmed, merged or closed)
   * is already in the wanted state. Only a PR that is armed is disarmed; any unreadable answer is
   * a failure (the caller keeps the row armed and retries).
   */
  async disableAuto(slug: string, pr: number): Promise<boolean> {
    try {
      // RULE 3: EXEMPT — gh's documented --json output (a stable, versioned data contract).
      const view = JSON.parse(await this.gh(['pr', 'view', String(pr), '--repo', slug, '--json', 'autoMergeRequest,state'])) as { autoMergeRequest?: unknown; state?: string };
      if (view.autoMergeRequest === null || view.autoMergeRequest === undefined || view.state === 'MERGED' || view.state === 'CLOSED') return true;
      await this.gh(['pr', 'merge', String(pr), '--repo', slug, '--disable-auto']);
      return true;
    } catch { return false; } // @silent-fallback-ok: caller keeps the row armed (disarmFailed) and raises the disarm-failure Attention line
  }

  async safeMerge(slug: string, pr: number, sha: string): Promise<{ exitCode: number | null; stdout: string }> {
    try {
      const { stdout } = await execFileAsync(this.opts.nodePath ?? process.execPath, [this.opts.safeMergeScript, String(pr), '--auto', '--repo', slug, '--match-head-commit', sha],
        { cwd: this.opts.cwd, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 });
      return { exitCode: 0, stdout };
    } catch (error) {
      const e = error as { code?: number | string; stdout?: string };
      return { exitCode: typeof e.code === 'number' ? e.code : null, stdout: String(e.stdout ?? '') };
    }
  }
}
