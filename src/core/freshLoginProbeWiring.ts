/**
 * freshLoginProbeWiring — builds the FreshProbeScheduler the server attaches to the QuotaPoller
 * (spec docs/specs/stale-process-login-expired.md, D1–D1b, D6). Kept out of server.ts so the wiring
 * is testable on its own.
 *
 * Every probe: runs on the account's ROUTED folder; only when the stored access token has at least
 * FRESH_PROBE_EXPIRY_MARGIN_MS left (else `not-run`, so the probe never triggers a refresh); goes
 * through the host spawn cap with the reservation written inside the admitted callback; and records
 * one feature-metrics row. Persisted state lives in <stateDir>/state/fresh-login-probe.json (atomic).
 */

import fs from 'node:fs';
import path from 'node:path';
import { FreshProbeScheduler, type PersistedState } from './FreshProbeScheduler.js';
import { runFreshLoginProbe, type FreshProbeResult } from './freshLoginProbe.js';
import { readClaudeOauthAsync } from './OAuthRefresher.js';
import { wrapIntelligenceWithSpawnCap, isCapacityUnavailable } from './SpawnCapIntelligenceProvider.js';
import { getFeatureMetricsRecorder } from './CircuitBreakingIntelligenceProvider.js';
import { CLAUDE_CODE_FRAMEWORK } from './frameworkFacts.js';

export const FRESH_PROBE_EXPIRY_MARGIN_MS = 15 * 60_000;
export const FRESH_PROBE_FEATURE = 'QuotaPoller.freshLoginProbe';

export interface FreshProbeWiringDeps {
  stateDir: string;
  /** Live switch (subscriptionPool.freshLoginProbe.enabled), read on every decision. */
  enabled: () => boolean;
  claudePath: () => string | null;
  routedConfigHome: (accountId: string) => string | null;
  fingerprint: (accountId: string) => string | null;
  applyVerdict: (accountId: string, verdict: 'ok' | 'refused') => void;
  onBreaker: (accountId: string) => void;
  now?: () => number;
  /** Injected for tests. */
  readExpiresAt?: (configHome: string) => Promise<number | null>;
  run?: (configHome: string, cwd: string) => Promise<FreshProbeResult>;
  log?: (m: string) => void;
}

function statePath(stateDir: string): string { return path.join(stateDir, 'state', 'fresh-login-probe.json'); }

export function loadFreshProbeState(stateDir: string): PersistedState {
  try { return JSON.parse(fs.readFileSync(statePath(stateDir), 'utf8')) as PersistedState; }
  catch { return {}; } // @silent-fallback-ok: no file yet (or unreadable) starts empty
}

export async function persistFreshProbeState(stateDir: string, state: PersistedState): Promise<void> {
  const file = statePath(stateDir);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(state), 'utf8');
  await fs.promises.rename(tmp, file);
}

export function buildFreshProbeScheduler(deps: FreshProbeWiringDeps): FreshProbeScheduler {
  const now = deps.now ?? (() => Date.now());
  const cwd = path.join(deps.stateDir, 'state', 'fresh-login-probe');
  const readExpiresAt = deps.readExpiresAt ?? (async (home: string) => {
    const oauth = await readClaudeOauthAsync(home);
    return typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null;
  });
  const run = deps.run ?? ((home: string, dir: string) => runFreshLoginProbe({ claudePath: deps.claudePath, cwd: dir }, home));
  return new FreshProbeScheduler({
    now,
    enabled: deps.enabled,
    fingerprint: deps.fingerprint,
    load: () => loadFreshProbeState(deps.stateDir),
    persist: (s) => persistFreshProbeState(deps.stateDir, s),
    probe: async (accountId, reserve) => {
      const home = deps.routedConfigHome(accountId);
      if (!home) return { verdict: 'unavailable', reason: 'no-routed-folder' };
      // D1a: never probe inside the refresh window (a refresh would rotate the shared token).
      let expiresAt: number | null = null;
      try { expiresAt = await readExpiresAt(home); } catch { expiresAt = null; } // @silent-fallback-ok: unknown expiry is not run
      if (expiresAt === null || expiresAt - now() < FRESH_PROBE_EXPIRY_MARGIN_MS) return { verdict: 'not-run', reason: 'token-near-expiry' };
      try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* @silent-fallback-ok: the spawn reports a bad cwd as unavailable */ }
      let result: FreshProbeResult = { verdict: 'not-run', reason: 'spawn-cap-shed' };
      const capped = wrapIntelligenceWithSpawnCap({
        evaluate: async () => {
          // Reserve INSIDE the admitted callback; spawn only once the reservation committed.
          if (!(await reserve())) { result = { verdict: 'not-run', reason: 'reserve-refused' }; return 'reserve-refused'; }
          result = await run(home, cwd);
          return result.verdict;
        },
      } as never);
      try { await capped?.evaluate('fresh-login-probe', {} as never); }
      catch (err) {
        if (isCapacityUnavailable(err)) return { verdict: 'not-run', reason: 'spawn-cap-shed' };
        return { verdict: 'unavailable', reason: 'spawn-cap-error' };
      }
      return result;
    },
    onRan: (_accountId, r) => {
      if (r.reason === 'token-near-expiry' || r.reason === 'no-routed-folder') return; // never spawned
      const outcome = r.reason === 'spawn-cap-shed' || r.reason === 'reserve-refused' ? 'shed'
        : r.verdict === 'ok' ? 'fired' : r.verdict === 'not-run' ? 'noop' : 'error';
      try {
        getFeatureMetricsRecorder()?.record({
          feature: FRESH_PROBE_FEATURE, kind: 'llm', outcome,
          ...(outcome === 'shed' ? {} : {
            tokensIn: r.usage?.tokensIn, tokensOut: r.usage?.tokensOut, tokensCached: r.usage?.tokensCached,
            latencyMs: r.usage?.latencyMs, model: r.usage?.model, framework: CLAUDE_CODE_FRAMEWORK, door: `${CLAUDE_CODE_FRAMEWORK}-cli`,
          }),
        } as never);
      } catch { /* @silent-fallback-ok: metrics must never break the probe */ }
      deps.log?.(`[FreshProbe] verdict=${r.verdict} reason=${r.reason}`);
    },
    onVerdict: deps.applyVerdict,
    onBreaker: deps.onBreaker,
    log: deps.log,
  });
}
