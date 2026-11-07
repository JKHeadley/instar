/**
 * Skill Learning Sentinel — the operator surface (docs/specs/skill-learning-sentinel.md §3.10, slice 1).
 *
 *   GET  /skills/learned                              this machine's status snapshot (503 `skill-learning-disabled` when off)
 *   GET  /skills/learned/:name                        one learned skill or proposal (404 when unknown)
 *   POST /skills/learned/proposals/:name/agree        operator verdict on a shadow proposal — bearer + operator PIN
 *   POST /skills/learned/proposals/:name/disagree     same, `{ reason }` required (400 without)
 *   POST /skills/learned/pending/:name/confirm        slice 2: the operator's one-tap confirm of a `pending` skill
 *   POST /skills/learned/pending/:name/reject         slice 2: the mirror tap — the skill goes back to proposals
 *
 * The pending taps forward FIRST (`forwardToHolder`, deviations (w)/(x)): a machine that is not the
 * lease holder sends the request BODY UNCHANGED, PIN INCLUDED, to the holder with the asserted
 * `X-Instar-Forwarded-From: <meshSelfId>` header and never pre-validates the PIN (the holder runs
 * `checkMandatePin` on its own counters, keyed by the forwarding machine, and records
 * `forwardedFromMachine` as the origin). A coordinator that names no holder while this machine does not
 * hold the lease, or a holder the fetch cannot reach, is `503 lease-holder-unreachable`; the holder's
 * status is passed through with `handledBy: 'holder-proxy'`. The slice-1 proposal taps keep their own
 * (pre-validating) forward.
 *
 * Reads answer for THIS machine and name it (`machine`). Writes run the shared operator-PIN gate
 * (mandatePin.ts, the same check as mandate issuance) with a skill-specific message, then land on
 * the Telegram lease holder: when `ctx.resolveRouterUrl()` names another machine the tap is forwarded
 * there (the holder re-runs the PIN check on its own counters); a holder that cannot be reached is a
 * visible `503 lease-holder-unreachable`, never a silent local write. A forwarded request carries
 * `X-Instar-Skill-Learning-Forwarded` and is never forwarded again, so no machine proxies to itself
 * even if two resolvers disagree about who holds the lease. `:name` is validated against
 * SKILL_NAME_RE at the edge (400) before anything else reads it.
 *
 * The routes consume `SkillLearningSentinelLike` through an injected getter; the sentinel itself is
 * built in src/monitoring/SkillLearningSentinel.ts and bound with `AgentServer.setSkillLearningSentinel()`.
 */
import { Router, type Request, type Response } from 'express';
import type { RouteContext } from './routes.js';
import { createMandatePinCheck } from './mandatePin.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';
import { SKILL_NAME_RE, type SkillLearningSentinelLike } from '../monitoring/skillLearning/types.js';

export const SKILL_LEARNING_DISABLED = 'skill-learning-disabled';
export const LEASE_HOLDER_UNREACHABLE = 'lease-holder-unreachable';
export const SKILL_LEARNING_PIN_MESSAGE = 'Operator PIN required — agreeing or disagreeing with a learned-skill proposal is a human action, not an agent action';
export const FORWARDED_HEADER = 'x-instar-skill-learning-forwarded';
export const SKILL_LEARNING_PENDING_PIN_MESSAGE = 'Operator PIN required — confirming or rejecting a pending learned skill is a human action, not an agent action';
/** Asserted (bearer-authenticated, unsigned): the mesh id of the machine that forwarded a pending tap. */
export const FORWARDED_FROM_HEADER = 'x-instar-forwarded-from';
const FORWARDED_FROM_RE = /^[\w.:@-]{1,160}$/;
/** Longest reason the disagree tap accepts; the console's select never exceeds it. */
export const MAX_REASON_CHARS = 200;

type SkillCtx = Pick<RouteContext, 'config' | 'meshSelfId' | 'machinePoolRegistry' | 'resolveRouterUrl' | 'pinAttemptStore'> & Partial<Pick<RouteContext, 'coordinator' | 'listPoolMachines'>> & {
  skillLearningSentinel: () => SkillLearningSentinelLike | null;
};

/** The forwarding machine named by a forwarded pending tap, or null when the request arrived directly. */
export function forwardedFromOf(req: Request): string | null {
  const v = req.get(FORWARDED_FROM_HEADER);
  return typeof v === 'string' && FORWARDED_FROM_RE.test(v) ? v : null;
}

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  const bare = ip.replace(/^::ffff:/, '');
  return bare === '127.0.0.1' || bare === '::1' || bare.startsWith('127.');
}

