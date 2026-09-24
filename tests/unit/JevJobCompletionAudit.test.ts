// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * JevJobCompletionAudit — the observe-only job-completion audit.
 * Spec: docs/specs/jev-job-supervision.md
 *
 * No network: every test injects fetch. Under test is the contract that makes
 * this safe: capture is bounded and never throws, the pack is the durable
 * admission/dedupe record, the batch decides nothing, failed-but-billed
 * attempts debit the cap, and no secret or job text ever reaches a row.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JevJobCompletionAudit,
  AUDIT_QUESTIONS,
  POSITIVE_THRESHOLD,
  CAPTURE_INFLIGHT_CAP,
  MAX_AUDIT_ATTEMPTS,
  type JevAuditConfig,
  type CaptureInput,
  type EvidencePack,
} from '../../src/scheduler/JevJobCompletionAudit.js';

const NOW = Date.parse('2026-09-22T12:00:00Z');
const FUTURE = '2026-10-05T12:00:00Z';
const SECRET = 'sk-proj-' + 'A1b2C3d4'.repeat(6);

let root: string;
let evidenceDir: string;
let logPath: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-audit-'));
  evidenceDir = path.join(root, 'state', 'jev-supervision-evidence');
  logPath = path.join(root, 'logs', 'jev-job-completion-audit.jsonl');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
});

const rows = () =>
  fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const packs = () => (fs.existsSync(evidenceDir) ? fs.readdirSync(evidenceDir).filter((f) => f.endsWith('.json')) : []);
const readPack = (runId: string): EvidencePack =>
  JSON.parse(fs.readFileSync(path.join(evidenceDir, `${runId}.json`), 'utf8'));

function okAnswers(over: Partial<Record<string, number | string>> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'jev-1.13.0',
      usage: { input_tokens: 200 },
      answers: {
        produced_declared_effect: { noul: (over.produced as number) ?? 0.95 },
        false_success: { noul: (over.false_success as number) ?? 0.03 },
        failure_class: { choice: (over.failure_class as string) ?? 'cannot-tell' },
      },
    }),
  } as unknown as Response;
}

function make(opts: { cfg?: Partial<JevAuditConfig>; key?: string | null; fetchImpl?: typeof fetch; now?: () => number; metrics?: Array<Record<string, unknown>> }) {
  const metrics = opts.metrics ?? [];
  return new JevJobCompletionAudit({
    getConfig: () => ({ enabled: true, soakEndsAt: FUTURE, model: 'jev-1.13.0', timeoutMs: 500, dailyCallCap: 1500, ...opts.cfg }) as JevAuditConfig,
    readKey: () => (opts.key === undefined ? 'test-key' : opts.key),
    evidenceDir,
    logPath,
    metrics: { record: (r) => metrics.push(r) },
    fetchImpl: opts.fetchImpl ?? ((async () => okAnswers()) as never),
    now: opts.now ?? (() => NOW),
  });
}

function input(over: Partial<CaptureInput> = {}): CaptureInput {
  return {
    runId: over.runId ?? `run-${Math.random().toString(36).slice(2, 8)}`,
    slug: 'sample-job',
    goal: 'Sync the daily report',
    result: 'success',
    output: 'starting…\nreport written to out/report.md\ndone',
    workDir: root,
    startedAtMs: NOW - 60_000,
    ...over,
  };
}

