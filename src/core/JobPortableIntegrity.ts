/** Admission-time integrity for locally approved imported jobs. */
import fs from 'node:fs';
import path from 'node:path';
import { validJobDependencyPath } from './JobDependency.js';
import { portableVerify } from './JobPortableFs.js';

export function verifyImportedPortableJob(stateDir: string, projectDir: string, slug: string): boolean {
  let journal: { jobs: Record<string, { state?: string; root?: string; expected?: Record<string, string> }> };
  try {
    const raw = fs.readFileSync(path.join(stateDir, 'state', 'job-portable-import-journal.json'), 'utf8');
    if (raw.length > 8 * 1024 * 1024) return false;
    journal = JSON.parse(raw);
    if (!journal || typeof journal.jobs !== 'object') return false;
  } catch (error) { /* @silent-fallback-ok — absent journal means ordinary local job; other errors refuse */ return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  const imported = journal.jobs[slug];
  if (!imported) return true;
  if (fs.existsSync(path.join(stateDir, 'state', 'job-portable-pending', `${slug}.json`))
    || fs.existsSync(path.join(stateDir, 'state', 'job-portable-disarmed.json'))
    || imported.state !== 'active' || !imported.expected) return false;
  try {
    const approvals = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'job-portable-activate-approval.json'), 'utf8'));
    if (approvals?.approvals?.[slug]?.root !== imported.root) return false;
    const project: Record<string, string> = {};
    const state: Record<string, string> = {};
    for (const [file, hash] of Object.entries(imported.expected)) {
      if (!/^[a-f0-9]{64}$/.test(hash)) return false;
      if (file === `.instar/jobs/schedule/${slug}.json` || file === `.instar/jobs/user/${slug}.md`) {
        state[file.slice('.instar/'.length)] = hash;
      } else if (validJobDependencyPath(file)) project[file] = hash;
      else return false;
    }
    if (Object.keys(project).length + Object.keys(state).length === 0
      || Object.keys(project).length + Object.keys(state).length > 64) return false;
    portableVerify(stateDir, state);
    portableVerify(projectDir, project);
    return true;
  } catch { /* @silent-fallback-ok — any integrity error refuses the imported job */ return false; }
}

/** Persist an admission refusal for the coverage alert without exposing paths. */
export function recordImportedPortableIntegrityFailure(stateDir: string, slug: string): void {
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'job-portable-import-journal.json'), 'utf8'));
    const source = journal?.jobs?.[slug]?.source;
    if (typeof source !== 'string' || !/^m_[a-f0-9]{32}$/.test(source)) return;
    const file = path.join(stateDir, 'state', 'job-portable-status.json');
    let jobs: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.length > 128 * 1024) throw new Error('status-oversized');
      const prior = JSON.parse(raw);
      if (prior.version !== 1 || !prior.jobs || typeof prior.jobs !== 'object') throw new Error('status-corrupt');
      jobs = prior.jobs;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    jobs[`${source}:${slug}`] = { state: 'error', reason: 'imported-file-integrity', at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.integrity.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    console.warn('[job-portable] could not persist integrity refusal:', error);
  }
}
