import type { Router } from 'express';
import { ChiefOfStaffPrSearch } from '../core/ChiefOfStaffPrSearch.js';
import { resolveGitHubToken } from '../core/githubRuntime.js';
import { bearerMatches } from './middleware.js';

interface ChiefOfStaffPrSearchRouteOptions {
  ownerToken(): string | undefined;
  enabled(): boolean;
  stateDir?: string;
}

export function mountChiefOfStaffPrSearch(router: Router, options: ChiefOfStaffPrSearchRouteOptions): void {
  const lookup = new ChiefOfStaffPrSearch({ readToken: () => resolveGitHubToken({ stateDir: options.stateDir }) });
  router.get('/chief-of-staff/pr-search', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const principal = (req as unknown as { instarPrincipal?: unknown }).instarPrincipal;
    const ownerToken = options.ownerToken();
    if (principal || !ownerToken || !bearerMatches(req, ownerToken)) {
      res.status(403).json({ error: 'owner-bearer-required' });
      return;
    }
    if (!options.enabled()) {
      res.status(503).json({ error: 'chief-of-staff-pr-search-disabled' });
      return;
    }
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const scope = req.query.state;
    const offset = req.query.offset === undefined ? 0 : typeof req.query.offset === 'string' && /^\d{1,5}$/.test(req.query.offset)
      ? Number(req.query.offset) : NaN;
    const revision = req.query.revision;
    if (!query || query.length > 256 || (scope !== undefined && scope !== 'OPEN' && scope !== 'MERGED')
      || !Number.isSafeInteger(offset) || (offset > 0 && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)))
      || Object.keys(req.query).some(key => !['q', 'state', 'offset', 'revision'].includes(key))) {
      res.status(400).json({ error: 'invalid-pr-search-query' });
      return;
    }
    const result = await lookup.search(query, scope, offset);
    if (res.headersSent || res.destroyed) return;
    if (offset > 0 && revision !== result.revision) {
      res.status(409).json({ error: 'pr-search-changed', restartAt: 0 });
      return;
    }
    res.status(result.knownMatchCount === null ? 503 : 200).json(result);
  });
}
