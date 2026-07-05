/**
 * WorkingSetPull — P2.2 of multi-machine coherence: both sides of the
 * chunked, bounded, verified `working-set-pull` mesh verb.
 *
 * Spec: docs/specs/WORKING-SET-HANDOFF-SPEC.md §3.2 (the verb), §3.5
 * (never-clobber). Transport-agnostic: the server registers the serve side
 * as the verb handler; the puller drives the receive side through an
 * injected `send` seam (MeshRpcClient upstream).
 *
 * Load-bearing transport rules (§3.2):
 *  - Every response carries at most `pullMaxBatchBytes` (1 MiB default) of
 *    content — a single 32 MiB JSON.stringify is the host's DOCUMENTED
 *    event-loop-starvation root cause.
 *  - Cross-chunk consistency anchor: the offset-0 response alone carries the
 *    whole-file sha256 (ONE full read+hash, amortized) + a cheap fstat
 *    anchor {bytes, mtimeNs, ino}; later chunks carry the fstat anchor only.
 *    Anchor mismatch → restart FROM 0, bounded by chunkRestartCap, then the
 *    file is `unstable` (surfaced, never a livelock).
 *  - `busy` is retry-without-penalty: it never consumes the pending-pull
 *    breaker's failure budget (§3.2/§3.4).
 *  - maxTotalBytes counts ASSEMBLED, verification-passed bytes — never raw
 *    wire bytes (anchor restarts can't starve the set's remaining files).
 *  - Serve side: the FRESH manifest is the allowlist (recomputed per
 *    request); O_NOFOLLOW open + fd identity verify (TOCTOU defense);
 *    at most `serveConcurrency` requests served at once.
 *  - Receive side: peer relPath is HOSTILE input; full jail before any
 *    join; never-clobber with hash-suffixed alongside copies (cap 2,
 *    eviction via SafeFsExecutor — the single, narrow deletion exception).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SafeFsExecutor } from './SafeFsExecutor.js';
import {
  computeWorkingSet,
  DEFAULT_WORKING_SET_CAPS,
  type WorkingSetCaps,
  type WorkingSetManifestResult,
} from './WorkingSetManifest.js';
import type { OwnAutonomousRuns } from './CoherenceJournalReader.js';

// ── Wire shapes ─────────────────────────────────────────────────────

export const DEFAULT_PULL_MAX_BATCH_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_CHUNK_RESTART_CAP = 3;
export const DEFAULT_CHUNKS_PER_TICK = 8;
export const DEFAULT_SERVE_CONCURRENCY = 2;
export const DEFAULT_BUSY_RETRY_CAP = 10;

/** Cheap per-chunk tear detector (§3.2) — fstat, never a content re-hash. */
export interface GenerationAnchor {
  bytes: number;
  mtimeNs: string; // BigInt serialized — JSON-safe
  ino: string;
}

export interface ServedBlob {
  relPath: string;
  offset: number;
  dataB64: string;
  anchor: GenerationAnchor;
  /** Offset-0 responses only: the whole file's sha256 (the assembly authority). */
  fileSha256?: string;
  /** True when this chunk reaches end-of-file. */
  eof: boolean;
  /** Served hash differs from the requester's manifest view (§3.2 — served wins). */
  changedSinceManifest?: boolean;
}

export type RefusalReason =
  | 'refusedPolicy'        // outside the fresh manifest / flagged / capped
  | 'goneSinceManifest'    // benign evolution, never logged as an attack
  | 'liveSource'           // still being written (§3.2)
  | 'secretFlagged'
  | 'tooLarge';

export interface ServeResult {
  busy?: boolean;
  manifest?: WorkingSetManifestResult;
  blobs?: ServedBlob[];
  refused?: { relPath: string; reason: RefusalReason }[];
}

// ── Serve side ──────────────────────────────────────────────────────

