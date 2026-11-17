/**
 * Which file does each script-class job in jobs.json execute?
 *
 * A script job's `execute.value` is a shell command run by `/bin/sh -c` from
 * the project directory (the state directory's parent — see
 * JobScheduler.runScriptJob). Backups keep jobs.json; this module lets them
 * also keep (or at least name) the executables those jobs point at, so a
 * restore never brings back a job that is registered but cannot run.
 *
 * The command is tokenised with POSIX quoting rules (single quotes, double
 * quotes, backslash escapes), so `bash ".instar/scripts/my job.sh"` resolves to
 * `.instar/scripts/my job.sh`. Anything the shell would expand at run time
 * (`$VAR`, backticks, globs) cannot be resolved statically and is reported as
 * such rather than guessed at.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Shells and interpreters whose first non-option argument is the script file. */
const INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish',
  'node', 'bun', 'tsx', 'ts-node',
  'python', 'python3', 'ruby', 'perl', 'osascript',
]);
/** Options that mean "the code is inline / a module", not a file. */
const INLINE_FLAGS = new Set(['-c', '-e', '--eval', '-m', '-p', '--print']);
/** Command words that only prefix the real command. */
const PREFIX_WORDS = new Set(['exec', 'command', 'nohup', 'env', 'time']);

export type ScriptExecutableKind =
  /** A file path (absolute, or relative to the project directory). */
  | 'file'
  /** A bare command found on PATH at run time (or inline interpreter code). */
  | 'path-command'
  /** The shell would expand or the command could not be parsed. */
  | 'unresolved';

export interface ScriptExecutable {
  slug: string;
  /** The command as written in jobs.json. */
  command: string;
  kind: ScriptExecutableKind;
  /** For kind 'file': the absolute path the job executes. */
  absolutePath?: string;
  /** For kind 'file' inside the state directory: the stateDir-relative path (forward slashes). */
  stateRelativePath?: string;
  /** For kind 'path-command': the command name. */
  commandName?: string;
}

export interface ScriptExecutableRecord {
  slug: string;
  command: string;
  /** What the job executes: a stateDir-relative path, an absolute path, or a command name. */
  executable: string | null;
  captured: boolean;
  /** Why it was not captured. */
  reason?: string;
}

interface Word {
  text: string;
  /** Contained an unquoted `$`, backtick, or glob character. */
  expands: boolean;
  /** Unquoted leading `~`. */
  tilde: boolean;
  /** Looks like a leading VAR=value assignment (unquoted name and `=`). */
  assignment: boolean;
}

/** Split the first simple command of a shell command line into words. Null when unparseable. */
export function tokenizeFirstCommand(command: string): Word[] | null {
  const words: Word[] = [];
  let cur = '';
  let inWord = false;
  let expands = false;
  let tilde = false;
  let quotedSoFar = false;
  let assignment = false;
  const push = (): void => {
    if (inWord) words.push({ text: cur, expands, tilde, assignment });
    cur = ''; inWord = false; expands = false; tilde = false; quotedSoFar = false; assignment = false;
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === ' ' || ch === '\t') { push(); i++; continue; }
    if (ch === '\n' || ch === ';' || ch === '&' || ch === '|' || ch === '<' || ch === '>' || ch === '(' || ch === ')') {
      // End of the first simple command (a redirection also ends the words we care about).
      if (ch === '(' && !inWord && words.length === 0) return null; // subshell
      break;
    }
    if (ch === '#' && !inWord) break; // comment
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += command.slice(i + 1, end);
      inWord = true; quotedSoFar = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < command.length) {
        const c = command[j];
        if (c === '"') { closed = true; break; }
        if (c === '\\' && j + 1 < command.length && '$`"\\\n'.includes(command[j + 1])) {
          if (command[j + 1] !== '\n') cur += command[j + 1];
          j += 2;
          continue;
        }
        if (c === '$' || c === '`') expands = true;
        cur += c;
        j++;
      }
      if (!closed) return null;
      inWord = true; quotedSoFar = true;
      i = j + 1;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= command.length) return null;
      if (command[i + 1] !== '\n') cur += command[i + 1];
      inWord = true; quotedSoFar = true;
      i += 2;
      continue;
    }
    if (ch === '$' || ch === '`' || ch === '*' || ch === '?' || ch === '[') expands = true;
    if (ch === '~' && !inWord) tilde = true;
    if (ch === '=' && !quotedSoFar && /^[A-Za-z_][A-Za-z0-9_]*$/.test(cur) && words.every((w) => w.assignment)) assignment = true;
    cur += ch;
    inWord = true;
    i++;
  }
  push();
  return words;
}

