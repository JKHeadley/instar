/**
 * Job-mode instructions (docs/specs/job-mode-instructions.md).
 *
 * Scheduled job sessions can launch with a short instruction set instead of the agent's full
 * CLAUDE.md, AGENTS.md and auto-memory index. This module holds the pure pieces:
 *  - rendering the job-mode text (Change 1),
 *  - resolving a job's configured mode (Change 3),
 *  - building the Claude Code launch settings (Change 4),
 *  - judging a finished run's transcript (Change 6).
 * Nothing here gates or blocks; it only selects which instruction text a job session loads.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  SHARED_CLAUSE_CITE_WITH_SOURCE,
  SHARED_CLAUSE_NO_COMMANDS_TO_USER,
  SHARED_CLAUSE_NO_INTERACTIVE_COMMANDS,
  SHARED_CLAUSE_PLAIN_COMPLETE_MESSAGES,
} from '../scaffold/templates.js';
import { EXCLUDED_INSTRUCTION_FILES } from './jobModeLaunch.js';
export { EXCLUDED_INSTRUCTION_FILES, jobModeRestriction, jobModeSettingsJson, newJobModeSessionId } from './jobModeLaunch.js';

export type InstructionsMode = 'job-mode' | 'full';
export const INSTRUCTIONS_MODES: readonly InstructionsMode[] = ['job-mode', 'full'];

export function isInstructionsMode(v: unknown): v is InstructionsMode {
  return typeof v === 'string' && (INSTRUCTIONS_MODES as readonly string[]).includes(v);
}

/** The marker line every rendered job-mode text ends with (Change 1, checked in Change 6). */
export function jobModeMarker(instarVersion: string): string {
  return `JOB-MODE-MARKER instar ${instarVersion}`;
}
export const JOB_MODE_MARKER_PREFIX = 'JOB-MODE-MARKER instar ';

/**
 * Change 1: the job-mode text. Rendered in memory at every job-mode launch and passed inline, so no
 * disk copy can change what the session receives. Holds no per-machine value: the server address
 * and token come from the session environment.
 */
export function generateJobModeText(opts: { agentName: string; instarVersion: string }): string {
  const name = opts.agentName || 'this agent';
  return [
    `# Job mode: ${name}`,
    '',
    `You are ${name}, running an unattended scheduled job. Nobody is watching this session live. Your task is the job prompt you were given; do that task and finish.`,
    '',
    'To keep this session cheap, the agent\'s full instruction files (CLAUDE.md, AGENTS.md) and its memory index were NOT loaded. They are in the agent home if this job genuinely needs them: read CLAUDE.md, or `.instar/reference/INDEX.md` for a capability, on demand.',
    '',
    '## Talking to your own server',
    '- The server address is `$INSTAR_SERVER_URL` and the bearer token is `$INSTAR_AUTH_TOKEN`; send `Authorization: Bearer $INSTAR_AUTH_TOKEN` on every call except `/health`.',
    '- Look things up through the server before claiming anything about state (for example `GET /capabilities`, `GET /jobs`, `GET /memory/search?q=...`). Your memory of how the system works is stale; the server is the source of truth.',
    '- Record anything worth keeping through the server (memory, commitments, feedback routes). Auto-memory is off in job sessions.',
    '',
    '## Rules that apply to every session',
    SHARED_CLAUSE_NO_INTERACTIVE_COMMANDS,
    '',
    SHARED_CLAUSE_CITE_WITH_SOURCE,
    '',
    '- Report an Instar bug or missing feature with `POST /feedback` (`{"type":"bug","title":...,"description":...}`). Never use GitHub issues for this.',
    '- Never force-push, never run destructive git or file-deletion commands outside what the job prompt asks, and never print a secret value; refer to a secret by its name.',
    '',
    '## Messaging the person (only if the job prompt says to)',
    '- Use the relay script the job prompt names (for Telegram, `.instar/scripts/telegram-reply.sh <topic>` with the message on stdin).',
    SHARED_CLAUSE_PLAIN_COMPLETE_MESSAGES,
    SHARED_CLAUSE_NO_COMMANDS_TO_USER,
    '- Technical detail (commands, file paths, ids) only when the person asked for it.',
    '',
    jobModeMarker(opts.instarVersion),
  ].join('\n');
}

/** Change 3: a reviewed shipped job, keyed by slug AND the body hash the loader verifies. */
export interface ReviewedJob { slug: string; bodyHash: string }

/**
 * Shipped jobs whose exact prompt someone has read and found self-contained. A newly signed body
 * under a listed slug does not match and resolves to full until it is reviewed. Empty at first
 * release: every shipped job stays on full instructions until reviewed (the PR lists them).
 */
export const SHIPPED_JOBS_REVIEWED_FOR_JOB_MODE: readonly ReviewedJob[] = [];

