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
}

export class EnrollmentWizard {
  private readonly store: PendingLoginStore;
  private readonly driveLogin: LoginDriver;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };

  constructor(cfg: EnrollmentWizardConfig) {
    this.store = cfg.store;
    this.driveLogin = cfg.driveLogin;
    this.logger = cfg.logger ?? { log: () => {}, warn: () => {} };
  }

  /** Default flow kind per provider: Codex/OpenAI = device-code (its endorsed
   *  flow); everyone else = url-code-paste (the phone-friendly Claude path). */
  static defaultKind(provider: LoginProvider): LoginFlowKind {
    return provider === 'openai' ? 'device-code' : 'url-code-paste';
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

  /** Mark a login completed once the operator approved + the account enrolled. */
  complete(id: string): PendingLogin | null {
    return this.store.complete(id);
  }

  /** The phone surface: still-valid logins awaiting approval. */
  pending(): PendingLogin[] {
    return this.store.active();
  }
}
