/**
 * resolveInboxBlobToken.ts — find the Vercel Blob token the InboxDrainer needs.
 *
 * The server is spawned by the lifeline's ServerSupervisor inside a fresh tmux
 * session, so a variable set in the lifeline's (launchd) environment never
 * reaches it. The env var alone therefore kept the drainer dark on the operated
 * machine even though the token sat in the agent's encrypted vault.
 *
 * Precedence: a non-empty env var wins (unchanged behavior wherever it worked);
 * otherwise the agent's encrypted SecretStore — the same store and read path as
 * `.instar/scripts/secret-get.mjs` and `ghToken.ts`; otherwise none.
 *
 * Containment: the value is only ever RETURNED. This module never logs, echoes
 * or persists it, and a vault read failure is reported as a flag, never as the
 * underlying error text. Never throws: boot must proceed regardless of vault
 * state (the caller fails dark exactly as before).
 *
 * Spec: docs/specs/feedback-inbox-vault-token.md §A.
 */
import { SecretStore } from '../../core/SecretStore.js';

export const DEFAULT_INBOX_BLOB_TOKEN_ENV = 'FEEDBACK_INBOX_BLOB_TOKEN';
export const DEFAULT_INBOX_BLOB_TOKEN_VAULT_KEY = 'feedback_inbox_blob_token';

export type InboxBlobTokenSource = 'env' | 'vault' | 'none';

export interface ResolveInboxBlobTokenInput {
  env: Record<string, string | undefined>;
  envName: string;
  stateDir: string;
  vaultKey: string;
  /** Route the master key to the file backend (tests; config.secrets.forceFileKey). */
  forceFileKey?: boolean;
}

export interface ResolvedInboxBlobToken {
  token: string | null;
  source: InboxBlobTokenSource;
  /** Set when the vault exists but could not be read (no value, no error text). */
  vaultError?: true;
}

export function resolveInboxBlobToken(input: ResolveInboxBlobTokenInput): ResolvedInboxBlobToken {
  const fromEnv = input.env[input.envName]?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };

  try {
    const value = new SecretStore({ stateDir: input.stateDir, forceFileKey: input.forceFileKey }).get(input.vaultKey);
    if (typeof value === 'string' && value.trim().length > 0) {
      return { token: value.trim(), source: 'vault' };
    }
    return { token: null, source: 'none' };
  } catch {
    // @silent-fallback-ok — reported to the caller as vaultError, which logs it;
    // the drainer then stays dark exactly as it did before the vault fallback.
    return { token: null, source: 'none', vaultError: true };
  }
}
