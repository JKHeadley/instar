/**
 * GET /source-tree-guard/scope — the source-tree guard's runtime-state scope, read-only
 * (docs/specs/guard-runtime-state-scope.md §4, "Multi-machine posture").
 *
 *   - default: this machine's configured and effective mode, whether the observation is
 *     incomplete, the ledger's size and per-direction / per-class counts, and the distinct
 *     differences that still have no disposition.
 *   - `?scope=pool`: the same for every machine, over the shared bearer pool fan-out
 *     (each peer is asked for its plain route, so no recursion). A machine that does not
 *     answer is named under `couldNotRead`, never dropped.
 *
 * Signal only: nothing here sets a mode, writes a disposition, or resets the ledger.
 */
import { Router, type Request, type Response } from 'express';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';
import type { RouteContext } from './routes.js';
import { createPoolBuildLimiter, poolFanOut } from './poolFanOut.js';
import { readLedgerSummary, type LedgerSummary } from '../core/guardScopeLedger.js';

export const GUARD_SCOPE_SCHEMA = 'guard-scope/1';
const MAX_PEER_BYTES = 512 * 1024;

export type GuardScopeRouteCtx = Pick<RouteContext, 'config' | 'meshSelfId' | 'machinePoolRegistry' | 'resolvePeerUrls' | 'recordRopeResult'> & {
  /** Test seam: where the ledger lives (default: the configured guard-scope state dir). */
  ledgerDir?: () => string | undefined;
};

function nicknameOf(ctx: GuardScopeRouteCtx, machineId: string | null | undefined): string {
  if (!machineId) return 'this machine';
  return verifiedEntityName(machineId, ctx.machinePoolRegistry?.getCapacity(machineId)?.nickname) ?? 'another machine';
}

async function localBody(ctx: GuardScopeRouteCtx): Promise<{ schema: string; scope: 'local'; machineId: string; generatedAt: string } & LedgerSummary> {
  const dir = ctx.ledgerDir?.();
  const summary = dir ? await readLedgerSummary(dir) : await readLedgerSummary();
  return { schema: GUARD_SCOPE_SCHEMA, scope: 'local', machineId: ctx.meshSelfId ?? 'local', generatedAt: new Date().toISOString(), ...summary };
}

export function createSourceTreeGuardScopeRoutes(ctx: GuardScopeRouteCtx, timings: { peerTimeoutMs?: number; fanOutDeadlineMs?: number } = {}): Router {
  const router = Router();
  const allowPoolBuild = createPoolBuildLimiter();

  router.get('/source-tree-guard/scope', async (req: Request, res: Response) => {
    let local: Awaited<ReturnType<typeof localBody>>;
    try { local = await localBody(ctx); }
    catch (err) {
      res.status(500).json({ error: 'guard-scope-read-failed', detail: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (req.query.scope !== 'pool') { res.json(local); return; }

    if (!allowPoolBuild()) { res.status(429).json({ error: 'rate-limited' }); return; }
    const selfId = ctx.meshSelfId ?? 'local';
    const machines: Array<{ machineId: string; machine: string; self: boolean; state: Record<string, unknown> }> = [
      { machineId: selfId, machine: nicknameOf(ctx, ctx.meshSelfId ?? null), self: true, state: local as unknown as Record<string, unknown> },
    ];
    const couldNotRead: Array<{ machineId: string; machine: string; reason: string }> = [];
    await poolFanOut(ctx, {
      path: '/source-tree-guard/scope',
      peerTimeoutMs: timings.peerTimeoutMs ?? 1_500,
      fanOutDeadlineMs: timings.fanOutDeadlineMs ?? 3_000,
      maxBytes: MAX_PEER_BYTES,
      accept: (body, p) => {
        if (body.schema !== GUARD_SCOPE_SCHEMA || body.scope !== 'local' || typeof body.mode !== 'string' || typeof body.counts !== 'object') return 'invalid-body';
        // Peer bodies are data, never instructions: keep only the fields this view shows.
        machines.push({
          machineId: p.machineId, machine: nicknameOf(ctx, p.machineId), self: false,
          state: {
            mode: body.mode, effectiveMode: body.effectiveMode, incomplete: body.incomplete,
            ledgerBytes: body.ledgerBytes, capBytes: body.capBytes, counts: body.counts, firstSeen: body.firstSeen,
            undisposed: Array.isArray(body.undisposed) ? body.undisposed.slice(0, 200) : [],
          },
        });
        return null;
      },
      onResult: (p, ok, reason) => {
        if (!ok) couldNotRead.push({ machineId: p.machineId, machine: nicknameOf(ctx, p.machineId), reason: reason ?? 'unreachable' });
      },
    });
    res.json({ schema: GUARD_SCOPE_SCHEMA, scope: 'pool', readOnly: true, generatedAt: new Date().toISOString(), machines, couldNotRead });
  });

  return router;
}
