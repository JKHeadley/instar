/**
 * `instar nuke <name>` — Completely remove a standalone agent.
 * `instar nuke --here` — Remove the project-local install in a project folder.
 *
 * The teardown follows docs/specs/nuke-teardown-narrowing.md. Everything is
 * planned and checked BEFORE anything is torn down:
 *   - the delete plan passes `SafeFsExecutor.checkScope` with its real flags;
 *   - sessions are chosen by today's name rule and then placed by the folder
 *     they started in: inside this home → stopped; inside another agent home
 *     beside it → left running; anywhere else → refused unless named with
 *     `--also-stop <id>`;
 *   - a nested agent home, an unreadable registry, or a failed tmux / launchctl
 *     lookup refuses (never read as "nothing there");
 *   - the auto-start entry is removed only when it points at this home.
 *
 * Then, in order: remove the auto-start entry, stop the server by its recorded
 * id, list sessions again and stop the in-home ones by id (each confirmed with
 * `has-session`), push the git backup (unchanged), back up secrets,
 * unregister, delete. Every step's outcome is collected; any failure is
 * printed with its path and the command exits non-zero instead of claiming
 * removal.
 *
 * Safety:
 *   - Requires explicit confirmation (unless --yes)
 *   - Pushes to git remote before deletion (preserves cloud backup)
 *   - Shows exactly what will be removed before proceeding
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { standaloneAgentsDir } from '../core/Config.js';
import { unregisterAgent } from '../core/AgentRegistry.js';
import { agentRegistryPath } from '../core/AgentRegistryPaths.js';
import { SecretManager } from '../core/SecretManager.js';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { SafeFsExecutor, isSingleComponentName } from '../core/SafeFsExecutor.js';

interface NukeOptions {
  skipConfirm?: boolean;
  /** Session ids (`$N` or `N`) the operator approves stopping although they started outside every agent home. */
  alsoStop?: string[];
}

interface NukeHereOptions {
  dir?: string;
  skipConfirm?: boolean;
  alsoStop?: string[];
}

const PROJECT_LOCAL_ALWAYS_REMOVE = [
  '.instar',
  '.claude',
  '.codex',
  '.mcp.json',
  'instar.config.json',
];

const PROJECT_LOCAL_IDENTITY_SHADOWS = [
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  // .gitignore goes through the same classifier: instar's init writes a
  // fresh .gitignore listing per-machine state paths, but a project may
  // already have one tracked at HEAD. Same rule applies (tracked-clean
  // keep, tracked-modified restore, untracked delete).
  '.gitignore',
];

// ── Refusals and results ────────────────────────────────────────────

/** A refusal before (or during) teardown. `lines` are printed as-is. */
export class NukeRefusal extends Error {
  readonly lines: string[];
  constructor(lines: string[]) {
    super(lines[0] ?? 'nuke refused');
    this.lines = lines;
  }
}

interface StepFailure { step: string; target?: string; detail: string }

interface TeardownResult {
  failures: StepFailure[];
  stopped: string[];
  done: string[];
}

function errText(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const stderr = e?.stderr ? String(e.stderr).trim() : '';
  return stderr || (err instanceof Error ? err.message : String(err));
}

// ── Paths ───────────────────────────────────────────────────────────

/** realpath when the path exists, otherwise lexically normalised. */
export function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // @silent-fallback-ok: a missing folder is compared lexically, per spec §1.
    return resolved;
  }
}

/** True when `child` equals `parent` or sits below it, compared path component by path component. */
export function isPathInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ── Agent homes ─────────────────────────────────────────────────────

/**
 * Other agent homes, per spec §1: every sibling `<instarHome>/agents/<other>`
 * holding a `.instar` directory, plus live registry entries. Neither may equal
 * or contain `H`. A missing registry is empty; an unreadable one refuses.
 */
export function findOtherHomes(H: string, selfName?: string): string[] {
  const homes = new Set<string>();
  const consider = (candidate: string) => {
    const c = canonicalPath(candidate);
    if (c === H || isPathInside(H, c)) return;
    homes.add(c);
  };

  const agentsDir = standaloneAgentsDir();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new NukeRefusal([
        `Refusing: could not read the agents folder ${agentsDir} (${errText(err)}).`,
        'It is needed to tell this agent\'s sessions from other agents\' sessions. Nothing was changed.',
      ]);
    }
  }
  for (const entry of entries) {
    if (selfName !== undefined && entry.name === selfName) continue;
    const full = path.join(agentsDir, entry.name);
    if (!isDir(full)) continue;
    if (!isDir(path.join(full, '.instar'))) continue; // a stray folder is not a home
    consider(full);
  }

  const registryFile = agentRegistryPath();
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(registryFile, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new NukeRefusal([
        `Refusing: the agent registry ${registryFile} could not be read (${errText(err)}).`,
        'It may be the only record of an agent home nested in this one. Nothing was changed.',
      ]);
    }
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new NukeRefusal([
        `Refusing: the agent registry ${registryFile} could not be parsed (${errText(err)}).`,
        'It may be the only record of an agent home nested in this one. Nothing was changed.',
      ]);
    }
    const list = (parsed as { entries?: unknown })?.entries;
    if (!Array.isArray(list)) {
      throw new NukeRefusal([
        `Refusing: the agent registry ${registryFile} has no entries list.`,
        'It may be the only record of an agent home nested in this one. Nothing was changed.',
      ]);
    }
    for (const e of list) {
      const p = (e as { path?: unknown })?.path;
      if (typeof p !== 'string' || !p) continue;
      let real: string;
      try { real = fs.realpathSync(p); } catch { continue; } // stale entry
      if (!fs.existsSync(path.join(real, '.instar', 'config.json'))) continue;
      consider(real);
    }
  }
  return [...homes];
}

const NESTED_SCAN_SKIP = new Set(['node_modules', '.git']);

/**
 * Agent homes inside `H` (spec §1 "Nested homes"): any other home inside H,
 * any folder below H holding `.instar/config.json`, and any
 * `H/.instar/agents/<other>` when `H/.instar` is itself an instar home.
 * The walk never follows symlinks and does not descend into `node_modules`
 * or `.git`. A folder it cannot read refuses.
 */
