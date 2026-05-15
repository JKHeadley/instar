/**
 * TrustedProjectGate — gate provider-config loading on explicit project trust.
 *
 * OPTIONAL primitive — Codex-native. Prevents malicious project config
 * files from being loaded automatically: `.codex/config.toml` is only
 * loaded if the user has explicitly marked the project as trusted.
 *
 * STRATEGIC: Claude does NOT have this. A malicious CLAUDE.md in a freshly
 * cloned repo can silently exfiltrate, prompt-inject, or worse. Instar
 * should adopt this primitive in its abstraction even when running against
 * Claude — the abstraction can enforce the gate on top of Claude's
 * unprotected loading.
 *
 * Maps to:
 *   - Codex: trust prompt on first encounter; persisted in user config
 *   - Claude: capability false at the provider level; Instar's abstraction
 *     adds a wrapping gate before invoking Claude on a new project
 */

import type { CancellationOptions } from '../../types.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface TrustedProjectGate {
  readonly capability: typeof CapabilityFlag.TrustedProjectGate;

  /** Check whether a project is currently trusted. */
  isTrusted(
    projectRoot: string,
    options?: CancellationOptions,
  ): Promise<boolean>;

  /** Mark a project as trusted. */
  trust(
    projectRoot: string,
    options?: TrustOptions,
  ): Promise<void>;

  /** Revoke trust from a project. */
  revoke(
    projectRoot: string,
    options?: CancellationOptions,
  ): Promise<void>;

  /** List trusted projects. */
  listTrusted(options?: CancellationOptions): Promise<ReadonlyArray<TrustedProjectEntry>>;
}

export interface TrustOptions extends CancellationOptions {
  /** Optional reason/note recorded with the trust. */
  reason?: string;
  /** Expire trust after this many days. Default: no expiry. */
  expireAfterDays?: number;
}

export interface TrustedProjectEntry {
  projectRoot: string;
  trustedAt: string;
  expiresAt?: string;
  reason?: string;
}
