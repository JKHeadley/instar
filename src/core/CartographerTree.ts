/**
 * CartographerTree — the substrate of the cartographer-conformance project
 * (spec #1, docs/specs/CARTOGRAPHER-DOC-TREE-SCHEMA.md).
 *
 * A hierarchical, semantic doc-tree of the codebase: one node per directory or
 * significant file, each carrying a plain-language `summary` plus a git object-id
 * fingerprint (`codeHash`) captured when the summary was authored. Staleness is
 * DERIVED — never stored — by comparing each node's stored `codeHash` to the
 * code's current git oid, obtained from ONE batched `git ls-tree -r -t HEAD`
 * (plus one `rev-parse` for the root tree). Pure git/filesystem, zero LLM.
 *
 * This module is the schema + storage + staleness + read/update primitives only.
 * Bulk summary authoring (the freshness sweep) is spec #2; this layer just stores
 * and serves. Summaries are LLM-authored and semantically UNVERIFIED here —
 * downstream consumers must re-ground against the code before acting on one.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeGitExecutor } from './SafeGitExecutor.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { DEFAULT_SKIP_DIRS } from './skipDirs.js';

export type NodeKind = 'dir' | 'file';
export type StalenessStatus = 'fresh' | 'stale' | 'never-authored' | 'path-gone' | 'dirty';

export interface CartographerNodeProvenance {
  framework?: string;
  /** Size tier of the model that authored the summary — never a vendor name. */
  modelTier?: 'light' | 'standard';
}

export interface CartographerNode {
  /** Repo-relative POSIX path this node covers ('' = repo root). */
  path: string;
  kind: NodeKind;
  /** Plain-language description of what the code here does. '' until authored. */
  summary: string;
  /** ISO timestamp the summary was last authored; null = never. */
  summaryUpdatedAt: string | null;
  /** The git object id of the covered code AT authoring time (dir→tree, file→blob). null = never. */
  codeHash: string | null;
  /** Short HEAD sha when the summary was authored (provenance only). */
  codeRev: string | null;
  /** Child node paths (dirs only; sorted, repo-relative). */
  children: string[];
  /** Provenance marker — this file is cartographer state, not a user file. */
  builtinKind: 'cartographer-node';
  provenance?: CartographerNodeProvenance;
  /** True if codeHash was a working-tree hash rather than a committed oid. */
  dirtyAtAuthor?: boolean;
}

export interface CartographerIndexEntry {
  kind: NodeKind;
  summaryUpdatedAt: string | null;
  codeHash: string | null;
  hasChildren: boolean;
}

export interface CartographerIndex {
  schemaVersion: number;
  root: string;
  generatedAt: string;
  nodes: Record<string, CartographerIndexEntry>;
}

export interface CartographerStaleEntry {
  path: string;
  status: StalenessStatus;
  reason: string;
}

export interface CartographerConfig {
  /** Project root directory (the repo to map). */
  projectDir: string;
  /** Instar state directory (cartographer state nests under here). */
  stateDir: string;
  /** Hard cap on descent depth (default 12). */
  maxDepth?: number;
  /** File extensions that become leaf nodes (default ts/js/mjs/cjs). */
  leafExtensions?: string[];
  /** Substrings that exclude a file from being a leaf (default test/spec/.d.ts). */
  excludeSubstrings?: string[];
}

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_LEAF_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs'];
const DEFAULT_EXCLUDE_SUBSTRINGS = ['.test.', '.spec.', '.d.ts'];
const GIT_OP = 'cartographer-tree';

export class CartographerTree {
  private readonly projectDir: string;
  private readonly cartoDir: string;
  private readonly nodesDir: string;
  private readonly indexPath: string;
  private readonly maxDepth: number;
  private readonly leafExtensions: string[];
  private readonly excludeSubstrings: string[];

  constructor(config: CartographerConfig) {
    this.projectDir = config.projectDir;
    this.cartoDir = path.join(config.stateDir, 'cartographer');
    this.nodesDir = path.join(this.cartoDir, 'nodes');
    this.indexPath = path.join(this.cartoDir, 'index.json');
    this.maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.leafExtensions = config.leafExtensions ?? DEFAULT_LEAF_EXTENSIONS;
    this.excludeSubstrings = config.excludeSubstrings ?? DEFAULT_EXCLUDE_SUBSTRINGS;
  }

