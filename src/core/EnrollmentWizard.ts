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
}) => Promise<LoginArtifact>;

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
    const kind = input.kind ?? EnrollmentWizard.defaultKind(input.provider);
    const artifact = await this.driveLogin({
      provider: input.provider,
      framework: input.framework,
      kind,
      configHome: input.configHome,
    });
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
    | { outcome: 'held'; login: PendingLogin; reason: string }
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
    return { outcome: 'held', login, reason: verdict.reason };
  }

  /** The phone surface: still-valid logins awaiting approval. */
  pending(): PendingLogin[] {
    return this.store.active();
  }
}
