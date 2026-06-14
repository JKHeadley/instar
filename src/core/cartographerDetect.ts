/**
 * cartographerDetect — the PURE, importable detect/index-write logic for the
 * doc-freshness sweep, extracted so it can run OFF the server's main event loop
 * in a worker thread (fix instar#1069) while staying unit-testable in-process.
 *
 * THE INVARIANT THIS MODULE EXISTS TO HOLD (spec CARTOGRAPHER-SWEEP-EVENTLOOP-SAFETY):
 * the cartographer index on a real tree is hundreds of thousands of nodes / tens
 * of megabytes. Parsing it and walking it is an O(nodeCount)/O(67MB) synchronous
 * operation that MUST NOT run on the server's main thread — doing so starves the
 * event loop, `/health` stops answering, and the supervisor kill-loops the server.
 * So:
 *   - This module is `import_type`-only against CartographerTree (no value import
 *     of the storage class), so a `worker_threads` worker can load the compiled
 *     `.js` without dragging the whole server in.
 *   - `runDetect()` reads + parses the index, derives staleness from ONE batched
 *     `git ls-tree` (explicit large maxBuffer — never the 10MB default that throws
 *     on a big tree), orders a BOUNDED candidate set via bounded heaps (never a
 *     full sort of a full materialized array), computes the freshness aggregate,
 *     applies the pass's anti-starvation defer increments, and writes the index
 *     ONCE. It reads ZERO per-node files (every field it needs — including the
 *     accumulated `staleSincePass`, the `firstSeenAt` grace anchor, and the
 *     `authorFailed` quarantine flag — is carried on the index entry).
 *   - `applyIndexDeltas()` is the author-phase write: it re-reads the index,
 *     applies the ≤maxNodesPerPass authored-summary deltas, and writes ONCE — so
 *     authoring N nodes is ONE off-thread 67MB write, not N per-node main-thread
 *     parse+serialize (closes the sixth starver).
 *
 * Both functions are shared VERBATIM by the worker wrapper AND the synchronous
 * rollback path (`freshnessSweep.detectInWorker: false`): the byte-guard, the
 * explicit git maxBuffer, the bounded heap ordering, and the refusal taxonomy are
 * properties of THIS module, so the rollback runs the same bounded logic on the
 * main thread (bounded — never the legacy `tree.staleNodes()` full walk).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import type {
  CartographerIndex,
  CartographerIndexEntry,
  StalenessStatus,
} from './CartographerTree.js';
import { SafeGitExecutor } from './SafeGitExecutor.js';
import { isSecretBearingPath } from './cartographerSummary.js';

const GIT_OP = 'cartographer-detect';

/**
 * Every detect failure path sets `refused: true` + one of these reasons so it
 * flows through the poller's `r.refused` branch and feeds the breaker — a
 * refusal is NEVER mistaken for "genuinely nothing to do". `detect-timeout` and
 * `detect-worker-start-failure` are set by the ENGINE (the worker can't report
 * its own timeout/start failure); the rest are set here.
 */
export type DetectRefusalReason =
  | 'detect-index-too-large'
  | 'detect-index-unreadable'
  | 'detect-git-error'
  | 'detect-timeout'
  | 'detect-worker-start-failure';

export interface DetectInput {
  /** Absolute path to the cartographer index.json. */
  indexPath: string;
  /** Repo root the git plumbing runs against. */
  projectDir: string;
  /** Refuse (detect-index-too-large) above this on-disk byte size BEFORE parsing. */
  maxIndexBytes: number;
  /** Hard cap on the ordered candidate list this pass returns (maxNodesPerPass × headroom). */
  maxCandidates: number;
  /** Per-pass author budget — used for the anti-starvation front-bias cap (maxNodesPerPass/2). */
  maxNodesPerPass: number;
  /** A deferred dir at/above this defer count is force-promoted (anti-starvation). */
  maxDeferredPasses: number;
  /** How many oldest-fresh nodes to nominate for re-validation this pass. */
  revalidateSamplePerPass: number;
  /** Grace window for the never-authored-past-grace freshness split. */
  graceMs: number;
  /** Explicit git ls-tree maxBuffer (≥64MB) so a big tree never throws ENOBUFS. */
  gitMaxBuffer: number;
  /** Cap on the published stale sample written to the snapshot (the /stale surface). */
  snapshotSampleMax: number;
  /** Wall clock for the grace computation (injected for deterministic tests). */
  nowMs: number;
}

