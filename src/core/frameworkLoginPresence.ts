/**
 * frameworkLoginPresence — does an off-default framework have a usable sign-in
 * on this machine? (CMT-2289)
 *
 * The provider-fallback default policy (internalFrameworkDefault.ts) routes the
 * internal `gate` category to the FASTEST "active" off-Claude framework
 * (pi → gemini → codex → claude). "Active" used to mean only that the
 * framework's provider BUILT — for gemini-cli that is "the binary is on PATH".
 * On an agent with the gemini binary installed but no Gemini sign-in, every
 * PromptGate / UnjustifiedStopGate call was routed to gemini-cli and failed
 * (fleet reports: 100% errors, e.g. Bob 51/51 on gemini-cli with no Gemini
 * account). This module adds the missing condition: a framework with no
 * usable sign-in is not active for automatic internal routing, so the policy
 * falls through to the next framework (and finally the agent default).
 *
 * Scope is deliberately narrow and deny-safe for the one framework whose
 * sign-in is a local file the CLI itself reads:
 *  - gemini-cli: cached OAuth creds at ~/.gemini/oauth_creds.json with a
 *    non-empty access_token or refresh_token (the shape crossModelReviewer's
 *    detection already uses). API keys are not a sign-in here — paid keys stay
 *    inside the separate gemini-api door.
 *  - every other framework: true (codex-cli resolves its account through the
 *    subscription pool per call; pi-cli already degrades to null without a
 *    configured model; claude-code is the default framework).
 *
 * Pure apart from the one file read; never throws.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IntelligenceFramework } from './intelligenceProviderFactory.js';
import { GEMINI_CLI_FRAMEWORK } from './frameworkFacts.js';

/**
 * The gemini CLI reads creds at `~/.gemini/oauth_creds.json` unconditionally
 * (verified v0.25.2 — there is no GEMINI_HOME), so detection probes exactly
 * that path. Tests inject their own path.
 */
export function defaultGeminiOauthCredsPath(): string {
  return path.join(os.homedir(), '.gemini', 'oauth_creds.json');
}

/**
 * Authed iff the creds file parses as JSON with a non-empty string
 * `access_token` OR `refresh_token` (the CLI refreshes an expired access token
 * from the refresh token). Missing / unreadable / malformed → false. Never throws.
 */
export function geminiOauthCredsAuthed(credsPath: string = defaultGeminiOauthCredsPath()): boolean {
  try {
    const raw = fs.readFileSync(credsPath, 'utf-8');
    const parsed = JSON.parse(raw) as { access_token?: unknown; refresh_token?: unknown };
    const nonEmptyString = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
    return nonEmptyString(parsed?.access_token) || nonEmptyString(parsed?.refresh_token);
  } catch {
    // @silent-fallback-ok — deny-safe: missing/unreadable/malformed creds mean "not signed in".
    return false;
  }
}

export interface FrameworkLoginPresenceDeps {
  /** Injected for tests; defaults to the real gemini creds probe. */
  geminiAuthed?: () => boolean;
}

/**
 * True when `fw` has a usable sign-in for automatic internal routing on this
 * machine. Only gemini-cli is probed (see module doc); all others return true.
 */
export function hasUsableInternalLogin(
  fw: IntelligenceFramework,
  deps: FrameworkLoginPresenceDeps = {},
): boolean {
  try {
    if (fw === GEMINI_CLI_FRAMEWORK) return (deps.geminiAuthed ?? (() => geminiOauthCredsAuthed()))();
    return true;
  } catch {
    // @silent-fallback-ok — deny-safe for the probed framework: an error means "not signed in".
    return fw !== GEMINI_CLI_FRAMEWORK;
  }
}
