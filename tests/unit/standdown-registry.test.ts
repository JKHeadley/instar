// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Unit tests — StandDownRegistry lifecycle, episode latches, marker file, and
 * the corroborated drain predicate.
 *
 * Spec: docs/specs/duplicate-session-standdown.md
 *
 * These lock the properties a reviewer specifically worried about:
 *  - the TTL RESUMES across re-registration inside an episode (never resets),
 *    or a producer re-confirming every tick holds a session muzzled forever;
 *  - a released/expired episode is LATCHED and cannot be re-minted by an
 *    unchanged verdict, but a strictly NEWER ownership epoch re-admits;
 *  - a CLEAN close arms no latch (that episode ended correctly);
 *  - `expired` keeps BOTH enforcement halves — the entry stays consultable;
 *  - the marker file is regenerated EMPTY on a corrupt-file boot, never stale;
 *  - drain is corroborated and every uncertainty resolves to NOT drained.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StandDownRegistry, DEFAULT_STANDDOWN_CONFIG } from '../../src/core/StandDownRegistry.js';
import { paneShowsClaudeWorking } from '../../src/core/claudeActivityIndicators.js';
import { IDLE_PROMPT_PATTERNS } from '../../src/core/SessionManager.js';
import { BASELINE_PROCESS_PATTERNS, MCP_STACK_ROOT_PATTERNS } from '../../src/core/baselineProcessPatterns.js';
import {
  evaluateDrain, drainProcessShape, drainedCloseReason, analyseTranscriptSinceBoundary,
  STANDDOWN_BLOCK_SIGNATURE, classifyPeerStandDownView,
  DRAINED_CLOSE_BYPASSED_REASONS, DRAINED_CLOSE_NEVER_BYPASSED,
} from '../../src/core/standDownDrain.js';

let dir: string;
let clock: number;
const now = () => clock;

function makeRegistry(cfg = {}) {
  return new StandDownRegistry({ stateDir: dir, now }, { ...cfg });
}

