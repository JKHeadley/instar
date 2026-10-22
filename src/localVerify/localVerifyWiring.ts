/**
 * Builds the LocalVerifyService for the agent server (spec
 * docs/specs/local-verify-merge-authority.md §2).
 *
 * Repo-gated like the green-PR watcher: constructed only when
 * `monitoring.localVerify.enabled` is true AND the server runs from an instar
 * source checkout. Otherwise null, and the routes answer 503. The verifier's own
 * code (this module, the orchestrator, the child entry) always comes from the
 * running server's install, never from the PR being verified.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getInstarVersion } from '../core/Config.js';
import { createAuthenticatedGitHubCliRuntimeResolver } from '../core/githubRuntime.js';
import { PROTECTED_PATH_PREFIXES } from '../monitoring/greenPrAutomergeWiring.js';
import { LocalVerifyService } from './LocalVerifyService.js';
import { buildDefaultServiceSeams, scrubbedEnv } from './serviceSeams.js';

export interface LocalVerifyConfigBlock {
  enabled?: boolean;
  operatorGhLogin?: string;
}

export interface LocalVerifyWiringOpts {
  config: LocalVerifyConfigBlock | undefined;
  /** The green-PR block's `expectedGhLogin` (the agent's own GitHub login). */
  expectedGhLogin: string | undefined;
  repo: string;
  /** The server's working directory (the instar source checkout). */
  repoPath: string;
  /** The agent's `.instar` directory. */
  stateDir: string;
  /** The agent home (`.worktrees/.verify/` lives under it). */
  agentHome: string;
  machineId: string;
  onStarved?: (info: { pr: number; headSha: string; waitedMs: number }) => void;
  /** Override the child entry (tests running from source point at the built dist). */
  mainEntry?: string;
}

export type LocalVerifyWiringResult =
  | { service: LocalVerifyService; reason: null }
  | { service: null; reason: 'disabled' | 'no-source-checkout' | 'no-gh-login' | 'no-entry' };

/** The child entry installed next to this module (dist/localVerify/runVerifyMain.js). */
export function installedMainEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'runVerifyMain.js');
}

export function buildLocalVerifyService(opts: LocalVerifyWiringOpts): LocalVerifyWiringResult {
  if (opts.config?.enabled !== true) return { service: null, reason: 'disabled' };
  if (!fs.existsSync(path.join(opts.repoPath, '.git')) || !fs.existsSync(path.join(opts.repoPath, 'scripts', 'safe-merge.mjs'))) {
    return { service: null, reason: 'no-source-checkout' };
  }
  const expected = (opts.expectedGhLogin ?? '').trim();
  if (!expected) return { service: null, reason: 'no-gh-login' };
  const mainEntry = opts.mainEntry ?? installedMainEntry();
  if (!fs.existsSync(mainEntry)) return { service: null, reason: 'no-entry' };

  const githubRuntime = createAuthenticatedGitHubCliRuntimeResolver({ stateDir: opts.stateDir });
  const seams = buildDefaultServiceSeams({
    repo: opts.repo,
    resolveGitHubEnv: () => {
      try { return githubRuntime().env; } catch { return null; } // @silent-fallback-ok — no explicit GitHub identity makes every request refuse as pr-unreadable
    },
  });
  const service = new LocalVerifyService(
    {
      repo: opts.repo,
      stateDir: opts.stateDir,
      agentHome: opts.agentHome,
      expectedGhLogin: expected,
      operatorGhLogin: opts.config.operatorGhLogin?.trim() || null,
      verifierVersion: getInstarVersion(),
      nodePath: process.execPath,
      mainEntry,
      remoteUrl: `https://github.com/${opts.repo}.git`,
      machineId: opts.machineId,
      nodeVersion: process.version,
      protectedList: PROTECTED_PATH_PREFIXES,
      baseEnv: scrubbedEnv(),
    },
    {
      ...seams,
      onStarved: opts.onStarved,
    },
  );
  return { service, reason: null };
}
