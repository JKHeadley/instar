/**
 * Project apps part 2 serving routes (docs/specs/project-apps-sandbox.md §3.6, §3.7).
 *
 *   POST /project-apps/:appId/ticket      console credential (the auth middleware's Bearer gate)
 *   POST /project-apps/:appId/key         console credential; body {contentSha} = the loaded version
 *   GET  /project-apps/:appId/frame?t=    NO Bearer: the single-use ticket + Sec-Fetch-Dest
 *   GET|PUT /project-apps/:appId/api/data      NO Bearer: the narrow key (X-Project-App-Key) only
 *   GET|PUT /project-apps/:appId/api/summary   NO Bearer: the narrow key only
 *
 * The frame and api shapes are exempted in authMiddleware by exact method + path
 * (`isProjectAppPublicRoute`); the ticket and key routes are NOT exempted, so they need the
 * console's credential like any owner route. The frame route never redirects.
 */
import type { Request, Response, Router } from 'express';
import {
  APP_ID_RE, KEY_HEADER, frameHeaders, resolveKnownOrigin,
  type OriginDeps, type ProjectAppSandbox, type KeyRight,
} from './ProjectAppSandbox.js';

export interface ProjectAppSandboxRouteDeps {
  sandbox: () => ProjectAppSandbox | null;
  /** projectApps.custom.enabled (with part 1's switch). Off ⇒ every route answers 503. */
  enabled: () => boolean;
  origin: OriginDeps;
  log?: (entry: Record<string, unknown>) => void;
  /** The per-app request bucket on the four api routes (defaults: API_RATE_DEFAULT). */
  apiRate?: { perSecond: number; burst: number };
  now?: () => number;
}

/**
 * The app api's per-app token bucket (§3.7 "Request rate"). A starting value, to be tuned from
 * real use: about 20 requests a second, with a small burst on top.
 */
export const API_RATE_DEFAULT = { perSecond: 20, burst: 30 } as const;
/** At most this many app ids tracked (the api is reachable without the Bearer; ids are attacker-chosen). */
const BUCKETS_MAX = 1000;

/** A token bucket per key: `take(key)` is false once the key is out of tokens. */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly rate: { perSecond: number; burst: number }, private readonly now: () => number = Date.now) {}
  take(key: string): boolean {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= BUCKETS_MAX) this.buckets.delete(this.buckets.keys().next().value as string);
      b = { tokens: this.rate.burst, at: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.rate.burst, b.tokens + ((t - b.at) / 1000) * this.rate.perSecond);
      b.at = t;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

const PLAIN_PAGE_CSP = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'";

function plainPage(res: Response, status: number, text: string): void {
  res.status(status);
  res.set({
    'Content-Security-Policy': PLAIN_PAGE_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
  });
  const safe = text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
  res.send(`<!doctype html><meta charset="utf-8"><title>Project app</title><p>${safe}</p>`);
}

