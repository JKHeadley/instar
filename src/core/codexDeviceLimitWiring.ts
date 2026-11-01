/**
 * The production composition of the Codex device-limit tripwire (spec
 * codex-device-limit-tripwire), shared by server.ts and the wiring-integrity tests so the two can
 * never drift. It builds the judge (Jev, Luna referee on another account), the tripwire, and the
 * session mover, attaches the tripwire to the quota poller, and returns the hooks the session
 * monitor, the sign-in repair and the routes need.
 */
import path from 'node:path';
import type { IntelligenceProvider } from './types.js';
import type { SubscriptionAccount, SubscriptionPool } from './SubscriptionPool.js';
import { isDeviceLimitBenched, isLocallyExecutable } from './SubscriptionPool.js';
import type { SubscriptionLoginLedger } from './SubscriptionLoginLedger.js';
import type { QuotaPoller } from './QuotaPoller.js';
import { selectAccount } from './QuotaAwareScheduler.js';
import { CodexDeviceLimitJudge, appendDeviceLimitLog, type JevCodexDeviceLimitConfig } from './CodexDeviceLimitJudge.js';
import { CodexDeviceLimitTripwire, type DeviceLimitNotice, type DeviceLimitJudgeLike } from './CodexDeviceLimitTripwire.js';
import { DeviceLimitSessionMover, type DeviceLimitMoverSession } from './DeviceLimitSessionMover.js';

export const DEVICE_LIMIT_ATTENTION_CATEGORY = 'subscription-device-limit';
export const deviceLimitConditionKey = (machineId: string): string => `codex-device-limit:${machineId}`;

export interface CodexDeviceLimitWiringDeps {
  pool: SubscriptionPool;
  ledger: SubscriptionLoginLedger | null;
  quotaPoller: QuotaPoller;
  machineId: string;
  stateDir: string;
  logsDir: string;
  /** The tripwire switch, dev-gate resolved, read live; and this machine's ignore list. */
  config: () => { enabled: boolean; ignoreAccounts: string[] };
  judgeConfig: () => JevCodexDeviceLimitConfig | undefined;
  readKey: () => string | null;
  /** A dedicated Codex provider for the referee (never the shared default-home one). */
  referee: IntelligenceProvider | null;
  listSessions: () => DeviceLimitMoverSession[];
  swap: (args: { sessionName: string; exhaustedAccountId: string; nowMs: number }) =>
    Promise<{ swapped: boolean; toAccountId?: string | null; reason?: string }>;
  swapEnabled?: () => boolean;
  /** Late-bound: the sign-in repair runtime is built after the poller. */
  endRepairs: (accountId: string) => Promise<unknown> | void;
  raiseNotice: (notice: DeviceLimitNotice & { conditionKey: string; category: string }) => void;
  clearNotice: (conditionKey: string, resolution: string) => void;
  metrics?: { record(r: Record<string, unknown>): void } | null;
  /**
   * The shared judgment-provenance log (late-bound: built after the poller). Each judgement adds
   * one redacted row whose context is only `{ source, snippetHash }` (spec §1 Provenance).
   */
  provenance?: () => { recordDecision(input: Record<string, unknown>): string | null } | null;
  reportDegradation?: (e: { feature: string; primary: string; fallback: string; reason: string; impact: string }) => void;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  now?: () => number;
}

export interface CodexDeviceLimitWiring {
  judge: CodexDeviceLimitJudge;
  tripwire: CodexDeviceLimitTripwire;
  mover: DeviceLimitSessionMover;
  /** SessionManager sink: a Codex session's screen looks like a sign-in problem. */
  onSessionSigninSighting: (input: { accountId: string; session: string }) => Promise<boolean>;
  /** Sign-in repair: is this account suspected or benched (switch-aware)? */
  deviceLimitHold: (accountId: string) => boolean;
  /** Sign-in repair: judge an `unknown` OpenAI page (true only on a fresh device_limit). */
  judgeDeviceLimitPage: (accountId: string, text: string) => Promise<boolean>;
  /** Sign-in repair: a repair stopped at a (suspected) device-limit page. */
  onDeviceLimitStopped: (accountId: string) => void;
  /** Attention resolver for this machine's row. */
  resolveNotice: (item: { category?: string; conditionKey?: string }) => 'cleared' | 'active' | 'unknown';
  /** GET /subscription-pool `deviceLimit` block. */
  status: () => Record<string, unknown>;
}