export interface DetectCounts {
  nodeCount: number;
  authoredCount: number;
  neverAuthored: number;
  stale: number;
  pathGone: number;
  generatedAt: string | null;
  headSha: string | null;
}

/** The full freshness aggregate (so `/cartographer/health` never recomputes it on the request thread). */
export interface DetectFreshness {
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
}

export interface DetectResult {
  refused: boolean;
  refusalReason?: DetectRefusalReason;
  /** Ordered, BOUNDED (≤ maxCandidates) author candidates (deepest/anti-starvation first). */
  candidates: string[];
  /** Count of dirs whose `staleSincePass` was incremented + persisted this pass. */
  deferredApplied: number;
  counts: DetectCounts;
  freshness: DetectFreshness;
  /** Oldest-authored fresh node paths to re-validate (≤ revalidateSamplePerPass). */
  revalidationSample: string[];
  /** Bounded, secret-filtered stale sample for the /cartographer/stale snapshot. */
  staleSample: { path: string; status: StalenessStatus }[];
  /** Total stale+never-authored candidates (the sample's `total` for truncation honesty). */
  staleTotal: number;
  /** Measured wall-clock of this detect (operators tune detectTimeoutMs from this). */
  durationMs: number;
  /** True when the index file did not exist (distinct from a refusal — boot scaffold builds it). */
  indexMissing?: boolean;
}

/** The detect-health enum carried on the snapshot + both read routes. */
export type LastDetectStatus =
  | 'ok'
  | 'timeout'
  | 'worker-start-failed'
  | 'index-too-large'
  | 'index-unreadable'
  | 'git-error'
  | 'not-lease-holder';

/**
 * The small, per-host snapshot every /cartographer/* read route serves from —
 * so no request path ever parses the 67MB index or walks the tree. Written
 * atomically by the sweep engine after each detect; never committed (it is
 * per-host state under .instar/cartographer/).
 */
export interface CartographerSnapshot {
  generatedAt: string;
  headSha: string | null;
  counts: DetectCounts;
  freshness: DetectFreshness;
  staleSample: { path: string; status: StalenessStatus }[];
  staleTotal: number;
  staleSampleTruncated: boolean;
  lastDetectStatus: LastDetectStatus;
  lastDetectAt: string;
  durationMs: number;
}

/** One authored-summary delta applied to the index in the single author-phase write. */
export interface IndexDelta {
  path: string;
  /** Present when the node's summary/codeHash changed (an author or fingerprint refresh). */
  summaryUpdatedAt?: string | null;
  codeHash?: string | null;
  /** Reset to 0 on a successful author. */
  staleSincePass?: number;
  /** Quarantine bookkeeping (failure path). */
  authorFailed?: boolean;
}

export interface ApplyDeltasInput {
  indexPath: string;
  maxIndexBytes: number;
  deltas: IndexDelta[];
}

// ── pure helpers (no I/O) ──────────────────────────────────────────────────

function deriveStatus(storedHash: string | null, currentOid: string | undefined): StalenessStatus {
  if (storedHash == null) return 'never-authored';
  if (currentOid == null) return 'path-gone';
  return currentOid === storedHash ? 'fresh' : 'stale';
}

function depthOf(p: string): number {
  if (p === '') return 0;
  return p.split('/').length;
}