export interface ModeResolutionInput {
  slug: string;
  /** 'instar' | 'user' for agentmd jobs; undefined for legacy jobs.json entries. */
  origin?: 'instar' | 'user';
  lockTrust?: string;
  /** sha256:<hex> of the agentmd body, or null for legacy entries. */
  bodyHash: string | null;
  /** The jobs.json entry's own `instructions` field (legacy entries only). */
  field?: unknown;
}

export interface ModeResolution {
  mode: InstructionsMode;
  source: 'override' | 'field' | 'reviewed-default' | 'default';
  /** Set when an override or field value was invalid and ignored. */
  invalid?: string;
}

/** The override map key: origin and slug, so an override never follows a fork that reuses a slug. */
export function overrideKey(origin: 'instar' | 'user' | undefined, slug: string): string {
  return `${origin ?? 'user'}:${slug}`;
}

/**
 * Change 3, first match wins: operator override (origin:slug), the jobs.json field, then the
 * default (job-mode only for a verified shipped job whose slug and body hash are reviewed).
 * An invalid value resolves THAT job to full and is reported; it never throws.
 */
export function resolveInstructionsMode(
  input: ModeResolutionInput,
  overrides: Record<string, unknown> | undefined,
  reviewed: readonly ReviewedJob[] = SHIPPED_JOBS_REVIEWED_FOR_JOB_MODE,
): ModeResolution {
  const key = overrideKey(input.origin, input.slug);
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) {
    const v = overrides[key];
    if (isInstructionsMode(v)) return { mode: v, source: 'override' };
    return { mode: 'full', source: 'override', invalid: `scheduler.instructionsOverrides["${key}"] = ${JSON.stringify(v)}` };
  }
  if (input.origin === undefined && input.field !== undefined) {
    if (isInstructionsMode(input.field)) return { mode: input.field, source: 'field' };
    return { mode: 'full', source: 'field', invalid: `job "${input.slug}" instructions = ${JSON.stringify(input.field)}` };
  }
  if (input.origin === 'instar' && input.lockTrust === 'trusted' && input.bodyHash
    && reviewed.some(r => r.slug === input.slug && r.bodyHash === input.bodyHash)) {
    return { mode: 'job-mode', source: 'reviewed-default' };
  }
  return { mode: 'full', source: 'default' };
}

// ── Change 6: judging a finished run's transcript ─────────────────────────────

export type TranscriptVerdict = 'pass' | 'fail' | 'unknown';
export interface TranscriptJudgement { verdict: TranscriptVerdict; reason: string; loaded?: string[] }

export const TRANSCRIPT_READ_BOUND_BYTES = 256 * 1024;

/** Is `file` one of the sources a job-mode launch claims to exclude (resolved path match)? */
/** Both the lexical path and, when it exists, its real path (symlinks resolved), so an alias still matches. */
function pathForms(p: string): string[] {
  const lexical = path.resolve(p);
  try { const real = fs.realpathSync(lexical); return real === lexical ? [lexical] : [lexical, real]; }
  catch { return [lexical]; } // @silent-fallback-ok — a path that does not exist keeps its lexical form
}

export function isExcludedSource(file: string, agentHome: string, memoryIndexPaths: readonly string[] = []): boolean {
  const resolved = path.resolve(file);
  const fileForms = pathForms(file);
  const matches = (candidate: string) => { const c = pathForms(candidate); return fileForms.some(f => c.includes(f)); };
  if (EXCLUDED_INSTRUCTION_FILES.some(f => matches(path.resolve(agentHome, f)))) return true;
  if (memoryIndexPaths.some(m => matches(m))) return true;
  // Auto-memory index files are always named MEMORY.md inside a `memory` folder.
  return path.basename(resolved) === 'MEMORY.md' && path.basename(path.dirname(resolved)) === 'memory';
}

/**
 * Pass: the read reached the first assistant message, a prompt snapshot before it carries the
 * marker, and no instructions entry before it lists an excluded source. Fail: an excluded source is
 * listed, or a first-turn snapshot lacks the marker. Unknown: anything else.
 */
