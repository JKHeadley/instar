/**
 * ProcessCeilingCheck — the state-not-symbol half of the launchd ceiling fix.
 *
 * Spec: docs/specs/launchd-process-ceiling-floor.md §3, acceptance criteria 7-9.
 *
 * The point of this suite is criterion 7: the reading must come from a LIVE process, not
 * from the plist bytes. A suite that only exercised the pure comparator would prove the
 * arithmetic and miss the entire bug, which is that the file and the running process
 * disagree.
 */
import { describe, it, expect } from 'vitest';
import {
  readEffectiveProcessCeiling,
  evaluateProcessCeiling,
  processCeilingNotice,
  readLaunchdPlistCeilingsForSelf,
  launchdPlistExistsForSelf,
} from '../../src/core/ProcessCeilingCheck.js';
import { LAUNCHD_PROCESS_CEILING_FLOOR } from '../../src/core/PostUpdateMigrator.js';

describe('readEffectiveProcessCeiling — reads the LIVE process, not a file', () => {
  it('returns this process\'s real soft RLIMIT_NPROC (criterion 7)', () => {
    const v = readEffectiveProcessCeiling();
    // On a platform that reports it, it must be a real positive integer — and it must come
    // from the running process, which is why nothing here reads a plist.
    if (v !== null) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    // A platform that cannot report it yields null, which is a valid state, not a failure.
    expect(v === null || typeof v === 'number').toBe(true);
  });

  it('agrees with the OS about the live process (corroboration, not a second look at the symbol)', () => {
    const v = readEffectiveProcessCeiling();
    if (v === null) return; // honestly unmeasurable here
    const direct = (process.report.getReport() as { userLimits: Record<string, { soft: unknown }> })
      .userLimits['max_user_processes'].soft;
    expect(v).toBe(direct);
  });

  it('returns null (never a number) when the report throws — criterion 8', () => {
    expect(
      readEffectiveProcessCeiling(() => {
        throw new Error('no report on this runtime');
      }),
    ).toBeNull();
  });

  it('returns null when the limit is absent, unlimited, or non-numeric — criterion 8', () => {
    expect(readEffectiveProcessCeiling(() => ({}))).toBeNull();
    expect(readEffectiveProcessCeiling(() => ({ userLimits: {} }))).toBeNull();
    expect(
      readEffectiveProcessCeiling(() => ({ userLimits: { max_user_processes: { soft: 'unlimited' } } })),
    ).toBeNull();
    expect(
      readEffectiveProcessCeiling(() => ({ userLimits: { max_user_processes: { soft: 0 } } })),
    ).toBeNull();
    expect(
      readEffectiveProcessCeiling(() => ({ userLimits: { max_user_processes: { soft: Infinity } } })),
    ).toBeNull();
  });
});