function parentOf(p: string): string {
  if (p === '') return '';
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function atomicWrite(filePath: string, contents: string): void {
  // Per-host-unique tmp suffix so a shared state dir across machines can't collide.
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

// ── git plumbing (explicit large maxBuffer; failure → caller refuses) ────────

/** Throws on git failure so the caller can map it to a `detect-git-error` refusal. */
function readCurrentOids(projectDir: string, gitMaxBuffer: number): Map<string, string> {
  const map = new Map<string, string>();
  const rootTree = SafeGitExecutor.readSync(['rev-parse', 'HEAD^{tree}'], {
    cwd: projectDir, operation: GIT_OP, maxBuffer: gitMaxBuffer,
  });
  if (rootTree) map.set('', rootTree.trim());
  const out = SafeGitExecutor.readSync(['ls-tree', '-r', '-t', '-z', 'HEAD'], {
    cwd: projectDir, operation: GIT_OP, maxBuffer: gitMaxBuffer,
  });
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const meta = entry.slice(0, tab).split(' ');
    const p = entry.slice(tab + 1);
    const oid = meta[2];
    if (oid && p) map.set(p, oid);
  }
  return map;
}

function headShort(projectDir: string): string | null {
  try {
    const out = SafeGitExecutor.readSync(['rev-parse', '--short', 'HEAD'], {
      cwd: projectDir, operation: GIT_OP, maxBuffer: 1024 * 1024,
    });
    return out ? out.trim() : null;
  } catch {
    // @silent-fallback-ok — headSha is provenance-only; absence is reported as null,
    // never a refusal (the ls-tree read above is the one that gates the pass).
    return null;
  }
}

// ── bounded top-N min-heap (keeps the N highest-priority items, O(N) memory) ──

/**
 * A fixed-capacity min-heap keyed by a numeric priority where HIGHER priority =
 * keep. Streaming every candidate through `offer()` keeps only the top `cap`
 * without ever materializing or sorting the full candidate set — the structural
 * guarantee that peak memory is O(cap), not O(nodeCount).
 */
class BoundedTopHeap<T> {
  private readonly heap: { key: number; tie: string; v: T }[] = [];
  private peak = 0;
  constructor(private readonly cap: number) {}

  offer(key: number, tie: string, v: T): void {
    if (this.cap <= 0) return;
    if (this.heap.length < this.cap) {
      this.heap.push({ key, tie, v });
      this.siftUp(this.heap.length - 1);
    } else if (this.worseThanRoot(key, tie)) {
      // new item outranks the current minimum → replace root
      this.heap[0] = { key, tie, v };
      this.siftDown(0);
    }
    if (this.heap.length > this.peak) this.peak = this.heap.length;
  }

  /** Highest-priority first. */
  drainSorted(): T[] {
    return [...this.heap]
      .sort((a, b) => b.key - a.key || a.tie.localeCompare(b.tie))
      .map((e) => e.v);
  }

  peakSize(): number { return this.peak; }

  private worseThanRoot(key: number, tie: string): boolean {
    const r = this.heap[0];
    return key > r.key || (key === r.key && tie.localeCompare(r.tie) < 0);
  }
  private less(a: { key: number; tie: string }, b: { key: number; tie: string }): boolean {
    // min-heap: the WORST (lowest priority) item floats to the root so it's evicted first
    return a.key < b.key || (a.key === b.key && a.tie.localeCompare(b.tie) > 0);
  }
  private siftUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(this.heap[i], this.heap[p])) { this.swap(i, p); i = p; } else break;
    }
  }
  private siftDown(i: number): void {
    const n = this.heap.length;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let s = i;
      if (l < n && this.less(this.heap[l], this.heap[s])) s = l;
      if (r < n && this.less(this.heap[r], this.heap[s])) s = r;
      if (s === i) break;
      this.swap(i, s); i = s;
    }
  }
  private swap(i: number, j: number): void { const t = this.heap[i]; this.heap[i] = this.heap[j]; this.heap[j] = t; }
}