export function findNestedHomes(H: string, otherHomes: string[]): string[] {
  const nested = new Set<string>();
  for (const home of otherHomes) {
    if (home !== H && isPathInside(home, H)) nested.add(home);
  }
  const agentsUnderState = path.join(H, '.instar', 'agents');
  if (isDir(agentsUnderState)) {
    let subs: fs.Dirent[];
    try {
      subs = fs.readdirSync(agentsUnderState, { withFileTypes: true });
    } catch (err) {
      throw new NukeRefusal([`Refusing: could not read ${agentsUnderState} (${errText(err)}). Nothing was changed.`]);
    }
    for (const s of subs) if (s.isDirectory()) nested.add(path.join(agentsUnderState, s.name));
  }
  const stack = [H];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new NukeRefusal([
        `Refusing: could not read ${dir} while checking for agent homes nested in ${H} (${errText(err)}).`,
        'Nothing was changed.',
      ]);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // Dirent.isDirectory() is false for symlinks
      if (NESTED_SCAN_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (dir !== H && entry.name === '.instar' && fs.existsSync(path.join(full, 'config.json'))) {
        nested.add(dir);
      }
      stack.push(full);
    }
  }
  return [...nested];
}

// ── tmux ────────────────────────────────────────────────────────────

export interface TmuxSession { id: string; name: string; path: string }

/**
 * Session listings use a SPACE after the `$N` id, never a tab: tmux replaces
 * non-printable characters (a tab included) with `_` in format output when it
 * does not run in a UTF-8 locale — measured on tmux 3.7c under the test runner.
 * An id (`$N`) never contains a space, so each line splits on its first space,
 * and the rest of the line (which may contain spaces) is the value. Name and
 * path come from two listings joined by id.
 */
const NAME_FORMAT = '#{session_id} #{session_name}';
const PATH_FORMAT = '#{session_id} #{session_path}';

/** Parse `<$N> <value>` lines into id → value, splitting each line only on its first space. */
export function parseIdValueListing(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const m = /^(\$\d+)(?: (.*))?$/.exec(line);
    if (!m) throw new Error(`unparseable tmux line: ${JSON.stringify(line)}`);
    out.set(m[1], m[2] ?? '');
  }
  return out;
}

/** Join the name and path listings. Throws when they do not list the same ids. */
export function parseSessionListing(namesOut: string, pathsOut: string): TmuxSession[] {
  const names = parseIdValueListing(namesOut);
  const paths = parseIdValueListing(pathsOut);
  if (names.size !== paths.size || [...names.keys()].some(id => !paths.has(id))) {
    throw new Error('the session list changed between the name and path listings');
  }
  return [...names].map(([id, name]) => ({ id, name, path: paths.get(id) as string }));
}

function isNoServerError(err: unknown): boolean {
  const t = errText(err);
  return /no server running/i.test(t) || /error connecting to .*\(No such file or directory\)/i.test(t);
}

function isTmuxMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** One listing; null means "no server running" (or no tmux installed). Other errors throw. */
function listFormat(format: string): string | null {
  try {
    return String(execFileSync('tmux', ['list-sessions', '-F', format], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch (err) {
    if (isNoServerError(err) || isTmuxMissing(err)) return null;
    throw new Error(`tmux list-sessions failed: ${errText(err)}`);
  }
}

/** List sessions. "No server running" (or no tmux installed) is an empty list; any other error throws. */
export function listTmuxSessions(): TmuxSession[] {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const names = listFormat(NAME_FORMAT);
    if (names === null) return [];
    const paths = listFormat(PATH_FORMAT);
    if (paths === null) return []; // the server exited between the two listings
    try {
      return parseSessionListing(names, paths);
    } catch (err) {
      lastError = err; // a session started or ended between the two listings: list again
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Confirm a stop: 'gone' only on tmux's "can't find session" or "no server running". */
export function sessionState(id: string): 'alive' | 'gone' | 'unknown' {
  try {
    execFileSync('tmux', ['has-session', '-t', id], { stdio: 'pipe' });
    return 'alive';
  } catch (err) {
    if (isNoServerError(err) || /can't find session/i.test(errText(err))) return 'gone';
    return 'unknown';
  }
}

/** Stop a session by its `$N` id (one argv element, no shell) and confirm it is gone. */
function stopSessionById(s: TmuxSession, result: TeardownResult): boolean {
  let killError = '';
  try {
    execFileSync('tmux', ['kill-session', '-t', s.id], { stdio: 'pipe' });
  } catch (err) {
    killError = errText(err);
  }
  const state = sessionState(s.id);
  if (state === 'gone') {
    result.stopped.push(`${s.name} (${s.id})`);
    return true;
  }
  result.failures.push({
    step: 'stop session',
    target: `${s.name} (${s.id})`,
    detail: state === 'alive'
      ? `still running after the stop${killError ? ` (${killError})` : ''}`
      : `could not confirm it stopped${killError ? ` (${killError})` : ''}`,
  });
  return false;
}

export function matchesNameRule(sessionName: string, projectName: string): boolean {
  return sessionName === `${projectName}-server` || sessionName.startsWith(`${projectName}-`);
}

export type Placement =
  | { kind: 'inside' }
  | { kind: 'other-home'; home: string }
  | { kind: 'ambiguous' };

/** Place a session by its start folder; the most specific home wins. */
export function placeSession(startPath: string, H: string, otherHomes: string[]): Placement {
  if (!startPath) return { kind: 'ambiguous' };
  const c = canonicalPath(startPath);
  let best: string | null = null;
  for (const home of [H, ...otherHomes]) {
    if (isPathInside(c, home) && (best === null || home.length > best.length)) best = home;
  }
  if (best === null) return { kind: 'ambiguous' };
  if (best === H) return { kind: 'inside' };
  return { kind: 'other-home', home: best };
}

function normaliseIds(ids: string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of ids ?? []) {
    for (const part of String(raw).split(/[\s,]+/)) {
      if (!part) continue;
      out.add(/^\d+$/.test(part) ? `$${part}` : part);
    }
  }
  return out;
}

export interface SessionPlan {
  serverName: string;
  server: TmuxSession | null;
  inside: TmuxSession[];
  skipped: Array<TmuxSession & { home: string }>;
  approved: TmuxSession[];
  alsoStop: Set<string>;
}

function ambiguousRefusal(ambiguous: TmuxSession[], H: string, when: string): string[] {
  const ids = ambiguous.map(s => s.id.replace(/^\$/, '')).join(' ');
  return [
    `Refusing ${when}: these sessions match the agent's name but started outside ${H} and outside every other agent home:`,
    ...ambiguous.map(s => `    ${s.id}  ${s.name}  (started in ${s.path || 'an unknown folder'})`),
    'Where a session starts does not limit where it writes, so nuke will not guess.',
    `If they belong to this agent, run the command again with: --also-stop ${ids}`,
  ];
}

/** Plan-time session decisions (spec §1). Throws NukeRefusal before any teardown. */
export function planSessions(H: string, projectName: string, otherHomes: string[], alsoStopRaw?: string[]): SessionPlan {
  let listing: TmuxSession[];
  try {
    listing = listTmuxSessions();
  } catch (err) {
    throw new NukeRefusal([
      `Refusing: could not list tmux sessions (${errText(err)}).`,
      'A failed listing is never read as "no sessions". Nothing was changed.',
    ]);
  }
  const alsoStop = normaliseIds(alsoStopRaw);
  const serverName = `${projectName}-server`;
  const plan: SessionPlan = { serverName, server: null, inside: [], skipped: [], approved: [], alsoStop };
  const ambiguous: TmuxSession[] = [];
  for (const s of listing) {
    if (!matchesNameRule(s.name, projectName)) continue;
    const place = placeSession(s.path, H, otherHomes);
    if (place.kind === 'inside') plan.inside.push(s);
    else if (place.kind === 'other-home') plan.skipped.push({ ...s, home: place.home });
    else if (alsoStop.has(s.id)) plan.approved.push(s);
    else ambiguous.push(s);
  }
  const ambiguousIds = new Set([...plan.approved, ...ambiguous].map(s => s.id));
  const unknown = [...alsoStop].filter(id => !ambiguousIds.has(id));
  if (unknown.length > 0) {
    throw new NukeRefusal([
      `Refusing: --also-stop names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not on the list of sessions nuke refused to guess about.`,
      '--also-stop only accepts ids that nuke itself listed. Nothing was changed.',
    ]);
  }
  if (ambiguous.length > 0) throw new NukeRefusal(ambiguousRefusal(ambiguous, H, 'before teardown'));
  plan.server = [...plan.inside, ...plan.approved].find(s => s.name === serverName) ?? null;
  return plan;
}

// ── Auto-start entry ────────────────────────────────────────────────

type Pointing = 'absent' | 'home' | 'elsewhere' | 'unknown' | 'conflict';

interface EntryFields { workingDirectory?: string; args?: string[]; needDaemonReload?: boolean }

/** Spec §3: at least one of WorkingDirectory and --dir must be present; every one present must equal H. */
export function classifyEntry(fields: EntryFields | null, H: string): Pointing {
  if (!fields) return 'absent';
  const dirs: string[] = [];
  if (fields.workingDirectory) dirs.push(fields.workingDirectory);
  const args = fields.args ?? [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) dirs.push(args[i + 1]);
    else if (args[i].startsWith('--dir=')) dirs.push(args[i].slice('--dir='.length));
  }
  if (fields.needDaemonReload) return 'conflict';
  if (dirs.length === 0) return 'unknown';
  const canon = new Set(dirs.map(canonicalPath));
  if (canon.size > 1) return 'conflict';
  return canon.has(H) ? 'home' : 'elsewhere';
}

/**
 * Parse `launchctl list <label>` output (an old-style property list) for its
 * ProgramArguments. Throws when the output is not the expected shape.
 */
export function parseLaunchctlList(stdout: string): { programArguments?: string[]; label?: string } {
  const text = stdout.trim();
  if (!text.startsWith('{') || !text.endsWith('};')) throw new Error('launchctl list output is not a property list');
  const readQuoted = (s: string, start: number): { value: string; end: number } => {
    if (s[start] !== '"') throw new Error('expected a quoted string');
    let value = '';
    let i = start + 1;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\') { value += s[i + 1] ?? ''; i += 2; continue; }
      if (ch === '"') return { value, end: i + 1 };
      value += ch;
      i++;
    }
    throw new Error('unterminated string');
  };
  const out: { programArguments?: string[]; label?: string } = {};
  const labelMatch = /^\s*"Label"\s*=\s*/m.exec(text);
  if (labelMatch) {
    const start = text.indexOf('"', labelMatch.index + labelMatch[0].length - 1);
    out.label = readQuoted(text, start).value;
  }
  const key = /^\s*"ProgramArguments"\s*=\s*\(/m.exec(text);
  if (key) {
    const args: string[] = [];
    let i = key.index + key[0].length;
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith(');', i)) break;
      if (i >= text.length) throw new Error('unterminated ProgramArguments');
      const q = readQuoted(text, i);
      args.push(q.value);
      i = q.end;
      while (i < text.length && /[ \t]/.test(text[i])) i++;
      if (text[i] !== ';') throw new Error('expected ; after a ProgramArguments item');
      i++;
    }
    out.programArguments = args;
  } else if (/"ProgramArguments"/.test(text)) {
    throw new Error('ProgramArguments present but not parseable');
  }
  return out;
}

/** Parse `systemctl --user show -p ...` output into a key → value map. */
export function parseSystemctlShow(stdout: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    map[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return map;
}

/** argv from a systemd ExecStart= value, either the unit-file form or the `show` form. */
export function execStartArgs(value: string): string[] {
  const m = /argv\[\]=(.*?)\s;\s/.exec(value);
  const raw = m ? m[1] : value;
  return raw.trim().split(/\s+/).filter(Boolean);
}

function parseUnitFile(text: string): EntryFields {
  const fields: EntryFields = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(WorkingDirectory|ExecStart)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'WorkingDirectory') fields.workingDirectory = m[2].trim().replace(/^-/, '');
    else fields.args = execStartArgs(m[2].replace(/^[-@+!:]+/, ''));
  }
  return fields;
}

export interface AutoStartPlan {
  platform: 'darwin' | 'linux' | 'none';
  label: string;
  filePath: string;
  file: Pointing;
  loaded: Pointing;
  removeFile: boolean;
  removeLoaded: boolean;
  notes: string[];
}

function uid(): number {
  return process.getuid?.() ?? 501;
}

/** 'loaded' | 'absent'; throws on any other launchctl print failure. */
function launchdLoaded(label: string): boolean {
  try {
    execFileSync('launchctl', ['print', `gui/${uid()}/${label}`], { stdio: 'pipe' });
    return true;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 113 || /could not find service/i.test(errText(err))) return false;
    throw new Error(`launchctl print failed: ${errText(err)}`);
  }
}

