/**
 * Triage input packet (docs/specs/feedback-triage-and-execution.md §1, "Input packet").
 *
 * Every text field is scrubbed with scrubForStore (called directly, so it is never a dry-run
 * no-op) and carried as untrusted evidence. Cutting is never silent: an in-band marker names
 * exactly what is missing.
 */
import { scrubForStore } from '../../core/durableSecretScrub.js';
import type { Cluster, FeedbackItem } from '../processor/types.js';
import { jaccardSimilarity } from '../processor/similarity.js';
import { KEYWORD_FLOOR } from './triageFloors.js';

export interface TriagePacketOptions {
  reportsPerItem: number;
  charsPerReport: number;
}

export interface NeighbourInfo { clusterId: string; title: string; disposition: string | null }

export interface TriagePacket {
  clusterId: string;
  title: string;
  type: string;
  reportCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  recurrenceCount: number;
  reports: Array<{ n: number; receivedAt: string | null; description: string }>;
  truncation: string | null;
  neighbours: NeighbourInfo[];
  /** Merged PRs carrying the exact cluster id or a member feedback id; 'unknown' when gh failed. */
  mergedPrs: Array<{ number: string; title: string }> | 'unknown';
  holdHistory?: { holds: number; lastReason: string | null };
  operatorOverride?: string | null;
}

export interface BuiltPacket {
  packet: TriagePacket;
  truncated: boolean;
  credentialShaped: boolean;
  keywordFloor: boolean;
  /** Bare PR numbers the exact-id match found (floor 6), or null when unknown. */
  exactIdPrs: Set<string> | null;
  chars: number;
}

export interface MergedPr { number: number; title: string; body: string; commits: string[] }

const SCRUB_MAX = 64 * 1024;

function scrub(text: string): { text: string; credential: boolean; withheld: boolean } {
  const result = scrubForStore(text, { maxBytes: SCRUB_MAX });
  if (result.error) return { text: '[evidence withheld: scrub failed]', credential: true, withheld: true };
  const credential = (result.redactions ?? []).some((r) => r.kind !== 'oversize' && r.kind !== 'scrub-error');
  // An oversize field is replaced wholesale: the evidence is missing, which is a cut like any other.
  const withheld = result.truncated === true || (result.redactions ?? []).some((r) => r.kind === 'oversize');
  return { text: result.text, credential, withheld };
}

