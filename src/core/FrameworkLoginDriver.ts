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

/**
 * The tmux session name an enrollment login pane runs under. SINGLE SOURCE OF TRUTH —
 * both the spawn (server.ts) and any consumer that needs to reach the live pane
 * (e.g. WS5.2 code paste-back submit-code in routes.ts) MUST derive the name through
 * this helper, so the two can never drift apart or collide differently. The slug is
 * the configHome (the per-credential slot, unique by construction) normalized + tail-
 * clamped; framework is included so two providers in the same slot can't collide.
 * (ws52-code-paste-back — codex cross-model review finding #1.)
 */
export function enrollPaneSessionName(framework: string, configHome?: string): string {
  const slug = (configHome ?? framework).replace(/[^a-zA-Z0-9]+/g, '-').slice(-24);
  return `instar-enroll-${framework}-${slug}`;
}

/** A login flow we know how to launch + scrape. */
export interface FrameworkLoginRequest {
  provider: LoginProvider;
  framework: 'claude-code' | 'codex-cli' | 'gemini-cli' | 'pi-cli';
  kind: LoginFlowKind;
  /** The account's CLAUDE_CONFIG_DIR — isolates this login to its own slot. */
  configHome?: string;
  /** False for background renewal; production must suppress browser launch. */
  openBrowser?: boolean;
}

/** Environment prefix used by login commands when no operator initiated this drive.
 * Claude Code honors BROWSER as its opener; `true` accepts the open request without
 * launching an application while the CLI still prints the URL for capture. */
export function enrollmentBrowserEnv(openBrowser: boolean | undefined): Record<string, string> {
  return openBrowser === false ? { BROWSER: 'true' } : {};
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
    // A long verification URL HARD-WRAPS across tmux pane lines with no inserted
    // space (e.g. "...authorize?code=t\nrue&client_id=...\nri=https%3A..."). A naive
    // single-line URL_RE truncates at the first wrap (the 2026-06-18 "code=t" bug:
    // the real URL was "...?code=true&client_id=..."). De-wrap first so the FULL URL
    // is matched. (The capture is ALSO switched to `tmux capture-pane -J`; this is the
    // pure, unit-tested defense so a wrapped capture still parses correctly.)
    const dewrapped = dewrapWrappedUrls(paneText);
    const urlMatch = dewrapped.match(URL_RE);
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
   *
   * `scrapeTimeoutMs` (per-call) overrides the constructor default for THIS
   * drive only — WS5.2 R6b uses it to give a remote/cloud enrollment a larger
   * budget (cloud→provider latency + the two-code Claude window) without
   * rebuilding the shared production driver. Omitted ⇒ the constructor default
   * (the local-LAN budget) is unchanged. A non-finite/≤0 value is ignored.
   */
  async drive(req: {
    provider: LoginProvider;
    framework: FrameworkLoginRequest['framework'];
    kind: LoginFlowKind;
    configHome?: string;
    scrapeTimeoutMs?: number;
    openBrowser?: boolean;
  }): Promise<LoginArtifact> {
    const { session } = await this.deps.spawn({
      provider: req.provider,
      framework: req.framework,
      kind: req.kind,
      configHome: req.configHome,
      openBrowser: req.openBrowser,
    });
    const budgetMs =
      typeof req.scrapeTimeoutMs === 'number' && Number.isFinite(req.scrapeTimeoutMs) && req.scrapeTimeoutMs > 0
        ? req.scrapeTimeoutMs
        : this.scrapeTimeoutMs;
    const deadline = this.now() + budgetMs;
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
      `[FrameworkLoginDriver] timed out scraping ${req.kind} login for ${req.provider}/${req.framework} (budget ${budgetMs}ms)`,
    );
    throw new Error(
      `login artifact not found for ${req.provider}/${req.framework} within ${budgetMs}ms`,
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

/**
 * Re-join a verification URL that a terminal HARD-WRAPPED across pane lines. tmux
 * wraps a long line at the pane width by inserting a newline with NO space — so a
 * URL becomes "...?code=t\nrue&client_id=...\nri=...". We reassemble it: find the
 * line bearing the first http(s) URL, then append each following line that is a pure
 * URL-continuation fragment (non-empty and containing NO whitespace), stopping at the
 * first blank line or a line with internal whitespace (real output, e.g. a prompt).
 * Only that one URL region is joined; the rest of the text is left untouched so the
 * code/TTL parses stay line-accurate. Idempotent on already-unwrapped text.
 */
function dewrapWrappedUrls(text: string): string {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => /https?:\/\//i.test(l));
  if (i === -1) return text;
  let joined = lines[i].replace(/\s+$/, '');
  let j = i + 1;
  for (; j < lines.length; j++) {
    const ln = lines[j];
    if (ln.trim() === '') break;          // blank line ends the URL
    if (/\s/.test(ln.trim())) break;       // internal whitespace ⇒ real output, not a wrap fragment
    joined += ln.replace(/\s+$/, '');
  }
  // Rebuild: lines before the URL, the rejoined URL line, then the remaining lines.
  return [...lines.slice(0, i), joined, ...lines.slice(j)].join('\n');
}

function parseTtlMs(text: string): number | undefined {
  const min = text.match(TTL_MIN_RE);
  if (min) return Number(min[1]) * 60_000;
  const sec = text.match(TTL_SEC_RE);
  if (sec) return Number(sec[1]) * 1_000;
  return undefined;
}
