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
 *
 * ENGINES (§9.6). Each engine supplies its transcript channel and a profile:
 *  - Claude Code: the compact-boundary entry; both artifacts verifiable.
 *  - Codex (`codex-cli`): the rollout's engine-written `compacted` entry ALONE
 *    is a detection (measured 2026-11-10: Codex 0.156-0.167 writes one per
 *    compaction, so detection is `supported`, not synthesized). Codex has no
 *    PostCompact hook and no summary, so the channel itself PRODUCES the
 *    post-compaction event (`synthesized`), and each `token_count` usage
 *    reading is fed to the adapter's `trackContextUsage` (the synthesized
 *    85%-of-window pre-compaction signal, counted but NEVER a detection).
 *    No recovery artifact is verifiable yet (the next-prompt seed is a later
 *    slice), so a Codex group reads `counted`, never `diverged`/`healthy`,
 *    and its profile says it is never healed by injection (Codex has no
 *    control-command inject).
 */
import fs from 'node:fs';
import path from 'node:path';
import { listPostCompactRecords } from './PostCompactStore.js';
import { classifyCodexRolloutEntry, codexRolloutLineMayMatter } from './CodexRolloutParser.js';
import { trackContextUsage, emitPostCompactFromTranscript, rearmContextUsage } from '../providers/adapters/openai-codex/control/compactionLifecycle.js';
import { sessionHandle } from '../providers/types.js';

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

/** Claude Code's wrapper for hook output over its size limit (only a preview reaches the model). */
export function isTruncatedHookOutput(out: string): boolean {
  return /^\s*<persisted-output>/.test(out);
}
/** A known transcript untouched this long stops being scanned. */
const KNOWN_IDLE_MS = 24 * 60 * 60_000;
const MAX_DETECTIONS = 500;
/**
 * An engine side-channel (the synthesized signal, the post-compaction producer)
 * fires only for an entry this recent: a first scan of a long-running rollout
 * records its history but never announces old compactions as new.
 */
export const CHANNEL_FRESH_MS = 10 * 60_000;
/** Read at most this much new transcript per file per tick (a huge backlog is read across ticks). */
const MAX_READ_BYTES = 32 * 1024 * 1024;

/**
 * `counted`: an engine whose recovery artifacts are not verifiable (yet) — its
 * detections are counted, and the group never reads diverged or healthy.
 */
export type CanaryState = 'n/a' | 'uninitialized' | 'accruing' | 'diverged' | 'healthy' | 'counted';

/** What the canary can know about one engine (§9.6 harness-adapter contract). */
export interface EngineCanaryProfile {
  /** A compaction detected from an engine-written transcript entry (`supported`) or derived by Instar (`synthesized`). */
  detection: 'supported' | 'synthesized';
  /** The post-compaction event: an engine hook (`supported`) or produced by Instar from the transcript (`synthesized`). */
  postCompactEvent: 'supported' | 'synthesized';
  /** The pre-compaction signal: a native hook (`supported`) or Instar's usage threshold (`synthesized`). */
  preCompactSignal: 'supported' | 'synthesized';
  /** Whether both recovery artifacts (PostCompact record, recovery block) are verifiable on this engine now. */
  recoveryVerifiable: boolean;
  /** §9.1: an engine without a control-command inject (or only synthesized evidence) is never healed by injection. */
  healByInjection: boolean;
}

export const ENGINE_CANARY_PROFILES: Readonly<Record<string, EngineCanaryProfile>> = Object.freeze({
  'claude-code': { detection: 'supported', postCompactEvent: 'supported', preCompactSignal: 'supported', recoveryVerifiable: true, healByInjection: true },
  'codex-cli': { detection: 'supported', postCompactEvent: 'synthesized', preCompactSignal: 'synthesized', recoveryVerifiable: false, healByInjection: false },
});

function profileOf(engine: string): EngineCanaryProfile {
  // An engine with no profile is unverifiable and never healed: the conservative reading.
  return ENGINE_CANARY_PROFILES[engine] ?? { detection: 'synthesized', postCompactEvent: 'synthesized', preCompactSignal: 'synthesized', recoveryVerifiable: false, healByInjection: false };
}

