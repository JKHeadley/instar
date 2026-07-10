/**
 * EnrollmentWizard — mobile-first login orchestration (P2.1 of the Subscription
 * & Auth Standard). Sits on top of PendingLoginStore and turns a raw framework
 * login into a phone-friendly, expiry-resilient flow.
 *
 * The job (from the spec + the pi live-test specimen):
 *   - START a login: drive the framework's login flow, capture the PUBLIC
 *     device-code / auth URL, and store it with its TTL visible. (Codex →
 *     device-code; Claude → URL+paste-back-code.)
 *   - On EXPIRY: auto-reissue a fresh code/URL WITHOUT the operator asking — the
 *     exact gap the pi live-test exposed (the first code expired before Justin
 *     got to it and re-issuing took a manual round-trip).
 *   - COMPLETE when the operator approves at the provider + the account enrols.
 *
 * The interactive part — actually driving the framework's login CLI to obtain a
 * code/URL — is INJECTED (`driveLogin`), so this orchestrator is pure +
 * hermetically testable (no spawning, no network, no real OAuth). In production
 * the driver runs the framework's device-code/login flow and scrapes the code +
 * URL + TTL; here tests pass a stub. NEVER handles a credential — only the
 * public code/URL the operator types into the provider's own page.
 */

import {
  PendingLoginStore,
  type PendingLogin,
  type LoginFlowKind,
  type LoginProvider,
} from './PendingLoginStore.js';
import {
  ensureInteractiveReady,
  type EnsureInteractiveReadyResult,
} from './ensureInteractiveReady.js';
import type { IdentityOracle } from './CredentialLocationLedger.js';
import { validateEnrolledAccountEmail } from './AccountFollowMeEmailGate.js';

/** The public artifact a framework login yields (no secret). */
export interface LoginArtifact {
  verificationUrl: string;
  userCode?: string;
  ttlMs?: number;
}

/** Injected: drive the framework's login flow, return its public code/URL. */
export type LoginDriver = (req: {
  provider: LoginProvider;
  framework: PendingLogin['framework'];
  kind: LoginFlowKind;
  /** The new account's CLAUDE_CONFIG_DIR — isolates this login to its own slot
   *  so enrolling a 2nd account never clobbers the 1st. */
  configHome?: string;
  /** WS5.2 R6b — per-call scrape-timeout budget (ms). The follow-me/remote path
   *  passes a larger value (cloud→provider latency + the two-code Claude window);
   *  omitted ⇒ the driver's own default (the local-LAN budget). */
  scrapeTimeoutMs?: number;
}) => Promise<LoginArtifact>;

/**
 * WS5.2 R6b — the honest-failure surface for a DRIVE failure during `start()`.
 * Thrown (NOT swallowed) when `driveLogin` fails, so a remote/cloud enrollment
 * surfaces an operator-facing "couldn't start the login on <nickname> — retry?"
 * instead of either an opaque 500 OR a silently-stuck pending-login. The key
 * invariant it guarantees: a drive failure NEVER leaves a pending-login issued
 * with no artifact (the store is only written AFTER the drive succeeds), so the
 * caller can render this as a retry-able failure with no dangling state.
 */
export class EnrollmentDriveError extends Error {
  readonly code = 'enrollment-drive-failed' as const;
  /** A short, operator-facing message (machine nickname interpolated by the caller). */
  readonly operatorMessage: string;
  /** The underlying driver error, for logs/audit (never shown to the operator raw). */
  readonly cause?: unknown;
  constructor(opts: { operatorMessage: string; cause?: unknown }) {
    super(opts.operatorMessage);
    this.name = 'EnrollmentDriveError';
    this.operatorMessage = opts.operatorMessage;
    this.cause = opts.cause;
  }
}

