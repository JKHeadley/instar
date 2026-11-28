/**
 * Launch-side helpers for job-mode instructions (docs/specs/job-mode-instructions.md, Changes 4-5).
 * Kept free of template imports so the session launcher can use them without a cycle.
 */
import crypto from 'node:crypto';
import path from 'node:path';

/** The project-level instruction files a job-mode launch excludes, relative to the agent home. */
export const EXCLUDED_INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', path.join('.claude', 'CLAUDE.md')] as const;

/** Change 5: any restricted spawn keeps today's launch. Returns the reason, or null when unrestricted. */
export function jobModeRestriction(opts: {
  confinement?: unknown; confinedTools?: string[]; requireToolConfinement?: boolean; omitAuthEnv?: boolean;
}): string | null {
  if (opts.confinement) return 'confinement';
  if (opts.confinedTools && opts.confinedTools.length > 0) return 'confined-tools';
  if (opts.requireToolConfinement) return 'require-tool-confinement';
  if (opts.omitAuthEnv) return 'no-auth-env';
  return null;
}

/** Change 4: the settings object passed with `--settings` (inline JSON). */
export function jobModeSettingsJson(agentHome: string): string {
  return JSON.stringify({
    claudeMdExcludes: EXCLUDED_INSTRUCTION_FILES.map(f => path.resolve(agentHome, f)),
    autoMemoryEnabled: false,
  });
}

export function newJobModeSessionId(): string {
  return crypto.randomUUID();
}

