/**
 * WorkingSetManifest — P2.1 of multi-machine coherence: pure, on-demand
 * computation of "what files make up this topic's workspace on THIS machine".
 *
 * Spec: docs/specs/WORKING-SET-HANDOFF-SPEC.md §3.1 (manifest — computed,
 * never declared). No new persistent store; no willpower-dependent
 * declarations. Sources, deduped:
 *   1. Filesystem convention: `autonomous/<topic>.local.md` + `autonomous/
 *      <topic>.*` (bounded readdir of the convention dir — never recursion).
 *   2. Journal evidence: jailed `artifactPaths` from the topic's OWN-stream
 *      autonomous-run entries (CoherenceJournalReader.readOwnAutonomousRuns —
 *      injected by the caller so this module stays pure).
 *
 * Discipline (§3.1):
 *  - Every candidate is canonicalized + re-jailed HERE even though journal
 *    paths were jailed at write time (jails are enforced at the data's birth
 *    AND at every serve boundary — defense in depth, P1 invariant).
 *  - `mtime` is DISPLAY-ONLY (P1's `ts` treatment): every diff/skip decision
 *    downstream keys on sha256 exclusively.
 *  - The credential-shape scan runs over each candidate file's BYTES; a
 *    flagged file is LISTED `secretFlagged: true` and never transferred — an
 *    honest, surfaced refusal, never a silent skip. The scan is a
 *    LEAK-REDUCTION filter, not the security boundary (the boundary is the
 *    same-operator peer posture — §3.1/§5).
 *  - When the topic's own journal shows a live autonomous run, EVERY entry is
 *    `liveSource: true` (any of them is plausibly mid-write) — the pull
 *    re-fires on the run's `stopped` (§3.4).
 *  - Bounded everywhere: per-file caps (headline exemption for the topic's
 *    `.local.md`), maxFiles, hash ceiling. Over-cap entries are LISTED
 *    `tooLarge: true` — observability is not delivery.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { redactForLiveTail } from './liveTailRedaction.js';
import type { OwnAutonomousRuns } from './CoherenceJournalReader.js';

/** §3.7 defaults (mirrored in ConfigDefaults.coherenceJournal.workingSet). */
export const DEFAULT_WORKING_SET_CAPS: WorkingSetCaps = {
  maxFileBytes: 4 * 1024 * 1024,
  headlineFileBytes: 16 * 1024 * 1024,
  maxFiles: 64,
  maxTotalBytes: 32 * 1024 * 1024,
};

/**
 * Above this, a file's sha256 is reported `null` rather than paying an
 * unbounded hash at manifest time (a tooLarge file never transfers anyway,
 * so the hash is disclosure metadata, not verification material).
 */
export const HASH_BYTE_CEILING = 64 * 1024 * 1024;

export interface WorkingSetCaps {
  maxFileBytes: number;
  headlineFileBytes: number;
  maxFiles: number;
  /** TOTAL-SET transfer budget — enforced by the PULL layer, carried here so
   *  both sides quote one number (§3.2 assembled-bytes basis). */
  maxTotalBytes: number;
}

export interface WorkingSetEntry {
  /** Relative to the stateDir; receiver treats it as hostile input (§3.2). */
  relPath: string;
  bytes: number;
  /** null only above HASH_BYTE_CEILING (honest, bounded compute). */
  sha256: string | null;
  /** ISO — DISPLAY-ONLY, never a decision key (§3.1). */
  mtime: string;
  tooLarge?: boolean;
  secretFlagged?: boolean;
  liveSource?: boolean;
}

export interface WorkingSetManifestResult {
  topic: number;
  computedAt: string;
  entries: WorkingSetEntry[];
  /** The topic's own journal shows a still-active autonomous run. */
  liveRun: boolean;
  /** Journal evidence was byte/archive-bounded — older artifacts may be missing. */
  evidenceTruncated: boolean;
  /** Candidates dropped past maxFiles (counted, never silent — §3.1). */
  filesTruncated: number;
  /** Candidates rejected by the compute-time jail. */
  jailRejected: number;
  /** Journal-evidenced paths no longer on disk (rotated/deleted/never durable). */
  goneFromDisk: number;
  /** Sum of bytes the pull layer may actually move (excludes tooLarge /
   *  secretFlagged / liveSource entries). */
  transferableBytes: number;
}