describe('evaluateProcessCeiling — three enumerable states, silence on uncertainty', () => {
  const base = { platform: 'darwin', machineId: 'm1', plistCeilings: [2048, 2048] };

  it('raises exactly when the plist is raised but the live process is not — criterion 9', () => {
    const v = evaluateProcessCeiling({ ...base, effective: 512 });
    expect(v.state).toBe('raise');
    if (v.state !== 'raise') return;
    expect(v.effective).toBe(512);
    expect(v.floor).toBe(LAUNCHD_PROCESS_CEILING_FLOOR);
  });

  it('stays silent once the live process is at the floor AND the plist agrees — criterion 9', () => {
    expect(evaluateProcessCeiling({ ...base, effective: 2048 }).state).toBe('ok');
  });

  it('stays silent when the live process is ABOVE the floor (operator tuned higher)', () => {
    expect(evaluateProcessCeiling({ ...base, effective: 8192 }).state).toBe('ok');
  });

  it('warns about a SAFE machine whose next restart would drop it below the floor', () => {
    // A draft called this `ok` on the reasoning that the plist is "a question about the
    // future". A silent future failure triggered by a routine restart is the exact class
    // this whole check exists to end.
    const v = evaluateProcessCeiling({ ...base, plistCeilings: [512, 512], effective: 4096 });
    expect(v.state).toBe('future-repair');
  });

  it('warns the same way when a SAFE machine has no readable plist at all', () => {
    expect(evaluateProcessCeiling({ ...base, plistCeilings: [], effective: 4096 }).state).toBe(
      'future-repair',
    );
  });

  it('gives future-repair its own dedupe key, distinct from raise and repair', () => {
    const future = evaluateProcessCeiling({ ...base, plistCeilings: [512, 512], effective: 4096 });
    const repair = evaluateProcessCeiling({ ...base, plistCeilings: [512, 512], effective: 512 });
    const raise = evaluateProcessCeiling({ ...base, effective: 512 });
    const keys = [future, repair, raise].map((v) => (v.state === 'ok' || v.state === 'unknown' ? '' : v.dedupeKey));
    expect(new Set(keys).size).toBe(3);
  });

  it('stays silent — never guesses — when the reading is unmeasurable (criterion 8)', () => {
    const v = evaluateProcessCeiling({ ...base, effective: null });
    expect(v.state).toBe('unknown');
    if (v.state === 'unknown') expect(v.reason).toBe('effective-unreadable');
  });

  it('says REPAIR, not restart, when the machine is unsafe and the plist was never corrected', () => {
    // The first draft returned silence here, reasoning the migration reports it. It reports
    // it to a LOG. A machine whose migration never ran is crashing on this exact bug with
    // nobody told — and telling that operator to "restart" would be wrong advice, because
    // the machine would come back identical.
    expect(evaluateProcessCeiling({ ...base, plistCeilings: [512, 512], effective: 512 }).state).toBe(
      'repair',
    );
  });

  it('says REPAIR when the plist declares no ceiling at all', () => {
    expect(evaluateProcessCeiling({ ...base, plistCeilings: [], effective: 512 }).state).toBe('repair');
  });

  it('says REPAIR when only SOME plist values were raised (half-migrated plist)', () => {
    expect(
      evaluateProcessCeiling({ ...base, plistCeilings: [2048, 512], effective: 512 }).state,
    ).toBe('repair');
  });

  it('gives raise and repair DIFFERENT keys, so a machine that gets migrated is re-told', () => {
    const repair = evaluateProcessCeiling({ ...base, plistCeilings: [512, 512], effective: 512 });
    const raise = evaluateProcessCeiling({ ...base, effective: 512 });
    expect(repair.state === 'repair' && raise.state === 'raise').toBe(true);
    if (repair.state !== 'repair' || raise.state !== 'raise') return;
    expect(repair.dedupeKey).not.toBe(raise.dedupeKey);
  });

  it('is a no-op off darwin, where the limit is not launchd-governed', () => {
    const v = evaluateProcessCeiling({ ...base, platform: 'linux', effective: 512 });
    expect(v.state).toBe('unknown');
    if (v.state === 'unknown') expect(v.reason).toBe('not-applicable');
  });

  it('dedupes per machine so a restart-less week yields ONE item, not one per boot', () => {
    const a = evaluateProcessCeiling({ ...base, effective: 512 });
    const b = evaluateProcessCeiling({ ...base, effective: 512 });
    expect(a.state === 'raise' && b.state === 'raise' && a.dedupeKey === b.dedupeKey).toBe(true);
  });

  it('gives a DIFFERENT dedupe key per machine, so a second machine is never suppressed', () => {
    const a = evaluateProcessCeiling({ ...base, effective: 512 });
    const b = evaluateProcessCeiling({ ...base, machineId: 'm2', effective: 512 });
    expect(a.state === 'raise' && b.state === 'raise' && a.dedupeKey !== b.dedupeKey).toBe(true);
  });

  it('two hosts COLLIDING on one machineId still get separate items, not one swallowed', () => {
    // Elsewhere a machineId collision costs a duplicate row. Here it could swallow the HIGH
    // notice for a machine that is actively crashing, so the host fingerprint is mixed in.
    const a = evaluateProcessCeiling({ ...base, hostFingerprint: 'studio.local', effective: 512 });
    const b = evaluateProcessCeiling({ ...base, hostFingerprint: 'laptop.local', effective: 512 });
    expect(a.state === 'raise' && b.state === 'raise' && a.dedupeKey !== b.dedupeKey).toBe(true);
  });

  it('still dedupes across boots on ONE host (the fingerprint is stable, not per-run)', () => {
    const a = evaluateProcessCeiling({ ...base, hostFingerprint: 'studio.local', effective: 512 });
    const b = evaluateProcessCeiling({ ...base, hostFingerprint: 'studio.local', effective: 512 });
    expect(a.state === 'raise' && b.state === 'raise' && a.dedupeKey === b.dedupeKey).toBe(true);
  });

  it('gives a fresh key when the reading genuinely changes', () => {
    const a = evaluateProcessCeiling({ ...base, effective: 512 });
    const b = evaluateProcessCeiling({ ...base, effective: 1024 });
    expect(a.state === 'raise' && b.state === 'raise' && a.dedupeKey !== b.dedupeKey).toBe(true);
  });
});

