#!/usr/bin/env node
/**
 * Publish this checkout's console pages as the agent's dashboard preview
 * (served at /dashboard/preview/ by the running server, no merge or release).
 *
 *   node scripts/publish-dashboard-preview.mjs --state-dir <agent>/.instar [--source dashboard/console]
 *
 * Needs a build (dist/) of this checkout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { publishDashboardPreview } from '../dist/server/dashboardPreview.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const stateDir = opt('--state-dir');
if (!stateDir) { console.error('usage: publish-dashboard-preview.mjs --state-dir <agent>/.instar [--source dashboard/console]'); process.exit(2); }
const source = path.resolve(opt('--source') || 'dashboard/console');
// Which work this is, read from the checkout's git files (no git process).
function gitInfo() {
  try {
    let gitDir = path.resolve('.git');
    if (fs.statSync(gitDir).isFile()) gitDir = path.resolve(fs.readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim());
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return { branch: null, commit: head.slice(0, 9) };
    const ref = head.slice(5);
    const common = fs.existsSync(path.join(gitDir, 'commondir'))
      ? path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()) : gitDir;
    let sha = null;
    for (const d of [gitDir, common]) { try { sha = fs.readFileSync(path.join(d, ref), 'utf8').trim(); break; } catch { /* try next */ } }
    if (!sha) {
      try { const line = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(' ' + ref)); sha = line ? line.split(' ')[0] : null; } catch { /* none */ }
    }
    return { branch: ref.replace(/^refs\/heads\//, ''), commit: sha ? sha.slice(0, 9) : null };
  } catch { return { branch: null, commit: null }; }
}
const g = gitInfo();
const meta = {
  branch: opt('--branch') || g.branch,
  commit: g.commit,
  // Whether the files include uncommitted edits is not checked here.
  uncommitted: null,
  publishedAt: new Date().toISOString(),
};
const dir = publishDashboardPreview(path.resolve(stateDir), source, meta);
console.log(`Published ${source} to ${dir} (${meta.branch || 'unknown branch'} ${meta.commit || ''})`);
