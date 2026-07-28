/**
 * Vault-backed GitHub token resolution for spawned sessions — Phase-3
 * increment P3b (per-agent credential isolation, the 2026-06-05 shared-machine
 * identity-bleed incident; operator-selected design: option C).
 *
 * On a shared machine, the `gh` CLI reads the machine-global
 * `~/.config/gh/hosts.yml` seat — which may belong to a DIFFERENT principal
 * than the agent doing the work. This module resolves the agent's OWN GitHub
 * token from its per-agent encrypted SecretStore so spawned sessions
 * authenticate as the agent (the vault is per-agent by construction and
 * already syncs across the agent's machines).
 *
 * Deliberately narrow (vault-only): when the vault holds no token the
 * resolver returns null and the caller injects nothing — installs that have
 * not adopted vault tokens keep today's machine-global behavior
 * byte-for-byte. There is no `~/.config/gh/hosts.yml` parsing here by design.
 *
 * Pure fs/crypto read — no subprocess. A subprocess inside a spawn-path
 * helper would consume queued child_process mock values in downstream test
 * suites (the P3a GitSync mock-sequence lesson).
 */
import { SecretStore } from './SecretStore.js';

/**
 * Vault key paths checked, in order. `github_token` is the fleet's canonical
 * flat name (the session-boot self-knowledge convention; deployed vaults use
 * it today); `github.token` is the nested dot-notation variant.
 */
export const GH_TOKEN_VAULT_KEYS = ['github_token', 'github.token'] as const;

export interface ResolveGhTokenOptions {
  /** Test seam: route the master key to the file backend (never the real
   *  keychain). Production callers omit this. */
  forceFileKey?: boolean;
}

/**
 * Resolve the agent's GitHub token from the encrypted vault at
 * `<stateDir>/secrets/config.secrets.enc`.
 *
 * Returns the trimmed token string, or null when the vault is absent, holds
 * no GitHub token, or cannot be read. Never throws: session spawning must
 * proceed regardless of vault state.
 */
export function resolveGhTokenFromVault(
  stateDir: string,
  options?: ResolveGhTokenOptions,
): string | null {
  try {
    const store = new SecretStore({ stateDir, forceFileKey: options?.forceFileKey });
    for (const keyPath of GH_TOKEN_VAULT_KEYS) {
      const value = store.get(keyPath);
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return null;
  } catch (err) {
    // @silent-fallback-ok — a vault read problem must never break session
    // spawning; the spawn proceeds without an injected GH_TOKEN (machine-global
    // gh behavior, exactly as before this increment).
    console.warn(
      `[ghToken] vault read failed (non-fatal; spawn proceeds without GH_TOKEN): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