/**
 * Read the auto-start entry and decide (spec §3). Throws NukeRefusal when the
 * lookup is indeterminate or the entry could restart the server mid-teardown.
 */
export function planAutoStart(projectName: string, H: string): AutoStartPlan {
  const refuse = (msg: string) => new NukeRefusal([`Refusing: ${msg}`, 'Nothing was changed.']);
  if (process.platform === 'darwin') {
    const label = `ai.instar.${projectName}`;
    const filePath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    let fileFields: EntryFields | null = null;
    if (fs.existsSync(filePath)) {
      try {
        const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', filePath], {
          encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        }) as unknown as string;
        const data = JSON.parse(String(json)) as { WorkingDirectory?: unknown; ProgramArguments?: unknown };
        fileFields = {
          workingDirectory: typeof data.WorkingDirectory === 'string' ? data.WorkingDirectory : undefined,
          args: Array.isArray(data.ProgramArguments) ? data.ProgramArguments.map(String) : undefined,
        };
      } catch (err) {
        throw refuse(`the auto-start file ${filePath} could not be read (${errText(err)}).`);
      }
    }
    let loaded: boolean;
    try {
      loaded = launchdLoaded(label);
    } catch (err) {
      throw refuse(`could not tell whether the auto-start job ${label} is loaded (${errText(err)}).`);
    }
    let loadedFields: EntryFields | null = null;
    if (loaded) {
      try {
        const listing = execFileSync('launchctl', ['list', label], {
          encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        }) as unknown as string;
        loadedFields = { args: parseLaunchctlList(String(listing)).programArguments };
      } catch (err) {
        throw refuse(`could not read the loaded auto-start job ${label} (${errText(err)}).`);
      }
    }
    return decideAutoStart('darwin', label, filePath, classifyEntry(fileFields, H), classifyEntry(loadedFields, H), H);
  }
  if (process.platform === 'linux') {
    const label = `instar-${projectName}.service`;
    const filePath = path.join(os.homedir(), '.config', 'systemd', 'user', label);
    let fileFields: EntryFields | null = null;
    try {
      fileFields = parseUnitFile(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw refuse(`the auto-start unit ${filePath} could not be read (${errText(err)}).`);
      }
    }
    let show: Record<string, string>;
    try {
      show = parseSystemctlShow(String(execFileSync('systemctl', [
        '--user', 'show', '-p', 'LoadState,ActiveState,WorkingDirectory,ExecStart,NeedDaemonReload', label,
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })));
    } catch (err) {
      throw refuse(`could not read the running unit ${label} (${errText(err)}).`);
    }
    const active = show.ActiveState && !['inactive', 'failed'].includes(show.ActiveState);
    const loaded = show.LoadState === 'loaded' || Boolean(active);
    const loadedFields: EntryFields | null = loaded
      ? {
          workingDirectory: show.WorkingDirectory ? show.WorkingDirectory.replace(/^[-!]+/, '') : undefined,
          args: show.ExecStart ? execStartArgs(show.ExecStart) : undefined,
          needDaemonReload: show.NeedDaemonReload === 'yes',
        }
      : null;
    return decideAutoStart('linux', label, filePath, classifyEntry(fileFields, H), classifyEntry(loadedFields, H), H);
  }
  return { platform: 'none', label: '', filePath: '', file: 'absent', loaded: 'absent', removeFile: false, removeLoaded: false, notes: [] };
}