export interface ServeDeps {
  stateDir: string;
  /** Own-stream journal evidence for the topic (reader, threaded by server). */
  readRuns: (topic: number) => OwnAutonomousRuns;
  /** Source 3 (intelligent-working-set-lazy-sync): relPaths of the topic's READY interactive
   *  artifact rows (threaded by server from the WorkingSetArtifactManager). Absent ⇒ no
   *  interactive source (byte-identical to before). Each is re-jailed + scanned in
   *  computeWorkingSet exactly like the other sources. */
  readInteractiveArtifacts?: (topic: number) => string[];
  caps?: Partial<WorkingSetCaps>;
  pullMaxBatchBytes?: number;
  serveConcurrency?: number;
  logger?: (msg: string) => void;
}

export interface WorkingSetPullCmd {
  type: 'working-set-pull';
  topic: number;
  manifestOnly?: boolean;
  want?: { relPath: string; offset: number }[];
}

/**
 * The serve-side handler — stateless per request except the concurrency
 * gate. Registered by the server as the `working-set-pull` verb handler.
 */
export class WorkingSetPullServer {
  private inFlight = 0;
  private readonly d: ServeDeps;

  constructor(deps: ServeDeps) {
    this.d = deps;
  }

  handle(cmd: WorkingSetPullCmd): ServeResult {
    const cap = this.d.serveConcurrency ?? DEFAULT_SERVE_CONCURRENCY;
    if (this.inFlight >= cap) return { busy: true }; // honest throttle (§3.2)
    this.inFlight++;
    try {
      return this.handleInner(cmd);
    } finally {
      this.inFlight--;
    }
  }

  private handleInner(cmd: WorkingSetPullCmd): ServeResult {
    // The FRESH manifest is the allowlist — recomputed on every request,
    // never cached across calls (§3.2). There is no generic file-read surface.
    const manifest = computeWorkingSet({
      stateDir: this.d.stateDir,
      topic: cmd.topic,
      runs: this.d.readRuns(cmd.topic),
      caps: this.d.caps,
      interactiveArtifactRelPaths: this.d.readInteractiveArtifacts?.(cmd.topic),
    });
    if (cmd.manifestOnly || !cmd.want?.length) return { manifest };

    const stateDir = realStateDir(this.d.stateDir);
    const batchBudget = this.d.pullMaxBatchBytes ?? DEFAULT_PULL_MAX_BATCH_BYTES;
    let budgetLeft = batchBudget;

    const byRel = new Map(manifest.entries.map((e) => [e.relPath, e]));
    const blobs: ServedBlob[] = [];
    const refused: { relPath: string; reason: RefusalReason }[] = [];

    for (const want of cmd.want) {
      if (budgetLeft <= 0) break; // remaining wants ride the next request
      const entry = byRel.get(want.relPath);
      if (!entry) {
        refused.push({ relPath: want.relPath, reason: 'refusedPolicy' });
        continue;
      }
      if (entry.liveSource) {
        refused.push({ relPath: want.relPath, reason: 'liveSource' });
        continue;
      }
      if (entry.secretFlagged) {
        refused.push({ relPath: want.relPath, reason: 'secretFlagged' });
        continue;
      }
      if (entry.tooLarge) {
        refused.push({ relPath: want.relPath, reason: 'tooLarge' });
        continue;
      }

      const abs = path.join(stateDir, entry.relPath);
      const served = this.serveChunk(abs, want.offset, budgetLeft, entry.sha256);
      if (served === 'gone') {
        refused.push({ relPath: want.relPath, reason: 'goneSinceManifest' });
        continue;
      }
      if (served === null) {
        refused.push({ relPath: want.relPath, reason: 'refusedPolicy' });
        continue;
      }
      budgetLeft -= Buffer.byteLength(served.dataB64, 'utf-8');
      blobs.push({ ...served, relPath: want.relPath, offset: want.offset });
    }

    return { blobs, refused };
  }

