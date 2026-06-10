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
  /**
   * Which tier authored this summary (spec #2 — doc-freshness). 'inline-agent' =
   * a Tier-1 opportunistic refresh by the agent that edited the code; 'sweep' =
   * the background CartographerSweep poller. Inline summaries are NOT protected
   * ground truth — the sweep may re-author them on a later pass.
   */
  source?: 'inline-agent' | 'sweep';
}

/** Coarse trust signal for a summary (spec #2). `fresh` ≠ correct; this hints how much. */
export type CartographerConfidence = 'low' | 'medium' | 'high';

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

  // ── Spec #2 (doc-freshness) — owned-here fields ──────────────────────────
  // These are added by spec #2; spec #1 leaves them undefined. They are
  // preserved across scaffold() (structure-only refresh) like the authored
  // fields, and never wipe spec #1 behavior.
  /** ISO timestamp this node path was first scaffolded — the grace-clock anchor. */
  firstSeenAt?: string;
  /** Who last authored: 'inline-agent' | `sweep:<framework>`. Consumers must not read fresh as trusted. */
  lastAuthoredBy?: string;
  /** Coarse trust signal — `fresh` means fingerprint-current, NOT verified-correct. */
  confidence?: CartographerConfidence;
  /**
   * Hash of the concatenated DIRECT-child summaries at this dir's last author.
   * The dir re-author amplification guard: a dir whose tree-oid flipped but whose
   * childDigestHash is unchanged (e.g. a comment-only deep edit) gets its
   * fingerprint refreshed WITHOUT an LLM call. Leaf nodes leave this null.
   */
  childDigestHash?: string | null;
  /** Anti-starvation: passes this node has been deferred (dir authored after its children). */
  staleSincePass?: number;
  /** Consecutive failed author attempts — drives per-node quarantine. */
  consecutiveAuthorFailures?: number;
  /** True once consecutiveAuthorFailures crossed the quarantine threshold. Surfaced in health(). */
  authorFailed?: boolean;
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
      // Spec #2 fields are preserved across a structure-only rescaffold. A node
      // first seen now anchors its grace clock; existing nodes keep theirs.
      firstSeenAt: existing?.firstSeenAt ?? this.nowIso(),
      lastAuthoredBy: existing?.lastAuthoredBy,
      confidence: existing?.confidence,
      childDigestHash: existing?.childDigestHash,
      staleSincePass: existing?.staleSincePass,
      consecutiveAuthorFailures: existing?.consecutiveAuthorFailures,
      authorFailed: existing?.authorFailed,
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
    opts: {
      codeHash?: string;
      codeRev?: string;
      provenance?: CartographerNodeProvenance;
      /** Spec #2 authoring metadata, written atomically with the summary. */
      meta?: {
        lastAuthoredBy?: string;
        confidence?: CartographerConfidence;
        childDigestHash?: string | null;
      };
    } = {},
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
      // Spec #2: a successful author clears the failure/defer state and records
      // who authored + confidence. childDigestHash is set for dir authors.
      lastAuthoredBy: opts.meta?.lastAuthoredBy ?? existing.lastAuthoredBy,
      confidence: opts.meta?.confidence ?? existing.confidence,
      childDigestHash:
        opts.meta?.childDigestHash !== undefined ? opts.meta.childDigestHash : existing.childDigestHash,
      staleSincePass: 0,
      consecutiveAuthorFailures: 0,
      authorFailed: false,
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

  /**
   * Spec #2: patch a node's freshness METADATA without re-authoring its summary.
   * Used by the sweep for failure counters / quarantine / defer-pass bookkeeping,
   * and for a fingerprint-only refresh (the dir re-author amplification guard:
   * bump `codeHash` to the current oid so a comment-only deep edit goes `fresh`
   * with NO LLM call). Never touches `summary` or `summaryUpdatedAt` unless
   * `codeHash` is supplied (a fingerprint refresh) — then the index entry is
   * patched too so staleness derives correctly. No-op (returns null) if absent.
   */
  patchNodeMeta(
    nodePath: string,
    partial: {
      codeHash?: string | null;
      codeRev?: string | null;
      childDigestHash?: string | null;
      lastAuthoredBy?: string;
      confidence?: CartographerConfidence;
      staleSincePass?: number;
      consecutiveAuthorFailures?: number;
      authorFailed?: boolean;
      provenance?: CartographerNodeProvenance;
    },
  ): CartographerNode | null {
    const existing = this.readNodeFile(nodePath);
    if (!existing) return null;
    const codeHashChanged = Object.prototype.hasOwnProperty.call(partial, 'codeHash');
    const node: CartographerNode = {
      ...existing,
      codeHash: codeHashChanged ? (partial.codeHash ?? null) : existing.codeHash,
      codeRev: partial.codeRev !== undefined ? partial.codeRev : existing.codeRev,
      childDigestHash:
        partial.childDigestHash !== undefined ? partial.childDigestHash : existing.childDigestHash,
      lastAuthoredBy: partial.lastAuthoredBy ?? existing.lastAuthoredBy,
      confidence: partial.confidence ?? existing.confidence,
      staleSincePass: partial.staleSincePass ?? existing.staleSincePass,
      consecutiveAuthorFailures:
        partial.consecutiveAuthorFailures ?? existing.consecutiveAuthorFailures,
      authorFailed: partial.authorFailed ?? existing.authorFailed,
      provenance: partial.provenance ?? existing.provenance,
    };
    this.atomicWrite(this.nodeFilePath(nodePath), JSON.stringify(node, null, 2));
    if (codeHashChanged) {
      const index = this.loadIndex();
      if (index && index.nodes[nodePath]) {
        index.nodes[nodePath].codeHash = node.codeHash;
        this.atomicWrite(this.indexPath, JSON.stringify(index, null, 2));
      }
    }
    return node;
  }

  /**
   * Spec #2: read the COMMITTED content of a leaf node's covered file, bounded to
   * `maxBytes` (head-truncated). Reads `git show HEAD:<path>` — never the dirty
   * working tree — so an uncommitted edit (possibly containing just-typed secrets)
   * is never read, and a long-lived uncommitted edit never causes re-author churn.
   * Returns null when the path is absent from HEAD or git is unavailable.
   */
  committedContent(nodePath: string, maxBytes: number): { content: string; truncated: boolean } | null {
    if (nodePath === '') return null; // root is a dir, not a file
    const out = this.git(['show', `HEAD:${nodePath}`]);
    if (out == null) return null;
    if (Buffer.byteLength(out, 'utf8') <= maxBytes) return { content: out, truncated: false };
    // Head-truncate on a byte budget without splitting a multibyte char.
    const buf = Buffer.from(out, 'utf8').subarray(0, maxBytes);
    return { content: buf.toString('utf8'), truncated: true };
  }

  /** Public: the current short HEAD sha (compare-and-skip / provenance). */
  currentHeadShort(): string | null {
    return this.headShort();
  }

  /** Public: the current root tree oid (the CI ratchet short-circuit key). */
  rootTreeOid(): string | null {
    return this.currentOid('');
  }

  /** Public: the current git oid for a single node path (compare-and-skip on HEAD). */
  currentNodeOid(nodePath: string): string | null {
    return this.currentOid(nodePath);
  }

  /**
   * Public: ONE batched current-oid map (path → oid) for the whole HEAD tree. The
   * spec #5 navigator derives per-node `fresh` from a SINGLE read of this map
   * (compared to each node's stored `codeHash`) instead of a per-node staleness
   * call — keeping the "cheap on a wide frontier" guarantee.
   */
  currentOidMap(): Map<string, string> {
    return this.currentOids();
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

  /**
   * Spec #2 (doc-freshness) richer health: the freshness ratio over AUTHORABLE
   * nodes (excludes `path-gone`), plus the two ABSOLUTE backlog counts the CI
   * ratchet also gates on so a green ratio over a small authored set cannot hide
   * a growing un-authored backlog (Goodhart guard). `freshRatio` is `fresh /
   * authorable` with 1 when there are no authorable nodes. A node is
   * never-authored "past grace" when it has no summary AND was first seen longer
   * ago than `graceMs`.
   */
  freshnessHealth(opts: { graceMs: number; now?: number } = { graceMs: 0 }): {
    nodeCount: number;
    authorableCount: number;
    freshCount: number;
    staleCount: number;
    neverAuthoredCount: number;
    neverAuthoredWithinGrace: number;
    neverAuthoredPastGrace: number;
    authorFailedCount: number;
    freshRatio: number;
    generatedAt: string | null;
  } {
    const index = this.loadIndex();
    const empty = {
      nodeCount: 0, authorableCount: 0, freshCount: 0, staleCount: 0,
      neverAuthoredCount: 0, neverAuthoredWithinGrace: 0, neverAuthoredPastGrace: 0,
      authorFailedCount: 0, freshRatio: 1, generatedAt: null as string | null,
    };
    if (!index) return empty;
    const nowMs = opts.now ?? Date.parse(this.nowIso());
    const current = this.currentOids();
    let authorable = 0, fresh = 0, stale = 0, never = 0, neverWithin = 0, neverPast = 0, authorFailed = 0;
    for (const [nodePath, entry] of Object.entries(index.nodes)) {
      const status = this.deriveStatus(entry.codeHash, current.get(nodePath));
      if (status === 'path-gone') continue; // not authorable
      authorable += 1;
      // One node-file read per path: used for both the grace clock AND the
      // orthogonal author-failed quarantine flag (a quarantined node that never
      // successfully authored is still `never-authored`, so the read can't be
      // skipped for that status).
      const node = this.readNodeFile(nodePath);
      if (node?.authorFailed) authorFailed += 1;
      if (status === 'fresh') fresh += 1;
      else if (status === 'stale') stale += 1;
      else if (status === 'never-authored') {
        never += 1;
        const firstSeen = node?.firstSeenAt ? Date.parse(node.firstSeenAt) : nowMs;
        if (Number.isFinite(firstSeen) && nowMs - firstSeen > opts.graceMs) neverPast += 1;
        else neverWithin += 1;
      }
    }
    // The ratio denominator EXCLUDES never-authored-within-grace (a freshly
    // scaffolded node has a grace period to get authored before it counts as debt).
    // denominator = fresh + stale + never-authored-past-grace.
    const ratioDenom = fresh + stale + neverPast;
    return {
      nodeCount: Object.keys(index.nodes).length,
      authorableCount: authorable,
      freshCount: fresh,
      staleCount: stale,
      neverAuthoredCount: never,
      neverAuthoredWithinGrace: neverWithin,
      neverAuthoredPastGrace: neverPast,
      authorFailedCount: authorFailed,
      freshRatio: ratioDenom === 0 ? 1 : fresh / ratioDenom,
      generatedAt: index.generatedAt,
    };
  }
}