export function decideAutoStart(
  platform: 'darwin' | 'linux', label: string, filePath: string, file: Pointing, loaded: Pointing, H: string,
): AutoStartPlan {
  const plan: AutoStartPlan = { platform, label, filePath, file, loaded, removeFile: false, removeLoaded: false, notes: [] };
  const refuse = (why: string) => new NukeRefusal([
    `Refusing: the auto-start entry ${label} ${why}`,
    `  file: ${filePath} (${file}); loaded job: ${loaded}`,
    'A running auto-start job could restart the server in the middle of the teardown. Nothing was changed.',
  ]);
  if (loaded === 'conflict') throw refuse('is loaded and its settings contradict each other.');
  if (loaded !== 'absent' && file === 'conflict') throw refuse('is loaded and its file\'s settings contradict each other.');
  if (loaded === 'home' && file !== 'absent' && file !== 'home') throw refuse(`is loaded and points at ${H}, but its file does not.`);
  if (file === 'absent' && loaded === 'absent') return plan;
  if (file === 'home' && (loaded === 'home' || loaded === 'absent')) {
    plan.removeFile = true;
    plan.removeLoaded = loaded === 'home';
    return plan;
  }
  if (file === 'absent' && loaded === 'home') {
    plan.removeLoaded = true;
    return plan;
  }
  plan.notes.push(
    `Auto-start entry ${label} left in place: it does not point only at ${H} (file: ${file}, loaded job: ${loaded}).`,
  );
  return plan;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Remove the parts the plan marked, verifying each. Throws on any part that is not confirmed gone. */
export function removeAutoStart(plan: AutoStartPlan): void {
  if (plan.platform === 'darwin') {
    if (plan.removeLoaded) {
      try {
        execFileSync('launchctl', ['bootout', `gui/${uid()}/${plan.label}`], { stdio: 'pipe' });
      } catch { /* @silent-fallback-ok: verified by the print check below */ }
      let gone = false;
      for (let i = 0; i < 10 && !gone; i++) {
        try {
          gone = !launchdLoaded(plan.label);
        } catch (err) {
          throw new Error(`could not confirm ${plan.label} was unloaded (${errText(err)})`);
        }
        if (!gone) sleepMs(200);
      }
      if (!gone) throw new Error(`${plan.label} is still loaded after launchctl bootout`);
    }
    if (plan.removeFile) {
      try {
        SafeFsExecutor.safeUnlinkSync(plan.filePath, { operation: 'src/commands/nuke.ts:removeAutoStart' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`could not delete ${plan.filePath} (${errText(err)})`);
      }
      if (fs.existsSync(plan.filePath)) throw new Error(`${plan.filePath} is still present`);
    }
    return;
  }
  if (plan.platform === 'linux') {
    if (plan.removeLoaded) {
      try {
        execFileSync('systemctl', ['--user', 'stop', plan.label], { stdio: 'pipe' });
      } catch (err) {
        throw new Error(`systemctl stop ${plan.label} failed (${errText(err)})`);
      }
    }
    if (plan.removeFile) {
      try {
        execFileSync('systemctl', ['--user', 'disable', plan.label], { stdio: 'pipe' });
      } catch (err) {
        throw new Error(`systemctl disable ${plan.label} failed (${errText(err)})`);
      }
      try {
        SafeFsExecutor.safeUnlinkSync(plan.filePath, { operation: 'src/commands/nuke.ts:removeAutoStart' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`could not delete ${plan.filePath} (${errText(err)})`);
      }
      try {
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
      } catch (err) {
        throw new Error(`systemctl daemon-reload failed (${errText(err)})`);
      }
      if (fs.existsSync(plan.filePath)) throw new Error(`${plan.filePath} is still present`);
    }
    if (plan.removeLoaded || plan.removeFile) {
      let state = '';
      try {
        state = String(execFileSync('systemctl', ['--user', 'is-active', plan.label], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })).trim();
      } catch (err) {
        state = String((err as { stdout?: Buffer | string }).stdout ?? '').trim();
      }
      if (state !== 'inactive' && state !== 'failed') throw new Error(`${plan.label} is not confirmed stopped (is-active: ${state || 'no answer'})`);
    }
  }
}

// ── Delete plan ─────────────────────────────────────────────────────

interface PlannedDelete {
  target: string;
  label: string;
  recursive: boolean;
  force: boolean;
  operation: string;
  nukeAgentHomeScope?: { agentName: string };
  suppressAudit?: boolean;
}

/** Spec §4: every planned delete goes through the side-effect-free scope check with its real flags. */
function checkDeletePlan(deletes: PlannedDelete[]): void {
  const refused: string[] = [];
  for (const d of deletes) {
    const decision = SafeFsExecutor.checkScope(d.target, {
      recursive: d.recursive,
      force: d.force,
      operation: d.operation,
      nukeAgentHomeScope: d.nukeAgentHomeScope,
    });
    if (!decision.allowed) refused.push(`    ${d.target}: ${decision.reason}`);
  }
  if (refused.length > 0) {
    throw new NukeRefusal(['Refusing: the safety guard would refuse these deletes:', ...refused, 'Nothing was changed.']);
  }
}

function runDelete(d: PlannedDelete, result: TeardownResult): void {
  const prevAudit = process.env.INSTAR_AUDIT_LOG_DISABLED;
  if (d.suppressAudit) process.env.INSTAR_AUDIT_LOG_DISABLED = '1';
  try {
    SafeFsExecutor.safeRmSync(d.target, {
      recursive: d.recursive,
      force: d.force,
      operation: d.operation,
      nukeAgentHomeScope: d.nukeAgentHomeScope,
    });
    if (fs.existsSync(d.target)) {
      result.failures.push({ step: 'delete', target: d.target, detail: 'still present after the delete' });
    } else {
      result.done.push(`Removed ${d.label}`);
      console.log(`  ${pc.green('✓')} Removed ${d.label}`);
    }
  } catch (err) {
    result.failures.push({ step: 'delete', target: d.target, detail: errText(err) });
  } finally {
    if (d.suppressAudit) {
      if (prevAudit === undefined) delete process.env.INSTAR_AUDIT_LOG_DISABLED;
      else process.env.INSTAR_AUDIT_LOG_DISABLED = prevAudit;
    }
  }
}

// ── Shared teardown ─────────────────────────────────────────────────

interface TeardownPlan {
  H: string;
  projectName: string;
  sessions: SessionPlan;
  otherHomes: string[];
  autoStart: AutoStartPlan;
}

/** Plan everything before anything is torn down. Throws NukeRefusal. */
function planTeardown(H: string, projectName: string, selfName: string | undefined, alsoStop: string[] | undefined, deletes: PlannedDelete[]): TeardownPlan {
  const otherHomes = findOtherHomes(H, selfName);
  const nested = findNestedHomes(H, otherHomes);
  if (nested.length > 0) {
    throw new NukeRefusal([
      `Refusing: another agent home is inside ${H}:`,
      ...nested.map(n => `    ${n}`),
      'Deleting this folder would delete that agent\'s files while its sessions keep running. Nothing was changed.',
    ]);
  }
  const sessions = planSessions(H, projectName, otherHomes, alsoStop);
  const autoStart = planAutoStart(projectName, H);
  checkDeletePlan(deletes);
  return { H, projectName, sessions, otherHomes, autoStart };
}

function printPlanSessions(plan: TeardownPlan): void {
  const toStop = [...plan.sessions.inside, ...plan.sessions.approved];
  for (const s of toStop) {
    console.log(`  ${pc.red('x')} Session: ${pc.dim(`${s.name} (${s.id})`)}`);
  }
  for (const s of plan.sessions.skipped) {
    console.log(`  ${pc.green('-')} Left running: ${pc.dim(`${s.name} (${s.id}) — it belongs to ${s.home}`)}`);
  }
  const a = plan.autoStart;
  if (a.removeFile || a.removeLoaded) {
    console.log(`  ${pc.red('x')} Auto-start entry: ${pc.dim(a.label)}`);
  }
  for (const note of a.notes) console.log(`  ${pc.yellow('!')} ${note}`);
}

function printPartialState(result: TeardownResult): void {
  console.log(pc.dim('  What was done before stopping:'));
  if (result.done.length === 0 && result.stopped.length === 0) console.log(pc.dim('    nothing'));
  for (const d of result.done) console.log(pc.dim(`    ${d}`));
  for (const s of result.stopped) console.log(pc.dim(`    Stopped ${s}`));
}

/**
 * Remove the auto-start entry, stop the server by its recorded id, list again
 * and stop the in-home sessions by id. Returns false when the deletes must be
 * refused (failures are recorded in `result`).
 */
function stopEverything(plan: TeardownPlan, result: TeardownResult): boolean {
  // 1. Auto-start entry first, so the lifeline cannot restart the server.
  const a = plan.autoStart;
  if (a.removeFile || a.removeLoaded) {
    try {
      removeAutoStart(a);
      result.done.push(`Removed auto-start entry ${a.label}`);
      console.log(`  ${pc.green('✓')} Removed auto-start`);
    } catch (err) {
      result.failures.push({ step: 'remove auto-start', target: a.filePath, detail: errText(err) });
      return false; // no session is stopped
    }
  }

  // 2. The server, by the id recorded at plan time.
  const server = plan.sessions.server;
  if (server) {
    if (!stopSessionById(server, result)) return false;
    console.log(`  ${pc.green('✓')} Stopped server`);
  }

  // 3. The second list: catches sessions started at the last moment.
  let listing: TmuxSession[];
  try {
    listing = listTmuxSessions();
  } catch (err) {
    result.failures.push({ step: 'list sessions', detail: `${errText(err)} — a failed listing is never read as "no sessions"` });
    return false;
  }
  const toStop: TmuxSession[] = [];
  const newAmbiguous: TmuxSession[] = [];
  for (const s of listing) {
    if (!matchesNameRule(s.name, plan.projectName)) continue;
    if (server && s.id === server.id) continue; // its stop was already confirmed
    const place = placeSession(s.path, plan.H, plan.otherHomes);
    if (place.kind === 'other-home') {
      console.log(`  ${pc.green('-')} Left running ${s.name} (${s.id}) — it belongs to ${place.home}`);
      continue;
    }
    if (s.name === plan.sessions.serverName) {
      // Only the server id recorded at plan time may be stopped.
      result.failures.push({
        step: 'stop sessions',
        target: `${s.name} (${s.id})`,
        detail: 'a server session that was not in the plan appeared — something restarted the server',
      });
      continue;
    }
    if (place.kind === 'inside') toStop.push(s);
    else if (plan.sessions.alsoStop.has(s.id)) toStop.push(s);
    else newAmbiguous.push(s);
  }
  if (newAmbiguous.length > 0) {
    for (const line of ambiguousRefusal(newAmbiguous, plan.H, 'the deletes')) console.log(pc.red(`  ${line}`));
    result.failures.push({ step: 'stop sessions', detail: `${newAmbiguous.length} session(s) outside every agent home were not named with --also-stop` });
  }
  if (result.failures.length > 0) return false;

  let ok = true;
  for (const s of toStop) {
    if (!stopSessionById(s, result)) ok = false;
  }
  if (toStop.length > 0 && ok) console.log(`  ${pc.green('✓')} Stopped ${toStop.length} spawned session(s)`);
  return ok;
}

function backupSecrets(configPath: string, agentName: string): void {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const secretMgr = new SecretManager({ agentName });
    secretMgr.initialize();
    const telegramEntry = config.messaging?.find?.((m: { type: string }) => m.type === 'telegram');
    if (telegramEntry?.config) {
      // String-type guards reject the { secret: true } placeholder produced by
      // SecretMigrator after multi-machine pairing — the real values are already
      // in the encrypted store in that case, so backing up the placeholder
      // would silently corrupt the backup.
      const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
      secretMgr.backupFromConfig({
        telegramToken: asStr(telegramEntry.config.token),
        telegramChatId: asStr(telegramEntry.config.chatId),
        authToken: asStr(config.authToken),
        dashboardPin: asStr(config.dashboardPin),
        tunnelToken: asStr(config.tunnel?.token),
      });
      console.log(`  ${pc.green('✓')} Secrets backed up (will auto-restore on reinstall)`);
    }
  } catch {
    // @silent-fallback-ok: non-fatal as before — the store may not be configured.
  }
}

function unregisterStep(registryPath: string, result: TeardownResult): void {
  try {
    unregisterAgent(registryPath); // an absent registration is not an error
    result.done.push('Removed from agent registry');
    console.log(`  ${pc.green('✓')} Removed from agent registry`);
  } catch (err) {
    result.failures.push({ step: 'unregister', target: registryPath, detail: errText(err) });
  }
}

function reportFailures(result: TeardownResult, what: string): void {
  console.log();
  console.log(pc.red(`  ${what} was NOT fully removed. These steps failed:`));
  for (const f of result.failures) {
    console.log(pc.red(`    ${f.step}${f.target ? ` — ${f.target}` : ''}: ${f.detail}`));
  }
  printPartialState(result);
  console.log();
  process.exit(1);
}

function refuseAndExit(err: unknown): never {
  if (err instanceof NukeRefusal) {
    console.log();
    for (const line of err.lines) console.log(pc.red(`  ${line}`));
    console.log();
    process.exit(1);
  }
  throw err;
}

/** Spec §4 precondition: H must be a real directory, not a symlink. */
function assertRealDirectory(p: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    throw new NukeRefusal([`Refusing: ${p} could not be checked (${errText(err)}). Nothing was changed.`]);
  }
  if (st.isSymbolicLink()) throw new NukeRefusal([`Refusing: ${p} is a symlink, not the agent's real folder. Nothing was changed.`]);
  if (!st.isDirectory()) throw new NukeRefusal([`Refusing: ${p} is not a folder. Nothing was changed.`]);
}

