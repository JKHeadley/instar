/**
 * Whole-disk attribution (spec docs/specs/disk-steward.md §3.7a). Read-only.
 *
 * The agent-home sizes (§3.7) only see this agent's own folder, so a disk that
 * fills from another agent's checkouts or a backup folder posts "biggest
 * folders" that explain a fraction of the space. This measures the top level
 * of the user's home folder, names each part's owner when an Instar agent
 * lives there (from the machine's agent registry), and reports the rest of
 * the used space as "not opened".
 *
 * Never opened, on macOS: folders whose access belongs to the privacy system
 * (Documents, Desktop, Downloads, Library, Pictures, Movies, Music, the
 * trash). Reading them from the agent's process tree can raise a permission
 * prompt or disturb the grant agents rely on. Their bytes land in the
 * "not opened" remainder, so the total still adds up.
 *
 * Nothing here deletes, moves or writes anything.
 */
import path from 'node:path';
import type { PruneSeams } from './pruneCategories.js';

export const MAC_NOT_OPENED = new Set(['Documents', 'Desktop', 'Downloads', 'Library', 'Pictures', 'Movies', 'Music', '.Trash']);
/** How deep a folder is opened to find the agents inside it (~/.instar/agents/<name> is two below home). */
const MAX_DEPTH = 3;

export interface AgentHome { name: string; path: string }

export interface WholeDiskOwner {
  /** An agent's name, or a home-relative folder (`~/Projects`) when no agent lives there. */
  owner: string;
  agent: boolean;
  bytes: number;
  /** The biggest measured folders under this owner, home-relative. */
  paths: Array<{ name: string; bytes: number }>;
}

export interface WholeDiskResult {
  at: number;
  partial: boolean;
  usedBytes: number;
  measuredBytes: number;
  /** Used space not counted: folders not opened (privacy, system, other users) and the unfinished rest. */
  notOpenedBytes: number;
  owners: WholeDiskOwner[];
  /** Folders whose walk ran out of time or could not be read, home-relative (at most 5); their counts are lower bounds. */
  unfinished?: string[];
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The agent living at `p` or inside it (the first by path, so the answer is stable). */
export function ownerOf(p: string, agents: readonly AgentHome[]): AgentHome | null {
  const hits = agents.filter((a) => a.path === p || inside(a.path, p)).sort((x, y) => x.path.localeCompare(y.path));
  return hits[0] ?? null;
}

/**
 * Group measured folders by owner. A folder holding an agent belongs to that
 * agent; any other folder belongs to its top-level home folder (`~/Projects`).
 */
export function groupOwners(home: string, measured: ReadonlyArray<{ path: string; bytes: number }>, agents: readonly AgentHome[]): WholeDiskOwner[] {
  const by = new Map<string, WholeDiskOwner>();
  for (const m of measured) {
    const a = ownerOf(m.path, agents);
    const rel = path.relative(home, m.path);
    const key = a ? a.name : `~/${rel.split(path.sep)[0]}`;
    const o = by.get(key) ?? { owner: key, agent: !!a, bytes: 0, paths: [] };
    o.bytes += m.bytes;
    o.paths.push({ name: `~/${rel}`, bytes: m.bytes });
    by.set(key, o);
  }
  const out = [...by.values()];
  for (const o of out) o.paths = o.paths.sort((x, y) => y.bytes - x.bytes).slice(0, 3);
  return out.sort((x, y) => y.bytes - x.bytes);
}

/** Read the machine's agent registry (`~/.instar/registry.json`); unreadable ⇒ no owners named. */
export function agentsFromRegistry(raw: string | null): AgentHome[] {
  if (!raw) return [];
  try {
    const d = JSON.parse(raw) as { entries?: Array<{ name?: unknown; path?: unknown }> };
    return (d.entries ?? [])
      .filter((e): e is { name: string; path: string } => typeof e.name === 'string' && typeof e.path === 'string' && path.isAbsolute(e.path))
      // A lifeline shares its agent's folder or sits beside it; it is not a separate owner.
      .filter((e) => !e.name.endsWith('-lifeline'))
      .map((e) => ({ name: e.name, path: path.resolve(e.path) }));
  } catch {
    return []; // @silent-fallback-ok — folders are still listed by name, just without an owner
  }
}

export async function measureWholeDisk(
  seams: Pick<PruneSeams, 'readdir' | 'lstat' | 'devOf' | 'sizeOf' | 'sizeAtLeast' | 'platform'>,
  opts: {
    home: string; agents: readonly AgentHome[]; usedBytes: number; budgetMs: number; now: () => number;
    /** Lower bounds already known for some folders (this agent's own measured sizes), by absolute path. */
    floors?: ReadonlyMap<string, number>;
  },
): Promise<WholeDiskResult> {
  const started = opts.now();
  const homeDev = seams.devOf(opts.home);
  const measured: Array<{ path: string; bytes: number }> = [];
  let partial = false;
  const unfinished: string[] = [];
  const stopped = (p: string, bytes: number): void => {
    partial = true;
    unfinished.push(`~/${path.relative(opts.home, p)}`);
    const b = Math.max(bytes, opts.floors?.get(p) ?? 0);
    if (b > 0) measured.push({ path: p, bytes: b });
  };

  const visit = async (dir: string, depth: number): Promise<void> => {
    const names = seams.readdir(dir);
    if (names === null) { partial = true; return; }
    for (const n of names.sort()) {
      if (dir === opts.home && seams.platform === 'darwin' && MAC_NOT_OPENED.has(n)) continue;
      const p = path.join(dir, n);
      const st = seams.lstat(p);
      if (!st || st.isSymbolicLink()) continue;
      if (homeDev !== null && seams.devOf(p) !== homeDev) continue; // another volume
      // A folder with an agent somewhere below it (not at it) is opened one level more.
      if (st.isDirectory() && depth < MAX_DEPTH && opts.agents.some((a) => inside(a.path, p))) {
        await visit(p, depth + 1);
        continue;
      }
      const left = opts.budgetMs - (opts.now() - started);
      if (left <= 0) { partial = true; return; }
      // No one folder may spend more than a quarter of what is left, so one huge
      // checkout cannot leave everything after it unmeasured; it reports "at least".
      const cap = Math.max(30_000, Math.floor(left / 4));
      if (seams.sizeAtLeast) {
        const r = await seams.sizeAtLeast(p, Math.min(left, cap));
        if (r === null || !r.complete) { stopped(p, r?.bytes ?? 0); continue; }
        measured.push({ path: p, bytes: r.bytes });
      } else {
        const bytes = await seams.sizeOf(p, Math.min(left, cap));
        if (bytes === null) { stopped(p, 0); continue; }
        measured.push({ path: p, bytes });
      }
    }
  };
  await visit(opts.home, 1);

  const measuredBytes = measured.reduce((a, m) => a + m.bytes, 0);
  return {
    at: opts.now(), partial, usedBytes: opts.usedBytes, measuredBytes,
    notOpenedBytes: Math.max(0, opts.usedBytes - measuredBytes),
    owners: groupOwners(opts.home, measured, opts.agents).slice(0, 8),
    ...(unfinished.length ? { unfinished: unfinished.slice(0, 5) } : {}),
  };
}
