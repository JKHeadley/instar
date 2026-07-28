// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
/**
 * Autonomous stop hook — Completion Discipline (Tier 1, hook as a subprocess).
 * Spec: docs/specs/AUTONOMOUS-COMPLETION-DISCIPLINE.md.
 *
 * Exercises the SHIPPED hook (not a copy) via execFileSync, mirroring
 * autonomous-completion-condition.test.ts. Covers: the deterministic checkbox
 * 3-state scan + corruption fail-safe; the milestone + injection scans over the
 * tail-6 window; the nonce-gated <hard-blocker> (a) exit branch (external →
 * exit + JSONL row + attention item; buildable → continue; malformed/template/
 * fenced/nonce-mismatch → continue; not-final-turn → ignored); contradictory
 * terminal markers → continue; the off-switch reverts behavior; emergency/duration
 * still win; the version-skew three-case detection; the fail-open record-and-continue.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK = path.join(process.cwd(), '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');
const UUID = '04db2de7-8e82-4baf-9136-7a067bb2ec53';
let tmp: string;

interface StateOpts {
  condition?: string;
  promise?: string;
  nonce?: string;
  tasks?: string;
  durationSeconds?: number;
  startedAt?: string;
  cdEnabled?: boolean | null; // null → omit config (defaults to enabled)
  port?: number;
}

function writeConfig(opts: StateOpts) {
  const cd = opts.cdEnabled === null
    ? {}
    : { autonomousSessions: { completionDiscipline: { enabled: opts.cdEnabled !== false, judgeTimeoutMs: 5000 } } };
  fs.writeFileSync(path.join(tmp, '.instar', 'config.json'),
    JSON.stringify({ port: opts.port ?? 4040, authToken: 'test', ...cd }));
}

function writeState(opts: StateOpts) {
  const started = opts.startedAt ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const tasks = opts.tasks ?? '- [ ] task one\n- [ ] task two';
  fs.writeFileSync(path.join(tmp, '.instar', 'autonomous-state.local.md'),
    `---\nactive: true\niteration: 2\nsession_id: "${UUID}"\nduration_seconds: ${opts.durationSeconds ?? 0}\nstarted_at: "${started}"\nreport_topic: "9984"\ncompletion_promise: "${opts.promise ?? ''}"\ncompletion_condition: "${opts.condition ?? ''}"\nhard_blocker_nonce: "${opts.nonce ?? ''}"\n---\n\n# Autonomous Session\n\n## Tasks\n${tasks}\n`);
  writeConfig(opts);
}

/** Write a transcript whose FINAL assistant turn carries `finalText`; optional earlier turns. */
function writeTranscript(finalText: string, earlierTurns: string[] = []): string {
  const p = path.join(tmp, 'transcript.jsonl');
  const lines = [...earlierTurns, finalText].map((t) =>
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: t }] } }));
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function statePresent() { return fs.existsSync(path.join(tmp, '.instar', 'autonomous-state.local.md')); }
function hardBlockerLog(): string {
  const p = path.join(tmp, 'logs', 'autonomous-hard-blocker.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
function attentionRecord(): string {
  const p = path.join(tmp, 'attention-record.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function runHook(finalText: string, env: Record<string, string> = {}, earlierTurns: string[] = []): { decision: string | null; exit: number; stdout: string } {
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    INSTAR_HOOK_NO_TMUX: '1',
    INSTAR_HOOK_TMUX_SESSION: '',
    INSTAR_HOOK_BACKOFF_DISABLE: '1',
    INSTAR_HOOK_ATTENTION_RECORD: path.join(tmp, 'attention-record.jsonl'),
    ...env,
  };
  let stdout = ''; let exit = 0;
  try {
    stdout = execFileSync('bash', [HOOK], {
      cwd: tmp,
      input: JSON.stringify({ session_id: UUID, transcript_path: writeTranscript(finalText, earlierTurns) }),
      env: baseEnv, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) { exit = e.status ?? 1; stdout = e.stdout?.toString() ?? ''; }
  let decision: string | null = null;
  try { decision = JSON.parse(stdout.trim()).decision ?? null; } catch { /* allow-exit */ }
  return { decision, exit, stdout };
}

const NONCE = 'abc123def456';
function marker(tried = 'ran tsc, pulled the vault', stuck = 'the third-party API key does not exist', needed = 'a credential that does not exist yet', nonce = NONCE): string {
  return `<hard-blocker nonce="${nonce}">\n  what I tried: ${tried}\n  why I am stuck: ${stuck}\n  what I would need to proceed: ${needed}\n</hard-blocker>`;
}

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-cd-')); fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true }); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('checkbox 3-state scan + corruption fail-safe', () => {
  it('all-checked task list does NOT block on a met condition (judge fires)', () => {
    writeState({ condition: 'done', tasks: '- [x] task one\n- [x] task two' });
    const r = runHook('all tasks complete', { INSTAR_HOOK_EVAL_OVERRIDE: 'met' });
    expect(r.decision).not.toBe('block');
    expect(statePresent()).toBe(false);
  });

  it('some-unchecked blocks (work remains) even when the agent asserts done', () => {
    writeState({ condition: 'done', tasks: '- [x] task one\n- [ ] task two' });
    // No eval override → CD gates the judge: unchecked>0 AND no completion assertion
    // means the judge never fires; the cheap scan continues.
    const r = runHook('still working on task two');
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
  });

  it('corrupt state file (bad iteration) → corruption fail-safe WINS (rm + exit 0)', () => {
    // Bad iteration value — the corruption path fires before any CD block.
    fs.writeFileSync(path.join(tmp, '.instar', 'autonomous-state.local.md'),
      `---\nactive: true\niteration: NOTANUMBER\nsession_id: "${UUID}"\nduration_seconds: 0\nstarted_at: "2026-06-09T00:00:00Z"\nreport_topic: "9984"\ncompletion_condition: "x"\nhard_blocker_nonce: "${NONCE}"\n---\n\nno checkboxes here\n`);
    writeConfig({});
    const r = runHook('whatever');
    expect(r.exit).toBe(0);
    expect(r.decision).not.toBe('block');
    expect(statePresent()).toBe(false); // corruption fail-safe removed it
  });
});

describe('(a) hard-blocker marker branch', () => {
  it('a nonce-valid marker classified EXTERNAL → exit + JSONL row + attention item', () => {
    writeState({ condition: 'done', nonce: NONCE });
    const r = runHook(marker(), { INSTAR_HOOK_P13_OVERRIDE: 'external' });
    expect(r.exit).toBe(0);
    expect(r.decision).not.toBe('block');
    expect(statePresent()).toBe(false);
    const row = hardBlockerLog();
    expect(row).toContain('"needed"');
    expect(row).toContain('"completionConditionMet":false');
    expect(attentionRecord()).toContain('autonomous-hard-blocker');
  });

  it('a nonce-valid marker classified BUILDABLE → continue (no exit, no row)', () => {
    writeState({ condition: 'done', nonce: NONCE });
    const r = runHook(marker('nothing', 'I need a coding standard', 'a derivable standard'), { INSTAR_HOOK_P13_OVERRIDE: 'buildable' });
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
    expect(hardBlockerLog()).toBe('');
  });

  it('a NONCE-MISMATCHED marker is ignored → continue', () => {
    writeState({ condition: 'done', nonce: NONCE });
    const r = runHook(marker('x', 'y', 'z', 'WRONGNONCE'), { INSTAR_HOOK_P13_OVERRIDE: 'external' });
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
    expect(hardBlockerLog()).toBe('');
  });

  it('a TEMPLATE-VERBATIM marker (literal ... placeholders) is ignored → continue', () => {
    writeState({ condition: 'done', nonce: NONCE });
    const tmpl = `<hard-blocker nonce="${NONCE}">\n  what I tried: ...\n  why I am stuck: ...\n  what I would need to proceed: ...\n</hard-blocker>`;
    const r = runHook(tmpl, { INSTAR_HOOK_P13_OVERRIDE: 'external' });
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
  });

  it('a FENCED marker (inside ```) is ignored → continue', () => {
    writeState({ condition: 'done', nonce: NONCE });
    const fenced = '```\n' + marker() + '\n```';
    const r = runHook(fenced, { INSTAR_HOOK_P13_OVERRIDE: 'external' });
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
  });

  it('a marker NOT in the final turn is ignored (only the final turn counts)', () => {
    writeState({ condition: 'done', nonce: NONCE });
    // marker in an EARLIER turn, benign final turn
    const r = runHook('still working', { INSTAR_HOOK_P13_OVERRIDE: 'external' }, [marker()]);
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
  });

  it('contradictory terminal markers (hard-blocker + promise) → continue with a steer', () => {
    writeState({ promise: 'ALL_DONE', nonce: NONCE });
    const both = marker() + '\n<promise>ALL_DONE</promise>';
    const r = runHook(both, { INSTAR_HOOK_P13_OVERRIDE: 'external' });
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
    expect(r.stdout).toMatch(/contradictory terminal markers/i);
  });

  it('a planted credential in a marker field is REDACTED in the JSONL row', () => {
    writeState({ condition: 'done', nonce: NONCE });
    const leaky = marker('used key sk-abcdefABCDEF0123456789xyz to call the API', 'auth failed', 'a working credential I cannot obtain');
    const r = runHook(leaky, { INSTAR_HOOK_P13_OVERRIDE: 'external' });
    expect(r.exit).toBe(0);
    const row = hardBlockerLog();
    expect(row).toContain('[redacted: possible secret]');
    expect(row).toContain('"leakRedacted":true');
    expect(row).not.toContain('sk-abcdefABCDEF0123456789xyz');
  });
});

describe('off-switch reverts behavior', () => {
  it('with completionDiscipline.enabled:false, a nonce-valid marker does NOT exit (no (a) branch)', () => {
    writeState({ condition: 'done', nonce: NONCE, cdEnabled: false });
    // not-met override so the condition path keeps working; the marker branch is OFF.
    const r = runHook(marker(), { INSTAR_HOOK_P13_OVERRIDE: 'external', INSTAR_HOOK_EVAL_OVERRIDE: 'not-met' });
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
    expect(hardBlockerLog()).toBe('');
  });
});

describe('emergency + duration still win (untouched by CD)', () => {
  it('emergency stop exits regardless of a pending marker', () => {
    writeState({ condition: 'done', nonce: NONCE });
    fs.writeFileSync(path.join(tmp, '.instar', 'autonomous-emergency-stop'), 'stop\n');
    const r = runHook(marker(), { INSTAR_HOOK_P13_OVERRIDE: 'buildable' });
    expect(r.exit).toBe(0);
    expect(statePresent()).toBe(false);
  });

  it('duration expiry exits regardless of CD state', () => {
    const past = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    writeState({ condition: 'done', nonce: NONCE, durationSeconds: 10, startedAt: past });
    const r = runHook('whatever', { INSTAR_HOOK_P13_OVERRIDE: 'buildable' });
    expect(r.exit).toBe(0);
    expect(statePresent()).toBe(false);
  });
});

// ── Version-skew three-case detection on the (a) path ──
// NOTE: the live curl path cannot be exercised in this sandbox (localhost curl from
// the Bash tool is blocked — verified rc 28 even to an in-process 127.0.0.1 server).
// The three-case BRANCH LOGIC is exercised via the INSTAR_HOOK_P13_OVERRIDE seam,
// which simulates each P13 response shape (old-server | external | timeout) WITHOUT a
// network call. The route side of the protocol stamp is covered by the integration
// test (autonomous-evaluate-stop-signals.test.ts) which asserts p13ProtocolVersion is
// present on block/allow/503/500.
describe('version-skew three-case detection on the (a) path (seam-driven)', () => {
  it('Case 1 — OLD server (no p13ProtocolVersion) → continue, NO (a) exit', () => {
    writeState({ condition: 'done', nonce: NONCE });
    const r = runHook(marker(), { INSTAR_HOOK_P13_OVERRIDE: 'old-server' });
    expect(r.decision).toBe('block'); // safe-continue
    expect(statePresent()).toBe(true);
    expect(hardBlockerLog()).toBe('');
  });

  it('Case 2 — NEW server, classifiedBlocker:external + allowed → (a) exit', () => {
    writeState({ condition: 'done', nonce: NONCE });
    const r = runHook(marker(), { INSTAR_HOOK_P13_OVERRIDE: 'external' });
    expect(r.exit).toBe(0);
    expect(statePresent()).toBe(false);
    expect(hardBlockerLog()).toContain('"needed"');
  });

  it('Case 3 — NEW server but no usable verdict (proto present, no classifiedBlocker) → evaluator-unreachable row + continue', () => {
    writeState({ condition: 'done', nonce: NONCE });
    const r = runHook(marker(), { INSTAR_HOOK_P13_OVERRIDE: 'timeout' });
    expect(r.decision).toBe('block'); // continue, NOT a permanent old-server block
    expect(statePresent()).toBe(true);
    expect(hardBlockerLog()).toContain('evaluator-unreachable-exit');
  });
});

describe('fail-open record-and-continue on the condition path (judge unreachable)', () => {
  it('condition set, judge unreachable, work might be done (all checked) → writes evaluator-unreachable row + continues', () => {
    // No server running on the configured port → the completion curl fails. With all
    // boxes checked the judge WOULD fire (might-be-done), so the unreachable path runs.
    writeState({ condition: 'done', tasks: '- [x] one\n- [x] two', port: 59999 });
    const r = runHook('all tasks complete — believe me');
    expect(r.decision).toBe('block'); // never a silent exit
    expect(statePresent()).toBe(true);
    expect(hardBlockerLog()).toContain('evaluator-unreachable-exit');
  });
});

describe('milestone scan over the tail-6 window (signal-only, never blocks alone)', () => {
  it('a milestone phrase in an EARLIER tail-6 turn is still in scope (no crash; continues)', () => {
    writeState({ condition: 'done', tasks: '- [ ] one', port: 59999 });
    // milestone phrase earlier; benign final turn. unchecked>0 → judge never fires → continue.
    const r = runHook('working', {}, ['this is a clean milestone, I will stop here']);
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
  });
});

describe('circuit-breaker — K consecutive judge failures → cheap checkbox-only continue', () => {
  it('with the breaker tripped (judgeFailures>=3 in window), an all-checked might-be-done iteration continues WITHOUT a judge call', () => {
    // all-checked → normally the judge fires; but with the breaker OPEN it must NOT
    // call the judge and must continue (never a fail-open exit on the cheap path).
    writeState({ condition: 'done', tasks: '- [x] one\n- [x] two', port: 59999 });
    // Seed the breaker sidecar: 3 failures, window just started.
    const nowS = Math.floor(Date.now() / 1000);
    fs.writeFileSync(path.join(tmp, '.instar', 'autonomous-state.local.backoff.json'),
      JSON.stringify({ judgeFailures: 3, judgeFailWindowStart: nowS }));
    const r = runHook('all tasks complete');
    expect(r.decision).toBe('block'); // continue, no fail-open exit
    expect(statePresent()).toBe(true);
    // The breaker short-circuit emits its log line + does NOT write an unreachable row.
    expect(r.stdout).not.toContain('evaluator-unreachable'); // stdout is the block JSON
  });
});

describe('backward-compat — an in-flight OLD state file (no nonce) degrades safely', () => {
  it('a state file with no hard_blocker_nonce: a <hard-blocker> marker can NEVER trip an exit', () => {
    // Old state files (written before this feature) carry no hard_blocker_nonce.
    writeState({ condition: 'done', nonce: '' }); // empty nonce
    const r = runHook(marker(), { INSTAR_HOOK_P13_OVERRIDE: 'external', INSTAR_HOOK_EVAL_OVERRIDE: 'not-met' });
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
    expect(hardBlockerLog()).toBe('');
  });

  it('legacy promise path still works unchanged (blocks until the promise token appears)', () => {
    writeState({ promise: 'ALL_DONE', nonce: NONCE });
    const r = runHook('still working, no promise yet');
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
  });

  it('legacy promise exit still fires when the token appears (P13 allows)', () => {
    writeState({ promise: 'ALL_DONE', nonce: NONCE });
    const r = runHook('<promise>ALL_DONE</promise>', { INSTAR_HOOK_P13_OVERRIDE: 'ok' });
    expect(r.exit).toBe(0);
    expect(statePresent()).toBe(false);
  });
});
