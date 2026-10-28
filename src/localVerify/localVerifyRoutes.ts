/**
 * HTTP surface for local-verify (spec docs/specs/local-verify-merge-authority.md §2).
 *
 *   POST /local-verify          body { "pr": <positive integer> } and nothing else
 *   GET  /local-verify          queue, in-flight run and record count
 *   GET  /local-verify/record   ?pr=&head=&base=  the record for one key, or 404
 *   POST /local-verify/peer-run     a coordinator hands this machine one PR verify (Part D of
 *                                   docs/specs/local-verify-capacity.md); refused on the lease holder
 *   GET  /local-verify/peer-status  this machine's peer slot (served on a non-holder)
 *   GET  /local-verify/peer-result  ?attemptId=  unknown | running | done + record
 *   POST /local-verify/peer-cancel  { attemptId }: tombstone it, cancel it if running
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
import { parsePeerRunRequest } from './peer.js';
import { ATTEMPT_ID_RE } from './record.js';
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
    case 'main-unhealthy':
    case 'pr-closed': return 409;
    case 'stopping':
    case 'peer-only': return 503;
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
    // flakyFiles: file → { count, lastSeen, lane } for every file an isolation re-run found flaky.
    res.json({ ...rec.status(), flakyFiles: deps.service()?.flakyFiles() ?? {} });
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

  // ---- peer verifier routes (Part D). Served on a NON-holder; the lease holder refuses peer-run. ----
  const peerGate = (res: Response): LocalVerifyService | null => {
    const svc = deps.service();
    if (!svc) {
      res.status(503).json({ error: 'local-verify not configured (disabled)' });
      return null;
    }
    return svc;
  };
  const leaseCtx = (): { holdsLease: boolean; holderMachineId: string | null } => {
    let holdsLease = true;
    let holderMachineId: string | null = null;
    try { holdsLease = deps.lease ? deps.lease.holdsLease() : true; } catch { holdsLease = true; } // @silent-fallback-ok — an unreadable lease reads as HELD here, so peer-run is refused (the safe direction)
    try { holderMachineId = deps.lease?.holderMachineId() ?? null; } catch { holderMachineId = null; } // @silent-fallback-ok — an unknown holder refuses peer-run as not-coordinator
    return { holdsLease, holderMachineId };
  };

  router.post('/local-verify/peer-run', async (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    const body = parsePeerRunRequest(req.body);
    if (!body) {
      res.status(400).json({ ok: false, reason: 'invalid-request' });
      return;
    }
    const ans = await svc.peerRun(body, leaseCtx());
    res.status(ans.ok ? 202 : ans.reason === 'peer-disabled' ? 503 : 409).json(ans);
  });

  router.get('/local-verify/peer-status', (_req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    res.json(svc.peerStatus());
  });

  router.get('/local-verify/peer-result', (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    const id = String(req.query.attemptId ?? '');
    if (!ATTEMPT_ID_RE.test(id)) {
      res.status(400).json({ error: 'need attemptId (32 lowercase hex)' });
      return;
    }
    res.json(svc.peerResult(id));
  });

  router.post('/local-verify/peer-cancel', (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    const id = req.body && typeof req.body === 'object' ? (req.body as { attemptId?: unknown }).attemptId : undefined;
    if (typeof id !== 'string' || !ATTEMPT_ID_RE.test(id)) {
      res.status(400).json({ error: 'body must be {"attemptId": <32 lowercase hex>}' });
      return;
    }
    res.json(svc.peerCancel(id));
  });
}