export function mountProjectAppSandboxRoutes(router: Router, deps: ProjectAppSandboxRouteDeps): void {
  const log = (e: Record<string, unknown>) => { try { deps.log?.(e); } catch { /* @silent-fallback-ok — a lost log line never changes the answer */ } };

  /** The switch, the runtime and an exact app id; answers the refusal itself. */
  const gate = (req: Request, res: Response, json: boolean): { sb: ProjectAppSandbox; appId: string } | null => {
    const appId = String(req.params.appId ?? '');
    if (!deps.enabled()) {
      if (json) res.status(503).set('Cache-Control', 'no-store').json({ error: 'custom-apps-off', detail: 'Custom apps are switched off on this agent.' });
      else plainPage(res, 503, 'Custom apps are switched off on this agent.');
      return null;
    }
    const sb = deps.sandbox();
    if (!sb) {
      if (json) res.status(503).set('Cache-Control', 'no-store').json({ error: 'custom-apps-starting' });
      else plainPage(res, 503, 'Custom apps are starting. Try again in a moment.');
      return null;
    }
    if (!APP_ID_RE.test(appId)) {
      if (json) res.status(404).set('Cache-Control', 'no-store').json({ error: 'unknown-app' });
      else plainPage(res, 404, 'There is no such app.');
      return null;
    }
    return { sb, appId };
  };

  // ── ticket ──
  router.post('/project-apps/:appId/ticket', (req, res) => {
    const g = gate(req, res, true); if (!g) return;
    res.set('Cache-Control', 'no-store');
    const meta = g.sb.source.meta(g.appId);
    if (!meta) { res.status(404).json({ error: 'unknown-app' }); return; }
    const v = g.sb.source.servedVersion(g.appId);
    if (v.state !== 'served') { res.status(409).json({ error: 'not-served', state: v.state, meta }); return; }
    const t = g.sb.tickets.issue(g.appId, v.contentSha);
    res.json({
      ticket: t.ticket, expiresAt: t.expiresAt, contentSha: v.contentSha, meta,
      frameUrl: `/project-apps/${g.appId}/frame?t=${encodeURIComponent(t.ticket)}`,
    });
  });

  // ── key ──
  router.post('/project-apps/:appId/key', (req, res) => {
    const g = gate(req, res, true); if (!g) return;
    res.set('Cache-Control', 'no-store');
    const raw = ((req.body ?? {}) as { contentSha?: unknown }).contentSha;
    if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/.test(raw)) { res.status(400).json({ error: 'content-sha-required' }); return; }
    const r = g.sb.mint(g.appId, raw);
    if (!r.ok) { res.status(r.status).json({ error: r.error, ...(r.state ? { state: r.state } : {}), ...(r.contentSha ? { contentSha: r.contentSha } : {}) }); return; }
    log({ event: 'key-minted', appId: g.appId, contentSha: r.contentSha });
    res.json({ key: r.key, exp: r.exp, contentSha: r.contentSha });
  });

  // ── frame ──
  router.get('/project-apps/:appId/frame', (req, res) => {
    const g = gate(req, res, false); if (!g) return;
    const dest = req.headers['sec-fetch-dest'];
    if (dest !== undefined && dest !== 'iframe') {
      log({ event: 'frame-refused', appId: g.appId, reason: 'sec-fetch-dest', dest: String(dest).slice(0, 20) });
      plainPage(res, 403, 'This page opens only inside its app. Open the app from your project in Work.');
      return;
    }
    const origin = resolveKnownOrigin(req, deps.origin);
    if (!origin) { plainPage(res, 400, 'This address is not one of this agent\'s addresses.'); return; }
    const v = g.sb.source.servedVersion(g.appId);
    const served = v.state === 'served' ? v : null;
    const t = g.sb.tickets.consume(req.query.t, g.appId, served?.contentSha ?? null);
    if (!t.ok) {
      log({ event: 'frame-refused', appId: g.appId, reason: `ticket-${t.reason}` });
      plainPage(res, 403, 'This page opens only inside its app. Open the app from your project in Work.');
      return;
    }
    if (!served) { plainPage(res, 409, 'This app has no version to run right now.'); return; }
    const headers = frameHeaders(origin, g.appId, served.contentSha);
    res.set(headers);
    if (req.headers['if-none-match'] === headers.ETag) { res.status(304).end(); return; }
    res.status(200).send(served.html);
  });

  // ── api ──
  const buckets = new TokenBuckets(deps.apiRate ?? API_RATE_DEFAULT, deps.now ?? Date.now);
  const keyed = (right: KeyRight) => (req: Request, res: Response): { sb: ProjectAppSandbox; appId: string } | null => {
    const g = gate(req, res, true); if (!g) return null;
    res.set('Cache-Control', 'no-store');
    const verdict = g.sb.verify(g.appId, req.headers[KEY_HEADER], right);
    if (!verdict.ok) {
      if (verdict.reason === 'key-secret-unavailable') { res.status(503).json({ error: 'key-secret-unavailable' }); return null; }
      // version-not-served / revoked / expired tell the wrapper to renew or reload; the frame learns nothing more.
      res.status(401).json({ error: 'app-key-refused', reason: verdict.reason });
      return null;
    }
    // After the key check (cheap: its folds are memoised), so a caller without the app's key cannot
    // spend the app's own allowance; the bucket bounds what the app's code itself can ask for.
    if (!buckets.take(g.appId)) {
      res.status(429).set('Retry-After', '1').json({ error: 'too-many-requests', detail: 'This app is asking too often. Wait a moment and try again.' });
      return null;
    }
    return g;
  };
  const answer = (res: Response, r: { ok: boolean; status?: number; error?: string; detail?: string; [k: string]: unknown }) => {
    if (r.ok) { res.json(r); return; }
    const { ok: _ok, status, ...rest } = r;
    res.status(typeof status === 'number' ? status : 500).json(rest);
  };

  router.get('/project-apps/:appId/api/data', (req, res) => {
    const g = keyed('data:read')(req, res); if (!g) return;
    res.json(g.sb.source.readData(g.appId));
  });
  router.put('/project-apps/:appId/api/data', (req, res) => {
    const g = keyed('data:write')(req, res); if (!g) return;
    const b = (req.body ?? {}) as { body?: unknown; base?: unknown };
    const base = typeof b.base === 'string' ? b.base : null;
    answer(res, g.sb.source.writeData(g.appId, b.body, base));
  });
  router.get('/project-apps/:appId/api/summary', (req, res) => {
    const g = keyed('data:read')(req, res); if (!g) return;
    res.json({ summary: g.sb.source.readSummary(g.appId) ?? null });
  });
  router.put('/project-apps/:appId/api/summary', (req, res) => {
    const g = keyed('summary:write')(req, res); if (!g) return;
    answer(res, g.sb.source.writeSummary(g.appId, (req.body ?? {}) as unknown));
  });
}