/** The engine side-channels the transcript scan drives (defaults: the Codex adapter's own). */
export interface CanaryEngineHooks {
  /** A usage reading (Codex `token_count`): returns true when it emitted the synthesized pre-compaction notice. */
  onUsage(s: CanarySession, contextUsed: number, contextWindow: number | null): boolean;
  /** The post-compaction producer for an engine with no post-compaction hook. */
  onCompaction(s: CanarySession, d: CanaryDetection, tokensBefore: number | null): void;
  /** A compaction seen too late to announce: re-arm the pre-compaction signal only. */
  onRearm(s: CanarySession): void;
}

const DEFAULT_ENGINE_HOOKS: CanaryEngineHooks = {
  onUsage: (s, used, win) => trackContextUsage(sessionHandle(s.claudeSessionId), used, win ?? undefined),
  onCompaction: (s, d, before) => emitPostCompactFromTranscript(sessionHandle(s.claudeSessionId), { timestamp: new Date(d.at).toISOString(), windowId: d.boundaryUuid, ...(before !== null ? { tokensBefore: before } : {}) }),
  onRearm: (s) => rearmContextUsage(sessionHandle(s.claudeSessionId)),
};

/** One synthesized pre-compaction signal (counted, never a detection). */
export interface CanarySignal { machine: string; engine: string; version: string; topicKey: string; sessionId: string; at: number; contextUsed: number; contextWindow: number | null }

/** Per-transcript state an engine channel keeps across ticks. */
interface ChannelState { version?: string; usageSeen?: boolean; armed?: boolean }

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
  /** The recovery block was printed but Claude Code delivered only its preview (over the hook-output limit). */
  recoveryTruncated?: boolean;
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
  /** Engine channel state per transcript (Codex: version, first-usage seen, signal armed). */
  channel?: Record<string, ChannelState>;
  /** Synthesized pre-compaction signals (bounded). */
  signals?: CanarySignal[];
}

