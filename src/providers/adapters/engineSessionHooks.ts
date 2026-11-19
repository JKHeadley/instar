/**
 * Per-engine hooks used by engine-neutral code (2.0 Rule 30: engine special-casing lives in the
 * adapter tree, behind a table keyed by framework id, never as branches in core code).
 *
 *  - PROJECT_TRUST_SEEDERS — before an interactive launch, record the agent's own launch folder as
 *    trusted in that engine's home, so the session cannot stall at a "trust this folder?" dialog
 *    (never-silent-conversation §1.5). Codex records trust in `<CODEX_HOME>/config.toml`.
 *  - ENGINE_LOGIN_READERS — the engine's OWN structured login answer for one config home, used as
 *    evidence by the never-silent judge (§3.2, §3.6). Claude Code: `claude auth status`, with the
 *    empty-home canary (a NO counts only once the check has been shown able to say no).
 *
 * An engine with no entry simply has no hook: callers skip it.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { IntelligenceFramework } from '../../core/intelligenceProviderFactory.js';
import { ensureCodexProjectTrusted, type CodexTrustResult } from '../../core/ensureCodexProjectTrusted.js';
import { ClaudeAuthStatusReader } from '../../core/ClaudeAuthStatus.js';

export type ProjectTrustSeeder = (
  envOverrides: Record<string, string | undefined>,
  projectDir: string,
  opts: { allowDefaultHome: boolean },
) => { home: string | null; result: CodexTrustResult };

export const PROJECT_TRUST_SEEDERS: Partial<Record<IntelligenceFramework, ProjectTrustSeeder>> = {
  'codex-cli': (envOverrides, projectDir, opts) => {
    const home = envOverrides.CODEX_HOME
      ?? (opts.allowDefaultHome ? (process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) : undefined)
      ?? null;
    return { home, result: ensureCodexProjectTrusted(home, projectDir) };
  },
};

export type EngineLoginReader = (configHome: string) => Promise<{ loggedIn: boolean | null; detail?: string }>;

/**
 * Whether the engine's credential store can be read right now. A NO from the engine counts as
 * "signed out" only while this is true: Claude Code keeps its login in the macOS login keychain,
 * and a locked keychain (after a reboot, a launchd context) makes a working login read as absent.
 * `null` = cannot tell, which never counts. An engine with no entry has no such store.
 */
export type CredentialStoreOpenCheck = () => Promise<boolean | null>;

const claudeAuth = new ClaudeAuthStatusReader();

/** macOS: `security show-keychain-info` on the default keychain exits 0 when it is unlocked. */
const macLoginKeychainOpen: CredentialStoreOpenCheck = () => new Promise((resolve) => {
  if (process.platform !== 'darwin') { resolve(true); return; } // Linux: a file in the config home
  try {
    execFile('security', ['show-keychain-info'], { timeout: 10_000 }, (err) => {
      if (!err) { resolve(true); return; }
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
      resolve(typeof code === 'number' ? false : null); // exited non-zero ⇒ locked; spawn failure ⇒ unknown
    });
  } catch {
    resolve(null); // @silent-fallback-ok — unknown never counts as signed out
  }
});

export const ENGINE_CREDENTIAL_STORE_OPEN: Partial<Record<IntelligenceFramework, CredentialStoreOpenCheck>> = {
  'claude-code': macLoginKeychainOpen,
};

/**
 * The engine's trusted signed-out answer for a config home (never-silent-conversation §3.6):
 * true only when the engine's own check says NO, that NO is canary-proven on this machine, and
 * the engine's credential store is open. Engines with no login reader answer null.
 */
export async function engineTrustedSignedOut(framework: string, configHome: string): Promise<boolean | null> {
  const reader = ENGINE_LOGIN_READERS[framework as IntelligenceFramework];
  if (!reader || !configHome) return null;
  const ans = await reader(configHome);
  if (ans.loggedIn !== false) return ans.loggedIn === true ? false : null;
  const storeOpen = ENGINE_CREDENTIAL_STORE_OPEN[framework as IntelligenceFramework];
  if (storeOpen && (await storeOpen()) !== true) return null;
  return true;
}

export const ENGINE_LOGIN_READERS: Partial<Record<IntelligenceFramework, EngineLoginReader>> = {
  'claude-code': async (configHome) => {
    const ans = await claudeAuth.read(configHome);
    if (ans.loggedIn === false && !(await claudeAuth.canaryProven())) {
      return { loggedIn: null, detail: 'signed-out answer not yet proven on this machine' };
    }
    return { loggedIn: ans.loggedIn, ...(ans.loginExpiresAt ? { detail: `login expires ${ans.loginExpiresAt}` } : {}) };
  },
};