  /**
   * TOCTOU-safe single-chunk read (§3.2): open O_NOFOLLOW (refuses a symlink
   * swapped in at the final component), fstat the FD (regular file), and
   * verify FD identity against a fresh lstat of the same path (same dev+ino
   * → the fd IS the file at the jailed path, not a different object raced
   * in). Bytes are read once; the offset-0 read covers the whole file so the
   * assembly hash comes from the exact served bytes.
   */
  private serveChunk(
    abs: string,
    offset: number,
    budget: number,
    manifestSha: string | null,
  ): (Omit<ServedBlob, 'relPath' | 'offset'>) | 'gone' | null {
    let fd: number;
    try {
      fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 'gone';
      return null; // ELOOP (symlink) and friends → policy refusal
    }
    try {
      const st = fs.fstatSync(fd, { bigint: true });
      if (!st.isFile()) return null;
      let lst: fs.BigIntStats;
      try {
        lst = fs.lstatSync(abs, { bigint: true });
      } catch {
        return 'gone';
      }
      if (lst.ino !== st.ino || lst.dev !== st.dev) return null; // raced object swap

      const size = Number(st.size);
      const anchor: GenerationAnchor = {
        bytes: size,
        mtimeNs: st.mtimeNs.toString(),
        ino: st.ino.toString(),
      };

      if (offset < 0 || offset > size) return null;

      if (offset === 0) {
        // ONE full read+hash — the assembly authority. The first chunk is
        // sliced from these exact bytes (read-once, hash-from-served-bytes).
        const whole = Buffer.alloc(size);
        let readTotal = 0;
        while (readTotal < size) {
          const n = fs.readSync(fd, whole, readTotal, size - readTotal, readTotal);
          if (n <= 0) break;
          readTotal += n;
        }
        if (readTotal !== size) return null; // shrank mid-read → refuse, puller restarts
        const fileSha256 = crypto.createHash('sha256').update(whole).digest('hex');
        const sliceLen = Math.min(size, maxContentBytes(budget));
        const data = whole.subarray(0, sliceLen);
        return {
          dataB64: data.toString('base64'),
          anchor,
          fileSha256,
          eof: sliceLen >= size,
          ...(manifestSha && fileSha256 !== manifestSha ? { changedSinceManifest: true } : {}),
        };
      }

      const len = Math.min(size - offset, maxContentBytes(budget));
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, offset + got);
        if (n <= 0) break;
        got += n;
      }
      return {
        dataB64: buf.subarray(0, got).toString('base64'),
        anchor,
        eof: offset + got >= size,
      };
    } finally {
      try {
        fs.closeSync(fd);
      } catch { /* @silent-fallback-ok: double-close/EBADF on cleanup is harmless; the read already completed or failed above (WORKING-SET-HANDOFF-SPEC §3.2) */
      }
    }
  }
}

/** base64 inflates 4/3 — convert a response-byte budget to raw content bytes. */
function maxContentBytes(budgetB64Bytes: number): number {
  return Math.max(0, Math.floor((budgetB64Bytes * 3) / 4));
}

function realStateDir(stateDir: string): string {
  try {
    return fs.realpathSync(path.resolve(stateDir));
  } catch { /* @silent-fallback-ok: a not-yet-existing stateDir keeps its lexical path; the jail still bounds it (WORKING-SET-HANDOFF-SPEC §3.1) */
    return path.resolve(stateDir);
  }
}

// ── Receive side ────────────────────────────────────────────────────

export interface PullerDeps {
  stateDir: string;
  /** Send one verb request to the nominee peer. Throws on transport failure. */
  send: (cmd: WorkingSetPullCmd) => Promise<ServeResult>;
  /** Short stable id of the SENDER machine (alongside naming, from env.sender). */
  senderShortId: string;
  /** Re-checked before EVERY write (§3.3): still the owner at this epoch? */
  stillCurrent: () => boolean;
  caps?: Partial<WorkingSetCaps>;
  pullMaxBatchBytes?: number;
  chunkRestartCap?: number;
  chunksPerTick?: number;
  busyRetryCap?: number;
  /** Event-loop yield between chunk groups (test seam; default setImmediate). */
  yieldFn?: () => Promise<void>;
  /** Inter-chunk delay under pressure (ms); 0 default, the scheduler stretches. */
  interChunkDelayMs?: number;
  logger?: (msg: string) => void;
}