export function buildCodexDeviceLimitWiring(deps: CodexDeviceLimitWiringDeps): CodexDeviceLimitWiring {
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? { log: () => {}, warn: () => {} };
  const logPath = path.join(deps.logsDir, 'codex-device-limit.jsonl');
  const codexAccounts = (): SubscriptionAccount[] =>
    deps.pool.list().filter((a) => a.framework === 'codex-cli' && a.provider === 'openai');
  const conditionKey = deviceLimitConditionKey(deps.machineId);

  const judge = new CodexDeviceLimitJudge({
    getConfig: deps.judgeConfig,
    readKey: deps.readKey,
    referee: deps.referee,
    // The referee runs on ANOTHER signed-in Codex account, never the judged one and never one
    // that is suspected or benched; with none, the referee is unavailable (never the default home).
    pickRefereeAccount: (judgedAccountId) => {
      const candidates = codexAccounts().filter((a) => !a.deviceLimitSuspectedAt && !isDeviceLimitBenched(a));
      const pick = selectAccount(candidates, { framework: 'codex-cli', nowMs: now() }, judgedAccountId);
      return pick ? { accountId: pick.id, configHome: pick.configHome } : null;
    },
    codexAccountCount: () => codexAccounts().length,
    stateDir: deps.stateDir,
    logPath,
    metrics: deps.metrics ?? null,
    reportDegradation: deps.reportDegradation,
    machineId: deps.machineId,
    now,
  });

  /** The judge as the tripwire and the repair see it: every verdict also leaves a provenance row. */
  const judged: DeviceLimitJudgeLike = {
    enqueue: (job, onVerdict) => {
      judge.enqueue(job as never, (r) => {
        try {
          deps.provenance?.()?.recordDecision({
            component: 'CodexDeviceLimitJudge',
            decisionPoint: 'codex-device-limit-judge',
            context: { source: job.source, snippetHash: (r as { snippetHash?: string }).snippetHash ?? null },
            optionsPresented: ['device_limit', 'not_device_limit', 'undecided'],
            decision: r.verdict,
            reason: `decidedBy=${r.decidedBy} deciders=${r.deciders}${r.cached ? ' cached' : ''}`,
            floor: 'bench needs two fresh device_limit verdicts on separate read refusals 5-60 min apart plus the machine floor; undecided ⇒ no action',
            fallbackRung: r.decidedBy === 'none' ? 'deterministic' : r.decidedBy,
          });
        } catch { /* @silent-fallback-ok — provenance is observability, never part of the decision */ }
        onVerdict(r);
      });
    },
  };

  let tripwireRef: CodexDeviceLimitTripwire | null = null;
  const mover = new DeviceLimitSessionMover({
    listSessions: deps.listSessions,
    isBenched: (accountId) => {
      const a = deps.pool.get(accountId);
      return !!a && isDeviceLimitBenched(a);
    },
    swap: deps.swap,
    enabled: () => (deps.swapEnabled ? deps.swapEnabled() : true) && deps.config().enabled,
    now,
    logger,
  });

  const observe = (accountId: string, outcome: Parameters<SubscriptionLoginLedger['recordObservation']>[0]['outcome']) => {
    if (!deps.ledger) throw new Error('subscription-login-ledger-unavailable');
    deps.ledger.recordObservation({ accountId, at: new Date(now()).toISOString(), outcome });
  };

  const tripwire = new CodexDeviceLimitTripwire({
    pool: deps.pool,
    judge: judged,
    machineId: deps.machineId,
    config: deps.config,
    requestRead: (accountId, opts) => {
      void deps.quotaPoller.requestCodexCheck(accountId, opts).catch((err) => {
        // @silent-fallback-ok — logged; a failed read request is re-asked by the next trigger or poll
        logger.warn(`[DeviceLimit] read request for ${accountId} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    ledger: {
      // Best-effort bookkeeping: the pool record is the authority. A missing or read-only ledger
      // is reported, never fatal.
      benched: (accountId, wasNeedsReauth) => {
        try {
          if (wasNeedsReauth && deps.ledger) deps.ledger.supersedeCause(accountId, 'codex-device-limit');
          else observe(accountId, { kind: 'transition-to-needs-reauth', causeClass: 'codex-device-limit', corroboration: 'exchange-corroborated' });
        } catch (err) {
          deps.reportDegradation?.({
            feature: 'CodexDeviceLimitTripwire.ledger',
            primary: 'a device-limit bench is recorded in the sign-in ledger',
            fallback: 'the bench stands on the pool record (the authority); repair admission still refuses it',
            reason: err instanceof Error ? err.message : String(err),
            impact: 'Sign-in history may not show this bench.',
          });
        }
      },
      released: (accountId) => {
        try { observe(accountId, { kind: 'transition-to-active' }); }
        catch { /* @silent-fallback-ok — the pool record is already active; ledger history is best-effort */ }
      },
    },
    settleRepairs: async (accountId) => {
      const results = await deps.endRepairs(accountId);
      const failed = Array.isArray(results) ? (results as Array<{ ended?: boolean; reason?: string }>).filter((r) => r && r.ended === false) : [];
      if (failed.length > 0) {
        deps.reportDegradation?.({
          feature: 'CodexDeviceLimitTripwire.settleRepairs',
          primary: 'every live sign-in repair for a benched account ends at once',
          fallback: 'the bench stands on the pool record and repair admission refuses the account; the repair ends at its next admission check',
          reason: `${failed.length} repair(s) for ${accountId} could not be ended now (${failed.map((r) => r.reason ?? 'unknown').join(', ')})`,
          impact: 'A repair already in flight may make one more sign-in attempt.',
        });
      }
    },
    moveSessions: (accountId) => mover.moveOff(accountId),
    notice: (notice) => {
      if (notice === null) { deps.clearNotice(conditionKey, 'no Codex account here is benched or refusing any more'); return; }
      deps.raiseNotice({ ...notice, conditionKey, category: DEVICE_LIMIT_ATTENTION_CATEGORY });
    },
    log: (row) => {
      try { appendDeviceLimitLog(logPath, { at: new Date(now()).toISOString(), machineId: deps.machineId, ...row } as never); }
      catch { /* @silent-fallback-ok — the audit log is best-effort and never blocks a decision */ }
    },
    now,
    logger,
  });
  tripwireRef = tripwire;
  deps.quotaPoller.setDeviceLimitTripwire(tripwire);

  return {
    judge,
    tripwire,
    mover,
    onSessionSigninSighting: async ({ accountId }) => {
      if (!deps.config().enabled) return false;
      return deps.quotaPoller.requestCodexCheck(accountId, { confirmation: false });
    },
    deviceLimitHold: (accountId) => {
      if (!deps.config().enabled) return false;
      const a = deps.pool.get(accountId);
      return !!a && (isDeviceLimitBenched(a) || !!a.deviceLimitSuspectedAt);
    },
    judgeDeviceLimitPage: (accountId, text) => new Promise<boolean>((resolve) => {
      if (!deps.config().enabled) { resolve(false); return; }
      const a = deps.pool.get(accountId);
      judged.enqueue({ accountId, source: 'sign-in-page', text, email: a?.email, nickname: a?.nickname, stateChanging: true },
        (r) => resolve(r.verdict === 'device_limit' && !r.cached));
    }),
    onDeviceLimitStopped: (accountId) => tripwireRef?.onRepairStopped(accountId),
    resolveNotice: (item) => {
      if (item.category !== DEVICE_LIMIT_ATTENTION_CATEGORY || item.conditionKey !== conditionKey) return 'unknown';
      return tripwire.noticeCondition();
    },
    status: () => ({
      ...tripwire.status(),
      judge: judge.getCounters(),
      mover: { ...mover.counters },
      executableCodexAccounts: codexAccounts().filter(isLocallyExecutable).length,
    }),
  };
}

let installed: CodexDeviceLimitWiring | null = null;
export function installCodexDeviceLimitWiring(w: CodexDeviceLimitWiring | null): void { installed = w; }
export function getCodexDeviceLimitWiring(): CodexDeviceLimitWiring | null { return installed; }