/** Is `machineId` a machine in this agent's mesh roster (pool registry / coordinator registry)? */
function isRosterMachine(ctx: SkillCtx, machineId: string): boolean {
  if (ctx.meshSelfId && machineId === ctx.meshSelfId) return false; // never "forwarded from" ourselves
  try {
    if (ctx.listPoolMachines?.()?.some((m) => m.machineId === machineId)) return true;
  } catch { /* @silent-fallback-ok — an unreadable pool list answers "not a roster machine": the IP bucket applies */ }
  try {
    if (ctx.machinePoolRegistry?.getCapacities().some((c) => c.machineId === machineId)) return true;
  } catch { /* @silent-fallback-ok — same: unknown is never a bucket of its own */ }
  try {
    const machines = ctx.coordinator?.managers?.identityManager?.loadRegistry()?.machines ?? {};
    const entry = (machines as Record<string, { revokedAt?: string | null } | undefined>)[machineId];
    if (entry && !entry.revokedAt) return true;
  } catch { /* @silent-fallback-ok — an unreadable registry is not a roster */ }
  return false;
}

/**
 * The PIN-lockout bucket a forwarded tap may ADD to the caller's IP bucket (deviation (y)). Only a
 * header naming a machine in the mesh roster, on a request that did not arrive over loopback, earns
 * its own bucket; anything else is just the IP bucket — a bearer holder cannot mint fresh buckets
 * by inventing header values, and both buckets are checked and charged.
 */
export function forwardedBucketOf(ctx: SkillCtx, req: Request): string | null {
  const from = forwardedFromOf(req);
  if (!from) return null;
  if (isLoopback(req.ip || req.socket?.remoteAddress)) return null;
  return isRosterMachine(ctx, from) ? `forwarded:${from}` : null;
}

export function isSkillLearningEnabled(config: SkillCtx['config']): boolean {
  return config.monitoring?.skillLearning?.enabled === true;
}

function machineName(ctx: SkillCtx): string {
  const id = ctx.meshSelfId;
  if (!id) return 'this machine';
  return verifiedEntityName(id, ctx.machinePoolRegistry?.getCapacity(id)?.nickname) ?? 'this machine';
}

/** The holder URL when another machine holds the lease; null when this machine does (or no pool). */
function holderUrlOf(ctx: SkillCtx, req: Request): string | null {
  if (req.get(FORWARDED_HEADER)) return null; // already forwarded once: answer here, never bounce
  const url = ctx.resolveRouterUrl?.() ?? null;
  if (!url) return null;
  try {
    const u = new URL(url);
    const port = String(ctx.config.port ?? '');
    const selfHost = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
    if (selfHost && port && u.port === port) return null; // a resolver pointing at our own port is not a holder
  } catch { return null; } // @silent-fallback-ok — an unparseable holder URL cannot be forwarded to; the write lands here
  return url;
}

