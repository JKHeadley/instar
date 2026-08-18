/**
 * standDownDrain.ts — the corroborated DRAIN predicate for the duplicate-session
 * stand-down (spec: docs/specs/duplicate-session-standdown.md §Drained-close).
 *
 * P20 — VERIFY THE STATE, NOT ITS SYMBOL. "Drained" is never inferred from the
 * registry write that muzzled the session. It is corroborated from four
 * independent observations, and any UNCERTAINTY resolves to NOT drained (wait),
 * because the consequence of a wrong `drained` is closing a session that still
 * holds work.
 *
 * THE BLOCK-ECHO SUBTLETY (why a naive transcript check fails). A muzzled session
 * whose tool calls exit 2 keeps WRITING to its transcript — the model reacting to
 * the block messages. A plain "transcript quiet" check therefore never converges:
 * the muzzle itself generates the activity that proves the session is not
 * drained. Hence the alternate signal: a session whose ONLY activity since
 * registration is BLOCKED calls, and which has returned to its prompt, counts as
 * drained. A block-loop that ENDS must not be held un-drained by the noise the
 * blocks themselves generated.
 *
 * THE MCP-STACK SUBTLETY (why `hasActiveProcesses` is the wrong probe here). The
 * existing baseline filter excludes the MCP SERVER processes but not what they
 * spawn — Playwright's Chromium is a descendant of the MCP server, matches no
 * baseline pattern, and is resident whether or not any work is running. A drain
 * predicate keyed on `hasActiveProcesses` would therefore never fire for any
 * session with a browser MCP attached. `drainProcessShape` excludes the WHOLE
 * resident MCP subtree — the server AND everything under it — and nothing else.
 */

import { MCP_STACK_ROOT_PATTERNS } from './baselineProcessPatterns.js';

/** One row of `ps -eo pid,ppid,command`. */
interface ProcRow { ppid: string; command: string }

/** Non-MCP processes that are always present and never mean "work is running". */
const DRAIN_BASELINE_PATTERNS = [
  /\bcaffeinate\b/,
];

/**
 * Does the session's process tree show work running, EXCLUDING the resident MCP
 * stack and the framework's own main process?
 *
 * Returns `null` when the tree cannot be resolved — an explicitly UNKNOWN answer
 * the caller must treat as NOT drained. A boolean-with-a-fail-safe-default would
 * hide exactly the case where closing is most dangerous.
 */
export function drainProcessShape(panePid: string, psOutput: string): { working: boolean } | null {
  if (!panePid || !/^\d+$/.test(panePid)) return null;
  const processes = new Map<string, ProcRow>();
  for (const line of psOutput.split('\n').slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) processes.set(m[1], { ppid: m[2], command: m[3] });
  }
  if (processes.size === 0) return null;

  // Walk the descendant tree, marking every node that sits under an MCP root.
  const descendants: Array<{ pid: string; command: string; ppid: string; inMcpStack: boolean }> = [];
  const queue: Array<{ pid: string; inMcpStack: boolean }> = [{ pid: panePid, inMcpStack: false }];
  const seen = new Set<string>([panePid]);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const [pid, info] of processes) {
      if (info.ppid !== parent.pid || seen.has(pid)) continue;
      seen.add(pid);
      const isMcpRoot = MCP_STACK_ROOT_PATTERNS.some((p) => p.test(info.command));
      const inMcpStack = parent.inMcpStack || isMcpRoot;
      descendants.push({ pid, command: info.command, ppid: info.ppid, inMcpStack });
      queue.push({ pid, inMcpStack });
    }
  }

  const working = descendants.some((d) => {
    if (d.inMcpStack) return false;                                    // resident stack — not work
    if (DRAIN_BASELINE_PATTERNS.some((p) => p.test(d.command))) return false;
    // The framework's own main process is the direct child of the pane shell.
    if (d.ppid === panePid && (/\bclaude\b/.test(d.command) || /\bnode\b.*\bclaude\b/.test(d.command))) return false;
    return true;
  });
  return { working };
}

