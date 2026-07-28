/**
 * CartographerNavigator — the capstone of cartographer-conformance (spec #5,
 * docs/specs/CARTOGRAPHER-SUBTREE-NAV.md).
 *
 * A deterministic, recursive navigator over the cartographer doc-tree. Given a
 * task/query it walks the tree's plain-language summaries TOP-DOWN and returns the
 * minimal **relevant subtree** — the set of node paths a sub-agent should be scoped
 * to instead of loading the whole repo.
 *
 * Hard rules (pinned at convergence):
 *  - Deterministic-first, NO LLM. Term overlap on summary + path, with distinctive
 *    identifiers (camelCase/PascalCase/snake_case — the spec #2 extractCodeSymbols
 *    shape) weighing more than common words.
 *  - Two-phase dir scoring: a PROVISIONAL dir score (the dir's OWN summary+path
 *    overlap) gates descent; a FINAL dir score is folded UP from visited children
 *    (max child score, lightly depth-discounted) so a dir whose own text didn't
 *    match but whose children did still surfaces as a container of relevance.
 *  - Minimal-covering-subtree collapse: a dir collapses iff ≥ collapseFraction of
 *    its VISITED direct children scored > minScore; unvisited children are EXCLUDED
 *    from the fraction; applied bottom-up so a collapsed dir can participate in its
 *    parent's fraction.
 *  - Bounds: maxDepth / branchingFactor / maxNodesVisited / maxResults — each
 *    enforced with the truncated count reported (no silent cap).
 *  - SAFETY: every emitted `summary` is neutralizeInstructionShapedContent → then
 *    delimitUntrusted. A summary is LLM-authored over untrusted code; rendering it
 *    as quoted untrusted data is the binding consumer-contract spec #2 declared.
 *  - `fresh` per node is derived from ONE batched current-oid read (the spec #1
 *    currentOids() pattern), NOT a per-node computeStaleness.
 *
 * Observe-only: the navigator RETURNS a scoped manifest; it never spawns a
 * sub-agent or mutates anything.
 */
import type { CartographerTree, CartographerNode, NodeKind, CartographerConfidence } from './CartographerTree.js';
import {
  extractCodeSymbols,
  neutralizeInstructionShapedContent,
  delimitUntrusted,
} from './cartographerSummary.js';

export interface NavigateOptions {
  /** Hard cap on descent depth from the root (default 6). */
  maxDepth?: number;
  /** Descend into at most this many top-scoring children per dir (default 4). */
  branchingFactor?: number;
  /** Stop the walk once this many nodes have been scored/visited (default 200). */
  maxNodesVisited?: number;
  /** Cap the emitted `scored` set + relevantPaths breadth (default 25). */
  maxResults?: number;
  /** A node must score strictly above this to be relevant / descended-into (default 0.1). */
  minScore?: number;
  /** Fraction of a dir's VISITED direct children that must be relevant for it to collapse (default 0.6). */
  collapseFraction?: number;
}

export interface ScoredNode {
  path: string;
  kind: NodeKind;
  score: number;
  /** Delimited + neutralized — quoted untrusted data, never an instruction. Absent when the node had no summary. */
  summary?: string;
  confidence?: CartographerConfidence;
  fresh: boolean;
}

export interface NavigateManifest {
  query: string;
  /** The minimal covering subtree — scope a sub-agent here. */
  relevantPaths: string[];
  scored: ScoredNode[];
  /** Fraction of scored nodes that had a non-empty summary (path-only vs summary-informed). */
  summaryCoverage: number;
  nodesVisited: number;
  /** True if a bound (depth/visited/results) truncated the walk. */
  truncated: boolean;
}

const DEFAULTS: Required<NavigateOptions> = {
  maxDepth: 6,
  branchingFactor: 4,
  maxNodesVisited: 200,
  maxResults: 25,
  minScore: 0.1,
  collapseFraction: 0.6,
};

/** Common English/structural words that carry little distinctive signal. */
const STOPWORDS = new Set<string>([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is',
  'are', 'be', 'this', 'that', 'it', 'as', 'at', 'by', 'from', 'into', 'how',
  'what', 'where', 'when', 'which', 'who', 'code', 'file', 'files', 'dir', 'src',
  'all', 'any', 'use', 'using', 'used', 'do', 'does', 'find', 'get', 'set',
]);

