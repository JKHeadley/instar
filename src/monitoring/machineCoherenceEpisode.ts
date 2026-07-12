/**
 * Machine-coherence episode — the DURABLE state layer (machine-coherence-guard
 * §4.1 + §4.6). Pure types + the persistence primitives only: episodeId
 * minting, the atomic transition-write, and the read that distinguishes
 * absent / ok / corrupt so the caller can re-baseline (N3/N4). The episode
 * STATE MACHINE — open / join / suspend / resume / reopen / close / the
 * pendingFix lifecycle / the recurrence damper (§4.2–§4.5) — is the CONSUMER
 * of this layer and lands in the next sub-unit; nothing here raises, alarms,
 * or transitions anything.
 *
 * Why a durable layer at all (§4.1): a server restart mid-episode must neither
 * re-alarm nor forget. The file is written on state TRANSITIONS only (never
 * per tick — confirm/resolve/verify COUNTERS stay in-memory, warm-up-absorbed,
 * R2-N3); the recurrence block OUTLIVES episode close so the reopen window has
 * memory (R2-N2).
 *
 * N7: `stateDir` is the per-agent state root — never a shared/global path.
 * Supervision tier (N6): Tier 0 — deterministic file I/O, no LLM anywhere.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SkewDimension } from './machineCoherenceEvaluate.js';
import type { AnchorsBlock } from './machineCoherenceAnchors.js';

/** The pendingFix three-state lifecycle (§4.2.1-i, R3-M6 / R4-M2). */
export type PendingFixState = 'proposed' | 'approved-holding' | 'executing-verifying';

/**
 * A single approved-or-proposed fix bound to ONE proposal (§4.2.1-i cardinality
 * — at most one per episode). The proposal hash + message id is the AUTHORITY:
 * a reply confirms ONLY the exact recorded proposal (display-integrity).
 */
export interface PendingFix {
  state: PendingFixState;
  /** The N1 skew-row identity this fix targets. */
  rowIdentity: string;
  /** The manifest flag / dimension key being equalized. */
  key: string;
  dimension: SkewDimension;
  /** The divergent machine whose local config the fix rewrites (§4.2.1-iv). */
  targetMachineId: string;
  /** The concrete effective value the write yields (§4.2.1-ii direction). */
  targetValue: string;
  /** The server-authored proposal message id the reply chains to (§4.2.1-i). */
  proposalMessageId?: string;
  /** Hash over (episodeId|key|targetMachine|targetValue|proposalMessageId) — the
   *  reply-recognition authority; nothing executes without matching it. */
  proposalHash: string;
  /** Approval anchor (executing-verifying verify-clock start, R5-L1). */
  approvedAtMs?: number;
  /** First post-restart beat from the divergent machine (verify-clock anchor). */
  postRestartBeatAtMs?: number;
  /** Accumulated suspended time excluded from the executing-verifying clocks
   *  (§4.2.1-v; transition-written — suspend-start/resume-end are its writers). */
  accumulatedSuspendedMs?: number;
  /** Set while an executing-verifying fix is inside a suspension (pause anchor). */
  suspendStartedAtMs?: number;
}

/**
 * The §4.5 recurrence bookkeeping — a sibling block that OUTLIVES episode close
 * (R2-N2) so the reopen window has memory. All brakes on a budget-exempt HIGH
 * path (M2) live here durably; an in-memory implementation would reset the
 * brake at exactly the restart-heavy moment a boot-flag flap needs it.
 */
export interface RecurrenceBlock {
  /** Rolling new-item open timestamps for the per-day cap (maxEpisodeItemsPerDay). */
  newItemTimestamps: number[];
  /** Recently-closed row-identity sets (+ the item id, so a reopen reuses the
   *  SAME item/topic) — the reopenWindowMs memory. */
  recentlyClosed: Array<{ rowIdentities: string[]; closedAtMs: number; itemId?: string }>;
  /** Episode-reopen flapping latch (flappingLatchReopens within the window). */
  reopenLatch?: { latched: boolean; reopenCount: number; windowStartMs: number };
  /** Shared per-episode append budget (episodeAppendBudget within the window);
   *  reservedSuspendResumeAtMs guarantees ONE slot per window for the first
   *  suspend/resume transition (R4-L6). */
  appendBudget?: { appendTimestamps: number[]; latched: boolean; reservedSuspendResumeAtMs?: number };
  /** When the per-day-cap give-up note last fired (once per rolling 24 h). */
  capGiveupAtMs?: number;
  /** calm-alerting M-P2 resolve-note bounding: last resolve NOTE per item id
   *  (at most one per reopenWindowMs; latched-flapping closes are jsonl-only).
   *  Additive. */
  resolveNoteAtByItem?: Record<string, number>;
}

/** A §4.3 close reason — only `restored` may ever claim restoration. */
export type EpisodeCloseReason =
  | 'restored'
  | 'suspended-peer-offline'
  | 'suspended-peer-unverifiable'
  | 'expired-peer-gone'
  | 'superseded-by-takeover'
  | 'resolved-after-reenable'
  | 'manifest-changed'
  | 'state-rebaselined';

