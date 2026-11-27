import { createHash } from 'node:crypto';
import type { SubscriptionPool, SubscriptionAccount } from './SubscriptionPool.js';
import type { SubscriptionLoginLedger, SubscriptionLoginEpisode } from './SubscriptionLoginLedger.js';
import type { EnrollmentWizard } from './EnrollmentWizard.js';
import type { QuotaPoller } from './QuotaPoller.js';
import type { IdentityOracle } from './CredentialLocationLedger.js';
import type { PlaywrightProfileRegistry, PlaywrightAccount, PlaywrightProfileDetail } from './PlaywrightProfileRegistry.js';
import type { PendingLogin } from './PendingLoginStore.js';
import { evaluateSubscriptionReloginAdmission, isReloginSupportedPath, type PasskeyCellAdmissionState,
  type SubscriptionReloginRefusal } from './SubscriptionReloginPolicy.js';
import { SubscriptionReloginStore, type SubscriptionReloginEpisode } from './SubscriptionReloginStore.js';
import { SubscriptionReloginOrchestrator } from './SubscriptionReloginOrchestrator.js';
import { SubscriptionReloginService } from './SubscriptionReloginService.js';
import { AnthropicReloginBrowserDriver, type ReloginBrowserAction, type AgentNavigationInput,
  type ReloginBrowserPort, type ReloginBrowserSnapshot } from './AnthropicReloginBrowserDriver.js';
import { PlaywrightSeatLease } from './PlaywrightSeatLease.js';
import { resolveDevAgentGate } from './devAgentGate.js';
import { validClaudePasteBackCode, type ClaudePasteBackController } from './ClaudePasteBackController.js';
import { SubscriptionReloginHelper, type ReloginHelperBrowserDriver, type ReloginHelperSeat } from './SubscriptionReloginHelper.js';
import { isWslHost } from './wslPlatform.js';
import type { CliLoginVerdict } from './CliLoginStatus.js';
import type { ReloginLastResortStatus } from './ReloginLastResortProvider.js';

/**
 * The last-resort model port (spec relogin-last-resort-model): a lightweight model over an
 * operator-placed API key that answers the repair's own model calls when the shared provider
 * cannot. The runtime only asks whether it is available and brackets each drive for its caps;
 * the evaluate itself is wired into `supervise` / `navigate` by the caller.
 */
export interface ReloginLastResortPort {
  available(): boolean;
  beginDrive(episodeId: string): void;
  endDrive(episodeId: string): void;
  status(): ReloginLastResortStatus;
}

/** The outcome of the passkey sign-in step, states only (never an email, a URL or key material). */
export interface PasskeyRepairSignInResult {
  outcome: 'ready' | 'failed' | 'unknown' | 'credential-rejected' | 'removed-on-google' | 'security';
  reason: string;
  riskPage: boolean;
  throttled: boolean;
}

