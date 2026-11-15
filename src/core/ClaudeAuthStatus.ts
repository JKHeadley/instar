/**
 * Claude Code's own login answer for one config home (never-silent-conversation §3.6).
 *
 * `CLAUDE_CONFIG_DIR=<home> claude auth status` prints JSON (`loggedIn`, `authMethod`,
 * `loginExpiresAt`) and exits non-zero when signed out. The answer is ASYMMETRIC:
 * `loggedIn: true` has been measured true for an expired login (skill-driven-signin-repair),
 * so a YES is never proof; `loggedIn: false` is trustworthy once the empty-home canary has
 * shown the check can say no on this machine. Credentials from the environment are stripped
 * so an API key cannot turn the answer into a YES for the home being asked about.
 *
 * RULE 3.1 rationale (state-detector registry: core/ClaudeAuthStatus.ts):
 *  - Criticality: MEDIUM. The answer is an input to the never-silent judge; nothing acts on it alone.
 *  - Frequency: only when a silent Claude conversation is judged (backed off per incident).
 *  - Stability: semi-stable — `claude auth status` is a documented status command emitting JSON.
 *  - Fallback: unreadable ⇒ unknown (no change); a YES never counts as proof.
 *  - → Verdict: asymmetric + canary-backed (ClaudeAuthStatusReader.canaryProven).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export interface ClaudeAuthAnswer {
  /** null = unreadable (spawn failed, timed out, unparseable). */
  loggedIn: boolean | null;
  authMethod?: string;
  loginExpiresAt?: string | null;
}

export type ClaudeAuthRunner = (configHome: string) => Promise<string | null>;

const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_API_KEY'];

export const defaultClaudeAuthRunner: ClaudeAuthRunner = (configHome) => new Promise((resolve) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configHome };
  for (const k of STRIPPED_ENV) delete env[k];
  try {
    execFile('claude', ['auth', 'status'], { timeout: 15_000, maxBuffer: 256 * 1024, env }, (_err, stdout) => {
      // A signed-out answer exits 1 with the JSON on stdout — read stdout either way.
      resolve(typeof stdout === 'string' && stdout.trim() ? stdout : null);
    });
  } catch {
    resolve(null); // @silent-fallback-ok — spawn failed ⇒ unreadable, which changes nothing
  }
});

export function parseClaudeAuthStatus(stdout: string | null): ClaudeAuthAnswer {
  if (!stdout) return { loggedIn: null };
  try {
    const d = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown; loginExpiresAt?: unknown };
    return {
      loggedIn: typeof d.loggedIn === 'boolean' ? d.loggedIn : null,
      ...(typeof d.authMethod === 'string' ? { authMethod: d.authMethod } : {}),
      ...(typeof d.loginExpiresAt === 'string' || d.loginExpiresAt === null ? { loginExpiresAt: d.loginExpiresAt as string | null } : {}),
    };
  } catch {
    return { loggedIn: null }; // @silent-fallback-ok — unparseable ⇒ unknown
  }
}

export class ClaudeAuthStatusReader {
  private canary: 'unproven' | 'proven' | 'failed' = 'unproven';
  private canaryAt = 0;
  constructor(
    private readonly run: ClaudeAuthRunner = defaultClaudeAuthRunner,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The check can say NO on this machine: an empty home must read loggedIn:false. Re-proven daily. */
  async canaryProven(): Promise<boolean> {
    if (this.canary === 'proven' && this.now() - this.canaryAt < 24 * 60 * 60_000) return true;
    let dir: string | null = null;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-auth-canary-'));
      const ans = parseClaudeAuthStatus(await this.run(dir));
      this.canary = ans.loggedIn === false ? 'proven' : 'failed';
    } catch {
      this.canary = 'failed'; // @silent-fallback-ok — an unproven canary means a NO is not trusted
    } finally {
      this.canaryAt = this.now();
      if (dir) {
        try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'src/core/ClaudeAuthStatus.ts:canary' }); }
        catch { /* @silent-fallback-ok — a leftover empty temp dir is harmless */ }
      }
    }
    return this.canary === 'proven';
  }

  async read(configHome: string): Promise<ClaudeAuthAnswer> {
    return parseClaudeAuthStatus(await this.run(configHome));
  }

  /** true only for a canary-backed NO; false for YES; null for unknown. */
  async trustedSignedOut(configHome: string): Promise<boolean | null> {
    const ans = await this.read(configHome);
    if (ans.loggedIn === true) return false;
    if (ans.loggedIn === null) return null;
    return (await this.canaryProven()) ? true : null;
  }
}
