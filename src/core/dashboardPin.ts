/**
 * Vault-backed dashboard-PIN resolution for the Telegram dashboard broadcast.
 *
 * The 6-digit dashboard PIN is normally resolved from the per-agent encrypted
 * vault at loadConfig() time — a `{secret:true}` config ref is replaced with
 * the real value before the server starts. But a transient vault/keychain read
 * failure during a server boot under host pressure can leave the PIN
 * unresolved, and the dashboard broadcast then leaked the internal placeholder
 * string "(check your config)" to the user as if it were their PIN — a value
 * the end-user cannot act on, that reads like an instruction (the 2026-06-06
 * topic-5 incident; the exact user-facing-clarity failure mode).
 *
 * This module re-resolves the PIN straight from the vault at broadcast time so
 * a transient boot-time failure still yields the real PIN, and guarantees the
 * placeholder never escapes as a value. Mirrors ghToken.ts (vault-only, never
 * throws, no subprocess — a subprocess inside a messaging-path helper would
 * consume queued child_process mock values in downstream test suites).
 */
import { SecretStore } from './SecretStore.js';

/** The internal placeholder that must NEVER reach a user as a PIN value. */
export const DASHBOARD_PIN_PLACEHOLDER = '(check your config)';

/** Vault key path for the dashboard PIN (matches the config field name). */
export const DASHBOARD_PIN_VAULT_KEY = 'dashboardPin';

export interface ResolveDashboardPinOptions {
  /** Test seam: route the master key to the file backend (never the real
   *  keychain). Production callers omit this. */
  forceFileKey?: boolean;
}

/**
 * Resolve the dashboard PIN from the encrypted vault at
 * `<stateDir>/secrets/config.secrets.enc`.
 *
 * Returns the trimmed PIN string, or null when the vault is absent, holds no
 * dashboard PIN, or cannot be read. Never throws, and never returns the
 * placeholder.
 */
export function resolveDashboardPinFromVault(
  stateDir: string,
  options?: ResolveDashboardPinOptions,
): string | null {
  try {
    const store = new SecretStore({ stateDir, forceFileKey: options?.forceFileKey });
    const value = store.get(DASHBOARD_PIN_VAULT_KEY);
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0 && trimmed !== DASHBOARD_PIN_PLACEHOLDER) {
        return trimmed;
      }
    }
    return null;
  } catch (err) {
    // @silent-fallback-ok — a vault read problem must never break the dashboard
    // broadcast; the caller omits the PIN line honestly instead of leaking a
    // placeholder.
    console.warn(
      `[dashboardPin] vault read failed (non-fatal; broadcast omits PIN): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Pick a usable dashboard PIN: prefer the in-memory config value (the normal
 * path — already resolved from the vault by loadConfig), falling back to a
 * fresh vault read so a transient boot-time resolution failure still yields the
 * real PIN.
 *
 * Returns null when no real PIN is available — the caller MUST then omit the
 * PIN rather than emit any placeholder. Guards against a non-string in-memory
 * value (an unresolved `{secret:true}` object that leaked past loadConfig) and
 * against the placeholder string itself.
 */
export function pickDashboardPin(
  inMemory: unknown,
  stateDir: string,
  options?: ResolveDashboardPinOptions,
): string | null {
  if (typeof inMemory === 'string') {
    const trimmed = inMemory.trim();
    if (trimmed.length > 0 && trimmed !== DASHBOARD_PIN_PLACEHOLDER) {
      return trimmed;
    }
  }
  return resolveDashboardPinFromVault(stateDir, options);
}
