/**
 * The standing compaction canary (context-budget-layered-summaries §9.1
 * "Standing canary", run by the ContextBudgetSentinel, §7.8).
 *
 * Scope: topic-bound sessions (and the throwaway sessions a synthetic press
 * targets). Per (machine, engine, version) it counts compaction DETECTIONS and,
 * for each, the two artifacts the recovery path must leave:
 *  - a PostCompact record for that session (PostCompactStore), and
 *  - a RECOVERY BLOCK in the transcript: the engine's own record that the
 *    `SessionStart` (`compact`) hook ran and succeeded after the boundary
 *    (Claude Code: an `attachment` of type `hook_success`, hookName
 *    `SessionStart:compact`, exitCode 0).
 *
 * ONE detection rule, independent of the hooks under test: the engine-written
 * compact-boundary entry (Claude Code: `type: "system"`, `subtype:
 * "compact_boundary"`, `compactMetadata.trigger`) ALONE is a detection. The
 * engine's pre-compaction event is never a detection, and the size-drop
 * channel (which needs corroboration) is not used, so a fold's or a clear's
 * own context drop is never counted. A hook family that never fires reads
 * `diverged`, never `uninitialized`.
 *
 * States, over detections within the current VERIFICATION EPOCH (restarted
 * when the switch turns on or a remediation completes; history stays in the
 * ledger): `n/a` (switch off); `uninitialized` (no settled detection);
 * `diverged` (≥ 1 settled detection without both artifacts); `healthy` (≥ N,
 * default 3, all with both artifacts, at least one of them a synthetic
 * positive control). A detection still inside its artifact grace is
 * `pending` and counts toward nothing yet.
 *
 * Observation only: the heal ladder by cause is a later slice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listPostCompactRecords } from './PostCompactStore.js';

export const CANARY_HEALTHY_MIN = 3;
/** How long after a boundary its artifacts may still arrive. */
export const CANARY_ARTIFACT_GRACE_MS = 10 * 60_000;
/** A PostCompact record counts for a boundary when received within this window of it. */
const POST_COMPACT_MATCH_MS = 10 * 60_000;
/** A synthetic press counts for a manual boundary that follows it within this window. */
const SYNTHETIC_MATCH_MS = 5 * 60_000;
/** Tolerance between the transcript's timestamps and the server's clock. */
/**
 * How early a PostCompact record (or a press) may be stamped before its own
 * boundary: the hooks run about a second before the engine writes the boundary
 * (measured on Claude Code 2.1.321), on the same machine's clock.
 */
const CLOCK_SKEW_MS = 15_000;
/** A record stamped this close to the NEXT boundary belongs to that one, not this. */
const NEXT_BOUNDARY_MARGIN_MS = 5_000;
/** The line Instar's session-start hook prints only on its post-compaction recovery path. */
export const RECOVERY_MARKER = '=== IDENTITY RECOVERY (post-compaction) ===';
/** A known transcript untouched this long stops being scanned. */
const KNOWN_IDLE_MS = 24 * 60 * 60_000;
const MAX_DETECTIONS = 500;
/** Read at most this much new transcript per file per tick (a huge backlog is read across ticks). */
const MAX_READ_BYTES = 32 * 1024 * 1024;

export type CanaryState = 'n/a' | 'uninitialized' | 'accruing' | 'diverged' | 'healthy';

export interface CanarySession {
  topicKey: string;
  claudeSessionId: string;
  transcriptPath: string;
  engine: string;
}

export interface CanaryDetection {
  machine: string;
  engine: string;
  version: string;
  topicKey: string;
  sessionId: string;
  boundaryUuid: string;
  at: number;
  trigger: string;
  recoveryBlock: boolean;
  postCompact: boolean;
  /** The matched PostCompact record's receivedAt (each record counts for one boundary). */
  postCompactAt?: number;
  synthetic: boolean;
}

interface CanaryLedger {
  schema: 'compaction-canary/1';
  epochStartedAt: number;
  switchOn: boolean;
  offsets: Record<string, number>;
  /** The newest boundary per transcript whose recovery block may still follow. */
  open: Record<string, string>;
  detections: CanaryDetection[];
  presses: Array<{ sessionId: string; at: number }>;
  /** Every transcript seen, so a session that compacts and exits still gets a final scan. */
  known?: Record<string, { session: CanarySession; seenAt: number }>;
  /** When an unreadable ledger was replaced by a fresh one (the history it held is gone). */
  ledgerResetAt?: number;
}

export interface CanaryGroup { machine: string; engine: string; version: string; state: CanaryState; detected: number; complete: number; pending: number; synthetic: number }

export interface CanaryReport { epochStartedAt: number; switchOn: boolean; groups: CanaryGroup[]; recent: CanaryDetection[]; ledgerResetAt: number | null; unreadableTranscripts: number }

