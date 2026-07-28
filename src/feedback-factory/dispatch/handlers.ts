/**
 * handlers.ts — framework-agnostic dispatch (guidance-out) request handlers.
 *
 * Faithful port of handleList + handleCreate from the reference dispatch endpoint
 * (the-portal/pages/api/instar/dispatches/index.ts), lifted out of Next.js into
 * pure request→response functions over the FeedbackStore + the ported dispatch
 * logic (dispatch.ts). The canonical front binds these; the operated deploy
 * supplies the real store + the internal key. Reproduces the reference's exact
 * status codes, auth, validation messages, and the version-compat filter.
 *
 * Note: unlike the public feedback receiver (which DEFAULTS an invalid type),
 * dispatch create REJECTS an invalid type — it's an internal, authed endpoint.
 */

import {
  isValidDispatchType, isValidDispatchPriority, SEMVER_RE, DISPATCH_TYPES,
  filterDispatchesForVersion, normalizeDispatchTitle, type DispatchRecord,
} from './dispatch.js';
import type { FeedbackStore } from '../store/FeedbackStore.js';

export interface DispatchListRequest {
  headers: Record<string, string | string[] | undefined>;
  query: { since?: string; type?: string };
}
export interface DispatchCreateRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}
export interface DispatchResponse {
  status: number;
  json: unknown;
}

function header(headers: DispatchListRequest['headers'], name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Port of handleList: fingerprint-gate, since/type filter, version-compat filter, mapped output. */
export function handleDispatchList(req: DispatchListRequest, deps: { store: FeedbackStore; now: number }): DispatchResponse {
  const ua = (header(req.headers, 'user-agent') || '').toLowerCase();
  if (!ua.includes('instar/')) {
    return { status: 400, json: { error: 'Invalid request format' } };
  }

  // since: only applied when it parses to a valid date (mirrors the reference).
  let since: string | undefined;
  if (req.query.since && !isNaN(new Date(req.query.since).getTime())) {
    since = new Date(req.query.since).toISOString();
  }
  const type = req.query.type && isValidDispatchType(req.query.type) ? req.query.type : undefined;

  let dispatches = deps.store.listDispatches({ since, type });

  const version = header(req.headers, 'x-instar-version');
  if (version && SEMVER_RE.test(version)) {
    dispatches = filterDispatchesForVersion(dispatches, version);
  }

  return {
    status: 200,
    json: {
      dispatches: dispatches.map((d) => ({
        dispatchId: d.dispatchId,
        type: d.type,
        title: d.title,
        content: d.content,
        priority: d.priority,
        minVersion: d.minVersion ?? null,
        maxVersion: d.maxVersion ?? null,
        createdAt: d.createdAt,
      })),
      count: dispatches.length,
      asOf: new Date(deps.now).toISOString(),
    },
  };
}

export interface DispatchCreateDeps {
  store: FeedbackStore;
  /** The internal API key the caller must present (x-internal-key or Bearer). */
  internalKey: string;
  now: number;
  generateDispatchId?: () => string;
}

/** Port of handleCreate: internal-auth, validation (type REJECTED, priority defaulted), dedup-by-title, create. */
export function handleDispatchCreate(req: DispatchCreateRequest, deps: DispatchCreateDeps): DispatchResponse {
  const provided = header(req.headers, 'x-internal-key')
    || header(req.headers, 'authorization')?.replace('Bearer ', '');
  if (provided !== deps.internalKey) {
    return { status: 401, json: { error: 'Authentication required' } };
  }

  if (!req.body || typeof req.body !== 'object') {
    return { status: 400, json: { error: 'Request body must be JSON' } };
  }
  const body = req.body as Record<string, unknown>;

  if (!body.title || typeof body.title !== 'string' || body.title.trim().length < 3) {
    return { status: 400, json: { error: 'title is required (min 3 characters)' } };
  }
  if (!body.content || typeof body.content !== 'string' || body.content.trim().length < 10) {
    return { status: 400, json: { error: 'content is required (min 10 characters)' } };
  }
  if (!body.type || !isValidDispatchType(body.type)) {
    return { status: 400, json: { error: `type must be one of: ${DISPATCH_TYPES.join(', ')}` } };
  }
  const priority = body.priority && isValidDispatchPriority(body.priority) ? body.priority : 'normal';

  if (body.minVersion && !SEMVER_RE.test(body.minVersion as string)) {
    return { status: 400, json: { error: 'minVersion must be valid semver' } };
  }
  if (body.maxVersion && !SEMVER_RE.test(body.maxVersion as string)) {
    return { status: 400, json: { error: 'maxVersion must be valid semver' } };
  }

  const normalizedTitle = normalizeDispatchTitle(body.title);

  const existing = deps.store.findDispatchByTitle(normalizedTitle);
  if (existing) {
    return { status: 200, json: { dispatchId: existing.dispatchId, created: false, duplicate: true } };
  }

  const dispatchId = (deps.generateDispatchId ?? (() => `dsp-${deps.now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`))();
  const record: DispatchRecord = {
    dispatchId,
    type: body.type as string,
    title: normalizedTitle,
    content: (body.content as string).trim().slice(0, 50000),
    priority: priority as string,
    minVersion: (body.minVersion as string) || null,
    maxVersion: (body.maxVersion as string) || null,
    active: true,
    createdAt: new Date(deps.now).toISOString(),
  };
  deps.store.createDispatch(record);

  return { status: 201, json: { dispatchId, created: true, duplicate: false } };
}
