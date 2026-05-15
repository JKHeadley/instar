/**
 * ProviderScaffolder — install per-provider configuration at agent init time.
 *
 * Different providers expect different files in different places:
 *   - Claude: `.claude/settings.json`, `.claude/scripts/`, `.claude/skills/`,
 *     CLAUDE.md in project root, hook script registrations
 *   - Codex: `~/.codex/hooks.json` or `config.toml`, `.codex/agents/*.toml`,
 *     `.codex/skills/<name>/SKILL.md`, AGENTS.md in project root
 *
 * The Instar provider-abstraction project standardizes on `.agent/<provider>/`
 * for per-provider scaffolding (instead of `.claude/` directly). This
 * primitive performs the install during agent initialization and during
 * provider-switching migrations.
 *
 * Used by:
 *   - commands/init.ts (will be refactored in Phase 3 to use this)
 *   - commands/setup.ts
 *   - migration script (Phase 7)
 *
 * Adapters know what files they need; consumers just ask for "scaffold
 * for this project root."
 */

import type { CancellationOptions } from '../../types.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface ProviderScaffolder {
  readonly capability: typeof CapabilityFlag.ProviderScaffolder;

  /**
   * Install this provider's scaffolding under the given project root.
   * Idempotent — calling twice is safe; the adapter detects existing
   * scaffolding and skips or upgrades as appropriate.
   */
  install(
    projectRoot: string,
    options?: ProviderScaffoldOptions,
  ): Promise<ScaffoldResult>;

  /**
   * Verify scaffolding is intact under the given project root. Returns
   * a report of what's present, missing, or modified from expected.
   */
  verify(
    projectRoot: string,
    options?: CancellationOptions,
  ): Promise<ScaffoldVerification>;

  /**
   * Remove this provider's scaffolding. Used during provider-switching
   * (uninstall the old provider before installing the new one).
   */
  uninstall(
    projectRoot: string,
    options?: ProviderScaffoldOptions,
  ): Promise<void>;
}

export interface ProviderScaffoldOptions extends CancellationOptions {
  /** Whether to overwrite existing files without confirmation. Default: false. */
  force?: boolean;
  /**
   * Hooks to install. Subset of the provider's supported event kinds; the
   * adapter materializes hook scripts that POST events to instar's HTTP
   * endpoint.
   */
  hookEvents?: ReadonlyArray<string>;
  /**
   * Skills/agents to install. Adapter materializes them in the provider's
   * native skill/agent format (Claude's .claude/skills/, Codex's
   * .codex/agents/).
   */
  bundledAssets?: ReadonlyArray<ScaffoldAsset>;
}

export interface ScaffoldAsset {
  kind: 'skill' | 'subagent' | 'hook-script' | 'instruction-file';
  name: string;
  /** Contents of the asset. */
  content: string;
}

export interface ScaffoldResult {
  /** Paths that were created. */
  created: ReadonlyArray<string>;
  /** Paths that were updated. */
  updated: ReadonlyArray<string>;
  /** Paths that were left as-is (already correct). */
  unchanged: ReadonlyArray<string>;
}

export interface ScaffoldVerification {
  /** All expected files are present and correct. */
  intact: boolean;
  /** Files expected but missing. */
  missing: ReadonlyArray<string>;
  /** Files present but modified from expected content. */
  modified: ReadonlyArray<string>;
  /** Files present that the scaffolder doesn't know about. */
  extraneous: ReadonlyArray<string>;
}
