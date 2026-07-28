// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
/**
 * Autonomous stop hook — Scope-Accretion Completion Discipline (Tier 1, hook as
 * a subprocess). Spec: autonomous-scope-accretion-completion.md §2.7 Layer B +
 * R40/R44 run-end + R35 identity echo.
 *
 * Exercises the SHIPPED hook (not a copy) via execFileSync, mirroring
 * autonomous-stop-hook-realcheck.test.ts. The Layer B scan is fed byte-for-byte
 * captured REAL agent-authored prose (tests/fixtures/captured/
 * scope-accretion-transcript-tail); the judge/run-end network calls are driven
 * by the INSTAR_HOOK_* seams (no live server).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCapturedFixture } from '../helpers/loadCapturedFixture.js';

const HOOK = path.join(process.cwd(), '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');
const UUID = '04db2de7-8e82-4baf-9136-7a067bb2ec53';
let tmp: string;

interface StateOpts {
  condition?: string;
  durationSeconds?: number;
  startedAt?: string;
  runId?: string;
  saEnabled?: boolean;
  tasks?: string;
}

function writeConfig(opts: StateOpts) {
  const cd: Record<string, unknown> = { enabled: true, judgeTimeoutMs: 5000 };
  if (opts.saEnabled !== undefined) cd.scopeAccretion = { enabled: opts.saEnabled };
  fs.writeFileSync(
    path.join(tmp, '.instar', 'config.json'),
    JSON.stringify({ port: 4040, authToken: 'test-auth-token-value', autonomousSessions: { completionDiscipline: cd } }),
  );
}

function writeState(opts: StateOpts = {}) {
  const started = opts.startedAt ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const tasks = opts.tasks ?? '- [x] task one';
  let fm = `---\nactive: true\niteration: 2\nsession_id: "${UUID}"\nduration_seconds: ${opts.durationSeconds ?? 0}\nstarted_at: "${started}"\nreport_topic: "9984"\ncompletion_promise: ""\ncompletion_condition: "${opts.condition ?? 'the work is verifiably done'}"\nhard_blocker_nonce: "abc123def456"\n`;
  if (opts.runId !== undefined) fm += `run_id: "${opts.runId}"\n`;
  fm += `work_dir: "${tmp}"\n`;
  fs.writeFileSync(
    path.join(tmp, '.instar', 'autonomous-state.local.md'),
    `${fm}---\n\n# Autonomous Session\n\n## Tasks\n${tasks}\n`,
  );
  writeConfig(opts);
}

function writeTranscript(turns: string[]): string {
  const p = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(
    p,
    turns.map((t) => JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: t }] } })).join('\n') + '\n',
  );
  return p;
}

function runHook(turns: string[], env: Record<string, string> = {}): { exit: number; stdout: string } {
  let stdout = '';
  let exit = 0;
  try {
    stdout = execFileSync('bash', [HOOK], {
      cwd: tmp,
      input: JSON.stringify({ session_id: UUID, transcript_path: writeTranscript(turns) }),
      env: {
        ...process.env,
        INSTAR_HOOK_NO_TMUX: '1',
        INSTAR_HOOK_TMUX_SESSION: '',
        INSTAR_HOOK_BACKOFF_DISABLE: '1',
        INSTAR_HOOK_ATTENTION_RECORD: path.join(tmp, 'attention-record.jsonl'),
        INSTAR_HOOK_RUNEND_RECORD: path.join(tmp, 'runend-record.jsonl'),
        INSTAR_HOOK_SIGNALS_RECORD: path.join(tmp, 'signals-record.jsonl'),
        ...env,
      },
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: { toString(): string } };
    exit = err.status ?? 1;
    stdout = err.stdout?.toString() ?? '';
  }
  return { exit, stdout };
}

function signalsRows(): Array<{ signals: Record<string, unknown>; topicId: string; runId: string }> {
  const p = path.join(tmp, 'signals-record.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runendRows(): Array<{ topic: string; reason: string; runId: string }> {
  const p = path.join(tmp, 'runend-record.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Drive the hook's REAL Layer B scan over a judge-tail text and return the
 * scopeAccretionSuspected boolean it computed (via the signals-record seam).
 * This is the registered-parser entry point for the captured-fixture lint.
 */
