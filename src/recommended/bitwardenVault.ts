/**
 * What the Bitwarden setup recipe needs from this machine's Bitwarden CLI, behind one small surface so
 * the recipe and the routes can be tested with a stand-in (docs/specs/recommended-services.md, First
 * recipes: Bitwarden). The real surface wraps BitwardenProvider, which scopes everything to the folder
 * `instar/<agent>` and names items `instar/<agent>/<key>`.
 *
 * Nothing here logs a value. The master password reaches `bw` through the child's environment only.
 */
import { BitwardenProvider } from '../core/BitwardenProvider.js';
import type { Secrets } from '../core/SecretStore.js';

export interface BitwardenVaultStatus {
  installed: boolean;
  loggedIn: boolean;
}

export interface BitwardenSurface {
  /** Null when the program did not answer, so nothing is known: never read as "not logged in". */
  status(): BitwardenVaultStatus | null;
  /** Opens the vault for this process with the master password. False when the password is refused or the CLI fails. */
  unlock(masterPassword: string): boolean;
  /** The names of the items in the agent's own folder (keys only, without the folder prefix): [] when there is no folder yet, null when the vault can't be read. Never creates anything. */
  itemNames(): string[] | null;
  /** Writes or updates one Secure Note in the agent's own folder. */
  put(key: string, value: string): boolean;
  /** Signs this machine out. True when signed out, or already was. */
  logout(): boolean;
}

/** The marker item setup writes, so the check can tell the agent's folder from an empty or foreign one. */
export const VAULT_CHECK_ITEM = 'vault-check';

/** Leaves of the vault that go to Bitwarden: every stored secret except transient drops and Bitwarden's own password. */
export function copiedSecretNames(secrets: Secrets): string[] {
  const out: string[] = [];
  const walk = (obj: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(obj)) {
      const name = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>, name);
      else if (typeof v === 'string' && v) out.push(name);
    }
  };
  walk(secrets as Record<string, unknown>, '');
  // The vault's own key, under either name the codebase uses for it, never goes into the vault it opens.
  return out.filter((n) => !n.startsWith('secretDrops.') && n !== 'bitwarden_master_password' && n !== 'bw-master-password').sort();
}

/** The production surface: BitwardenProvider on this machine, scoped to this agent's folder. */
export function realBitwardenSurface(agentName: string): BitwardenSurface {
  const provider = new BitwardenProvider({ agentName });
  return {
    status: () => {
      const s = provider.statusRead();
      if (s.kind === 'failed') return null;
      return s.kind === 'missing' ? { installed: false, loggedIn: false } : { installed: true, loggedIn: s.loggedIn };
    },
    unlock: (masterPassword) => provider.unlock(masterPassword),
    // Read-only and honest: [] when there is no folder or no items, null when the vault could not be read.
    itemNames: () => {
      try {
        return provider.listOwnItemNames();
      } catch {
        // @silent-fallback-ok: an unreadable vault is reported as null, and the check says "unknown"
        return null;
      }
    },
    // Never throws: the provider's failure text can carry a command line, and a failed write is just false here.
    put: (key, value) => {
      try {
        return provider.set(key, value);
      } catch {
        // @silent-fallback-ok: reported as a failed write by the caller, with a fixed reason
        return false;
      }
    },
    logout: () => provider.logout(),
  };
}