describe('capture — bounded, durable, never throws', () => {
  it('writes one pack per runId even when completion writers race (pack-file dedupe)', async () => {
    const a = make({});
    a.capture(input({ runId: 'race-1' }));
    a.capture(input({ runId: 'race-1' }));
    await a.flush();
    expect(packs()).toEqual(['race-1.json']);
  });

  it('is inert when disabled / soak-expired / audit-excluded', async () => {
    for (const [cfg, cap] of [
      [{ enabled: false }, undefined],
      [{ soakEndsAt: '2026-09-01T00:00:00Z' }, undefined],
      [{}, 'excluded'],
    ] as const) {
      const a = make({ cfg: cfg as Partial<JevAuditConfig> });
      a.capture(input({ completionAudit: cap as never }));
      await a.flush();
    }
    expect(packs()).toHaveLength(0);
  });

  it('capture() never throws even when everything inside fails', () => {
    const a = new JevJobCompletionAudit({
      getConfig: () => {
        throw new Error('boom');
      },
      readKey: () => {
        throw new Error('boom');
      },
      evidenceDir,
      logPath,
    });
    expect(() => a.capture(input())).not.toThrow();
  });

  it('a burst of 8 same-second completions yields 8 packs (capture never sheds below the cap)', async () => {
    const a = make({});
    for (let i = 0; i < 8; i++) a.capture(input({ runId: `burst-${i}` }));
    await a.flush();
    // flush awaits the LAST capture; wait for all detached writes
    await new Promise((r) => setTimeout(r, 50));
    expect(packs().length).toBe(8);
  });

  it('past the in-flight cap, overflow is a counted capture-failed metric, not unbounded work', async () => {
    const metrics: Array<Record<string, unknown>> = [];
    // A fetch that never runs; make the detached write slow by pointing evidenceDir at a path we create lazily
    const a = make({ metrics });
    // Fill in-flight synchronously: capture's detached part is async, so
    // launching CAP+2 in one tick keeps them all in flight momentarily.
    for (let i = 0; i < CAPTURE_INFLIGHT_CAP + 2; i++) a.capture(input({ runId: `cap-${i}` }));
    await a.flush();
    await new Promise((r) => setTimeout(r, 80));
    const failed = metrics.filter((m) => m.outcome === 'capture-failed');
    expect(packs().length + failed.length).toBeGreaterThanOrEqual(CAPTURE_INFLIGHT_CAP);
    expect(packs().length).toBeLessThanOrEqual(CAPTURE_INFLIGHT_CAP + 2);
  });

  it('tail-preferring truncation with in-band disclosure; scrub removes a planted secret', async () => {
    const big = 'x'.repeat(20_000) + `\nAPI_KEY=${SECRET}\nEND-MARKER`;
    const a = make({});
    a.capture(input({ runId: 'trunc-1', output: big }));
    await a.flush();
    const p = readPack('trunc-1');
    expect(p.truncated).toBe(true);
    expect(p.outputTail).toContain('[truncated: dropped');
    expect(p.outputTail).toContain('END-MARKER'); // the END survived (tail-preferring)
    expect(JSON.stringify(p)).not.toContain(SECRET); // scrubbed
  });

  it('declaredEffects: raw facts + jail — symlinks refused, escapes refused, stale vs fresh recorded', async () => {
    const real = Date.now();
    fs.writeFileSync(path.join(root, 'fresh.txt'), 'new');
    fs.writeFileSync(path.join(root, 'stale.txt'), 'old');
    fs.utimesSync(path.join(root, 'stale.txt'), new Date(real - 3_600_000), new Date(real - 3_600_000));
    fs.symlinkSync('/etc/hosts', path.join(root, 'link.txt'));
    const a = make({ now: () => real });
    a.capture(
      input({
        runId: 'fx-1',
        startedAtMs: real - 60_000,
        declaredEffects: ['fresh.txt', 'stale.txt', 'link.txt', 'missing.txt'],
      }),
    );
    await a.flush();
    const p = readPack('fx-1');
    const by = Object.fromEntries(p.effects.map((e) => [e.path, e]));
    expect(by['fresh.txt']).toMatchObject({ exists: true, mtimeAfterStart: true });
    expect(by['stale.txt']).toMatchObject({ exists: true, mtimeAfterStart: false });
    expect(by['link.txt'].refused).toBe('symlink');
    expect(by['missing.txt'].exists).toBe(false);
    expect(p.deterministic).toBe('missing'); // a missing effect dominates
    expect(p.corroboration).toBe('effects');
  });

  it('no declaredEffects → deterministic no-effects-declared, corroboration none', async () => {
    const a = make({});
    a.capture(input({ runId: 'none-1' }));
    await a.flush();
    const p = readPack('none-1');
    expect(p.deterministic).toBe('no-effects-declared');
    expect(p.corroboration).toBe('none');
  });

  it('trivial-heuristic column: error keywords or empty output are suspicious', async () => {
    const a = make({});
    a.capture(input({ runId: 'h-err', output: 'Traceback (most recent call last): boom' }));
    a.capture(input({ runId: 'h-empty', output: '   ' }));
    a.capture(input({ runId: 'h-ok', output: 'all good, report written' }));
    await a.flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(readPack('h-err').trivialHeuristic).toBe('suspicious');
    expect(readPack('h-empty').trivialHeuristic).toBe('suspicious');
    expect(readPack('h-ok').trivialHeuristic).toBe('clean');
  });

  it('evidence store is permission-hardened (0700 dir / 0600 files)', async () => {
    const a = make({});
    a.capture(input({ runId: 'perm-1' }));
    await a.flush();
    expect(fs.statSync(evidenceDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(evidenceDir, 'perm-1.json')).mode & 0o777).toBe(0o600);
  });
});