/** The durable episode state (§4.1). `mc-<openedAtEpochMs>` id (N4). */
export interface EpisodeState {
  /** `mc-<openedAtMs>` — machine-local view id, minted per §4.1. */
  episodeId: string;
  openedAtMs: number;
  /** The N1 skew-row identity set this episode covers (§3.4 match key). */
  skewRowIdentities: string[];
  /** When the ONE attention item was raised (R4-M1); absent until raised. */
  itemRaisedAt?: number;
  /** The item id (`machine-coherence:<episodeId>`), once raised. */
  attentionItemId?: string;
  /** Predecessor episode id cross-referenced on a §3.4 takeover (R2-M2). */
  predecessorEpisodeId?: string;
  /** Durable suspended flag (§4.3; stale-until-latch-exit per R4-N5). */
  suspended?: boolean;
  suspendReason?: 'peer-offline' | 'peer-unverifiable';
  /** The durable operator "leave it" ack (R4-N2) — suppresses §4.4 escalation. */
  operatorAck?: boolean;
  /** The single in-flight fix (§4.2.1 cardinality — one per episode). */
  pendingFix?: PendingFix;
  /** The §4.4 escalation-append latch fired flag (one per episode). */
  escalationAppended?: boolean;
  /** Re-open count carried on the episode (§4.5 damper). */
  reopenCount?: number;
  /**
   * Derived escalation item ids raised for this episode (`<itemId>:stalled` /
   * `<itemId>:recurring`) — the close path resolves EVERY one (calm-alerting
   * M-P2 derived-item lifecycle); doubles as the restart-proof per-episode
   * once-per-class raise record. Additive.
   */
  derivedItemIds?: string[];
  /** calm-alerting: episode classified calm at open (all rows patch-only version
   *  skew under the calm gate) — drives silent narration + close mode. Additive. */
  calmClass?: boolean;
  /**
   * Durable operator-interaction bit (calm-alerting M-P2): set ONLY by
   * evidence-carrying operator actions (fix approval / explicit ack), NEVER
   * derived from pendingFix presence (auto-created at raise, cleared on every
   * fix path). Interacted episodes close with a notifying resolve note; a
   * reopen does NOT carry it. Additive.
   */
  operatorInteracted?: boolean;
  recurrence: RecurrenceBlock;
}

/** The on-disk file shape: the open episode (or null) + the outliving recurrence. */
export interface EpisodeFile {
  version: 1;
  /** The currently-open episode, or null between episodes (recurrence persists). */
  episode: EpisodeState | null;
  /** Outlives episode close — the reopen window's memory (R2-N2). */
  recurrence: RecurrenceBlock;
  /**
   * The M-P0 identity-independent clock layer (calm-transient-episode-alerting
   * spec) — STRICTLY ADDITIVE: `version` stays 1, the reader is lenient to it,
   * and a binary rollback treats it as inert. Absent on files written before
   * the calm-alerting feature.
   */
  anchors?: AnchorsBlock;
}

/** The result of a durable read — absent / ok / corrupt (§4.6 re-baseline gate). */
export type EpisodeReadResult =
  | { status: 'absent' }
  | { status: 'ok'; file: EpisodeFile }
  | { status: 'corrupt'; reason: string };

/** Mint a machine-local episode id (§4.1, N4): `mc-<openedAtEpochMs>`. */
export function mintEpisodeId(openedAtMs: number): string {
  return `mc-${openedAtMs}`;
}

/** The durable file path (N7 — per-agent `state/` subdir, never global). */
export function episodeStatePath(stateDir: string): string {
  return path.join(stateDir, 'state', 'machine-coherence-episode.json');
}

/** An empty recurrence block (fresh baseline / no prior memory). */
export function emptyRecurrence(): RecurrenceBlock {
  return { newItemTimestamps: [], recentlyClosed: [] };
}

/**
 * Read the durable episode file, distinguishing absent / ok / corrupt so the
 * caller can re-baseline WITHOUT crashing (§4.6, the GuardPostureProbe pattern).
 * A structurally-invalid file (bad JSON, wrong version, missing required shape)
 * returns `corrupt` with a named reason — never a throw, never a silent {}.
 */
export function readEpisodeFile(stateDir: string): EpisodeReadResult {
  const p = episodeStatePath(stateDir);
  let raw: string;
  try {
    if (!fs.existsSync(p)) return { status: 'absent' };
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { status: 'corrupt', reason: `read-failed: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt', reason: 'invalid-json' };
  }
  if (!parsed || typeof parsed !== 'object') return { status: 'corrupt', reason: 'not-an-object' };
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) return { status: 'corrupt', reason: `bad-version:${String(obj.version)}` };
  if (!obj.recurrence || typeof obj.recurrence !== 'object') return { status: 'corrupt', reason: 'missing-recurrence' };
  const ep = obj.episode;
  if (ep !== null && ep !== undefined) {
    if (typeof ep !== 'object') return { status: 'corrupt', reason: 'episode-not-object' };
    const e = ep as Record<string, unknown>;
    if (typeof e.episodeId !== 'string' || typeof e.openedAtMs !== 'number' || !Array.isArray(e.skewRowIdentities)) {
      return { status: 'corrupt', reason: 'episode-shape' };
    }
  }
  const rec = obj.recurrence as Record<string, unknown>;
  if (!Array.isArray(rec.newItemTimestamps) || !Array.isArray(rec.recentlyClosed)) {
    return { status: 'corrupt', reason: 'recurrence-shape' };
  }
  return { status: 'ok', file: obj as unknown as EpisodeFile };
}

/**
 * Atomically write the durable episode file (§4.1 transition-write; mirrors
 * `writeConfigAtomic`'s tmp+rename). The `state/` subdir is created if absent.
 * Callers write on TRANSITIONS only — never per tick.
 */
export function writeEpisodeFile(stateDir: string, file: EpisodeFile): void {
  const p = episodeStatePath(stateDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
