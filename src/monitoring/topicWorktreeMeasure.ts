/**
 * topicWorktreeMeasure — topic-worktree-reclaim D. Runs in the disk-steward child,
 * after the whole-disk walk. READ-ONLY: nothing here can remove a worktree.
 *
 * For each topic worktree under `<stateDir>/worktrees` it answers, with evidence:
 * is it provably safe to remove (and how many bytes), or why must it stay. Every
 * "eligible" verdict is checked a second way (the audit table in the spec), and a
 * disagreement is recorded as a false eligibility. Phase 2 (CMT-1958) decides
 * removal on these numbers.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  makeAgentWorktreeReaperDeps, makeCappedRunGh, isGateRecordPath, resolveBaseRef, isBranchMerged, type ReadGit, type RunGh,
} from './agentWorktreeGit.js';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { DEPS_COPY_MARKER } from '../core/WorktreeManager.js';

export interface TopicWorktreeMeasureInput {
  agentHome: string;
  stateDir: string;
  projectDir: string;
  /** WorktreeManager's machine id; history events from other machines are not provenance here. */
  worktreeMachineId: string | null;
  githubMergeCheck: boolean;
  /** Absolute deadline (epoch ms): runDeadlineAt minus the 60 s reserve. */
  deadlineAt: number;
  sizeOf: (p: string, budgetMs: number) => Promise<number | null>;
  now?: () => number;
  readGit?: ReadGit;
  runGh?: RunGh;
}

export interface Bucket { count: number; bytes: number | null }
export interface TopicWorktreePlan {
  at: number;
  partial: boolean;
  eligible: Bucket;
  eligibleIfMarkedDepsAccepted: Bucket;
  eligibleIfUnmarkedDepsAccepted: Bucket;
  audit: { agrees: number; disagrees: number; couldNotVerify: number };
  kept: Record<string, number>;
  outOfScope: Record<string, number>;
  notMeasured: number;
  falseEligibility: { count: number; paths: string[] };
  lookupsUsed: number;
}

/** Files WorktreeManager itself writes into a topic worktree (the closed residue list). */
export function isTopicResidue(rel: string): boolean {
  const r = rel.replace(/\/$/, '');
  return r === '.session.lock'
    || /^\.session\.lock\.tmp\./.test(r)
    || r === '.instar/session-context.json'
    || r === '.husky/_' || r.startsWith('.husky/_/')
    || isGateRecordPath(r);
}

type Residue = { work: string[]; realDeps: boolean };

/** Classify a `git status --porcelain=v1 -z --ignored --untracked-files=all` listing. */
export function classifyStatus(porcelainZ: string, checkout: string): Residue {
  const work: string[] = [];
  let realDeps = false;
  const entries = porcelainZ.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const xy = e.slice(0, 2);
    const rel = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // rename/copy carries the source path as the next entry
    if (isTopicResidue(rel)) continue;
    if (rel === 'node_modules' || rel === 'node_modules/' || rel.startsWith('node_modules/')) {
      let isLink = false;
      try { isLink = fs.lstatSync(path.join(checkout, 'node_modules')).isSymbolicLink(); } catch { isLink = false; } // @silent-fallback-ok — unreadable ⇒ not proven a link ⇒ counted as a real copy
      if (!isLink) realDeps = true;
      continue;
    }
    work.push(rel);
  }
  return { work, realDeps };
}

function parsePorcelainWorktrees(out: string): Array<{ path: string; branch: string | null; headSha: string }> {
  const rows: Array<{ path: string; branch: string | null; headSha: string }> = [];
  let cur: { path?: string; branch?: string | null; headSha?: string } = {};
  for (const line of (out + '\n').split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9).trim() };
    else if (line.startsWith('HEAD ')) cur.headSha = line.slice(5).trim();
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (line.startsWith('detached')) cur.branch = null;
    else if (line.trim() === '' && cur.path) { rows.push({ path: cur.path, branch: cur.branch ?? null, headSha: cur.headSha ?? '' }); cur = {}; }
  }
  return rows;
}

const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } }; // @silent-fallback-ok — unresolvable ⇒ compare the literal path

/** Paths WorktreeManager bound on this machine, from the signed binding history. null = unreadable. */
export function readBindingProvenance(stateDir: string, machineId: string | null): Set<string> | null {
  let text: string;
  try { text = fs.readFileSync(path.join(stateDir, 'state', 'binding-history-log.jsonl'), 'utf-8'); }
  catch (err) { return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? new Set() : null; }
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const json = line.split('\t')[0];
    try {
      const e = JSON.parse(json) as { kind?: string; machineId?: string; worktreePath?: string };
      if (e.kind !== 'binding-created' || typeof e.worktreePath !== 'string') continue;
      if (machineId && e.machineId !== machineId) continue;
      out.add(real(e.worktreePath));
    } catch { /* @silent-fallback-ok — one unparsable line is not provenance; the rest still count */ }
  }
  return out;
}

