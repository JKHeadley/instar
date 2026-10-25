// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * ReapLog — notify outcome records + mid-work fields (reap-notify spec R1.3/R2.1).
 *
 * The normalizer is the trap under test: it whitelists types and fields on
 * read, so any new type/field MUST pass through it or the records silently
 * vanish — exactly the failure the spec calls out ("the new type and fields
 * MUST be added to the normalizer or they vanish on read").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReapLog } from '../../src/monitoring/ReapLog.js';

let tmpDir: string;
let stateDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-log-test-'));
  stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('ReapLog — reaped entries with mid-work evidence (R2.1)', () => {
  it('round-trips midWork + workEvidence through append → read', () => {
    const log = new ReapLog(stateDir);
    log.recordReaped({
      session: 'topic-builder',
      tmuxSession: 'instar-topic-42',
      reason: 'quota-shed',
      origin: 'autonomous',
      midWork: true,
      workEvidence: ['build-or-autonomous-active', 'open-commitment'],
    });
    const entries = log.read();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('reaped');
    expect(entries[0].midWork).toBe(true);
    expect(entries[0].workEvidence).toEqual(['build-or-autonomous-active', 'open-commitment']);
  });

  it('omits midWork/workEvidence when not supplied (legacy writers unchanged)', () => {
    const log = new ReapLog(stateDir);
    log.recordReaped({
      session: 's',
      tmuxSession: 't',
      reason: 'age-limit',
    });
    const [entry] = log.read();
    expect(entry.midWork).toBeUndefined();
    expect(entry.workEvidence).toBeUndefined();
  });

  it('preserves launchLane on read (the normalizer previously stripped it)', () => {
    const log = new ReapLog(stateDir);
    log.recordReaped({
      session: 's',
      tmuxSession: 't',
      reason: 'age-limit',
      launchLane: 'rerouted-interactive',
    });
    expect(log.read()[0].launchLane).toBe('rerouted-interactive');
  });

  it('preserves the admitting authority scope and rejects unknown values', () => {
    const log = new ReapLog(stateDir, () => 'machine-under-test');
    log.recordReaped({
      session: 'local-expired',
      tmuxSession: 'tmux-local-expired',
      reason: 'age-limit',
      authorityScope: 'local-age-limit',
    });
    expect(log.read()[0]).toMatchObject({
      machine: 'machine-under-test',
      authorityScope: 'local-age-limit',
    });

    fs.appendFileSync(
      path.join(tmpDir, 'logs', 'reap-log.jsonl'),
      JSON.stringify({
        type: 'reaped',
        session: 'bad',
        authorityScope: 'remote-anything',
        origin: 'forged-operator',
      }) + '\n',
    );
    expect(log.read().at(-1)).toMatchObject({ session: 'bad' });
    expect(log.read().at(-1)?.authorityScope).toBeUndefined();
    expect(log.read().at(-1)?.origin).toBeUndefined();
  });
});

describe('ReapLog — notify outcome record pairs (R1.3)', () => {
  it('appends enqueued → terminal as separate records; latest per noticeId wins', () => {
    const log = new ReapLog(stateDir);
    log.recordNotify({ noticeId: 'n-1', topicId: 42, outcome: 'enqueued' });
    log.recordNotify({ noticeId: 'n-1', topicId: 42, outcome: 'sent' });
    const entries = log.read().filter((e) => e.type === 'notify');
    expect(entries).toHaveLength(2);
    expect(entries[0].outcome).toBe('enqueued');
    expect(entries[1].outcome).toBe('sent');
    expect(entries[1].disposition).toBe('notify:sent');
    // Latest-wins semantics: the consumer's view of n-1 is the last record.
    const latest = new Map(entries.map((e) => [e.noticeId, e]));
    expect(latest.get('n-1')!.outcome).toBe('sent');
  });

  it('records every terminal outcome class, including enqueue-failed fallback', () => {
    const log = new ReapLog(stateDir);
    for (const outcome of ['send-failed-escalated', 'no-topic', 'enqueue-failed'] as const) {
      log.recordNotify({ noticeId: `n-${outcome}`, topicId: null, outcome, detail: `why: ${outcome}` });
    }
    const entries = log.read().filter((e) => e.type === 'notify');
    expect(entries.map((e) => e.outcome)).toEqual([
      'send-failed-escalated',
      'no-topic',
      'enqueue-failed',
    ]);
    // topicId omitted for lifeline-only/no-topic records.
    expect(entries[1].topicId).toBeUndefined();
    expect(entries[0].reason).toContain('send-failed-escalated');
  });
});

describe('ReapLog — normalizer both sides', () => {
  const logPath = () => path.join(tmpDir, 'logs', 'reap-log.jsonl');

  it("passes 'notify' through the type whitelist (does NOT coerce to 'reaped')", () => {
    const log = new ReapLog(stateDir);
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(
      logPath(),
      JSON.stringify({ ts: 'x', type: 'notify', noticeId: 'n9', topicId: 7, outcome: 'sent' }) + '\n',
    );
    const [entry] = log.read();
    expect(entry.type).toBe('notify');
    expect(entry.noticeId).toBe('n9');
    expect(entry.topicId).toBe(7);
    expect(entry.outcome).toBe('sent');
    expect(entry.disposition).toBe('notify:sent');
  });

  it('still coerces a genuinely unknown type to reaped (legacy behavior intact)', () => {
    const log = new ReapLog(stateDir);
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), JSON.stringify({ type: 'banana', session: 's' }) + '\n');
    expect(log.read()[0].type).toBe('reaped');
  });

  it('drops an unknown outcome and non-string evidence values (field whitelist holds)', () => {
    const log = new ReapLog(stateDir);
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(
      logPath(),
      JSON.stringify({
        type: 'notify',
        noticeId: 'n10',
        outcome: 'totally-made-up',
      }) + '\n',
    );
    fs.appendFileSync(
      logPath(),
      JSON.stringify({
        type: 'reaped',
        session: 's',
        tmuxSession: 't',
        reason: 'r',
        midWork: true,
        workEvidence: ['ok-string', 42, null, { evil: true }],
      }) + '\n',
    );
    const entries = log.read();
    expect(entries[0].outcome).toBeUndefined();
    expect(entries[0].disposition).toBe('notify:unknown');
    expect(entries[1].workEvidence).toEqual(['ok-string']);
    expect(entries[1].midWork).toBe(true);
  });

  it('drops a non-boolean midWork (no truthy coercion through the whitelist)', () => {
    const log = new ReapLog(stateDir);
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(
      logPath(),
      JSON.stringify({ type: 'reaped', session: 's', tmuxSession: 't', reason: 'r', midWork: 'yes' }) + '\n',
    );
    expect(log.read()[0].midWork).toBeUndefined();
  });
});