export interface CanaryGroup {
  machine: string; engine: string; version: string; state: CanaryState; detected: number; complete: number; pending: number; synthetic: number;
  /** `synthesized` when any of the engine's compaction capabilities is derived by Instar rather than provided by the engine. */
  marking: 'native' | 'synthesized';
  profile: EngineCanaryProfile;
  /** Synthesized pre-compaction signals in the epoch (counted; never a detection). */
  synthesizedSignals: number;
  /** Compactions whose recovery block was cut to a preview by the hook-output limit. */
  truncated?: number;
}

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

  private readonly hooks: CanaryEngineHooks;
  private readonly engineInScope: (engine: string) => boolean;

  constructor(private readonly o: {
    stateDir: string; machineId: string; now?: () => number; healthyMin?: number; engineHooks?: CanaryEngineHooks;
    /**
     * Whether an engine's transcripts are scanned at all, read every tick (the
     * production Codex gate). Out of scope ⇒ its known transcripts are dropped
     * at once, so turning a gate off stops the scan and its side-channels on
     * the next tick. Default: every engine.
     */
    engineInScope?: (engine: string) => boolean;
  }) {
    this.file = path.join(o.stateDir, 'state', 'context-budget', 'canary.json');
    this.now = o.now ?? Date.now;
    this.hooks = o.engineHooks ?? DEFAULT_ENGINE_HOOKS;
    this.engineInScope = o.engineInScope ?? (() => true);
  }

  private load(): CanaryLedger {
    const fresh = (resetAt?: number): CanaryLedger => ({ schema: 'compaction-canary/1', epochStartedAt: this.now(), switchOn: false, offsets: {}, open: {}, detections: [], presses: [], known: {}, ...(resetAt ? { ledgerResetAt: resetAt } : {}) });
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf-8'); } catch { return fresh(); } // @silent-fallback-ok — no ledger yet
    try {
      const v = JSON.parse(raw) as CanaryLedger;
      if (v && v.schema === 'compaction-canary/1' && Array.isArray(v.detections)) return { ...v, open: v.open ?? {}, presses: v.presses ?? [], known: v.known ?? {}, channel: v.channel ?? {}, signals: v.signals ?? [] };
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
    const inScope = new Map<string, boolean>();
    const scoped = (engine: string) => { if (!inScope.has(engine)) inScope.set(engine, this.engineInScope(engine)); return inScope.get(engine)!; };
    for (const s of sessions) if (scoped(s.engine)) known[s.transcriptPath] = { session: s, seenAt: now };
    for (const [p, k] of Object.entries(known)) {
      if (now - k.seenAt > KNOWN_IDLE_MS || !scoped(k.session.engine)) { delete known[p]; delete l.offsets[p]; delete l.open[p]; if (l.channel) delete l.channel[p]; continue; }
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
      if (d.postCompact || !profileOf(d.engine).recoveryVerifiable) continue;
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
    l.signals = (l.signals ?? []).slice(-MAX_DETECTIONS);
    this.lastSkipped = this.skipped;
    this.save(l);
  }

  private scanTranscript(l: CanaryLedger, s: CanarySession): void {
    let size: number;
    try { size = fs.statSync(s.transcriptPath).size; } catch { return; } // @silent-fallback-ok — a transcript not on disk (yet) has nothing to count
    let from = l.offsets[s.transcriptPath] ?? 0;
    if (size < from) { from = 0; if (l.channel) delete l.channel[s.transcriptPath]; } // truncated or replaced: read again, channel state too
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
    if (s.engine === 'codex-cli') { this.scanCodexLines(l, s, buf.subarray(0, lastNl).toString('utf-8')); return; }
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
      // Judge what the MODEL received: `content` is the delivered text (Claude Code's
      // `<persisted-output>` wrapper when the hook output was over its limit), while
      // `stdout` is the raw output the hook printed. Fall back to stdout only when no
      // content is recorded (older transcript shapes).
      const out = typeof a?.content === 'string' && a.content !== '' ? a.content : typeof a?.stdout === 'string' ? a.stdout : '';
      if (e.type === 'attachment' && a && a.type === 'hook_success' && a.hookName === 'SessionStart:compact' && (a.exitCode === undefined || a.exitCode === 0)
        && typeof a.command === 'string' && a.command.includes('session-start.sh') && out.split(/\r?\n/).some((ln) => ln.trim() === RECOVERY_MARKER)) {
        const open = l.open[s.transcriptPath];
        const d = open ? l.detections.find((x) => x.boundaryUuid === open) : undefined;
        // A block Claude Code replaced with its "output too large" preview reached the
        // model only as its first ~2,000 characters: printed, not delivered. It is a
        // divergence, never a recovery (Phase 0 results check 4).
        if (d && isTruncatedHookOutput(out)) { d.recoveryTruncated = true; delete l.open[s.transcriptPath]; }
        else if (d) { d.recoveryBlock = true; delete l.open[s.transcriptPath]; }
      }
    }
  }

  /**
   * The Codex rollout channel: `compacted` ALONE is a detection (after the
   * rollout's first usage reading, so a fork's inherited copies never count;
   * deduped on `window_id` across transcripts); each detection fires the
   * post-compaction producer; each usage reading feeds `trackContextUsage`,
   * whose notice is recorded as a synthesized SIGNAL, at most one per
   * compaction cycle (durable across restarts: re-armed by the next detection).
   */
  private scanCodexLines(l: CanaryLedger, s: CanarySession, text: string): void {
    const ch = (l.channel ??= {});
    const st: ChannelState = (ch[s.transcriptPath] ??= {});
    for (const line of text.split('\n')) {
      if (!codexRolloutLineMayMatter(line)) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const c = classifyCodexRolloutEntry(e);
      if (!c) continue;
      // The first meta before any usage (a fork's own, not its inherited parent's); after usage, the latest (a resume under a newer Codex).
      if (c.kind === 'meta') { if (c.version && (!st.version || st.usageSeen)) st.version = c.version; continue; }
      if (c.kind === 'usage') {
        st.usageSeen = true;
        if (c.contextUsed === null || st.armed === false) continue;
        const at = parseTs(e.timestamp) ?? this.now();
        if (this.now() - at > CHANNEL_FRESH_MS) continue; // history: no signal (the next fresh reading decides)
        let fired = false;
        try { fired = this.hooks.onUsage(s, c.contextUsed, c.contextWindow); } catch { fired = false; } // @silent-fallback-ok — a hook error is no signal; the scan carries on
        if (fired) {
          st.armed = false;
          (l.signals ??= []).push({ machine: this.o.machineId, engine: s.engine, version: st.version ?? 'unknown', topicKey: s.topicKey, sessionId: s.claudeSessionId, at, contextUsed: c.contextUsed, contextWindow: c.contextWindow });
        }
        continue;
      }
      // c.kind === 'compacted'
      if (!st.usageSeen) continue; // a forked rollout's inherited copy of its parent's compaction
      if (l.detections.some((d) => d.boundaryUuid === c.windowId)) continue;
      const d: CanaryDetection = {
        machine: this.o.machineId, engine: s.engine, version: st.version ?? 'unknown',
        topicKey: s.topicKey, sessionId: s.claudeSessionId, boundaryUuid: c.windowId, at: c.at ?? this.now(), trigger: 'unknown',
        recoveryBlock: false, postCompact: false, synthetic: false,
      };
      l.detections.push(d);
      st.armed = true;
      if (this.now() - d.at > CHANNEL_FRESH_MS) { // a historical compaction is counted and re-arms, never announced
        try { this.hooks.onRearm(s); } catch { /* @silent-fallback-ok — re-arm is best-effort; the durable flag is set */ }
        continue;
      }
      try { this.hooks.onCompaction(s, d, c.tokensBefore); } catch { /* @silent-fallback-ok — the producer's subscriber failed; the detection is recorded regardless */ }
    }
  }

  report(switchOn: boolean): CanaryReport {
    const l = this.load();
    const now = this.now();
    const healthyMin = this.o.healthyMin ?? CANARY_HEALTHY_MIN;
    const inEpoch = l.detections.filter((d) => d.at >= l.epochStartedAt);
    const groups = new Map<string, CanaryDetection[]>();
    const signals = new Map<string, number>();
    for (const d of inEpoch) {
      const k = `${d.machine}\u0000${d.engine}\u0000${d.version}`;
      groups.set(k, [...(groups.get(k) ?? []), d]);
    }
    for (const sg of (l.signals ?? []).filter((x) => x.at >= l.epochStartedAt)) {
      const k = `${sg.machine}\u0000${sg.engine}\u0000${sg.version}`;
      signals.set(k, (signals.get(k) ?? 0) + 1);
      if (!groups.has(k)) groups.set(k, []);
    }
    const out: CanaryGroup[] = [];
    for (const [k, ds] of groups) {
      const [machine, engine, version] = k.split('\u0000');
      const profile = profileOf(engine);
      const marking: CanaryGroup['marking'] = profile.detection === 'synthesized' || profile.postCompactEvent === 'synthesized' || profile.preCompactSignal === 'synthesized' ? 'synthesized' : 'native';
      if (!profile.recoveryVerifiable) {
        // Counted, never judged: no artifact this engine leaves can be verified yet.
        out.push({ machine, engine, version, state: !switchOn ? 'n/a' : ds.length === 0 ? 'uninitialized' : 'counted', detected: ds.length, complete: 0, pending: 0, synthetic: 0, marking, profile, synthesizedSignals: signals.get(k) ?? 0 });
        continue;
      }
      const complete = ds.filter((d) => d.recoveryBlock && d.postCompact);
      // A truncated delivery is settled at once: it is a known divergence, not a pending one.
      const settled = ds.filter((d) => (d.recoveryBlock && d.postCompact) || d.recoveryTruncated === true || now - d.at > CANARY_ARTIFACT_GRACE_MS);
      const pending = ds.length - settled.length;
      const synthetic = complete.filter((d) => d.synthetic).length;
      let state: CanaryState;
      if (!switchOn) state = 'n/a';
      else if (settled.length === 0) state = 'uninitialized';
      else if (settled.some((d) => !(d.recoveryBlock && d.postCompact))) state = 'diverged';
      // "all with both artifacts": a compaction still pending its artifacts holds healthy back.
      else if (complete.length >= healthyMin && synthetic >= 1 && pending === 0) state = 'healthy';
      else state = 'accruing'; // every settled detection is complete, but not yet N of them or no synthetic positive
      out.push({ machine, engine, version, state, detected: ds.length, complete: complete.length, pending, synthetic, marking, profile, synthesizedSignals: signals.get(k) ?? 0, truncated: ds.filter((d) => d.recoveryTruncated === true).length });
    }
    // Claude Code always has a row (a Codex-only epoch must not hide it).
    if (!out.some((g) => g.engine === 'claude-code')) out.push({ machine: this.o.machineId, engine: 'claude-code', version: 'unknown', state: switchOn ? 'uninitialized' : 'n/a', detected: 0, complete: 0, pending: 0, synthetic: 0, marking: 'native', profile: profileOf('claude-code'), synthesizedSignals: 0 });
    return { epochStartedAt: l.epochStartedAt, switchOn, groups: out, recent: l.detections.slice(-20), ledgerResetAt: l.ledgerResetAt ?? null, unreadableTranscripts: this.lastSkipped };
  }
}