export interface EnrollmentWizardConfig {
  store: PendingLoginStore;
  driveLogin: LoginDriver;
  now?: () => number;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  /**
   * Onboarding-readiness seeder run when a claude-code enrollment completes
   * (2026-06-09 incident: `claude auth login` is headless-only — it stores
   * tokens but never sets the interactive first-launch flags, so the new
   * home wedges the first interactive session pinned/swapped onto it).
   * Injectable for hermetic tests; production uses the real util.
   */
  ensureReady?: (configHome: string) => EnsureInteractiveReadyResult;
  /**
   * WS5.2 §5.3/S7 — identity oracle used by `completeFollowMe` to read the freshly-minted
   * login's account email from its config-home slot, for validation against operator
   * expectation. Absent ⇒ the follow-me gate fails CLOSED (the account is HELD, never
   * auto-selected). The plain `complete()` path never touches it.
   */
  oracle?: IdentityOracle;
  /**
   * WS5.2 §5.3/S7 — emit a HIGH attention item when a follow-me completion is HELD
   * (surprise/mismatched/unverifiable email). Best-effort; absence does not change the
   * fail-closed verdict (the account is still NOT selected), only whether the operator
   * is paged.
   */
  emitAttention?: (item: { id: string; title: string; body: string; priority: 'high'; source: 'agent' }) => void;
}

export interface StartEnrollmentInput {
  id: string;
  label: string;
  provider: LoginProvider;
  framework: PendingLogin['framework'];
  /** device-code (Codex) or url-code-paste (Claude). Defaults per provider. */
  kind?: LoginFlowKind;
  /** The new account's CLAUDE_CONFIG_DIR — isolates the login to its own slot. */
  configHome?: string;
  /** WS5.2 §5.3/S7 — the operator-expected account email (follow-me path only). Carried
   *  onto the pending login so `completeFollowMe` can validate the minted account. */
  expectedEmail?: string;
  /**
   * WS5.2 R6b — this is a remote/cloud (follow-me) enrollment, not a local-LAN one.
   * When set: (a) the per-provider flow-kind selection prefers the device-code
   *   single-code flow where the provider supports it (Phase-C default — sidesteps
   *   the two-code Claude problem entirely), and (b) `remoteScrapeTimeoutMs` (if
   *   provided) is threaded to the driver as a larger scrape budget. Defaulted-off,
   *   so normal local enrollment is byte-for-byte unchanged.
   */
  remote?: boolean;
  /** WS5.2 R6b — larger scrape-timeout budget (ms) used only when `remote` is true.
   *  Omitted ⇒ the driver's own default (the local-LAN budget). */
  remoteScrapeTimeoutMs?: number;
}