/** The observations the drain verdict is computed from. Each may be `null` =
 *  could not be determined, which resolves to NOT drained. */
export interface DrainObservations {
  /** The pane shows an idle prompt. */
  idleAtPrompt: boolean | null;
  /** Work is running in the process tree, MCP stack excluded (see above). */
  processWorking: boolean | null;
  /** The framework transcript grew since the last observation. */
  transcriptGrew: boolean | null;
  /** Every transcript turn since the drain boundary was a reaction to a BLOCKED
   *  call (the block-echo case) — i.e. the growth is the muzzle's own noise. */
  growthIsBlockEchoOnly: boolean;
  /** Non-allowlisted tool calls that genuinely COMPLETED in this observation
   *  window. A completed non-allowlisted call means enforcement is not actually
   *  holding — or, in the first window, that the in-flight step the muzzle
   *  deliberately allows has just landed. Either way the session is not quiet
   *  YET; consecutive clean windows are what establish drain. */
  nonAllowlistedCallsSinceBoundary: number;
}

export type DrainVerdict =
  | { drained: true; basis: 'quiet' | 'block-echo-only' }
  | { drained: false; reason: 'pane-busy' | 'unknown-pane' | 'unknown-process-tree' | 'process-working' | 'transcript-active' | 'unknown-transcript' | 'calls-since-boundary' };

/**
 * The corroborated verdict. Every leg must be POSITIVELY established; an
 * unresolvable leg is `drained: false` with a named reason, never a shrug.
 */
export function evaluateDrain(obs: DrainObservations): DrainVerdict {
  // A completed non-allowlisted call after the drain boundary means the session
  // is still ACTING. This is checked first because it is the only leg that can be
  // true while every other leg looks quiet (the call finished between probes).
  if (obs.nonAllowlistedCallsSinceBoundary > 0) return { drained: false, reason: 'calls-since-boundary' };
  // A busy pane and an unprobeable one produce the same VERDICT but are not the
  // same fact, and the audit is read to judge whether the predicate is
  // converging — collapsing them makes live work look like an instrumentation
  // failure.
  if (obs.idleAtPrompt === false) return { drained: false, reason: 'pane-busy' };
  if (obs.idleAtPrompt !== true) return { drained: false, reason: 'unknown-pane' };
  if (obs.processWorking === null) return { drained: false, reason: 'unknown-process-tree' };
  if (obs.processWorking) return { drained: false, reason: 'process-working' };
  if (obs.transcriptGrew === true) {
    // The alternate signal: growth that is ONLY the model reacting to blocks is
    // not work. Without this, a muzzled session can never drain — the muzzle
    // generates the activity that proves it is not drained.
    if (obs.growthIsBlockEchoOnly) return { drained: true, basis: 'block-echo-only' };
    return { drained: false, reason: 'transcript-active' };
  }
  // Same busy-vs-unprobeable split as the pane leg, for the same reason — and
  // this is the leg MOST likely to be unreadable (path resolution + a 512KB tail
  // read), so collapsing it made a systematically-unreadable transcript look
  // like a genuinely busy session in the very evidence the flip decision reads.
  if (obs.transcriptGrew === null) return { drained: false, reason: 'unknown-transcript' };
  return { drained: true, basis: 'quiet' };
}

/**
 * The keep-reasons the drained-close crosses, EXHAUSTIVE against ReapGuard's
 * actual reason enumeration. A non-exhaustive list is how a silent hole ships,
 * so this is a frozen constant a test pins against ReapGuard.
 *
 *  - `recent-user-message`: the inbound rules guarantee a fresh local message
 *    already released or diverted the entry, so a residual hold is stale by
 *    construction.
 *  - `active-process`: crossed ONLY because `evaluateDrain` positively
 *    established that nothing outside the resident MCP stack is running. The
 *    drain predicate is what makes this safe; without it this bypass would be
 *    exactly the blanket activeness bypass round-4 review rejected.
 *  - `open-commitment`: a commitment binds the AGENT, not this copy. The
 *    registration preconditions proved the conversation is served on the owner,
 *    whose copy carries the commitment.
 *
 * NEVER crossed: protected, active-subagent, structural-long-work,
 * recovery-in-flight, pending-injection, relay-lease, spawn-grace, and both
 * uninspectable reasons — uncertainty is not evidence.
 */
