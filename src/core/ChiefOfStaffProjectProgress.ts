import type { BoundProject } from './ChiefOfStaffLoop.js';
import type { Initiative } from './InitiativeTracker.js';
import type { GhExec } from './ChiefOfStaffEvidence.js';
import type { LocalVerifyRecord } from '../localVerify/record.js';

const HOUR_MS = 3_600_000;
const STALL_MS = 6 * HOUR_MS;

export type VerifiedProgressKind = 'merge' | 'full-test-pass' | 'done-item';
export interface VerifiedProgress {
  at: string;
  kind: VerifiedProgressKind;
}

export interface ProjectProgressStatus {
  lastProgressAt: string | null;
  lastProgressKind: VerifiedProgressKind | null;
  waitingOn: string[];
  stalledSince: string | null;
  progressCheckedAt: string | null;
  progressEvidenceComplete: boolean;
}

interface PullProgressDeps {
  gh: GhExec | null;
  verify: (pr: number, headSha: string, baseRefName: string) => LocalVerifyRecord | null;
  verifyAvailable: () => boolean;
  evaluateDoneItem?: (item: BoundProject['doneDefinition'][number], project: BoundProject, deadline: number) => Promise<'pass' | 'fail' | 'unknown'>;
}

export async function readProgressWithin<T>(deadline: number, read: () => Promise<T>, unavailable: T): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return unavailable;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(unavailable), remaining); }),
    ]);
  } catch {
    return unavailable;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readProjectEvidencePage(url: URL, deadline = performance.now() + 10_000): Promise<string | null> {
  const remaining = Math.min(10_000, deadline - performance.now());
  if (remaining <= 0) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), remaining);
  try {
    const response = await fetch(url, { signal: ctl.signal });
    if (!response.ok || !response.body) { ctl.abort(); return null; }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > 256 * 1024) { ctl.abort(); return null; }
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function projectProgressStatus(
  now: number,
  baseline: string | null,
  evidence: readonly VerifiedProgress[],
  waitingOn: string[],
  sampledAt: number | null,
  complete: boolean,
): ProjectProgressStatus {
  const latest = evidence.reduce<VerifiedProgress | null>((best, row) => {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || at > now || (best && at <= Date.parse(best.at))) return best;
    return row;
  }, null);
  const start = Math.max(Date.parse(baseline ?? '') || 0, Date.parse(latest?.at ?? '') || 0);
  const fresh = complete && sampledAt !== null && now - sampledAt <= HOUR_MS;
  return {
    lastProgressAt: latest?.at ?? null,
    lastProgressKind: latest?.kind ?? null,
    waitingOn,
    stalledSince: fresh && start > 0 && now >= start + STALL_MS ? new Date(start + STALL_MS).toISOString() : null,
    progressCheckedAt: sampledAt === null ? null : new Date(sampledAt).toISOString(),
    progressEvidenceComplete: fresh,
  };
}

export function matchProgressProject(project: BoundProject, entries: readonly Initiative[]): Initiative | null {
  const projects = entries.filter((entry) => entry.kind === 'project');
  if (project.initiativeId) {
    const exact = projects.find((entry) => entry.id === project.initiativeId);
    return exact ?? null;
  }
  const matches = projects.filter((entry) => entry.telegramTopicId && project.conversationKey === `telegram:${entry.telegramTopicId}`);
  return matches.length === 1 ? matches[0]! : null;
}

function linkedPull(child: Initiative, repos: string[]): { repo: string; pr: number } | null {
  if (!Number.isSafeInteger(child.prNumber) || (child.prNumber ?? 0) < 1) return null;
  const pr = child.prNumber!;
  const explicit = child.links.filter((row) => row.type === 'pr');
  const exact = explicit.map((row) => {
    const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(row.url ?? '');
    return match && Number(match[2]) === pr ? match[1]! : null;
  }).filter((repo): repo is string => repo !== null);
  if (explicit.length !== exact.length) return null;
  const candidates = new Set((exact.length ? exact : repos).map((repo) => repo.toLowerCase()));
  if (candidates.size !== 1) return null;
  const repo = [...candidates][0]!;
  return repos.some((linked) => linked.toLowerCase() === repo) ? { repo, pr } : null;
}