// ── runDetect ───────────────────────────────────────────────────────────────

/** Internal: instrumentation surfaced for tests (peak heap + node-file reads). */
export interface DetectInstrumentation {
  candidateHeapPeak: number;
  starvedHeapPeak: number;
  /** Always 0 — detect reads ZERO node files; the test asserts this. */
  nodeFileReads: number;
}

export function runDetect(input: DetectInput, instr?: DetectInstrumentation): DetectResult {
  const startedAt = Date.now();
  const emptyCounts: DetectCounts = {
    nodeCount: 0, authoredCount: 0, neverAuthored: 0, stale: 0, pathGone: 0,
    generatedAt: null, headSha: null,
  };
  const emptyFreshness: DetectFreshness = {
    nodeCount: 0, authorableCount: 0, freshCount: 0, staleCount: 0,
    neverAuthoredCount: 0, neverAuthoredWithinGrace: 0, neverAuthoredPastGrace: 0,
    authorFailedCount: 0, freshRatio: 1, generatedAt: null,
  };
  const refuse = (reason: DetectRefusalReason): DetectResult => ({
    refused: true, refusalReason: reason, candidates: [], deferredApplied: 0,
    counts: emptyCounts, freshness: emptyFreshness, revalidationSample: [],
    staleSample: [], staleTotal: 0, durationMs: Date.now() - startedAt,
  });

  // Index missing → NOT a refusal (the boot scaffold builds it); honest empty result.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(input.indexPath);
  } catch {
    return {
      refused: false, candidates: [], deferredApplied: 0, counts: emptyCounts,
      freshness: emptyFreshness, revalidationSample: [], staleSample: [], staleTotal: 0,
      durationMs: Date.now() - startedAt, indexMissing: true,
    };
  }
  // Pre-parse byte guard — the REAL bound on the parse (terminate() cannot interrupt
  // a synchronous JSON.parse already in flight). Refuse before attempting it.
  if (stat.size > input.maxIndexBytes) return refuse('detect-index-too-large');

  let index: CartographerIndex;
  try {
    index = JSON.parse(fs.readFileSync(input.indexPath, 'utf8')) as CartographerIndex;
    if (!index || typeof index !== 'object' || !index.nodes) return refuse('detect-index-unreadable');
  } catch {
    return refuse('detect-index-unreadable');
  }

  let current: Map<string, string>;
  try {
    current = readCurrentOids(input.projectDir, input.gitMaxBuffer);
  } catch {
    // A git read failure must be a NAMED refusal — never "every node path-gone"
    // (that would silently mark the whole tree stale and author churn).
    return refuse('detect-git-error');
  }
  const headSha = headShort(input.projectDir);

  // ── Pass A: derive status for every node; accumulate counts + freshness;
  //    collect the candidate set; feed the oldest-fresh revalidation heap. ──
  const entries = Object.entries(index.nodes);
  const candidateSet = new Set<string>();
  const staleSample: { path: string; status: StalenessStatus }[] = [];
  let authoredCount = 0, neverAuthored = 0, stale = 0, pathGone = 0;
  let authorable = 0, fresh = 0, never = 0, neverWithin = 0, neverPast = 0, authorFailed = 0;
  const revalHeap = new BoundedTopHeap<string>(Math.max(0, input.revalidateSamplePerPass));
  const sampleCap = Math.max(0, input.snapshotSampleMax);

  const addCandidate = (p: string, status: StalenessStatus): void => {
    candidateSet.add(p);
    // Secret-bearing path NAMES are excluded from the published sample so they are
    // never surfaced via the /stale route or the Files tab (they are still authored-
    // excluded by the engine; only their NAME is withheld from the snapshot).
    if (staleSample.length < sampleCap && !isSecretBearingPath(p)) {
      staleSample.push({ path: p, status });
    }
  };

  for (const [p, entry] of entries) {
    const status = deriveStatus(entry.codeHash, current.get(p));
    if (entry.codeHash != null) authoredCount += 1; else neverAuthored += 1;

    if (status === 'path-gone') { pathGone += 1; continue; }
    authorable += 1;
    if (entry.authorFailed === true) authorFailed += 1;
    if (status === 'fresh') {
      fresh += 1;
      if (entry.summaryUpdatedAt != null) {
        // Re-validation nominee priority: OLDEST summaryUpdatedAt first → higher
        // priority = larger (nowMs - updatedAt), so older summaries win the heap.
        const age = input.nowMs - Date.parse(entry.summaryUpdatedAt);
        revalHeap.offer(Number.isFinite(age) ? age : 0, p, p);
      }
    } else if (status === 'stale') {
      stale += 1;
      addCandidate(p, status);
    } else if (status === 'never-authored') {
      never += 1;
      const firstSeen = entry.firstSeenAt ? Date.parse(entry.firstSeenAt) : input.nowMs;
      if (Number.isFinite(firstSeen) && input.nowMs - firstSeen > input.graceMs) neverPast += 1;
      else neverWithin += 1;
      addCandidate(p, status);
    }
  }

  // ── childrenOf adjacency from PATH STRINGS in the parsed index (zero node-file
  //    reads) — needed for the dir-defer rule (author a dir after its candidate
  //    children). Derived from the index we already parsed, never the filesystem. ──
  const childrenOf = new Map<string, string[]>();
  for (const [p] of entries) {
    if (p === '') continue;
    const par = parentOf(p);
    const arr = childrenOf.get(par);
    if (arr) arr.push(p); else childrenOf.set(par, [p]);
  }

  // ── Pass B: order candidates through bounded heaps (NEVER a full sort of the
  //    full set — peak memory O(maxCandidates), not O(nodeCount)). Deepest-first
  //    guarantees children are authored before their parent dir IN THE SAME pass.
  //    A starved dir (deferred past maxDeferredPasses) gets a capped front-bias
  //    lane. A dir that is evicted by the per-pass bound AND still has a candidate
  //    child is "deferred": its anti-starvation counter is bumped so a subtree
  //    perpetually pushed out by deeper churn is eventually promoted. ──
  const frontCap = Math.max(1, Math.floor(input.maxNodesPerPass / 2));
  const candidateHeap = new BoundedTopHeap<string>(input.maxCandidates);
  const starvedHeap = new BoundedTopHeap<string>(frontCap);

  for (const p of candidateSet) {
    const entry = index.nodes[p];
    const starved = entry.kind === 'dir' && (entry.staleSincePass ?? 0) >= input.maxDeferredPasses;
    if (starved) starvedHeap.offer(depthOf(p), p, p);
    else candidateHeap.offer(depthOf(p), p, p);
  }

  const starvedList = starvedHeap.drainSorted();
  const normalList = candidateHeap.drainSorted();
  const starvedSet = new Set(starvedList);
  const candidates = [...starvedList, ...normalList.filter((p) => !starvedSet.has(p))].slice(0, input.maxCandidates);

  // Anti-starvation: a dir candidate the bound pushed out, that still has a
  // candidate child, gets its defer counter bumped (persisted in write (a)).
  const selected = new Set(candidates);
  let deferredApplied = 0;
  for (const p of candidateSet) {
    const entry = index.nodes[p];
    if (entry.kind !== 'dir' || selected.has(p)) continue;
    const kids = childrenOf.get(p);
    if (kids && kids.some((c) => candidateSet.has(c))) {
      entry.staleSincePass = (entry.staleSincePass ?? 0) + 1;
      deferredApplied += 1;
    }
  }

  if (instr) {
    instr.candidateHeapPeak = candidateHeap.peakSize();
    instr.starvedHeapPeak = starvedHeap.peakSize();
    instr.nodeFileReads = 0; // detect NEVER reads node files
  }

  // ── Detect-phase index write (a): persist the defer increments ONCE, off the
  //    main thread. The deferred set never crosses the worker boundary. ──
  if (deferredApplied > 0) {
    atomicWrite(input.indexPath, JSON.stringify(index, null, 2));
  }

  const ratioDenom = fresh + stale + neverPast;
  return {
    refused: false,
    candidates,
    deferredApplied,
    counts: {
      nodeCount: entries.length,
      authoredCount,
      neverAuthored,
      stale,
      pathGone,
      generatedAt: index.generatedAt ?? null,
      headSha,
    },
    freshness: {
      nodeCount: entries.length,
      authorableCount: authorable,
      freshCount: fresh,
      staleCount: stale,
      neverAuthoredCount: never,
      neverAuthoredWithinGrace: neverWithin,
      neverAuthoredPastGrace: neverPast,
      authorFailedCount: authorFailed,
      freshRatio: ratioDenom === 0 ? 1 : fresh / ratioDenom,
      generatedAt: index.generatedAt ?? null,
    },
    revalidationSample: revalHeap.drainSorted(),
    staleSample,
    staleTotal: candidateSet.size,
    durationMs: Date.now() - startedAt,
  };
}