export interface SubscriptionReloginRuntimeDeps {
  stateDir: string; projectDir: string; machineId: string;
  mode: 'observe' | 'approval' | 'unattended';
  pool: SubscriptionPool; ledger: SubscriptionLoginLedger; enrollment: EnrollmentWizard;
  profiles: PlaywrightProfileRegistry; quotaPoller: QuotaPoller; identityOracle: IdentityOracle;
  pasteBack: ClaudePasteBackController;
  /** The screen state at a failed drive, for the audit trail (see SubscriptionReloginOrchestratorDeps). */
  screenStateAtFailure?: () => Promise<'locked' | 'asleep' | 'lock-flag-set' | null>;
  createBrowser: (userDataDir: string) => ReloginBrowserPort;
  resolveSecret: (name: string) => Promise<string | null>;
  /** Take one single-use Google backup code out of a vault entry (see AnthropicReloginBrowserDriverDeps). */
  takeBackupCode?: (name: string) => Promise<string | null>;
  supervise: (input: { snapshot: ReloginBrowserSnapshot; allowedActions: ReloginBrowserAction[] }) => Promise<ReloginBrowserAction>;
  /**
   * Agent navigation (spec agent-driven-relogin): `agent` lets a model choose each sign-in step
   * from the page's floor-filtered controls. Resolved by the caller (dev-agent gate); default `closed`.
   */
  navigation?: 'closed' | 'agent' | 'agent-session';
  /**
   * Authenticator over a phone prompt (spec relogin-authenticator-over-phone-prompt), already
   * resolved by `resolveAuthenticatorOverPhone`. Absent ⇒ off: the helper prompt is unchanged.
   */
  authenticatorOverPhone?: AuthenticatorOverPhoneMode;
  /**
   * The agent-session helper's ports (spec skill-driven-signin-repair). Required when
   * `navigation` is `agent-session`; ignored otherwise.
   */
  helperSession?: {
    spawn: (input: { name: string; prompt: string; seat: ReloginHelperSeat; maxDurationMinutes: number }) => Promise<string>;
    isAlive: (tmuxSession: string) => boolean;
    kill: (tmuxSession: string) => void;
    listHelpers: () => Array<{ name: string; tmuxSession: string }>;
    hasCapacity: () => boolean;
    serverPort: number;
    browserDriver?: ReloginHelperBrowserDriver;
    /** `codex login status` for a config home, proven able to fail (CliLoginStatus). */
    codexLoginStatus?: (codexHome: string) => Promise<CliLoginVerdict>;
    /** Test seams for the helper's timers. */
    timing?: { pollMs?: number; leaseRenewMs?: number; capMs?: number; exitSettleMs?: number; startGraceMs?: number };
  };
  /** The agent's chooser; required for `navigation: 'agent'` to take effect. */
  navigate?: (input: AgentNavigationInput) => Promise<string>;
  /**
   * The last-resort model (spec relogin-last-resort-model). With it available, an agent-session
   * repair that finds NO other healthy account on this machine (`no-healthy-seat`) drives the
   * server-side browser path with agent navigation instead of waiting on the operator; `navigate`
   * is required for that. Absent or unavailable ⇒ the no-healthy-seat hand-off exactly as before.
   */
  lastResort?: ReloginLastResortPort;
  onSuggested?: (episode: SubscriptionReloginEpisode, deliveryKey: string) => Promise<void> | void;
  onTerminal?: (episode: SubscriptionReloginEpisode, deliveryKey: string) => Promise<void> | void;
  onOperatorOnly?: (episode: SubscriptionReloginEpisode, deliveryKey: string) => Promise<void> | void;
  onPhoneTap?: (episode: SubscriptionReloginEpisode, deliveryKey: string) => Promise<void> | void;
  /** A failed/refused repair's cell is verified signed in again: close that condition's attention row. */
  onConditionCleared?: (episode: SubscriptionReloginEpisode) => Promise<void> | void;
  /**
   * False when the live Codex app-server read is turned off (`subscriptionPool.codexLiveQuota:
   * false`). Then no Codex repair can ever prove authenticated use (the rollout file is not proof),
   * so Codex episodes are refused at admission with a named reason instead of burning attempts.
   */
  /**
   * codex-device-limit-tripwire §4: true while the account is suspected or benched for a device
   * limit on this machine (switch-aware). Defers slow retries; never mutates an episode.
   */
  deviceLimitHold?: (accountId: string) => boolean;
  /** codex-device-limit-tripwire §2 C: judge an `unknown` OpenAI sign-in page (true ⇒ device limit). */
  judgeDeviceLimitPage?: (accountId: string, text: string) => Promise<boolean>;
  /** codex-device-limit-tripwire §4: a repair ended at a (suspected) device-limit page. */
  onDeviceLimitStopped?: (accountId: string) => void;
  codexLiveReadAvailable?: boolean;
  /** Host seat lease override (tests); defaults to the host-wide Playwright seat lease. */
  seatLease?: PlaywrightSeatLease;
  allowedScopes?: string[]; tickMs?: number; maxAttempts?: number; retryBaseMs?: number;
  /**
   * Slow automatic retry of failed repairs while the incident stays open (spec
   * relogin-unattended-agent-session-and-slow-retry). Absent ⇒ on, 6 h then 24 h, at most 3.
   */
  slowRetry?: { enabled?: boolean; delaysMs?: number[]; maxRetries?: number; quietHours?: { startHour: number; endHour: number } | null };
  unattendedPolicy?: {
    identities?: string[];
    minimumSuccessfulRepairs?: number;
    minimumEvidenceDays?: number;
  };
  /**
   * The (account × machine) passkey cell's state for a `google-passkey` account (spec
   * agent-held-google-passkey §3.4), computed by `passkeyRepairAdmissionState` over the grant,
   * custody, Chrome gate and health stores. Absent (passkeys off) ⇒ every cell reads `unknown`
   * ⇒ the policy refuses `passkey-cell-state-unknown`. `canonicalEmail` is the account row's
   * identity, lower-cased; the stores are keyed by it.
   */
  passkeyCellState?: (input: { accountId: string; machineId: string; entryKey: string; canonicalEmail: string }) => PasskeyCellAdmissionState;
  /**
   * The Google passkey sign-in STEP of a `google-passkey` repair (spec agent-held-google-passkey §3.4,
   * in the two-step shape the Chief of Staff ruled on 2026-11-26): sign the account's own dedicated
   * profile in to Google with the agent's passkey and leave that session, so the provider sign-in that
   * follows runs in the NORMAL browser exactly as today. Wired ONLY when `passkeys.repairUsesPasskey`
   * is true; absent ⇒ every passkey repair refuses by name (`passkey-refused`, reason
   * `passkey-sign-in-off`). Turning it on for a real account is the operator's decision.
   */
  passkeySignIn?: (input: { accountId: string; canonicalEmail: string; profileDir: string }, signal?: AbortSignal) => Promise<PasskeyRepairSignInResult>;
  now?: () => number;
}

/**
 * Who chooses each sign-in step (spec agent-driven-relogin). An explicit
 * `assistedRelogin.navigation` wins; omitted ⇒ the development-agent gate
 * (agent on a development agent, closed on the fleet).
 */
export function resolveReloginNavigation(
  navigation: 'agent' | 'closed' | 'agent-session' | undefined,
  config: { developmentAgent?: boolean } | undefined,
  platform: NodeJS.Platform = process.platform,
  wsl: boolean = isWslHost(platform),
): 'agent' | 'closed' | 'agent-session' {
  // Skill-driven sign-in repair (spec skill-driven-signin-repair): `agent-session` is honored on
  // macOS, and on WSL when set explicitly (spec windows-signin-repair); omitted ⇒ `agent-session`
  // on a macOS development agent. Everywhere else the value resolves to the existing driver
  // exactly as before.
  if (wsl && navigation === 'agent-session') return 'agent-session';
  if (platform === 'darwin') {
    if (navigation === 'agent-session') return 'agent-session';
    if (navigation === undefined && resolveDevAgentGate(undefined, config)) return 'agent-session';
  }
  const legacy = navigation === 'agent-session' ? undefined : navigation;
  return resolveDevAgentGate(legacy === undefined ? undefined : legacy === 'agent', config) ? 'agent' : 'closed';
}

