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
 *                                        (the dry-run task, borrowedDryRun.ts, consumes it)
 *   POST /local-verify/helper-here       the paired helper's signed "I am here"
 *   POST /local-verify/borrowed-proxy    LOOPBACK ONLY, authenticated by a running verify's attempt
 *                                        token (header X-Instar-Attempt-Token) in place of the Bearer
 *                                        credential: the verify child's way to its helper. The commits,
 *                                        the lanes' states and the helper come from the server's record
 *                                        of that verify, never from the request
 *   POST /local-verify/peer-baseline     the coordinator's baseline results, stored by a peer
 *   POST /local-verify/peer-main-red     the coordinator's red `main` (head and failed files), for a peer's counted helper passes
 *   GET  /local-verify/record   ?pr=&head=&base=  the record for one key, or 404
 *   POST /local-verify/peer-run     a coordinator hands this machine one PR verify (Part D of
 *                                   docs/specs/local-verify-capacity.md); refused on the lease holder
 *   GET  /local-verify/peer-status  this machine's peer slot (served on a non-holder)
 *   GET  /local-verify/peer-result  ?attemptId=  unknown | running | done + record
 *   POST /local-verify/peer-cancel  { attemptId }: tombstone it, cancel it if running
 *   POST /local-verify/queue/hold     { pr, by, reason, until?, blockMerge? }  hold a change out of the queue
 *   POST /local-verify/queue/release  { pr, by }                               end a hold
 *   POST /local-verify/queue/front    { pr, by, reason }                       the next change to start
 *   POST /local-verify/queue/unfront  { pr, by }                               end a front mark
 *                               (spec docs/specs/local-verify-queue-controls.md; 404 unless
 *                               `monitoring.localVerify.queueControls` is true; lease holder only)
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
import { OPERATOR_QUEUE_LIMITS, cleanLabel, cleanMergeHoldReason, parseUntil } from './operatorQueue.js';
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
  /**
   * The merge-side hold (the `[HOLD]` marker): the same function `POST /green-pr-automerge/hold`
   * calls. A queue hold with `blockMerge: true` applies it too. Absent ⇒ the answer says the
   * merge-side hold is unavailable; the queue hold still applies.
   */
  applyMergeHold?: (pr: number, reason: string) => Promise<{ ok: boolean; status?: number; detail?: string }>;
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
    case 'release-fragment-missing':
    case 'main-unhealthy':
    case 'held':
    case 'pr-closed': return 409;
    case 'overflow-full': return 429;
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

/** A parsed queue-control body, or the reason it was refused. Exported for tests. */
export type QueueControlBody =
  | { ok: true; pr: number; by: string; reason?: string; until?: number; blockMerge?: boolean }
  | { ok: false; error: string };

/**
 * Validate a queue-control body: only the keys the route knows, `pr` a positive integer, `by`
 * required on all four routes, `reason` required on hold and front (up to 500 characters; a
 * longer one is refused, never cut), `until` a date, `blockMerge` a boolean. Pure.
 */
export function parseQueueControlBody(body: unknown, kind: 'hold' | 'release' | 'front' | 'unfront'): QueueControlBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const allowed = kind === 'hold' ? ['pr', 'by', 'reason', 'until', 'blockMerge'] : kind === 'front' ? ['pr', 'by', 'reason'] : ['pr', 'by'];
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length > 0) return { ok: false, error: `unknown field: ${extra.slice(0, 3).join(', ')} (allowed: ${allowed.join(', ')})` };
  const pr = b.pr;
  if (typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr <= 0) return { ok: false, error: 'pr must be a positive integer' };
  const by = cleanLabel(b.by, OPERATOR_QUEUE_LIMITS.byChars);
  if (!by) return { ok: false, error: `by is required: the name of the session or person asking (1 to ${OPERATOR_QUEUE_LIMITS.byChars} characters)` };
  if (kind === 'release' || kind === 'unfront') return { ok: true, pr, by };
  const reason = cleanLabel(b.reason, OPERATOR_QUEUE_LIMITS.reasonChars);
  if (!reason) return { ok: false, error: `reason is required (1 to ${OPERATOR_QUEUE_LIMITS.reasonChars} characters)` };
  if (kind === 'front') return { ok: true, pr, by, reason };
  const until = parseUntil(b.until);
  if (until === null) return { ok: false, error: 'until must be a date (ISO 8601, or milliseconds) that a calendar can hold' };
  if (b.blockMerge !== undefined && typeof b.blockMerge !== 'boolean') return { ok: false, error: 'blockMerge must be true or false' };
  return { ok: true, pr, by, reason, ...(until !== undefined ? { until } : {}), ...(b.blockMerge === true ? { blockMerge: true } : {}) };
}