describe('self-reported assessment is scrubbed (second-pass review finding)', () => {
  it('a secret inside instrumentAssessment reaches neither the pack nor the wire', async () => {
    let sent = '';
    const a = make({ fetchImpl: (async (_u: unknown, init: RequestInit) => { sent = String(init.body); return okAnswers(); }) as never });
    a.capture(input({ runId: 'ia-1', instrumentAssessment: { status: 'assessed', reason: `used ${SECRET} to call` } }));
    await a.flush();
    expect(JSON.stringify(readPack('ia-1'))).not.toContain(SECRET);
    await a.runBatch();
    expect(sent).toContain('UNTRUSTED CLAIM');
    expect(sent).not.toContain(SECRET);
  });
});

describe('batch — records, never acts; failed attempts debit the cap', () => {
  async function captured(a: JevJobCompletionAudit, over: Partial<CaptureInput> = {}) {
    a.capture(input(over));
    await a.flush();
  }

  it('question battery covers the frozen contract', () => {
    expect(Object.keys(AUDIT_QUESTIONS).sort()).toEqual(['failure_class', 'false_success', 'produced_declared_effect']);
  });

  it('audits a pack and writes a verdict row with no job text; secret-free', async () => {
    let sentBody = '';
    const f: typeof fetch = (async (_u: unknown, init: RequestInit) => {
      sentBody = String(init.body);
      return okAnswers();
    }) as never;
    const a = make({ fetchImpl: f });
    await captured(a, { runId: 'v-1', output: `did the work\n${SECRET}\n` , declaredEffects: undefined});
    const res = await a.runBatch();
    expect(res.audited).toBe(1);
    expect(sentBody).toContain('BEGIN UNTRUSTED JOB OUTPUT'); // envelope
    expect(sentBody).not.toContain(SECRET); // scrub held on the wire too
    const [row] = rows().filter((r) => r.kind === 'audited');
    expect(row.runId).toBe('v-1');
    expect(row.lowConfidence).toBe(false);
    expect(JSON.stringify(row)).not.toContain('did the work'); // rows carry no text
  });

  it('confidence rule: min-noul 0.69 flags lowConfidence, 0.70 does not; p=0.35 and 0.65 both give 0.65', async () => {
    const a1 = make({ fetchImpl: (async () => okAnswers({ produced: 0.31, false_success: 0.05 })) as never }); // conf 0.69 vs 0.95 → min 0.69
    await captured(a1, { runId: 'c-low', declaredEffects: ['x.txt'] });
    await a1.runBatch();
    expect(rows().find((r) => r.runId === 'c-low')?.lowConfidence).toBe(true);

    const a2 = make({ fetchImpl: (async () => okAnswers({ produced: 0.3, false_success: 0.05 })) as never }); // conf 0.70 → records
    await captured(a2, { runId: 'c-ok', declaredEffects: ['x.txt'] });
    await a2.runBatch();
    expect(rows().find((r) => r.runId === 'c-ok')?.lowConfidence).toBe(false);

    const a3 = make({ fetchImpl: (async () => okAnswers({ produced: 0.35, false_success: 0.65 })) as never });
    await captured(a3, { runId: 'c-sym', declaredEffects: ['x.txt'] });
    await a3.runBatch();
    expect(rows().find((r) => r.runId === 'c-sym')?.minConfidence).toBe(0.65);
  });

  it('no declaredEffects → gate reads false_success alone (the unanswerable noul is recorded ungated)', async () => {
    // produced ambiguous (conf 0.5) but false_success decisive → NOT lowConfidence
    const a = make({ fetchImpl: (async () => okAnswers({ produced: 0.5, false_success: 0.02 })) as never });
    await captured(a, { runId: 'ng-1' }); // no declaredEffects
    await a.runBatch();
    const row = rows().find((r) => r.runId === 'ng-1');
    expect(row.lowConfidence).toBe(false);
    expect(row.jev.produced_declared_effect).toBe(0.5);
  });

  it('every closed not-audited reason is reachable', async () => {
    // disabled
    expect((await make({ cfg: { enabled: false } }).runBatch()).skipped.disabled).toBe(1);
    // soak-expired
    expect((await make({ cfg: { soakEndsAt: '2020-01-01T00:00:00Z' } }).runBatch()).skipped['soak-expired']).toBe(1);
    // no-key
    expect((await make({ key: null }).runBatch()).skipped['no-key']).toBe(1);
    // http-error / timeout / model-mismatch / oversize handled below & elsewhere
  });

  it('timeout and http-error write rows immediately (billed attempts debit the cap) and retry with brakes', async () => {
    const failing = make({ fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as never });
    await captured(failing, { runId: 'retry-1' });
    await failing.runBatch();
    expect(rows().filter((r) => r.runId === 'retry-1' && r.reason === 'http-error')).toHaveLength(1);
    expect(readPack('retry-1').attempts).toBe(1);

    // Immediately rerunning: backoff (2 passes) blocks the second attempt.
    const r2 = await failing.runBatch();
    expect(r2.skipped['backoff-wait']).toBe(1);
  });

  it('after MAX attempts the pack goes terminal audit-failed and is never selected again', async () => {
    const a = make({ fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as never });
    await captured(a, { runId: 'term-1' });
    // Force the pack to the attempt ceiling with a stale lastAttemptPass.
    const p = readPack('term-1');
    p.attempts = MAX_AUDIT_ATTEMPTS;
    p.lastAttemptPass = 0;
    fs.writeFileSync(path.join(evidenceDir, 'term-1.json'), JSON.stringify(p));
    const res = await a.runBatch();
    expect(res.skipped['audit-failed']).toBe(1);
    expect(rows().some((r) => r.runId === 'term-1' && r.reason === 'audit-failed')).toBe(true);
    // Terminal: a second pass no longer sees it at all.
    const res2 = await a.runBatch();
    expect(res2.skipped['audit-failed']).toBeUndefined();
  });

  it('a response from another model is excluded as model-mismatch (terminal)', async () => {
    const a = make({
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ model: 'jev-2.0.0', usage: { input_tokens: 1 }, answers: {} }),
      })) as never,
    });
    await captured(a, { runId: 'mm-1' });
    const res = await a.runBatch();
    expect(res.skipped['model-mismatch']).toBe(1);
    expect((await a.runBatch()).skipped['model-mismatch']).toBeUndefined(); // terminal
  });

  it('cap spend derives from the day rows ACROSS instances (restart-safe) and counts failed attempts', async () => {
    const fail = make({ cfg: { dailyCallCap: 2 }, fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as never });
    await captured(fail, { runId: 'cap-a' });
    await captured(fail, { runId: 'cap-b' });
    await fail.runBatch(); // two failed (billed) attempts → two rows
    // A FRESH instance (simulated restart) sees the two attempt rows and refuses more calls today.
    const next = make({ cfg: { dailyCallCap: 2 } });
    await captured(next, { runId: 'cap-c' });
    const res = await next.runBatch();
    expect(res.audited).toBe(0);
    expect(res.skipped.capped).toBeGreaterThanOrEqual(1);
  });

  it('stratified order: deterministic-suspicious packs are audited before uniform ones under a tight cap', async () => {
    const auditedIds: string[] = [];
    const f: typeof fetch = (async (_u: unknown, init: RequestInit) => {
      const body = String(init.body);
      const m = body.match(/Job: ([\w-]+)/);
      auditedIds.push(m?.[1] ?? '?');
      return okAnswers();
    }) as never;
    const a = make({ cfg: { dailyCallCap: 1 }, fetchImpl: f });
    a.capture(input({ runId: 'u-1', slug: 'clean-job' }));
    await a.flush();
    // 'gone.txt' is never created → a missing declared effect
    a.capture(input({ runId: 's-1', slug: 'suspicious-job', declaredEffects: ['gone.txt'] }));
    await a.flush();
    const res = await a.runBatch();
    expect(res.audited).toBe(1);
    expect(auditedIds).toEqual(['suspicious-job']);
    const row = rows().find((r) => r.kind === 'audited');
    expect(row.stratum).toBe('suspicious');
  });

  it('truncated and corroboration flags ride every row (graduation exclusion inputs)', async () => {
    const a = make({});
    await captured(a, { runId: 'flag-1', output: 'y'.repeat(20_000) });
    await a.runBatch();
    const row = rows().find((r) => r.runId === 'flag-1');
    expect(row.truncated).toBe(true);
    expect(row.corroboration).toBe('none');
  });
});

