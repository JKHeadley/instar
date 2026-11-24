// A1's first slice: lookup on the authenticated private Work boundary.
import { Router, type Request, type Response } from 'express';
import type { ChiefOfStaffPrSearch } from '../core/ChiefOfStaffPrSearch.js';
import { MAX_QUERY_CHARS, searchTerms } from '../core/conversationKeywordSearch.js';
import { isConversationSearchEnabled, searchLocal, type ConversationSearchRouteDeps, type SearchPlatform } from './mobileConversationSearchRoutes.js';
import { personOfReaderKey } from './mobilePairingRoutes.js';

const PROVIDER_LIMIT = 20;
const LOOKUP_BUDGET_MS = 5_000; // Same interactive budget as conversation search over the machine pool.
const FUTURE_SOURCES = ['gitRefs', 'specs', 'decisions', 'documents', 'projects', 'cards', 'commitments', 'jobs'] as const;
const SOURCES = ['conversations', 'pullRequests'] as const;
type Source = typeof SOURCES[number];

export interface WorkDiscoveryDependencies {
  enabled(): boolean;
  /** Must verify the private Work session again before rendering provider results. */
  mayReadPrivateWork(req: Request, res: Response): boolean;
  conversationSource(): ConversationSearchRouteDeps | null;
  configuredMessaging(platform: 'telegram' | 'slack'): boolean;
  pullRequestSource: Pick<ChiefOfStaffPrSearch, 'search'>;
  budgetMs?: number;
}

export function parseWorkDiscoveryQuery(body: unknown): { query: string; sources: Set<Source> } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'query' && key !== 'sources')) return null;
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query || query.length > MAX_QUERY_CHARS || searchTerms(query).length === 0) return null;
  const sources = input.sources ?? SOURCES;
  if (!Array.isArray(sources) || !sources.length || sources.length > SOURCES.length
    || sources.some(source => !SOURCES.includes(source))) return null;
  return { query, sources: new Set(sources) };
}

type PlatformCoverage = 'present' | 'unknown' | 'unsearched';

function conversations(deps: WorkDiscoveryDependencies, query: string, included: boolean) {
  const scope = { machine: 'this-machine', peers: 'unsearched', messages: 'user-side-leads' } as const;
  const platforms: Record<SearchPlatform, PlatformCoverage> = {
    app: included ? 'unknown' : 'unsearched',
    telegram: included && deps.configuredMessaging('telegram') ? 'unknown' : 'unsearched',
    slack: included && deps.configuredMessaging('slack') ? 'unknown' : 'unsearched',
  };
  const unavailable = () => ({ hits: [], coverage: { ...scope, status: 'unavailable', platforms } });
  if (!included) return { hits: [], coverage: { ...scope, status: 'unsearched', platforms } };
  try {
    const source = deps.conversationSource();
    if (!source?.service || !source.pairing.enabled() || !isConversationSearchEnabled(source.config)) return unavailable();
    const owner = personOfReaderKey(source.pairing, 'owner');
    if (!owner || owner.role !== 'owner') return unavailable();
    // The platform caches do not establish a current authorization and
    // erasure boundary. Only the original live native store is enrolled.
    platforms.app = 'present';
    const found = searchLocal(source, {
      terms: searchTerms(query), limit: PROVIDER_LIMIT, only: null, nativeUserLeadsOnly: true,
    }, {
      may: key => source.pairing.mayUse(owner, key),
      mayReadApp: (key, row) => source.pairing.mayReadStored(owner, key, row),
    });
    for (const platform of found.unsearched) platforms[platform] = 'unknown';
    const capped = found.capped || found.results.length === PROVIDER_LIMIT;
    return {
      hits: found.results.map(hit => ({
        kind: 'conversation' as const, ref: hit.ref, messageId: hit.messageId, platform: hit.platform,
        title: hit.title, messageAt: hit.at, snippet: hit.snippet, matchedBy: 'keyword' as const, evidence: 'lead' as const,
      })),
      coverage: { ...scope, status: capped || Object.values(platforms).includes('unknown') ? 'partial' : 'fresh', capped, platforms },
    };
  } catch {
    // Coverage is the degradation signal. Never include text from provider errors.
    for (const platform of Object.keys(platforms) as SearchPlatform[]) {
      if (platforms[platform] === 'present') platforms[platform] = 'unknown';
    }
    return unavailable();
  }
}

async function pullRequests(deps: WorkDiscoveryDependencies, query: string, included: boolean) {
  const scope = { repository: 'public Instar', method: 'literal' } as const;
  const unavailable = () => ({ hits: [], coverage: { ...scope, status: 'unavailable' } });
  if (!included) return { hits: [], coverage: { ...scope, status: 'unsearched' } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The shared PR provider refreshes its allowlisted corpus with a fixed
    // GraphQL request. The caller's phrase is used only for local matching.
    const result = await Promise.race([
      deps.pullRequestSource.search(query),
      new Promise<null>(resolve => { timer = setTimeout(resolve, deps.budgetMs ?? LOOKUP_BUDGET_MS, null); }),
    ]);
    if (!result || result.knownMatchCount === null) return unavailable();
    const statuses = [result.coverage.open.status, result.coverage.merged.status];
    const truncated = result.nextOffset !== null;
    const status = truncated || statuses.some(s => s === 'partial' || s === 'unavailable')
      ? 'partial' : statuses.includes('stale') ? 'stale' : 'fresh';
    return {
      hits: result.items.map(pr => ({
        kind: 'pull-request' as const, repository: result.repository, number: pr.number, title: pr.title,
        url: pr.url, state: pr.state, headRefName: pr.headRefName, observedAt: pr.observedAt,
        retainedObservation: pr.priorComplete, matchedBy: 'literal' as const,
      })),
      coverage: { ...scope, status, truncated, open: result.coverage.open, merged: result.coverage.merged },
    };
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timer);
  }
}

export function createWorkDiscoveryRouter(deps: WorkDiscoveryDependencies): Router {
  const router = Router();
  router.post('/work/discover', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!deps.mayReadPrivateWork(req, res)) {
      res.status(403).json({ error: 'private-work-session-required' });
      return;
    }
    if (!deps.enabled()) {
      res.status(503).json({ error: 'work-discovery-disabled' });
      return;
    }
    const input = Object.keys(req.query).length === 0 ? parseWorkDiscoveryQuery(req.body) : null;
    if (!input) {
      res.status(400).json({ error: 'invalid-work-discovery-query' });
      return;
    }
    const pulls = await pullRequests(deps, input.query, input.sources.has('pullRequests'));
    if (res.headersSent || res.destroyed) return;
    if (!deps.mayReadPrivateWork(req, res)) {
      res.status(403).json({ error: 'private-work-session-required' });
      return;
    }
    if (!deps.enabled()) {
      res.status(503).json({ error: 'work-discovery-disabled' });
      return;
    }
    // Capture private rows only after the asynchronous public source. Current source
    // checks, row capture, and JSON serialization share one synchronous boundary.
    const local = conversations(deps, input.query, input.sources.has('conversations'));
    const available = [local.coverage.status, pulls.coverage.status].some(status => status !== 'unavailable' && status !== 'unsearched');
    res.status(available ? 200 : 503).json({
      version: 1, status: available ? 'partial' : 'unavailable', observedAt: new Date().toISOString(),
      candidates: [...local.hits, ...pulls.hits],
      coverage: {
        conversations: local.coverage, pullRequests: pulls.coverage,
        ...Object.fromEntries(FUTURE_SOURCES.map(source => [source, { status: 'unsearched' }])),
      },
    });
  });
  return router;
}