export class EnrollmentWizard {
  private readonly store: PendingLoginStore;
  private readonly driveLogin: LoginDriver;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };
  private readonly ensureReady: (configHome: string) => EnsureInteractiveReadyResult;
  private readonly oracle?: IdentityOracle;
  private readonly emitAttention?: (item: { id: string; title: string; body: string; priority: 'high'; source: 'agent' }) => void;

  constructor(cfg: EnrollmentWizardConfig) {
    this.store = cfg.store;
    this.driveLogin = cfg.driveLogin;
    this.logger = cfg.logger ?? { log: () => {}, warn: () => {} };
    this.ensureReady = cfg.ensureReady ?? ensureInteractiveReady;
    this.oracle = cfg.oracle;
    this.emitAttention = cfg.emitAttention;
  }

  /** Default flow kind per provider: Codex/OpenAI = device-code (its endorsed
   *  flow); everyone else = url-code-paste (the phone-friendly Claude path). */
  static defaultKind(provider: LoginProvider): LoginFlowKind {
    return provider === 'openai' ? 'device-code' : 'url-code-paste';
  }

  /**
   * WS5.2 R6b — flow kind for a REMOTE/cloud (follow-me) enrollment. Prefers the
   * device-code single-code flow wherever the provider supports it (the Phase-C
   * default per R6b), because a single code sidesteps the two-code Claude window
   * entirely on a headless VM. Providers that have a device-code endpoint
   * (OpenAI/Codex) get `device-code`; a provider with no single-code flow
   * (Anthropic/Claude → url-code-paste) keeps its two-code flow, and the caller
   * MUST give it the larger scrape budget so the full two-code interaction fits
   * inside one poll window (the URL appears late on cloud→provider latency). This
   * is a SUPERSET of defaultKind — anything device-code-capable locally is also
   * device-code-capable remotely. */
  static remoteKind(provider: LoginProvider): LoginFlowKind {
    return provider === 'openai' ? 'device-code' : EnrollmentWizard.defaultKind(provider);
  }

  /**
   * Operator-facing heads-up about a flow's quirks, surfaced on the pending login.
   * The url-code-paste (Claude) flow on a brand-new account slot frequently issues
   * TWO codes in sequence: Anthropic first emails an email-VERIFICATION code, then
   * (after that's accepted) the page shows the sign-in code to paste back. Enrolling
   * is always a new slot, so the operator should expect — and not be confused by —
   * the two-step sequence (this confusion was flagged in live testing, topic 20905).
   * device-code (Codex) is a single code, so no notice. Returns undefined when there
   * is nothing to warn about.
   */
  static flowNotice(kind: LoginFlowKind): string | undefined {
    if (kind === 'url-code-paste') {
      return (
        'Heads up: a brand-new Claude login often asks for TWO codes in order — ' +
        'first an email-verification code Anthropic sends you, then the sign-in code ' +
        'shown after that. Enter the email code first; the sign-in code comes next.'
      );
    }
    return undefined;
  }

  /**
   * Start an enrollment: drive the login, capture the public code/URL, store it
   * as a pending login (TTL visible). Returns the stored PendingLogin — the
   * surface the operator's phone shows.
   */
  async start(input: StartEnrollmentInput): Promise<PendingLogin> {
    // WS5.2 R6b — a remote/cloud (follow-me) enrollment prefers the device-code
    // single-code flow where the provider supports it; an explicit `kind` always
    // wins. Local enrollment is unchanged (uses defaultKind).
    const kind =
      input.kind ??
      (input.remote ? EnrollmentWizard.remoteKind(input.provider) : EnrollmentWizard.defaultKind(input.provider));
    // WS5.2 R6b — the honest-failure surface. The store is written ONLY AFTER the
    // drive succeeds, so a drive throw leaves NO pending-login behind; we re-raise
    // it as a typed EnrollmentDriveError the caller renders as "couldn't start the
    // login on <nickname> — retry?", never an opaque 500 / silently-stuck pending.
    let artifact: LoginArtifact;
    try {
      artifact = await this.driveLogin({
        provider: input.provider,
        framework: input.framework,
        kind,
        configHome: input.configHome,
        // Threaded only for remote drives; omitted ⇒ the driver's local-LAN default.
        ...(input.remote && typeof input.remoteScrapeTimeoutMs === 'number'
          ? { scrapeTimeoutMs: input.remoteScrapeTimeoutMs }
          : {}),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[EnrollmentWizard] start drive failed for ${input.label} (${input.provider}): ${detail}`);
      throw new EnrollmentDriveError({
        operatorMessage: 'the provider login didn’t start in time — retry?',
        cause: err,
      });
    }
    const login = this.store.issue({
      id: input.id,
      label: input.label,
      provider: input.provider,
      framework: input.framework,
      kind,
      configHome: input.configHome,
      verificationUrl: artifact.verificationUrl,
      userCode: artifact.userCode,
      notice: EnrollmentWizard.flowNotice(kind),
      expectedEmail: input.expectedEmail,
      ttlMs: artifact.ttlMs,
    });
    this.logger.log(`[EnrollmentWizard] started ${kind} login for ${input.label} (${input.provider})`);
    return login;
  }

  /**
   * Auto-reissue every EXPIRED pending login without the operator asking — the
   * pi-live-test gap. For each expired login, re-drive the framework flow and
   * refresh the stored code/URL + TTL. Returns the reissued logins. Driver
   * failures are skipped (logged, left expired) so one bad re-drive doesn't
   * abort the sweep.
   */
  async reissueExpired(): Promise<PendingLogin[]> {
    const reissued: PendingLogin[] = [];
    for (const login of this.store.expired()) {
      try {
        const fresh = await this.driveLogin({
          provider: login.provider,
          framework: login.framework,
          kind: login.kind,
          configHome: login.configHome,
        });
        const updated = this.store.reissue(login.id, {
          verificationUrl: fresh.verificationUrl,
          userCode: fresh.userCode,
          ttlMs: fresh.ttlMs,
        });
        if (updated) {
          reissued.push(updated);
          this.logger.log(`[EnrollmentWizard] auto-reissued expired login ${login.id} (reissue #${updated.reissueCount})`);
        }
      } catch (err) {
        // @silent-fallback-ok: one re-drive failing must not abort the sweep;
        // the login stays expired and is retried next sweep.
        this.logger.warn(`[EnrollmentWizard] reissue of ${login.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return reissued;
  }

  /**
   * Mark a login completed once the operator approved + the account enrolled.
   * For a claude-code enrollment with a per-account config home, also seed the
   * interactive onboarding flags — the login itself was headless, so without
   * this the freshly-enrolled home wedges the first interactive session that
   * pins/swaps onto it (2026-06-09 incident). Fail-safe: a seeding failure is
   * logged, never blocks completion (the launch paths re-ensure defensively).
   */
  complete(id: string): PendingLogin | null {
    const login = this.store.complete(id);
    if (login && login.framework === 'claude-code' && login.configHome) {
      const ready = this.ensureReady(login.configHome);
      if (ready.patched) {
        this.logger.log(`[EnrollmentWizard] made ${login.configHome} interactive-ready (${ready.reason})`);
      } else if (ready.reason !== 'already interactive-ready') {
        this.logger.warn(`[EnrollmentWizard] could not verify ${login.configHome} interactive-ready — ${ready.reason}`);
      }
    }
    return login;
  }

  /**
   * WS5.2 §5.3 step 3 / S7 — the FOLLOW-ME completion path. Completes the pending login
   * (reusing the sync `complete()` so claude-code interactive-readiness still runs), then
   * validates the freshly-minted account's email against the operator's expectation BEFORE
   * the account is allowed to become selectable. Only a verified match returns 'validated'
   * (the caller — the route — then adds it to the SubscriptionPool); everything else FAILS
   * CLOSED to 'held' (a HIGH attention item is emitted, the account is NOT added to the pool).
   *
   * Fail-closed by construction: a missing oracle, an unreadable/missing config-home, an
   * unavailable identity probe, or a missing operator-expected email all resolve to 'held'
   * — an account is NEVER auto-selected unless its email provably matches what the operator
   * approved (this is the FOLLOW-ME path, so the email gate ALWAYS runs).
   */
  async completeFollowMe(
    id: string,
    targetMachineNickname: string,
  ): Promise<
    | { outcome: 'validated'; login: PendingLogin; email: string }
    // `expected`/`got` are the gate verdict's account emails (operator-approved vs the
    // account the sign-in ACTUALLY authenticated as) — surfaced so the dashboard can name
    // BOTH accounts in plain language instead of a bare reason code (wrong-account hazard,
    // topic 29836 case study D3). Never secrets: both are operator-visible account emails.
    | { outcome: 'held'; login: PendingLogin; reason: string; expected: string | null; got: string | null }
    | { outcome: 'not-found' }
  > {
    const login = this.complete(id);
    if (!login) return { outcome: 'not-found' };

    // Read the email the COMPLETED login actually authenticated as. No oracle / no config-home
    // / a probe failure are all treated as "unavailable" → the gate fails closed below.
    let completedEmail: string | null = null;
    if (this.oracle) {
      let probe;
      try {
        probe = await this.oracle.resolveSlotTenant(login.configHome ?? '');
      } catch (err) {
        probe = { unavailable: true, reason: `oracle threw: ${err instanceof Error ? err.message : String(err)}` };
      }
      completedEmail = 'email' in probe && probe.email ? probe.email : null;
    }

    // The follow-me gate ALWAYS runs (this IS the follow-me path); a missing expectedEmail
    // is caller misuse and the gate fails it closed with reason 'missing-expected-email'.
    const verdict = validateEnrolledAccountEmail({
      completedEmail,
      expectedEmail: login.expectedEmail,
      accountId: login.id,
      targetMachineNickname,
    });

    if (verdict.selectable) {
      this.logger.log(`[EnrollmentWizard] follow-me completion ${login.id} validated as ${verdict.email}`);
      return { outcome: 'validated', login, email: verdict.email };
    }

    this.emitAttention?.(verdict.attentionItem);
    this.logger.warn(`[EnrollmentWizard] follow-me completion ${login.id} HELD (${verdict.reason}) — account NOT selected`);
    return { outcome: 'held', login, reason: verdict.reason, expected: verdict.expected, got: verdict.got };
  }

  /** The phone surface: still-valid logins awaiting approval. */
  pending(): PendingLogin[] {
    return this.store.active();
  }

  /**
   * D5 (topic 29836) — the already-authorized short-circuit. A follow-me sign-in can
   * complete WITHOUT ever showing a paste-back code: the provider short-circuits an
   * already-authorized browser session ("You're all set up… you can close this window"),
   * so nothing calls submit-code and the pending login would sit at "signing in" until
   * TTL expiry even though the credential already landed in its config-home slot. This
   * sweep detects the landed credential and drives the SAME identity-verified completion
   * path (`completeFollowMe` — the S7 email gate ALWAYS runs; a mismatch/unverifiable
   * account is HELD, never auto-enrolled). Follow-me logins only (expectedEmail set):
   * a plain enrollment's completion stays the explicit /enroll/:id/complete call.
   */
  async sweepFollowMeCompletions(deps: {
    /** Does this login's config-home hold a landed credential? (fs probe injected by the caller) */
    credentialReady: (login: PendingLogin) => boolean;
    /** Called on a VALIDATED completion so the caller adds the account to its pool. */
    onValidated: (login: PendingLogin, email: string) => void;
    targetMachineNickname?: string;
  }): Promise<Array<{ id: string; outcome: 'validated' | 'held' }>> {
    const results: Array<{ id: string; outcome: 'validated' | 'held' }> = [];
    for (const login of this.store.active()) {
      if (!login.expectedEmail || !login.configHome) continue;
      let ready = false;
      try { ready = deps.credentialReady(login); } catch { ready = false; }
      if (!ready) continue;
      const result = await this.completeFollowMe(login.id, deps.targetMachineNickname ?? 'this machine');
      if (result.outcome === 'validated') {
        try { deps.onValidated(result.login, result.email); } catch (err) {
          this.logger.warn(`[EnrollmentWizard] completion-sweep pool-add failed for ${login.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
        results.push({ id: login.id, outcome: 'validated' });
      } else if (result.outcome === 'held') {
        results.push({ id: login.id, outcome: 'held' });
      }
    }
    return results;
  }

  /** Look up a single login by id INCLUDING terminal/expired records (unlike
   *  pending(), which returns only live-pending). The operator-cancel route uses
   *  this so an expired login is still found — and its pane torn down — not 404'd. */
  getById(id: string): PendingLogin | null {
    return this.store.get(id);
  }

  /** Operator-cancel: abandon a pending/expired login. Delegates to the store's
   *  terminal-guarded transition, so a login that COMPLETED a moment earlier is
   *  never clobbered back to abandoned. */
  abandon(id: string): PendingLogin | null {
    return this.store.abandon(id);
  }
}
