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
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

/**
 * Give the agent a dashboard PIN when it has none, whatever messaging it uses.
 *
 * The PIN gates every dashboard operator route, so an agent without one (an
 * agent with no Telegram, before this) could never unlock its own dashboard.
 * Anything already set is kept untouched, including an unresolved vault
 * reference: a transient vault read failure must never replace the operator's
 * PIN. The value is returned to the caller, never logged here.
 */
export function ensureDashboardPin(
  config: { dashboardPin?: unknown },
  persist: (pin: string) => void,
  draw: () => number = () => randomInt(100000, 1000000),
): { generated: boolean } {
  if (config.dashboardPin) return { generated: false };
  const pin = String(draw());
  config.dashboardPin = pin;
  persist(pin);
  return { generated: true };
}

/**
 * Store a newly minted PIN where this agent keeps its secrets: in the
 * encrypted vault (config gets the `{secret:true}` reference) when the agent
 * has one, else in config.json as before. A vault write that fails falls back
 * to config.json, so the PIN is never lost. Returns where it went.
 */
export function persistDashboardPin(
  stateDir: string,
  pin: string,
  setConfig: (value: unknown) => void,
  openStore: () => Pick<SecretStore, 'set'> = () => new SecretStore({ stateDir }),
): 'vault' | 'config' {
  if (fs.existsSync(path.join(stateDir, 'secrets', 'config.secrets.enc'))) {
    try {
      openStore().set(DASHBOARD_PIN_VAULT_KEY, pin);
      setConfig({ secret: true });
      return 'vault';
    } catch (err) {
      // @silent-fallback-ok — the PIN still has to exist; config.json is where it lived before vaults
      console.warn(`[dashboardPin] vault write failed, keeping the new PIN in config.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  setConfig(pin);
  return 'config';
}
