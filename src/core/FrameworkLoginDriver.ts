/**
 * FrameworkLoginDriver — the concrete `LoginDriver` for the EnrollmentWizard
 * (P2.1 of the Subscription & Auth Standard). It is the "hands" that actually
 * obtain a PUBLIC login artifact (verification URL + optional device code + TTL)
 * from a framework's login flow, so the wizard can surface it to the operator's
 * phone.
 *
 * Design constraints (why the I/O is injected):
 *   - The SCRAPE logic — turning a pane's text into a `{ verificationUrl,
 *     userCode, ttlMs }` artifact — is PURE and must be unit-testable against
 *     real captured-output fixtures with no tmux, no spawning, no network.
 *   - The I/O — spawning the login command under the target account's
 *     `CLAUDE_CONFIG_DIR` and capturing the pane — is INJECTED (`spawn`,
 *     `capture`, `sleep`, `now`). Production wiring (server.ts) passes the real
 *     tmux primitives; tests pass fakes. This also keeps this module decoupled
 *     from SessionManager's spawn internals.
 *
 * SECURITY: this driver only ever reads the PUBLIC artifact a provider prints to
 * be typed into its own page — the verification URL and (for device-code flows)
 * the short user code. It NEVER reads, stores, or returns a token. The actual
 * credential is written by the framework's own login client into the account's
 * config home; instar never touches it.
 */

import type { LoginArtifact, LoginDriver } from './EnrollmentWizard.js';
import type { LoginFlowKind, LoginProvider } from './PendingLoginStore.js';

/** A login flow we know how to launch + scrape. */
export interface FrameworkLoginRequest {
  provider: LoginProvider;
  framework: 'claude-code' | 'codex-cli' | 'gemini-cli' | 'pi-cli';
  kind: LoginFlowKind;
  /** The account's CLAUDE_CONFIG_DIR — isolates this login to its own slot. */
  configHome?: string;
}

/** Injected I/O so the driver is decoupled + hermetically testable. */
export interface FrameworkLoginDriverDeps {
  /**
   * Spawn the framework's login command in a dedicated tmux pane under the
   * given configHome. Returns a session handle the capture fn reads from.
   */
  spawn: (req: FrameworkLoginRequest) => Promise<{ session: string }>;
  /** Capture the current text of a login pane. */
  capture: (session: string) => Promise<string>;
  /** Await ms (injected so tests don't really wait). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  /** How long to poll the pane for the artifact before giving up (default 60s). */
  scrapeTimeoutMs?: number;
  /** Poll cadence while waiting for the artifact to appear (default 1s). */
  pollIntervalMs?: number;
}

const URL_RE = /(https?:\/\/[^\s"'<>)\]]+)/i;
// Device codes are short, dash-grouped, uppercase-alnum: e.g. 7DAU-W4XJA, ABCD-1234.
const DEVICE_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/;
// "expires in 15 minutes", "valid for 10 min", "expires in 900 seconds".
const TTL_MIN_RE = /(?:expire[sd]?|valid)\b[^.\n]*?\b(\d{1,3})\s*(?:minutes?|mins?\b)/i;
const TTL_SEC_RE = /(?:expire[sd]?|valid)\b[^.\n]*?\b(\d{2,5})\s*(?:seconds?|secs?\b)/i;

export class FrameworkLoginDriver {
  private readonly deps: FrameworkLoginDriverDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };
  private readonly scrapeTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(deps: FrameworkLoginDriverDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? { log: () => {}, warn: () => {} };
    this.scrapeTimeoutMs = deps.scrapeTimeoutMs ?? 60_000;
    this.pollIntervalMs = deps.pollIntervalMs ?? 1_000;
  }

  /**
   * Parse a PUBLIC login artifact out of captured pane text. Pure — no I/O.
   * Returns null until the pane has emitted at least a verification URL (for
   * device-code flows, also a user code). Exported via the static for tests.
   */
  static parseArtifact(paneText: string, kind: LoginFlowKind): LoginArtifact | null {
    if (!paneText) return null;
    const urlMatch = paneText.match(URL_RE);
    if (!urlMatch) return null;
    const verificationUrl = stripTrailingPunctuation(urlMatch[1]);

    let userCode: string | undefined;
    if (kind === 'device-code') {
      const codeMatch = paneText.match(DEVICE_CODE_RE);
      if (!codeMatch) return null; // device-code flow isn't ready until the code prints
      userCode = codeMatch[1];
    }

    const ttlMs = parseTtlMs(paneText);
    return { verificationUrl, userCode, ttlMs };
  }

  /**
   * Drive a framework login: spawn it under the target config home, poll the
   * pane until the public artifact appears (or timeout), and return it. Throws
   * on timeout so the wizard logs + leaves the login for the next sweep.
   */
  async drive(req: {
    provider: LoginProvider;
    framework: FrameworkLoginRequest['framework'];
    kind: LoginFlowKind;
    configHome?: string;
  }): Promise<LoginArtifact> {
    const { session } = await this.deps.spawn({
      provider: req.provider,
      framework: req.framework,
      kind: req.kind,
      configHome: req.configHome,
    });
    const deadline = this.now() + this.scrapeTimeoutMs;
    let lastText = '';
    while (this.now() < deadline) {
      lastText = await this.deps.capture(session);
      const artifact = FrameworkLoginDriver.parseArtifact(lastText, req.kind);
      if (artifact) {
        this.logger.log(
          `[FrameworkLoginDriver] captured ${req.kind} artifact for ${req.provider}/${req.framework}`,
        );
        return artifact;
      }
      await this.sleep(this.pollIntervalMs);
    }
    this.logger.warn(
      `[FrameworkLoginDriver] timed out scraping ${req.kind} login for ${req.provider}/${req.framework}`,
    );
    throw new Error(
      `login artifact not found for ${req.provider}/${req.framework} within ${this.scrapeTimeoutMs}ms`,
    );
  }

  /** Adapt to the EnrollmentWizard's LoginDriver signature. */
  asLoginDriver(): LoginDriver {
    return (req) => this.drive(req);
  }
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:'")\]]+$/, '');
}

function parseTtlMs(text: string): number | undefined {
  const min = text.match(TTL_MIN_RE);
  if (min) return Number(min[1]) * 60_000;
  const sec = text.match(TTL_SEC_RE);
  if (sec) return Number(sec[1]) * 1_000;
  return undefined;
}