const REQ = {
  sessionName: 'topic-46473',
  topicId: 46473,
  ownerMachineId: 'laptop-a',
  ownershipEpoch: 7,
  reason: 'duplicate — owner elsewhere',
  dryRun: false,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standdown-'));
  clock = 1_700_000_000_000;
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('StandDownRegistry — registration', () => {
  it('registers and lists an entry, and writes the hook marker file', () => {
    const r = makeRegistry();
    const res = r.register(REQ, 'mini-b');
    expect(res.ok).toBe(true);
    expect(r.list()).toHaveLength(1);
    const marker = JSON.parse(fs.readFileSync(r.markerPath, 'utf-8'));
    expect(marker.sessions).toEqual(['topic-46473']);
  });

  it('REFUSES when the local machine is itself the named owner (self-is-owner)', () => {
    const r = makeRegistry();
    const res = r.register(REQ, 'laptop-a');
    expect(res).toMatchObject({ ok: false, refusal: 'self-is-owner' });
    expect(r.list()).toHaveLength(0);
  });

  it('refuses a malformed machine id rather than writing it into the block message', () => {
    const r = makeRegistry();
    const res = r.register({ ...REQ, ownerMachineId: 'evil machine\n<script>' }, 'mini-b');
    expect(res).toMatchObject({ ok: false, refusal: 'malformed' });
  });

  it('is idempotent inside an episode and the TTL RESUMES rather than resets', () => {
    const r = makeRegistry();
    const first = r.register(REQ, 'mini-b');
    expect(first.ok && first.created).toBe(true);
    const originalExpiry = first.ok ? first.entry.expiresAt : 0;
    clock += 30 * 60_000; // half the TTL later, the producer re-confirms
    const second = r.register(REQ, 'mini-b');
    expect(second.ok).toBe(true);
    expect(second.ok && second.created).toBe(false);
    expect(second.ok && second.entry.expiresAt).toBe(originalExpiry);
  });
});

describe('StandDownRegistry — episode latches (P19)', () => {
  it('a released episode is latched: the same verdict cannot re-mint it', () => {
    const r = makeRegistry();
    r.register(REQ, 'mini-b');
    r.release(REQ.sessionName, 'ownership moved back');
    const again = r.register(REQ, 'mini-b');
    expect(again).toMatchObject({ ok: false, refusal: 'episode-latched' });
  });

  it('a STRICTLY NEWER ownership epoch re-admits (genuine new adjudication)', () => {
    const r = makeRegistry();
    r.register(REQ, 'mini-b');
    r.release(REQ.sessionName, 'flap');
    const readmitted = r.register({ ...REQ, ownershipEpoch: 8 }, 'mini-b');
    expect(readmitted.ok).toBe(true);
  });

  it('raises latch attention after the threshold so a live duplicate is never invisible', () => {
    const r = makeRegistry({ latchBlockedAttentionThreshold: 3 });
    r.register(REQ, 'mini-b');
    r.release(REQ.sessionName, 'flap');
    for (let i = 0; i < 3; i++) r.register(REQ, 'mini-b');
    const due = r.claimLatchAttention();
    expect(due).toHaveLength(1);
    expect(due[0].blockedAttempts).toBeGreaterThanOrEqual(3);
    // Claimed once — the item does not re-fire every tick.
    expect(r.claimLatchAttention()).toHaveLength(0);
  });

  it('a CLEAN close arms NO latch — a later genuine duplicate is admissible', () => {
    const r = makeRegistry();
    r.register(REQ, 'mini-b');
    r.markClosed(REQ.sessionName);
    expect(r.latches()).toHaveLength(0);
    expect(r.register(REQ, 'mini-b').ok).toBe(true);
  });

  it('prunes a latch whose ownership epoch has been superseded', () => {
    const r = makeRegistry();
    r.register(REQ, 'mini-b');
    r.release(REQ.sessionName, 'flap');
    expect(r.latches()).toHaveLength(1);
    expect(r.pruneLatches(new Map([[46473, 9]]))).toBe(1);
    expect(r.latches()).toHaveLength(0);
  });
});

describe('StandDownRegistry — drain, expiry, and release', () => {
  it('needs drainConfirmTicks corroborated observations before drained', () => {
    const r = makeRegistry({ drainConfirmTicks: 2 });
    r.register(REQ, 'mini-b');
    expect(r.observeDrain(REQ.sessionName, true)).toBe(false);
    expect(r.observeDrain(REQ.sessionName, true)).toBe(true);
    expect(r.getBySession(REQ.sessionName)?.state).toBe('drained');
  });

  it('DEMOTES an already-drained entry when a later observation is not drained', () => {
    // `drained` authorizes the three-reason keep-guard bypass. Latched, one pair
    // of quiet windows permanently authorized a close, so a session that resumed
    // work would be closed the moment an unrelated guard stopped vetoing. A state
    // that can only ever be entered is a symbol, not a verified state (P20).
    const r = makeRegistry({ drainConfirmTicks: 2 });
    r.register(REQ, 'mini-b');
    r.observeDrain(REQ.sessionName, true);
    expect(r.observeDrain(REQ.sessionName, true)).toBe(true);
    expect(r.getBySession(REQ.sessionName)?.state).toBe('drained');
    expect(r.observeDrain(REQ.sessionName, false)).toBe(false);
    expect(r.getBySession(REQ.sessionName)?.state).toBe('standing-down');
  });

  it('an unconfirmed tick resets the drain streak (uncertainty is not evidence)', () => {
    const r = makeRegistry({ drainConfirmTicks: 2 });
    r.register(REQ, 'mini-b');
    r.observeDrain(REQ.sessionName, true);
    r.observeDrain(REQ.sessionName, false);
    expect(r.observeDrain(REQ.sessionName, true)).toBe(false);
  });

  it('expiry keeps BOTH enforcement halves — the entry stays consultable and muzzling', () => {
    const r = makeRegistry();
    r.register(REQ, 'mini-b');
    r.expire(REQ.sessionName);
    const e = r.getBySession(REQ.sessionName);
    expect(e?.state).toBe('expired');
    expect(r.isEnforcing(e)).toBe(true);
    expect(r.getByTopic(46473)?.state).toBe('expired');
    const marker = JSON.parse(fs.readFileSync(r.markerPath, 'utf-8'));
    expect(marker.sessions).toEqual(['topic-46473']);
  });

  it('an operator ack of an expired episode clears both the entry and the latch', () => {
    const r = makeRegistry();
    r.register(REQ, 'mini-b');
    r.expire(REQ.sessionName);
    expect(r.operatorRelease(REQ.sessionName)).toBe(true);
    expect(r.getBySession(REQ.sessionName)).toBeNull();
    expect(r.register(REQ, 'mini-b').ok).toBe(true);
  });

  it('release needs the hysteresis count — one dark-peer tick cannot flap the muzzle', () => {
    const r = makeRegistry({ releaseHysteresisTicks: 2 });
    r.register(REQ, 'mini-b');
    expect(r.reverify(REQ.sessionName, false, 'peer dark')).toBe('held');
    expect(r.getBySession(REQ.sessionName)).not.toBeNull();
    expect(r.reverify(REQ.sessionName, false, 'peer dark')).toBe('released');
    expect(r.getBySession(REQ.sessionName)).toBeNull();
  });

  it('a passing re-verify leg resets the failure streak', () => {
    const r = makeRegistry({ releaseHysteresisTicks: 2 });
    r.register(REQ, 'mini-b');
    r.reverify(REQ.sessionName, false, 'blip');
    r.reverify(REQ.sessionName, true, 'ok');
    expect(r.reverify(REQ.sessionName, false, 'blip')).toBe('held');
  });

  it('dryRun entries are never enforcing and never claim the tmux notice', () => {
    const r = makeRegistry();
    r.register({ ...REQ, dryRun: true }, 'mini-b');
    expect(r.isEnforcing(r.getBySession(REQ.sessionName))).toBe(false);
    expect(r.claimNotice(REQ.sessionName)).toBe(false);
  });

  it('claims each channel\'s notice exactly once, and the two channels are INDEPENDENT', () => {
    // Two different audiences. A shared budget meant whichever fired first
    // permanently silenced the other, so a divert could leave the USER with no
    // line at all — the exact silence this design exists to prevent.
    const r = makeRegistry();
    r.register(REQ, 'mini-b');
    expect(r.claimNotice(REQ.sessionName, 'session')).toBe(true);
    expect(r.claimNotice(REQ.sessionName, 'session')).toBe(false);
    expect(r.claimNotice(REQ.sessionName, 'user')).toBe(true);
    expect(r.claimNotice(REQ.sessionName, 'user')).toBe(false);
  });

  it('an UNRESOLVABLE-read release arms no latch (it adjudicated nothing)', () => {
    // One transient null ownership read must not permanently disable a
    // legitimate muzzle — a stronger consequence than the two-legged reverify
    // path this is meant to mirror.
    const r = makeRegistry();
    r.register(REQ, 'mini-b');
    r.release(REQ.sessionName, 'ownership-unresolvable-at-send', { armLatch: false });
    expect(r.latches()).toHaveLength(0);
    expect(r.register(REQ, 'mini-b').ok).toBe(true);
  });
});

describe('StandDownRegistry — durability', () => {
  it('reloads entries and latches across a restart', () => {
    const r1 = makeRegistry();
    r1.register(REQ, 'mini-b');
    const r2 = makeRegistry();
    expect(r2.getBySession(REQ.sessionName)?.topicId).toBe(46473);
  });

  it('a corrupt durable file starts EMPTY, flags degraded, and rewrites the marker EMPTY', () => {
    const r1 = makeRegistry();
    r1.register(REQ, 'mini-b');
    fs.writeFileSync(r1.statePath, '{ this is not json', 'utf-8');
    const r2 = makeRegistry();
    expect(r2.list()).toHaveLength(0);
    expect(r2.degradedBoot.degraded).toBe(true);
    // The stale marker from the previous process must NOT survive — otherwise a
    // session stays muzzled with no entry justifying it.
    const marker = JSON.parse(fs.readFileSync(r2.markerPath, 'utf-8'));
    expect(marker.sessions).toEqual([]);
  });
});

describe('drain predicate', () => {
  const base = {
    idleAtPrompt: true, processWorking: false, transcriptGrew: false,
    growthIsBlockEchoOnly: false, nonAllowlistedCallsSinceBoundary: 0,
  };

  it('drains on a genuinely quiet session', () => {
    expect(evaluateDrain(base)).toEqual({ drained: true, basis: 'quiet' });
  });

  it('drains on block-echo-only transcript growth (the muzzle\'s own noise)', () => {
    expect(evaluateDrain({ ...base, transcriptGrew: true, growthIsBlockEchoOnly: true }))
      .toEqual({ drained: true, basis: 'block-echo-only' });
  });

  it('does NOT drain when transcript growth is real work', () => {
    expect(evaluateDrain({ ...base, transcriptGrew: true })).toMatchObject({ drained: false, reason: 'transcript-active' });
  });

  it('does NOT drain when a non-allowlisted call completed since the boundary', () => {
    expect(evaluateDrain({ ...base, nonAllowlistedCallsSinceBoundary: 1 }))
      .toMatchObject({ drained: false, reason: 'calls-since-boundary' });
  });

  it.each([
    ['pane unknown', { idleAtPrompt: null }, 'unknown-pane'],
    ['process tree unknown', { processWorking: null }, 'unknown-process-tree'],
    ['work running', { processWorking: true }, 'process-working'],
    ['transcript unknown', { transcriptGrew: null }, 'unknown-transcript'],
  ])('resolves %s to NOT drained', (_label, patch, reason) => {
    expect(evaluateDrain({ ...base, ...(patch as object) })).toMatchObject({ drained: false, reason });
  });
});

describe('analyseTranscriptSinceBoundary — the analyser, on realistic records', () => {
  // These are the shapes a real Claude Code transcript writes. The verdict
  // function was previously tested on synthetic inputs the analyser could not
  // actually produce, which is how the leg below stayed broken with green tests.
  const at = (ms: number) => new Date(ms).toISOString();
  const request = (ms: number, id: string, name: string) => ({
    timestamp: at(ms), message: { content: [{ type: 'tool_use', id, name, input: {} }] },
  });
  const result = (ms: number, id: string, content: string) => ({
    timestamp: at(ms), message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
  const BLOCKED = `${STANDDOWN_BLOCK_SIGNATURE} the conversation and its work continue on machine laptop-a.`;

  // Claude Code writes EACH content block as its own timestamped record, and
  // extended thinking is this agent's default — so a muzzled model reacting to a
  // block emits `thinking` and `text` records around its retry. Grounded against
  // a real transcript, not inferred: one 600KB window held 31 tool_use, 31
  // tool_result, 20 thinking and 6 text records. An earlier version of the
  // block-loop rule required EVERY block in a record to be a blocked tool
  // block, which those records defeat — so the basis never fired and the
  // retry-looping session it exists for could never drain.
  const thinking = (ms: number) => ({ timestamp: at(ms), message: { content: [{ type: 'thinking', thinking: 'The call was blocked. I should stop.' }] } });
  const text = (ms: number, body: string) => ({ timestamp: at(ms), message: { content: [{ type: 'text', text: body }] } });

  it('WITHOUT a block in the window, thinking alone is NOT block-echo-only', () => {
    // The round-4 finding, and the most dangerous single defect in this feature:
    // once the predicate stopped requiring real block evidence it meant only
    // "nothing completed in this window" — which a quiet-but-thinking session
    // satisfies. Combined with a pane leg that could not see a live turn, a
    // genuinely WORKING session could be declared drained and closed. That is
    // the exact harm the terminate primitive was rejected for.
    const out = analyseTranscriptSinceBoundary([thinking(2000), text(2100, 'still reasoning')], 1000);
    expect(out.grew).toBe(true);
    expect(out.growthIsBlockEchoOnly).toBe(false);
    expect(evaluateDrain({
      idleAtPrompt: true, processWorking: false, transcriptGrew: out.grew,
      growthIsBlockEchoOnly: out.growthIsBlockEchoOnly,
      nonAllowlistedCallsSinceBoundary: out.nonAllowlistedCalls,
    })).toMatchObject({ drained: false, reason: 'transcript-active' });
  });

  it('an IN-FLIGHT non-allowlisted call is active work, not loop noise', () => {
    // Requested, no result yet. The muzzle deliberately lets the held step
    // finish — and when that step is an MCP tool call the process leg cannot see
    // it either, because the whole MCP subtree is excluded by design. Counting
    // it as noise is how a session gets closed mid-work.
    const out = analyseTranscriptSinceBoundary([
      request(2000, 'tu_1', 'Bash'), result(2100, 'tu_1', BLOCKED),
      request(2200, 'tu_2', 'Bash'), // still running
    ], 1000);
    expect(out.growthIsBlockEchoOnly).toBe(false);
  });

  it('an in-flight ALLOWLISTED call does not defeat block-echo-only', () => {
    const out = analyseTranscriptSinceBoundary([
      request(2000, 'tu_1', 'Bash'), result(2100, 'tu_1', BLOCKED),
      request(2200, 'tu_2', 'Read'),
    ], 1000);
    expect(out.growthIsBlockEchoOnly).toBe(true);
  });

  it('a retry window containing thinking and text is still block-echo-only', () => {
    const out = analyseTranscriptSinceBoundary([
      request(2000, 'tu_1', 'Bash'),
      result(2100, 'tu_1', BLOCKED),
      thinking(2200),
      text(2300, 'I will stop here.'),
      request(2400, 'tu_2', 'Bash'),
      result(2500, 'tu_2', BLOCKED),
    ], 1000);
    expect(out.nonAllowlistedCalls).toBe(0);
    expect(out.growthIsBlockEchoOnly).toBe(true);
  });

  it('a COMPLETED call in the same window defeats block-echo-only, as it should', () => {
    const out = analyseTranscriptSinceBoundary([
      request(2000, 'tu_1', 'Bash'), result(2100, 'tu_1', BLOCKED),
      thinking(2200),
      request(2300, 'tu_2', 'Bash'), result(2400, 'tu_2', 'real output'),
    ], 1000);
    expect(out.nonAllowlistedCalls).toBe(1);
    expect(out.growthIsBlockEchoOnly).toBe(false);
  });

  it('an ALLOWLISTED completion does not defeat block-echo-only (reads stay open)', () => {
    const out = analyseTranscriptSinceBoundary([
      request(2000, 'tu_1', 'Bash'), result(2100, 'tu_1', BLOCKED),
      request(2200, 'tu_2', 'Read'), result(2300, 'tu_2', 'file contents'),
    ], 1000);
    expect(out.growthIsBlockEchoOnly).toBe(true);
  });

  it('a BLOCKED call is not a completed call — the muzzle working must not read as work', () => {
    // The bug this pins: counting `tool_use` (a REQUEST) meant a blocked call
    // made the count permanently non-zero, so `drained` was unreachable and the
    // block-echo basis — the entire mechanism that lets a retry-looping session
    // converge — was dead code behind an earlier return.
    const out = analyseTranscriptSinceBoundary([
      request(2000, 'tu_1', 'Bash'),
      result(2100, 'tu_1', BLOCKED),
    ], 1000);
    expect(out.nonAllowlistedCalls).toBe(0);
    expect(out.grew).toBe(true);
    expect(out.growthIsBlockEchoOnly).toBe(true);
    expect(evaluateDrain({
      idleAtPrompt: true, processWorking: false,
      transcriptGrew: out.grew, growthIsBlockEchoOnly: out.growthIsBlockEchoOnly,
      nonAllowlistedCallsSinceBoundary: out.nonAllowlistedCalls,
    })).toEqual({ drained: true, basis: 'block-echo-only' });
  });

  it('a call that genuinely COMPLETED counts, and blocks the close', () => {
    const out = analyseTranscriptSinceBoundary([
      request(2000, 'tu_1', 'Bash'),
      result(2100, 'tu_1', 'total 8\ndrwxr-xr-x  2 justin  staff'),
    ], 1000);
    expect(out.nonAllowlistedCalls).toBe(1);
    expect(evaluateDrain({
      idleAtPrompt: true, processWorking: false, transcriptGrew: true,
      growthIsBlockEchoOnly: false, nonAllowlistedCallsSinceBoundary: out.nonAllowlistedCalls,
    })).toMatchObject({ drained: false, reason: 'calls-since-boundary' });
  });

  it('an ALLOWLISTED completed call is not work (reads stay open by design)', () => {
    const out = analyseTranscriptSinceBoundary([
      request(2000, 'tu_1', 'Read'),
      result(2100, 'tu_1', 'file contents'),
    ], 1000);
    expect(out.nonAllowlistedCalls).toBe(0);
  });

  it('an UNATTRIBUTABLE result is not counted (guessing would re-break drain)', () => {
    const out = analyseTranscriptSinceBoundary([result(2100, 'tu_missing', 'something')], 1000);
    expect(out.nonAllowlistedCalls).toBe(0);
  });

  it('attributes a result whose REQUEST predates the boundary', () => {
    // The in-flight step the muzzle deliberately lets finish: requested before
    // registration, lands after. It is a real completed call and must count.
    const out = analyseTranscriptSinceBoundary([
      request(500, 'tu_1', 'Bash'),
      result(2100, 'tu_1', 'done'),
    ], 1000);
    expect(out.nonAllowlistedCalls).toBe(1);
  });

  it('ignores everything at or before the boundary', () => {
    const out = analyseTranscriptSinceBoundary([
      request(200, 'tu_1', 'Bash'), result(300, 'tu_1', 'done'),
    ], 1000);
    expect(out).toEqual({ grew: false, growthIsBlockEchoOnly: false, nonAllowlistedCalls: 0 });
  });

  it('tolerates torn/unknown record shapes without counting them as work', () => {
    const out = analyseTranscriptSinceBoundary(
      [{ timestamp: at(2000) }, { timestamp: 'not-a-date' }, { message: { content: 'not-an-array' } }] as never,
      1000,
    );
    expect(out.nonAllowlistedCalls).toBe(0);
  });
});

describe('drainProcessShape — the resident MCP stack is excluded, its siblings are not', () => {
  const ps = (rows: string[]) => ['  PID  PPID COMMAND', ...rows].join('\n');

  it('treats a Chromium under playwright-mcp as resident stack, not work', () => {
    const out = drainProcessShape('100', ps([
      '  200   100 node /usr/lib/claude/cli.js',
      '  300   100 node @playwright/mcp server',
      '  400   300 /Applications/Chromium.app/Contents/MacOS/Chromium --type=renderer',
    ]));
    expect(out).toEqual({ working: false });
  });

  it('reports work when a real tool child is running', () => {
    const out = drainProcessShape('100', ps([
      '  200   100 node /usr/lib/claude/cli.js',
      '  500   200 npm run build',
    ]));
    expect(out).toEqual({ working: true });
  });

  it('returns null (UNKNOWN) on an unusable process listing', () => {
    expect(drainProcessShape('100', 'PID PPID COMMAND')).toBeNull();
    expect(drainProcessShape('', 'anything')).toBeNull();
  });
});

describe('drained-close contract', () => {
  it('bypasses exactly three keep-reasons and never the uncertainty ones', () => {
    expect([...DRAINED_CLOSE_BYPASSED_REASONS].sort())
      .toEqual(['active-process', 'open-commitment', 'recent-user-message']);
    for (const never of DRAINED_CLOSE_NEVER_BYPASSED) {
      expect(DRAINED_CLOSE_BYPASSED_REASONS).not.toContain(never);
    }
  });

  it('carries the `topic moved` prefix the resume-queue exclusion already keys on', () => {
    expect(drainedCloseReason('laptop-a')).toMatch(/^topic moved /);
    expect(drainedCloseReason('laptop-a')).toContain('laptop-a');
  });

  it('ships the documented default tuning values', () => {
    expect(DEFAULT_STANDDOWN_CONFIG).toMatchObject({
      standDownTtlMinutes: 60, unprovableFrameworkTtlMinutes: 15,
      drainConfirmTicks: 2, releaseHysteresisTicks: 2,
    });
  });
});

describe('the pane leg genuinely distinguishes a live turn (round-4 finding)', () => {
  // IDLE_PROMPT_PATTERNS are STATUS-BAR strings, present whether or not a turn
  // is running — which is why every other consumer in this repo pairs them with
  // a second signal. Trusted alone, the pane leg was effectively always true and
  // "corroborated drain" corroborated nothing.
  const IDLE_BAR = 'bypass permissions on · shift+tab to cycle';

  it('a pane showing the working indicator is NOT idle, despite the status bar', () => {
    const working = `${IDLE_BAR}\n✻ Thinking… (esc to interrupt)`;
    expect(paneShowsClaudeWorking(working)).toBe(true);
    // The production predicate is `patterns matched && !paneShowsClaudeWorking`.
    expect(IDLE_PROMPT_PATTERNS.some((p) => working.includes(p)) && !paneShowsClaudeWorking(working)).toBe(false);
  });

  it('a pane at rest IS idle', () => {
    const resting = `${IDLE_BAR}\n> `;
    expect(paneShowsClaudeWorking(resting)).toBe(false);
    expect(IDLE_PROMPT_PATTERNS.some((p) => resting.includes(p)) && !paneShowsClaudeWorking(resting)).toBe(true);
  });
});

describe('the MCP-stack pattern list is DERIVED, not copied', () => {
  it('every MCP root comes from the single baseline source, minus caffeinate', () => {
    // An earlier version was a hand-copy whose comment claimed the two "cannot
    // drift". They could, and a third copy existed elsewhere. Now it is
    // structural: adding an MCP pattern to the baseline extends both consumers.
    expect(MCP_STACK_ROOT_PATTERNS.every((p) => BASELINE_PROCESS_PATTERNS.includes(p))).toBe(true);
    expect(MCP_STACK_ROOT_PATTERNS.some((p) => /caffeinate/.test(p.source))).toBe(false);
    expect(BASELINE_PROCESS_PATTERNS.some((p) => /caffeinate/.test(p.source))).toBe(true);
  });
});

describe('the anti-mutual-muzzle peer view — the PRODUCTION classifier', () => {
  // Consumes classifyPeerStandDownView itself — the round-5 reviewer caught the
  // first version of this suite testing a hand-written re-implementation whose
  // comment said it "mirrors the composition root", which is the exact
  // fixture-free-to-agree-with-broken-code shape this build kept re-finding.
  const T = 46473;

  it.each([
    ['a muzzled peer', { kind: 'ok', entries: [{ topicId: T, state: 'standing-down' }], liveTopics: [] }, 'muzzled'],
    ['a peer speaking for the topic', { kind: 'ok', entries: [], liveTopics: [T] }, 'speaking'],
    ['an idle bystander', { kind: 'ok', entries: [], liveTopics: [999] }, 'absent'],
    ['a peer with the feature DARK (503)', { kind: 'feature-dark' }, 'absent'],
    ['a registry-known-OFFLINE peer (sleeping laptop)', { kind: 'offline' }, 'absent'],
    ['an unreachable peer', { kind: 'unreachable' }, null],
    ['a released entry (not a muzzle)', { kind: 'ok', entries: [{ topicId: T, state: 'released' }], liveTopics: [] }, 'absent'],
  ] as const)('classifies %s as %s', (_label, answer, expected) => {
    expect(classifyPeerStandDownView(answer as never, T)).toBe(expected);
  });

  it('an idle bystander does NOT block the tiebreak (the >2-machine bug)', () => {
    // A and B mutually muzzled, C simply idle. Counting C as an unmuzzled copy
    // made the answer false, so the tiebreak never fired past two machines and
    // the agent stayed silent until the TTL — which FREEZES rather than releases.
    const peers = [
      classifyPeerStandDownView({ kind: 'ok', entries: [{ topicId: T, state: 'standing-down' }], liveTopics: [] }, T),
      classifyPeerStandDownView({ kind: 'ok', entries: [], liveTopics: [999] }, T),
    ];
    expect(peers.some((r) => r === null)).toBe(false);
    expect(peers.some((r) => r === 'speaking')).toBe(false);
    expect(peers.some((r) => r === 'muzzled')).toBe(true); // ⇒ mutual muzzle confirmed
  });

  it('one genuinely speaking peer means someone has a voice — no tiebreak', () => {
    const peers = [
      classifyPeerStandDownView({ kind: 'ok', entries: [{ topicId: T, state: 'standing-down' }], liveTopics: [] }, T),
      classifyPeerStandDownView({ kind: 'ok', entries: [], liveTopics: [T] }, T),
    ];
    expect(peers.some((r) => r === 'speaking')).toBe(true);
  });
});