// ── nuke <name> ─────────────────────────────────────────────────────

export async function nukeAgent(name: string, options: NukeOptions = {}): Promise<void> {
  if (!isSingleComponentName(name)) {
    console.log(pc.red(`  "${name}" is not an agent name. An agent name is one folder name (no "/", not "." or "..").`));
    process.exit(1);
  }
  const agentDir = path.join(standaloneAgentsDir(), name);
  const stateDir = path.join(agentDir, '.instar');
  const configPath = path.join(stateDir, 'config.json');

  // Verify agent exists
  if (!fs.existsSync(configPath)) {
    console.log(pc.red(`  Agent "${name}" not found at ${agentDir}`));
    console.log(pc.dim(`  Standalone agents live at: ${standaloneAgentsDir()}/`));
    process.exit(1);
  }

  // Load config for project name
  let projectName = name;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    projectName = config.projectName || name;
  } catch {
    // @silent-fallback-ok: use name as fallback, as before.
  }

  let plan: TeardownPlan;
  try {
    assertRealDirectory(agentDir);
    const H = fs.realpathSync(agentDir);
    plan = planTeardown(H, projectName, name, options.alsoStop, [{
      target: agentDir,
      label: agentDir,
      recursive: true,
      force: true,
      operation: 'src/commands/nuke.ts:nukeAgent-delete-home',
      nukeAgentHomeScope: { agentName: name },
    }]);
  } catch (err) {
    refuseAndExit(err);
  }

  // Check what exists
  const hasGit = fs.existsSync(path.join(agentDir, '.git'));
  const hasRemote = hasGit && hasGitRemote(agentDir);

  // Show what will be removed
  console.log();
  console.log(pc.bold(pc.red('  This will permanently remove:')));
  console.log();
  console.log(`  ${pc.red('x')} Agent directory: ${pc.dim(agentDir)}`);
  console.log(`  ${pc.red('x')} All agent data: memories, relationships, config, logs`);
  printPlanSessions(plan);
  console.log(`  ${pc.red('x')} Agent registry entry`);

  if (hasGit && hasRemote) {
    console.log();
    console.log(`  ${pc.green('~')} Git remote backup will be ${pc.bold('preserved')} (we'll push before deleting)`);
  } else if (hasGit && !hasRemote) {
    console.log();
    console.log(pc.yellow(`  ! Local git repo exists but has NO remote — data will be permanently lost`));
  }

  console.log();

  // Confirm
  if (!options.skipConfirm) {
    try {
      const { confirm } = await import('@inquirer/prompts');
      const confirmed = await confirm({
        message: `Remove agent "${name}" and all its data? This cannot be undone.`,
        default: false,
      });
      if (!confirmed) {
        console.log(pc.dim('  Cancelled.'));
        return;
      }
    } catch {
      console.log(pc.dim('  Cancelled.'));
      return;
    }
  }

  console.log();
  const result: TeardownResult = { failures: [], stopped: [], done: [] };

  // Steps 1-2: auto-start entry, then the server and sessions.
  if (!stopEverything(plan, result)) {
    reportFailures(result, `Agent "${name}"`);
    return;
  }

  // Step 3: Push to git remote (preserve cloud backup) — unchanged.
  if (hasGit && hasRemote) {
    try {
      // Stage and commit any uncommitted changes
      SafeGitExecutor.execSync(['add', '-A'], { cwd: agentDir, stdio: 'pipe', operation: 'src/commands/nuke.ts:143' });
      const status = SafeGitExecutor.readSync(['status', '--porcelain'], { cwd: agentDir,
        encoding: 'utf-8',
        stdio: 'pipe', operation: 'src/commands/nuke.ts:145' }).trim();

      if (status) {
        SafeGitExecutor.execSync(['commit', '-m', 'final backup before nuke'], { cwd: agentDir,
          stdio: 'pipe', operation: 'src/commands/nuke.ts:153' });
      }

      SafeGitExecutor.execSync(['push'], { cwd: agentDir, stdio: 'pipe', timeout: 30_000, operation: 'src/commands/nuke.ts:160' });
      console.log(`  ${pc.green('✓')} Pushed final backup to remote`);
    } catch {
      console.log(pc.yellow('  Could not push final backup (remote may be unavailable)'));
    }
  }

  // Step 4: Back up secrets before deletion
  backupSecrets(configPath, name);

  // Step 5: Remove from agent registry
  unregisterStep(agentDir, result);

  // Step 6: Delete the agent directory
  runDelete({
    target: agentDir,
    label: agentDir,
    recursive: true,
    force: true,
    operation: 'src/commands/nuke.ts:nukeAgent-delete-home',
    nukeAgentHomeScope: { agentName: name },
  }, result);

  if (result.failures.length > 0) {
    reportFailures(result, `Agent "${name}"`);
    return;
  }

  console.log();
  console.log(pc.green(`  Agent "${name}" has been removed.`));
  if (hasGit && hasRemote) {
    console.log(pc.dim('  Your cloud backup is still available on GitHub.'));
    console.log(pc.dim(`  To restore: git clone <repo-url> ${agentDir} && instar server start ${name}`));
  }
  console.log();
}

