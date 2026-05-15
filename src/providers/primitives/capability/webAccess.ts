/**
 * WebAccess — agent's ability to fetch URLs and search the web.
 *
 * Maps to:
 *   - Claude: built-in `WebFetch` and `WebSearch` tools
 *   - Codex: `web_search` (on by default, cached), toggleable via
 *     `permissions.<name>.network`
 *
 * Composes with PathAllowlist's network analog (currently inline here, not a
 * separate primitive — if it grows, factor out). Allows domain allow/deny
 * lists and a toggle for whether the agent may search vs. only fetch known URLs.
 */

import { CapabilityFlag } from '../../capabilities.js';

export interface WebAccess {
  readonly capability: typeof CapabilityFlag.WebAccess;

  /** Build a portable web-access spec for session establishment. */
  buildSpec(rules: WebAccessRules): WebAccessSpec;

  /** Whether this provider supports web search (vs. only direct fetch). */
  supportsSearch(): boolean;
}

export interface WebAccessRules {
  /** Whether the session may fetch arbitrary URLs. Default true. */
  allowFetch?: boolean;
  /** Whether the session may search the web. Default true. */
  allowSearch?: boolean;
  /**
   * If non-empty, fetches are restricted to these domains (and subdomains).
   * Search results are filtered to these domains where the provider supports it.
   */
  domainAllow?: ReadonlyArray<string>;
  /** Domains always denied. Deny wins on conflict. */
  domainDeny?: ReadonlyArray<string>;
  /**
   * Whether the provider's prompt-injection protections are required.
   * Anthropic's WebFetch warns the model about untrusted content; Codex's
   * web_search does similar. Default true; set false only for trusted
   * fetches like internal documentation.
   */
  promptInjectionProtection?: boolean;
}

export type WebAccessSpec = Readonly<{
  readonly __brand: 'WebAccessSpec';
  readonly rules: WebAccessRules;
}>;