  // ---- slug + atomic IO -----------------------------------------------------

  /** Collision-free, opaque node-file slug. The index is the authoritative reverse lookup. */
  private slug(nodePath: string): string {
    return crypto.createHash('sha256').update(nodePath, 'utf8').digest('hex').slice(0, 40);
  }

  private nodeFilePath(nodePath: string): string {
    return path.join(this.nodesDir, `${this.slug(nodePath)}.json`);
  }

  /** Atomic write — temp file + rename (atomic on POSIX) so a reader never sees a torn file. */
  private atomicWrite(filePath: string, contents: string): void {
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, filePath);
  }

  private ensureDirs(): void {
    fs.mkdirSync(this.nodesDir, { recursive: true });
  }

  // ---- git plumbing (read-only, batched) ------------------------------------

  private git(args: readonly string[]): string | null {
    try {
      return SafeGitExecutor.readSync(args, { cwd: this.projectDir, operation: GIT_OP });
    } catch {
      // @silent-fallback-ok — absent git/HEAD yields no oids; callers treat as unknown.
      return null;
    }
  }

  /**
   * ONE batched call: every tracked tree (dir) and blob (file) oid in HEAD, keyed
   * by repo-relative path. Plus the root tree oid (key ''). The make-or-break perf
   * primitive — no per-node `git rev-parse`.
   */
  private currentOids(): Map<string, string> {
    const map = new Map<string, string>();
    const rootTree = this.git(['rev-parse', 'HEAD^{tree}']);
    if (rootTree) map.set('', rootTree.trim());
    const out = this.git(['ls-tree', '-r', '-t', '-z', 'HEAD']);
    if (!out) return map;
    for (const entry of out.split('\0')) {
      if (!entry) continue;
      // format: "<mode> <type> <oid>\t<path>"
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const meta = entry.slice(0, tab).split(' ');
      const p = entry.slice(tab + 1);
      const oid = meta[2];
      if (oid && p) map.set(p, oid);
    }
    return map;
  }

  /** Single-path current oid (for setSummary capture) — `git rev-parse HEAD:<path>`. */
  private currentOid(nodePath: string): string | null {
    const rev = nodePath === '' ? 'HEAD^{tree}' : `HEAD:${nodePath}`;
    const out = this.git(['rev-parse', rev]);
    return out ? out.trim() : null;
  }

  private headShort(): string | null {
    const out = this.git(['rev-parse', '--short', 'HEAD']);
    return out ? out.trim() : null;
  }

  // ---- scaffold (structural skeleton) ---------------------------------------

  private isLeafFile(name: string): boolean {
    if (this.excludeSubstrings.some((s) => name.includes(s))) return false;
    return this.leafExtensions.some((ext) => name.endsWith(ext));
  }

  /**
   * (Re)build the structural skeleton from a directory walk. Preserves an existing
   * node's authored summary/codeHash/codeRev (so staleness still reflects time of
   * authoring); only structure (kind/children) is refreshed. New nodes start
   * never-authored (codeHash null). Honors skip-set, maxDepth, and a symlink-loop
   * guard (visited real paths).
   */
  scaffold(): CartographerIndex {
    this.ensureDirs();
    const visitedReal = new Set<string>();
    const nodes = new Map<string, CartographerNode>();

    const relPosix = (abs: string): string =>
      path.relative(this.projectDir, abs).split(path.sep).join('/');

    const walk = (absDir: string, depth: number): string[] => {
      // returns sorted child node paths of absDir
      let real: string;
      try {
        real = fs.realpathSync(absDir);
      } catch {
        // @silent-fallback-ok — an unresolvable path is simply not mapped; the
        // scaffold skips it and continues. No degraded state to report.
        return [];
      }
      if (visitedReal.has(real)) return [];
      visitedReal.add(real);
      if (depth > this.maxDepth) return [];

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        // @silent-fallback-ok — an unreadable directory contributes no child
        // nodes; the scaffold treats it as empty and moves on (read-only map).
        return [];
      }
      const children: string[] = [];
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.isDirectory()) {
          if (DEFAULT_SKIP_DIRS.has(e.name)) continue;
          const childAbs = path.join(absDir, e.name);
          const childRel = relPosix(childAbs);
          const grandChildren = walk(childAbs, depth + 1);
          this.upsertNode(nodes, childRel, 'dir', grandChildren);
          children.push(childRel);
        } else if (e.isFile() && this.isLeafFile(e.name)) {
          const childAbs = path.join(absDir, e.name);
          const childRel = relPosix(childAbs);
          this.upsertNode(nodes, childRel, 'file', []);
          children.push(childRel);
        }
      }
      return children;
    };

    const rootChildren = walk(this.projectDir, 0);
    this.upsertNode(nodes, '', 'dir', rootChildren);

    // Prune stale node files (paths that disappeared) and write the surviving set.
    this.rewriteAll(nodes);
    return this.buildIndex(nodes);
  }

  /** Merge structure into a node, preserving any existing authored fields. */
  private upsertNode(
    nodes: Map<string, CartographerNode>,
    nodePath: string,
    kind: NodeKind,
    children: string[],
  ): void {
    const existing = this.readNodeFile(nodePath);
    nodes.set(nodePath, {
      path: nodePath,
      kind,
      summary: existing?.summary ?? '',
      summaryUpdatedAt: existing?.summaryUpdatedAt ?? null,
      codeHash: existing?.codeHash ?? null,
      codeRev: existing?.codeRev ?? null,
      children,
      builtinKind: 'cartographer-node',
      provenance: existing?.provenance,
      dirtyAtAuthor: existing?.dirtyAtAuthor,
    });
  }

  private rewriteAll(nodes: Map<string, CartographerNode>): void {
    // Remove node files for paths no longer present.
    if (fs.existsSync(this.nodesDir)) {
      const keep = new Set<string>();
      for (const p of nodes.keys()) keep.add(`${this.slug(p)}.json`);
      for (const f of fs.readdirSync(this.nodesDir)) {
        if (f.endsWith('.json') && !keep.has(f)) {
          try {
            SafeFsExecutor.safeUnlinkSync(path.join(this.nodesDir, f), {
              operation: 'cartographer-prune-stale-node',
            });
          } catch { /* best-effort prune */ }
        }
      }
    }
    for (const node of nodes.values()) {
      this.atomicWrite(this.nodeFilePath(node.path), JSON.stringify(node, null, 2));
    }
  }

  private buildIndex(nodes: Map<string, CartographerNode>): CartographerIndex {
    const index: CartographerIndex = {
      schemaVersion: SCHEMA_VERSION,
      root: '',
      generatedAt: this.nowIso(),
      nodes: {},
    };
    for (const node of nodes.values()) {
      index.nodes[node.path] = {
        kind: node.kind,
        summaryUpdatedAt: node.summaryUpdatedAt,
        codeHash: node.codeHash,
        hasChildren: node.children.length > 0,
      };
    }
    this.atomicWrite(this.indexPath, JSON.stringify(index, null, 2));
    return index;
  }

  private nowIso(): string {
    // Wall clock is acceptable here (authoring timestamp); not on a resume-critical path.
    return new Date().toISOString();
  }

  // ---- read / update --------------------------------------------------------

  private readNodeFile(nodePath: string): CartographerNode | null {
    const fp = this.nodeFilePath(nodePath);
    if (!fs.existsSync(fp)) return null;
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf8')) as CartographerNode;
    } catch {
      // @silent-fallback-ok — a corrupt/partial node file reads as "absent"; the
      // next scaffold/sweep re-authors it. Treating it as null is the recovery.
      return null;
    }
  }

  loadIndex(): CartographerIndex | null {
    if (!fs.existsSync(this.indexPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as CartographerIndex;
    } catch {
      // @silent-fallback-ok — a corrupt index reads as "no index yet"; callers
      // then scaffold() a fresh one. Treating it as null is the recovery path.
      return null;
    }
  }

  getNode(nodePath: string): CartographerNode | null {
    return this.readNodeFile(nodePath);
  }

  getChildren(nodePath: string): CartographerNode[] {
    const node = this.readNodeFile(nodePath);
    if (!node) return [];
    return node.children
      .map((c) => this.readNodeFile(c))
      .filter((n): n is CartographerNode => n !== null);
  }

  /**
   * Author/refresh a node's summary, capturing the current code oid so future
   * staleness reflects time-of-authoring. Writes the node file first, then patches
   * the index (so a reader never sees an index entry ahead of its node file).
   */
  setSummary(
    nodePath: string,
    summary: string,
    opts: { codeHash?: string; codeRev?: string; provenance?: CartographerNodeProvenance } = {},
  ): CartographerNode {
    this.ensureDirs();
    const existing = this.readNodeFile(nodePath);
    if (!existing) {
      throw new Error(`CartographerTree.setSummary: no node at path "${nodePath}" — run scaffold() first`);
    }
    const codeHash = opts.codeHash ?? this.currentOid(nodePath);
    const node: CartographerNode = {
      ...existing,
      summary,
      summaryUpdatedAt: this.nowIso(),
      codeHash,
      codeRev: opts.codeRev ?? this.headShort(),
      provenance: opts.provenance ?? existing.provenance,
    };
    this.atomicWrite(this.nodeFilePath(nodePath), JSON.stringify(node, null, 2));
    // Patch the index entry (node file already on disk).
    const index = this.loadIndex();
    if (index && index.nodes[nodePath]) {
      index.nodes[nodePath].summaryUpdatedAt = node.summaryUpdatedAt;
      index.nodes[nodePath].codeHash = node.codeHash;
      this.atomicWrite(this.indexPath, JSON.stringify(index, null, 2));
    }
    return node;
  }

  /** Derive staleness for the whole tree from ONE batched git read. */
  staleNodes(): CartographerStaleEntry[] {
    const index = this.loadIndex();
    if (!index) return [];
    const current = this.currentOids();
    const out: CartographerStaleEntry[] = [];
    for (const [nodePath, entry] of Object.entries(index.nodes)) {
      const status = this.deriveStatus(entry.codeHash, current.get(nodePath));
      if (status !== 'fresh') {
        out.push({ path: nodePath, status, reason: this.statusReason(status) });
      }
    }
    return out;
  }

  /** Derive staleness for a single node. */
  computeStaleness(nodePath: string): StalenessStatus {
    const node = this.readNodeFile(nodePath);
    if (!node) return 'path-gone';
    return this.deriveStatus(node.codeHash, this.currentOid(nodePath) ?? undefined);
  }

  private deriveStatus(storedHash: string | null, currentOid: string | undefined): StalenessStatus {
    if (storedHash == null) return 'never-authored';
    if (currentOid == null) return 'path-gone';
    return currentOid === storedHash ? 'fresh' : 'stale';
  }

  private statusReason(status: StalenessStatus): string {
    switch (status) {
      case 'never-authored': return 'no summary authored yet';
      case 'path-gone': return 'covered path no longer in HEAD';
      case 'stale': return 'code changed since the summary was authored';
      case 'dirty': return 'uncommitted changes under this path';
      default: return '';
    }
  }

  // ---- observability --------------------------------------------------------

  health(): {
    nodeCount: number;
    authoredCount: number;
    neverAuthoredCount: number;
    staleCount: number;
    generatedAt: string | null;
  } {
    const index = this.loadIndex();
    if (!index) {
      return { nodeCount: 0, authoredCount: 0, neverAuthoredCount: 0, staleCount: 0, generatedAt: null };
    }
    const entries = Object.values(index.nodes);
    const authoredCount = entries.filter((e) => e.codeHash != null).length;
    return {
      nodeCount: entries.length,
      authoredCount,
      neverAuthoredCount: entries.length - authoredCount,
      staleCount: this.staleNodes().filter((s) => s.status === 'stale').length,
      generatedAt: index.generatedAt,
    };
  }
}