/**
 * Reaper self-inflicted log-flood fix (2026-07-03): a permanently-vetoed
 * session (open-commitment, not-lease-holder) is re-evaluated every reaper tick
 * and used to emit an identical `skipped` row each time — 5k+ repeat rows on a
 * live agent ⇒ a 142MB log that froze the event loop when read whole. The fix
 * is log-on-transition + a bounded tail read + a size cap.
 */
describe('ReapLog — skip flood: log on transition, not every tick', () => {
  const skip = (session: string, skipped: string, reason = 'age-limit') => ({
    session,
    tmuxSession: `tmux-${session}`,
    reason,
    skipped,
  });

  it('does NOT re-append an identical skip for the same session', () => {
    const log = new ReapLog(stateDir);
    for (let i = 0; i < 50; i++) log.recordSkipped(skip('tas-1', 'open-commitment'));
    const rows = log.read().filter((r) => r.type === 'skipped');
    expect(rows).toHaveLength(1);
    expect(rows[0].skipped).toBe('open-commitment');
  });

  it('appends a new row when the skip REASON transitions', () => {
    const log = new ReapLog(stateDir);
    log.recordSkipped(skip('tas-1', 'open-commitment'));
    log.recordSkipped(skip('tas-1', 'open-commitment'));
    log.recordSkipped(skip('tas-1', 'not-lease-holder')); // transition
    log.recordSkipped(skip('tas-1', 'not-lease-holder'));
    const rows = log.read().filter((r) => r.type === 'skipped');
    expect(rows.map((r) => r.skipped)).toEqual(['open-commitment', 'not-lease-holder']);
  });

  it('keeps per-session dedup independent (two sessions, same reason, one row each)', () => {
    const log = new ReapLog(stateDir);
    log.recordSkipped(skip('tas-1', 'protected'));
    log.recordSkipped(skip('tas-2', 'protected'));
    log.recordSkipped(skip('tas-1', 'protected'));
    log.recordSkipped(skip('tas-2', 'protected'));
    const rows = log.read().filter((r) => r.type === 'skipped');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.session).sort()).toEqual(['tas-1', 'tas-2']);
  });

  it('re-logs a skip after the session is reaped (state forgotten on reap)', () => {
    const log = new ReapLog(stateDir);
    log.recordSkipped(skip('tas-1', 'open-commitment'));
    log.recordSkipped(skip('tas-1', 'open-commitment')); // deduped
    log.recordReaped({ session: 'tas-1', tmuxSession: 'tmux-tas-1', reason: 'age-limit' });
    log.recordSkipped(skip('tas-1', 'open-commitment')); // fresh — logs again
    const skipRows = log.read().filter((r) => r.type === 'skipped');
    const reapRows = log.read().filter((r) => r.type === 'reaped');
    expect(skipRows).toHaveLength(2);
    expect(reapRows).toHaveLength(1);
  });
});