export interface PullFileOutcome {
  relPath: string;
  outcome:
    | 'written'
    | 'skippedExisting'
    | 'alongside'
    | 'unstable'
    | 'refused'
    | 'liveSourceDeferred'
    | 'superseded'
    | 'budgetExhausted'
    | 'busyExhausted'
    | 'verifyFailed';
  reason?: string;
  alongsidePath?: string;
}

export interface PullReport {
  topic: number;
  files: PullFileOutcome[];
  assembledBytes: number;
  /** True when ANY outcome warrants a pending-pull record (§3.4). */
  needsPendingPull: boolean;
}

export class WorkingSetPuller {
  private readonly d: PullerDeps;

  constructor(deps: PullerDeps) {
    this.d = deps;
  }

  /**
   * Pull one topic's transferables from the nominee behind `send`.
   * The caller (trigger/ledger layer) handles nomination, single-flight,
   * staggered drain, and pending-pull filing off `needsPendingPull`.
   */
  async pullTopic(topic: number): Promise<PullReport> {
    const caps = { ...DEFAULT_WORKING_SET_CAPS, ...this.d.caps };
    const report: PullReport = { topic, files: [], assembledBytes: 0, needsPendingPull: false };

    let first: ServeResult;
    try {
      first = await this.sendWithBusyRetry({ type: 'working-set-pull', topic, manifestOnly: true });
    } catch (e) {
      report.needsPendingPull = true;
      report.files.push({ relPath: '*', outcome: 'refused', reason: `transport: ${(e as Error).message}` });
      return report;
    }
    if (first.busy) {
      report.needsPendingPull = true;
      report.files.push({ relPath: '*', outcome: 'busyExhausted' });
      return report;
    }
    const manifest = first.manifest;
    if (!manifest) {
      report.files.push({ relPath: '*', outcome: 'refused', reason: 'no manifest in response' });
      return report;
    }

    let chunksThisTick = 0;
    const chunksPerTick = this.d.chunksPerTick ?? DEFAULT_CHUNKS_PER_TICK;

    for (const entry of manifest.entries) {
      if (entry.liveSource) {
        report.files.push({ relPath: entry.relPath, outcome: 'liveSourceDeferred' });
        report.needsPendingPull = true; // re-fires on the run's `stopped` (§3.4)
        continue;
      }
      if (entry.secretFlagged || entry.tooLarge) {
        report.files.push({
          relPath: entry.relPath,
          outcome: 'refused',
          reason: entry.secretFlagged ? 'secretFlagged' : 'tooLarge',
        });
        continue;
      }
      // Budget on ASSEMBLED bytes only (§3.2) — checked before starting a file.
      if (report.assembledBytes + entry.bytes > caps.maxTotalBytes) {
        report.files.push({ relPath: entry.relPath, outcome: 'budgetExhausted' });
        continue;
      }

      const out = await this.pullFile(topic, entry.relPath, () => {
        chunksThisTick++;
        if (chunksThisTick >= chunksPerTick) {
          chunksThisTick = 0;
          return this.yieldNow();
        }
        return Promise.resolve();
      });
      report.files.push(out.outcome);
      if (out.assembled !== null && out.outcome.outcome === 'written') {
        report.assembledBytes += out.assembled;
      } else if (out.outcome.outcome === 'skippedExisting' || out.outcome.outcome === 'alongside') {
        report.assembledBytes += out.assembled ?? 0;
      }
      if (out.outcome.outcome === 'busyExhausted' || out.outcome.outcome === 'unstable') {
        report.needsPendingPull = true;
      }
    }

    return report;
  }