async function readPullProgress(deps: PullProgressDeps, repo: string, pr: number): Promise<VerifiedProgress[] | null> {
  if (!deps.gh) return null;
  const request = deps.gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,baseRefName,mergedAt,state']);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      request,
      new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 5000); }),
    ]);
    if (!result || result.code !== 0) return null;
    // RULE 3: EXEMPT — reads the structured gh --json contract. A failed read yields unknown progress.
    const row = JSON.parse(result.stdout) as { headRefOid?: string; baseRefName?: string; mergedAt?: string; state?: string };
    if (!row.headRefOid || !/^[a-f0-9]{40}$/.test(row.headRefOid) || !row.baseRefName ||
      !['OPEN', 'CLOSED', 'MERGED'].includes(row.state ?? '')) return null;
    const evidence: VerifiedProgress[] = [];
    if (row.state === 'MERGED') {
      if (!row.mergedAt || !Number.isFinite(Date.parse(row.mergedAt))) return null;
      evidence.push({ at: row.mergedAt, kind: 'merge' });
    }
    const record = deps.verify(pr, row.headRefOid, row.baseRefName);
    if (record?.outcome === 'success' && record.repo.toLowerCase() === repo &&
      record.pr === pr && record.headSha === row.headRefOid && record.baseRefName === row.baseRefName &&
      record.lanes.some((lane) => lane.gating && lane.tests > 0) &&
      record.lanes.every((lane) => !lane.gating || lane.failed === 0)) {
      evidence.push({ at: record.finishedAt, kind: 'full-test-pass' });
    }
    return evidence;
  } catch {
    // An unreadable source cannot establish a stall.
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Read exact attached work once per hour. The route never makes provider calls or directs work. */
export interface ProjectProgressEvidence {
  evidence: VerifiedProgress[];
  waitingOn: string[];
  complete: boolean;
  doneItems?: Record<string, 'pass' | 'fail' | 'unknown'>;
}

export function buildProjectProgressReader(deps: PullProgressDeps) {
  const cache = new Map<string, Promise<VerifiedProgress[] | null>>();
  const deadline = performance.now() + 45_000;

  return async (project: BoundProject, entries: readonly Initiative[]): Promise<ProjectProgressEvidence> => {
    const doneItems: NonNullable<ProjectProgressEvidence['doneItems']> = {};
    for (const item of project.doneDefinition) {
      if (item.kind !== 'deterministic') continue;
      doneItems[item.id] = 'unknown';
      if (performance.now() >= deadline || !deps.evaluateDoneItem) continue;
      const evaluate = deps.evaluateDoneItem;
      doneItems[item.id] = await readProgressWithin(deadline, () => evaluate(item, project, deadline), 'unknown');
    }
    const matched = matchProgressProject(project, entries);
    if (!matched) return { evidence: [], waitingOn: [], complete: false, doneItems };
    const childIds = new Set(matched.rounds?.flatMap((round) => round.itemIds) ?? []);
    const children = entries.filter((entry) => childIds.has(entry.id) && entry.parentProjectId === matched.id);
    const waitingOn = [...new Set([matched.needsUser ? matched.needsUserReason : null, ...matched.blockers]
      .filter((reason): reason is string => !!reason))];
    const evidence: VerifiedProgress[] = [];
    let complete = children.length === childIds.size;
    for (const child of children) {
      if (child.prNumber === undefined) continue;
      const ref = linkedPull(child, project.linked.repos);
      const key = ref ? `${ref.repo}#${ref.pr}` : null;
      if (key && ref && performance.now() < deadline && !cache.has(key)) {
        cache.set(key, readProgressWithin(deadline, () => readPullProgress(deps, ref.repo, ref.pr), null));
      }
      const result = key ? await cache.get(key) : null;
      if (!deps.verifyAvailable()) complete = false;
      if (result) evidence.push(...result);
      else complete = false;
    }
    return { evidence, waitingOn, complete, doneItems };
  };
}

export interface ProjectCoverageRow {
  conversationKey: string | null;
  title: string;
  projectIds: string[];
  disposition: 'tracked' | 'awaiting-binding' | 'needs-conversation' | 'ambiguous-membership' | 'chief-of-staff-root';
  progress: ProjectProgressStatus | null;
}

export function buildProjectCoverage(
  tracked: ReadonlyArray<{ conversationKey: string; title: string } & ProjectProgressStatus>,
  projects: readonly Initiative[],
  rootConversationKey: string | null,
): ProjectCoverageRow[] {
  const registeredByKey = new Map<string, Initiative[]>();
  const unbound: ProjectCoverageRow[] = [];
  for (const project of projects) {
    if (!project.telegramTopicId) {
      if (project.status === 'active') unbound.push({
        conversationKey: null, title: project.title, projectIds: [project.id],
        disposition: 'needs-conversation', progress: null,
      });
      continue;
    }
    const key = `telegram:${project.telegramTopicId}`;
    const entries = registeredByKey.get(key) ?? [];
    entries.push(project);
    registeredByKey.set(key, entries);
  }
  const trackedByKey = new Map(tracked.map((row) => [row.conversationKey, row]));
  const rows: ProjectCoverageRow[] = [];
  for (const key of new Set([...trackedByKey.keys(), ...registeredByKey.keys()])) {
    const track = trackedByKey.get(key);
    const entries = registeredByKey.get(key) ?? [];
    if (!track && !entries.some((entry) => entry.status === 'active')) continue;
    const progress = track ? {
      lastProgressAt: track.lastProgressAt, lastProgressKind: track.lastProgressKind,
      waitingOn: track.waitingOn, stalledSince: track.stalledSince,
      progressCheckedAt: track.progressCheckedAt, progressEvidenceComplete: track.progressEvidenceComplete,
    } : null;
    rows.push({
      conversationKey: key,
      title: track?.title ?? entries[0]!.title,
      projectIds: entries.map(({ id }) => id).sort(),
      disposition: entries.length > 1 ? 'ambiguous-membership' :
        key === rootConversationKey ? 'chief-of-staff-root' :
          track ? 'tracked' : 'awaiting-binding',
      progress,
    });
  }
  return [...rows, ...unbound].sort((a, b) => a.title.localeCompare(b.title));
}
