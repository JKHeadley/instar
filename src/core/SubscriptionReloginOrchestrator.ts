import type {
  SubscriptionReloginEpisode,
  SubscriptionReloginFailureClass,
  SubscriptionReloginStore,
} from './SubscriptionReloginStore.js';

export interface ReloginArtifact {
  attemptId: string;
  kind: 'device-code' | 'url-code-paste';
  expiresAt: string;
  reissueCount: number;
}
export type BrowserRepairResult =
  | { outcome: 'approved'; pasteCode?: string }
  | { outcome: 'operator-only'; failureClass: 'captcha' | 'phone-confirmation' | 'permission-expansion' }
  | { outcome: 'transient'; failureClass: 'seat-busy' | 'target-unreachable' | 'artifact-expired' | 'provider-transient' }
  | { outcome: 'refused'; failureClass: 'wrong-identity' | 'unexpected-origin' | 'vault-reference-missing' | 'provider-rejected' };

export interface SubscriptionReloginOrchestratorDeps {
  store: SubscriptionReloginStore;
  authorityReady: () => boolean;
  sourceIncidentOpen: (episode: SubscriptionReloginEpisode) => boolean;
  /** Re-observes external truth after restart at a non-idempotent boundary. Never mutates. */
  recoverUncertain: (episode: SubscriptionReloginEpisode, signal: AbortSignal) => Promise<
    'credential-ready' | 'cli-awaiting' | 'inconclusive'
  >;
  /** Must be idempotent for episode.id and re-observe an existing pending attempt. */
  startOrRecoverLogin: (episode: SubscriptionReloginEpisode, signal: AbortSignal) => Promise<ReloginArtifact>;
  driveBrowser: (episode: SubscriptionReloginEpisode, artifact: ReloginArtifact, signal: AbortSignal) => Promise<BrowserRepairResult>;
  /** Readiness-checks the pane and never blind-types. The code is memory-only. */
  finishCli: (episode: SubscriptionReloginEpisode, pasteCode: string | undefined, signal: AbortSignal) => Promise<'complete' | 'pending'>;
  verifyIdentity: (episode: SubscriptionReloginEpisode, signal: AbortSignal) => Promise<'match' | 'mismatch' | 'unavailable'>;
  verifyAuthenticatedUse: (episode: SubscriptionReloginEpisode, signal: AbortSignal) => Promise<boolean>;
  /** Applies the verified recovery to the existing pool/ledger authorities. Must be idempotent. */
  finalizeSuccess: (episode: SubscriptionReloginEpisode, signal: AbortSignal) => Promise<void>;
  accountActive: (episode: SubscriptionReloginEpisode) => boolean;
  now?: () => number;
  maxAttempts?: number;
  retryBaseMs?: number;
  maxWallClockMs?: number;
  maxReissues?: number;
}

export type SubscriptionReloginTickResult =
  | { outcome: 'advanced'; episode: SubscriptionReloginEpisode }
  | { outcome: 'waiting'; episode: SubscriptionReloginEpisode; reason: string }
  | { outcome: 'terminal'; episode: SubscriptionReloginEpisode };

/** Deterministic controller. Browser prose and secrets stay behind injected, typed ports. */
export class SubscriptionReloginOrchestrator {
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly maxWallClockMs: number;
  private readonly maxReissues: number;

  constructor(private readonly deps: SubscriptionReloginOrchestratorDeps) {
    this.now = deps.now ?? Date.now;
    this.maxAttempts = Math.max(1, Math.min(5, Math.floor(deps.maxAttempts ?? 3)));
    this.retryBaseMs = Math.max(1_000, Math.min(60_000, Math.floor(deps.retryBaseMs ?? 5_000)));
    this.maxWallClockMs = Math.max(60_000, Math.min(30 * 60_000, Math.floor(deps.maxWallClockMs ?? 10 * 60_000)));
    this.maxReissues = Math.max(0, Math.min(10, Math.floor(deps.maxReissues ?? 2)));
  }