  // ---- one file: chunk loop + anchor + assembly verification ---------------

  private async pullFile(
    topic: number,
    relPath: string,
    perChunk: () => Promise<void>,
  ): Promise<{ outcome: PullFileOutcome; assembled: number | null }> {
    const restartCap = this.d.chunkRestartCap ?? DEFAULT_CHUNK_RESTART_CAP;

    for (let attempt = 0; attempt <= restartCap; attempt++) {
      const result = await this.pullFileOnce(topic, relPath, perChunk);
      if (result === 'restart') continue; // anchor change / assembly mismatch → from 0
      return result;
    }
    // chunkRestartCap exhausted — the file won't sit still (§3.2): surfaced,
    // never a livelock.
    return { outcome: { relPath, outcome: 'unstable' }, assembled: null };
  }

  private async pullFileOnce(
    topic: number,
    relPath: string,
    perChunk: () => Promise<void>,
  ): Promise<{ outcome: PullFileOutcome; assembled: number | null } | 'restart'> {
    const chunks: Buffer[] = [];
    let offset = 0;
    let pinnedAnchor: GenerationAnchor | null = null;
    let pinnedSha: string | null = null;

    // Hard request bound per attempt: a compliant 16MiB headline at 1MiB
    // chunks needs 16 requests; 4096 is a misbehaving-server guard, never a
    // working bound (P19 — every repeating behavior is bounded).
    for (let req = 0; req < 4096; req++) {
      let res: ServeResult;
      try {
        res = await this.sendWithBusyRetry({
          type: 'working-set-pull',
          topic,
          want: [{ relPath, offset }],
        });
      } catch (e) {
        return {
          outcome: { relPath, outcome: 'refused', reason: `transport: ${(e as Error).message}` },
          assembled: null,
        };
      }
      if (res.busy) return { outcome: { relPath, outcome: 'busyExhausted' }, assembled: null };

      const refusal = res.refused?.find((r) => r.relPath === relPath);
      if (refusal) {
        if (refusal.reason === 'liveSource') {
          return { outcome: { relPath, outcome: 'liveSourceDeferred' }, assembled: null };
        }
        return { outcome: { relPath, outcome: 'refused', reason: refusal.reason }, assembled: null };
      }
      const blob = res.blobs?.find((b) => b.relPath === relPath);
      if (!blob) {
        // Budget-paged out of THIS response — re-request the same offset.
        if (res.blobs?.length || res.refused?.length) continue;
        return { outcome: { relPath, outcome: 'refused', reason: 'empty response' }, assembled: null };
      }
      // Response bound BEFORE decode (§3.2): a peer answering with more than
      // the batch ceiling (×4/3 b64 inflation + slack) is refused, never
      // decoded. (The full pre-parse transport ceiling rides the client's
      // bounded fetch at wiring time; this is the decode-side backstop.)
      const ceiling = this.d.pullMaxBatchBytes ?? DEFAULT_PULL_MAX_BATCH_BYTES;
      if (blob.dataB64.length > Math.ceil((ceiling * 4) / 3) + 1024) {
        return { outcome: { relPath, outcome: 'refused', reason: 'oversize response' }, assembled: null };
      }

      if (offset === 0) {
        if (!blob.fileSha256) {
          return { outcome: { relPath, outcome: 'refused', reason: 'offset-0 missing fileSha256' }, assembled: null };
        }
        pinnedAnchor = blob.anchor;
        pinnedSha = blob.fileSha256;
      } else if (pinnedAnchor && !anchorsEqual(pinnedAnchor, blob.anchor)) {
        // Tear detected mid-file → restart FROM 0 (§3.2), bounded by caller.
        return 'restart';
      }

      const data = Buffer.from(blob.dataB64, 'base64');
      chunks.push(data);
      offset += data.length;
      await perChunk();
      const delay = this.d.interChunkDelayMs ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));

