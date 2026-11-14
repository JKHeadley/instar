// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * The standing compaction canary (context-budget-layered-summaries §9.1):
 * one detection rule (the engine's compact-boundary entry), two artifacts per
 * detection (a PostCompact record and a SessionStart:compact recovery block in
 * the transcript), states over the verification epoch. Transcript lines are
 * shaped exactly like Claude Code 2.1.321's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompactionCanary, CANARY_ARTIFACT_GRACE_MS, type CanarySession } from '../../src/monitoring/compactionCanary.js';
import { recordPostCompact } from '../../src/monitoring/PostCompactStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/compaction-canary.test.ts';
const T = '141133';
const SID = '0f706e54-1995-4c2b-ba35-2f936f003ea7';
const iso = (ms: number) => new Date(ms).toISOString();

describe('compaction canary', () => {
  let stateDir: string; let transcript: string; let now: number; let session: CanarySession; let n: number;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-'));
    transcript = path.join(stateDir, 'proj', `${SID}.jsonl`); fs.mkdirSync(path.dirname(transcript));
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'u0', sessionId: SID, version: '2.1.321', message: { content: 'hi' } })}\n`);
    now = Date.parse('2026-11-10T10:00:00Z'); n = 0;
    session = { topicKey: T, claudeSessionId: SID, transcriptPath: transcript, engine: 'claude-code' };
  });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

  const canary = () => new CompactionCanary({ stateDir, machineId: 'm1', now: () => now });
  const append = (o: object) => fs.appendFileSync(transcript, `${JSON.stringify(o)}\n`);
  /**
   * The SessionStart:compact attachment as Claude Code writes it for a block
   * delivered WHOLE (under its 10,000-char hook-output limit): `content`, what
   * the model received, carries the block. A block over the limit has `content`
   * = the `<persisted-output>` preview wrapper and is NOT a recovery (see
   * tests/unit/recovery-output-fit.test.ts).
   */
  const hook = (over: Record<string, unknown> = {}, uuid = 'h') => {
    const stdout = (over.stdout as string | undefined) ?? '--- MACHINE LOAD ---\n=== IDENTITY RECOVERY (post-compaction) ===\nI am Echo.';
    return { type: 'attachment', attachment: {
      type: 'hook_success', hookName: 'SessionStart:compact', hookEvent: 'SessionStart', exitCode: 0,
      command: 'bash "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/session-start.sh"',
      stdout, content: stdout, ...over,
    }, uuid, sessionId: SID };
  };
  /** A compaction as Claude Code writes it, optionally with its two artifacts. */
  const compaction = (opts: { trigger?: string; recovery?: boolean; postCompact?: boolean; hookExit?: number } = {}) => {
    const uuid = `b${(n += 1)}`;
    append({ parentUuid: null, isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: opts.trigger ?? 'auto', preTokens: 968913, postTokens: 34011 }, uuid, timestamp: iso(now), sessionId: SID, version: '2.1.321' });
    append({ type: 'attachment', attachment: { type: 'instructions', files: [] }, uuid: `${uuid}-i`, sessionId: SID });
    if (opts.recovery !== false) append(hook({ exitCode: opts.hookExit ?? 0 }, `${uuid}-h`));
    if (opts.postCompact !== false) recordPostCompact(stateDir, { topicKey: T, instarSessionId: 'inst1', claudeSessionId: SID, trigger: opts.trigger ?? 'auto', summary: 'summary', receivedAt: now + 1_000 });
    return uuid;
  };

  it('switch off ⇒ n/a; on with no compaction ⇒ uninitialized', () => {
    const c = canary();
    c.scan([session], false);
    expect(c.report(false).groups[0].state).toBe('n/a');
    c.scan([session], true);
    expect(c.report(true).groups[0].state).toBe('uninitialized');
  });

  it('a compact-boundary entry ALONE is a detection; with both artifacts it is complete', () => {
    const c = canary();
    compaction();
    c.scan([session], true);
    const r = c.report(true);
    expect(r.groups).toMatchObject([{ machine: 'm1', engine: 'claude-code', version: '2.1.321', detected: 1, complete: 1 }]);
    expect(r.recent[0]).toMatchObject({ trigger: 'auto', recoveryBlock: true, postCompact: true, synthetic: false });
  });

  it('a hook that never fires reads DIVERGED (past the grace), never uninitialized', () => {
    const c = canary();
    compaction({ recovery: false });
    c.scan([session], true);
    expect(c.report(true).groups[0]).toMatchObject({ pending: 1 });
    now += CANARY_ARTIFACT_GRACE_MS + 1;
    c.scan([session], true);
    expect(c.report(true).groups[0].state).toBe('diverged');
  });

  it('a missing PostCompact record, or a failed hook, also diverges (records never cross boundaries, even on tied timestamps)', () => {
    const c = canary();
    compaction({ postCompact: false });
    compaction({ hookExit: 1 }); // same timestamp as the first
    c.scan([session], true);
    now += CANARY_ARTIFACT_GRACE_MS + 1;
    expect(c.report(true).groups[0]).toMatchObject({ state: 'diverged', complete: 0 });
  });

  it('artifacts that arrive on a later tick complete the detection (incremental scan, partial last line)', () => {
    const c = canary();
    append({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' }, uuid: 'bx', timestamp: iso(now), sessionId: SID, version: '2.1.321' });
    const line = JSON.stringify(hook()) + '\n';
    fs.appendFileSync(transcript, line.slice(0, 40)); // torn mid-write
    c.scan([session], true);
    expect(c.report(true).recent[0].recoveryBlock).toBe(false);
    fs.appendFileSync(transcript, line.slice(40));
    recordPostCompact(stateDir, { topicKey: T, instarSessionId: 'inst1', claudeSessionId: SID, trigger: 'auto', summary: 's', receivedAt: now + 5_000 });
    c.scan([session], true);
    expect(c.report(true).recent[0]).toMatchObject({ recoveryBlock: true, postCompact: true });
    c.scan([session], true);
    expect(c.report(true).groups[0].detected).toBe(1); // never double-counted
  });

  it('healthy needs N complete detections AND a synthetic positive; until then it is accruing', () => {
    const c = canary();
    c.scan([session], true); // the switch is on: the epoch starts here
    now += 1_000;
    for (let i = 0; i < 3; i++) { compaction(); now += 60_000; }
    c.scan([session], true);
    expect(c.report(true).groups[0]).toMatchObject({ state: 'accruing', complete: 3, synthetic: 0 });
    c.recordSyntheticPress(SID);
    now += 30_000;
    compaction({ trigger: 'manual' });
    c.scan([session], true);
    expect(c.report(true).groups[0]).toMatchObject({ state: 'healthy', complete: 4, synthetic: 1 });
  });

  it('a manual compaction the sentinel did not press is not a synthetic positive', () => {
    const c = canary();
    compaction({ trigger: 'manual' });
    c.scan([session], true);
    expect(c.report(true).recent[0].synthetic).toBe(false);
  });

  it('the epoch restarts when the switch turns on and after a remediation; history is kept', () => {
    const c = canary();
    compaction({ recovery: false });
    c.scan([session], true);
    now += CANARY_ARTIFACT_GRACE_MS + 1;
    expect(c.report(true).groups[0].state).toBe('diverged');
    c.restartEpoch();
    expect(c.report(true).groups[0].state).toBe('uninitialized');
    expect(c.report(true).recent).toHaveLength(1);
    c.scan([session], false); now += 1; c.scan([session], true);
    expect(c.report(true).epochStartedAt).toBe(now);
  });

  describe('review round 1: a recovery block is a RECOVERY, not just a hook that exited 0', () => {
    it('a SessionStart:compact hook that printed no recovery marker (startup-orientation fallback) is NOT recovery', () => {
      const c = canary(); c.scan([session], true); now += 1_000;
      const uuid = compaction({ recovery: false });
      append(hook({ stdout: '--- MACHINE LOAD ---\nstartup orientation only', content: 'startup orientation only' }, `${uuid}-h`));
      c.scan([session], true);
      now += CANARY_ARTIFACT_GRACE_MS + 1;
      expect(c.report(true).groups[0]).toMatchObject({ state: 'diverged', complete: 0 });
    });

    it('a startup fallback that merely QUOTES the marker inside other text is NOT recovery (whole-line match)', () => {
      const c = canary(); c.scan([session], true); now += 1_000;
      const uuid = compaction({ recovery: false });
      append(hook({ stdout: 'Recent messages:\n[user] after a compaction you see an === IDENTITY RECOVERY (post-compaction) === block' }, `${uuid}-h`));
      c.scan([session], true);
      expect(c.report(true).recent[0].recoveryBlock).toBe(false);
    });

    it('a manual boundary stamped BEFORE the press is not its synthetic positive', () => {
      const c = canary(); c.scan([session], true); now += 1_000;
      compaction({ trigger: 'manual' }); now += 10_000; c.recordSyntheticPress(SID);
      c.scan([session], true);
      expect(c.report(true).recent[0].synthetic).toBe(false);
    });

    it('another hook succeeding under the same name (not instar\'s session-start) is NOT recovery', () => {
      const c = canary(); c.scan([session], true); now += 1_000;
      const uuid = compaction({ recovery: false });
      append(hook({ command: 'bash ./some-other-hook.sh', stdout: '=== IDENTITY RECOVERY (post-compaction) === (copied)' }, `${uuid}-h`));
      c.scan([session], true);
      expect(c.report(true).recent[0].recoveryBlock).toBe(false);
    });

    it('a compaction still pending its artifacts holds healthy back', () => {
      const c = canary(); c.scan([session], true); now += 1_000;
      for (let i = 0; i < 3; i++) { compaction(); now += 60_000; }
      c.recordSyntheticPress(SID); now += 10_000; compaction({ trigger: 'manual' });
      c.scan([session], true);
      expect(c.report(true).groups[0].state).toBe('healthy');
      now += 60_000; compaction({ recovery: false, postCompact: false });
      c.scan([session], true);
      expect(c.report(true).groups[0]).toMatchObject({ state: 'accruing', pending: 1 });
    });

    it('one press counts for one manual compaction only', () => {
      const c = canary(); c.scan([session], true); now += 1_000;
      c.recordSyntheticPress(SID); now += 10_000;
      compaction({ trigger: 'manual' }); now += 10_000; compaction({ trigger: 'manual' });
      c.scan([session], true);
      expect(c.report(true).recent.map((d) => d.synthetic)).toEqual([true, false]);
    });

    it('a session that compacts and exits before the next tick is still counted', () => {
      const c = canary(); c.scan([session], true); now += 1_000;
      compaction();
      c.scan([], true); // the session is gone from the running list
      expect(c.report(true).groups[0]).toMatchObject({ detected: 1, complete: 1 });
    });

    it('an unreadable transcript is skipped without stopping the other sessions\' scans', () => {
      const other = path.join(stateDir, 'proj', 'other.jsonl');
      fs.writeFileSync(other, '{"type":"user"}\n'); // non-empty, so a read is attempted
      const c = canary(); c.scan([session], true); now += 1_000;
      compaction();
      fs.chmodSync(other, 0o000);
      try {
        expect(() => c.scan([{ ...session, transcriptPath: other, claudeSessionId: 'other' }, session], true)).not.toThrow();
        expect(c.report(true).groups[0].detected).toBe(1);
        expect(c.report(true).unreadableTranscripts).toBe(1);
      } finally { fs.chmodSync(other, 0o600); }
    });

    it('an unreadable ledger is replaced and the reset is REPORTED', () => {
      const c = canary(); c.scan([session], true);
      fs.writeFileSync(path.join(stateDir, 'state', 'context-budget', 'canary.json'), '{torn');
      expect(c.report(true).ledgerResetAt).toBe(now);
      expect(canary().report(true).ledgerResetAt).toBe(now);
    });
  });

  it('versions are separate groups; a truncated transcript is re-read without duplicates', () => {
    const c = canary();
    compaction();
    c.scan([session], true);
    fs.writeFileSync(transcript, '');
    append({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' }, uuid: 'b1', timestamp: iso(now), sessionId: SID, version: '2.1.321' }); // same boundary re-read
    append({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' }, uuid: 'v2', timestamp: iso(now), sessionId: SID, version: '2.1.330' });
    c.scan([session], true);
    const g = c.report(true).groups;
    expect(g.map((x) => [x.version, x.detected]).sort()).toEqual([['2.1.321', 1], ['2.1.330', 1]]);
  });

  it('the ledger is durable across canary instances (sentinel restarts)', () => {
    compaction();
    canary().scan([session], true);
    expect(canary().report(true).groups[0].detected).toBe(1);
    canary().scan([session], true);
    expect(canary().report(true).groups[0].detected).toBe(1);
  });

  it('counts this session\'s real compaction from its own transcript shape (no artifacts in this state dir ⇒ pending, then diverged)', () => {
    const start = now;
    // The real line from this very session's transcript (Claude Code 2.1.321), trimmed.
    fs.writeFileSync(transcript, '{"parentUuid":null,"logicalParentUuid":"e543db08-d73c-4c38-9dce-ed52daad8090","isSidechain":false,"type":"system","subtype":"compact_boundary","content":"Conversation compacted","level":"info","compactMetadata":{"trigger":"auto","preTokens":968913,"postTokens":34011},"uuid":"real-b","timestamp":"2026-11-10T10:30:00.000Z","sessionId":"0f706e54-1995-4c2b-ba35-2f936f003ea7","version":"2.1.321"}\n');
    now = Date.parse('2026-11-10T10:29:00Z');
    const c = canary();
    c.scan([], true); // epoch starts before the compaction
    now = Date.parse('2026-11-10T10:31:00Z');
    c.scan([session], true);
    expect(c.report(true).groups[0]).toMatchObject({ detected: 1, pending: 1 });
    now = Date.parse('2026-11-10T10:30:00Z') + CANARY_ARTIFACT_GRACE_MS + 1;
    expect(c.report(true).groups[0].state).toBe('diverged');
    expect(start).toBeTypeOf('number');
  });

  it('compactions before the switch turned on are history, not this epoch', () => {
    const c = canary();
    compaction();
    now += 60_000;
    c.scan([session], true);
    expect(c.report(true).groups[0]).toMatchObject({ state: 'uninitialized', detected: 0 });
    expect(c.report(true).recent).toHaveLength(1);
  });
});