export const DRAINED_CLOSE_BYPASSED_REASONS: readonly string[] = Object.freeze([
  'recent-user-message',
  'active-process',
  'open-commitment',
]);

/** Reasons the drained-close must NEVER bypass. Pinned by test against the
 *  ReapGuard cascade so a newly-added keep-reason cannot silently join the
 *  bypassed set. */
export const DRAINED_CLOSE_NEVER_BYPASSED: readonly string[] = Object.freeze([
  'protected',
  'active-subagent',
  'structural-long-work',
  'recovery-in-flight',
  'pending-injection',
  'relay-lease',
  'spawn-grace',
  'main-process-active',
  'main-process-uninspectable',
  'process-uninspectable',
  'guard-error',
]);

/**
 * The reap-log reason for a drained close. The `topic moved` PREFIX is
 * DELIBERATE and load-bearing: `ResumeQueue.classify` already hard-excludes that
 * prefix, so the existing exclusion catches this close with zero new code, and
 * reap-notify's per-topic notice suppression keys on the same shape. A reason
 * string without the prefix would need new exclusion work in two places.
 */
export function drainedCloseReason(ownerMachineId: string): string {
  return `topic moved — stand-down complete (owned by ${ownerMachineId})`;
}


/** The exact sentence the muzzle's exit-2 message opens with. A transcript turn
 *  echoing it is the model REACTING TO the block, not doing work. Kept next to
 *  the predicate that consumes it so the two cannot drift apart. */
export const STANDDOWN_BLOCK_SIGNATURE = 'This session is standing down:';

/** Tools the muzzle never blocks. Mirrors the hook's own allowlist; the drain
 *  predicate must agree with the hook about what "did not start work" means. */
export const STANDDOWN_ALLOWLISTED_TOOLS: readonly string[] = Object.freeze(['Read', 'Glob', 'Grep', 'TodoWrite']);

/**
 * Analyse framework-transcript lines for the two transcript-derived drain legs.
 *
 * Pure over ALREADY-PARSED lines so the interesting logic is testable without a
 * filesystem: the caller does the bounded tail read.
 *
 * `growthIsBlockEchoOnly` is true when there IS growth after the boundary and
 * every bit of it is the model reacting to a block message. That is the leg that
 * lets a muzzled session converge at all — see the module docstring.
 */