      if (blob.eof) break;
      if (data.length === 0) return 'restart'; // zero-progress guard — re-anchor
      if (req === 4095) {
        return { outcome: { relPath, outcome: 'refused', reason: 'request bound exceeded' }, assembled: null };
      }
    }

    const whole = Buffer.concat(chunks);
    const assembledSha = crypto.createHash('sha256').update(whole).digest('hex');
    if (!pinnedSha || assembledSha !== pinnedSha) {
      // mtime-preserving rewrite dodged the fstat anchor — assembly is the
      // authority (§3.2); restart bounded by the caller.
      return 'restart';
    }

    // Ownership recheck before EVERY write (§3.3) — superseded → abort quietly.
    if (!this.d.stillCurrent()) {
      return { outcome: { relPath, outcome: 'superseded' }, assembled: null };
    }

    const written = this.writeNeverClobber(relPath, whole, assembledSha);
    return { outcome: written, assembled: written.outcome === 'refused' ? null : whole.length };
  }

  // ---- never-clobber landing (§3.5) ----------------------------------------

  private writeNeverClobber(relPath: string, content: Buffer, sha: string): PullFileOutcome {
    const stateDir = realStateDir(this.d.stateDir);
    // Peer relPath is HOSTILE input (§3.2): relative only, no `..` segment,
    // no absolute/drive/UNC prefix — validated BEFORE any join.
    if (!isSafeRelPath(relPath)) {
      return { relPath, outcome: 'refused', reason: 'hostile relPath' };
    }
    const dest = path.resolve(stateDir, relPath);
    if (!isContained(stateDir, dest)) {
      return { relPath, outcome: 'refused', reason: 'jail escape' };
    }
    // Parent-directory realpath containment: never create-through a
    // peer-supplied symlink/junction chain (§3.2).
    const parent = path.dirname(dest);
    fs.mkdirSync(parent, { recursive: true });
    let realParent: string;
    try {
      realParent = fs.realpathSync(parent);
    } catch {
      return { relPath, outcome: 'refused', reason: 'parent unresolvable' };
    }
    if (!isContained(stateDir, realParent)) {
      return { relPath, outcome: 'refused', reason: 'parent escapes jail' };
    }
    const finalDest = path.join(realParent, path.basename(dest));

    let destExists = false;
    let destIsSame = false;
    try {
      const lst = fs.lstatSync(finalDest);
      if (lst.isSymbolicLink()) {
        return { relPath, outcome: 'refused', reason: 'destination is a symlink' };
      }
      destExists = true;
      const existing = fs.readFileSync(finalDest);
      destIsSame = crypto.createHash('sha256').update(existing).digest('hex') === sha;
    } catch { /* @silent-fallback-ok: absent destination is the normal first-transfer case — proceed to the jailed write (WORKING-SET-HANDOFF-SPEC §3.5) */
    }

    if (destExists && destIsSame) return { relPath, outcome: 'skippedExisting' };

    if (!destExists) {
      writeAtomic(finalDest, content);
      return { relPath, outcome: 'written' };
    }

    // Destination differs → alongside copy (NEVER overwrite, §3.5):
    // <sanitizedBasename>.from-<senderShortId>-<hash8><ext> — hash-suffix
    // makes repeated divergent arrivals naturally idempotent.
    const ext = path.extname(finalDest);
    const base = sanitizeBasename(path.basename(finalDest, ext));
    const shortId = sanitizeBasename(this.d.senderShortId).slice(0, 12) || 'peer';
    const alongsideName = `${base}.from-${shortId}-${sha.slice(0, 8)}${ext}`;
    const alongsidePath = path.join(realParent, alongsideName);
    if (!isContained(stateDir, alongsidePath)) {
      return { relPath, outcome: 'refused', reason: 'alongside escapes jail' };
    }
    if (!fs.existsSync(alongsidePath)) {
      writeAtomic(alongsidePath, content);
      this.evictAlongsideOverCap(realParent, base, ext, shortIdSafePrefix(base));
    }
    return { relPath, outcome: 'alongside', alongsidePath };
  }

  /**
   * Cap-2 alongside retention (§3.5) — the single, narrow deletion exception:
   * alongside files only, inside the jail, through SafeFsExecutor. The
   * evicted copy's content still exists on its producer machine (first-hop
   * provenance) — nothing is lost to the fleet, only to this replica.
   */
  private evictAlongsideOverCap(dir: string, base: string, ext: string, _prefix: string): void {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch { /* @silent-fallback-ok: eviction is best-effort housekeeping; a failed listing only delays the cap (WORKING-SET-HANDOFF-SPEC §3.5) */
      return;
    }
    const re = new RegExp(
      `^${escapeRegExp(base)}\\.from-[A-Za-z0-9_-]+-[0-9a-f]{8}${escapeRegExp(ext)}$`,
    );
    const matches = names
      .filter((n) => re.test(n))
      .map((n) => {
        const p = path.join(dir, n);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.lstatSync(p).mtimeMs;
        } catch { /* @silent-fallback-ok: a vanished alongside candidate simply sorts oldest; eviction stays bounded (WORKING-SET-HANDOFF-SPEC §3.5) */
        }
        return { p, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    for (const victim of matches.slice(2)) {
      try {
        SafeFsExecutor.safeUnlinkSync(victim.p, {
          operation: 'working-set alongside cap-2 eviction (WORKING-SET-HANDOFF-SPEC §3.5)',
        });
        this.d.logger?.(`alongside evicted (cap 2): ${path.basename(victim.p)}`);
      } catch { /* @silent-fallback-ok: eviction failure leaves an extra alongside copy — bounded growth, surfaced by the degradation counter (WORKING-SET-HANDOFF-SPEC §3.5) */
      }
    }
  }

  // ---- busy retry (penalty-free, bounded) -----------------------------------

  private async sendWithBusyRetry(cmd: WorkingSetPullCmd): Promise<ServeResult> {
    const cap = this.d.busyRetryCap ?? DEFAULT_BUSY_RETRY_CAP;
    let delay = 50;
    let coldRetried = false;
    for (let i = 0; i < cap; i++) {
      let res: ServeResult;
      try {
        res = await this.d.send(cmd);
      } catch (e) {
        // ONE bounded immediate retry on a transport failure: the first mesh
        // call over an idle tunnel was measured aborting cold and succeeding
        // warm (live-matrix finding T1, 2026-06-06). A single re-send masks
        // the cold hop; a second failure is real and propagates to the caller
        // (refused → pending-pull ledger), so this can never loop.
        if (coldRetried) throw e;
        coldRetried = true;
        res = await this.d.send(cmd);
      }
      if (!res.busy) return res;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 5000);
    }
    return { busy: true }; // exhausted — caller re-files the pending-pull intact
  }

  private yieldNow(): Promise<void> {
    if (this.d.yieldFn) return this.d.yieldFn();
    return new Promise((r) => setImmediate(r));
  }
}

// ── shared helpers ──────────────────────────────────────────────────

function anchorsEqual(a: GenerationAnchor, b: GenerationAnchor): boolean {
  return a.bytes === b.bytes && a.mtimeNs === b.mtimeNs && a.ino === b.ino;
}

function isSafeRelPath(relPath: string): boolean {
  if (!relPath || typeof relPath !== 'string') return false;
  if (path.isAbsolute(relPath)) return false;
  if (/^[A-Za-z]:[\\/]/.test(relPath)) return false; // drive prefix
  if (relPath.startsWith('\\\\')) return false; // UNC
  const segs = relPath.split(/[\\/]+/);
  if (segs.some((s) => s === '..' || s === '')) return false;
  return true;
}

function isContained(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sanitizeBasename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

function shortIdSafePrefix(base: string): string {
  return `${base}.from-`;
}

function writeAtomic(dest: string, content: Buffer): void {
  const tmp = `${dest}.tmp-${process.pid}-${content.length}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, dest);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
