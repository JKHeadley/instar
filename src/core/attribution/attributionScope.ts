/**
 * Which files the write gate and the audit look at. Spec section 5. Paths are compared after
 * realpath, because the memory folder is a symlink and a link must not get round the scope.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_MD_CORE_END, CLAUDE_MD_CORE_START_PREFIX } from '../../scaffold/claudeMdLayout.js';

export interface ScopeOptions {
  projectDir: string;
  stateDir: string;
  /** `attribution.paths`. Each is confined to roots under the agent home. */
  extraPaths?: string[];
}

/** Resolves links on the part of the path that exists, so a file about to be created still maps. */
export function realpathLoose(target: string): string {
  const absolute = path.resolve(target);
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

interface ResolvedScope { files: string[]; dirs: string[]; projectMemorySegment: string }

export function resolveScope(options: ScopeOptions): ResolvedScope {
  const project = realpathLoose(options.projectDir);
  const state = realpathLoose(options.stateDir);
  const files = ['MEMORY.md', 'USER.md', 'AGENT.md'].map((name) => path.join(state, name));
  files.push(path.join(project, 'CLAUDE.md'));
  const dirs = [path.join(state, 'agent-memory'), path.join(project, '.claude', 'rules')];
  for (const extra of options.extraPaths ?? []) {
    if (typeof extra !== 'string' || !extra.trim()) continue;
    const resolved = realpathLoose(path.resolve(project, extra));
    if (!within(project, resolved) && !within(state, resolved)) continue;
    if (extra.endsWith('/')) dirs.push(resolved);
    else files.push(resolved);
  }
  // A login's memory folder that has not been linked yet is still this agent's memory.
  const projectMemorySegment = path.resolve(options.projectDir).replace(/[/.]/g, '-');
  return { files, dirs, projectMemorySegment };
}

export function isInScope(filePath: string, options: ScopeOptions): boolean {
  const scope = resolveScope(options);
  const real = realpathLoose(filePath);
  if (scope.files.includes(real) || scope.dirs.some((dir) => within(dir, real))) return true;
  const parts = real.split(path.sep);
  const at = parts.indexOf('projects');
  return at >= 0 && parts[at + 1] === scope.projectMemorySegment && parts[at + 2] === 'memory';
}

/** Every text note in scope, for the audit. A missing path is simply not listed. */
export function listScopeFiles(options: ScopeOptions, maxFiles = 5_000): string[] {
  const scope = resolveScope(options);
  const out = new Set<string>();
  for (const file of scope.files) if (fs.existsSync(file) && fs.statSync(file).isFile()) out.add(file);
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.size >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(md|mdc|txt)$/i.test(entry.name)) out.add(full);
    }
  };
  for (const dir of scope.dirs) walk(dir);
  return [...out];
}

/** Blanks instar's managed region of CLAUDE.md, which an agent neither wrote nor can be refused for. */
export function withoutManagedRegion(filePath: string, text: string): string {
  if (path.basename(filePath) !== 'CLAUDE.md') return text;
  const start = text.indexOf(CLAUDE_MD_CORE_START_PREFIX);
  if (start < 0) return text;
  const end = text.indexOf(CLAUDE_MD_CORE_END, start);
  if (end < 0) return text;
  return `${text.slice(0, start)}${text.slice(end + CLAUDE_MD_CORE_END.length)}`;
}