/**
 * `instar nuke --here` — Remove the project-local instar install in cwd.
 *
 * Sibling of nukeAgent for project-bound installs (the result of
 * `npx instar setup` inside a project directory). See
 * `specs/dev-infrastructure/nuke-here.md` for the full design.
 */
export async function nukeHere(options: NukeHereOptions = {}): Promise<void> {
  const dir = path.resolve(options.dir || process.cwd());
  const stateDir = path.join(dir, '.instar');
  const configPath = path.join(stateDir, 'config.json');

  if (isInstarSourceRepo(dir)) {
    console.log(pc.red('  Refusing to nuke the instar source repo.'));
    console.log(pc.dim('  --here removes an installed agent in a project directory.'));
    console.log(pc.dim('  The instar source checkout is not an agent install.'));
    process.exit(1);
  }

  if (!fs.existsSync(configPath)) {
    console.log(pc.red(`  No instar install found at ${dir}`));
    console.log(pc.dim('  Expected: .instar/config.json'));
    console.log(pc.dim('  (Standalone agents live under ~/.instar/agents/ — use `instar nuke <name>` for those.)'));
    process.exit(1);
  }

  let projectName = path.basename(dir);
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    projectName = config.projectName || projectName;
  } catch {
    // @silent-fallback-ok: fall back to basename, as before.
  }

  const isGitRepo = fs.existsSync(path.join(dir, '.git'));

  const presentAlwaysRemove = PROJECT_LOCAL_ALWAYS_REMOVE.filter(rel =>
    fs.existsSync(path.join(dir, rel)),
  );
  const presentShadows = PROJECT_LOCAL_IDENTITY_SHADOWS.filter(rel =>
    fs.existsSync(path.join(dir, rel)),
  );

  // Decide shadow disposition up front so the plan can show it.
  const shadowDispositions: Array<{ file: string; action: 'keep' | 'restore' | 'delete' }> = [];
  for (const rel of presentShadows) {
    shadowDispositions.push({ file: rel, action: classifyShadowFile(dir, rel, isGitRepo) });
  }

  // The full delete plan, with each delete's real flags, in execution order.
  //
  // Order matters: SafeFsExecutor + SafeGitExecutor both write to
  // .instar/audit/destructive-ops.jsonl on every operation. If .instar
  // is deleted first, every subsequent destructive op recreates
  // .instar/audit/ to log its entry, leaving a ghost .instar directory
  // behind. So: identity-shadow files first, non-.instar always-remove
  // paths second, .instar LAST with audit logging suppressed for that op.
  const deletes: PlannedDelete[] = [];
  for (const { file, action } of shadowDispositions) {
    if (action !== 'delete') continue;
    deletes.push({
      target: path.join(dir, file), label: file, recursive: false, force: true,
      operation: 'src/commands/nuke.ts:nukeHere-delete-shadow',
    });
  }
  for (const rel of presentAlwaysRemove.filter(r => r !== '.instar')) {
    deletes.push({
      target: path.join(dir, rel), label: rel, recursive: true, force: true,
      operation: 'src/commands/nuke.ts:nukeHere-delete-always',
    });
  }
  if (presentAlwaysRemove.includes('.instar')) {
    // .instar IS the audit log location, so a final audit-write would
    // recreate the directory being deleted.
    deletes.push({
      target: path.join(dir, '.instar'), label: '.instar', recursive: true, force: true,
      operation: 'src/commands/nuke.ts:nukeHere-delete-dot-instar', suppressAudit: true,
    });
  }

  let plan: TeardownPlan;
  try {
    assertRealDirectory(dir);
    plan = planTeardown(fs.realpathSync(dir), projectName, undefined, options.alsoStop, deletes);
  } catch (err) {
    refuseAndExit(err);
  }

  console.log();
  console.log(pc.bold(pc.red('  This will remove instar from this project:')));
  console.log();
  console.log(`  Project: ${pc.cyan(projectName)}`);
  console.log(`  Directory: ${pc.dim(dir)}`);
  console.log();
  console.log('  Artifacts to remove:');
  for (const rel of presentAlwaysRemove) {
    console.log(`  ${pc.red('x')} ${rel}`);
  }
  for (const { file, action } of shadowDispositions) {
    if (action === 'delete') {
      console.log(`  ${pc.red('x')} ${file} ${pc.dim('(created by instar)')}`);
    } else if (action === 'restore') {
      console.log(`  ${pc.yellow('~')} ${file} ${pc.dim('(restoring to git HEAD)')}`);
    } else {
      console.log(`  ${pc.dim('-')} ${file} ${pc.dim('(pre-existing, kept)')}`);
    }
  }
  printPlanSessions(plan);
  console.log(`  ${pc.red('x')} Agent registry entry (if any)`);
  console.log(`  ${pc.green('~')} Secrets backed up (auto-restored on next setup)`);
  console.log();

  if (!options.skipConfirm) {
    try {
      const { confirm } = await import('@inquirer/prompts');
      const confirmed = await confirm({
        message: `Remove instar from "${projectName}"? This cannot be undone.`,
        default: false,
      });
      if (!confirmed) {
        console.log(pc.dim('  Cancelled.'));
        return;
      }
    } catch {
      console.log(pc.dim('  Cancelled.'));
      return;
    }
  }

  console.log();
  const result: TeardownResult = { failures: [], stopped: [], done: [] };

  // 1-2. Auto-start entry, then the server and sessions.
  if (!stopEverything(plan, result)) {
    reportFailures(result, `instar in "${projectName}"`);
    return;
  }

  // 3. Back up secrets
  backupSecrets(configPath, projectName);

  // 4. Unregister from agent registry
  unregisterStep(dir, result);

  // 5. Filesystem teardown: restores and keeps, then the planned deletes in order.
  for (const { file, action } of shadowDispositions) {
    if (action === 'keep') {
      console.log(`  ${pc.dim('-')} Kept ${file} (pre-existing)`);
    } else if (action === 'restore') {
      try {
        SafeGitExecutor.execSync(['checkout', 'HEAD', '--', file], {
          cwd: dir,
          stdio: 'pipe',
          operation: 'src/commands/nuke.ts:nukeHere-restore-shadow',
        });
        result.done.push(`Restored ${file} to git HEAD`);
        console.log(`  ${pc.green('↺')} Restored ${file} to git HEAD`);
      } catch (err) {
        result.failures.push({ step: 'restore', target: path.join(dir, file), detail: errText(err) });
      }
    }
  }
  for (const d of deletes) runDelete(d, result);

  if (result.failures.length > 0) {
    reportFailures(result, `instar in "${projectName}"`);
    return;
  }

  console.log();
  console.log(pc.green(`  instar has been removed from "${projectName}".`));
  console.log(pc.dim('  Run `npx instar` to reinstall.'));
  console.log();
}