function runLayerBScan(tailText: string): boolean {
  writeState({ tasks: '- [ ] still working' }); // keep-working path — no judge fire needed
  const { exit } = runHook([tailText], { INSTAR_HOOK_EVAL_OVERRIDE: 'not-met' });
  expect(exit).toBe(0);
  const rows = signalsRows();
  expect(rows.length).toBeGreaterThan(0);
  return rows.at(-1)!.signals.scopeAccretionSuspected === true;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sa-hook-'));
  fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Layer B evasion-vocabulary scan (§2.7 — advisory, fenced/quoted-excluded)', () => {
  it('flags the REAL incident prose and stays silent on the REAL fenced clean tail', () => {
    const incident = loadCapturedFixture('scope-accretion-transcript-tail', 'incident-acknowledgment-prose');
    expect(runLayerBScan(incident)).toBe(true);

    fs.rmSync(path.join(tmp, 'signals-record.jsonl'), { force: true });
    const clean = loadCapturedFixture('scope-accretion-transcript-tail', 'tail-clean-fenced');
    expect(runLayerBScan(clean)).toBe(false);
  });

  it('vocabulary INSIDE a fenced code block does not fire (the NEW exclusion logic)', () => {
    expect(runLayerBScan('Progress update.\n```\nthe documented stretch (out of completion condition)\n```\nStill building the feature now.')).toBe(false);
  });

  it('vocabulary on a >-quoted line does not fire', () => {
    expect(runLayerBScan('The rule says:\n> never label work "filed for a future session"\nand I am building it now.')).toBe(false);
  });

  it('vocabulary in plain prose DOES fire', () => {
    expect(runLayerBScan('The remaining implementation is the documented stretch — I will file it for later.')).toBe(true);
  });

  it('scopeAccretion disabled → the field is OMITTED from signals entirely (byte-identity)', () => {
    writeState({ saEnabled: false, tasks: '- [ ] still working' });
    runHook(['the documented stretch remains'], { INSTAR_HOOK_EVAL_OVERRIDE: 'not-met' });
    const rows = signalsRows();
    expect(rows.length).toBeGreaterThan(0);
    expect('scopeAccretionSuspected' in rows.at(-1)!.signals).toBe(false);
  });
});

describe('identity echo (R35/R36 — the server arms against its OWN registration record)', () => {
  it('echoes topicId + runId from the state-file frontmatter into the judge payload fields', () => {
    writeState({ runId: 'run-abc-123', tasks: '- [ ] one open' });
    runHook(['keep going'], { INSTAR_HOOK_EVAL_OVERRIDE: 'not-met' });
    const row = signalsRows().at(-1)!;
    expect(row.topicId).toBe('9984');
    expect(row.runId).toBe('run-abc-123');
  });

  it('an unregistered run (no run_id) echoes an empty runId — the server degrades honestly', () => {
    writeState({ tasks: '- [ ] one open' });
    runHook(['keep going'], { INSTAR_HOOK_EVAL_OVERRIDE: 'not-met' });
    expect(signalsRows().at(-1)!.runId).toBe('');
  });
});

describe('run-end reporting on EVERY exit surface (R40/R44 — no silent exit)', () => {
  it('duration expiry fires run-end', () => {
    writeState({ durationSeconds: 60, startedAt: '2026-01-01T00:00:00Z', runId: 'run-x' });
    const { exit } = runHook(['still going']);
    expect(exit).toBe(0);
    expect(runendRows().at(-1)).toMatchObject({ topic: '9984', reason: 'duration-expiry', runId: 'run-x' });
  });

  it('emergency stop fires run-end IDENTICALLY (the one-step bypass is as loud as the two-step, §6)', () => {
    writeState({ runId: 'run-x' });
    fs.writeFileSync(path.join(tmp, '.instar', 'autonomous-emergency-stop'), '');
    const { exit } = runHook(['anything']);
    expect(exit).toBe(0);
    expect(runendRows().at(-1)).toMatchObject({ reason: 'emergency-stop' });
  });

  it('a met exit fires run-end', () => {
    writeState({ runId: 'run-x', tasks: '- [x] all done' });
    const { exit } = runHook(['all tasks complete — condition met'], { INSTAR_HOOK_EVAL_OVERRIDE: 'met' });
    expect(exit).toBe(0);
    expect(runendRows().at(-1)).toMatchObject({ reason: 'met', runId: 'run-x' });
    // Terminal — state removed.
    expect(fs.existsSync(path.join(tmp, '.instar', 'autonomous-state.local.md'))).toBe(false);
  });

  it('a state-corrupt exit fires run-end', () => {
    writeState({ runId: 'run-x' });
    // Corrupt the iteration field.
    const f = path.join(tmp, '.instar', 'autonomous-state.local.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^iteration: 2$/m, 'iteration: banana'));
    const { exit } = runHook(['anything']);
    expect(exit).toBe(0);
    expect(runendRows().at(-1)!.reason).toContain('state-corrupt');
  });

  it('the ordinary keep-working iteration does NOT fire run-end', () => {
    writeState({ runId: 'run-x', tasks: '- [ ] open task' });
    runHook(['keep going'], { INSTAR_HOOK_EVAL_OVERRIDE: 'not-met' });
    expect(runendRows()).toHaveLength(0);
  });
});