/** Split a free-text token-stream into lowercased word tokens (incl. camelCase pieces). */
function wordTokens(text: string): string[] {
  const out: string[] = [];
  // Split identifier-ish runs, then break camelCase/PascalCase into sub-words too.
  const raw = text.match(/[A-Za-z_$][\w$]*/g) ?? [];
  for (const tok of raw) {
    out.push(tok.toLowerCase());
    // camelCase / PascalCase split: "TelegramAdapter" → telegram, adapter
    const parts = tok.split(/(?<=[a-z0-9])(?=[A-Z])|_/).filter(Boolean);
    if (parts.length > 1) {
      for (const p of parts) out.push(p.toLowerCase());
    }
  }
  return out;
}

/** The set of distinctive query identifiers (the extractCodeSymbols shape), lowercased. */
function distinctiveQueryIds(query: string): Set<string> {
  const ids = new Set<string>();
  for (const sym of extractCodeSymbols(query)) ids.add(sym.toLowerCase());
  return ids;
}

/** The basename of a repo-relative POSIX path ('' → ''). */
function basename(p: string): string {
  if (p === '') return '';
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Deterministic relevance score for a single node against a query.
 *
 * Signals (all case-insensitive):
 *  - term overlap between the query words and the node's summary + path basename
 *    + path segments;
 *  - a distinctive identifier (camelCase/PascalCase/snake_case) match weighs MORE
 *    than a common-word match (reusing the spec #2 extractCodeSymbols shape);
 *  - a path-segment / basename match is a strong, cheap signal.
 *
 * Pure + deterministic — no clock, no I/O, no randomness.
 */
export function scoreNodeRelevance(query: string, node: CartographerNode): number {
  const queryWords = wordTokens(query).filter((w) => !STOPWORDS.has(w));
  if (queryWords.length === 0) return 0;
  const queryWordSet = new Set(queryWords);
  const queryIds = distinctiveQueryIds(query);

  // Build the node's signal corpus: summary text + path basename + path segments.
  const base = basename(node.path);
  const segments = node.path.split('/').filter(Boolean);
  const pathText = [base, ...segments].join(' ');
  const summaryWords = new Set(wordTokens(node.summary));
  const pathWords = new Set(wordTokens(pathText));
  const summaryIds = new Set([...extractCodeSymbols(node.summary)].map((s) => s.toLowerCase()));
  const pathIds = new Set([...extractCodeSymbols(pathText)].map((s) => s.toLowerCase()));

  let score = 0;
  // Per distinct query word, credit the strongest place it lands (no double-count).
  for (const qw of queryWordSet) {
    const isDistinctiveQuery = queryIds.has(qw);
    // Weight ladder: a distinctive-id match (in path or summary) is the strongest
    // signal, then a path-word match, then a summary-word match.
    if (pathIds.has(qw) || (isDistinctiveQuery && pathWords.has(qw))) {
      score += 1.0;
    } else if (summaryIds.has(qw) || (isDistinctiveQuery && summaryWords.has(qw))) {
      score += 0.8;
    } else if (pathWords.has(qw)) {
      score += 0.6;
    } else if (summaryWords.has(qw)) {
      score += 0.35;
    }
  }
  // Normalize by query breadth so the score is a 0..~1 relevance fraction that
  // collapse/minScore thresholds reason about consistently across query lengths.
  return score / queryWordSet.size;
}

/** Depth of the bounded path-only descendant-basename peek used to gate dir descent. */
const PEEK_DEPTH = 2;

/**
 * The PROVISIONAL score used to decide whether to DESCEND into a dir (phase a of
 * two-phase dir scoring). It is the dir's own summary+path overlap, augmented by a
 * cheap PATH-ONLY peek at the basenames of its descendants down to a bounded depth
 * (`PEEK_DEPTH`) — never a recursive child SCORE (so there is no deadlock; only
 * paths are read, not relevance). This augmentation is what lets the walk descend
 * toward a relevant leaf on a never-swept tree where intermediate dirs (`src`,
 * `src/messaging`) have generic/empty summaries but a descendant basename
 * (`TelegramAdapter.ts`) matches the query.
 *
 * Decision noted in the build report: the spec says "provisional = the dir's OWN
 * summary+path overlap". A strict single-node reading deadlocks path-only
 * navigation at depth ≥ 2 (an intermediate dir with no matching summary is never
 * descended into, so a relevant deep leaf is unreachable). We extend "path overlap"
 * to the bounded set of descendant PATHS the dir contains — still path-only and
 * non-recursive-in-score — which is the minimal, deterministic way to honor the
 * spec's own worked example ("the relevant code is under src/messaging/") and its
 * Tier-1 "never-swept tree navigates on path signal" requirement.
 */
function provisionalDirScore(query: string, dirNode: CartographerNode, descendantBasenames: string[]): number {
  const own = scoreNodeRelevance(query, dirNode);
  if (descendantBasenames.length === 0) return own;
  // Score the dir as if its "path text" also carried its bounded descendant
  // basenames — a synthetic PATH-ONLY node (empty summary so the basenames never
  // count as summary-informed signal). scoreNodeRelevance reads path SEGMENTS, so
  // joining the basenames into the path surfaces each contained name as a segment.
  const synthetic: CartographerNode = {
    ...dirNode,
    path: [dirNode.path, ...descendantBasenames].filter(Boolean).join('/'),
    summary: '',
  };
  const contained = scoreNodeRelevance(query, synthetic);
  return Math.max(own, contained);
}

interface VisitedRecord {
  node: CartographerNode;
  depth: number;
  /** The score used for RANKING the `scored` set. For a leaf == its own score; for a dir == max(own, fold-up). */
  finalScore: number;
  /**
   * Whether this node SEEDS the relevant set on its own. A LEAF is self-relevant
   * when its OWN score > minScore. A DIR is NEVER self-relevant — a dir only becomes
   * a relevant path by COLLAPSING (its own fold-up score is for ranking, not for
   * claiming the dir as a scope on the strength of a single relevant descendant).
   * This is what keeps "scattered leaves" as leaves instead of bubbling up to the
   * dir whenever one child matches.
   */
  selfRelevant: boolean;
  /** Whether this node (leaf OR dir) counts as a RELEVANT visited child for its parent's collapse fraction. */
  countsForCollapse: boolean;
}

/**
 * The bounded top-down recursive walk + minimal-covering-subtree collapse.
 *
 * @param tree  a CartographerTree (already scaffolded; the route lazy-scaffolds).
 * @param query the task description / search text.
 * @param opts  bound + threshold overrides.
 */
export function navigate(
  tree: CartographerTree,
  query: string,
  opts: NavigateOptions = {},
): NavigateManifest {
  const o: Required<NavigateOptions> = {
    maxDepth: opts.maxDepth ?? DEFAULTS.maxDepth,
    branchingFactor: opts.branchingFactor ?? DEFAULTS.branchingFactor,
    maxNodesVisited: opts.maxNodesVisited ?? DEFAULTS.maxNodesVisited,
    maxResults: opts.maxResults ?? DEFAULTS.maxResults,
    minScore: opts.minScore ?? DEFAULTS.minScore,
    collapseFraction: opts.collapseFraction ?? DEFAULTS.collapseFraction,
  };

  // Empty query → empty relevantPaths short-circuit (nothing to score against).
  if (query.trim().length === 0) {
    return { query, relevantPaths: [], scored: [], summaryCoverage: 0, nodesVisited: 0, truncated: false };
  }

  const root = tree.getNode('');
  if (!root) {
    return { query, relevantPaths: [], scored: [], summaryCoverage: 0, nodesVisited: 0, truncated: false };
  }

  // Visited records keyed by path. Tracks every node we SCORED (the walk frontier).
  const visited = new Map<string, VisitedRecord>();
  // Per-dir: which of its DIRECT children we actually visited (the collapse denominator).
  const visitedChildrenOf = new Map<string, string[]>();
  let nodesVisited = 0;
  let truncated = false;

  // PATH-ONLY bounded descendant-basename peek for the provisional dir-descent gate.
  // Cached per dir path so a dir's peek is computed once even if revisited. Reads
  // ONLY node paths (never summaries / never relevance scores) down to PEEK_DEPTH.
  const peekCache = new Map<string, string[]>();
  const descendantBasenames = (dirPath: string): string[] => {
    const cached = peekCache.get(dirPath);
    if (cached) return cached;
    const out: string[] = [];
    const recurse = (p: string, d: number): void => {
      if (d > PEEK_DEPTH) return;
      for (const child of tree.getChildren(p)) {
        out.push(basename(child.path));
        if (child.kind === 'dir') recurse(child.path, d + 1);
      }
    };
    recurse(dirPath, 1);
    peekCache.set(dirPath, out);
    return out;
  };

  /**
   * Recursively walk a dir's children. Returns the max child finalScore seen (for
   * the parent's fold-up). The dir node itself is recorded by the caller.
   */
  const walkChildren = (dirNode: CartographerNode, depth: number): number => {
    if (depth >= o.maxDepth) {
      // We are at the depth wall — children below are not visited; note truncation
      // only if this dir actually has children we're choosing not to descend into.
      if (dirNode.children.length > 0) truncated = true;
      return 0;
    }
    const children = tree.getChildren(dirNode.path);
    // Score every direct child. A LEAF's score is its own summary+path overlap (this
    // is also its final score). A DIR's PROVISIONAL score (phase a) additionally
    // peeks at its bounded descendant basenames (path-only, non-recursive in SCORE)
    // so the walk can descend toward a relevant leaf even when intermediate dirs have
    // generic/empty summaries — the spec's "descend on the dir's provisional score".
    const scoredChildren = children.map((c) => ({
      node: c,
      provisional: c.kind === 'dir' ? provisionalDirScore(query, c, descendantBasenames(c.path)) : scoreNodeRelevance(query, c),
      // The dir's OWN final base (its summary+path overlap) — the fold-up takes the
      // MAX of this and the folded child scores, so a generic dir doesn't claim a
      // descendant's relevance as its own text match.
      ownScore: scoreNodeRelevance(query, c),
    }));

    // Record + (for dirs) descend into the top-branchingFactor children whose
    // PROVISIONAL score exceeds minScore. Sort by provisional score desc, then path
    // for determinism.
    const ordered = [...scoredChildren].sort(
      (a, b) => b.provisional - a.provisional || a.node.path.localeCompare(b.node.path),
    );
    const descendInto = ordered
      .filter((c) => c.node.kind === 'dir' && c.provisional > o.minScore)
      .slice(0, o.branchingFactor);
    const descendSet = new Set(descendInto.map((c) => c.node.path));
    // A dir has more relevant-or-present children than we'll descend into → truncation.
    const descendableDirs = ordered.filter((c) => c.node.kind === 'dir' && c.provisional > o.minScore);
    if (descendableDirs.length > descendInto.length) truncated = true;

    const myVisitedChildren: string[] = [];
    let maxChildFinal = 0;

    for (const { node: child, ownScore } of scoredChildren) {
      if (nodesVisited >= o.maxNodesVisited) {
        truncated = true;
        break;
      }
      nodesVisited += 1;
      myVisitedChildren.push(child.path);

      // The reported FINAL score starts from the node's OWN summary+path overlap
      // (NOT the basename-augmented provisional, which is only the descent gate). A
      // generic dir therefore does not claim a child's relevance as its own text.
      let finalScore = ownScore;
      if (child.kind === 'dir' && descendSet.has(child.path)) {
        // Two-phase: descend, then fold the children's max score UP, lightly
        // depth-discounted, and take the max with the dir's own score (a dir whose
        // own text matched AND whose children matched keeps the stronger).
        const childMax = walkChildren(child, depth + 1);
        const foldedUp = childMax * 0.9; // light depth discount on the fold-up
        finalScore = Math.max(ownScore, foldedUp);
      }

      visited.set(child.path, {
        node: child,
        depth: depth + 1,
        finalScore,
        // A leaf seeds the relevant set on its OWN score; a dir never does (it must
        // collapse to become a relevant path).
        selfRelevant: child.kind === 'file' && ownScore > o.minScore,
        // For the parent's collapse fraction, a child (leaf or dir) "counts" when its
        // ranking score clears minScore — a child dir with a relevant descendant counts.
        countsForCollapse: finalScore > o.minScore,
      });
      if (finalScore > maxChildFinal) maxChildFinal = finalScore;
    }

    visitedChildrenOf.set(dirNode.path, myVisitedChildren);
    return maxChildFinal;
  };

  // Seed: the root is always "visited" but never itself a relevant result (it is the
  // whole repo — collapsing to '' would defeat the purpose). Score its subtree.
  nodesVisited += 1;
  const rootMaxChild = walkChildren(root, 0);
  visited.set('', {
    node: root,
    depth: 0,
    finalScore: rootMaxChild * 0.9,
    selfRelevant: false,     // root is never emitted as a relevant scope
    countsForCollapse: false,
  });

  // ── Minimal-covering-subtree collapse (bottom-up) ──────────────────────────
  // relevantPaths starts as every SELF-relevant visited node (i.e. relevant LEAVES;
  // excluding root). Dirs enter only by collapsing below.
  const relevant = new Set<string>();
  for (const [p, rec] of visited) {
    if (p !== '' && rec.selfRelevant) relevant.add(p);
  }

  // Process dirs deepest-first so a collapsed dir can participate in its parent's
  // fraction. Exclude root from being a collapse target (never scope to '').
  const dirPaths = [...visited.keys()]
    .filter((p) => p !== '' && visited.get(p)!.node.kind === 'dir')
    .sort((a, b) => visited.get(b)!.depth - visited.get(a)!.depth || b.localeCompare(a));

  for (const dirPath of dirPaths) {
    const visitedChildren = visitedChildrenOf.get(dirPath) ?? [];
    if (visitedChildren.length === 0) continue; // a dir with no visited children can't collapse
    // Denominator: VISITED direct children only (unvisited/pruned children are
    // EXCLUDED from the fraction). Numerator: a visited child counts as relevant when
    // it scored above minScore (`countsForCollapse` — true for a relevant leaf AND
    // for a child dir relevant via fold-up) OR it is already in `relevant` (a child
    // dir that ALREADY collapsed on a deeper iteration — deepest-first ordering).
    const relevantVisited = visitedChildren.filter(
      (c) => relevant.has(c) || (visited.get(c)?.countsForCollapse ?? false),
    );
    const fraction = relevantVisited.length / visitedChildren.length;
    if (fraction >= o.collapseFraction) {
      // Collapse: the dir's path replaces those children in the relevant set (the
      // true minimal covering set). The collapsed dir can itself participate in its
      // parent's fraction on a later (shallower) iteration.
      for (const c of visitedChildren) relevant.delete(c);
      relevant.add(dirPath);
    }
  }

  // ── Assemble the scored manifest ───────────────────────────────────────────
  // Emit every visited node (excluding root) ranked by finalScore, capped at maxResults.
  const allScored = [...visited.entries()]
    .filter(([p]) => p !== '')
    .map(([, rec]) => rec)
    .sort((a, b) => b.finalScore - a.finalScore || a.node.path.localeCompare(b.node.path));
  if (allScored.length > o.maxResults) truncated = true;
  const capped = allScored.slice(0, o.maxResults);

  let withSummary = 0;
  const scored: ScoredNode[] = capped.map((rec) => {
    const hasSummary = rec.node.summary.trim().length > 0;
    if (hasSummary) withSummary += 1;
    const entry: ScoredNode = {
      path: rec.node.path,
      kind: rec.node.kind,
      score: rec.finalScore,
      fresh: false, // filled in below from the batched oid map
    };
    if (hasSummary) {
      // SAFETY CONTRACT: neutralize instruction-shaped content, THEN delimit as
      // untrusted data. The downstream sub-agent reading this JSON must treat the
      // summary as quoted data, never as an instruction.
      const { text } = neutralizeInstructionShapedContent(rec.node.summary);
      entry.summary = delimitUntrusted(rec.node.path || 'root', text);
    }
    if (rec.node.confidence) entry.confidence = rec.node.confidence;
    return entry;
  });

  // ── fresh: ONE batched current-oid read, compared to each node's stored codeHash ──
  const oidMap = tree.currentOidMap();
  for (let i = 0; i < scored.length; i++) {
    const rec = capped[i];
    const current = oidMap.get(rec.node.path);
    // fresh iff the node was authored (codeHash set) AND its current oid matches.
    scored[i].fresh = rec.node.codeHash != null && current != null && current === rec.node.codeHash;
  }

  // relevantPaths: the collapsed relevant set, sorted, also capped at maxResults
  // breadth (the collapse already minimizes it; the cap is the honest bound).
  let relevantPaths = [...relevant].sort();
  if (relevantPaths.length > o.maxResults) {
    truncated = true;
    relevantPaths = relevantPaths.slice(0, o.maxResults);
  }

  const summaryCoverage = scored.length === 0 ? 0 : withSummary / scored.length;

  return { query, relevantPaths, scored, summaryCoverage, nodesVisited, truncated };
}