// ── snapshot read/write (the per-host file every read route serves from) ──────

export function writeSnapshot(snapshotPath: string, snap: CartographerSnapshot): void {
  atomicWrite(snapshotPath, JSON.stringify(snap, null, 2));
}

export function readSnapshot(snapshotPath: string): CartographerSnapshot | null {
  try {
    const raw = fs.readFileSync(snapshotPath, 'utf8');
    const snap = JSON.parse(raw) as CartographerSnapshot;
    if (!snap || typeof snap !== 'object' || !snap.counts) return null;
    return snap;
  } catch {
    // @silent-fallback-ok — a missing/corrupt snapshot reads as "absent"; the
    // routes serve snapshot:'absent' and the next detect rewrites it.
    return null;
  }
}

// ── applyIndexDeltas (author-phase write — ONE off-thread 67MB write) ─────────

export function applyIndexDeltas(input: ApplyDeltasInput): { written: number; refused: boolean; refusalReason?: DetectRefusalReason } {
  if (input.deltas.length === 0) return { written: 0, refused: false };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(input.indexPath);
  } catch {
    return { written: 0, refused: true, refusalReason: 'detect-index-unreadable' };
  }
  if (stat.size > input.maxIndexBytes) return { written: 0, refused: true, refusalReason: 'detect-index-too-large' };

  let index: CartographerIndex;
  try {
    index = JSON.parse(fs.readFileSync(input.indexPath, 'utf8')) as CartographerIndex;
    if (!index || !index.nodes) return { written: 0, refused: true, refusalReason: 'detect-index-unreadable' };
  } catch {
    return { written: 0, refused: true, refusalReason: 'detect-index-unreadable' };
  }

  let written = 0;
  for (const d of input.deltas) {
    const entry = index.nodes[d.path] as CartographerIndexEntry | undefined;
    if (!entry) continue;
    if (Object.prototype.hasOwnProperty.call(d, 'summaryUpdatedAt')) entry.summaryUpdatedAt = d.summaryUpdatedAt ?? null;
    if (Object.prototype.hasOwnProperty.call(d, 'codeHash')) entry.codeHash = d.codeHash ?? null;
    if (Object.prototype.hasOwnProperty.call(d, 'staleSincePass')) entry.staleSincePass = d.staleSincePass;
    if (Object.prototype.hasOwnProperty.call(d, 'authorFailed')) entry.authorFailed = d.authorFailed;
    written += 1;
  }
  if (written > 0) atomicWrite(input.indexPath, JSON.stringify(index, null, 2));
  return { written, refused: false };
}
