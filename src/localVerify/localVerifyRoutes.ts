/**
 * HTTP surface for local-verify (spec docs/specs/local-verify-merge-authority.md §2).
 *
 *   POST /local-verify          body { "pr": <positive integer> } and nothing else
 *   GET  /local-verify          queue, in-flight run and record count; `borrowed` = the borrowed
 *                               mode and, per helper and lane, the state, each evidence item's
 *                               progress, the last verify's share and how much the helper
 *                               finished (docs/specs/local-verify-borrowed-slices-count.md, G)
 *   GET  /local-verify/borrowed          the same `borrowed` summary on any run machine (a peer's
 *                                        practice record lives on the peer; not lease-gated)
 *   POST /local-verify/borrowed/decision { helper, lane, reason, sevenDayException?, by? }: record the
 *                                        decision to count; refused (409) when the admission rule does not hold
 *   POST /local-verify/borrowed/dry-run  { helper, lanes?, action?, by? }: record a dry-run request
 *                                        (the dry-run task that consumes it is a later stage)
 *   POST /local-verify/helper-here       the paired helper's signed "I am here"
 *   POST /local-verify/borrowed-proxy    LOOPBACK ONLY, authenticated by a running verify's attempt
 *                                        token (header X-Instar-Attempt-Token) in place of the Bearer
 *                                        credential: the verify child's way to its helper. The commits,
 *                                        the lanes' states and the helper come from the server's record
 *                                        of that verify, never from the request
 *   POST /local-verify/peer-baseline     the coordinator's baseline results, stored by a peer
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
import { parseDiagnosisPeerRequest } from './failedFileDiagnosisPeer.js';
import { ATTEMPT_ID_RE } from './record.js';
import type { StatusReconciler } from './StatusReconciler.js';
import type { BorrowedRouteFacts } from './mainRunObserver.js';

/** The loopback proxy's path and token header (the auth middleware lets exactly this method and path through to the route's own checks). */
export const BORROWED_PROXY_PATH = '/local-verify/borrowed-proxy';
export const BORROWED_PROXY_TOKEN_HEADER = 'x-instar-attempt-token';

/** What the borrowed routes may know about how a request arrived. */
export function borrowedRouteFacts(req: Request): BorrowedRouteFacts {
  return { cfConnectingIp: req.headers['cf-connecting-ip'], forwardedFor: req.headers['x-forwarded-for'], remoteAddress: req.socket?.remoteAddress };
}

export interface LocalVerifyRouteDeps {
  service: () => LocalVerifyService | null;
  /** The status reconcile loop; absent/null ⇒ GET /local-verify/status answers 503. */
  status?: () => StatusReconciler | null;
  /** Lease view; absent on a single-machine agent (always the holder). */
  lease?: { holdsLease(): boolean; holderMachineId(): string | null; leaseEpoch?(): number | null };
  /**
   * SEC-113 D2.5: the owner's verified console session (the `X-Instar-Operator-Session` header). The
   * peer quarantine clear needs it; the Bearer token alone is never enough. Absent ⇒ 503.
   */
  verifyOperatorSession?: (token: string | undefined) => boolean;
}