export interface SubscriptionReloginRuntime {
  store: SubscriptionReloginStore; service: SubscriptionReloginService;
  /** Present only on the agent-session path: the code route's handler. */
  helper: SubscriptionReloginHelper | null;
  /** The last-resort model port when configured (spec relogin-last-resort-model). */
  lastResort: ReloginLastResortPort | null;
  /**
   * True only when THIS machine's server has verified the account×machine cell signed in: pool
   * `active`, no identity drift, and a live login check of `ok`. Another machine's cell is
   * never verifiable here ⇒ false.
   */
  cellVerifiedHealthy(accountId: string, machineId: string): boolean;
  /**
   * Why each needs-sign-in account on THIS machine has no repair (Registry First: "why didn't the
   * repair start?" is a read, never a guess). Read-only: no row, ledger entry or login is written.
   */
  blockers(): Promise<SubscriptionReloginBlocker[]>;
  /** codex-device-limit-tripwire §4: end every live repair for a benched account on this machine. */
  endForDeviceLimit(accountId: string): Promise<Array<{ id: string; ended: boolean; reason?: string }>>;
  start(): void; stop(): void; close(): void;
}

/**
 * A needs-sign-in account the automatic repair will not start for. `no-open-incident`: nothing
 * has corroborated the sign-in as dead on this machine (for example its stored login cannot be
 * read), and a repair needs that evidence; any other reason is the admission refusal.
 */
export interface SubscriptionReloginBlocker {
  accountId: string; machineId: string; framework: string;
  reason: 'no-open-incident' | SubscriptionReloginRefusal;
}

