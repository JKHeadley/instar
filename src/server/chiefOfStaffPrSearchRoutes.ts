import type { Response, Router } from 'express';
import { ChiefOfStaffPrSearch, PR_INVENTORY_LOOKUP_BUDGET_MS } from '../core/ChiefOfStaffPrSearch.js';
import { resolveGitHubToken } from '../core/githubRuntime.js';
import { bearerMatches } from './middleware.js';

interface ChiefOfStaffPrSearchRouteOptions {
  ownerToken(): string | undefined;
  enabled(): boolean;
  stateDir?: string;
  lookup?: ChiefOfStaffPrSearch;
}

/** Waiters detach independently of the provider's refresh lifecycle. */
export async function waitForPrInventory<T>(lookup: (signal: AbortSignal) => Promise<T>, deadline: number | undefined, res: Response): Promise<T | null> {
  const waiter = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let close: (() => void) | undefined;
  try {
    if (res.destroyed || deadline !== undefined && Date.now() >= deadline) return null;
    return await Promise.race([lookup(waiter.signal), new Promise<null>(resolve => {
      close = () => { waiter.abort(); resolve(null); };
      res.once('close', close);
      if (deadline !== undefined) timer = setTimeout(close, Math.max(0, deadline - Date.now()));
      if (res.destroyed || deadline !== undefined && Date.now() >= deadline) close();
    })]);
  } finally {
    if (close) res.removeListener('close', close);
    clearTimeout(timer);
  }
}

export function mountChiefOfStaffPrSearch(router: Router, options: ChiefOfStaffPrSearchRouteOptions): void {
  const lookup = options.lookup ?? new ChiefOfStaffPrSearch({ readToken: () => resolveGitHubToken({ stateDir: options.stateDir }) });
  router.get('/chief-of-staff/pr-search', async (req, res) => {
    const enteredAt = Date.now();
    res.set('Cache-Control', 'no-store');
    const principal = (req as unknown as { instarPrincipal?: unknown }).instarPrincipal;
    const authorized = () => {
      const ownerToken = options.ownerToken();
      return !principal && !!ownerToken && bearerMatches(req, ownerToken);
    };
    if (!authorized()) {
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
    const deadline = lookup.isWarmEnrolled() ? enteredAt + PR_INVENTORY_LOOKUP_BUDGET_MS : undefined;
    const result = await waitForPrInventory(signal => lookup.search(query, scope, offset, signal), deadline, res);
    if (res.headersSent || res.destroyed) return;
    if (!authorized()) {
      res.status(403).json({ error: 'owner-bearer-required' });
      return;
    }
    if (!options.enabled()) {
      res.status(503).json({ error: 'chief-of-staff-pr-search-disabled' });
      return;
    }
    if (!result || (result.knownMatchCount !== null && !lookup.isObservationCurrent(result.revision, query, scope))) {
      res.status(503).json({ error: 'pr-inventory-unavailable' });
      return;
    }
    if (offset > 0 && revision !== result.revision) {
      res.status(409).json({ error: 'pr-search-changed', restartAt: 0 });
      return;
    }
    res.status(result.knownMatchCount === null ? 503 : 200).json(result);
  });
}