describe('ReapLog — bounded read + rotation (can never be slurped/grow unbounded)', () => {
  it('read(limit) returns the last `limit` rows via a bounded tail read', () => {
    const log = new ReapLog(stateDir);
    for (let i = 0; i < 500; i++) {
      log.recordReaped({ session: `s-${i}`, tmuxSession: `t-${i}`, reason: 'age-limit' });
    }
    const rows = log.read(10);
    expect(rows).toHaveLength(10);
    expect(rows[9].session).toBe('s-499');
    expect(rows[0].session).toBe('s-490');
  });

  it('rotates to <path>.1 past the size cap and read() merges across the boundary', () => {
    const p = path.join(tmpDir, 'logs', 'reap-log.jsonl');
    // Tiny cap forces rotation after a few hundred bytes.
    const log = new ReapLog(stateDir, undefined, { maxLogBytes: 400 });
    for (let i = 0; i < 40; i++) {
      log.recordReaped({ session: `s-${i}`, tmuxSession: `t-${i}`, reason: 'age-limit' });
    }
    expect(fs.existsSync(`${p}.1`)).toBe(true);
    // Newest rows survive; read merges the rotated tail to reach older ones.
    const rows = log.read(20);
    expect(rows[rows.length - 1].session).toBe('s-39');
    expect(rows.length).toBeGreaterThan(1);
    // The live file alone is bounded well under a full 40-row file.
    expect(fs.statSync(p).size).toBeLessThan(1000);
  });

  it('does not cross a byte-window gap into an older rotated generation', () => {
    const p = path.join(tmpDir, 'logs', 'reap-log.jsonl');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const row = (session: string, padding = '') => JSON.stringify({
      ts: '2026-01-01T00:00:00.000Z',
      type: 'reaped',
      session,
      tmuxSession: `t-${session}`,
      reason: 'age-limit',
      padding,
    }) + '\n';
    fs.writeFileSync(`${p}.1`, row('s1') + row('s2') + row('s3'));
    fs.writeFileSync(p, row('s4', 'x'.repeat(500)) + row('s5', 'x'.repeat(500)) + row('s6', 'x'.repeat(500)));

    const page = new ReapLog(stateDir, undefined, { tailReadBytes: 750 }).readPage(3);

    expect(page.entries.map((entry) => entry.session)).toEqual(['s6']);
    expect(page).toMatchObject({ returned: 1, truncated: true });
  });

  it('does not choke on an absent log (empty read)', () => {
    const log = new ReapLog(stateDir);
    expect(log.read()).toEqual([]);
  });
});