export function createSkillLearningRoutes(ctx: SkillCtx, timings: { forwardTimeoutMs?: number } = {}): Router {
  const FORWARD_TIMEOUT_MS = timings.forwardTimeoutMs ?? 5_000;
  const router = Router();
  const requireMandatePin = createMandatePinCheck({ dashboardPin: () => ctx.config.dashboardPin, pinAttemptStore: () => ctx.pinAttemptStore });

  /** The live sentinel, or a 503 already sent. */
  const live = (res: Response): SkillLearningSentinelLike | null => {
    const sentinel = isSkillLearningEnabled(ctx.config) ? ctx.skillLearningSentinel() : null;
    if (!sentinel) { res.status(503).json({ error: SKILL_LEARNING_DISABLED, machine: machineName(ctx) }); return null; }
    return sentinel;
  };

  /** `:name` validated at the edge, or a 400 already sent. */
  const nameOf = (req: Request, res: Response): string | null => {
    const name = req.params.name;
    if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) { res.status(400).json({ error: 'invalid-skill-name' }); return null; }
    return name;
  };

  router.get('/skills/learned', (_req, res) => {
    const sentinel = live(res);
    if (!sentinel) return;
    res.json({ ...sentinel.status(), machine: machineName(ctx) });
  });

  router.get('/skills/learned/:name', (req, res) => {
    const name = nameOf(req, res);
    if (!name) return;
    const sentinel = live(res);
    if (!sentinel) return;
    const entry = sentinel.skill(name);
    if (!entry) { res.status(404).json({ error: 'not-found', name }); return; }
    res.json({ ...entry, machine: machineName(ctx) });
  });

  const verdictRoute = (verdict: 'agree' | 'disagree') => async (req: Request, res: Response) => {
    const name = nameOf(req, res);
    if (!name) return;
    const sentinel = live(res);
    if (!sentinel) return;
    const body = (req.body ?? {}) as { reason?: unknown; pin?: unknown };
    let reason: string | undefined;
    if (verdict === 'disagree') {
      reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, MAX_REASON_CHARS) : '';
      if (!reason) { res.status(400).json({ error: 'reason-required' }); return; }
    }
    if (!requireMandatePin(req, res, { message: SKILL_LEARNING_PIN_MESSAGE })) return; // 503/429/403 already sent
    const holderUrl = holderUrlOf(ctx, req);
    if (holderUrl) {
      try {
        const r = await fetch(`${holderUrl}/skills/learned/proposals/${encodeURIComponent(name)}/${verdict}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ctx.config.authToken}`, 'Content-Type': 'application/json', [FORWARDED_HEADER]: machineName(ctx) },
          body: JSON.stringify({ pin: body.pin, ...(reason ? { reason } : {}) }),
          signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
        });
        // @silent-fallback-ok — a non-JSON holder body still forwards the holder's status; the status is the signal
        const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        res.status(r.status).json({ ...j, handledBy: 'holder-proxy' });
      } catch (err) {
        // NOT silent: the tap did not land anywhere; the caller sees the exact reason.
        res.status(503).json({ error: LEASE_HOLDER_UNREACHABLE, detail: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    const out = sentinel.recordOperatorVerdict(name, verdict, reason);
    if (!out.ok) { res.status(out.error === 'not-found' ? 404 : 409).json({ error: out.error, name }); return; }
    res.json({ ok: true, name, verdict, ...(reason ? { reason } : {}), machine: machineName(ctx) });
  };

  router.post('/skills/learned/proposals/:name/agree', verdictRoute('agree'));
  router.post('/skills/learned/proposals/:name/disagree', verdictRoute('disagree'));

  /**
   * Forward a write to the lease holder, body unchanged. Returns true when the response is already
   * sent (proxied, or 503); false when this machine answers locally (it is the holder, there is no
   * pool, or the request was itself forwarded here).
   */
  const forwardToHolder = async (req: Request, res: Response): Promise<boolean> => {
    if (forwardedFromOf(req)) return false; // forwarded here once: answer here, never bounce
    const holderUrl = holderUrlOf(ctx, req);
    if (!holderUrl) {
      // Deviation (w): a null router URL is not proof of holding. With a coordinator, "no known
      // holder" while this machine does not hold the lease is unreachable, never a local write.
      const coordinator = ctx.coordinator ?? null;
      if (coordinator) {
        let holds = false;
        try { holds = coordinator.holdsLease(); } catch { holds = false; } // @silent-fallback-ok — an unreadable lease reads as NOT held: the tap is refused visibly below, never written blind
        if (!holds) {
          res.status(503).json({ error: LEASE_HOLDER_UNREACHABLE, detail: 'this machine does not hold the operator-messaging lease and no lease holder is known', machine: machineName(ctx) });
          return true;
        }
      }
      return false;
    }
    try {
      const r = await fetch(`${holderUrl}${req.originalUrl}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.config.authToken}`,
          'Content-Type': 'application/json',
          [FORWARDED_FROM_HEADER]: ctx.meshSelfId ?? machineName(ctx),
          [FORWARDED_HEADER]: machineName(ctx),
        },
        body: JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      // @silent-fallback-ok — a non-JSON holder body still forwards the holder's status; the status is the signal
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      res.status(r.status).json({ ...j, handledBy: 'holder-proxy' });
    } catch (err) {
      // NOT silent: the tap did not land anywhere; never queued.
      res.status(503).json({ error: LEASE_HOLDER_UNREACHABLE, detail: err instanceof Error ? err.message : String(err), machine: machineName(ctx) });
    }
    return true;
  };

  const pendingRoute = (tap: 'confirm' | 'reject') => async (req: Request, res: Response) => {
    const name = nameOf(req, res);
    if (!name) return;
    if (!isSkillLearningEnabled(ctx.config)) { res.status(503).json({ error: SKILL_LEARNING_DISABLED, machine: machineName(ctx) }); return; }
    if (await forwardToHolder(req, res)) return; // proxied or 503 — the standby never pre-validates the PIN
    const sentinel = live(res);
    if (!sentinel) return;
    const forwardedFromMachine = forwardedFromOf(req);
    const forwardedBucket = forwardedBucketOf(ctx, req);
    if (!requireMandatePin(req, res, { message: SKILL_LEARNING_PENDING_PIN_MESSAGE, ...(forwardedBucket ? { forwardedBucketKey: forwardedBucket } : {}) })) return; // 503/429/403 already sent
    const opts = forwardedFromMachine ? { forwardedFromMachine } : undefined;
    const out = tap === 'confirm' ? await sentinel.confirmPending(name, opts) : await sentinel.rejectPending(name, opts);
    if (!out.ok) { res.status(out.error === 'not-found' || out.error === 'pending-not-found' ? 404 : 409).json({ error: out.error, name, machine: machineName(ctx) }); return; }
    res.json({ ok: true, name, action: tap, machine: machineName(ctx), ...(forwardedFromMachine ? { forwardedFromMachine } : {}) });
  };

  router.post('/skills/learned/pending/:name/confirm', pendingRoute('confirm'));
  router.post('/skills/learned/pending/:name/reject', pendingRoute('reject'));

  return router;
}