function line(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** Keep the head and tail of a long report; return the cut size. */
function cutMiddle(text: string, budget: number): { text: string; removed: number } {
  if (text.length <= budget) return { text, removed: 0 };
  const head = Math.round(budget * 2 / 3);
  const tail = budget - head;
  return { text: `${text.slice(0, head)} … ${text.slice(text.length - tail)}`, removed: text.length - budget };
}

/**
 * Build the evidence packet for one item. `alone` gives the item a whole batch (floor 4 re-try):
 * more reports fit and each may use the full budget.
 */
export function buildTriagePacket(input: {
  cluster: Cluster;
  reports: readonly FeedbackItem[];
  neighbours: NeighbourInfo[];
  mergedPrs: readonly MergedPr[] | null;
  options: TriagePacketOptions;
  alone?: { maxChars: number };
  holdHistory?: { holds: number; lastReason: string | null };
  operatorOverride?: string | null;
  now: number;
}): BuiltPacket {
  const { cluster, reports, options } = input;
  const ordered = [...reports].sort((a, b) => String(a.receivedAt ?? '').localeCompare(String(b.receivedAt ?? '')));
  const total = ordered.length;
  const maxReports = input.alone
    ? Math.max(options.reportsPerItem, Math.floor(input.alone.maxChars / Math.max(200, options.charsPerReport)))
    : options.reportsPerItem;
  // Newest first, plus the first-ever report.
  const chosen: Array<{ item: FeedbackItem; n: number }> = [];
  if (total > 0) {
    const newest = ordered.slice().reverse().slice(0, Math.max(1, maxReports - 1)).map((item) => ({ item, n: ordered.indexOf(item) + 1 }));
    chosen.push(...newest);
    if (!chosen.some((c) => c.n === 1)) chosen.push({ item: ordered[0], n: 1 });
    while (chosen.length > maxReports) chosen.splice(chosen.length - 2, 1);
  }
  const perReport = input.alone ? Math.max(options.charsPerReport, Math.floor(input.alone.maxChars / Math.max(1, chosen.length))) : options.charsPerReport;
  let credential = false;
  let keyword = KEYWORD_FLOOR.test(String(cluster.title ?? '')) || KEYWORD_FLOOR.test(String(cluster.description ?? ''));
  const cuts: string[] = [];
  const outReports = chosen.map(({ item, n }) => {
    const raw = `${line(item.title, 240)}\n${String(item.description ?? '')}`;
    if (KEYWORD_FLOOR.test(raw)) keyword = true;
    const scrubbed = scrub(raw);
    credential ||= scrubbed.credential;
    if (scrubbed.withheld) {
      cuts.push(`report ${n}: all ${raw.length} chars withheld`);
      return { n, receivedAt: item.receivedAt ? line(item.receivedAt, 40) : null, description: scrubbed.text.slice(0, perReport) };
    }
    const cut = cutMiddle(scrubbed.text, perReport);
    if (cut.removed > 0) cuts.push(`report ${n}: middle ${cut.removed} of ${scrubbed.text.length} chars removed`);
    return { n, receivedAt: item.receivedAt ? line(item.receivedAt, 40) : null, description: cut.text };
  });
  const parts: string[] = [];
  if (chosen.length < total) parts.push(`showing ${chosen.length} of ${total} reports`);
  parts.push(...cuts);
  const truncation = parts.length ? `[evidence truncated: ${parts.join('; ')}]` : null;

  const titleScrub = scrub(line(cluster.title, 240));
  credential ||= titleScrub.credential;
  const memberIds = new Set(ordered.map((item) => String(item.feedbackId)));
  let exactIdPrs: Set<string> | null = null;
  let mergedPrs: TriagePacket['mergedPrs'] = 'unknown';
  if (input.mergedPrs) {
    exactIdPrs = new Set();
    mergedPrs = [];
    for (const pr of input.mergedPrs) {
      const haystack = `${pr.body}\n${pr.commits.join('\n')}`;
      const hit = haystack.includes(cluster.clusterId) || [...memberIds].some((id) => id.length >= 6 && haystack.includes(id));
      if (!hit) continue;
      exactIdPrs.add(String(pr.number));
      mergedPrs.push({ number: String(pr.number), title: scrub(line(pr.title, 160)).text });
    }
  }
  const time = (value: unknown) => { const t = Date.parse(String(value ?? '')); return Number.isFinite(t) ? new Date(t).toISOString() : new Date(input.now).toISOString(); };
  const packet: TriagePacket = {
    clusterId: line(cluster.clusterId, 200),
    title: titleScrub.text,
    type: line(cluster.type ?? 'unknown', 40),
    reportCount: Math.max(0, Math.trunc(Number(cluster.reportCount ?? total))),
    firstSeenAt: time(cluster.createdAt),
    lastSeenAt: time(cluster.updatedAt ?? cluster.createdAt),
    recurrenceCount: Math.max(0, Math.trunc(Number(cluster.recurrenceCount ?? 0))),
    reports: outReports,
    truncation,
    neighbours: input.neighbours.slice(0, 8).map((n) => ({ clusterId: line(n.clusterId, 200), title: scrub(line(n.title, 200)).text, disposition: n.disposition })),
    mergedPrs,
    ...(input.holdHistory ? { holdHistory: input.holdHistory } : {}),
    ...(input.operatorOverride ? { operatorOverride: line(input.operatorOverride, 200) } : {}),
  };
  return { packet, truncated: truncation !== null, credentialShaped: credential, keywordFloor: keyword, exactIdPrs, chars: JSON.stringify(packet).length };
}

/** Up to 8 nearest active clusters by the existing title-similarity function. */
export function nearestNeighbours(cluster: Cluster, candidates: readonly Cluster[], dispositionOf: (clusterId: string) => string | null): NeighbourInfo[] {
  return candidates
    .filter((other) => other.clusterId !== cluster.clusterId)
    .map((other) => ({ other, score: jaccardSimilarity(String(cluster.title ?? ''), String(other.title ?? '')) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.other.clusterId.localeCompare(b.other.clusterId))
    .slice(0, 8)
    .map(({ other }) => ({ clusterId: other.clusterId, title: String(other.title ?? ''), disposition: dispositionOf(other.clusterId) }));
}
