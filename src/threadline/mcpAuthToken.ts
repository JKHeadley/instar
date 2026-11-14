/**
 * Resolve the agent API bearer token for the Threadline MCP stdio process.
 *
 * The stdio helper runs OUTSIDE the agent server (Claude Code / Codex spawn it
 * from `.mcp.json`), yet every `/threadline/*` route it drives — relay-send,
 * relay-discover, status, pairing — is the agent's own control surface and is
 * bearer-gated (fb-829a7161-942: until 2026-10-27 the whole prefix was exempt
 * from the bearer check, which is the only reason a token-less helper ever
 * worked). So the helper must present the real token. Three sources, first
 * hit wins:
 *
 *   1. `INSTAR_AUTH_TOKEN` in the environment — SessionManager injects it into
 *      every session it spawns (tmux -e), and the MCP child inherits it.
 *   2. A plaintext `authToken` string in `.instar/config.json` — legacy installs
 *      that predate secret externalization.
 *   3. The encrypted vault (`.instar/secrets/config.secrets.enc`) — where
 *      SecretMigrator moves `authToken`, leaving `{ secret: true }` in the
 *      config. This is the case a HAND-STARTED Codex (`instar codex connect`)
 *      lands in: no session env, placeholder in config. Same read path as
 *      `.instar/scripts/secret-get.mjs authToken`.
 *
 * The `{ secret: true }` placeholder is never returned as a token (string-type
 * guard), and a vault that is absent or cannot be decrypted yields '' — the
 * helper then gets an honest 401 from the server instead of a forged header.
 * Nothing here is logged; the value only ever goes into an Authorization
 * header on a loopback request.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SecretStore } from '../core/SecretStore.js';

export interface McpAuthResolution {
  token: string;
  /** Which source answered — observability for tests and `--debug` output, never the value. */
  source: 'env' | 'config' | 'vault' | 'none';
  port: number;
}

export function resolveMcpAuthToken(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { defaultPort?: number; secretStore?: Pick<SecretStore, 'get'> } = {},
): McpAuthResolution {
  const defaultPort = opts.defaultPort ?? 4040;
  let port = defaultPort;
  let configToken = '';
  let configHasPlaceholder = false;
  const configPath = path.join(stateDir, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { port?: unknown; authToken?: unknown };
      if (typeof config.port === 'number' && Number.isFinite(config.port)) port = config.port;
      if (typeof config.authToken === 'string') configToken = config.authToken;
      else if (config.authToken && typeof config.authToken === 'object') configHasPlaceholder = true;
    } catch {
      // unreadable config: fall through with defaults
    }
  }

  const envToken = env.INSTAR_AUTH_TOKEN || '';
  if (envToken) return { token: envToken, source: 'env', port };
  if (configToken) return { token: configToken, source: 'config', port };

  // Vault fallback. Only attempted when the config actually points at the vault
  // (the placeholder) or carries no token at all — a legacy plaintext install
  // never opens the keychain.
  if (configHasPlaceholder || !configToken) {
    try {
      const store = opts.secretStore ?? new SecretStore({ stateDir });
      const v = store.get('authToken');
      if (typeof v === 'string' && v.length > 0) return { token: v, source: 'vault', port };
    } catch {
      // absent / locked / wrong-key vault: no token. Never repair or rotate here.
    }
  }
  return { token: '', source: 'none', port };
}