const MACHINE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

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

  // SEC-113 D2.5: the owner clears a peer's main quarantine from the console (owner-only).
  router.post('/local-verify/peers/:machineId/main-quarantine/clear', (req: Request, res: Response) => {
    if (!deps.verifyOperatorSession) { res.status(503).json({ error: 'operator-session-unavailable' }); return; }
    const token = req.headers['x-instar-operator-session'];
    let ok = false;
    try { ok = typeof token === 'string' && deps.verifyOperatorSession(token); } catch { ok = false; } // @silent-fallback-ok — an unverifiable session is refused (401), never treated as the owner
    if (!ok) { res.status(401).json({ error: 'operator-session-required' }); return; }
    const machineId = String(req.params.machineId ?? '');
    if (!MACHINE_ID_RE.test(machineId)) { res.status(400).json({ error: 'bad-machine-id' }); return; }
    const svc = gate(res);
    if (!svc) return;
    res.json(svc.clearMainQuarantine(machineId, 'owner'));
  });

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
    // borrowed: the borrowed-helper shadow (mode, helpers, last shadow summaries, learned lists); null when not wired.
    res.json({ ...svc.snapshot(), diagnosis: svc.diagnosisSummary(), borrowed: svc.borrowedInfo() });
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
    res.json({ record, diagnosis: svc.diagnosisForRecord(record) });
  });

  router.get('/local-verify/diagnosis', (req: Request, res: Response) => {
    const svc = gate(res);
    if (!svc) return;
    const pr = Number(req.query.pr);
    const head = String(req.query.head ?? '');
    const base = String(req.query.base ?? '');
    if (!Number.isSafeInteger(pr) || pr <= 0 || !SHA_RE.test(head) || !BRANCH_RE.test(base)) {
      res.status(400).json({ error: 'need pr, head, base' }); return;
    }
    const record = svc.getRecord(pr, head, base);
    const diagnosis = record ? svc.diagnosisForRecord(record) : null;
    if (!diagnosis) { res.status(404).json({ error: 'no diagnosis', pr, head, base }); return; }
    res.json({ diagnosis });
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
  const leaseCtx = (): { holdsLease: boolean; holderMachineId: string | null; leaseEpoch: number | null } => {
    let holdsLease = true;
    let holderMachineId: string | null = null;
    try { holdsLease = deps.lease ? deps.lease.holdsLease() : true; } catch { holdsLease = true; } // @silent-fallback-ok — an unreadable lease reads as HELD here, so peer-run is refused (the safe direction)
    try { holderMachineId = deps.lease?.holderMachineId() ?? null; } catch { holderMachineId = null; } // @silent-fallback-ok — an unknown holder refuses peer-run as not-coordinator
    let leaseEpoch: number | null = null;
    try { leaseEpoch = deps.lease?.leaseEpoch?.() ?? null; } catch { leaseEpoch = null; }
    return { holdsLease, holderMachineId, leaseEpoch };
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

  // ---- borrowed helpers, run-machine side (docs/specs/local-verify-borrowed-slices-count.md, F). ----
  // The practice record lives on the helper's PAIRING run machine, which may be a peer, so these
  // are served like the peer routes: by any machine whose service is built, lease holder or not.
  // Each answers 404 while the borrowed setting is absent (the seam itself says so).
  const notFound = (res: Response) => { res.status(404).json({ error: 'not found' }); };

  router.get('/local-verify/borrowed', (_req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    res.json({ borrowed: svc.borrowedInfo() });
  });

  router.post('/local-verify/borrowed/decision', (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    const seam = svc.borrowedRunSeam();
    if (!seam) { notFound(res); return; }
    try { const a = seam.decide(req.body); res.status(a.status).json(a.body); }
    catch (e) { res.status(500).json({ ok: false, code: 'borrowed-error', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
  });

  router.post('/local-verify/borrowed/dry-run', (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    const seam = svc.borrowedRunSeam();
    if (!seam) { notFound(res); return; }
    try { const a = seam.dryRun(req.body); res.status(a.status).json(a.body); }
    catch (e) { res.status(500).json({ ok: false, code: 'borrowed-error', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
  });

  router.post('/local-verify/helper-here', (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    const seam = svc.borrowedRunSeam();
    if (!seam) { notFound(res); return; }
    try { const a = seam.helperHere(req.body, borrowedRouteFacts(req)); res.status(a.status).json(a.body); }
    catch (e) { res.status(500).json({ ok: false, reason: 'borrowed-error', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
  });

  // The verify child's way to its helper. NOT behind the Bearer credential (the child holds none):
  // the route answers only on loopback, refuses anything that came through the tunnel or another
  // forwarder, and requires the attempt token of a verify that is running right now. Any failure
  // past those checks reads as "no helper answer": the child then runs the files itself.
  router.post(BORROWED_PROXY_PATH, async (req: Request, res: Response) => {
    const svc = deps.service();
    const seam = svc ? svc.borrowedRunSeam() : null;
    if (!svc || !seam) { notFound(res); return; }
    const token = req.headers[BORROWED_PROXY_TOKEN_HEADER];
    try {
      const a = await seam.proxy(typeof token === 'string' ? token : undefined, req.body, borrowedRouteFacts(req));
      res.status(a.status).json(a.body);
    } catch {
      res.status(200).json({ ok: false, reason: 'no-helper-answer' }); // @silent-fallback-ok: the proxy can never hold or break a lane; the child runs the files itself
    }
  });

  router.post('/local-verify/peer-baseline', (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    const ctx = leaseCtx();
    const a = svc.peerBaseline(req.body, { holdsLease: ctx.holdsLease, holderMachineId: ctx.holderMachineId });
    res.status(a.status).json(a.body);
  });

  router.get('/local-verify/peer-diagnosis-status', (_req: Request, res: Response) => {
    const svc = peerGate(res);
    if (svc) res.json(svc.diagnosisPeerStatus());
  });

  router.post('/local-verify/peer-diagnose', async (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    const request = parseDiagnosisPeerRequest(req.body);
    if (!request) { res.status(400).json({ accepted: false, reason: 'invalid-request' }); return; }
    const answer = await svc.diagnosisPeerAccept(request, leaseCtx());
    res.status(answer.accepted ? 202 : answer.reason === 'disabled' ? 503 : 409).json(answer);
  });

  router.get('/local-verify/peer-diagnosis-result', (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    const id = String(req.query.attemptId ?? '');
    if (!ATTEMPT_ID_RE.test(id)) { res.status(400).json({ error: 'need attemptId (32 lowercase hex)' }); return; }
    res.json(svc.diagnosisPeerResult(id));
  });
}