export function analyseTranscriptSinceBoundary(
  lines: Array<Record<string, unknown>>,
  sinceMs: number,
): { grew: boolean; growthIsBlockEchoOnly: boolean; nonAllowlistedCalls: number } {
  // `sinceMs` is the LAST OBSERVATION, not a fixed registration boundary — and
  // that distinction is load-bearing. Measured from a fixed boundary, `grew` is
  // MONOTONIC: once anything at all happens after registration it is true
  // forever, so a session that went quiet an hour ago still reads as active and
  // can never drain. Windowing per observation is what makes "quiet" mean quiet.
  // Convergence then comes from `drainConfirmTicks` CONSECUTIVE clean windows,
  // which is also what lets the in-flight step the muzzle deliberately allows
  // complete in one window and be gone by the next.
  let grew = false;
  let nonAllowlistedCalls = 0;
  /** Did a BLOCK actually happen inside this window? `block-echo-only` is a
   *  claim about a block LOOP, so it needs a block. Without this the predicate
   *  degenerated into "nothing completed in this window", which a quiet-but-
   *  thinking session satisfies — and which is nearly the leg evaluateDrain
   *  already checks, so it granted drain on no evidence of the muzzle at all. */
  let blockedInWindow = false;

  // tool_use_id → name, and which ids came back BLOCKED. Built across the whole
  // tail (a request can predate the window while its result lands inside it).
  const toolNameById = new Map<string, string>();
  const blockedIds = new Set<string>();
  const resolvedIds = new Set<string>();
  for (const line of lines) {
    for (const [id, name] of extractToolUses(line)) toolNameById.set(id, name);
    for (const [id, blocked] of extractToolResults(line)) {
      resolvedIds.add(id);
      if (blocked) blockedIds.add(id);
    }
  }

  let realActivityTurns = 0;
  let blockLoopTurns = 0;

  for (const line of lines) {
    const tsRaw = line.timestamp;
    const ts = typeof tsRaw === 'string' ? Date.parse(tsRaw) : (typeof tsRaw === 'number' ? tsRaw : NaN);
    if (!Number.isFinite(ts) || ts <= sinceMs) continue;
    grew = true;

    // COUNT RESULTS, NOT REQUESTS. A `tool_use` block is written when a call is
    // REQUESTED, and a hook-blocked call is requested too — counting those made
    // a single blocked call pin the count non-zero and `drained` unreachable for
    // exactly the retry-looping session the block-echo basis exists to let
    // converge. A RESULT means the call actually ran; a result carrying the
    // block message means it did not.
    for (const [id, blocked] of extractToolResults(line)) {
      if (blocked) continue;
      const name = toolNameById.get(id);
      // Unattributable ⇒ not counted. Guessing "not allowlisted" would re-break
      // drain through a different door.
      if (!name) continue;
      if (!STANDDOWN_ALLOWLISTED_TOOLS.includes(name)) nonAllowlistedCalls += 1;
    }

    // Is this record part of the block LOOP, or real activity? A request whose
    // result came back blocked is the loop just as much as the block itself —
    // the model asking again IS the reaction to the previous block. Judging a
    // record by whether it literally contains the block text would count every
    // retry request as fresh work and hold the session un-drained forever.
    for (const [, blocked] of extractToolResults(line)) if (blocked) blockedInWindow = true;
    if (classifyBlockLoopRecord(line, blockedIds, toolNameById, resolvedIds)) blockLoopTurns += 1;
    else realActivityTurns += 1;
  }

  return {
    grew,
    growthIsBlockEchoOnly: grew && blockedInWindow && blockLoopTurns > 0 && realActivityTurns === 0,
    nonAllowlistedCalls,
  };
}

/**
 * Is this record part of the block LOOP rather than real activity?
 *
 * The predicate is about COMPLETED TOOL ACTIVITY, deliberately — not about
 * whether a record "looks like" a block. An earlier version required every
 * content block to be a blocked tool_use/tool_result, which reads plausibly and
 * is wrong against the real transcript: Claude Code writes each content block as
 * its own record, and extended thinking is this agent's default, so a muzzled
 * model reacting to a block emits `thinking` and `text` records around its
 * retry. Every real retry window therefore contained a non-block record, the
 * basis never fired, and the retry-looping session it exists for could never
 * drain. (Grounded against a real transcript, not inferred: 31 tool_use, 31
 * tool_result, 20 thinking, 6 text records in one 600KB window.)
 *
 * A model THINKING and TALKING while it settles is exactly the quiescence this
 * design asks for. What would make a record real activity is a tool call that
 * actually RAN — and that is what this checks.
 */