/** HTTP status for a refused queue control. Exported for tests. */
export function statusForQueueControlRefusal(code: string): number {
  switch (code) {
    case 'disabled': return 404;
    case 'invalid-pr':
    case 'invalid-time': return 400;
    case 'not-held':
    case 'not-fronted':
    case 'front-limit':
    case 'held':
    case 'release-fragment-missing':
    case 'main-unhealthy':
    case 'pr-closed': return 409;
    case 'operator-file-full':
    case 'overflow-full':
    case 'queue-full': return 429;
    case 'untrusted-head': return 403;
    case 'pr-unreadable':
    case 'pr-invalid-shas': return 502;
    case 'stopping':
    case 'peer-only': return 503;
    default: return 500;
  }
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

  // ---- operator queue controls (spec local-verify-queue-controls.md) ----
  // Off unless `monitoring.localVerify.queueControls` is true on this machine (404), and only
  // the machine holding the coordinator lease answers (409), like the routes above. `by` is a
  // label for the audit row, not a proof of identity: the routes trust the server's credential.
  const controlGate = (res: Response): LocalVerifyService | null => {
    const svc = deps.service();
    if (!svc) {
      res.status(503).json({ error: 'local-verify not configured (no instar source checkout, or disabled)' });
      return null;
    }
    if (!svc.queueControlsOn()) {
      res.status(404).json({ error: 'queue-controls-off', detail: 'Set monitoring.localVerify.queueControls to true on the machine that runs the test line to use hold and front.' });
      return null;
    }
    return gate(res);
  };

  router.post('/local-verify/queue/hold', async (req: Request, res: Response) => {
    const svc = controlGate(res);
    if (!svc) return;
    const body = parseQueueControlBody(req.body, 'hold');
    if (!body.ok) { res.status(400).json({ error: body.error }); return; }
    const r = await svc.operatorHold({ pr: body.pr, by: body.by, reason: body.reason!, ...(body.until !== undefined ? { until: body.until } : {}) });
    // One request carries the whole intent: with blockMerge the existing merge-side hold is applied
    // too. If GitHub refuses, the queue hold still applies and the answer says which of the two did.
    let mergeHold: 'not-requested' | 'applied' | 'failed' | 'unavailable' = 'not-requested';
    let mergeHoldDetail: string | undefined;
    if (body.blockMerge) {
      if (!deps.applyMergeHold) { mergeHold = 'unavailable'; mergeHoldDetail = 'the merge watcher is not configured on this machine'; }
      else {
        try {
          const m = await deps.applyMergeHold(body.pr, cleanMergeHoldReason(body.reason));
          mergeHold = m.ok ? 'applied' : 'failed';
          if (!m.ok) mergeHoldDetail = typeof m.detail === 'string' ? m.detail.slice(0, 200) : 'the merge-side hold was refused';
        } catch (e) {
          mergeHold = 'failed';
          mergeHoldDetail = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        }
      }
    }
    const merge = { queueHold: r.ok, mergeHold, ...(mergeHoldDetail ? { mergeHoldDetail } : {}) };
    res.status(r.ok ? 200 : statusForQueueControlRefusal(r.code)).json({ ...r, ...merge });
  });

  router.post('/local-verify/queue/release', async (req: Request, res: Response) => {
    const svc = controlGate(res);
    if (!svc) return;
    const body = parseQueueControlBody(req.body, 'release');
    if (!body.ok) { res.status(400).json({ error: body.error }); return; }
    const r = await svc.operatorRelease({ pr: body.pr, by: body.by });
    if (!r.ok) { res.status(statusForQueueControlRefusal(r.code)).json(r); return; }
    // A release ends the queue hold only: a merge-side [HOLD] marker stays until it is removed on GitHub.
    res.status(200).json({ ...r, mergeHold: 'not-removed', note: 'A merge-side [HOLD] marker, if one was set, is not removed by a release.' });
  });

  router.post('/local-verify/queue/front', async (req: Request, res: Response) => {
    const svc = controlGate(res);
    if (!svc) return;
    const body = parseQueueControlBody(req.body, 'front');
    if (!body.ok) { res.status(400).json({ error: body.error }); return; }
    const r = await svc.operatorFront({ pr: body.pr, by: body.by, reason: body.reason! });
    res.status(r.ok ? 200 : statusForQueueControlRefusal(r.code)).json(r);
  });

  router.post('/local-verify/queue/unfront', (req: Request, res: Response) => {
    const svc = controlGate(res);
    if (!svc) return;
    const body = parseQueueControlBody(req.body, 'unfront');
    if (!body.ok) { res.status(400).json({ error: body.error }); return; }
    const r = svc.operatorUnfront({ pr: body.pr, by: body.by });
    res.status(r.ok ? 200 : statusForQueueControlRefusal(r.code)).json(r);
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

  router.get('/local-verify/first-part-report', (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (svc) res.json(svc.firstPartReport.report(svc.likelyFailingFirst(), req.query.evaluate === '1'));
  });
  router.post('/local-verify/first-part-report/new-trial', (_req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    svc.firstPartReport.marker(svc.likelyFailingFirst());
    res.json(svc.firstPartReport.report(svc.likelyFailingFirst()));
  });
  router.post('/local-verify/first-part-finding', (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    if (!svc.firstPartReport.finding(req.body)) { res.status(400).json({ error: 'invalid finding or unknown suspect' }); return; }
    res.json(svc.firstPartReport.report(svc.likelyFailingFirst()));
  });

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

  router.get('/local-verify/trial-receipts', (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    const id = req.query.coordinator;
    if (typeof id !== 'string' || !id || id.length > 200) { res.status(400).json({ error: 'invalid coordinator' }); return; }
    const ids = typeof req.query.ids === 'string' ? req.query.ids.split(',') : [];
    if (!ids.length || ids.length > 8 || !ids.every(attempt => ATTEMPT_ID_RE.test(attempt))) {
      res.status(400).json({ error: 'invalid attempt IDs' }); return;
    }
    res.json(svc.trialReceiptsFor(id, ids));
  });
  router.post('/local-verify/trial-receipts/ack', (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    const ok = svc.acknowledgeTrialReceipt(req.body);
    res.status(ok ? 200 : 409).json({ok});
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

  router.post('/local-verify/peer-trial-lease', (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    const b = req.body;
    if (!b || !ATTEMPT_ID_RE.test(b.attemptId) || typeof b.coordinatorMachineId !== 'string'
      || !Number.isSafeInteger(b.leaseEpoch) || (b.nonce !== undefined && !ATTEMPT_ID_RE.test(b.nonce))) {
      res.status(400).json({ reason: 'invalid-request' }); return;
    }
    const nonce = svc.trialLease(b.attemptId, b.coordinatorMachineId, b.leaseEpoch, b.nonce);
    res.status(nonce ? 200 : 409).json({ nonce });
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

  router.post('/local-verify/peer-main-red', (req: Request, res: Response) => {
    const svc = peerGate(res);
    if (!svc) return;
    const ctx = leaseCtx();
    const a = svc.peerMainRed(req.body, { holdsLease: ctx.holdsLease, holderMachineId: ctx.holderMachineId });
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
