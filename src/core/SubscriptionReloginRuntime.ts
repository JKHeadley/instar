import { createHash } from 'node:crypto';
import type { SubscriptionPool, SubscriptionAccount } from './SubscriptionPool.js';
import type { SubscriptionLoginLedger, SubscriptionLoginEpisode } from './SubscriptionLoginLedger.js';
import type { EnrollmentWizard } from './EnrollmentWizard.js';
import type { QuotaPoller } from './QuotaPoller.js';
import type { IdentityOracle } from './CredentialLocationLedger.js';
import type { PlaywrightProfileRegistry, PlaywrightAccount, PlaywrightProfileDetail } from './PlaywrightProfileRegistry.js';
import type { PendingLogin } from './PendingLoginStore.js';
import { evaluateSubscriptionReloginAdmission } from './SubscriptionReloginPolicy.js';
import { SubscriptionReloginStore, type SubscriptionReloginEpisode } from './SubscriptionReloginStore.js';
import { SubscriptionReloginOrchestrator } from './SubscriptionReloginOrchestrator.js';
import { SubscriptionReloginService } from './SubscriptionReloginService.js';
import { AnthropicReloginBrowserDriver, type ReloginBrowserAction,
  type ReloginBrowserPort, type ReloginBrowserSnapshot } from './AnthropicReloginBrowserDriver.js';
import { PlaywrightSeatLease } from './PlaywrightSeatLease.js';
import type { ClaudePasteBackController } from './ClaudePasteBackController.js';

export interface SubscriptionReloginRuntimeDeps {
  stateDir: string; projectDir: string; machineId: string;
  mode: 'observe' | 'approval' | 'unattended';
  pool: SubscriptionPool; ledger: SubscriptionLoginLedger; enrollment: EnrollmentWizard;
  profiles: PlaywrightProfileRegistry; quotaPoller: QuotaPoller; identityOracle: IdentityOracle;
  pasteBack: ClaudePasteBackController;
  createBrowser: (userDataDir: string) => ReloginBrowserPort;
  resolveSecret: (name: string) => Promise<string | null>;
  supervise: (input: { snapshot: ReloginBrowserSnapshot; allowedActions: ReloginBrowserAction[] }) => Promise<ReloginBrowserAction>;
  onSuggested?: (episode: SubscriptionReloginEpisode, deliveryKey: string) => Promise<void> | void;
  onTerminal?: (episode: SubscriptionReloginEpisode, deliveryKey: string) => Promise<void> | void;
  onOperatorOnly?: (episode: SubscriptionReloginEpisode, deliveryKey: string) => Promise<void> | void;
  allowedScopes?: string[]; tickMs?: number; maxAttempts?: number; retryBaseMs?: number;
  now?: () => number;
}

export interface SubscriptionReloginRuntime {
  store: SubscriptionReloginStore; service: SubscriptionReloginService;
  start(): void; stop(): void; close(): void;
}

