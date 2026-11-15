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

const claudeAuth = new ClaudeAuthStatusReader();

export const ENGINE_LOGIN_READERS: Partial<Record<IntelligenceFramework, EngineLoginReader>> = {
  'claude-code': async (configHome) => {
    const ans = await claudeAuth.read(configHome);
    if (ans.loggedIn === false && !(await claudeAuth.canaryProven())) {
      return { loggedIn: null, detail: 'signed-out answer not yet proven on this machine' };
    }
    return { loggedIn: ans.loggedIn, ...(ans.loginExpiresAt ? { detail: `login expires ${ans.loginExpiresAt}` } : {}) };
  },
};