/** Work out what one script command executes. */
export function resolveScriptCommand(slug: string, command: string, stateDir: string): ScriptExecutable {
  const projectDir = path.dirname(path.resolve(stateDir));
  const unresolved: ScriptExecutable = { slug, command, kind: 'unresolved' };
  const words = tokenizeFirstCommand(command);
  if (!words) return unresolved;
  let idx = 0;
  // Leading assignments and prefix words (`FOO=1 exec env BAR=2 ./x.sh`).
  for (;;) {
    while (idx < words.length && words[idx].assignment) idx++;
    if (idx < words.length && !words[idx].expands && PREFIX_WORDS.has(words[idx].text)) {
      idx++;
      while (idx < words.length && words[idx].text.startsWith('-')) idx++;
      continue;
    }
    break;
  }
  if (idx >= words.length) return unresolved;
  let target = words[idx];
  if (target.expands) return unresolved;
  let viaInterpreter = false;
  if (!target.text.includes('/') && INTERPRETERS.has(target.text)) {
    const interpreter = target.text;
    idx++;
    while (idx < words.length && words[idx].text.startsWith('-') && words[idx].text !== '-') {
      if (INLINE_FLAGS.has(words[idx].text)) return { slug, command, kind: 'path-command', commandName: interpreter };
      idx++;
    }
    if (idx >= words.length) return { slug, command, kind: 'path-command', commandName: interpreter };
    target = words[idx];
    if (target.expands) return unresolved;
    viaInterpreter = true;
  }
  let text = target.text;
  if (text === '' || text === '-') return unresolved;
  if (target.tilde) {
    if (text === '~' || text.startsWith('~/')) text = path.join(os.homedir(), text.slice(1));
    else return unresolved; // ~user
  }
  // A bare first word is looked up on PATH; a bare interpreter argument is a file in the cwd.
  if (!text.includes('/') && !viaInterpreter) return { slug, command, kind: 'path-command', commandName: text };
  const absolutePath = path.resolve(projectDir, text);
  const rel = path.relative(path.resolve(stateDir), absolutePath);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  return {
    slug,
    command,
    kind: 'file',
    absolutePath,
    ...(inside ? { stateRelativePath: rel.split(path.sep).join('/') } : {}),
  };
}

/** The script-class jobs in a jobs.json file's contents. Shipped instar script-runner jobs are excluded (the package restores them). */
export function scriptJobsFromJobsJson(raw: string): Array<{ slug: string; command: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // @silent-fallback-ok — an unparseable jobs.json loads no jobs, so it declares no script executables
  }
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ slug: string; command: string }> = [];
  for (const job of parsed) {
    if (!job || typeof job !== 'object') continue;
    const j = job as { slug?: unknown; origin?: unknown; runner?: unknown; execute?: { type?: unknown; value?: unknown } };
    if (j.execute?.type !== 'script' || typeof j.execute.value !== 'string') continue;
    if (j.origin === 'instar' && j.runner === 'script') continue;
    out.push({ slug: typeof j.slug === 'string' ? j.slug : '(unnamed)', command: j.execute.value });
  }
  return out;
}

/** The script executables of every script job in `<stateDir>/jobs.json`. */
export function scriptJobExecutables(stateDir: string, jobsJsonPath = path.join(stateDir, 'jobs.json')): ScriptExecutable[] {
  let raw: string;
  try {
    raw = fs.readFileSync(jobsJsonPath, 'utf-8');
  } catch {
    return []; // @silent-fallback-ok — no jobs.json means no script jobs to account for
  }
  return scriptJobsFromJobsJson(raw).map((j) => resolveScriptCommand(j.slug, j.command, stateDir));
}

/**
 * Why a file inside the state directory cannot be copied into a snapshot, or
 * null when it can. Every path component below the state directory is
 * lstat'ed: a symlinked directory or file could otherwise pull a file from
 * outside the state directory into the snapshot.
 */
export function uncopyableReason(stateDir: string, stateRelativePath: string): string | null {
  const segments = stateRelativePath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'not a plain path inside the state directory';
  let current = path.resolve(stateDir);
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return 'the executable does not exist';
    }
    if (stat.isSymbolicLink()) return 'the path goes through a symlink, which snapshots never follow';
    if (i < segments.length - 1 && !stat.isDirectory()) return 'the executable does not exist';
    if (i === segments.length - 1 && !stat.isFile()) return 'not a regular file';
  }
  return null;
}

/** The label a record uses for what the job executes. */
export function executableLabel(e: ScriptExecutable): string | null {
  if (e.kind === 'file') return e.stateRelativePath ?? e.absolutePath ?? null;
  if (e.kind === 'path-command') return e.commandName ?? null;
  return null;
}

/** The reason an executable outside the state directory, on PATH, or unresolvable is never captured. */
export function notCapturableReason(e: ScriptExecutable): string | null {
  if (e.kind === 'unresolved') return 'the command could not be resolved to a file without running the shell';
  if (e.kind === 'path-command') return 'runs a command found on PATH; a snapshot does not hold it';
  if (!e.stateRelativePath) return 'the executable lives outside the state directory; a snapshot does not hold it';
  return null;
}