/** Minimal fs seam (tests). */
export interface WorkingSetFs {
  readdirSync: (dir: string) => string[];
  lstatSync: (p: string) => { isFile(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number };
  existsSync: (p: string) => boolean;
  realpathSync: (p: string) => string;
  readFileSync: (p: string) => Buffer;
}

export interface ComputeWorkingSetOpts {
  /** Absolute path to the agent's `.instar/` directory. */
  stateDir: string;
  topic: number;
  /** Own-stream journal evidence, injected by the caller (keeps this pure). */
  runs: OwnAutonomousRuns;
  caps?: Partial<WorkingSetCaps>;
  now?: () => Date;
  fsImpl?: WorkingSetFs;
  /** Secret-content scan seam; defaults to the versioned credential-shape enum. */
  secretScan?: (content: Buffer) => boolean;
  /** Source 3 (intelligent-working-set-lazy-sync): relPaths of files the agent wrote
   *  INTERACTIVELY under the `.instar/` jail (the case the computed sources miss). Injected
   *  by the caller from the WorkingSetArtifactManager's READY rows for this topic; re-jailed +
   *  secret-scanned + capped here exactly like the other sources (no jail widening). */
  interactiveArtifactRelPaths?: string[];
}

function realFs(): WorkingSetFs {
  return {
    readdirSync: (dir) => fs.readdirSync(dir),
    lstatSync: (p) => fs.lstatSync(p),
    existsSync: (p) => fs.existsSync(p),
    realpathSync: (p) => fs.realpathSync(p),
    readFileSync: (p) => fs.readFileSync(p),
  };
}

function defaultSecretScan(content: Buffer): boolean {
  return redactForLiveTail(content.toString('utf-8')).redactedCount > 0;
}

/** One candidate before stat/hash. */
interface Candidate {
  abs: string;
  fromJournal: boolean;
}

export function computeWorkingSet(opts: ComputeWorkingSetOpts): WorkingSetManifestResult {
  const io = opts.fsImpl ?? realFs();
  const caps = mergeCaps(opts.caps);
  const now = opts.now ?? (() => new Date());
  const scan = opts.secretScan ?? defaultSecretScan;

  // Realpath the stateDir itself so the jail roots and the realpathed
  // candidates live in one namespace (macOS: /var/folders → /private/var).
  let stateDir = path.resolve(opts.stateDir);
  try {
    stateDir = io.realpathSync(stateDir);
  } catch { /* @silent-fallback-ok: a not-yet-existing stateDir keeps its lexical path; containment still bounds it (WORKING-SET-HANDOFF-SPEC §3.1) */
  }
  const conventionDir = path.join(stateDir, 'autonomous');
  // Scope-accretion server run records (autonomous-scope-accretion-completion.md
  // §4 multi-machine posture): the server run record + advisory ledger ride the
  // working-set carrier on transfer. Archived records are excluded below.
  const serverRecordDir = path.join(stateDir, 'state', 'autonomous-server');
  // Same roots as the journal writer's artifactRoots default (§3.1).
  const jailRoots = [conventionDir, serverRecordDir, stateDir];

  let jailRejected = 0;
  let goneFromDisk = 0;

  // ---- gather candidates (deduped on canonical absolute path) -------------
  const candidates = new Map<string, Candidate>();

  // Source 1: filesystem convention — bounded readdir, no recursion. Names
  // are matched with a `<topic>.` prefix so topic 134 never matches 13481.
  let names: string[] = [];
  try {
    names = io.readdirSync(conventionDir);
  } catch { /* @silent-fallback-ok: convention dir absent = no convention files; journal evidence still applies (WORKING-SET-HANDOFF-SPEC §3.1) */
    names = [];
  }
  const prefix = `${opts.topic}.`;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    candidates.set(path.join(conventionDir, name), {
      abs: path.join(conventionDir, name),
      fromJournal: false,
    });
  }

  // Source 1b: scope-accretion SERVER run records (`<topic>.<runId>.json` +
  // `<topic>.<runId>.artifacts.jsonl`) — same bounded, non-recursive readdir,
  // same `<topic>.` prefix rule. Archived records (`.archived.json`) are
  // EXCLUDED from carrier nomination (R28).
  let serverNames: string[] = [];
  try {
    serverNames = io.readdirSync(serverRecordDir);
  } catch { /* @silent-fallback-ok: server-record dir absent = no scope-accretion records; the convention + journal sources still apply */
    serverNames = [];
  }
  for (const name of serverNames) {
    if (!name.startsWith(prefix)) continue;
    if (name.endsWith('.archived.json') || name.endsWith('.tmp')) continue;
    candidates.set(path.join(serverRecordDir, name), {
      abs: path.join(serverRecordDir, name),
      fromJournal: false,
    });
  }

  // Source 2: journal evidence (already write-time jailed; re-jailed below).
  for (const p of opts.runs.artifactPaths) {
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(stateDir, p);
    if (!candidates.has(abs)) candidates.set(abs, { abs, fromJournal: true });
  }

  // Source 3: interactive-artifact records (intelligent-working-set-lazy-sync) — files the
  // agent wrote INTERACTIVELY under the .instar/ jail. Treated as fresh local candidates
  // (fromJournal:false) so they flow through the IDENTICAL jail + secret-scan + caps pipeline
  // below — the "re-jail + cred-scan at the serve boundary; only ready rows nominate; caps
  // unchanged" contract (the caller passes ONLY ready-row relPaths).
  for (const rel of opts.interactiveArtifactRelPaths ?? []) {
    const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(stateDir, rel);
    if (!candidates.has(abs)) candidates.set(abs, { abs, fromJournal: false });
  }

  // ---- jail + stat + hash + scan -------------------------------------------
  const headlineAbs = path.join(conventionDir, `${opts.topic}.local.md`);
  const surviving: WorkingSetEntry[] = [];