/** Production-shaped composition. All authority lookups are repeated at action boundaries. */
export function createSubscriptionReloginRuntime(deps: SubscriptionReloginRuntimeDeps): SubscriptionReloginRuntime {
  const now = deps.now ?? Date.now;
  const store = new SubscriptionReloginStore({ stateDir: deps.stateDir, now });
  const seatLease = new PlaywrightSeatLease({ now });
  const authenticated = new Set<string>();

  const source = (episode: SubscriptionReloginEpisode): SubscriptionLoginEpisode | null =>
    deps.ledger.listEpisodes({ accountId: episode.accountId, limit: 100 })
      .find((item) => item.id === episode.sourceEpisodeId && item.machineId === episode.machineId) ?? null;
  const account = (episode: SubscriptionReloginEpisode): SubscriptionAccount | null => deps.pool.get(episode.accountId);
  const profileContext = (acct: SubscriptionAccount) => {
    // Claude subscriptions may authenticate directly with Anthropic credentials
    // or through Google. Resolve both closed provider paths and require exactly
    // one account/profile mapping; never guess between them.
    const profiles = deps.profiles.listProfiles();
    const candidates: Array<{ detail: PlaywrightProfileDetail;
      browserAccount: PlaywrightAccount & { danglingRefs: string[] } }> = [];
    let registryAmbiguous = false;
    for (const service of ['anthropic', 'google']) {
      const resolution = deps.profiles.resolve(service, acct.email);
      if (resolution.ambiguous) registryAmbiguous = true;
      if (!resolution.profile) continue;
      const detail = profiles.find((item) => item.id === resolution.profile!.id);
      const browserAccount = detail?.accounts.find((item) => item.service === service
        && normalize(item.identity) === normalize(acct.email));
      if (detail && browserAccount) candidates.push({ detail, browserAccount });
    }
    const unique = candidates.filter((candidate, index) => candidates.findIndex((other) =>
      other.detail.id === candidate.detail.id && other.browserAccount.service === candidate.browserAccount.service
      && normalize(other.browserAccount.identity) === normalize(candidate.browserAccount.identity)) === index);
    if (registryAmbiguous || unique.length !== 1) {
      return { resolved: { profile: null, ambiguous: registryAmbiguous || unique.length > 1 },
        detail: null, browserAccount: null };
    }
    return { resolved: { profile: unique[0].detail, ambiguous: false }, ...unique[0] };
  };
  const pending = (id: string): PendingLogin | null => deps.enrollment.getById(id);
  const credentialReady = async (login: PendingLogin): Promise<boolean> => {
    if (!login.configHome) return false;
    const result = await deps.identityOracle.resolveSlotTenant(login.configHome);
    return !('unavailable' in result) && typeof result.email === 'string' && result.email.length > 0;
  };

  const orchestrator = new SubscriptionReloginOrchestrator({
    store,
    authorityReady: () => deps.pool.getAvailability().state === 'ready',
    sourceIncidentOpen: (episode) => source(episode)?.closedAt === null,
    accountActive: (episode) => account(episode)?.status === 'active',
    recoverUncertain: async (episode) => {
      const login = pending(episode.accountId);
      if (login && await credentialReady(login)) return 'credential-ready';
      if (login?.status === 'pending') return 'cli-awaiting';
      return 'inconclusive';
    },
    startOrRecoverLogin: async (episode) => {
      const acct = mustAccount(account(episode));
      let login = pending(acct.id);
      if (!login || login.status === 'completed' || login.status === 'abandoned') {
        login = await deps.enrollment.start({ id: acct.id, label: acct.nickname, provider: acct.provider,
          framework: acct.framework, configHome: acct.configHome, expectedEmail: acct.email,
          openBrowser: false });
      } else if (login.status === 'expired') {
        login = await deps.enrollment.refresh(login.id);
      }
      if (!login) throw new Error('login-artifact-unavailable');
      return { attemptId: login.id, kind: login.kind, expiresAt: login.ttlExpiresAt,
        reissueCount: login.reissueCount };
    },
    driveBrowser: async (episode, artifact, signal) => {
      const acct = mustAccount(account(episode));
      const login = pending(acct.id); if (!login) throw new Error('login-artifact-unavailable');
      const { detail, browserAccount } = profileContext(acct);
      if (!detail?.userDataDir || !browserAccount) return { outcome: 'refused', failureClass: 'wrong-identity' };
      const driver = new AnthropicReloginBrowserDriver({ browser: deps.createBrowser(detail.userDataDir),
        resolveSecret: deps.resolveSecret, supervise: deps.supervise, seatLease, now });
      return driver.drive({ artifact, verificationUrl: login.verificationUrl, expectedIdentity: acct.email,
        loginMethod: autonomousLoginMethod(browserAccount), secretRefs: browserAccount.vaultBindings ?? {},
        allowedScopes: deps.allowedScopes ?? [] }, signal);
    },
    finishCli: async (episode, code, signal) => {
      const login = pending(episode.accountId); if (!login) throw new Error('login-artifact-unavailable');
      const result = await deps.pasteBack.finish(login, code, signal);
      if (result === 'complete') return 'complete';
      if (result === 'pending') return 'pending';
      throw new Error(`paste-back-${result}`);
    },
    verifyIdentity: async (episode) => {
      const acct = mustAccount(account(episode));
      const result = await deps.identityOracle.resolveSlotTenant(acct.configHome);
      if ('unavailable' in result || !result.email) return 'unavailable';
      return normalize(result.email) === normalize(acct.email) ? 'match' : 'mismatch';
    },
    verifyAuthenticatedUse: async (episode) => {
      const acct = mustAccount(account(episode));
      const result = await deps.quotaPoller.pollAccount(acct);
      if (!result) return false;
      authenticated.add(episode.id); return true;
    },
    finalizeSuccess: async (episode) => {
      if (!authenticated.has(episode.id)) throw new Error('authenticated-use-not-proven');
      const acct = mustAccount(account(episode));
      deps.pool.update(acct.id, { status: 'active' });
      deps.ledger.recordStatus({ accountId: acct.id, status: 'active', at: new Date(now()).toISOString(),
        corroboration: 'status-preexisting', provenance: 'observed' });
      authenticated.delete(episode.id);
    },
    now, maxAttempts: deps.maxAttempts, retryBaseMs: deps.retryBaseMs,
  });

  const admissionFor = (acct: SubscriptionAccount, sourceEpisode: SubscriptionLoginEpisode, currentEpisodeId?: string) => {
    const { resolved, detail, browserAccount } = profileContext(acct);
    return evaluateSubscriptionReloginAdmission({ configuredMode: deps.mode,
      poolAuthority: deps.pool.getAvailability().state, account: { id: acct.id, machineId: deps.machineId,
        status: acct.status, framework: acct.framework, provider: acct.provider, identityHash: identityHash(acct.email) },
      sourceEpisode, hasLiveRepair: store.list({ accountId: acct.id, limit: 10 }).some((item) =>
        item.id !== currentEpisodeId && !['succeeded', 'refused', 'cancelled', 'failed'].includes(item.state)),
      hasLivePendingLogin: pending(acct.id)?.status === 'pending',
      profile: detail && browserAccount ? { id: detail.id, ambiguous: resolved.ambiguous === true,
        dirExists: detail.dirExists, dedicated: !!detail.userDataDir, identityHash: identityHash(browserAccount.identity),
        loginMethod: browserAccount.loginMethod, danglingRefs: browserAccount.danglingRefs } : null,
      breakerOpen: store.isBreakerOpen(acct.id, acct.provider) });
  };
  const scanCandidates = async () => {
    if (deps.pool.getAvailability().state !== 'ready') return [];
    const open = deps.ledger.listEpisodes({ limit: 500 }).filter((item) => item.closedAt === null && item.machineId === deps.machineId);
    const candidates = [];
    for (const sourceEpisode of open) {
      const acct = deps.pool.get(sourceEpisode.accountId); if (!acct) continue;
      const verdict = admissionFor(acct, sourceEpisode); if (!verdict.admitted) continue;
      candidates.push({ sourceEpisodeId: sourceEpisode.id, accountId: acct.id, machineId: deps.machineId,
        mode: verdict.mode, inputDigest: verdict.inputDigest, profileId: verdict.profileId,
        framework: acct.framework, provider: acct.provider });
    }
    return candidates;
  };
  const service = new SubscriptionReloginService({ store, orchestrator, scanCandidates,
    revalidate: async (episode) => {
      const acct = account(episode); const sourceEpisode = source(episode);
      if (!acct || !sourceEpisode) return { admissible: false, reason: 'authority-row-missing' } as const;
      const verdict = admissionFor(acct, sourceEpisode, episode.id);
      return verdict.admitted ? { admissible: true, inputDigest: verdict.inputDigest } as const
        : { admissible: false, reason: verdict.reason } as const;
    }, onSuggested: deps.onSuggested, onTerminal: deps.onTerminal,
    onOperatorOnly: deps.onOperatorOnly, tickMs: deps.tickMs, now });
  return { store, service, start: () => service.start(), stop: () => service.stop(),
    close: () => { service.stop(); store.close(); } };
}

function normalize(value: string): string { return value.trim().toLowerCase(); }
function identityHash(value: string): string { return `sha256:${createHash('sha256').update(normalize(value)).digest('hex')}`; }
function mustAccount(value: SubscriptionAccount | null): SubscriptionAccount {
  if (!value) throw new Error('subscription-account-unavailable'); return value;
}
function autonomousLoginMethod(account: PlaywrightAccount): 'session-cookie' | 'password' | 'password+totp' {
  if (account.loginMethod === 'session-cookie' || account.loginMethod === 'password' || account.loginMethod === 'password+totp')
    return account.loginMethod;
  throw new Error('login-method-not-autonomous');
}
