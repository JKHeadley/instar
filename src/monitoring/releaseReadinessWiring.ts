/**
 * releaseReadinessWiring — builds the real I/O dependencies for the
 * ReleaseReadinessSentinel (Layer B of release-readiness-visibility).
 *
 * Extracted from server.ts so the dependency construction is itself
 * unit-testable (Testing Integrity Standard: every dependency-injected
 * component needs wiring-integrity tests proving deps are real functions, not
 * nulls or silent no-ops).
 *
 * Repo-gated: the sentinel analyzes the instar git repo, which only exists in
 * the dev/maintainer environment. `isAnalyzableRepo` lets the server decide
 * whether to construct + start the sentinel at all on a given install.
 *
 * All git goes through SafeGitExecutor (audited funnel, execFileSync — no shell).
 * Canonical-remote reads are allow-listed to github.com:JKHeadley/instar so a
 * config override to a fork raises a HIGH-priority signal rather than silently
 * trusting a stale fork (spec §4.2.2).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import type {
  ReleaseReadinessSentinelDeps,
  ReadinessState,
  AnalyzerReport,
  OldestCommit,
  AttentionItem,
} from './ReleaseReadinessSentinel.js';
import { ReleaseReadinessSentinel } from './ReleaseReadinessSentinel.js';

/** Anchored on the known canonical host — not "any URL ending in JKHeadley/instar". */
export const CANONICAL_REMOTE_RE = /^(https:\/\/github\.com\/|git@github\.com:)JKHeadley\/instar(\.git)?$/;

export interface ReleaseReadinessWiringOpts {
  /** The instar git checkout to analyze (Echo: the agent home). */
  repoPath: string;
  /** Path to .instar/state/release-readiness.json. */
  statePath: string;
  /** Path to logs/sentinel-events.jsonl. */
  auditPath: string;
  /** Local server port + auth for Attention posting. */
  port: number;
  authToken: string;
  /** Configured canonical remote name (default: auto-detect a JKHeadley/instar remote). */
  canonicalRemote?: string;
  fetchTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Is `repoPath` an instar git checkout we can actually analyze? */
export function isAnalyzableRepo(repoPath: string): boolean {
  try {
    return (
      fs.existsSync(path.join(repoPath, '.git')) &&
      fs.existsSync(path.join(repoPath, 'scripts', 'analyze-release.js')) &&
      fs.existsSync(path.join(repoPath, 'package.json'))
    );
  } catch {
    return false;
  }
}

/** Resolve the canonical-main remote name and whether it was overridden to a non-canonical URL. */
export function resolveCanonicalRemote(
  repoPath: string,
  configured?: string,
): { remote: string; overridden: boolean } {
  let remotesRaw = '';
  try {
    remotesRaw = SafeGitExecutor.run(['remote', '-v'], { cwd: repoPath, operation: 'releaseReadinessWiring:resolveRemote', sourceTreeReadOk: true });
  } catch {
    return { remote: configured ?? 'origin', overridden: configured != null };
  }
  const remotes = new Map<string, string>();
  for (const line of remotesRaw.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line);
    if (m) remotes.set(m[1], m[2]);
  }
  if (configured) {
    const url = remotes.get(configured) ?? '';
    return { remote: configured, overridden: !CANONICAL_REMOTE_RE.test(url) };
  }
  for (const [name, url] of remotes) {
    if (CANONICAL_REMOTE_RE.test(url)) return { remote: name, overridden: false };
  }
  return { remote: 'origin', overridden: !CANONICAL_REMOTE_RE.test(remotes.get('origin') ?? '') };
}

function runAnalyzerSubprocess(repoPath: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(repoPath, 'scripts', 'analyze-release.js'), ...args],
      { cwd: repoPath, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        resolve(stdout ?? null);
      },
    );
  });
}

