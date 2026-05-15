/**
 * PluginRegistry — manage provider plugins.
 *
 * OPTIONAL primitive — Codex-native. Codex supports first-class plugins
 * that can bundle hooks, tools, and prompts. Claude has no plugin
 * protocol; skills approximate but are managed differently.
 *
 * Maps to:
 *   - Codex: `plugin/list`, `plugin/install`, `plugin/uninstall` JSON-RPC
 *     methods; plugins can bundle hooks under `hooks/hooks.json` with
 *     `[features].plugin_hooks = true`
 *   - Claude: capability false; ProviderScaffolder handles skill bundling
 *     as the rough equivalent
 */

import type { CancellationOptions } from '../../types.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface PluginRegistry {
  readonly capability: typeof CapabilityFlag.PluginRegistry;

  /** List installed plugins. */
  list(options?: CancellationOptions): Promise<ReadonlyArray<InstalledPlugin>>;

  /** Install a plugin from a source. */
  install(
    source: PluginSource,
    options?: PluginInstallOptions,
  ): Promise<InstalledPlugin>;

  /** Uninstall a plugin by id. */
  uninstall(
    pluginId: string,
    options?: CancellationOptions,
  ): Promise<void>;

  /** Enable or disable an installed plugin without uninstalling. */
  setEnabled(
    pluginId: string,
    enabled: boolean,
    options?: CancellationOptions,
  ): Promise<void>;
}

export type PluginSource =
  | { kind: 'npm'; package: string; version?: string }
  | { kind: 'git'; url: string; ref?: string }
  | { kind: 'local-path'; path: string };

export interface PluginInstallOptions extends CancellationOptions {
  /** Auto-enable on install. Default: true. */
  enabled?: boolean;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  /** What this plugin provides (hooks, tools, prompts). */
  contributions: {
    hooks?: number;
    tools?: number;
    prompts?: number;
  };
}