/** Production-shaped composition. All authority lookups are repeated at action boundaries. */
export function createSubscriptionReloginRuntime(deps: SubscriptionReloginRuntimeDeps): SubscriptionReloginRuntime {
  const now = deps.now ?? Date.now;
  const store = new SubscriptionReloginStore({ stateDir: deps.stateDir, now });
  const seatLease = deps.seatLease ?? new PlaywrightSeatLease({ now });
  const agentSession = deps.navigation === 'agent-session';
  const windowsHelper = agentSession && deps.helperSession?.browserDriver === 'windows';
  if (agentSession && !deps.helperSession) throw new Error('relogin-agent-session-ports-missing');
  // Every navigation path honors the configured mode the same way (spec
  // relogin-unattended-agent-session-and-slow-retry, superseding skill-driven-signin-repair's
  // forced approval): `unattended` still starts without a tap ONLY for an account whose exact email
  // is on `unattendedPolicy.identities` AND that clears the evidence floors — the admission policy
  // holds everything else at `approval`.
  const effectiveMode: SubscriptionReloginRuntimeDeps['mode'] = deps.mode;
  let serviceRef: SubscriptionReloginService | null = null;
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

  const walled = (quota: SubscriptionAccount['lastQuota']): boolean =>
    (quota?.fiveHour?.utilizationPct ?? 0) >= 100 || (quota?.sevenDay?.utilizationPct ?? 0) >= 100;
  const helper = agentSession ? new SubscriptionReloginHelper({
    lease: seatLease,
    hasCapacity: deps.helperSession!.hasCapacity,
    // Any healthy account on this machine, Claude or Codex, never the one under repair (spec §2).
    // Healthy = active, not identity-drifted, not walled, and a JUST-IN-TIME authenticated read
    // (for Codex: the CLI's own login check AND a live app-server read). Claude's CLI status is
    // not used: it only proves a credential file exists.
    pickSeat: async (excludeAccountId) => {
      const candidates = deps.pool.list()
        .filter((acct) => acct.id !== excludeAccountId && acct.status === 'active' && acct.identityDrifted !== true
          && ((acct.provider === 'anthropic' && acct.framework === 'claude-code')
            || (acct.provider === 'openai' && acct.framework === 'codex-cli'))
          && !walled(acct.lastQuota))
        .sort((a, b) => (a.framework === b.framework ? 0 : a.framework === 'claude-code' ? -1 : 1));
      for (const acct of candidates) {
        try {
          if (acct.framework === 'codex-cli') {
            const cli = await deps.helperSession!.codexLoginStatus?.(acct.configHome) ?? 'unavailable';
            if (cli !== 'signed-in') continue;
          }
          const snapshot = await deps.quotaPoller.pollAccount(acct);
          if (!snapshot || walled(snapshot)) continue;
          if (acct.framework === 'codex-cli' && snapshot.source !== 'codex-app-server') continue;
          return { accountId: acct.id, framework: acct.framework as 'claude-code' | 'codex-cli', configHome: acct.configHome };
        } catch {
          continue; // @silent-fallback-ok — an unmeasurable account is simply not eligible as a helper seat
        }
      }
      return null;
    },
    spawn: deps.helperSession!.spawn,
    isAlive: deps.helperSession!.isAlive,
    kill: deps.helperSession!.kill,
    listHelpers: deps.helperSession!.listHelpers,
    credentialReady: async (episode) => {
      const login = pending(episode.accountId);
      return !!login && await credentialReady(login);
    },
    queuePhoneTap: (episodeId) => {
      store.enqueuePhoneTap(episodeId);
      void serviceRef?.flushNotifications();
    },
    noteAuthenticator: (episodeId, label) => { store.recordAuthenticatorEvent(episodeId, label); },
    authenticatorLatch: (driveId) => store.authenticatorSupervision(driveId).state,
    noteAuthenticatorUse: (episodeId, driveId) => { store.recordAuthenticatorUse(episodeId, driveId); },
    authenticatorCodesGranted: (episodeId) => store.authenticatorCodesGranted(episodeId),
    onDeviceLimitReported: (episodeId) => {
      const accountId = store.get(episodeId)?.accountId;
      if (accountId) deps.onDeviceLimitStopped?.(accountId);
    },
    validateCode: validClaudePasteBackCode,
    serverPort: deps.helperSession!.serverPort,
    browserDriver: deps.helperSession!.browserDriver,
    now,
    ...(deps.helperSession!.timing ?? {}),
  }) : null;

  const agentNavigation = deps.navigation === 'agent' && typeof deps.navigate === 'function';
  // Episodes the agent-session path handed to the server-side driver because no other healthy
  // account could run the helper and the last-resort model is available (spec
  // relogin-last-resort-model). In-memory on purpose: a restart lands in `recoverUncertain`.
  const lastResortDrives = new Set<string>();
  const lastResortDriveAvailable = (): boolean =>
    deps.lastResort?.available() === true && typeof deps.navigate === 'function';
  const orchestrator = new SubscriptionReloginOrchestrator({
    store,
    screenStateAtFailure: deps.screenStateAtFailure,
    driveEventClass: (episode) => lastResortDrives.has(episode.id) ? 'last-resort-drive-started'
      : helper ? 'agent-session-drive-started' : agentNavigation ? 'agent-drive-started' : 'browser-drive-started',
    preAttempt: helper ? async (episode, signal) => {
      const verdict = await helper.preAttempt(episode, signal);
      if (verdict.kind === 'no-healthy-seat' && lastResortDriveAvailable()) {
        lastResortDrives.add(episode.id);
        return { kind: 'ok' };
      }
      return verdict;
    } : undefined,
    releaseAttempt: helper ? (episode) => { lastResortDrives.delete(episode.id); helper.releaseAttempt(episode); } : undefined,
    authorityReady: () => deps.pool.getAvailability().state === 'ready',
    sourceIncidentOpen: (episode) => source(episode)?.closedAt === null,
    accountActive: (episode) => account(episode)?.status === 'active',
    recoverUncertain: async (episode) => {
      // After a restart the token and the wait are gone, so a surviving helper can never finish.
      if (helper && episode.state === 'browser-driving') helper.killOrphan(episode.id);
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
      // A new attempt forgets the previous attempt's login first, so a failed record below can never
      // leave a stale value that would block this repair's retries.
      if (episode.state === 'cli-starting') {
        try { store.recordAttemptLogin(episode.id, null); }
        catch { /* @silent-fallback-ok — a stale value only makes the retry defer, never wrong */ }
      }
      if (login && episode.state === 'cli-starting' && login.status !== 'completed' && login.status !== 'abandoned') {
        deps.enrollment.abandon(login.id);
        login = null;
      }
      if (!login || login.status === 'completed' || login.status === 'abandoned') {
        login = await deps.enrollment.start({ id: acct.id, label: acct.nickname, provider: acct.provider,
          framework: acct.framework, configHome: acct.configHome, expectedEmail: acct.email,
          openBrowser: false });
        // Only a login THIS attempt created is recorded as the repair's own (reissues keep createdAt).
        if (login) {
          try { store.recordAttemptLogin(episode.id, login.createdAt); }
          catch { /* @silent-fallback-ok — without the record the slow retry simply never releases this login */ }
        }
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
      if (acct.provider !== 'anthropic' && acct.provider !== 'openai')
        return { outcome: 'refused', failureClass: 'provider-rejected' };
      // A `google-passkey` account is NEVER driven through the password flow and never falls through
      // to another method. Its Google sign-in is the passkey step (in the passkey-capable browser, on
      // the account's own profile, which then closes); the provider sign-in after it is the ordinary
      // session drive below, in the normal browser, with no secret at all.
      let driveAccount: PlaywrightAccount = browserAccount;
      if (browserAccount.loginMethod === 'google-passkey') {
        if (!deps.passkeySignIn) return { outcome: 'refused', failureClass: 'passkey-refused', reason: 'passkey-sign-in-off' };
        // The passkey step signs in `userDataDir`; a Windows helper drives a different profile copy,
        // so the session would not carry over. Refused by name until that path is built.
        if (windowsHelper && detail.windowsUserDataDir) return { outcome: 'refused', failureClass: 'passkey-refused', reason: 'passkey-windows-profile-unsupported' };
        const canonicalEmail = browserAccount.identity.trim().toLowerCase();
        // Defensive: profileContext already picks only a profile whose identity matches the account email.
        if (normalize(canonicalEmail) !== normalize(acct.email)) return { outcome: 'refused', failureClass: 'wrong-identity' };
        // One real browser per host (§4): the passkey step always holds the host-wide seat. On the helper
        // path it acquires as the helper's own holder (a renewal when the pre-attempt already holds it,
        // a fresh take when it does not: the helper released it, or a resumed drive skipped the
        // pre-attempt). It keeps the seat only when it goes on to `helper.drive`, whose release ends it;
        // on every other exit (an early refusal, a throw, or the last-resort drive, which takes the seat
        // under its own holder) it gives the seat back. Release is owner-checked, so a second release by
        // the helper is a no-op.
        const pkHolder = helper ? SubscriptionReloginHelper.holderId(episode.id) : `passkey-repair:${episode.id}`;
        const keepSeat = !!helper && !lastResortDrives.has(episode.id);
        if (!seatLease.acquire(pkHolder, 'passkey repair sign-in').acquired) return { outcome: 'transient', failureClass: 'seat-busy', reason: 'seat-busy' };
        let signedIn: PasskeyRepairSignInResult;
        let goesOn = false;
        try {
          signedIn = await deps.passkeySignIn({ accountId: acct.id, canonicalEmail, profileDir: detail.userDataDir }, signal);
          goesOn = !signedIn.riskPage && (signedIn.outcome === 'ready' || (signedIn.outcome === 'unknown' && signedIn.reason === 'session-present'));
        } finally { if (!keepSeat || !goesOn) seatLease.release(pkHolder); }
        if (signedIn.riskPage) return { outcome: 'operator-only', failureClass: 'captcha', reason: 'google-risk-page' };
        if (signedIn.outcome === 'security') return { outcome: 'refused', failureClass: 'wrong-identity', reason: 'passkey-identity-mismatch' };
        if (!goesOn)
          return { outcome: 'refused', failureClass: 'passkey-refused', reason: signedIn.throttled ? 'passkey-throttled' : `passkey-${signedIn.outcome}` };
        driveAccount = { ...browserAccount, loginMethod: 'session-cookie', vaultBindings: {} };
      }
      // Resumed attempts can reach the drive without running admission again.
      const unattended = episode.mode === 'unattended';
      const { backupCode, ...otherSecretRefs } = driveAccount.vaultBindings ?? {};
      const secretRefs = unattended ? otherSecretRefs : { ...otherSecretRefs, backupCode };
      if (helper && unattended && backupCode) {
        return { outcome: 'operator-only', failureClass: 'agent-hard-line', reason: 'unattended-backup-code-forbidden' };
      }
      if (helper && !lastResortDrives.has(episode.id)) {
        const result = await helper.drive({ episode, artifact, verificationUrl: login.verificationUrl, expectedEmail: acct.email,
          provider: acct.provider, profileDir: (windowsHelper ? detail.windowsUserDataDir : undefined) ?? detail.userDataDir,
          vaultBindingNames: Object.values(secretRefs).filter((name): name is string => typeof name === 'string'),
          authenticatorMode: helperAuthenticatorMode(deps.authenticatorOverPhone, browserAccount.loginMethod, secretRefs),
        }, signal);
        // A drive resumed past the pre-attempt check (a restart after `cli-starting`) reaches the
        // helper with no seat; with the last resort available it falls through here too, instead
        // of handing the operator a `no-healthy-seat` the pre-attempt path would have avoided.
        if (!(result.outcome === 'operator-only' && result.failureClass === 'no-healthy-seat' && lastResortDriveAvailable())) return result;
        lastResortDrives.add(episode.id);
      }
      const lastResortDrive = lastResortDrives.has(episode.id);
      // The server-side driver: the fixed page-class table, or agent navigation. A last-resort
      // drive always navigates by agent (the fallback exists for a page the table cannot read);
      // its model calls are capped per drive by the port, bracketed here.
      const driver = new AnthropicReloginBrowserDriver({ browser: deps.createBrowser(detail.userDataDir),
        resolveSecret: deps.resolveSecret, takeBackupCode: unattended ? undefined : deps.takeBackupCode, supervise: deps.supervise, seatLease, now,
        navigation: agentNavigation || lastResortDrive ? 'agent' : 'closed', navigate: deps.navigate,
        ...(deps.judgeDeviceLimitPage ? { judgeDeviceLimitPage: (text: string) => deps.judgeDeviceLimitPage!(acct.id, text) } : {}) });
      deps.lastResort?.beginDrive(episode.id);
      try {
        const driven = await driver.drive({ artifact, verificationUrl: login.verificationUrl, provider: acct.provider,
          expectedIdentity: acct.email,
          loginMethod: autonomousLoginMethod(driveAccount), secretRefs, unattended,
          allowedScopes: resolveAllowedScopes(deps.allowedScopes, login.verificationUrl) }, signal);
        if (driven.outcome === 'refused' && driven.failureClass === 'device-limit') deps.onDeviceLimitStopped?.(acct.id);
        return driven;
      } finally {
        deps.lastResort?.endDrive(episode.id);
      }
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
      // For Codex only a LIVE app-server read proves the login; the rollout file is usage history.
      if (acct.framework === 'codex-cli' && result.source !== 'codex-app-server') return false;
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
    if (!deps.passkeySignIn) return 'sign-in-off';
    const entryKey = browserAccount.vaultBindings?.passkey;
    if (!entryKey) return 'unknown';
    const canonicalEmail = browserAccount.identity.trim().toLowerCase();
    if (!canonicalEmail.includes('@')) return 'unknown';
    try {
      return deps.passkeyCellState?.({ accountId: acct.id, machineId: deps.machineId, entryKey, canonicalEmail }) ?? 'unknown';
    } catch {
      // @silent-fallback-ok — an unreadable passkey store refuses the passkey path by name
      // (`passkey-cell-state-unknown`); it never admits and never falls through to another method.
      return 'unknown';
    }
  };
  const admissionFor = async (acct: SubscriptionAccount, sourceEpisode: SubscriptionLoginEpisode,
    current?: Pick<SubscriptionReloginEpisode, 'id' | 'loginCreatedAt' | 'startedAt' | 'finishedAt'>) => {
    const currentEpisodeId = current?.id;
    if (acct.framework === 'codex-cli' && deps.codexLiveReadAvailable === false)
      return { admitted: false, reason: 'codex-live-read-disabled' } as const;
    const { resolved, detail, browserAccount } = profileContext(acct);
    // Graduation evidence is scoped to the account's CURRENT method (a method change resets it).
    const evidence = store.getUnattendedEvidence(acct.id, deps.machineId, acct.provider, acct.framework,
      browserAccount?.loginMethod ?? null);
    const oldestSuccessAt = evidence.oldestSuccessAt === null ? null : Date.parse(evidence.oldestSuccessAt);
    const optedInIdentities = deps.unattendedPolicy?.identities ?? [];
    // A helper has access to the machine vault. Keep accounts with a bound
    // recovery code on explicit approval instead of entrusting that boundary to its prompt.
    const helperHasBackupCode = !!helper && !!browserAccount?.vaultBindings?.backupCode;
    // The repair's OWN leftover login (the one its failed attempt created; reissues keep createdAt)
    // does not block its retry: the orchestrator replaces it at cli-starting, as for any attempt.
    // Any other pending login (an operator's) still blocks.
    const livePending = pending(acct.id);
    const ownLeftover = !!livePending && isOwnLeftoverLogin(livePending.createdAt, current);
    // A legacy row matched by its run window: pin the exact login now, because a re-offer clears the
    // window (startedAt/finishedAt) and the later approval must still recognise its own login.
    if (ownLeftover && current && !current.loginCreatedAt && livePending) {
      try { store.recordAttemptLogin(current.id, livePending.createdAt); }
      catch { /* @silent-fallback-ok — without the pin a later approval refuses and the retry is deferred, never wrong */ }
    }
    return evaluateSubscriptionReloginAdmission({ configuredMode: effectiveMode,
      poolAuthority: deps.pool.getAvailability().state, account: { id: acct.id, machineId: deps.machineId,
        status: acct.status, framework: acct.framework, provider: acct.provider, identityHash: identityHash(acct.email), statusCause: acct.statusCause ?? null },
      sourceEpisode, hasLiveRepair: store.list({ accountId: acct.id, limit: 10 }).some((item) =>
        item.id !== currentEpisodeId && !['succeeded', 'refused', 'cancelled', 'failed'].includes(item.state)),
      hasLivePendingLogin: livePending?.status === 'pending' && !ownLeftover,
      profile: detail && browserAccount ? { id: detail.id, ambiguous: resolved.ambiguous === true,
        // A WSL helper can only open a Windows folder; the Linux path is metadata there.
        dirExists: detail.dirExists && (!windowsHelper || !!detail.windowsUserDataDir), dedicated: !!detail.userDataDir, identityHash: identityHash(browserAccount.identity),
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
        helperHardLines: evidence.helperHardLines,
        backupCodesLow: helperHasBackupCode,
      } });
  };
  const scanCandidates = async () => {
    if (deps.pool.getAvailability().state !== 'ready') return [];
    const open = deps.ledger.listEpisodes({ limit: 500 }).filter((item) => item.closedAt === null && item.machineId === deps.machineId);
    const candidates = [];
    for (const sourceEpisode of open) {
      const acct = deps.pool.get(sourceEpisode.accountId); if (!acct) continue;
      // The incident's own re-admittable row (`suggested` or `cancelled`) is not "another live
      // repair": without this, a row whose inputs changed (e.g. its mode flipped to unattended) could
      // never be re-admitted, and its stale digest would also refuse the operator's tap.
      const own = store.list({ accountId: acct.id, limit: 100 }).find((item) =>
        item.sourceEpisodeId === sourceEpisode.id && item.machineId === deps.machineId
        && (item.state === 'suggested' || item.state === 'cancelled'));
      const verdict = await admissionFor(acct, sourceEpisode, own); if (!verdict.admitted) continue;
      candidates.push({ sourceEpisodeId: sourceEpisode.id, accountId: acct.id, machineId: deps.machineId,
        mode: verdict.mode, inputDigest: verdict.inputDigest, profileId: verdict.profileId,
        framework: acct.framework, provider: acct.provider,
        loginMethod: profileContext(acct).browserAccount?.loginMethod ?? null });
    }
    return candidates;
  };
  // Verified healthy by the server: pool `active`, no identity drift (the poller reconciles the
  // credential's identity), and this process's latest poll was an authenticated read. Only this
  // machine's own cells can be verified here.
  const cellVerifiedHealthy = (accountId: string, machineId: string): boolean => {
    if (machineId !== deps.machineId) return false;
    const acct = deps.pool.get(accountId);
    return !!acct && acct.status === 'active' && acct.identityDrifted !== true
      && deps.quotaPoller.loginCheck?.(acct.id) === 'ok';
  };
  const blockers = async (): Promise<SubscriptionReloginBlocker[]> => {
    if (deps.pool.getAvailability().state !== 'ready') return [];
    const open = deps.ledger.listEpisodes({ limit: 500 }).filter((item) => item.closedAt === null && item.machineId === deps.machineId);
    const out: SubscriptionReloginBlocker[] = [];
    for (const acct of deps.pool.list()) {
      if (acct.status !== 'needs-reauth' || !isReloginSupportedPath(acct.provider, acct.framework)) continue;
      const sourceEpisode = open.find((item) => item.accountId === acct.id);
      const base = { accountId: acct.id, machineId: deps.machineId, framework: acct.framework };
      // A device-limit bench is the reason, with or without an open incident (spec codex-device-limit-tripwire §8).
      if (acct.statusCause === 'codex-device-limit') { out.push({ ...base, reason: 'device-limit-benched' }); continue; }
      if (!sourceEpisode) { out.push({ ...base, reason: 'no-open-incident' }); continue; }
      // A repair row for this incident is already visible as an episode; its state says the rest.
      if (store.list({ accountId: acct.id, limit: 100 }).some((item) => item.sourceEpisodeId === sourceEpisode.id
        && item.machineId === deps.machineId)) continue;
      const verdict = await admissionFor(acct, sourceEpisode);
      if (!verdict.admitted) out.push({ ...base, reason: verdict.reason });
    }
    return out;
  };
  const service = new SubscriptionReloginService({ store, orchestrator, scanCandidates,
    revalidate: async (episode) => {
      const acct = account(episode); const sourceEpisode = source(episode);
      if (!acct || !sourceEpisode) return { admissible: false, reason: 'authority-row-missing' } as const;
      const verdict = await admissionFor(acct, sourceEpisode, episode);
      return verdict.admitted ? { admissible: true, inputDigest: verdict.inputDigest, mode: verdict.mode,
        profileId: verdict.profileId, loginMethod: profileContext(acct).browserAccount?.loginMethod ?? null } as const
        : { admissible: false, reason: verdict.reason } as const;
    },
    sourceIncidentOpen: (episode) => source(episode)?.closedAt === null,
    slowRetry: deps.slowRetry,
    onSuggested: deps.onSuggested, onTerminal: deps.onTerminal,
    onOperatorOnly: deps.onOperatorOnly, onPhoneTap: deps.onPhoneTap, onConditionCleared: deps.onConditionCleared,
    tickMs: deps.tickMs, now,
    // Verified healthy by the server: pool `active`, no identity drift (the poller reconciles the
    // credential's identity), and this process's latest poll was an authenticated read.
    deviceLimitHold: deps.deviceLimitHold ? (episode) => deps.deviceLimitHold!(episode.accountId) : undefined,
    cellHealthy: (episode) => cellVerifiedHealthy(episode.accountId, episode.machineId) });
  serviceRef = service;
  return { store, service, helper, lastResort: deps.lastResort ?? null, blockers, cellVerifiedHealthy,
    endForDeviceLimit: (accountId: string) => service.endForDeviceLimit(accountId, deps.machineId),
    start: () => {
      // Boot cleanup: a `relogin-*` helper left by a previous process can never finish.
      if (helper) {
        try { helper.killOrphans(); } catch { /* @silent-fallback-ok — recovery kills per episode too */ }
      }
      service.start();
    },
    stop: () => service.stop(),
    close: () => { service.stop(); store.close(); } };
}

/**
 * The production helper-session ports (spec skill-driven-signin-repair §4): one short-lived
 * HEADLESS session per episode (`relogin-<episodeId>`), pinned to the chosen helper account's
 * login for Claude or Codex, never topic-bound and never revived, with no project MCP servers
 * (a headless spawn can hang on interactive-auth MCP). A Codex helper runs with full access
 * (`codexAllowMcpTools`) so it can reach localhost and run GUI tools.
 */
export function buildReloginHelperSessionPorts(input: {
  sessionManager: Pick<import('./SessionManager.js').SessionManager,
    'spawnSession' | 'isSessionAlive' | 'killSessionByTmuxName' | 'listRunningSessions'>;
  maxSessions: number;
  serverPort: number;
  browserDriver?: ReloginHelperBrowserDriver;
  codexLoginStatus?: (codexHome: string) => Promise<CliLoginVerdict>;
}): NonNullable<SubscriptionReloginRuntimeDeps['helperSession']> {
  const { sessionManager } = input;
  return {
    spawn: async ({ name, prompt, seat, maxDurationMinutes }) => {
      const session = await sessionManager.spawnSession({
        name, prompt, framework: seat.framework, maxDurationMinutes,
        accountPin: { accountId: seat.accountId, configHome: seat.configHome },
        disableProjectMcp: true, triggeredBy: 'subscription-relogin-helper',
        ...(seat.framework === 'codex-cli' ? { codexAllowMcpTools: true } : {}),
      });
      return session.tmuxSession;
    },
    isAlive: (tmuxSession) => sessionManager.isSessionAlive(tmuxSession),
    kill: (tmuxSession) => { sessionManager.killSessionByTmuxName(tmuxSession); },
    listHelpers: () => sessionManager.listRunningSessions()
      .filter((session) => session.name.startsWith('relogin-'))
      .map((session) => ({ name: session.name, tmuxSession: session.tmuxSession })),
    hasCapacity: () => sessionManager.listRunningSessions().length < input.maxSessions,
    serverPort: input.serverPort,
    browserDriver: input.browserDriver ?? 'macos',
    ...(input.codexLoginStatus ? { codexLoginStatus: input.codexLoginStatus } : {}),
  };
}

/**
 * The route-context object the server hands to `/subscription-relogin/*` (the production
 * composition, shared with tests so the wiring cannot drift). `helperSubmit` exists only on the
 * agent-session path; without it the helper code route answers 503.
 */
export function subscriptionReloginRouteContext(runtime: SubscriptionReloginRuntime) {
  return {
    store: runtime.store,
    approve: (episodeId: string) => runtime.service.approve(episodeId),
    cancel: (episodeId: string) => runtime.service.cancel(episodeId),
    retry: (episodeId: string) => runtime.service.retry(episodeId),
    ...(runtime.helper ? {
      helperSubmit: (episodeId: string, token: string, body: unknown) => runtime.helper!.submit(episodeId, token, body),
      helperDriving: () => runtime.helper!.isAnyDriving(),
    } : {}),
    // Registry First: the last-resort model's live state (never the key), or available:false.
    lastResortStatus: (): ReloginLastResortStatus | { available: false } =>
      runtime.lastResort?.available() ? runtime.lastResort.status() : { available: false },
    blockers: () => runtime.blockers(),
    close: () => runtime.close(),
  };
}

/**
 * Whether a pending login is this repair's own leftover. Exact match on the recorded `createdAt`;
 * for a row from before that column existed (null), a login created inside the row's own run
 * (`startedAt ≤ createdAt ≤ finishedAt`) — no other login can be created for the account while the
 * repair's own one is pending.
 */
export function isOwnLeftoverLogin(loginCreatedAt: string,
  current?: { loginCreatedAt?: string | null; startedAt?: string | null; finishedAt?: string | null }): boolean {
  if (!current) return false;
  if (current.loginCreatedAt) return loginCreatedAt === current.loginCreatedAt;
  const created = Date.parse(loginCreatedAt);
  const started = Date.parse(current.startedAt ?? '');
  const finished = Date.parse(current.finishedAt ?? '');
  return Number.isFinite(created) && Number.isFinite(started) && Number.isFinite(finished) && created >= started && created <= finished;
}

/** Fewest single-use backup codes an unattended run may start with: a full run's drives plus one. */
export function unattendedBackupCodeFloor(maxAttempts?: number): number {
  return Math.max(1, Math.min(5, Math.floor(maxAttempts ?? 3))) + 1;
}
/** Count 8-digit Google backup codes in a vault value (same shape as {@link takeFirstBackupCode}). */
export function countBackupCodes(value: unknown): number {
  return typeof value === 'string' ? (value.match(/\b\d{4}\s?\d{4}\b/g) ?? []).length : 0;
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

/**
 * Whether the sign-in helper may answer Google's 2-Step Verification phone prompt with the
 * authenticator code (spec relogin-authenticator-over-phone-prompt): only for a password+totp
 * account whose authenticator vault entry is bound. Exported for tests.
 */
export function helperHasAuthenticator(loginMethod: string | undefined, secretRefs: { totp?: unknown }): boolean {
  return loginMethod === 'password+totp' && typeof secretRefs.totp === 'string' && secretRefs.totp.length > 0;
}

export type AuthenticatorOverPhoneMode = 'on' | 'shadow' | 'off';

/**
 * Resolve `assistedRelogin.authenticatorOverPhone`: an explicit value wins (`true` → on,
 * `'shadow'` → shadow, `false` → off); omitted ⇒ shadow on a development agent, off on the fleet.
 * Exported for tests.
 */
export function resolveAuthenticatorOverPhone(value: boolean | 'shadow' | undefined, config: { developmentAgent?: boolean } | undefined): AuthenticatorOverPhoneMode {
  if (value === true) return 'on';
  if (value === 'shadow') return 'shadow';
  if (value === false) return 'off';
  return resolveDevAgentGate(undefined, config) ? 'shadow' : 'off';
}

/** The resolved mode, applied only to an account that qualifies. Exported for tests. */
export function helperAuthenticatorMode(mode: AuthenticatorOverPhoneMode | undefined, loginMethod: string | undefined, secretRefs: { totp?: unknown }): AuthenticatorOverPhoneMode {
  if (!mode || mode === 'off' || !helperHasAuthenticator(loginMethod, secretRefs)) return 'off';
  return mode;
}

/** Take the first 8-digit Google backup code out of a vault entry and write the rest back. Never logs a value. */
export function takeFirstBackupCode(vault: { get(name: string): unknown; set(name: string, value: unknown): void }, name: string): string | null {
  const value = vault.get(name);
  if (typeof value !== 'string') return null;
  const codes = (value.match(/\b\d{4}\s?\d{4}\b/g) ?? []).map((c) => c.replace(/\s/g, ''));
  if (codes.length === 0) return null;
  const [first, ...rest] = codes;
  vault.set(name, rest.join(' '));
  return first;
}

/**
 * The permissions a repair may approve. An operator-configured list wins. Without one, the
 * allowance is exactly the scopes OUR OWN CLI requested in the sign-in link it printed — the
 * link comes from the `login` process this runtime started, so approving those scopes is the
 * sign-in the operator already runs by hand. A consent page asking for anything beyond them is
 * still a permission expansion and still stops the repair. (Before this, an unconfigured list
 * was empty, so every Claude repair outside a hand-configured machine refused at consent.)
 */
export function resolveAllowedScopes(configured: string[] | undefined, verificationUrl: string): string[] {
  if (configured && configured.length > 0) return configured;
  try {
    const scope = new URL(verificationUrl).searchParams.get('scope') ?? '';
    return scope.split(/[ ,+]+/).map((s) => s.trim()).filter((s) => /^[a-z][a-z0-9:._-]{0,79}$/i.test(s)).slice(0, 20);
  } catch {
    return []; // @silent-fallback-ok — an unparseable link allows nothing; consent then refuses.
  }
}
