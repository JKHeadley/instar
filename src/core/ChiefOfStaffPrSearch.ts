import { createHash, randomUUID } from 'node:crypto';
import { PUBLIC_PR_AUTONOMOUS_RETRY_FLOOR_MS, type PublicPrWarmupBudget } from './PublicPrWarmupBudget.js';
import { fetchGitHubGraphql, GitHubGraphqlResponseError } from './githubRuntime.js';

export const CHIEF_OF_STAFF_PR_REPO = 'JKHeadley/instar';
const GITHUB_ENDPOINT_QUERY = `
query ChiefOfStaffPullRequests($states: [PullRequestState!], $cursor: String, $order: IssueOrderField!) {
  repository(owner: "JKHeadley", name: "instar") {
    isPrivate
    pullRequests(first: 50, after: $cursor, states: $states, orderBy: {field: $order, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number title body state headRefName baseRefName updatedAt mergedAt }
    }
  }
}`;
const FRESH_MS = 2 * 60_000;
const RETAIN_MS = 10 * 60_000;
const RETRY_MS = PUBLIC_PR_AUTONOMOUS_RETRY_FLOOR_MS;
const RATE_LIMIT_RETRY_MS = 60_000;
export const PR_INVENTORY_REFRESH_BUDGET_MS = 20_000;
export const PR_INVENTORY_LOOKUP_BUDGET_MS = 21_000;
const WARM_SCAN_INTERVAL_MS = 8 * 60_000;
const ENROLLMENT_CHECK_MS = 15_000;
const MERGED_HISTORY_MS = 30 * 24 * 60 * 60_000;
export const PR_INVENTORY_MAX_PAGES_PER_SCOPE = 100;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_MATCHES = 20;
const MAX_EXCERPT = 240;
const CREDENTIAL_ROTATED = Symbol('credential-rotated');

type MatchKind = 'literal' | 'all-terms';

const WORK_STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with']);

function* workTerms(text: string): Generator<string> {
  for (const [match] of text.matchAll(/[a-z0-9]+(?:[.-][a-z0-9]+)*/gi)) {
    const term = match.toLowerCase();
    if (!/^[a-z]{4,}$/.test(term) || /(?:ss|us|is)$/.test(term)) yield term;
    else if (term.endsWith('sses')) yield term.slice(0, -2);
    else yield term.replace(/s$/, '');
  }
}

function matchesWorkTerms(row: IndexedPr, terms: readonly string[]): boolean {
  const remaining = new Set(terms);
  for (const field of [row.title, row.headRefName, row.baseRefName, row.body]) {
    for (const term of workTerms(field)) {
      if (remaining.delete(term) && remaining.size === 0) return true;
    }
  }
  return false;
}

