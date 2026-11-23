import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { performance } from 'node:perf_hooks';
import { inspectDesignPolicy, type DesignPolicySnapshot } from './policyInspection.js';

const MAX_BLOB = 2 * 1024 * 1024;
const MAX_DIFF = 4 * 1024 * 1024;
const MAX_PATHS = 2000;
const MAX_TOTAL_READ = 16 * 1024 * 1024;
/** An operational read failure, never clearance or permission to merge. */
class InspectionUnavailable extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Reads only immutable Git objects. Never loads code or configuration from either target tree. */
export async function inspectDesignGitTrees(input: { repo: string; base: string; head: string }) {
  const deadline = performance.now() + 30_000;
  let totalRead = 0;
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  // The executor owns repository/config environment isolation; these flags
  // additionally prohibit replacement objects and implicit promisor fetches.
  const git = (args: string[], maxBuffer = MAX_BLOB): Promise<string> => new Promise((resolve, reject) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) { reject(new InspectionUnavailable('read-deadline')); return; }
    if (totalRead >= MAX_TOTAL_READ) { reject(new InspectionUnavailable('read-capacity')); return; }
    let child: ReturnType<typeof SafeGitExecutor.readStream>;
    try {
      child = SafeGitExecutor.readStream(['--no-replace-objects', '--no-lazy-fetch', '--no-pager', '-c', 'core.fsmonitor=false', ...args],
        { cwd: input.repo, operation: 'design-policy-inspection', env, timeout: remaining, sourceTreeReadOk: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { reject(new InspectionUnavailable('git-read-failed')); return; }
    const cap = Math.min(maxBuffer, MAX_TOTAL_READ - totalRead);
    let bytes = 0, stderrBytes = 0, overBudget = false;
    const chunks: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > cap) { overBudget = true; child.kill('SIGKILL'); return; }
      chunks.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > cap) { overBudget = true; child.kill('SIGKILL'); }
    });
    child.once('error', () => reject(new InspectionUnavailable('git-read-failed')));
    child.once('close', (code, signal) => {
      if (code !== 0 || signal || overBudget) { reject(new InspectionUnavailable('git-read-failed')); return; }
      totalRead += bytes + stderrBytes;
      if (totalRead > MAX_TOTAL_READ) { reject(new InspectionUnavailable('read-capacity')); return; }
      try { resolve(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))); }
      catch { reject(new InspectionUnavailable('git-output-not-utf8')); }
    });
  });
  let baseCommit: string | undefined, headCommit: string | undefined;
  try {
    const resolve = async (ref: string) => {
      if (!ref || ref.includes('\0') || ref.includes('\n')) throw new InspectionUnavailable('invalid-ref');
      const sha = (await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
      if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new InspectionUnavailable('invalid-object-id');
      return sha;
    };
    baseCommit = await resolve(input.base); headCommit = await resolve(input.head);
    const read = async (commit: string, file: string): Promise<string | null> => {
      // Literal pathspec; a repository filename cannot broaden another read.
      const entry = await git(['ls-tree', '-z', commit, '--', `:(literal)${file}`]);
      if (!entry) return null;
      const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(entry);
      if (!match || match[3] !== file) throw new InspectionUnavailable('non-regular-policy-or-source');
      return git(['cat-file', 'blob', match[2]]);
    };
    const snapshot = async (commit: string): Promise<DesignPolicySnapshot> => {
      const standard = await read(commit, 'docs/DESIGN-STANDARD.md');
      const lock = await read(commit, 'docs/design/rule-ids.lock.json');
      const registry = await read(commit, 'docs/design/screens.json');
      if (standard === null || lock === null || registry === null) throw new InspectionUnavailable('policy-missing');
      try { return { standard, lock: JSON.parse(lock), registry: JSON.parse(registry) }; }
      catch { throw new InspectionUnavailable('policy-json-invalid'); }
    };
    const base = await snapshot(baseCommit), head = await snapshot(headCommit);
    const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', baseCommit, headCommit, '--'], MAX_DIFF);
    if (diff && !diff.endsWith('\0')) throw new InspectionUnavailable('diff-incomplete');
    const changedPaths = diff ? diff.slice(0, -1).split('\0') : [];
    if (changedPaths.length > MAX_PATHS) throw new InspectionUnavailable('diff-capacity');
    if (changedPaths.some(file => file.includes('\\') || /[\0\r\n]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..'))) throw new InspectionUnavailable('noncanonical-git-path');
    const sourceText: Record<string, string | null> = Object.create(null);
    for (const file of changedPaths) {
      if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
      // Look at both sides: removing the only HTML marker must not hide a UI edit.
      const before = await read(baseCommit, file), after = await read(headCommit, file);
      sourceText[file] = before === null && after === null ? null : `${before ?? ''}\n${after ?? ''}`;
    }
    if (performance.now() >= deadline) throw new InspectionUnavailable('read-deadline');
    const report = inspectDesignPolicy({ base, head, changedPaths, sourceText });
    if (performance.now() >= deadline) throw new InspectionUnavailable('read-deadline');
    return { ...report, baseCommit, headCommit, changedPaths };
  } catch (error) {
    return { schemaVersion: 1 as const, scope: 'manual-design-policy' as const, mergeAuthority: false as const,
      status: 'unavailable' as const, code: error instanceof InspectionUnavailable ? error.code : 'inspection-failed', baseCommit, headCommit };
  }
}