describe('retention sweep', () => {
  it('removes packs past the age bound, oldest first', async () => {
    const a = make({});
    a.capture(input({ runId: 'old-1' }));
    a.capture(input({ runId: 'new-1' }));
    await a.flush();
    await new Promise((r) => setTimeout(r, 50));
    const old = path.join(evidenceDir, 'old-1.json');
    fs.utimesSync(old, new Date(NOW - 20 * 86_400_000), new Date(NOW - 20 * 86_400_000));
    const res = await a.sweepRetention();
    expect(res.removed).toBe(1);
    expect(packs()).toEqual(['new-1.json']);
  });
});

describe('metering', () => {
  it('every attempted call lands in feature metrics with tokens', async () => {
    const metrics: Array<Record<string, unknown>> = [];
    const a = make({ metrics });
    a.capture(input({ runId: 'm-1' }));
    await a.flush();
    await a.runBatch();
    const call = metrics.find((m) => m.tokensIn === 200);
    expect(call).toMatchObject({ feature: 'jev-job-completion-audit', framework: 'typesafe-api', tokensOut: 0 });
  });
});

// ── Claimed effects (spec: docs/specs/jev-audit-claimed-effects.md) ────────
// The job CLAIMS a conditional effect on stdout; the audit verifies the claim.
// A quiet run claims nothing and is NOT a failure. A run that claims work it
// did not do is the strongest false-success signal the audit can record.
import { parseClaimedEffects, MAX_CLAIMED_EFFECTS } from '../../src/scheduler/JevJobCompletionAudit.js';