function classifyBlockLoopRecord(
  line: Record<string, unknown>,
  blockedIds: ReadonlySet<string>,
  toolNameById: ReadonlyMap<string, string>,
  resolvedIds: ReadonlySet<string>,
): boolean {
  for (const block of contentBlocksOf(line)) {
    if (!block) continue;
    if (block.type === 'tool_use') {
      const id = typeof block.id === 'string' ? block.id : null;
      if (id && blockedIds.has(id)) continue;              // the loop's own retry
      // An IN-FLIGHT non-allowlisted request — issued, no result yet in the
      // window — is work RUNNING, not loop noise. Treating it as noise let the
      // predicate declare drain while the in-flight step the muzzle deliberately
      // allows was still executing; and when that step is an MCP tool call the
      // process leg cannot see it either, because the whole MCP subtree is
      // excluded by design. That combination is how a working session gets
      // closed, which is the one outcome this design exists to prevent.
      const inFlightName = id ? toolNameById.get(id) : undefined;
      if (id && !resolvedIds.has(id) && (!inFlightName || !STANDDOWN_ALLOWLISTED_TOOLS.includes(inFlightName))) return false;
      continue;
    }
    if (block.type === 'tool_result') {
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
      if (id && blockedIds.has(id)) continue;      // the block itself
      const name = id ? toolNameById.get(id) : undefined;
      if (name && STANDDOWN_ALLOWLISTED_TOOLS.includes(name)) continue; // reads stay open
      return false;                                 // a call genuinely completed
    }
    // thinking / text / anything else: the model settling, not work.
  }
  return true;
}

/** `[tool_use_id, toolName]` pairs from one record. */
function extractToolUses(line: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const block of contentBlocksOf(line)) {
    if (block && block.type === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string') {
      out.push([block.id, block.name]);
    }
  }
  return out;
}

/** `[tool_use_id, wasBlockedByTheMuzzle]` pairs from one record. */
function extractToolResults(line: Record<string, unknown>): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  for (const block of contentBlocksOf(line)) {
    if (!block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    // The block message is what the hook wrote to stderr; the framework surfaces
    // it as the tool's (error) result. Matching on the signature — not on
    // `is_error` — keeps an unrelated tool failure counted as a real completed
    // call, which it is.
    const blocked = JSON.stringify(block.content ?? '').includes(STANDDOWN_BLOCK_SIGNATURE);
    out.push([block.tool_use_id, blocked]);
  }
  return out;
}

/** Content blocks of a record, tolerating shape drift across framework versions. */
function contentBlocksOf(line: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = line.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? message.content : (Array.isArray(line.content) ? line.content : []);
  return content as Array<Record<string, unknown>>;
}




/** A peer machine's answer to "do you hold a copy of this conversation?". */
export type PeerStandDownView = 'muzzled' | 'speaking' | 'absent' | null;

/**
 * Classify one peer's `/standdown` answer for the anti-mutual-muzzle tiebreak.
 *
 * EXPORTED AND PURE so the composition root and the tests consume the SAME
 * function. The first version of this logic lived inline in server.ts and its
 * test was a hand-written re-implementation whose comment said it "mirrors" the
 * production code — the exact fixture-free-to-agree-with-broken-code shape this
 * build kept re-finding in itself.
 *
 *  - an entry for the topic          → 'muzzled'
 *  - no entry BUT a live session      → 'speaking'
 *  - no entry and no live session     → 'absent'   (an idle bystander)
 *  - HTTP 503 / featureDark           → 'absent'   (a DEFINITE "no muzzle here" —
 *    this feature is dev-gated, so a mixed pool is the EXPECTED configuration)
 *  - registry-known-offline peer      → 'absent'   (a sleeping laptop is not an
 *    unknown; treating it as one released legitimate muzzles in ≥3-machine pools)
 *  - anything else                    → null       (genuinely unknown)
 */
export function classifyPeerStandDownView(
  answer:
    | { kind: 'offline' }
    | { kind: 'feature-dark' }
    | { kind: 'unreachable' }
    | { kind: 'ok'; entries: Array<{ topicId?: number; state?: string }>; liveTopics: number[] },
  topicId: number,
): PeerStandDownView {
  switch (answer.kind) {
    case 'offline':
    case 'feature-dark':
      return 'absent';
    case 'unreachable':
      return null;
    case 'ok': {
      const muzzled = answer.entries.some(
        (e) => e.topicId === topicId && e.state !== 'closed' && e.state !== 'released',
      );
      if (muzzled) return 'muzzled';
      return answer.liveTopics.includes(topicId) ? 'speaking' : 'absent';
    }
  }
}