  async tick(id: string, signal: AbortSignal = new AbortController().signal): Promise<SubscriptionReloginTickResult> {
    let ep = this.mustGet(id);
    if (signal.aborted) return this.cancelledResult(ep);
    if (isTerminal(ep)) return { outcome: 'terminal', episode: ep };
    if (ep.state === 'suggested' || ep.state === 'waiting-operator-only')
      return { outcome: 'waiting', episode: ep, reason: ep.state };
    if (ep.startedAt && this.now() - Date.parse(ep.startedAt) >= this.maxWallClockMs)
      return this.fail(ep, 'repair-time-budget-exhausted', 'repair-time-budget-exhausted');
    if (!this.deps.authorityReady()) return this.fail(ep, 'authority-degraded', 'authority-degraded');
    if (!this.deps.sourceIncidentOpen(ep)) {
      ep = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to: 'cancelled',
        eventClass: 'source-incident-closed', failureClass: 'cancelled-by-operator', at: this.isoNow() });
      return { outcome: 'terminal', episode: ep };
    }
    if (ep.state === 'approved') {
      if (!ep.startedAt && (!ep.approvalExpiresAt || Date.parse(ep.approvalExpiresAt) <= this.now()))
        return this.fail(ep, 'provider-rejected', 'approval-expired');
      if (ep.nextAttemptAt && Date.parse(ep.nextAttemptAt) > this.now())
        return { outcome: 'waiting', episode: ep, reason: 'retry-backoff' };
      ep = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to: 'cli-starting',
        eventClass: 'cli-starting', incrementAttempt: true, at: this.isoNow() });
    }
    if (ep.state === 'cli-starting') {
      try {
        const artifact = await this.deps.startOrRecoverLogin(ep, signal);
        if (signal.aborted) return this.cancelledResult(ep);
        ep = this.recordArtifactReissues(ep, artifact);
        if (ep.reissueCount > this.maxReissues)
          return this.fail(ep, 'attempt-budget-exhausted', 'artifact-reissue-budget-exhausted');
        if (Date.parse(artifact.expiresAt) <= this.now()) return this.retry(ep, 'artifact-expired');
        ep = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to: 'artifact-ready',
          eventClass: 'artifact-ready', at: this.isoNow() });
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return this.cancelledResult(ep);
        return this.retry(ep, 'target-unreachable');
      }
    }
    if (ep.state === 'browser-driving') {
      const observed = await this.deps.recoverUncertain(ep, signal).catch((error) => {
        if (signal.aborted || isAbortError(error)) return 'aborted' as const;
        return 'inconclusive' as const;
      });
      if (observed === 'aborted') return this.cancelledResult(ep);
      if (observed === 'credential-ready') {
        ep = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to: 'identity-verifying',
          eventClass: 'restart-credential-observed', at: this.isoNow() });
      } else {
        ep = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to: 'waiting-operator-only',
          eventClass: 'uncertain-external-outcome', failureClass: 'uncertain-external-outcome', at: this.isoNow() });
        return { outcome: 'waiting', episode: ep, reason: 'uncertain-external-outcome' };
      }
    }
    if (ep.state === 'artifact-ready') {
      let artifact: ReloginArtifact;
      try { artifact = await this.deps.startOrRecoverLogin(ep, signal); }
      catch (error) { if (signal.aborted || isAbortError(error)) return this.cancelledResult(ep); return this.retry(ep, 'target-unreachable'); }
      if (signal.aborted) return this.cancelledResult(ep);
      ep = this.recordArtifactReissues(ep, artifact);
      if (ep.reissueCount > this.maxReissues)
        return this.fail(ep, 'attempt-budget-exhausted', 'artifact-reissue-budget-exhausted');
      ep = this.deps.store.transition(ep.id, {
        expectedVersion: ep.version, to: 'browser-driving', eventClass: 'browser-drive-started', at: this.isoNow(),
      });
      let result: BrowserRepairResult;
      try { result = await this.deps.driveBrowser(ep, artifact, signal); }
      catch (error) { if (signal.aborted || isAbortError(error)) return this.cancelledResult(ep); return this.retry(ep, 'provider-transient'); }
      if (signal.aborted) return this.cancelledResult(ep);
      if (result.outcome === 'operator-only') {
        ep = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to: 'waiting-operator-only',
          eventClass: 'operator-only-challenge', failureClass: result.failureClass, at: this.isoNow() });
        return { outcome: 'waiting', episode: ep, reason: result.failureClass };
      }
      if (result.outcome === 'transient') return this.retry(ep, result.failureClass);
      if (result.outcome === 'refused') {
        const to = result.failureClass === 'wrong-identity' || result.failureClass === 'unexpected-origin' ? 'refused' : 'failed';
        ep = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to,
          eventClass: 'browser-drive-refused', failureClass: result.failureClass, at: this.isoNow() });
        return { outcome: 'terminal', episode: ep };
      }
      ep = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to: 'cli-finishing',
        eventClass: 'browser-approved', at: this.isoNow() });
      try {
        const cli = await this.deps.finishCli(ep, result.pasteCode, signal);
        if (signal.aborted) return this.cancelledResult(ep);
        if (cli === 'pending') return { outcome: 'waiting', episode: ep, reason: 'cli-finishing' };
        ep = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to: 'identity-verifying',
          eventClass: 'cli-finished', at: this.isoNow() });
      } finally {
        if (result.pasteCode) result.pasteCode = '';
      }
    }
    if (ep.state === 'cli-finishing') {
      const observed = await this.deps.recoverUncertain(ep, signal).catch((error) => {
        if (signal.aborted || isAbortError(error)) return 'aborted' as const;
        return 'inconclusive' as const;
      });
      if (observed === 'aborted') return this.cancelledResult(ep);
      if (observed === 'credential-ready') {
        ep = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to: 'identity-verifying',
          eventClass: 'restart-credential-observed', at: this.isoNow() });
      } else if (observed === 'inconclusive') {
        ep = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to: 'waiting-operator-only',
          eventClass: 'uncertain-external-outcome', failureClass: 'uncertain-external-outcome', at: this.isoNow() });
        return { outcome: 'waiting', episode: ep, reason: 'uncertain-external-outcome' };
      }
    }
    if (ep.state === 'cli-finishing') {
      try {
        if (await this.deps.finishCli(ep, undefined, signal) === 'pending')
          return { outcome: 'waiting', episode: ep, reason: 'cli-finishing' };
        if (signal.aborted) return this.cancelledResult(ep);
      } catch (error) { // @silent-fallback-ok — abort or typed retry is durably returned to the episode controller.
        if (signal.aborted || isAbortError(error)) return this.cancelledResult(ep); return this.retry(ep, 'target-unreachable'); }
      ep = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to: 'identity-verifying',
        eventClass: 'cli-finished', at: this.isoNow() });
    }
    if (ep.state === 'identity-verifying') {
      const identity = await this.deps.verifyIdentity(ep, signal).catch((error) => {
        // @silent-fallback-ok — unavailable is a closed retry verdict recorded by retry().
        if (signal.aborted || isAbortError(error)) return 'aborted' as const;
        return 'unavailable' as const;
      });
      if (identity === 'aborted') return this.cancelledResult(ep);
      if (identity === 'mismatch') return this.fail(ep, 'wrong-identity', 'identity-mismatch', 'refused');
      if (identity === 'unavailable') return this.retry(ep, 'verification-failed');
      ep = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to: 'auth-verifying',
        eventClass: 'identity-verified', at: this.isoNow() });
    }
    if (ep.state === 'auth-verifying') {
      const authenticated = await this.deps.verifyAuthenticatedUse(ep, signal).catch((error) => {
        // @silent-fallback-ok — false is a closed verification-failed verdict recorded by retry().
        if (signal.aborted || isAbortError(error)) return 'aborted' as const;
        return false;
      });
      if (authenticated === 'aborted') return this.cancelledResult(ep);
      if (!authenticated) return this.retry(ep, 'verification-failed');
      try { await this.deps.finalizeSuccess(ep, signal); }
      catch (error) {
        // @silent-fallback-ok — authority-closure-pending is explicit and re-observed; success is withheld.
        if (signal.aborted || isAbortError(error)) return this.cancelledResult(ep);
        return { outcome: 'waiting', episode: ep, reason: 'authority-closure-pending' };
      }
      if (signal.aborted) return this.cancelledResult(ep);
      if (!this.deps.accountActive(ep) || this.deps.sourceIncidentOpen(ep))
        return { outcome: 'waiting', episode: ep, reason: 'authority-closure-pending' };
      ep = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to: 'succeeded',
        eventClass: 'authenticated-use-verified', clearFailure: true, at: this.isoNow() });
      return { outcome: 'terminal', episode: ep };
    }
    return { outcome: 'advanced', episode: ep };
  }

  private retry(ep: SubscriptionReloginEpisode, failure: SubscriptionReloginFailureClass): SubscriptionReloginTickResult {
    if (ep.attemptCount >= this.maxAttempts)
      return this.fail(ep, 'attempt-budget-exhausted', 'attempt-budget-exhausted');
    const delay = this.retryBaseMs * 2 ** Math.max(0, ep.attemptCount - 1);
    const next = new Date(this.now() + delay).toISOString();
    const updated = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to: 'approved',
      eventClass: 'transient-retry-scheduled', failureClass: failure, nextAttemptAt: next, at: this.isoNow() });
    return { outcome: 'waiting', episode: updated, reason: failure };
  }

  private fail(ep: SubscriptionReloginEpisode, failure: SubscriptionReloginFailureClass,
    eventClass: string, to: 'failed' | 'refused' = 'failed'): SubscriptionReloginTickResult {
    const updated = this.deps.store.transition(ep.id, { expectedVersion: ep.version, to,
      eventClass, failureClass: failure, at: this.isoNow() });
    return { outcome: 'terminal', episode: updated };
  }
  private mustGet(id: string): SubscriptionReloginEpisode {
    const ep = this.deps.store.get(id); if (!ep) throw new Error('relogin-episode-not-found'); return ep;
  }
  private cancelledResult(ep: SubscriptionReloginEpisode): SubscriptionReloginTickResult {
    const latest = this.mustGet(ep.id);
    if (latest.state === 'cancelled') return { outcome: 'terminal', episode: latest };
    return { outcome: 'waiting', episode: latest, reason: 'cancel-requested' };
  }
  private recordArtifactReissues(ep: SubscriptionReloginEpisode, artifact: ReloginArtifact): SubscriptionReloginEpisode {
    if (!Number.isSafeInteger(artifact.reissueCount) || artifact.reissueCount < 0)
      throw new Error('invalid-artifact-reissue-count');
    return artifact.reissueCount > ep.reissueCount
      ? this.deps.store.recordReissue(ep.id, ep.version, artifact.reissueCount, this.isoNow())
      : ep;
  }
  private isoNow(): string { return new Date(this.now()).toISOString(); }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isTerminal(ep: SubscriptionReloginEpisode): boolean {
  return ['succeeded', 'refused', 'cancelled', 'failed'].includes(ep.state);
}