describe('processCeilingNotice — operator-facing text', () => {
  const v = evaluateProcessCeiling({
    platform: 'darwin',
    machineId: 'm1',
    plistCeilings: [2048, 2048],
    effective: 512,
  });

  it('names the machine, both numbers, and the action', () => {
    if (v.state !== 'raise') throw new Error('fixture should raise');
    const n = processCeilingNotice(v, 'the Studio');
    expect(n.title).toContain('the Studio');
    expect(n.body).toContain('512');
    expect(n.body).toContain('2048');
    expect(n.body.toLowerCase()).toContain('restart');
  });

  it('asks for no terminal work — no commands, paths, or config syntax', () => {
    if (v.state !== 'raise') throw new Error('fixture should raise');
    const n = processCeilingNotice(v, 'the Studio');
    const text = `${n.title}\n${n.body}`;
    for (const forbidden of ['launchctl', 'ulimit', 'NumberOfProcesses', '.plist', '/Users/', 'sudo']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('readLaunchdPlistCeilingsForSelf — read-only view of the SYMBOL', () => {
  it('parses the declared values from this agent\'s plist', () => {
    const v = readLaunchdPlistCeilingsForSelf('echo', {
      platform: 'darwin',
      home: '/home',
      readFile: () =>
        '<key>NumberOfProcesses</key><integer>2048</integer><key>NumberOfProcesses</key><integer>2048</integer>',
    });
    expect(v).toEqual([2048, 2048]);
  });

  it('returns [] — routing an unsafe machine to REPAIR — when the plist is unreadable', () => {
    const v = readLaunchdPlistCeilingsForSelf('echo', {
      platform: 'darwin',
      home: '/home',
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(v).toEqual([]);
    // An unreadable plist on an UNSAFE machine is a repair case: the operator must be told,
    // and must not be told to restart (which would not help).
    expect(
      evaluateProcessCeiling({
        platform: 'darwin',
        machineId: 'm1',
        plistCeilings: v,
        effective: 512,
      }).state,
    ).toBe('repair');
    // ...and a HEALTHY machine with an unreadable plist is warned at lower urgency, because
    // its next restart is what makes it unsafe.
    expect(
      evaluateProcessCeiling({
        platform: 'darwin',
        machineId: 'm1',
        plistCeilings: v,
        effective: 4096,
      }).state,
    ).toBe('future-repair');
  });

  it('returns [] off darwin without touching the filesystem', () => {
    let touched = false;
    const v = readLaunchdPlistCeilingsForSelf('echo', {
      platform: 'linux',
      home: '/home',
      readFile: () => {
        touched = true;
        return '';
      },
    });
    expect(v).toEqual([]);
    expect(touched).toBe(false);
  });

  it('returns [] when HOME is unset rather than reading a nonsense path', () => {
    expect(
      readLaunchdPlistCeilingsForSelf('echo', { platform: 'darwin', home: '', readFile: () => '' }),
    ).toEqual([]);
  });
});

describe('processCeilingNotice — the repair variant does NOT tell the operator to restart', () => {
  const repair = evaluateProcessCeiling({
    platform: 'darwin',
    machineId: 'm1',
    plistCeilings: [512, 512],
    effective: 512,
  });

  it('says plainly that a restart will not fix it', () => {
    if (repair.state !== 'repair') throw new Error('fixture should repair');
    const n = processCeilingNotice(repair, 'the laptop');
    expect(n.title).toContain('the laptop');
    expect(`${n.title} ${n.body}`.toLowerCase()).toContain('will not fix');
    expect(n.body).toContain('512');
    expect(n.body).toContain('2048');
  });

  it('asks for no terminal work either', () => {
    if (repair.state !== 'repair') throw new Error('fixture should repair');
    const n = processCeilingNotice(repair, 'the laptop');
    const text = `${n.title}\n${n.body}`;
    for (const forbidden of ['launchctl', 'ulimit', 'NumberOfProcesses', '.plist', '/Users/', 'sudo']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('processCeilingNotice — the future-repair variant does not manufacture urgency', () => {
  const future = evaluateProcessCeiling({
    platform: 'darwin',
    machineId: 'm1',
    plistCeilings: [512, 512],
    effective: 4096,
  });

  it('says plainly that nothing is wrong yet, and what changes at the next restart', () => {
    if (future.state !== 'future-repair') throw new Error('fixture should be future-repair');
    const n = processCeilingNotice(future, 'the mini');
    const text = `${n.title} ${n.body}`.toLowerCase();
    expect(n.title).toContain('the mini');
    expect(text).toContain('restart');
    expect(text).toContain('no hurry');
    // "may", never "would": an unreadable plist makes the next effective limit genuinely
    // unknown, and the notice must not assert a drop it cannot predict.
    expect(text).toContain('may lose');
    expect(text).not.toContain('would drop');
    expect(text).not.toContain('would come back this way.');
    expect(n.body).toContain('2048');
  });

  it('asks for no terminal work either', () => {
    if (future.state !== 'future-repair') throw new Error('fixture should be future-repair');
    const n = processCeilingNotice(future, 'the mini');
    const text = `${n.title}\n${n.body}`;
    for (const forbidden of ['launchctl', 'ulimit', 'NumberOfProcesses', '.plist', '/Users/', 'sudo']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('a machine with NO launchd plist is not warned (regression, found 2026-08-19)', () => {
  // The first shipped version conflated "no plist at all" with "plist present but wrong", so a
  // perfectly healthy machine that simply is not launchd-managed got a `future-repair` notice.
  // It surfaced by polluting an unrelated test's attention items — the suite caught what the
  // review did not.
  const base = { platform: 'darwin', machineId: 'm1' };

  it('SILENT when safe and not launchd-managed — nothing to lose on restart', () => {
    const v = evaluateProcessCeiling({ ...base, effective: 2048, plistCeilings: [], plistPresent: false });
    expect(v.state).toBe('unknown');
    if (v.state === 'unknown') expect(v.reason).toBe('not-applicable');
  });

  it('still WARNS when safe and the plist EXISTS but is wrong — the real risk is unchanged', () => {
    const v = evaluateProcessCeiling({ ...base, effective: 4096, plistCeilings: [512, 512], plistPresent: true });
    expect(v.state).toBe('future-repair');
  });

  it('still warns when the plist exists but could not be parsed', () => {
    const v = evaluateProcessCeiling({ ...base, effective: 4096, plistCeilings: [], plistPresent: true });
    expect(v.state).toBe('future-repair');
  });

  it('an UNSAFE machine is still reported even with no plist — it needs looking at either way', () => {
    const v = evaluateProcessCeiling({ ...base, effective: 512, plistCeilings: [], plistPresent: false });
    expect(v.state).toBe('repair');
  });

  it('defaults to the STRICTER reading when the flag is omitted — no silent suppression', () => {
    const v = evaluateProcessCeiling({ ...base, effective: 4096, plistCeilings: [] });
    expect(v.state).toBe('future-repair');
  });
});