export function buildReleaseReadinessDeps(opts: ReleaseReadinessWiringOpts): ReleaseReadinessSentinelDeps {
  const now = opts.now ?? (() => Date.now());
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 30_000;
  const { remote, overridden } = resolveCanonicalRemote(opts.repoPath, opts.canonicalRemote);
  // Coalesce concurrent fetches (Layer B + a future Layer C tick) onto one promise.
  let inflightFetch: Promise<{ ok: boolean; headSha?: string }> | null = null;

  const postAttention = makeAttentionPoster(opts);

  const audit = (event: Record<string, unknown>): void => {
    try {
      fs.appendFileSync(opts.auditPath, JSON.stringify({ ts: new Date(now()).toISOString(), ...event }) + '\n');
    } catch {
      /* audit is best-effort; never crash the monitoring path */
    }
  };

  return {
    fetchCanonical: () => {
      if (inflightFetch) return inflightFetch;
      inflightFetch = (async () => {
        try {
          // Spec §4.2.2 originally said --depth=1; an E2E against a fixture (and
          // by extension a real install with full local history) showed --depth=1
          // turns the LOCAL repo shallow, which breaks `git log v0.0.1..ref` for
          // analyze-release. --no-tags --no-recurse-submodules keeps the fetch
          // bounded without shallowing; incremental fetches against an existing
          // checkout transfer only new objects.
          SafeGitExecutor.run(
            ['fetch', remote, 'main', '--no-tags', '--no-recurse-submodules'],
            {
              cwd: opts.repoPath,
              operation: 'releaseReadinessWiring:fetch',
              timeout: fetchTimeoutMs,
              // The watchdog by-design runs against the instar source tree
              // (the maintainer environment IS an instar checkout). fetch
              // only touches FETCH_HEAD + objects — read-tier for source
              // protection. Opt into the narrow allowlist documented on
              // SafeGitOptions.sourceTreeReadOk.
              sourceTreeReadOk: true,
            },
          );
          const headSha = SafeGitExecutor.run(['rev-parse', 'FETCH_HEAD'], {
            cwd: opts.repoPath,
            operation: 'releaseReadinessWiring:revparse',
            sourceTreeReadOk: true,
          }).trim();
          return { ok: true, headSha };
        } catch {
          return { ok: false };
        } finally {
          inflightFetch = null;
        }
      })();
      return inflightFetch;
    },

    runAnalyzer: async (ref) => {
      const out = await runAnalyzerSubprocess(opts.repoPath, ['--json', `--ref=${ref}`], fetchTimeoutMs);
      if (!out || !out.trim()) return null;
      try {
        const j = JSON.parse(out);
        const r: AnalyzerReport = {
          lastTag: j.lastTag,
          commitCount: j.commitCount,
          analysis: {
            commitClassification: {
              features: j.analysis?.commitClassification?.features ?? 0,
              fixes: j.analysis?.commitClassification?.fixes ?? 0,
            },
          },
          guideCoverage: {
            criticalGaps: j.guideCoverage?.criticalGaps ?? 0,
            highGaps: j.guideCoverage?.highGaps ?? 0,
          },
        };
        return r;
      } catch {
        return null;
      }
    },

    oldestUnreleasedCommit: async (lastTag, ref) => {
      try {
        const raw = SafeGitExecutor.run(
          ['log', `${lastTag}..${ref}`, '--no-merges', '--reverse', '--format=%H %ct'],
          { cwd: opts.repoPath, operation: 'releaseReadinessWiring:oldest', sourceTreeReadOk: true },
        ).trim();
        const first = raw.split('\n').filter(Boolean)[0];
        if (!first) return null;
        const [sha, ct] = first.split(' ');
        const out: OldestCommit = { sha, dateMs: Number(ct) * 1000 };
        return out;
      } catch {
        return null;
      }
    },

    guideBlocksPublish: async () => {
      const nextPath = path.join(opts.repoPath, 'upgrades', 'NEXT.md');
      if (!fs.existsSync(nextPath)) return true;
      const c = fs.readFileSync(nextPath, 'utf-8');
      if (c.includes('[Feature name]') && c.includes('[Capability]')) return true; // pristine template
      if (c.includes('auto-draft-unreviewed')) return true; // un-reviewed auto-draft
      return false;
    },

    draftGuide: async (ref) => {
      await runAnalyzerSubprocess(opts.repoPath, ['--draft-guide', `--ref=${ref}`], fetchTimeoutMs);
    },

    postAttention,

    resolveAttention: async (id, reason) => {
      try {
        const doFetch = opts.fetchImpl ?? fetch;
        const resp = await doFetch(`http://localhost:${opts.port}/attention/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.authToken}` },
          body: JSON.stringify({ status: 'resolved', reason }),
        });
        return resp.ok;
      } catch {
        return false;
      }
    },

    loadState: () => loadReadinessState(opts.statePath, overridden),
    saveState: (state) => saveReadinessState(opts.statePath, state),

    isAncestor: async (sha, ref) => {
      try {
        // merge-base --is-ancestor exits 0 when sha is an ancestor of ref, 1 otherwise.
        SafeGitExecutor.run(['merge-base', '--is-ancestor', sha, ref], {
          cwd: opts.repoPath,
          operation: 'releaseReadinessWiring:isAncestor',
          sourceTreeReadOk: true,
        });
        return true;
      } catch {
        return false;
      }
    },

    audit,
    now,
  };
}

export function loadReadinessState(statePath: string, canonicalRemoteOverridden = false): ReadinessState {
  try {
    if (fs.existsSync(statePath)) {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as ReadinessState;
      parsed.episodes ??= [];
      parsed.recentResolves ??= [];
      parsed.canonicalRemoteOverridden = canonicalRemoteOverridden;
      return parsed;
    }
  } catch {
    /* corrupt state → start fresh rather than crash the tick */
  }
  const fresh = ReleaseReadinessSentinel.emptyState();
  fresh.canonicalRemoteOverridden = canonicalRemoteOverridden;
  return fresh;
}

export function saveReadinessState(statePath: string, state: ReadinessState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath); // atomic replace (rename is not a destructive-lint verb)
}

export type AttentionPoster = (item: AttentionItem) => Promise<boolean>;

export function makeAttentionPoster(opts: {
  port: number;
  authToken: string;
  fetchImpl?: typeof fetch;
}): AttentionPoster {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (item) => {
    try {
      const resp = await doFetch(`http://localhost:${opts.port}/attention`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.authToken}` },
        body: JSON.stringify({ category: 'degradation', priority: 'LOW', source: 'release-readiness', ...item }),
      });
      return resp.status === 201 || resp.ok;
    } catch {
      return false;
    }
  };
}