type PrState = 'OPEN' | 'MERGED';
type PrRow = {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  state: PrState;
  updatedAt: string;
  mergedAt: string | null;
};
type IndexedPr = PrRow & { body: string };
type PullRequestsPage = {
  repository?: {
    isPrivate?: boolean;
    pullRequests?: {
      nodes?: IndexedPr[];
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  };
};
type Snapshot = { rows: IndexedPr[]; startedAt: number; finishedAt: number; complete: boolean };
type SourceStatus = 'fresh' | 'stale' | 'partial' | 'unavailable';

interface PrSearchDependencies {
  readToken(): string | null;
  fetchPage?(token: string, state: PrState, cursor: string | null, timeoutMs: number, signal: AbortSignal, observeRateLimit: (waitMs: number) => void): Promise<PullRequestsPage>;
  now?(): number;
  priorWarmBudget?: PublicPrWarmupBudget;
}

async function fetchPage(token: string, state: PrState, cursor: string | null, timeoutMs: number, signal: AbortSignal, observeRateLimit: (waitMs: number) => void) {
  const result = await fetchGitHubGraphql<PullRequestsPage>({
    token,
    query: GITHUB_ENDPOINT_QUERY,
    variables: { states: [state], cursor, order: state === 'OPEN' ? 'CREATED_AT' : 'UPDATED_AT' },
    timeoutMs,
    signal,
    maxResponseBytes: MAX_PAGE_BYTES,
    rejectRedirects: true,
    observeRateLimit,
  });
  // An authenticated token may still enumerate a repository after it becomes
  // private. Only GitHub's explicit public visibility grants this source.
  if (result.repository?.isPrivate !== false) {
    throw new GitHubGraphqlResponseError('Public repository visibility was not verified', 'authorization');
  }
  return result;
}

function validRow(node: IndexedPr, state: PrState): boolean {
  return !!node && Number.isSafeInteger(node.number) && node.number > 0
    && node.state === state
    && typeof node.title === 'string' && typeof node.body === 'string'
    && typeof node.headRefName === 'string' && typeof node.baseRefName === 'string'
    && typeof node.updatedAt === 'string' && Number.isFinite(Date.parse(node.updatedAt))
    && (state === 'OPEN'
      ? node.mergedAt === null
      : typeof node.mergedAt === 'string' && Date.parse(node.mergedAt) <= Date.parse(node.updatedAt));
}

function matchRank(row: IndexedPr, query: string): number {
  if (/^#?\d+$/.test(query)) return row.number === Number(query.replace(/^#/, '')) ? 0 : -1;
  const title = row.title.toLowerCase();
  if (title === query) return 0;
  if (title.includes(query)) return 1;
  if (row.headRefName.toLowerCase().includes(query) || row.baseRefName.toLowerCase().includes(query)) return 2;
  return row.body.toLowerCase().includes(query) ? 3 : -1;
}

function authorizationUnknown(error: unknown): boolean {
  return error instanceof GitHubGraphqlResponseError && error.kind === 'authorization';
}

function bodyMatchExcerpt(body: string, query: string) {
  const at = body.toLowerCase().indexOf(query);
  if (at === -1 || /^#?\d+$/.test(query)) return undefined;
  const start = Math.max(0, at - 40);
  return {
    bodyMatchExcerpt: body.slice(start, start + MAX_EXCERPT).replace(/[\u0000-\u001f\u007f]/g, ' '),
    excerptTruncated: start > 0 || start + MAX_EXCERPT < body.length,
  };
}

export class ChiefOfStaffPrSearch {
  private snapshots: Partial<Record<PrState, Snapshot>> = {};
  private lastComplete: Partial<Record<PrState, Snapshot>> = {};
  private inFlight: Promise<void> | null = null;
  private refreshController: AbortController | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private enrollment: { enabled: () => boolean; budget: PublicPrWarmupBudget; jitterMs: number } | null = null;
  private lastWarmScanAt: number | null = null;
  private earlyRepairAt: number | null = null;
  private warmFlight = false;
  private upstreamRetryAt = 0;
  private cacheToken: string | null = null;
  private retryAt = 0;
  private credentialGeneration = 0;
  private revision = randomUUID();
  private readonly now: () => number;
  private readonly readPage: NonNullable<PrSearchDependencies['fetchPage']>;

  constructor(private readonly deps: PrSearchDependencies) {
    this.now = deps.now ?? Date.now;
    this.readPage = deps.fetchPage ?? fetchPage;
  }

  start(enrollment: { enabled: () => boolean; budget: PublicPrWarmupBudget; jitterMs: number }): void {
    if (this.refreshTimer) return;
    this.stopped = false;
    if (!enrollment.enabled() || !Number.isFinite(enrollment.budget.retryFloor())) return;
    this.enrollment = enrollment;
    this.scheduleWarmTick();
    this.warm();
  }

  stop(): void {
    this.disarm();
    this.stopped = true;
    this.resetCredentials(null);
    this.enrollment = null;
    this.lastWarmScanAt = null;
    this.earlyRepairAt = null;
  }

  pauseWarmup(): void {
    this.disarm();
    if (this.warmFlight) this.resetCredentials(null);
  }

  isWarmEnrolled(): boolean {
    if (this.stopped || !this.enrollment || !this.refreshTimer) return false;
    if (this.enrollment.enabled()) return true;
    this.pauseWarmup();
    return false;
  }

  private disarm(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private scheduleWarmTick(): void {
    const dueIn = this.lastWarmScanAt === null ? 0
      : this.lastWarmScanAt + WARM_SCAN_INTERVAL_MS + (this.enrollment?.jitterMs ?? 0) - this.now();
    const repairIn = this.earlyRepairAt === null ? 0 : this.earlyRepairAt - this.now();
    const upcoming = [dueIn, repairIn].filter(value => value > 0);
    const delay = Math.min(ENROLLMENT_CHECK_MS, ...upcoming);
    this.refreshTimer = setTimeout(() => {
      this.warm();
      if (this.isWarmEnrolled()) this.scheduleWarmTick();
    }, delay);
    this.refreshTimer.unref();
  }

  private warm(): void {
    if (!this.isWarmEnrolled()) return;
    const token = this.currentToken();
    /* @self-action-controller: public-pr-warmup-retry */
    if (token) this.ensureRefresh(token, true, true);
  }

  private resetCredentials(token: string | null, reason?: symbol): void {
    this.credentialGeneration++;
    this.cacheToken = token;
    this.snapshots = {};
    this.lastComplete = {};
    this.revision = randomUUID();
    this.retryAt = 0;
    this.refreshController?.abort(reason);
    // Keep the slot until cancellation settles. A new credential cannot overlap it.
  }

  private currentToken(): string | null {
    if (this.stopped) return null;
    let token: string | null;
    try { token = this.deps.readToken(); }
    catch { token = null; /* Credential resolution failures invalidate cached results. */ }
    if (this.cacheToken !== token) this.resetCredentials(token, token ? CREDENTIAL_ROTATED : undefined);
    return token;
  }

  private ensureRefresh(token: string, warm: boolean, autonomous: boolean, scope?: PrState): Promise<void> | null {
    if (this.inFlight) return this.refreshController?.signal.aborted ? null : this.inFlight;
    const now = this.now();
    if (now < this.retryFloor()) return null;
    const open = this.status('OPEN');
    const merged = this.status('MERGED');
    const requested = scope === 'OPEN' ? [open] : scope === 'MERGED' ? [merged] : [open, merged];
    const needs = warm
      ? requested.some(status => status === 'unavailable' || status === 'partial')
      : open !== 'fresh' || merged !== 'fresh';
    const budget = this.deps.priorWarmBudget;
    let allowEarlyRepair = false;
    if (warm) {
      const due = this.lastWarmScanAt === null || now >= this.lastWarmScanAt + WARM_SCAN_INTERVAL_MS + (this.enrollment?.jitterMs ?? 0);
      const scheduledRepair = this.earlyRepairAt !== null && now >= this.earlyRepairAt;
      if (!due && (!needs || (autonomous && !scheduledRepair))) return null;
      if (!budget) return null;
      allowEarlyRepair = due;
    } else if (!needs) return null;
    if (budget && !budget.reserveAttempt(autonomous)) return null;
    if (warm) {
      this.earlyRepairAt = null;
      this.lastWarmScanAt = now;
    }

    const controller = new AbortController();
    this.refreshController = controller;
    this.warmFlight = warm;
    const deadline = setTimeout(() => controller.abort(), PR_INVENTORY_REFRESH_BUDGET_MS);
    deadline.unref();
    const refresh = this.refresh(token, this.credentialGeneration, controller, budget, warm, allowEarlyRepair).finally(() => {
      clearTimeout(deadline);
      if (this.inFlight === refresh) {
        this.inFlight = null;
        this.refreshController = null;
        this.warmFlight = false;
      }
    });
    this.inFlight = refresh;
    return refresh;
  }

  async search(query: string, scope?: PrState, offset = 0, waitSignal?: AbortSignal) {
    return this.lookup(query, scope, offset, false, waitSignal);
  }

  async searchForWork(query: string, waitSignal?: AbortSignal) {
    return this.lookup(query, undefined, 0, true, waitSignal);
  }

  private async lookup(query: string, scope: PrState | undefined, offset: number, allowTermFallback: boolean, waitSignal?: AbortSignal) {
    const warm = this.isWarmEnrolled();
    const token = this.currentToken();
    const generation = this.credentialGeneration;
    if (token && !waitSignal?.aborted) {
      const predecessor = this.refreshController?.signal.reason === CREDENTIAL_ROTATED ? this.inFlight : null;
      if (predecessor) {
        await this.waitForPredecessor(predecessor, waitSignal);
        if (waitSignal?.aborted || this.currentToken() !== token || this.credentialGeneration !== generation
          || (warm && !this.isWarmEnrolled())) return this.result(query, scope, offset, false, allowTermFallback);
      }
      const refresh = this.ensureRefresh(token, warm, false, scope);
      const hasSnapshot = scope ? this.status(scope) !== 'unavailable'
        : this.status('OPEN') !== 'unavailable' || this.status('MERGED') !== 'unavailable';
      if (!warm || !hasSnapshot) await refresh;
    }
    const stillEnrolled = !warm || this.isWarmEnrolled();
    const currentToken = this.currentToken();
    const visible = stillEnrolled && !waitSignal?.aborted && !!token && this.credentialGeneration === generation && currentToken === token;
    return this.result(query, scope, offset, visible, allowTermFallback);
  }

  private async waitForPredecessor(predecessor: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return predecessor;
    if (signal.aborted) return;
    let detach: () => void = () => {};
    try {
      await Promise.race([predecessor, new Promise<void>(resolve => {
        detach = () => resolve();
        signal.addEventListener('abort', detach, { once: true });
      })]);
    } finally {
      signal.removeEventListener('abort', detach);
    }
  }

  private status(state: PrState): SourceStatus {
    const snapshot = this.snapshots[state];
    if (!snapshot) return 'unavailable';
    const age = this.now() - snapshot.finishedAt;
    if (age < 0 || age >= RETAIN_MS) return 'unavailable';
    if (!snapshot.complete) return 'partial';
    return age < FRESH_MS ? 'fresh' : 'stale';
  }

  private coverage(state: PrState, visible: boolean) {
    const status = visible ? this.status(state) : 'unavailable';
    const snapshot = status === 'unavailable' ? null : this.snapshots[state] ?? null;
    const prior = this.retainedComplete(state, status);
    return {
      status,
      priorCompleteObservedThrough: prior ? new Date(prior.finishedAt).toISOString() : null,
      observedFrom: snapshot ? new Date(snapshot.startedAt).toISOString() : null,
      observedThrough: snapshot ? new Date(snapshot.finishedAt).toISOString() : null,
      mergedSince: snapshot && state === 'MERGED' ? new Date(snapshot.startedAt - MERGED_HISTORY_MS).toISOString() : null,
    };
  }

  private retainedComplete(state: PrState, status: SourceStatus): Snapshot | undefined {
    const prior = this.lastComplete[state];
    if (status !== 'partial' || !prior) return undefined;
    const age = this.now() - prior.finishedAt;
    return age >= 0 && age < RETAIN_MS ? prior : undefined;
  }

  isObservationCurrent(revision: string, query: string, scope?: PrState): boolean {
    this.isWarmEnrolled();
    if (!this.currentToken()) return false;
    const coverage = { open: this.coverage('OPEN', true), merged: this.coverage('MERGED', true) };
    return revision === this.resultRevision(query.toLowerCase().trim(), scope, coverage);
  }

  private resultRevision(search: string, scope: PrState | undefined, coverage: { open: unknown; merged: unknown }): string {
    return createHash('sha256').update(JSON.stringify([this.revision, search, scope, coverage])).digest('hex');
  }

  private result(query: string, scope: PrState | undefined, offset: number, visible: boolean, allowTermFallback: boolean) {
    const coverage = { open: this.coverage('OPEN', visible), merged: this.coverage('MERGED', visible) };
    const scopes = [['OPEN', coverage.open], ['MERGED', coverage.merged]] as const;
    const candidates = new Map<number, { row: IndexedPr; observedAt: number; priorComplete: boolean }>();
    const observe = (snapshot: Snapshot, priorComplete: boolean, currentNumbers?: Set<number>, mergedSince?: number) => {
      for (const row of snapshot.rows) {
        if (mergedSince !== undefined && (row.mergedAt === null || Date.parse(row.mergedAt) < mergedSince)) continue;
        const prior = candidates.get(row.number);
        const supersedesOpen = row.state === 'MERGED' && prior?.row.state === 'OPEN';
        if (currentNumbers?.has(row.number) && !supersedesOpen) continue;
        if (!prior || supersedesOpen) {
          candidates.set(row.number, { row, observedAt: snapshot.finishedAt, priorComplete });
        }
      }
    };
    for (const [state, info] of scopes) {
      const snapshot = info.status === 'unavailable' ? undefined : this.snapshots[state];
      if (snapshot) observe(snapshot, false);
    }
    const currentNumbers = new Set(candidates.keys());
    for (const [state, info] of scopes) {
      const fallback = this.retainedComplete(state, info.status);
      const mergedSince = state === 'MERGED' && info.mergedSince ? Date.parse(info.mergedSince) : undefined;
      if (fallback) observe(fallback, true, currentNumbers, mergedSince);
    }
    const search = query.toLowerCase().trim();
    const scoped = [...candidates.values()].filter(({ row }) => !scope || row.state === scope);
    let termSearchAttempted = false;
    const matches = scoped.flatMap(candidate => {
      const rank = matchRank(candidate.row, search);
      return rank < 0 ? [] : [{ ...candidate, rank, matchedBy: 'literal' as MatchKind }];
    });
    const literalCount = matches.length;
    if (allowTermFallback && literalCount < MAX_MATCHES && !/#\d/.test(search)) {
      const terms = [...new Set([...workTerms(search)].filter(term => !WORK_STOP_WORDS.has(term)))];
      if (terms.length >= 2 && terms.length <= 8) {
        termSearchAttempted = true;
        const literalNumbers = new Set(matches.map(({ row }) => row.number));
        for (const candidate of scoped) {
          if (!literalNumbers.has(candidate.row.number) && matchesWorkTerms(candidate.row, terms)) {
            matches.push({ ...candidate, rank: 4, matchedBy: 'all-terms' });
          }
        }
      }
    }
    matches.sort((a, b) => a.rank - b.rank || Date.parse(b.row.updatedAt) - Date.parse(a.row.updatedAt) || b.row.number - a.row.number);
    const selectedCoverage = scope === 'OPEN' ? [coverage.open] : scope === 'MERGED' ? [coverage.merged] : [coverage.open, coverage.merged];
    const available = selectedCoverage.some(info => info.status !== 'unavailable');
    const complete = selectedCoverage.every(info => info.status === 'fresh' || info.status === 'stale');
    const revision = this.resultRevision(search, scope, coverage);
    return {
      repository: CHIEF_OF_STAFF_PR_REPO,
      coverage,
      matchKind: termSearchAttempted ? literalCount ? 'literal-and-all-terms' as const : 'all-terms' as const : 'literal' as const,
      matchCount: complete ? matches.length : null,
      knownMatchCount: available ? matches.length : null,
      revision,
      nextOffset: offset + MAX_MATCHES < matches.length ? offset + MAX_MATCHES : null,
      items: matches.slice(offset, offset + MAX_MATCHES).map(({ row: { body, ...row }, observedAt, priorComplete, matchedBy }) => ({
        ...row,
        observedAt: new Date(observedAt).toISOString(),
        priorComplete,
        ...(allowTermFallback ? { matchedBy } : {}),
        ...(matchedBy === 'literal' ? bodyMatchExcerpt(body, search) : {}),
        url: `https://github.com/${CHIEF_OF_STAFF_PR_REPO}/pull/${row.number}`,
      })),
    };
  }

  private async refresh(token: string, generation: number, controller: AbortController, budget: PublicPrWarmupBudget | undefined, warm: boolean, allowEarlyRepair: boolean): Promise<void> {
    const states = ['OPEN', 'MERGED'] as const;
    const results = await Promise.allSettled(states.map(state => this.readSnapshot(token, state, generation, controller.signal, budget, warm).catch((error: unknown) => {
      // A denial immediately invalidates this credential generation, before
      // its sibling finishes. Neither stream can republish the known data.
      if (this.credentialGeneration !== generation) throw error;
      if (authorizationUnknown(error)) {
        this.snapshots = {};
        this.lastComplete = {};
        this.revision = randomUUID();
        this.credentialGeneration++;
        controller.abort();
        this.retryAt = Math.max(this.retryAt, this.now() + RETRY_MS);
        if (allowEarlyRepair) this.earlyRepairAt = this.retryAt;
      }
      throw error;
    })));
    if (this.credentialGeneration !== generation || (warm && !this.isWarmEnrolled())) return;
    this.revision = randomUUID();
    for (const [index, result] of results.entries()) {
      if (result.status !== 'fulfilled') continue;
      const state = states[index];
      this.snapshots[state] = result.value;
      if (result.value.complete) this.lastComplete[state] = result.value;
    }
    const incomplete = results.some(result => result.status === 'rejected' || !result.value.complete);
    this.retryAt = incomplete ? Math.max(this.retryAt, this.now() + RETRY_MS) : 0;
    if (incomplete && allowEarlyRepair) this.earlyRepairAt = this.retryAt;
  }

  private throttleWait(error: unknown): number {
    if (!(error instanceof GitHubGraphqlResponseError) || error.kind !== 'throttled' && error.retryAfterMs === undefined) return 0;
    const wait = error.retryAfterMs;
    return wait !== undefined && Number.isSafeInteger(wait) ? Math.max(wait, RETRY_MS) : RATE_LIMIT_RETRY_MS;
  }

  private retryFloor(): number {
    return Math.max(this.retryAt, this.upstreamRetryAt, this.deps.priorWarmBudget?.retryFloor() ?? 0);
  }

  private async fetchReservedPage(token: string, state: PrState, cursor: string | null, remaining: number,
    signal: AbortSignal, budget?: PublicPrWarmupBudget): Promise<PullRequestsPage> {
    const reservation = budget?.reservePage();
    if (budget && !reservation) throw new Error('github-pr-search-budget');
    let wait = 0;
    const observeRateLimit = (waitMs: number) => {
      wait = Math.max(wait, waitMs);
      this.upstreamRetryAt = Math.max(this.upstreamRetryAt, this.now() + waitMs);
    };
    try {
      return await this.readPage(token, state, cursor, remaining, signal, observeRateLimit);
    } catch (error) {
      const retry = this.throttleWait(error);
      if (retry > 0) observeRateLimit(retry);
      // A clean cancellation still consumes its reservation. A process crash
      // leaves the marker instead, which the successor cannot clear by waiting.
      if (reservation && signal.aborted && signal.reason !== CREDENTIAL_ROTATED && wait === 0) observeRateLimit(RETRY_MS);
      throw error;
    } finally {
      if (budget && reservation && !budget.settlePage(reservation, wait)) {
        this.upstreamRetryAt = Infinity;
        this.resetCredentials(this.cacheToken);
        throw new Error('github-pr-search-budget-settlement');
      }
    }
  }

  private async readSnapshot(token: string, state: PrState, generation: number, signal: AbortSignal, budget: PublicPrWarmupBudget | undefined, warm: boolean): Promise<Snapshot> {
    const startedAt = this.now();
    const mergedSince = startedAt - MERGED_HISTORY_MS;
    const rows = new Map<number, IndexedPr>();
    const visited = new Set<string>();
    let cursor: string | null = null;
    let priorUpdated = Infinity;
    let bytes = 0;
    try {
      for (let page = 1; ; page++) {
        const remaining = PR_INVENTORY_REFRESH_BUDGET_MS - (this.now() - startedAt);
        if (page > PR_INVENTORY_MAX_PAGES_PER_SCOPE || remaining <= 0 || signal.aborted || generation !== this.credentialGeneration || this.now() < this.retryFloor()) {
          throw new Error('github-pr-search-incomplete');
        }
        if (warm && !this.isWarmEnrolled()) throw new Error('github-pr-search-not-enrolled');
        const response = await this.fetchReservedPage(token, state, cursor, remaining, signal, budget);
        if (signal.aborted || this.now() - startedAt >= PR_INVENTORY_REFRESH_BUDGET_MS) {
          throw new Error('github-pr-search-incomplete');
        }
        if (!response.repository) throw new GitHubGraphqlResponseError('github-pr-search-repository-unavailable', 'authorization');
        const connection = response.repository.pullRequests;
        if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
          throw new Error('github-pr-search-unreadable');
        }
        bytes += Buffer.byteLength(JSON.stringify(connection));
        if (bytes > MAX_BYTES) throw new Error('github-pr-search-incomplete');
        const pageRows: IndexedPr[] = [];
        for (const row of connection.nodes) {
          if (!validRow(row, state)) throw new Error('github-pr-search-unreadable');
          const updated = Date.parse(row.updatedAt);
          if (state === 'MERGED' && updated > priorUpdated) throw new Error('github-pr-search-unordered');
          priorUpdated = updated;
          if (state === 'OPEN' || Date.parse(row.mergedAt!) >= mergedSince) pageRows.push(row);
        }
        for (const row of pageRows) {
          const earlier = rows.get(row.number);
          if (!earlier || Date.parse(row.updatedAt) > Date.parse(earlier.updatedAt)) rows.set(row.number, row);
        }
        if (!connection.pageInfo.hasNextPage || (state === 'MERGED' && priorUpdated < mergedSince)) {
          return { rows: [...rows.values()], startedAt, finishedAt: this.now(), complete: true };
        }
        const next = connection.pageInfo.endCursor;
        if (!next || typeof next !== 'string' || visited.has(next) || connection.nodes.length === 0) {
          throw new Error('github-pr-search-invalid-cursor');
        }
        visited.add(next);
        cursor = next;
      }
    } catch (error) {
      if (authorizationUnknown(error) || rows.size === 0) throw error;
      return { rows: [...rows.values()], startedAt, finishedAt: this.now(), complete: false };
    }
  }
}