  const seenJailed = new Set<string>();
  for (const cand of candidates.values()) {
    // Jail FIRST (works on nonexistent paths too) — an escape-shaped path is
    // jailRejected even when nothing exists at it; only an in-jail path that
    // has vanished counts as benign goneFromDisk.
    const jailed = jailContained(io, jailRoots, cand.abs);
    if (jailed === null) {
      jailRejected++;
      continue;
    }
    // Regular files only — lstat the ORIGINAL path (not the realpathed one) so
    // a symlink at the FINAL component is refused even when its target
    // realpaths inside the jail (serve-time O_NOFOLLOW will refuse it anyway;
    // the manifest must not promise what serve refuses).
    let st: ReturnType<WorkingSetFs['lstatSync']>;
    try {
      st = io.lstatSync(cand.abs);
    } catch { /* @silent-fallback-ok: a journal-evidenced path that vanished is benign evolution, counted as goneFromDisk — never an error (WORKING-SET-HANDOFF-SPEC §3.1) */
      goneFromDisk++;
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      jailRejected++;
      continue;
    }
    // Dedupe on the CANONICAL path — a journal path and a convention hit that
    // resolve to the same file are one entry, whatever spelling each used.
    if (seenJailed.has(jailed)) continue;
    seenJailed.add(jailed);

    const isHeadline = jailed === headlineAbs;
    const cap = isHeadline ? caps.headlineFileBytes : caps.maxFileBytes;
    const tooLarge = st.size > cap;

    let sha256: string | null = null;
    let secretFlagged = false;
    if (st.size <= HASH_BYTE_CEILING) {
      try {
        const content = io.readFileSync(jailed);
        sha256 = crypto.createHash('sha256').update(content).digest('hex');
        // Scan only what could transfer — a tooLarge file never moves, so the
        // read above is its last touch.
        if (!tooLarge) secretFlagged = scan(content);
      } catch { /* @silent-fallback-ok: file vanished between lstat and read — benign evolution, counted as goneFromDisk (WORKING-SET-HANDOFF-SPEC §3.1) */
        goneFromDisk++;
        continue;
      }
    }

    surviving.push({
      relPath: path.relative(stateDir, jailed),
      bytes: st.size,
      sha256,
      mtime: new Date(st.mtimeMs).toISOString(),
      ...(tooLarge ? { tooLarge: true } : {}),
      ...(secretFlagged ? { secretFlagged: true } : {}),
    });
  }

  // ---- deterministic order + maxFiles ---------------------------------------
  // Headline first, then alpha on relPath — so truncation at maxFiles never
  // drops the headline and is stable across recomputations.
  const headlineRel = path.relative(stateDir, headlineAbs);
  surviving.sort((a, b) => {
    if (a.relPath === headlineRel) return -1;
    if (b.relPath === headlineRel) return 1;
    return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
  });
  const filesTruncated = Math.max(0, surviving.length - caps.maxFiles);
  const kept = surviving.slice(0, caps.maxFiles);

  // ---- liveSource (§3.2 live-source honesty — ALL of a live run's entries) --
  if (opts.runs.liveRun) {
    for (const e of kept) e.liveSource = true;
  }

  let transferableBytes = 0;
  for (const e of kept) {
    if (!e.tooLarge && !e.secretFlagged && !e.liveSource) transferableBytes += e.bytes;
  }

  return {
    topic: opts.topic,
    computedAt: now().toISOString(),
    entries: kept,
    liveRun: opts.runs.liveRun,
    evidenceTruncated: opts.runs.truncated,
    filesTruncated,
    jailRejected,
    goneFromDisk,
    transferableBytes,
  };
}

/**
 * Compute-time jail: realpath the deepest existing ancestor (symlink-escape
 * protection on the existing prefix), require containment under one of the
 * allowlisted roots for BOTH the resolved ancestor and the final path.
 * Mirrors CoherenceJournal's write-time jail (§3.1 — same rules at every
 * boundary).
 */
function jailContained(io: WorkingSetFs, roots: string[], candidate: string): string | null {
  let existing = candidate;
  const tail: string[] = [];
  while (!io.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let realExisting: string;
  try {
    realExisting = io.realpathSync(existing);
  } catch { /* @silent-fallback-ok: realpath failure on a vanishing path falls back to the lexical path, which containment still bounds (WORKING-SET-HANDOFF-SPEC §3.1) */
    realExisting = existing;
  }
  const finalPath = tail.length ? path.join(realExisting, ...tail) : realExisting;
  for (const root of roots) {
    if (isContained(root, realExisting) && isContained(root, finalPath)) return finalPath;
  }
  return null;
}

function isContained(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Undefined-safe caps merge — a config block with absent keys keeps defaults. */
export function mergeCaps(caps?: Partial<WorkingSetCaps>): WorkingSetCaps {
  const out = { ...DEFAULT_WORKING_SET_CAPS };
  if (!caps) return out;
  for (const k of Object.keys(out) as (keyof WorkingSetCaps)[]) {
    const v = caps[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}