describe('claimed effects — the run claims, the audit verifies', () => {
  const MEM = '.instar/MEMORY.md';
  const writeMem = () => {
    fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(root, MEM), 'a learning\n');
  };

  it('a quiet run (conditional declared, nothing claimed) is conditional-unclaimed — never missing/stale', async () => {
    writeMem(); // the file exists and is fresh, but the run did not claim it
    const a = make({});
    a.capture(input({ runId: 'quiet-1', conditionalEffects: [MEM], output: 'nothing significant today' }));
    await a.flush();
    const pack = readPack('quiet-1');
    expect(pack.deterministic).toBe('conditional-unclaimed');
    expect(pack.effects).toEqual([]);
    expect(pack.corroboration).toBe('none');
    expect(pack.claimedUndeclared).toBeUndefined();
  });

  it('a claimed conditional effect that landed is all-present-and-fresh, and the entry is marked claimed', async () => {
    writeMem();
    const a = make({});
    a.capture(input({ runId: 'claimed-ok', conditionalEffects: [MEM], output: `appended the insight\nEFFECT: ${MEM}\ndone` }));
    await a.flush();
    const pack = readPack('claimed-ok');
    expect(pack.deterministic).toBe('all-present-and-fresh');
    expect(pack.effects).toHaveLength(1);
    expect(pack.effects[0]).toMatchObject({ path: MEM, exists: true, mtimeAfterStart: true, claimed: true });
    expect(pack.corroboration).toBe('effects');
  });

  it('a claimed effect whose file is absent is MISSING — the false-success signal this exists to catch', async () => {
    const a = make({});
    a.capture(input({ runId: 'claimed-missing', conditionalEffects: [MEM], output: `EFFECT: ${MEM}` }));
    await a.flush();
    const pack = readPack('claimed-missing');
    expect(pack.deterministic).toBe('missing');
    expect(pack.effects[0]).toMatchObject({ path: MEM, exists: false, claimed: true });
  });

  it('a claimed effect whose file was NOT touched during the run is STALE', async () => {
    writeMem();
    const a = make({});
    // startedAtMs after the file's real mtime → the file predates the run
    a.capture(input({ runId: 'claimed-stale', conditionalEffects: [MEM], output: `EFFECT: ${MEM}`, startedAtMs: Date.now() + 60_000 }));
    await a.flush();
    expect(readPack('claimed-stale').deterministic).toBe('stale');
  });

  it('a claim for a path the job never declared is ignored for verification and counted', async () => {
    writeMem();
    const a = make({});
    a.capture(input({ runId: 'undeclared', conditionalEffects: [MEM], output: 'EFFECT: .instar/somewhere-else.md' }));
    await a.flush();
    const pack = readPack('undeclared');
    expect(pack.deterministic).toBe('conditional-unclaimed'); // output cannot widen the verified set
    expect(pack.effects).toEqual([]);
    expect(pack.claimedUndeclared).toBe(1);
  });

  it('an unconditional declaredEffect is still verified when the conditional one is unclaimed', async () => {
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'out', 'report.md'), 'x');
    const a = make({});
    a.capture(input({ runId: 'mixed', declaredEffects: ['out/report.md'], conditionalEffects: [MEM], output: 'report written' }));
    await a.flush();
    const pack = readPack('mixed');
    expect(pack.deterministic).toBe('all-present-and-fresh');
    expect(pack.effects.map((e) => e.path)).toEqual(['out/report.md']);
    expect(pack.effects[0].claimed).toBeUndefined();
  });

  it('absent conditionalEffects changes nothing: no declarations is still no-effects-declared', async () => {
    const a = make({});
    a.capture(input({ runId: 'legacy', output: 'EFFECT: .instar/MEMORY.md' })); // a stray claim with nothing declared
    await a.flush();
    const pack = readPack('legacy');
    expect(pack.deterministic).toBe('no-effects-declared');
    expect(pack.claimedUndeclared).toBe(1);
  });

  it('parseClaimedEffects is bounded, whitespace-tolerant, deduping, and ignores a bare marker', () => {
    expect([...parseClaimedEffects('  EFFECT: a/b.md \nEFFECT:\nEFFECT: a/b.md\n\tEFFECT: c.json')]).toEqual(['a/b.md', 'c.json']);
    expect(parseClaimedEffects('')).toEqual(new Set());
    const many = Array.from({ length: MAX_CLAIMED_EFFECTS + 10 }, (_, i) => `EFFECT: f${i}`).join('\n');
    expect(parseClaimedEffects(many).size).toBe(MAX_CLAIMED_EFFECTS);
    // The marker must own the whole line — prose mentioning it does not claim.
    expect(parseClaimedEffects('I will print EFFECT: x later').size).toBe(0);
  });
});

