/**
 * The doors' contracts for the installer: detect, install, signed in and sign in (spec section 5).
 *
 * "Signed in" is one live, read-only call that spends nothing. `claude auth status` is not proof:
 * it reports signed in for expired sessions. A store that can't be read is `unknown`, which never
 * leads to a new sign-in over a login that may work.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { detectClaudePath, detectCodexPath, redetectFrameworkBinary } from '../core/Config.js';
import { classifyCodexLoginStatus } from '../core/CliLoginStatus.js';
import { claudeCredentialFilePath, readClaudeOauthAsyncDetailed, refreshClaudeToken, type RefreshResult } from '../core/OAuthRefresher.js';
import { probeClaudeUsage, readAccountEmail, type FetchImpl } from '../core/QuotaPoller.js';
import { readLiveCodexRateLimitsDetailed, type CodexLiveRead } from '../providers/adapters/openai-codex/observability/codexLiveRateLimitReader.js';
import { isWslHost } from '../core/wslPlatform.js';
import type { InstallDoor } from '../commands/setup-wizard/state-machine.js';

export type SignedInVerdict = 'signed-in' | 'signed-out' | 'unknown';

export const DOOR_NPM_PACKAGE: Record<InstallDoor, string> = {
  'claude-code': '@anthropic-ai/claude-code',
  'codex-cli': '@openai/codex',
};

export function detectDoorPath(door: InstallDoor): string | null {
  return door === 'claude-code' ? detectClaudePath() : detectCodexPath();
}

/** Looks again after installing, since detection is remembered for the life of a process. */
export function redetectDoorPath(door: InstallDoor): string | null {
  return redetectFrameworkBinary(door === 'claude-code' ? 'claude' : 'codex');
}

export function detectInstallDoors(): InstallDoor[] {
  return (['claude-code', 'codex-cli'] as InstallDoor[]).filter((door) => detectDoorPath(door) !== null);
}

/** The harness running the installer. Each sets its own marker for the tools it starts. */
export function detectRunningDoor(env: NodeJS.ProcessEnv = process.env): InstallDoor | undefined {
  if (env.CLAUDECODE) return 'claude-code';
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX) return 'codex-cli';
  return undefined;
}

/** Whether a sign-in page can open on this machine. The kernel, not env vars, identifies WSL. */
export function hasBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  // Over SSH a page would open on a screen the person can't see.
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === 'darwin') return true;
  if (isWslHost(platform)) return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** The command that signs a door in. With no browser, Codex can use a device code. */
export function doorSignInArgs(door: InstallDoor, browser: boolean): string[] {
  if (door === 'claude-code') return ['auth', 'login'];
  return browser ? ['login'] : ['login', '--device-auth'];
}

export interface ClaudeProofDeps {
  configHome?: string;
  fetchImpl?: FetchImpl;
  readOauth?: typeof readClaudeOauthAsyncDetailed;
  refresh?: (configHome: string) => Promise<RefreshResult>;
  accountEmail?: (configHome: string) => string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (file: string) => boolean;
}

/** Only these say the login is really gone. Anything else may be a network, rate-limit or write problem. */
function refreshProvesSignedOut(result: RefreshResult): boolean {
  if (result.ok) return false;
  if (result.reason === 'no-refresh-token') return true;
  return result.reason === 'exchange-failed' && (result.status === 400 || result.status === 401);
}

const PROOF_TIMEOUT_MS = 10_000;

export async function proveClaudeSignedIn(deps: ClaudeProofDeps = {}): Promise<SignedInVerdict> {
  const configHome = deps.configHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const readOauth = deps.readOauth ?? readClaudeOauthAsyncDetailed;
  const fetchImpl: FetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as ReturnType<FetchImpl>);
  const refresh = deps.refresh ?? refreshClaudeToken;
  const accountEmail = deps.accountEmail ?? readAccountEmail;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const fileExists = deps.fileExists ?? fs.existsSync;

  // Claude Code can run on these without a stored login, and this proof can't read them.
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX) {
    return 'unknown';
  }

  const usage = async (): Promise<'ok' | 'auth-failed' | 'unknown'> => {
    const read = await readOauth(configHome);
    if (!read.ok || typeof read.oauth.accessToken !== 'string') return 'unknown';
    return probeClaudeUsage(read.oauth.accessToken, fetchImpl, PROOF_TIMEOUT_MS);
  };

  const read = await readOauth(configHome);
  if (!read.ok) {
    if (read.reason === 'missing-oauth-block') return 'signed-out';
    if (read.reason === 'unparseable') return 'unknown';
    // On a Mac "missing" can also mean a locked keychain, and a recorded account says one exists.
    if (platform === 'darwin') return accountEmail(configHome) ? 'unknown' : 'signed-out';
    // Elsewhere a file that's there but didn't read is unreadable, not absent.
    return fileExists(claudeCredentialFilePath(configHome)) ? 'unknown' : 'signed-out';
  }

  const first = await usage();
  if (first === 'ok') return 'signed-in';
  if (first === 'unknown') return 'unknown';
  // An expired access token also answers 401, and a refresh recovers it without a new sign-in.
  const refreshed = await refresh(configHome);
  if (!refreshed.ok) return refreshProvesSignedOut(refreshed) ? 'signed-out' : 'unknown';
  const second = await usage();
  if (second === 'ok') return 'signed-in';
  return second === 'auth-failed' ? 'signed-out' : 'unknown';
}

export interface CodexProofDeps {
  binary?: string;
  liveRead?: () => Promise<CodexLiveRead>;
  loginStatus?: () => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export async function proveCodexSignedIn(deps: CodexProofDeps = {}): Promise<SignedInVerdict> {
  // The detected path, not bare `codex`: the npm prefix may not be on PATH under curl | sh.
  const binary = deps.binary ?? detectCodexPath() ?? 'codex';
  const liveRead = deps.liveRead ?? (() => readLiveCodexRateLimitsDetailed({
    spawnImpl: (_cmd, args, options) => spawn(binary, args, { ...options, stdio: 'pipe' }),
  }));
  const loginStatus = deps.loginStatus ?? (() => codexLoginStatus(binary));
  const read = await liveRead();
  if (read.kind === 'ok') return 'signed-in';
  if (read.kind === 'auth-failed') return 'signed-out';
  // The live read couldn't answer. `codex login status` can still prove there is nothing to clobber.
  const status = classifyCodexLoginStatus(await loginStatus());
  return status === 'signed-out' ? 'signed-out' : 'unknown';
}

function codexLoginStatus(binary: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(binary, ['login', 'status'], { timeout: PROOF_TIMEOUT_MS }, (error, stdout, stderr) => {
      const code = error
        ? (typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : null)
        : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export function proveDoorSignedIn(door: InstallDoor): Promise<SignedInVerdict> {
  return door === 'claude-code' ? proveClaudeSignedIn() : proveCodexSignedIn();
}