function parseTs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export class CompactionCanary {
  private readonly file: string;
  private readonly now: () => number;
  /** Transcripts that could not be read in the LAST scan (visible in the report). */
  private skipped = 0;
  private lastSkipped = 0;

  constructor(private readonly o: { stateDir: string; machineId: string; now?: () => number; healthyMin?: number }) {
    this.file = path.join(o.stateDir, 'state', 'context-budget', 'canary.json');
    this.now = o.now ?? Date.now;
  }

  private load(): CanaryLedger {
    const fresh = (resetAt?: number): CanaryLedger => ({ schema: 'compaction-canary/1', epochStartedAt: this.now(), switchOn: false, offsets: {}, open: {}, detections: [], presses: [], known: {}, ...(resetAt ? { ledgerResetAt: resetAt } : {}) });
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf-8'); } catch { return fresh(); } // @silent-fallback-ok — no ledger yet
    try {
      const v = JSON.parse(raw) as CanaryLedger;
      if (v && v.schema === 'compaction-canary/1' && Array.isArray(v.detections)) return { ...v, open: v.open ?? {}, presses: v.presses ?? [], known: v.known ?? {} };
    } catch { /* fall through: an unreadable ledger */ }
    // An unreadable ledger is replaced, and the reset is REPORTED (a lost `diverged` must not vanish silently).
    return fresh(this.now());
  }

  private save(l: CanaryLedger): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(l), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Restart the verification epoch (the switch turned on, or a remediation completed). */
  restartEpoch(): void { const l = this.load(); l.epochStartedAt = this.now(); this.save(l); }

  /** The sentinel pressed a synthetic compaction on a throwaway session. */
  recordSyntheticPress(sessionId: string): void {
    const l = this.load(); l.presses = [...l.presses, { sessionId, at: this.now() }].slice(-100); this.save(l);
  }

  /** One pass: read new transcript bytes, record detections and recovery blocks, match PostCompact records. */
  scan(sessions: CanarySession[], switchOn: boolean): void {
    const l = this.load();
    this.skipped = 0;
    if (switchOn && !l.switchOn) l.epochStartedAt = this.now(); // the switch turned on: a new epoch
    l.switchOn = switchOn;
    // Current sessions, plus every known transcript (a session that compacted and
    // exited between ticks still gets its final lines read); idle ones age out.
    const now = this.now();
    const known = l.known ?? {};
    for (const s of sessions) known[s.transcriptPath] = { session: s, seenAt: now };
    for (const [p, k] of Object.entries(known)) {
      if (now - k.seenAt > KNOWN_IDLE_MS) { delete known[p]; delete l.offsets[p]; delete l.open[p]; continue; }
      this.scanTranscript(l, k.session);
    }
    l.known = known;
    // Match PostCompact records ONE-TO-ONE: a record belongs to the latest boundary
    // of its session at or before it (allowing clock skew), within the window, and
    // is never counted for a second boundary.
    const byTopic = new Map<string, ReturnType<typeof listPostCompactRecords>>();
    const claimed = new Set(l.detections.filter((d) => d.postCompactAt !== undefined).map((d) => `${d.sessionId}@${d.postCompactAt}`));
    for (let i = 0; i < l.detections.length; i++) {
      const d = l.detections[i];
      if (d.postCompact) continue;
      if (!byTopic.has(d.topicKey)) byTopic.set(d.topicKey, listPostCompactRecords(this.o.stateDir, d.topicKey));
      // The NEXT boundary of the same session in transcript order (timestamps can tie).
      const next = l.detections.slice(i + 1).find((x) => x.sessionId === d.sessionId);
      const nextBoundary = next ? next.at : Infinity;
      const rec = byTopic.get(d.topicKey)!
        .filter((r) => r.claudeSessionId === d.sessionId && !claimed.has(`${d.sessionId}@${r.receivedAt}`)
          && r.receivedAt >= d.at - CLOCK_SKEW_MS && r.receivedAt <= d.at + POST_COMPACT_MATCH_MS && r.receivedAt < nextBoundary - NEXT_BOUNDARY_MARGIN_MS)
        .sort((a, b) => a.receivedAt - b.receivedAt)[0];
      if (rec) { d.postCompact = true; d.postCompactAt = rec.receivedAt; claimed.add(`${d.sessionId}@${rec.receivedAt}`); }
    }
    l.detections = l.detections.slice(-MAX_DETECTIONS);
    this.lastSkipped = this.skipped;
    this.save(l);
  }

  private scanTranscript(l: CanaryLedger, s: CanarySession): void {
    let size: number;
    try { size = fs.statSync(s.transcriptPath).size; } catch { return; } // @silent-fallback-ok — a transcript not on disk (yet) has nothing to count
    let from = l.offsets[s.transcriptPath] ?? 0;
    if (size < from) from = 0; // truncated or replaced: read again
    if (size === from) return;
    const len = Math.min(size - from, MAX_READ_BYTES);
    const buf = Buffer.alloc(len);
    try {
      const fd = fs.openSync(s.transcriptPath, 'r');
      try { fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
    } catch { this.skipped += 1; return; } // @silent-fallback-ok — an unreadable transcript is skipped this tick and counted (an observer's read error must not stop every other scan)
    // Only whole lines: stop at the last newline and resume there next tick.
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) { if (len === MAX_READ_BYTES) l.offsets[s.transcriptPath] = from + len; return; } // a single line over the window is skipped
    l.offsets[s.transcriptPath] = from + lastNl + 1;
    for (const line of buf.subarray(0, lastNl).toString('utf-8').split('\n')) {
      if (!line.includes('compact')) continue; // both entry kinds carry the word; skip parsing everything else
      let e: Record<string, unknown>;
      try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (e.type === 'system' && e.subtype === 'compact_boundary' && typeof e.uuid === 'string') {
        const meta = (e.compactMetadata ?? {}) as { trigger?: unknown };
        const at = parseTs(e.timestamp) ?? this.now();
        const trigger = typeof meta.trigger === 'string' ? meta.trigger : 'unknown';
        if (l.detections.some((d) => d.boundaryUuid === e.uuid)) continue;
        // A press counts for ONE manual boundary: it is consumed on its first match.
        const pi = trigger === 'manual' ? l.presses.findIndex((p) => p.sessionId === s.claudeSessionId && at >= p.at && at - p.at <= SYNTHETIC_MATCH_MS) : -1;
        const synthetic = pi >= 0;
        if (pi >= 0) l.presses.splice(pi, 1);
        l.detections.push({
          machine: this.o.machineId, engine: s.engine, version: typeof e.version === 'string' ? e.version : 'unknown',
          topicKey: s.topicKey, sessionId: s.claudeSessionId, boundaryUuid: e.uuid, at, trigger,
          recoveryBlock: false, postCompact: false, synthetic,
        });
        l.open[s.transcriptPath] = e.uuid;
        continue;
      }
      const a = e.attachment as { type?: unknown; hookName?: unknown; exitCode?: unknown; command?: unknown; stdout?: unknown; content?: unknown } | undefined;
      // A RECOVERY block, not merely "a SessionStart:compact hook exited 0": Instar's own
      // session-start hook ran AND printed its post-compaction recovery marker (a hook that
      // fell back to the startup orientation, or another hook that succeeded, is not recovery).
      const out = typeof a?.stdout === 'string' ? a.stdout : typeof a?.content === 'string' ? a.content : '';
      if (e.type === 'attachment' && a && a.type === 'hook_success' && a.hookName === 'SessionStart:compact' && (a.exitCode === undefined || a.exitCode === 0)
        && typeof a.command === 'string' && a.command.includes('session-start.sh') && out.split(/\r?\n/).some((ln) => ln.trim() === RECOVERY_MARKER)) {
        const open = l.open[s.transcriptPath];
        const d = open ? l.detections.find((x) => x.boundaryUuid === open) : undefined;
        if (d) { d.recoveryBlock = true; delete l.open[s.transcriptPath]; }
      }
    }
  }

  report(switchOn: boolean): CanaryReport {
    const l = this.load();
    const now = this.now();
    const healthyMin = this.o.healthyMin ?? CANARY_HEALTHY_MIN;
    const inEpoch = l.detections.filter((d) => d.at >= l.epochStartedAt);
    const groups = new Map<string, CanaryDetection[]>();
    for (const d of inEpoch) {
      const k = `${d.machine}\u0000${d.engine}\u0000${d.version}`;
      groups.set(k, [...(groups.get(k) ?? []), d]);
    }
    const out: CanaryGroup[] = [];
    for (const [k, ds] of groups) {
      const [machine, engine, version] = k.split('\u0000');
      const complete = ds.filter((d) => d.recoveryBlock && d.postCompact);
      const settled = ds.filter((d) => (d.recoveryBlock && d.postCompact) || now - d.at > CANARY_ARTIFACT_GRACE_MS);
      const pending = ds.length - settled.length;
      const synthetic = complete.filter((d) => d.synthetic).length;
      let state: CanaryState;
      if (!switchOn) state = 'n/a';
      else if (settled.length === 0) state = 'uninitialized';
      else if (settled.some((d) => !(d.recoveryBlock && d.postCompact))) state = 'diverged';
      // "all with both artifacts": a compaction still pending its artifacts holds healthy back.
      else if (complete.length >= healthyMin && synthetic >= 1 && pending === 0) state = 'healthy';
      else state = 'accruing'; // every settled detection is complete, but not yet N of them or no synthetic positive
      out.push({ machine, engine, version, state, detected: ds.length, complete: complete.length, pending, synthetic });
    }
    if (out.length === 0) out.push({ machine: this.o.machineId, engine: 'claude-code', version: 'unknown', state: switchOn ? 'uninitialized' : 'n/a', detected: 0, complete: 0, pending: 0, synthetic: 0 });
    return { epochStartedAt: l.epochStartedAt, switchOn, groups: out, recent: l.detections.slice(-20), ledgerResetAt: l.ledgerResetAt ?? null, unreadableTranscripts: this.lastSkipped };
  }
}
