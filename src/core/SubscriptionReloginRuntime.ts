import { createHash } from 'node:crypto';
import type { SubscriptionPool, SubscriptionAccount } from './SubscriptionPool.js';
import type { SubscriptionLoginLedger, SubscriptionLoginEpisode } from './SubscriptionLoginLedger.js';
import type { EnrollmentWizard } from './EnrollmentWizard.js';
import type { QuotaPoller } from './QuotaPoller.js';
import type { IdentityOracle } from './CredentialLocationLedger.js';
import type { PlaywrightProfileRegistry, PlaywrightAccount, PlaywrightProfileDetail } from './PlaywrightProfileRegistry.js';
import type { PendingLogin } from './PendingLoginStore.js';
import { evaluateSubscriptionReloginAdmission, type PasskeyCellAdmissionState } from './SubscriptionReloginPolicy.js';
import { SubscriptionReloginStore, type SubscriptionReloginEpisode } from './SubscriptionReloginStore.js';
import { SubscriptionReloginOrchestrator } from './SubscriptionReloginOrchestrator.js';
import { SubscriptionReloginService } from './SubscriptionReloginService.js';
import { AnthropicReloginBrowserDriver, type ReloginBrowserAction, type AgentNavigationInput,
  type ReloginBrowserPort, type ReloginBrowserSnapshot } from './AnthropicReloginBrowserDriver.js';
import { PlaywrightSeatLease } from './PlaywrightSeatLease.js';
import { resolveDevAgentGate } from './devAgentGate.js';
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
  /**
   * Agent navigation (spec agent-driven-relogin): `agent` lets a model choose each sign-in step
   * from the page's floor-filtered controls. Resolved by the caller (dev-agent gate); default `closed`.
   */
  navigation?: 'closed' | 'agent';
  /** The agent's chooser; required for `navigation: 'agent'` to take effect. */
  navigate?: (input: AgentNavigationInput) => Promise<string>;
  onSuggested?: (episode: SubscriptionReloginEpisode, deliveryKey: string) => Promise<void> | void;
  onTerminal?: (episode: SubscriptionReloginEpisode, deliveryKey: string) => Promise<void> | void;
  onOperatorOnly?: (episode: SubscriptionReloginEpisode, deliveryKey: string) => Promise<void> | void;
  allowedScopes?: string[]; tickMs?: number; maxAttempts?: number; retryBaseMs?: number;
  unattendedPolicy?: {
    identities?: string[];
    minimumSuccessfulRepairs?: number;
    minimumEvidenceDays?: number;
  };
  /**
   * The (account × machine) passkey cell's state for a `google-passkey` account (spec
   * agent-held-google-passkey §3.4). NOT wired on this build: absent ⇒ every cell reads
   * `unknown` ⇒ the policy refuses `passkey-cell-state-unknown`, so no passkey repair is ever
   * admitted until the store + health layer that computes it lands.
   */
  passkeyCellState?: (input: { accountId: string; machineId: string; entryKey: string }) => PasskeyCellAdmissionState;
  now?: () => number;
}

/**
 * Who chooses each sign-in step (spec agent-driven-relogin). An explicit
 * `assistedRelogin.navigation` wins; omitted ⇒ the development-agent gate
 * (agent on a development agent, closed on the fleet).
 */
