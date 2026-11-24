/** Read-only Accounts HTTP composition shared by the production router and design harness.
 * Raw providers are injected; tagging, aggregation, response/error behavior remain production code.
 * This factory starts no timers, opens no store and performs no host discovery.
 */
import type { RequestHandler } from 'express';
import type { RouteContext } from './routes.js';
import type { InUseAccountResolver } from '../core/InUseAccountResolver.js';
import type { SubscriptionPoolAvailability } from '../core/SubscriptionPool.js';
import type { SiblingHoldingsCache } from '../core/sibling-holdings.js';
import { poolPeerFetch } from './poolPeerFetch.js';
import { operatorError } from '../core/storageMachineName.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';
import { machineKey } from './mobileOpsRoutes.js';
import { formatLivenessLine } from '../core/machineLiveness.js';
import { decorateWithRopeCondition, decorateWithReconnect } from './poolRopeCondition.js';

export type AccountsReadContext = Pick<RouteContext, 'config' | 'meshSelfId' | 'recordRopeResult' | 'resolvePeerUrls'> & {
  subscriptionPool?: Pick<NonNullable<RouteContext['subscriptionPool']>, 'list'> | null;
  quotaPoller?: Pick<NonNullable<RouteContext['quotaPoller']>, 'loginCheck'> | null;
  machinePoolRegistry?: Pick<NonNullable<RouteContext['machinePoolRegistry']>, 'getCapacity' | 'getCapacities'> | null;
  subscriptionRelogin?: {
    store: Pick<NonNullable<RouteContext['subscriptionRelogin']>['store'], 'list'>;
    blockers?: NonNullable<RouteContext['subscriptionRelogin']>['blockers'];
    lastResortStatus?: NonNullable<RouteContext['subscriptionRelogin']>['lastResortStatus'];
  } | null;
  inUseAccountResolver?: Pick<InUseAccountResolver, 'resolve'> | null;
  coordinator?: Pick<NonNullable<RouteContext['coordinator']>, 'getSyncStatus'> | null;
  ropeHealthMonitor?: Pick<NonNullable<RouteContext['ropeHealthMonitor']>, 'status'> | null;
  mutualSshHealth?: RouteContext['mutualSshHealth'];
};
export interface AccountsReadDeps {
  subscriptionPoolAvailability: () => SubscriptionPoolAvailability | null;
  subscriptionPoolReadable: () => boolean;
  subscriptionPoolFailureBody: () => Record<string, unknown>;
  subscriptionEmailGaps: () => Array<{ accountId: string; nickname: string; provider: string; framework: string; reason: string }>;
  subscriptionEmailReconciliation: () => { state: 'running' | 'degraded' | 'complete'; unresolvedCount: number; repairRunsFreshProbe: boolean };
  localReloginConfig: () => ({ machineId: string } & Record<string, unknown>) | null;
  deviceLimitStatus: () => unknown;
  recoveryPoolView: () => unknown;
  siblingHoldings: () => Pick<SiblingHoldingsCache, 'snapshot' | 'status'> | null | undefined;
  bearerMatches: (req: Parameters<RequestHandler>[0], token: string | undefined) => boolean;
  peerFetch?: typeof poolPeerFetch;
  now?: () => number;
}
export interface AccountsReadHandlers {
  poolView: () => Record<string, unknown>;
  subscriptionPoolScopeView: () => Promise<Record<string, unknown>>;
  pool: RequestHandler;
  subscriptionPool: RequestHandler;
  subscriptionRelogin: RequestHandler;
  inUse: RequestHandler;
}
export function createAccountsReadHandlers(ctx: AccountsReadContext, deps: AccountsReadDeps): AccountsReadHandlers {
  const { subscriptionPoolAvailability, subscriptionPoolReadable, subscriptionPoolFailureBody,
    subscriptionEmailGaps, subscriptionEmailReconciliation, localReloginConfig, recoveryPoolView,
    bearerMatches } = deps;
  const fetchPeer = deps.peerFetch ?? poolPeerFetch;
  function poolView(): Record<string, unknown> {
    const sync = ctx.coordinator ? ctx.coordinator.getSyncStatus() : null;
    // Rope-condition decoration: the registry's `online` flag feeds placement and
    // ages out on the conservative failoverThreshold (~15 min observed), while
    // the rope-health monitor knows a peer's transports are down within one
    // evaluation. Attach the live classification so reachability renders
    // honestly without touching placement semantics. Monitor dark → absent.
    const nickOf = (id: string): string => verifiedEntityName(id, ctx.machinePoolRegistry?.getCapacity(id)?.nickname) ?? 'another machine';
    // CMT-1541: whether this machine is re-dialing a peer it cannot reach (prober dark → absent).
    const machines = decorateWithReconnect(decorateWithRopeCondition(
      ctx.machinePoolRegistry ? ctx.machinePoolRegistry.getCapacities() : [],
      ctx.ropeHealthMonitor?.status().peers,
    ), sync?.ropeHealth).map((m) => ({
      ...m,
      // trustworthy-machine-load A5: the one wording template, rendered server-side
      // so every consumer (dashboard, digests, peers) says the same honest thing.
      ...(m.liveness ? { livenessLine: formatLivenessLine(m.liveness, nickOf) } : {}),
    }));
    const sshEnrollment = ctx.mutualSshHealth ? ctx.mutualSshHealth() : null;
    return {
      enabled: !!ctx.machinePoolRegistry,
      // dashboard-new-session-machine-choice §3.5 — the page labels its OWN server.
      selfMachineId: ctx.meshSelfId ?? null,
      router: sync
        ? {
            holder: sync.leaseHolder,
            epoch: sync.leaseEpoch,
            holdsLease: sync.holdsLease,
            awakeMachineCount: sync.awakeMachineCount,
            awakeMachineCountSource: sync.awakeMachineCountSource,
            splitBrainState: sync.splitBrainState,
          }
        : null,
      machines,
      sshEnrollment,
      serverDownRecovery: recoveryPoolView(),
    };
  }

  async function subscriptionPoolScopeView(): Promise<Record<string, unknown>> {
    // WS5.1 — pool-scope read: "how much quota is left across ALL my machines /
    // accounts?" in ONE view. Mirrors GET /sessions?scope=pool exactly: fan out
    // to every ONLINE-registered peer's PLAIN /subscription-pool (NEVER
    // ?scope=pool — no recursion), tag each remote account with the machine that
    // holds it, and merge into one dark-peer-tolerant object. Tolerant by design:
    // a down/slow/401 peer contributes a classified `pool.failed` row (normalized
    // reason — never a peer URL/token/raw TLS error, never a 500). Per-machine
    // seat is meaningful, so the SAME account on two machines is kept
    // individually visible — never P17-coalesced (differs from attention notices).
    // Single-machine / no resolvePeerUrls → the plain self-only view tagged
    // scope:'pool' with an empty pool.failed (a strict no-op superset).
    const selfMachineId = ctx.meshSelfId ?? null;
    const selfMachineNickname = selfMachineId
      ? (ctx.machinePoolRegistry?.getCapacity(selfMachineId)?.nickname ?? null)
      : null;
    const localAvailability = subscriptionPoolAvailability();
    const localReadable = !ctx.subscriptionPool || subscriptionPoolReadable();
    const localRows = ctx.subscriptionPool && localReadable ? ctx.subscriptionPool.list() : [];
    const selfAccounts = localRows.map((a) => ({
      ...a,
      // The login signal behind the status (spec skill-driven-signin-repair): never silent.
      loginCheck: ctx.quotaPoller?.loginCheck?.(a.id) ?? 'unavailable',
      // codex-device-limit-tripwire §8: always present on new code (null = no cause).
      statusCause: a.statusCause ?? null,
      machineId: selfMachineId,
      machineNickname: selfMachineNickname ?? undefined,
      remote: false,
    }));

    const peers = ctx.resolvePeerUrls?.() ?? [];
    const failed: Array<{ machineId: string; error: string }> = [];
    if (ctx.subscriptionPool && !localReadable) {
      failed.push({
        machineId: selfMachineId ?? 'self',
        error: localAvailability?.state === 'invalid'
          ? 'peer-pool-invalid'
          : 'peer-pool-unavailable',
      });
    } else if (localAvailability?.state === 'unconfigured') {
      failed.push({ machineId: selfMachineId ?? 'self', error: 'peer-pool-unconfigured' });
    }
    const remote: Record<string, unknown>[] = [];
    const remoteEmailGaps: Record<string, unknown>[] = [];
    const remoteReconciliation: Array<{
      state: 'running' | 'degraded' | 'complete';
      unresolvedCount: number;
    }> = [];
    await Promise.all(peers.map(async (p) => {
      try {
        const r = await fetchPeer(ctx.recordRopeResult ?? undefined, p, `/subscription-pool`, {
          headers: { Authorization: `Bearer ${ctx.config.authToken}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) {
          // Normalized reason — NEVER the peer URL or a raw body (no leak).
          failed.push({ machineId: p.machineId, error: r.status === 401 || r.status === 403 ? 'unauthorized' : 'error' });
          return;
        }
        const body = (await r.json()) as {
          accounts?: Record<string, unknown>[];
          emailGaps?: Record<string, unknown>[];
          emailReconciliation?: {
            state?: 'running' | 'degraded' | 'complete';
            unresolvedCount?: number;
          };
        };
        const nickname = ctx.machinePoolRegistry?.getCapacity(p.machineId)?.nickname ?? null;
        for (const a of body.accounts ?? []) {
          remote.push({
            ...a,
            // A peer on older code never reports a cause: unknown, never "clear".
            statusCause: 'statusCause' in a ? a.statusCause : 'unknown',
            // Attributed to the peer that was asked, named from this machine's registry: a peer
            // cannot file its rows under another machine (mobile-native-capacity-screens §3.1).
            machineId: p.machineId,
            machineNickname: nickname ?? undefined,
            remote: true,
          });
        }
        for (const gap of body.emailGaps ?? []) {
          remoteEmailGaps.push({
            ...gap,
            // Attributed to the peer that was asked, like its accounts (mobile-native-capacity-screens §3.1).
            machineId: p.machineId,
            machineNickname: nickname ?? undefined,
            remote: true,
          });
        }
        if (body.emailReconciliation?.state) {
          remoteReconciliation.push({
            state: body.emailReconciliation.state,
            unresolvedCount: Number(body.emailReconciliation.unresolvedCount ?? 0),
          });
        }
      } catch (err) {
        // @silent-fallback-ok — a peer being down/slow/unauth is the DESIGNED
        // tolerant path (spec: degrade to a named failed row, never a 500); the
        // failure is reported up-stack in pool.failed, not swallowed. Normalized
        // reason only (never raw err.message → no URL/TLS/token leak).
        const name = err instanceof Error ? err.name : '';
        failed.push({ machineId: p.machineId, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable' });
      }
    }));

    const localReconciliation = subscriptionEmailReconciliation();
    const reconciliationRows = [localReconciliation, ...remoteReconciliation];
    const aggregateState = reconciliationRows.some((row) => row.state === 'running')
      ? 'running'
      : reconciliationRows.some((row) => row.state === 'degraded') ? 'degraded' : 'complete';
    return {
      enabled: !!ctx.subscriptionPool,
      accounts: [...selfAccounts, ...remote],
      emailGaps: [
        ...subscriptionEmailGaps().map((gap) => ({
          ...gap,
          machineId: selfMachineId,
          machineNickname: selfMachineNickname ?? undefined,
          remote: false,
        })),
        ...remoteEmailGaps,
      ],
      emailReconciliation: {
        state: aggregateState,
        unresolvedCount: reconciliationRows.reduce((sum, row) => sum + row.unresolvedCount, 0),
        repairRunsFreshProbe: true,
      },
      pool: {
        selfMachineId,
        selfMachineNickname,
        peersQueried: peers.length,
        peersOk: peers.length - failed.length,
        failed,
      },
      // This machine's device-limit counters (machine-local; peers report their own).
      deviceLimit: deps.deviceLimitStatus(),
      scope: 'pool',
    };
  }

  const subscriptionPool: RequestHandler = async (req, res) => {
    // sibling-machine-reach §3.1: every plain response names the machine that answered, so a
    // reader can tell a stale URL that now reaches a different machine (identity check).
    const answeringMachine = ctx.meshSelfId ? { machineId: ctx.meshSelfId } : {};
    if (req.query.scope === 'pool') {
      const view = await subscriptionPoolScopeView();
      const siblingHoldings = deps.siblingHoldings();
      if (siblingHoldings) {
        // The agent's one lookup: per machine ages/failures for every reader; account and
        // browser identities ONLY for the agent's own bearer (never a dashboard session).
        const ownBearer = bearerMatches(req, ctx.config.authToken);
        const snap = siblingHoldings.snapshot();
        (view as Record<string, unknown>).siblingReach = {
          ...siblingHoldings.status(),
          machines: snap.machines.map((m) => ({
            machineId: m.machineId,
            ...(m.nickname ? { nickname: m.nickname } : {}),
            poolAgeMinutes: m.pool?.ageMinutes ?? null,
            browserAgeMinutes: m.browser?.ageMinutes ?? null,
            ...(m.poolUnknownReason ? { poolUnknownReason: m.poolUnknownReason } : {}),
            ...(m.browserUnknownReason ? { browserUnknownReason: m.browserUnknownReason } : {}),
            ...(ownBearer
              ? { poolAccounts: m.pool?.accounts ?? null, browserAccounts: m.browser?.accounts ?? null }
              : { poolAccountCount: m.pool?.accounts.length ?? null, browserProfileCount: m.browser?.accounts.length ?? null }),
          })),
          unknown: snap.unknown,
        };
      }
      res.json(view);
      return;
    }

    if (!ctx.subscriptionPool) {
      res.json({ enabled: false, accounts: [], ...answeringMachine });
      return;
    }
    if (!subscriptionPoolReadable()) {
      res.status(503).json({ ...subscriptionPoolFailureBody(), ...answeringMachine });
      return;
    }
    const accounts = ctx.subscriptionPool.list().map((a) => ({
      ...a,
      // The login signal behind the status (spec skill-driven-signin-repair): never silent.
      loginCheck: ctx.quotaPoller?.loginCheck?.(a.id) ?? 'unavailable',
      statusCause: a.statusCause ?? null,
    }));
    const emailGaps = subscriptionEmailGaps();
    res.json({
      enabled: true,
      ...answeringMachine,
      count: accounts.length,
      accounts,
      emailGaps,
      emailReconciliation: subscriptionEmailReconciliation(),
      // codex-device-limit-tripwire §8: this machine's judge/bench counters (null when not running).
      deviceLimit: deps.deviceLimitStatus(),
    });
  };

  const subscriptionRelogin: RequestHandler = async (req, res) => {
    if (!ctx.subscriptionRelogin && req.query.scope !== 'pool') {
      const config = localReloginConfig();
      res.status(503).json({ enabled: false, error: 'subscription re-login is not configured', ...(config ? { config } : {}) });
      return;
    }
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const localEpisodes = ctx.subscriptionRelogin?.store.list({
        state: state as import('../core/SubscriptionReloginStore.js').SubscriptionReloginState | undefined,
        accountId, limit,
      }) ?? [];
      // A blocker read that fails leaves `blockers` absent (unknown), never an empty "nothing blocked".
      const localBlockers = await ctx.subscriptionRelogin?.blockers?.().catch(() => undefined);
      const ownConfig = localReloginConfig();
      if (req.query.scope !== 'pool') {
        res.json({ enabled: true, episodes: localEpisodes,
          ...(localBlockers ? { blockers: localBlockers } : {}),
          ...(ownConfig ? { config: ownConfig } : {}),
          lastResort: ctx.subscriptionRelogin!.lastResortStatus?.() ?? { available: false } });
        return;
      }
      const configs: Array<Record<string, unknown>> = ownConfig ? [{ ...ownConfig, machineNickname: ctx.machinePoolRegistry?.getCapacity(ownConfig.machineId)?.nickname, remote: false }] : [];
      const configsMissing: string[] = [];
      const selfMachineId = ctx.meshSelfId ?? (ctx.config as { machineId?: string }).machineId ?? 'local';
      const selfMachineNickname = ctx.machinePoolRegistry?.getCapacity(selfMachineId)?.nickname;
      const failed: Array<{ machineId: string; error: string }> = [];
      const unavailable: Array<{ machineId: string; reason: string }> = [];
      const episodes = localEpisodes
        .filter((episode) => {
          if (episode.machineId === selfMachineId) return true;
          failed.push({ machineId: selfMachineId, error: 'episode-machine-mismatch' });
          return false;
        })
        .map((episode) => ({ ...episode, machineNickname: selfMachineNickname, remote: false }));
      const blockers: Array<Record<string, unknown>> = (localBlockers ?? [])
        .map((blocker) => ({ ...blocker, machineNickname: selfMachineNickname, remote: false }));
      // Machines whose blockers could not be read (failed read, or an older peer without the
      // field): unknown, never "nothing blocked".
      const blockersUnknown: string[] = ctx.subscriptionRelogin && !localBlockers ? [selfMachineId] : [];
      if (!ctx.subscriptionRelogin) unavailable.push({ machineId: selfMachineId, reason: 'feature-unavailable' });
      const query = new URLSearchParams();
      if (state) query.set('state', state);
      if (accountId) query.set('accountId', accountId);
      if (limit !== undefined) query.set('limit', String(limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      await Promise.all((ctx.resolvePeerUrls?.() ?? []).map(async (peer) => {
        try {
          const response = await fetchPeer(ctx.recordRopeResult ?? undefined, peer, `/subscription-relogin${suffix}`, {
            headers: { Authorization: `Bearer ${ctx.config.authToken}` },
            signal: AbortSignal.timeout(5_000),
          });
          const takeConfig = (body: { config?: unknown } | null) => {
            const c = body?.config;
            if (c && typeof c === 'object' && !Array.isArray(c)) {
              configs.push({ ...(c as Record<string, unknown>), machineId: peer.machineId,
                machineNickname: ctx.machinePoolRegistry?.getCapacity(peer.machineId)?.nickname, remote: true });
            } else configsMissing.push(peer.machineId);
          };
          if (!response.ok) {
            if (response.status === 503) {
              takeConfig(await response.json().catch(() => null) as { config?: unknown } | null);
              unavailable.push({ machineId: peer.machineId, reason: 'feature-unavailable' });
              return;
            }
            failed.push({ machineId: peer.machineId, error: response.status === 401 || response.status === 403 ? 'unauthorized' : 'error' });
            return;
          }
          const body = await response.json() as { enabled?: boolean; episodes?: Array<Record<string, unknown>>;
            blockers?: Array<Record<string, unknown>>; config?: unknown };
          takeConfig(body);
          if (body.enabled === false) {
            unavailable.push({ machineId: peer.machineId, reason: 'feature-unavailable' });
            return;
          }
          const nickname = ctx.machinePoolRegistry?.getCapacity(peer.machineId)?.nickname;
          for (const episode of body.episodes ?? []) {
            episodes.push({ ...episode, machineId: peer.machineId, machineNickname: nickname, remote: true } as typeof episodes[number]);
          }
          if (!Array.isArray(body.blockers)) blockersUnknown.push(peer.machineId);
          for (const blocker of Array.isArray(body.blockers) ? body.blockers : []) {
            if (typeof blocker?.accountId !== 'string' || typeof blocker?.reason !== 'string') continue;
            blockers.push({ accountId: blocker.accountId, framework: blocker.framework, reason: blocker.reason,
              machineId: peer.machineId, machineNickname: nickname, remote: true });
          }
        } catch (error) {
          const name = error instanceof Error ? error.name : '';
          failed.push({ machineId: peer.machineId, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable' });
        }
      }));
      res.json({ enabled: true, episodes, blockers, scope: 'pool', pool: { failed, unavailable, blockersUnknown, configs, configsMissing } });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? operatorError(error, res.app?.locals?.stateDir) : 'invalid re-login query' });
    }
  };

  const inUse: RequestHandler = async (_req, res) => {
    if (!ctx.subscriptionPool) {
      res.json({ enabled: false, activeAccountId: null, activeEmail: null });
      return;
    }
    try {
      const resolver =
        ctx.inUseAccountResolver ??
        new (await import('../core/InUseAccountResolver.js')).InUseAccountResolver({ now: deps.now });
      const result = await resolver.resolve(ctx.subscriptionPool.list());
      res.json({ enabled: true, ...result });
    } catch {
      // @silent-fallback-ok: resolver failure → "unknown" (never 500 the dashboard).
      res.json({ enabled: true, activeAccountId: null, activeEmail: null });
    }
  };

  const pool: RequestHandler = (_req, res) => {
    res.json(poolView());
  };

  return { poolView, subscriptionPoolScopeView, pool, subscriptionPool, subscriptionRelogin, inUse };
}