/**
 * Returns true when `dir` is the instar source repo (package.json name ===
 * "instar" AND src/cli.ts is present). Conservative — must match BOTH to
 * avoid false positives in projects that happen to be named "instar."
 */
export function isInstarSourceRepo(dir: string): boolean {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg.name !== 'instar') return false;
  } catch {
    return false;
  }
  return fs.existsSync(path.join(dir, 'src', 'cli.ts'));
}

/**
 * Classifies an identity-shadow file (CLAUDE.md / AGENTS.md / GEMINI.md)
 * for `nuke --here` disposition:
 *   - 'keep'    — tracked by git at HEAD with no working-tree diff (pre-existing)
 *   - 'restore' — tracked by git at HEAD with a diff (instar modified)
 *   - 'delete'  — not tracked, or not in a git repo (instar created)
 *
 * Exported for unit testing.
 */
export function classifyShadowFile(
  dir: string,
  relPath: string,
  isGitRepo: boolean,
): 'keep' | 'restore' | 'delete' {
  if (!isGitRepo) return 'delete';
  let tracked = false;
  try {
    SafeGitExecutor.readSync(['ls-files', '--error-unmatch', relPath], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: 'pipe',
      operation: 'src/commands/nuke.ts:classifyShadowFile-ls',
    });
    tracked = true;
  } catch {
    tracked = false;
  }
  if (!tracked) return 'delete';
  let dirty = '';
  try {
    dirty = SafeGitExecutor.readSync(['status', '--porcelain', relPath], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: 'pipe',
      operation: 'src/commands/nuke.ts:classifyShadowFile-status',
    }).trim();
  } catch {
    return 'restore';
  }
  return dirty ? 'restore' : 'keep';
}

function hasGitRemote(dir: string): boolean {
  try {
    const remote = SafeGitExecutor.readSync(['remote'], { cwd: dir,
      encoding: 'utf-8',
      stdio: 'pipe', operation: 'src/commands/nuke.ts:218' }).trim();
    return remote.length > 0;
  } catch {
    return false;
  }
}
