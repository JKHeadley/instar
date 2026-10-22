/**
 * HTTP surface for local-verify (spec docs/specs/local-verify-merge-authority.md §2).
 *
 *   POST /local-verify          body { "pr": <positive integer> } and nothing else
 *   GET  /local-verify          queue, in-flight run and record count
 *   GET  /local-verify/record   ?pr=&head=&base=  the record for one key, or 404
 *   GET  /local-verify/status   the status reconcile loop: floor state (GitHub's real
 *                               settings), main health, last pass, stuck heads, failed
 *                               posts, dry-run/live. Read-only and NOT lease-gated (a
 *                               standby reports its own view, `holdsLease: false`).
 *
 * Repo-gated: 503 when the service is not constructed (no instar source checkout,
 * or disabled). A standby answers 409 naming the lease holder; it does not proxy.
 * The repo always comes from config, never from the request.
 */

import type { Router, Request, Response } from 'express';

import type { LocalVerifyService, RequestResult } from './LocalVerifyService.js';
import type { StatusReconciler } from './StatusReconciler.js';

export interface LocalVerifyRouteDeps {
  service: () => LocalVerifyService | null;
  /** The status reconcile loop; absent/null ⇒ GET /local-verify/status answers 503. */
  status?: () => StatusReconciler | null;
  /** Lease view; absent on a single-machine agent (always the holder). */
  lease?: { holdsLease(): boolean; holderMachineId(): string | null };
}

const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/** HTTP status for a request result. Exported for tests. */
export function statusForResult(r: RequestResult): number {
  if (r.ok) return r.status === 'recorded' ? 200 : 202;
  switch (r.code) {
    case 'invalid-pr': return 400;
    case 'queue-full': return 429;
    case 'untrusted-head': return 403;
    case 'pr-unreadable':
    case 'pr-invalid-shas': return 502;
    case 'main-unhealthy': return 409;
    default: return 500;
  }
}

/** Validate the POST body: exactly `{ pr }`, a positive integer. Exported for tests. */
export function parsePostBody(body: unknown): number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== 'pr') return null;
  const pr = (body as { pr: unknown }).pr;
  return typeof pr === 'number' && Number.isSafeInteger(pr) && pr > 0 ? pr : null;
}

export function registerLocalVerifyRoutes(router: Router, deps: LocalVerifyRouteDeps): void {
  const gate = (res: Response): LocalVerifyService | null => {
    const svc = deps.service();
    if (!svc) {
      res.status(503).json({ error: 'local-verify not configured (no instar source checkout, or disabled)' });
      return null;
    }
    let holds = true;
    try { holds = deps.lease ? deps.lease.holdsLease() : true; } catch { holds = false; } // @silent-fallback-ok — an unreadable lease reads as NOT held, so a standby never starts a run
    if (!holds) {
      let holder: string | null = null;
      try { holder = deps.lease?.holderMachineId() ?? null; } catch { holder = null; } // @silent-fallback-ok — the holder id is advisory in the refusal body
      res.status(409).json({ error: 'not-lease-holder', holderMachineId: holder });
      return null;
    }
    return svc;
  };

  router.post('/local-verify', async (req: Request, res: Response) => {
    const svc = gate(res);
    if (!svc) return;
    const pr = parsePostBody(req.body);
    if (pr === null) {
      res.status(400).json({ error: 'body must be exactly {"pr": <positive integer>}' });
      return;
    }
    const r = await svc.request(pr, { explicit: true });
    res.status(statusForResult(r)).json(r);
  });

  router.get('/local-verify', (_req: Request, res: Response) => {
    const svc = gate(res);
    if (!svc) return;
    res.json(svc.snapshot());
  });

  router.get('/local-verify/status', (_req: Request, res: Response) => {
    const rec = deps.status?.() ?? null;
    if (!rec) {
      res.status(503).json({ error: 'local-verify status loop not configured (no instar source checkout, no GitHub login, or no safe-merge floor)' });
      return;
    }
    res.json(rec.status());
  });

  router.get('/local-verify/record', (req: Request, res: Response) => {
    const svc = gate(res);
    if (!svc) return;
    const pr = Number(req.query.pr);
    const head = String(req.query.head ?? '');
    const base = String(req.query.base ?? '');
    if (!Number.isSafeInteger(pr) || pr <= 0 || !SHA_RE.test(head) || !BRANCH_RE.test(base)) {
      res.status(400).json({ error: 'need pr (positive integer), head (40-hex sha), base (branch name)' });
      return;
    }
    const record = svc.getRecord(pr, head, base);
    if (!record) {
      res.status(404).json({ error: 'no record', pr, head, base });
      return;
    }
    res.json({ record });
  });
}
