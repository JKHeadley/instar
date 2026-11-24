// The Repositories page model (docs/specs/no-data-loss-on-machine-death.md §1.4, §1.7). Pure: it reads
// nothing itself and touches no DOM. One answer (GET /repos?scope=pool) feeds both this page and the
// Needs-you list (needs-model.js), so the two cannot disagree.

import { sourceState } from './development-model.js';

export const REPOS_PAGE = '#/capacity/repos';
export const REPOS_READ = '/repos?scope=pool';

const KIND_ORDER = { 'no-remote': 0, unpushed: 1, unknown: 2 };

/** What to ask the agent for one defect: plain words, carried in the ask link. */
export function defectAsk(d) {
  if (!d || typeof d !== 'object') return '';
  if (d.kind === 'no-remote') return `Make sure these repositories on ${d.machineName} have a copy off that machine: ${(d.repos || []).slice(0, 5).join(', ')}`;
  if (d.kind === 'unpushed') return `Copy the unpushed branches on ${d.machineName} somewhere off that machine`;
  return `Why can't you check the repositories on ${d.machineName}?`;
}

export function askHref(d) {
  return `#/work/sessions?ask=${encodeURIComponent(defectAsk(d))}`;
}

function validDefect(d) {
  return d && typeof d === 'object' && typeof d.key === 'string' && /^repos:(no-remote|unpushed|unknown):/.test(d.key)
    && typeof d.title === 'string' && typeof d.machineId === 'string';
}

/**
 * Needs-you rows: one per defect (aggregated per machine per kind on the server). A 503 = the
 * registry is switched off here = nothing waiting; any other failure or a 200 of the wrong shape
 * is unreadable (null), never "nothing waiting".
 */
export function repoNeedRows(res) {
  if (!res) return null;
  if (!res.ok) return sourceState(res) === 'off' ? [] : null;
  const d = res.data;
  if (!d || typeof d !== 'object' || !Array.isArray(d.defects)) return null;
  return d.defects.filter(validDefect)
    .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9))
    .map((x) => ({ key: x.key, machineName: typeof x.machineName === 'string' ? x.machineName : '', main: x.title, sub: typeof x.detail === 'string' ? x.detail : '', kind: x.kind, href: `${REPOS_PAGE}?s=${encodeURIComponent(x.key)}`, refs: Array.isArray(x.repos) ? x.repos.slice(0, 8).map(String) : [] }));
}

function repoLine(r) {
  const parts = [];
  if (r.state === 'unknown') return 'Could not read it.';
  const remotes = Array.isArray(r.remotes) ? r.remotes.filter((x) => x && x.offMachine) : [];
  parts.push(remotes.length ? `Copied to ${remotes.map((x) => [x.host, x.ownerAccount].filter(Boolean).join('/')).join(', ')}` : 'No copy anywhere else (no remote)');
  const sc = r.singleCopy || {};
  if (sc.branches > 0) parts.push(`${sc.approximate ? 'about ' : ''}${sc.branches} branch${sc.branches === 1 ? '' : 'es'} only here`);
  else if (sc.commits > 0) parts.push(`${sc.approximate ? 'about ' : ''}${sc.commits} commit${sc.commits === 1 ? '' : 's'} only here`);
  const u = r.uncommitted;
  if (u && typeof u === 'object' && u.files > 0) parts.push(`${u.files} uncommitted file${u.files === 1 ? '' : 's'}`);
  else if (u === true) parts.push('uncommitted changes');
  return `${parts.join(' · ')}.`;
}

/** The page: defects first, then each machine's repositories (single-copy first). */
export function buildReposPage(res) {
  if (!res || !res.ok) {
    if (res && sourceState(res) === 'off') return { ok: false, off: true, reason: 'The repository list is switched off on this agent.' };
    return { ok: false, reason: (res && res.reason) ? `I couldn’t read the repository list: ${res.reason}.` : 'I couldn’t read the repository list.' };
  }
  const d = res.data;
  if (!d || typeof d !== 'object' || !Array.isArray(d.defects)) return { ok: false, reason: 'The repository list came back in a shape I can’t read.' };
  const needs = repoNeedRows(res) || [];
  const machines = (Array.isArray(d.machines) ? d.machines : [{ machineId: d.machineId, machineName: d.machineName, source: 'self', repos: d.repos || [] }])
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      id: String(m.machineId || ''),
      name: String(m.machineName || m.machineId || 'a machine'),
      source: m.source,
      note: m.source === 'unknown' ? 'I couldn’t reach it and have nothing it shared, so I can’t say what is there.' : m.source === 'replicated' ? 'Unreachable just now: this is what it last shared.' : m.error === 'switched-off' ? 'The repository list is switched off there.' : '',
      repos: (Array.isArray(m.repos) ? m.repos : []).filter((r) => r && typeof r.displayPath === 'string')
        // warning-exempt: a listing line; the defect it belongs to leads the page as a need card with its ask link
        .map((r) => ({ path: r.displayPath, line: repoLine(r), alone: !r.hasOffMachineRemote || (r.singleCopy && r.singleCopy.commits > 0), tone: r.state === 'unknown' ? 'unknown' : (!r.hasOffMachineRemote || r.pastGrace) ? 'attn' : 'ok' }))
        .sort((a, b) => Number(b.alone) - Number(a.alone) || a.path.localeCompare(b.path)),
    }));
  const total = machines.reduce((n, m) => n + m.repos.length, 0);
  const headline = needs.length ? (needs.length === 1 ? needs[0].main : `${needs.length} things need copying off a machine`) : total ? 'Every repository has a copy somewhere else' : 'No repositories found yet';
  // warning-exempt: the headline restates the need cards that lead the page, and each card carries its ask link
  return { ok: true, headline, tone: needs.length ? 'attn' : 'ok', needs, machines, total, scan: d.scan || null };
}