export function resolveReloginNavigation(
  navigation: 'agent' | 'closed' | undefined,
  config: { developmentAgent?: boolean } | undefined,
): 'agent' | 'closed' {
  return resolveDevAgentGate(navigation === undefined ? undefined : navigation === 'agent', config) ? 'agent' : 'closed';
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
  const identityMismatches = new Map<string, string>();

  const source = (episode: SubscriptionReloginEpisode): SubscriptionLoginEpisode | null =>
    deps.ledger.listEpisodes({ accountId: episode.accountId, limit: 100 })
      .find((item) => item.id === episode.sourceEpisodeId && item.machineId === episode.machineId) ?? null;
  const account = (episode: SubscriptionReloginEpisode): SubscriptionAccount | null => deps.pool.get(episode.accountId);
  const profileContext = (acct: SubscriptionAccount) => {
    // Both subscription providers may authenticate directly or through Google.
    // Resolve only the provider's closed paths and require exactly one mapping;
    // never guess between identities or reuse a sibling provider's profile.
    const profiles = deps.profiles.listProfiles();
    const candidates: Array<{ detail: PlaywrightProfileDetail;
      browserAccount: PlaywrightAccount & { danglingRefs: string[] } }> = [];
    let registryAmbiguous = false;
    const services = acct.provider === 'openai' ? ['openai', 'google'] : ['anthropic', 'google'];
    for (const service of services) {
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

  const agentNavigation = deps.navigation === 'agent' && typeof deps.navigate === 'function';
  const orchestrator = new SubscriptionReloginOrchestrator({
    store,
    driveEventClass: () => agentNavigation ? 'agent-drive-started' : 'browser-drive-started',
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
      // Each attempt owns a fresh login. A live login seen at cli-starting was made before this
      // attempt (a dashboard link the auto-reissuer has been refreshing, or a prior attempt's), and
      // its cumulative reissueCount would be read as this episode's reissue budget — failing the
      // repair before the browser is ever driven. Nothing has been driven yet, so replacing it is safe.
      if (login && episode.state === 'cli-starting' && login.status !== 'completed' && login.status !== 'abandoned') {
        deps.enrollment.abandon(login.id);
        login = null;
      }
      if (!login || login.status === 'completed' || login.status === 'abandoned') {
        login = await deps.enrollment.start({ id: acct.id, label: acct.nickname, provider: acct.provider,
          framework: acct.framework, configHome: acct.configHome, expectedEmail: acct.email,
          openBrowser: false });
      } else if (login.status === 'expired') {
        login = await deps.enrollment.refresh(login.id);
      }
      if (!login) throw new Error('login-artifact-unavailable');
      return { attemptId: login.id, kind: login.kind, expiresAt: login.ttlExpiresAt,
        userCode: login.userCode, reissueCount: login.reissueCount };
    },
    driveBrowser: async (episode, artifact, signal) => {
      const acct = mustAccount(account(episode));
      const login = pending(acct.id); if (!login) throw new Error('login-artifact-unavailable');
      const { detail, browserAccount } = profileContext(acct);
      if (!detail?.userDataDir || !browserAccount) return { outcome: 'refused', failureClass: 'wrong-identity' };
      // A `google-passkey` account is NEVER driven through the password/session flow. The
      // passkey executor (credential load into the browser + the passkey page classes, spec
      // §3.5–§3.8) is not on this build, so the drive boundary refuses by name; admission
      // already refuses unless the cell is `ready`, which nothing can produce here.
      if (browserAccount.loginMethod === 'google-passkey') return { outcome: 'refused', failureClass: 'passkey-refused' };
      const driver = new AnthropicReloginBrowserDriver({ browser: deps.createBrowser(detail.userDataDir),
        resolveSecret: deps.resolveSecret, supervise: deps.supervise, seatLease, now,
        navigation: agentNavigation ? 'agent' : 'closed', navigate: deps.navigate });
      if (acct.provider !== 'anthropic' && acct.provider !== 'openai')
        return { outcome: 'refused', failureClass: 'provider-rejected' };
      return driver.drive({ artifact, verificationUrl: login.verificationUrl, provider: acct.provider,
        expectedIdentity: acct.email,
        loginMethod: autonomousLoginMethod(browserAccount), secretRefs: browserAccount.vaultBindings ?? {},
        allowedScopes: deps.allowedScopes ?? [] }, signal);
    },
    finishCli: async (episode, code, signal) => {
      const login = pending(episode.accountId); if (!login) throw new Error('login-artifact-unavailable');
      if (login.kind === 'device-code') return await credentialReady(login) ? 'complete' : 'pending';
      const result = await deps.pasteBack.finish(login, code, signal);
      if (result === 'complete') return 'complete';
      if (result === 'pending') return 'pending';
      throw new Error(`paste-back-${result}`);
    },
    verifyIdentity: async (episode) => {
      const acct = mustAccount(account(episode));
      const result = await deps.identityOracle.resolveSlotTenant(acct.configHome);
      if ('unavailable' in result || !result.email) return 'unavailable';
      if (normalize(result.email) === normalize(acct.email)) return 'match';
      identityMismatches.set(episode.id, result.email);
      return 'mismatch';
    },
    quarantineIdentityMismatch: async (episode) => {
      const acct = mustAccount(account(episode));
      const actualEmail = identityMismatches.get(episode.id);
      if (!actualEmail) throw new Error('identity-mismatch-evidence-missing');
      const actualAccountId = deps.pool.list().find((candidate) =>
        candidate.provider === acct.provider && normalize(candidate.email) === normalize(actualEmail))?.id
        ?? 'unrecognized-provider-identity';
      const at = new Date(now()).toISOString();
      deps.pool.update(acct.id, { identityDrifted: true, identityDrift: {
        expectedAccountId: acct.id, actualAccountId, actualEmail, slot: acct.configHome,
        detectedAt: at, lastConfirmedAt: at, repairState: 'owner-relogin-required',
      } });
      identityMismatches.delete(episode.id);
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

  const passkeyCellFor = (acct: SubscriptionAccount, browserAccount: PlaywrightAccount | null): PasskeyCellAdmissionState | null => {
    if (browserAccount?.loginMethod !== 'google-passkey') return null;
    const entryKey = browserAccount.vaultBindings?.passkey;
    if (!entryKey) return 'unknown';
    return deps.passkeyCellState?.({ accountId: acct.id, machineId: deps.machineId, entryKey }) ?? 'unknown';
  };
  const admissionFor = (acct: SubscriptionAccount, sourceEpisode: SubscriptionLoginEpisode, currentEpisodeId?: string) => {
    const { resolved, detail, browserAccount } = profileContext(acct);
    // Graduation evidence is scoped to the account's CURRENT method (a method change resets it).
    const evidence = store.getUnattendedEvidence(acct.id, deps.machineId, acct.provider, acct.framework,
      browserAccount?.loginMethod ?? null);
    const oldestSuccessAt = evidence.oldestSuccessAt === null ? null : Date.parse(evidence.oldestSuccessAt);
    const optedInIdentities = deps.unattendedPolicy?.identities ?? [];
    return evaluateSubscriptionReloginAdmission({ configuredMode: deps.mode,
      poolAuthority: deps.pool.getAvailability().state, account: { id: acct.id, machineId: deps.machineId,
        status: acct.status, framework: acct.framework, provider: acct.provider, identityHash: identityHash(acct.email) },
      sourceEpisode, hasLiveRepair: store.list({ accountId: acct.id, limit: 10 }).some((item) =>
        item.id !== currentEpisodeId && !['succeeded', 'refused', 'cancelled', 'failed'].includes(item.state)),
      hasLivePendingLogin: pending(acct.id)?.status === 'pending',
      profile: detail && browserAccount ? { id: detail.id, ambiguous: resolved.ambiguous === true,
        dirExists: detail.dirExists, dedicated: !!detail.userDataDir, identityHash: identityHash(browserAccount.identity),
        loginMethod: browserAccount.loginMethod, danglingRefs: browserAccount.danglingRefs,
        passkeyEntryKey: browserAccount.vaultBindings?.passkey ?? null,
        passkeyCell: passkeyCellFor(acct, browserAccount) } : null,
      breakerOpen: store.isBreakerOpen(acct.id, acct.provider),
      unattended: {
        explicitlyEnabled: optedInIdentities.some((identity) => normalize(identity) === normalize(acct.email)),
        successfulRepairs: evidence.successfulRepairs,
        evidenceDays: oldestSuccessAt === null || !Number.isFinite(oldestSuccessAt)
          ? 0 : Math.max(0, Math.floor((now() - oldestSuccessAt) / 86_400_000)),
        identityMismatches: evidence.identityMismatches,
        unexpectedOrigins: evidence.unexpectedOrigins,
        minimumSuccessfulRepairs: deps.unattendedPolicy?.minimumSuccessfulRepairs,
        minimumEvidenceDays: deps.unattendedPolicy?.minimumEvidenceDays,
      } });
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
        framework: acct.framework, provider: acct.provider,
        loginMethod: profileContext(acct).browserAccount?.loginMethod ?? null });
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
function autonomousLoginMethod(account: PlaywrightAccount): 'session-cookie' | 'password' | 'password+totp' | 'google-passkey' {
  if (account.loginMethod === 'session-cookie' || account.loginMethod === 'password' || account.loginMethod === 'password+totp'
    || account.loginMethod === 'google-passkey')
    return account.loginMethod;
  throw new Error('login-method-not-autonomous');
}