export function judgeJobModeTranscript(text: string, opts: {
  agentHome: string; marker: string; memoryIndexPaths?: readonly string[]; truncated?: boolean;
}): TranscriptJudgement {
  let sawSnapshot = false;
  let snapshotHasMarker = false;
  const loaded: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // The last line of a truncated read may be cut mid-record.
    let rec: any;
    try { rec = JSON.parse(line); } catch {
      if (opts.truncated && i === lines.length - 1) break;
      continue; // @silent-fallback-ok — a malformed transcript line is skipped; the verdict stays unknown unless a complete first turn is seen
    }
    if (rec?.type === 'attachment' && rec.attachment) {
      const a = rec.attachment;
      if (a.type === 'instructions' && Array.isArray(a.files)) {
        for (const f of a.files) {
          if (f && typeof f.path === 'string' && isExcludedSource(f.path, opts.agentHome, opts.memoryIndexPaths)) loaded.push(f.path);
        }
      } else if (a.type === 'prompt_snapshot' && !Array.isArray(a.systemPrompt)) {
        // An unrecognised snapshot after a recognised one resets the decision to unknown (the last snapshot decides).
        sawSnapshot = false; snapshotHasMarker = false;
      } else if (a.type === 'prompt_snapshot' && Array.isArray(a.systemPrompt)) {
        // Only the system prompt counts: the marker must be in the text Claude Code actually sent as the system
        // prompt (`systemPrompt`, a list of strings), not anywhere else in the snapshot. A snapshot without that
        // list is unrecognised and is not counted (the verdict is then unknown, never pass).
        sawSnapshot = true;
        // The last snapshot before the reply decides: a later snapshot without the marker is not masked by an earlier one.
        snapshotHasMarker = (a.systemPrompt as unknown[]).some((part) => typeof part === 'string' && part.includes(opts.marker));
      }
      continue;
    }
    if (rec?.type === 'assistant' || rec?.message?.role === 'assistant') {
      // Only a real model reply closes the window; an error or placeholder record cannot certify a pass.
      if (!isRealModelReply(rec)) {
        if (loaded.length > 0) return { verdict: 'fail', reason: 'excluded-source-loaded', loaded };
        return { verdict: 'unknown', reason: 'first-assistant-record-not-a-model-reply' };
      }
      if (loaded.length > 0) return { verdict: 'fail', reason: 'excluded-source-loaded', loaded };
      if (!sawSnapshot) return { verdict: 'unknown', reason: 'no-prompt-snapshot-before-first-reply' };
      if (!snapshotHasMarker) return { verdict: 'fail', reason: 'marker-missing-from-prompt' };
      return { verdict: 'pass', reason: 'excluded-sources-absent-and-marker-present' };
    }
  }
  if (loaded.length > 0) return { verdict: 'fail', reason: 'excluded-source-loaded', loaded };
  return { verdict: 'unknown', reason: 'first-reply-not-reached' };
}

/**
 * A real model reply: an assistant record carrying a model name other than Claude Code's `<synthetic>` placeholder,
 * no API error flag, and token usage. Shared by the job check and the positive control so both close the same window.
 */
export function isRealModelReply(rec: any): boolean {
  if (!(rec?.type === 'assistant' || rec?.message?.role === 'assistant')) return false;
  const m = rec?.message;
  if (!m || typeof m.model !== 'string' || m.model === '<synthetic>' || m.model.length === 0) return false;
  if (rec?.isApiErrorMessage === true || rec?.error) return false;
  return !!m.usage && typeof m.usage === 'object';
}

/** Read at most the bound from a transcript and judge it. Missing or unreadable → unknown. */
export function judgeTranscriptFile(file: string | null, opts: {
  agentHome: string; marker: string; memoryIndexPaths?: readonly string[];
}): TranscriptJudgement {
  if (!file) return { verdict: 'unknown', reason: 'transcript-not-found' };
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(TRANSCRIPT_READ_BOUND_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const size = fs.fstatSync(fd).size;
    return judgeJobModeTranscript(buf.subarray(0, n).toString('utf8'), { ...opts, truncated: size > n });
  } catch {
    return { verdict: 'unknown', reason: 'transcript-unreadable' };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* @silent-fallback-ok — closing a read-only descriptor */ } }
  }
}

/**
 * Find a Claude Code transcript by session id. Claude Code writes
 * `<configHome>/projects/<cwd with non-alphanumerics as ->/<sessionId>.jsonl`. The account that ran
 * the session may be any of the candidate config homes, so each is tried.
 */
export function findClaudeTranscript(sessionId: string, cwd: string, configHomes: readonly string[]): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const slug = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  for (const home of configHomes) {
    const p = path.join(home, 'projects', slug, `${sessionId}.jsonl`);
    try { if (fs.existsSync(p)) return p; } catch { /* @silent-fallback-ok — an unreadable candidate home is skipped */ }
  }
  return null;
}

/** Candidate Claude config homes: an explicit one first, then CLAUDE_CONFIG_DIR, ~/.claude and ~/.claude-* homes. */
export function candidateClaudeConfigHomes(explicit?: string | null, homeDir = process.env.HOME ?? ''): string[] {
  const out: string[] = [];
  const add = (p: string | null | undefined) => { if (p && !out.includes(p)) out.push(p); };
  add(explicit);
  add(process.env.CLAUDE_CONFIG_DIR);
  if (homeDir) {
    add(path.join(homeDir, '.claude'));
    try {
      for (const e of fs.readdirSync(homeDir)) {
        if (e.startsWith('.claude-')) add(path.join(homeDir, e));
      }
    } catch { /* @silent-fallback-ok — an unreadable home directory leaves the default candidates */ }
  }
  return out;
}
