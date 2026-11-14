/**
 * ChiefOfStaffTriage — the one-time first-run triage list (docs/specs/chief-of-staff-topic.md,
 * "Migration and rollout → First run (one time): triage").
 *
 * A pure, deterministic read over the active Initiative Tracker records that recommends, per record,
 * `keep` (draft a binding and track it), `review` (the owner decides) or `archive`, with the reason
 * stated from facts on the record — last touch, blockers, whether anything needs the owner, links. It
 * never writes: the route renders the markdown into a private view, and the owner's approval of the
 * list (one tap per row in the pilot) is what starts the pilot bindings. Floors: a record that needs
 * the owner or was touched within `keepWithinDays` is never recommended for archive.
 */

import { mergeDefaults } from './mergeDefaults.js';

export interface TriageInput {
  id: string;
  title: string;
  description?: string;
  status: string;
  lastTouchedAt: string;
  needsUser?: boolean;
  needsUserReason?: string;
  blockers?: string[];
  links?: Array<{ type?: string; url?: string; label?: string; id?: string }>;
}

export type TriageRecommendation = 'keep' | 'review' | 'archive';

export interface TriageRow {
  id: string;
  title: string;
  status: string;
  ageDays: number | null;
  recommendation: TriageRecommendation;
  reason: string;
  /** A one-paragraph goal draft for `keep` rows (the description, bounded), for the binding draft. */
  goalDraft: string | null;
  linkedRepos: string[];
}

export interface TriageOptions { keepWithinDays?: number; archiveAfterDays?: number }

const DEFAULTS: Required<TriageOptions> = { keepWithinDays: 14, archiveAfterDays: 45 };

function ageDaysOf(iso: string, now: Date): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / 86_400_000)) : null;
}

function reposOf(links: TriageInput['links']): string[] {
  const out = new Set<string>();
  for (const l of links ?? []) {
    const m = /github\.com\/([\w.-]+\/[\w.-]+)/i.exec(String(l.url ?? ''));
    if (m) out.add(m[1].replace(/\.git$/, ''));
  }
  return [...out].sort();
}

export function triageInitiative(i: TriageInput, now: Date, opts: TriageOptions = {}): TriageRow {
  const o = mergeDefaults(DEFAULTS, opts);
  const age = ageDaysOf(i.lastTouchedAt, now);
  const blockers = (i.blockers ?? []).filter((b) => typeof b === 'string' && b.trim());
  const repos = reposOf(i.links);
  const goalDraft = typeof i.description === 'string' && i.description.trim() ? i.description.trim().slice(0, 400) : null;
  let recommendation: TriageRecommendation; let reason: string;
  if (i.needsUser) { recommendation = 'keep'; reason = `needs you${i.needsUserReason ? `: ${i.needsUserReason.slice(0, 120)}` : ''}`; }
  else if (age !== null && age <= o.keepWithinDays) { recommendation = 'keep'; reason = `touched ${age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} ago`}${repos.length ? `; lands in ${repos.join(', ')}` : ''}`; }
  else if (age !== null && age >= o.archiveAfterDays && blockers.length === 0) { recommendation = 'archive'; reason = `untouched for ${age} days, no blockers${repos.length ? '' : ', no linked repo'}`; }
  else if (age === null) { recommendation = 'review'; reason = 'no readable last-touch time'; }
  else { recommendation = 'review'; reason = `untouched for ${age} days${blockers.length ? `; ${blockers.length} blocker${blockers.length === 1 ? '' : 's'} recorded` : ''}`; }
  return { id: i.id, title: i.title, status: i.status, ageDays: age, recommendation, reason, goalDraft: recommendation === 'keep' ? goalDraft : null, linkedRepos: repos };
}

export interface TriageList { rows: TriageRow[]; counts: Record<TriageRecommendation, number>; markdown: string; generatedAt: string }

export function buildTriage(initiatives: TriageInput[], now: Date, opts: TriageOptions = {}): TriageList {
  const rows = initiatives.map((i) => triageInitiative(i, now, opts));
  const order: Record<TriageRecommendation, number> = { keep: 0, review: 1, archive: 2 };
  rows.sort((a, b) => order[a.recommendation] - order[b.recommendation] || (a.ageDays ?? 1e9) - (b.ageDays ?? 1e9) || a.title.localeCompare(b.title));
  const counts: Record<TriageRecommendation, number> = { keep: 0, review: 0, archive: 0 };
  for (const r of rows) counts[r.recommendation]++;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const section = (rec: TriageRecommendation, title: string, lead: string) => {
    const list = rows.filter((r) => r.recommendation === rec);
    if (!list.length) return '';
    const head = `## ${title} (${list.length})\n\n${lead}\n\n| Project | Last touched | Why |\n|---|---|---|\n`;
    return head + list.map((r) => `| ${esc(r.title)} | ${r.ageDays === null ? 'unknown' : r.ageDays === 0 ? 'today' : `${r.ageDays}d ago`} | ${esc(r.reason)} |`).join('\n') + '\n\n';
  };
  const markdown =
    `# Chief of Staff — first-run triage\n\n` +
    `_${initiatives.length} active records read on ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC. Nothing here has been changed; this is my recommendation for what the Chief of Staff should track. ` +
    `Approve the Keep rows (or move rows between sections) and I will draft a binding for each kept project: a one-paragraph goal, the repos the work lands in, and a done checklist._\n\n` +
    section('keep', 'Keep — track with a drafted binding', 'Recently active or waiting on you.') +
    section('review', 'Review — you decide', 'Quiet for a while, or blocked; worth a look before tracking or archiving.') +
    section('archive', 'Archive — untouched and unblocked', 'Nothing has moved here for a long time and nothing is recorded as blocking it.');
  return { rows, counts, markdown: markdown.trim() + '\n', generatedAt: now.toISOString() };
}