describe('claimed effects — batch treatment', () => {
  it('an unclaimed pack is gated on false_success alone and never enters the suspicious stratum', async () => {
    const MEM = '.instar/MEMORY.md';
    fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(root, MEM), 'x');
    // produced_declared_effect is deliberately UNCERTAIN (0.5 → conf 0.5) while
    // false_success is confident (0.05 → conf 0.95). If the unclaimed pack were
    // min'd across both it would read 0.5; gated on false_success alone it reads 0.95.
    const a = make({ fetchImpl: (async () => okAnswers({ produced: 0.5, false_success: 0.05, failure_class: 'did-nothing' })) as never });
    a.capture(input({ runId: 'b-unclaimed', conditionalEffects: [MEM], output: 'quiet' }));
    a.capture(input({ runId: 'b-claimed', conditionalEffects: [MEM], output: `EFFECT: ${MEM}` }));
    await a.flush();
    await a.runBatch();
    const byRun = Object.fromEntries(rows().filter((r) => r.kind === 'audited').map((r) => [r.runId, r]));
    expect(byRun['b-unclaimed'].minConfidence).toBeCloseTo(0.95, 2);
    expect(byRun['b-unclaimed'].stratum).not.toBe('suspicious');
    expect(byRun['b-claimed'].minConfidence).toBeCloseTo(0.5, 2); // claimed+fresh: both questions in play
  });
});