describe("ReapLog.recordExited — a session that ended on its own leaves a trace", () => {
  let dir: string;
  let log: ReapLog;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-log-exited-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    log = new ReapLog(path.join(dir, 'state'), () => 'm_test');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips type 'exited' + uptime + framework + tail — the normalizer must not coerce it to 'reaped'", () => {
    // 2026-08-22: every interactive codex death was a reason-less `completed`
    // record and NO reap-log row. This row is what makes the death debuggable
    // from the records. The read-side whitelist previously coerced every
    // unknown type to 'reaped' — a row that survives append but comes back as
    // a 'reaped' row would mis-attribute a self-exit to a kill.
    log.recordExited({
      session: 'Observer 2',
      tmuxSession: 'echo-observer-2',
      reason: 'process-exited-during-startup',
      framework: 'codex-cli',
      uptimeSeconds: 18.66,
      exitCode: 0,
      midWork: false,
      outcome: 'completed',
      lastTail: [
        '  Update available! 0.147.0 -> 0.149.0',
        '› 1. Update now (runs `npm install -g @openai/codex`)',
        '  2. Skip',
        '  Press enter to continue',
      ].join('\n'),
    });
    const [row] = log.read();
    expect(row.type).toBe('exited');
    expect(row.disposition).toBe('terminal');
    expect(row.reason).toBe('process-exited-during-startup');
    expect(row.framework).toBe('codex-cli');
    expect(row.uptimeSeconds).toBe(19); // rounded, finite
    expect(row.machine).toBe('m_test');
    expect(row).toMatchObject({ exitCode: 0, midWork: false, outcome: 'completed' });
    expect(row.lastTail).toContain('Update now');
    expect(row.lastTailRedactions).toBe(0);
  });

  it('REDACTS credential-shaped material in the tail through the live-tail scrubber, and records that it did', () => {
    // The tail is pane CONTENT — the one field here that can carry a secret.
    // It goes through the SAME redactor the dashboard live-tail uses, INSIDE
    // recordExited, so no caller can write a raw secret into this log.
    log.recordExited({
      session: 's',
      tmuxSession: 't',
      reason: 'process-exited',
      outcome: 'completed',
      lastTail: 'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\nAuthorization: Bearer eyJabcdefghijklmnop.qrstuvwxyz012345.ABCDEFGHIJKLMNOP\n› done',
    });
    const [row] = log.read();
    expect(row.lastTail).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(row.lastTail).not.toContain('eyJabcdefghijklmnop');
    expect(row.lastTail).toContain('› done');
    expect((row.lastTailRedactions ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it('CLAMPS the tail — a pane dump can never inflate this log (Bounded Accumulation)', () => {
    const huge = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(80)}`).join('\n');
    log.recordExited({ session: 's', tmuxSession: 't', reason: 'process-exited', outcome: 'completed', lastTail: huge });
    const [row] = log.read();
    expect(row.lastTail!.length).toBeLessThanOrEqual(1500);
    expect(row.lastTail!.split('\n').length).toBeLessThanOrEqual(12);
    // Keeps the END of the pane (where the menu / error / prompt is), not the start.
    expect(row.lastTail).toContain('line 399');
  });

  it('omits the tail fields entirely when no sample was available — absence is honest, not an empty string', () => {
    log.recordExited({ session: 's', tmuxSession: 't', reason: 'process-exited', outcome: 'completed', uptimeSeconds: 3600 });
    const [row] = log.read();
    expect(row.lastTail).toBeUndefined();
    expect(row.lastTailRedactions).toBeUndefined();
    expect(row.uptimeSeconds).toBe(3600);
  });

  it("an 'exited' row is distinct from a 'reaped' row in the same log — the reader can tell a self-exit from a kill", () => {
    log.recordReaped({ session: 'a', tmuxSession: 'a', reason: 'idle-zombie' });
    log.recordExited({ session: 'b', tmuxSession: 'b', reason: 'process-exited', outcome: 'completed' });
    const types = log.read().map((r) => r.type);
    expect(types).toEqual(['reaped', 'exited']);
  });

  it('round-trips contrasting finished and stopped-mid-work rows', () => {
    log.recordExited({
      session: 'finished', tmuxSession: 'finished', reason: 'process-exited',
      exitCode: 0, midWork: false, outcome: 'completed',
    });
    log.recordExited({
      session: 'killed', tmuxSession: 'killed', reason: 'process-exited',
      exitCode: -1, midWork: true, outcome: 'stopped-mid-work',
    });
    expect(log.read()).toMatchObject([
      { session: 'finished', exitCode: 0, midWork: false, outcome: 'completed' },
      { session: 'killed', exitCode: -1, midWork: true, outcome: 'stopped-mid-work' },
    ]);
  });
});