/** Working directories of running sessions. null = unreadable (every entry then reads as in use). */
export function readRunningSessionCwds(stateDir: string): string[] | null {
  const dir = path.join(stateDir, 'state', 'sessions');
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); }
  catch (err) { return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : null; }
  const cwds: string[] = [];
  for (const n of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')) as { status?: string; cwd?: string };
      if ((rec.status === 'running' || rec.status === 'starting') && typeof rec.cwd === 'string') cwds.push(real(rec.cwd));
    } catch { return null; } // @silent-fallback-ok — a record that will not parse: treat everything as in use
  }
  return cwds;
}

/** The changed-file diff body without index/hunk-position lines, for a patch comparison. */
function normalizedDiff(readGit: ReadGit, repo: string, from: string, to: string, paths: string[]): string {
  const out = readGit(['-C', repo, 'diff', '--no-color', '--no-ext-diff', from, to, '--', ...paths], repo);
  return out.split('\n').filter((l) => !l.startsWith('index ') && !l.startsWith('@@')).join('\n');
}

export async function measureTopicWorktrees(input: TopicWorktreeMeasureInput): Promise<TopicWorktreePlan> {
  const now = input.now ?? Date.now;
  // One deadline for every step (spec D Budget): each git and gh call's timeout is the
  // smaller of its default and the time left.
  const left = () => input.deadlineAt - now();
  const readGit: ReadGit = input.readGit ?? ((args, cwd) => {
    const t = Math.min(30_000, Math.floor(left()));
    if (t < 1_000) throw new Error('topic-worktree measurement: deadline reached');
    return SafeGitExecutor.readSync(args, { cwd, encoding: 'utf-8', timeout: t, operation: 'src/monitoring/topicWorktreeMeasure.ts' }) as string;
  });
  const runGh: RunGh | undefined = input.runGh ?? (input.githubMergeCheck ? makeCappedRunGh(left) : undefined);
  const topicDir = path.join(input.stateDir, 'worktrees');
  const topicReal = real(topicDir);
  const plan: TopicWorktreePlan = {
    at: now(), partial: false,
    eligible: { count: 0, bytes: 0 }, eligibleIfMarkedDepsAccepted: { count: 0, bytes: 0 }, eligibleIfUnmarkedDepsAccepted: { count: 0, bytes: 0 },
    audit: { agrees: 0, disagrees: 0, couldNotVerify: 0 },
    kept: {}, outOfScope: {}, notMeasured: 0, falseEligibility: { count: 0, paths: [] }, lookupsUsed: 0,
  };
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  const rowsFile = path.join(input.stateDir, 'local-state', 'topic-worktree-plan.json');
  const falseFile = path.join(input.stateDir, 'local-state', 'topic-worktree-false-eligibility.jsonl');
  const rows: Array<Record<string, unknown>> = [];
  const persist = () => {
    try { fs.mkdirSync(path.dirname(rowsFile), { recursive: true }); fs.writeFileSync(rowsFile, JSON.stringify({ plan, rows }, null, 1)); }
    catch { /* @silent-fallback-ok — the plan still returns in the result file; the per-entry file is a bonus */ }
  };

  // Registered linked worktrees under the topic folder.
  let registered: Array<{ path: string; branch: string | null; headSha: string }>;
  try { registered = parsePorcelainWorktrees(readGit(['-C', input.projectDir, 'worktree', 'list', '--porcelain'], input.projectDir)).filter((w) => real(w.path).startsWith(topicReal + path.sep)); }
  catch { plan.partial = true; plan.notMeasured = -1; persist(); return plan; }
  const registeredReal = new Set(registered.map((w) => real(w.path)));
  try {
    for (const name of fs.readdirSync(topicDir)) {
      const p = path.join(topicDir, name);
      if (name.startsWith('.') || registeredReal.has(real(p))) continue;
      let isClone = false;
      try { isClone = fs.statSync(path.join(p, '.git')).isDirectory(); } catch { isClone = false; } // @silent-fallback-ok — no .git dir ⇒ not a clone
      try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; } // @silent-fallback-ok — vanished mid-listing
      bump(plan.outOfScope, isClone ? 'clone' : 'hand-made');
    }
  } catch { /* @silent-fallback-ok — no topic folder: nothing out of scope to count */ }

  // Provenance must match THIS machine's WorktreeManager id; without it, every entry is unprovable.
  const provenance = input.worktreeMachineId ? readBindingProvenance(input.stateDir, input.worktreeMachineId) : null;
  const sessionCwds = readRunningSessionCwds(input.stateDir);
  const deps = makeAgentWorktreeReaperDeps({
    instarRepo: input.projectDir, worktreesDir: topicDir, agentHome: input.agentHome,
    linkedWorktreeDirs: [path.join(input.agentHome, '.worktrees')], ignoreSessionLockFile: true,
    githubMergeCheck: input.githubMergeCheck, readGit, ...(runGh ? { runGh } : {}),
    linkIndexTimeoutMs: Math.max(1_000, Math.floor(left())),
  });
  await deps.preparePass?.();
  const base = resolveBaseRef(readGit, input.projectDir);
  const baseBranch = base ? (base.includes('/') ? base.slice(base.indexOf('/') + 1) : base) : null;
  let squashMap: Map<string, { head: string; mergeCommit: string | null }> | null = null;
  const squashLookup = (branch: string): { head: string; mergeCommit: string | null } | null => {
    if (!input.githubMergeCheck || !runGh || !baseBranch) return null;
    if (!squashMap) {
      squashMap = new Map();
      const out = runGh(['pr', 'list', '--state', 'merged', '--base', baseBranch, '--json', 'headRefName,headRefOid,mergeCommit,baseRefName', '--limit', '500'], input.projectDir);
      try {
        for (const r of JSON.parse(out ?? '[]') as Array<{ headRefName?: string; headRefOid?: string; baseRefName?: string; mergeCommit?: { oid?: string } | null }>) {
          if (r.baseRefName !== baseBranch || !r.headRefName || !r.headRefOid || squashMap.has(r.headRefName)) continue;
          squashMap.set(r.headRefName, { head: r.headRefOid, mergeCommit: r.mergeCommit?.oid ?? null });
        }
      } catch { /* @silent-fallback-ok — no map ⇒ squash merges read could-not-verify */ }
    }
    const hit = squashMap.get(branch);
    if (hit) return hit;
    if (plan.lookupsUsed >= 20) return null;
    plan.lookupsUsed++;
    const out = runGh(['pr', 'list', '--state', 'merged', '--base', baseBranch, '--head', branch, '--json', 'headRefName,headRefOid,mergeCommit,baseRefName', '--limit', '5'], input.projectDir);
    try {
      const r = (JSON.parse(out ?? '[]') as Array<{ headRefOid?: string; baseRefName?: string; mergeCommit?: { oid?: string } | null }>).find((x) => x.baseRefName === baseBranch && x.headRefOid);
      return r ? { head: r.headRefOid!, mergeCommit: r.mergeCommit?.oid ?? null } : null;
    } catch { return null; } // @silent-fallback-ok — unreadable lookup ⇒ could-not-verify
  };

  for (let i = 0; i < registered.length; i++) {
    if (now() >= input.deadlineAt) { plan.partial = true; plan.notMeasured = registered.length - i; break; }
    const w = registered[i];
    const p = real(w.path);
    const row: Record<string, unknown> = { path: p, branch: w.branch, head: w.headSha };
    rows.push(row);
    try {
      if (provenance === null) { bump(plan.outOfScope, 'provenance-unreadable'); row.result = 'out-of-scope:provenance-unreadable'; continue; }
      if (!provenance.has(p)) { bump(plan.outOfScope, 'no-provenance-record'); row.result = 'out-of-scope:no-provenance-record'; continue; }
      if (sessionCwds === null || sessionCwds.some((c) => c === p || c.startsWith(p + path.sep)) || deps.isInUse(w.path)) { bump(plan.kept, 'in-use'); row.result = 'kept:in-use'; continue; }
      if (!fs.existsSync(path.join(w.path, '.instar', 'session-context.json'))) { bump(plan.kept, 'creating'); row.result = 'kept:creating'; continue; }
      if (!w.branch) { bump(plan.kept, 'detached'); row.result = 'kept:detached'; continue; }
      const statusArgs = ['-C', w.path, 'status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all'];
      const res = classifyStatus(readGit(statusArgs, w.path), w.path);
      // git does not list an empty or fully-ignored folder reliably; read the copy directly.
      try { const st = fs.lstatSync(path.join(w.path, 'node_modules')); if (st.isDirectory() && !st.isSymbolicLink()) res.realDeps = true; } catch { /* @silent-fallback-ok — no node_modules here */ }
      if (res.work.length) { bump(plan.kept, 'work-files'); row.result = 'kept:work-files'; continue; }
      if (!deps.isMerged({ path: w.path, branch: w.branch, headSha: w.headSha })) { bump(plan.kept, 'unmerged'); row.result = 'kept:unmerged'; continue; }
      let bucket: 'eligible' | 'eligibleIfMarkedDepsAccepted' | 'eligibleIfUnmarkedDepsAccepted' = 'eligible';
      if (res.realDeps) {
        let lockEqual = false;
        try {
          lockEqual = !!base && readGit(['-C', w.path, 'rev-parse', `${base}:package-lock.json`], w.path).trim() === readGit(['-C', w.path, 'hash-object', 'package-lock.json'], w.path).trim();
        } catch { lockEqual = false; } // @silent-fallback-ok — no comparable lock file ⇒ the copy is not provably rebuildable
        if (!lockEqual) { bump(plan.kept, 'deps-lock-differs'); row.result = 'kept:deps-lock-differs'; continue; }
        bucket = fs.existsSync(path.join(w.path, 'node_modules', DEPS_COPY_MARKER)) ? 'eligibleIfMarkedDepsAccepted' : 'eligibleIfUnmarkedDepsAccepted';
      }
      // Audit (spec table): a fresh status, plus a merge check that does not reuse the verdict.
      const fresh = classifyStatus(readGit(statusArgs, w.path), w.path);
      let audit: 'agrees' | 'disagrees' | 'could-not-verify';
      let auditWhy = '';
      if (fresh.work.length) { audit = 'disagrees'; auditWhy = `fresh status shows work: ${fresh.work.slice(0, 3).join(', ')}`; }
      else {
        let ancestor = false;
        try { readGit(['-C', input.projectDir, 'merge-base', '--is-ancestor', w.headSha, base ?? 'HEAD'], input.projectDir); ancestor = !!base; } catch { ancestor = false; } // @silent-fallback-ok — non-zero exit means not an ancestor
        const pr = ancestor ? null : squashLookup(w.branch);
        if (ancestor) { audit = 'agrees'; auditWhy = 'ancestor of base'; }
        else if (!(pr && pr.head === w.headSha)) {
          // Not an ancestor and no exact-OID merged PR: patch-equivalence is the only remaining
          // basis, and nothing independent of `git cherry` can check it.
          if (base && isBranchMerged(readGit, input.projectDir, base, w.headSha)) { audit = 'could-not-verify'; auditWhy = 'patch-equivalent, no independent check'; }
          else if (plan.lookupsUsed >= 20 && !pr) { audit = 'could-not-verify'; auditWhy = 'lookup budget used'; }
          else { audit = 'disagrees'; auditWhy = 'not an ancestor, no exact merged PR, not patch-equivalent'; }
        } else if (!pr.mergeCommit) { audit = 'could-not-verify'; auditWhy = 'merge commit unavailable'; }
        else {
          {
            try {
              const mb = readGit(['-C', input.projectDir, 'merge-base', pr.mergeCommit + '^', w.headSha], input.projectDir).trim();
              const paths = readGit(['-C', input.projectDir, 'diff', '--name-only', mb, w.headSha], input.projectDir).split('\n').filter(Boolean);
              const same = normalizedDiff(readGit, input.projectDir, mb, w.headSha, paths) === normalizedDiff(readGit, input.projectDir, pr.mergeCommit + '^', pr.mergeCommit, paths);
              if (same) { audit = 'agrees'; auditWhy = 'squash: patch matches the merge commit (corroborated)'; }
              else {
                const mainTouched = readGit(['-C', input.projectDir, 'diff', '--name-only', mb, pr.mergeCommit + '^', '--', ...paths], input.projectDir).trim() !== '';
                audit = mainTouched ? 'could-not-verify' : 'disagrees';
                auditWhy = mainTouched ? 'patches differ on paths main also changed' : 'patches differ';
              }
            } catch { audit = 'could-not-verify'; auditWhy = 'merge commit not available locally'; } // @silent-fallback-ok — missing objects ⇒ unverified, never "agrees"
          }
        }
      }
      plan.audit[audit === 'agrees' ? 'agrees' : audit === 'disagrees' ? 'disagrees' : 'couldNotVerify']++;
      row.audit = audit; row.auditWhy = auditWhy;
      if (audit === 'disagrees') {
        plan.falseEligibility.count++;
        if (plan.falseEligibility.paths.length < 5) plan.falseEligibility.paths.push(p);
        try { fs.mkdirSync(path.dirname(falseFile), { recursive: true }); fs.appendFileSync(falseFile, JSON.stringify({ at: new Date(now()).toISOString(), path: p, branch: w.branch, head: w.headSha, bucket, why: auditWhy }) + '\n'); }
        catch { /* @silent-fallback-ok — the count is still in the plan */ }
      }
      const left = input.deadlineAt - now();
      const bytes = left > 1_000 ? await input.sizeOf(w.path, Math.min(left, 60_000)) : null;
      plan[bucket].count++;
      plan[bucket].bytes = bytes === null || plan[bucket].bytes === null ? null : (plan[bucket].bytes as number) + bytes;
      row.result = bucket; row.bytes = bytes;
    } catch (err) {
      bump(plan.kept, 'eval-error'); row.result = 'kept:eval-error'; row.error = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
    } finally {
      persist();
    }
  }
  persist();
  return plan;
}
