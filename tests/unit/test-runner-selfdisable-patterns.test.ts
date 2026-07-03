// safe-git-allow: test-only os.tmpdir fixture cleanup (mkdtemp teardown; no source-tree writes) — matches the tmux-resilience test allowlist precedent.
/**
 * Serverless-host self-disable surface — unit tests (spec
 * docs/specs/test-runner-concurrency-bound.md §2.6(b), §2.9, §5 last bullet).
 *
 * Covers the shared detector (scripts/lib/test-runner-selfdisable-patterns
 * .mjs — the ONE implementation behind both `instar dev:preflight` and the
 * pre-push hook): each pattern flags when sustained, below-threshold does
 * not, torn/malformed ledger lines are tolerated, and a missing ledger warns
 * nothing. Plus THE STRUCTURAL ASSERTION per §5: the pre-push check is
 * WARN-only — the REAL script, spawned against a pattern-heavy fixture
 * ledger, exits 0 with WARN on stderr (ledger content may only ever ADD a
 * warning, never block a push).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error: .mjs script, not typed
import {
  DEFAULT_THRESHOLD,
  DEFAULT_WINDOW_MS,
  PREFLIGHT_FAIL_PATTERNS,
  detectSelfDisablePatterns,
  formatWarnLines,
  isCiHost,
  readLedgerEvents,
  readTuningAuthority,
  resolveLedgerPaths,
  runSelfDisableCheck,
} from '../../scripts/lib/test-runner-selfdisable-patterns.mjs';

import {
  HOST_TEST_SUITE_CAP_DEFAULT,
  HOST_TEST_TARGETED_CAP_DEFAULT,
  resolveTestRunnerPaths,
} from '../../src/core/hostTestRunnerSemaphore.js';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/pre-push-test-runner-selfdisable.mjs', import.meta.url),
);

interface LedgerFinding {
  pattern: string;
  label: string;
  count: number;
  threshold: number;
  windowMs: number;
  lastTs: string | null;
}

const tmpDirs: string[] = [];

function mkFixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trb-selfdisable-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** One ledger event line, shaped like the chokepoint's own emissions. */
function evt(kind: string, fields: Record<string, unknown> = {}, ageMs = 60_000): string {
  return JSON.stringify({
    v: 1,
    ts: new Date(Date.now() - ageMs).toISOString(),
    kind,
    pid: 1234,
    hostname: 'fixture-host',
    posture: 'dry-run',
    suiteCap: 1,
    targetedCap: 6,
    ttlSignalArmed: false,
    tuningHash: 'absent',
    ...fields,
  });
}

function writeLedger(dir: string, lines: string[], file = 'host-test-runner-events.jsonl'): void {
  fs.writeFileSync(path.join(dir, file), lines.join('\n') + '\n');
}

function check(dir: string, opts: Record<string, unknown> = {}) {
  return runSelfDisableCheck({
    paths: resolveLedgerPaths({ INSTAR_HOST_TEST_BASE_DIR: dir }),
    isCiHost: false,
    ...opts,
  }) as {
    ledgerPresent: boolean;
    findings: LedgerFinding[];
    eventsScanned: number;
  };
}

function patternIds(findings: LedgerFinding[]): string[] {
  return findings.map((f) => f.pattern);
}

describe('shared contract with src/core/hostTestRunnerSemaphore', () => {
  it('resolves the SAME frozen ledger/tuning paths as resolveTestRunnerPaths', () => {
    const env = { INSTAR_HOST_TEST_BASE_DIR: '/tmp/trb-contract-pin' } as NodeJS.ProcessEnv;
    const canonical = resolveTestRunnerPaths(env);
    const mirror = resolveLedgerPaths(env);
    expect(mirror.ledger).toBe(canonical.ledger);
    expect(mirror.tuning).toBe(canonical.tuning);
    expect(mirror.baseDir).toBe(canonical.baseDir);
  });

  it('pins the mirrored code-default caps to the canonical constants', async () => {
    // @ts-expect-error: .mjs script, not typed
    const lib = await import('../../scripts/lib/test-runner-selfdisable-patterns.mjs');
    expect(lib.SUITE_CAP_DEFAULT).toBe(HOST_TEST_SUITE_CAP_DEFAULT);
    expect(lib.TARGETED_CAP_DEFAULT).toBe(HOST_TEST_TARGETED_CAP_DEFAULT);
  });
});

describe('sustained `off` skips (§2.6)', () => {
  it('flags at the sustained threshold', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      evt('skip', { reason: 'off', loud: true }),
      evt('skip', { reason: 'off', loud: true }),
      evt('skip', { reason: 'off', loud: true }),
    ]);
    const result = check(dir);
    expect(result.ledgerPresent).toBe(true);
    expect(patternIds(result.findings)).toContain('sustained-off');
    const finding = result.findings.find((f) => f.pattern === 'sustained-off');
    expect(finding?.count).toBe(3);
    expect(finding?.threshold).toBe(DEFAULT_THRESHOLD);
  });

  it('does NOT flag below the threshold', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      evt('skip', { reason: 'off', loud: true }),
      evt('skip', { reason: 'off', loud: true }),
    ]);
    expect(patternIds(check(dir).findings)).not.toContain('sustained-off');
  });

  it('does NOT count events older than the 48h window', () => {
    const dir = mkFixtureDir();
    const old = DEFAULT_WINDOW_MS + 60 * 60 * 1000; // 49h ago
    writeLedger(dir, [
      evt('skip', { reason: 'off', loud: true }, old),
      evt('skip', { reason: 'off', loud: true }, old),
      evt('skip', { reason: 'off', loud: true }, old),
    ]);
    expect(check(dir).findings).toEqual([]);
  });
});

describe('CI-reason skips on a non-CI host (§2.6 spoofed-CI grading)', () => {
  const ciSkips = [
    evt('skip', { reason: 'CI', loud: true }),
    evt('skip', { reason: 'CI', loud: true }),
    evt('skip', { reason: 'CI', loud: false }),
  ];

  it('flags on a non-CI host', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, ciSkips);
    expect(patternIds(check(dir, { isCiHost: false }).findings)).toContain('ci-skip-non-ci-host');
  });

  it('does NOT flag when the detecting host IS a CI runner', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, ciSkips);
    expect(patternIds(check(dir, { isCiHost: true }).findings)).not.toContain(
      'ci-skip-non-ci-host',
    );
  });

  it('isCiHost mirrors the hardened predicate (CI truthy alone is NOT CI)', () => {
    expect(isCiHost({ CI: 'true' })).toBe(false);
    expect(isCiHost({ CI: 'false', GITHUB_ACTIONS: 'true' })).toBe(false);
    expect(isCiHost({ CI: 'true', GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(isCiHost({ CI: '1', RUNNER_OS: 'macOS' })).toBe(true);
  });
});

describe('sustained watch skips (§2.6 — loud = defaulted/agent-context only)', () => {
  it('flags sustained LOUD watch skips', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      evt('skip', { reason: 'watch', loud: true }),
      evt('skip', { reason: 'watch', loud: true }),
      evt('skip', { reason: 'watch', loud: true }),
    ]);
    expect(patternIds(check(dir).findings)).toContain('sustained-watch-skip');
  });

  it('does NOT flag quiet deliberate interactive --watch skips', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      evt('skip', { reason: 'watch', loud: false }),
      evt('skip', { reason: 'watch', loud: false }),
      evt('skip', { reason: 'watch', loud: false }),
      evt('skip', { reason: 'watch', loud: false }),
    ]);
    expect(patternIds(check(dir).findings)).not.toContain('sustained-watch-skip');
  });
});

describe('resolved-cap divergence (§2.9 — stamps >4× authority)', () => {
  it('flags sustained explicit cap-divergence warns', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      evt('warn', { warnType: 'cap-divergence', lane: 'suite', cap: 50 }),
      evt('warn', { warnType: 'cap-divergence', lane: 'suite', cap: 50 }),
      evt('warn', { warnType: 'cap-divergence', lane: 'targeted', cap: 100 }),
    ]);
    expect(patternIds(check(dir).findings)).toContain('resolved-cap-divergence');
  });

  it('flags stamp-derived divergence (per-run cap stamps beyond 4× the authority)', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      evt('acquire', { suiteCap: 50 }),
      evt('acquire', { suiteCap: 50 }),
      evt('release', { suiteCap: 50 }),
    ]);
    // Default authority: suiteCap 1 → 4× margin = 4; 50 diverges.
    expect(patternIds(check(dir).findings)).toContain('resolved-cap-divergence');
  });

  it('does NOT flag stamps within the 4× margin (legit tuning transitions)', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      evt('acquire', { suiteCap: 4, targetedCap: 24 }),
      evt('acquire', { suiteCap: 4, targetedCap: 24 }),
      evt('release', { suiteCap: 4, targetedCap: 24 }),
      evt('release', { suiteCap: 2, targetedCap: 12 }),
    ]);
    expect(patternIds(check(dir).findings)).not.toContain('resolved-cap-divergence');
  });
});

describe('posture divergence (§2.9 — both directions, explicit warns only)', () => {
  it('flags sustained posture-divergence warns in either direction', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      evt('warn', { warnType: 'posture-divergence', direction: 'weaker' }),
      evt('warn', { warnType: 'posture-divergence', direction: 'stronger' }),
      evt('warn', { warnType: 'posture-divergence', direction: 'weaker' }),
    ]);
    expect(patternIds(check(dir).findings)).toContain('posture-divergence');
  });

  it('does NOT infer divergence from posture stamps alone (a legit flip must not false-positive)', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      evt('acquire', { posture: 'enforcing' }),
      evt('acquire', { posture: 'enforcing' }),
      evt('release', { posture: 'enforcing' }),
    ]);
    // Authority is dry-run (no tuning file) but stamps say enforcing: the
    // detector deliberately counts only the chokepoint's explicit warns.
    expect(patternIds(check(dir).findings)).not.toContain('posture-divergence');
  });
});

describe('arm divergence (§2.9 — env-arm-ignored events)', () => {
  it('flags sustained env-arm-ignored warns', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      evt('warn', { warnType: 'env-arm-ignored' }),
      evt('warn', { warnType: 'env-arm-ignored' }),
      evt('warn', { warnType: 'env-arm-ignored' }),
    ]);
    expect(patternIds(check(dir).findings)).toContain('arm-divergence');
  });
});

describe('tolerance + missing-ledger semantics (§2.6)', () => {
  it('tolerates torn/malformed lines and still detects around them', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      '{"v":1,"ts":"2026-07-03T00:00:00.000Z","kind":"ski', // torn mid-write
      'not json at all %%%%',
      '42',
      '{"no":"kind field"}',
      evt('skip', { reason: 'off', loud: true }),
      evt('skip', { reason: 'off', loud: true }),
      ' garbage',
      evt('skip', { reason: 'off', loud: true }),
    ]);
    const result = check(dir);
    expect(result.ledgerPresent).toBe(true);
    expect(patternIds(result.findings)).toContain('sustained-off');
  });

  it('a fully-garbage ledger yields zero findings and never throws', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, ['%%%', '<<<>>>', '{{{{{']);
    const result = check(dir);
    expect(result.ledgerPresent).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('missing ledger → ledgerPresent false, zero findings (nothing to warn)', () => {
    const dir = mkFixtureDir(); // dir exists, no ledger file
    const result = check(dir);
    expect(result.ledgerPresent).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it('counts events living in the newest rotated segment (live + segments)', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [evt('skip', { reason: 'off', loud: true })]);
    writeLedger(
      dir,
      [evt('skip', { reason: 'off', loud: true }), evt('skip', { reason: 'off', loud: true })],
      `host-test-runner-events.${Date.now() - 1000}.jsonl`,
    );
    expect(patternIds(check(dir).findings)).toContain('sustained-off');
  });

  it('events with an unparseable ts are excluded (never flag on garbage)', () => {
    const dir = mkFixtureDir();
    const noTs = (reason: string) =>
      JSON.stringify({ v: 1, ts: 'not-a-date', kind: 'skip', reason, loud: true });
    writeLedger(dir, [noTs('off'), noTs('off'), noTs('off')]);
    expect(check(dir).findings).toEqual([]);
  });
});

describe('tuning authority read (§2.9, tolerant)', () => {
  it('reads a valid tuning file (posture + sanity-clamped caps)', () => {
    const dir = mkFixtureDir();
    fs.writeFileSync(
      path.join(dir, 'host-test-runner-tuning.json'),
      JSON.stringify({ v: 1, enforcing: true, maxConcurrent: 2, targetedMax: 12 }),
    );
    const authority = readTuningAuthority(resolveLedgerPaths({ INSTAR_HOST_TEST_BASE_DIR: dir }));
    expect(authority).toMatchObject({
      posture: 'enforcing',
      suiteCap: 2,
      targetedCap: 12,
    });
  });

  it('falls back to code-defaults on corrupt / out-of-range values', () => {
    const dir = mkFixtureDir();
    fs.writeFileSync(path.join(dir, 'host-test-runner-tuning.json'), '{corrupt');
    const corrupt = readTuningAuthority(resolveLedgerPaths({ INSTAR_HOST_TEST_BASE_DIR: dir }));
    expect(corrupt).toMatchObject({ posture: 'dry-run', suiteCap: 1, targetedCap: 6 });

    fs.writeFileSync(
      path.join(dir, 'host-test-runner-tuning.json'),
      JSON.stringify({ v: 1, maxConcurrent: 999, targetedMax: 0 }),
    );
    const outOfRange = readTuningAuthority(
      resolveLedgerPaths({ INSTAR_HOST_TEST_BASE_DIR: dir }),
    );
    expect(outOfRange).toMatchObject({ suiteCap: 1, targetedCap: 6 });
  });

  it('a raised authority moves the 4× divergence bar', () => {
    const events = [
      JSON.parse(evt('acquire', { suiteCap: 6 })),
      JSON.parse(evt('acquire', { suiteCap: 6 })),
      JSON.parse(evt('acquire', { suiteCap: 6 })),
    ];
    const flagged = detectSelfDisablePatterns(events, {
      isCiHost: false,
      authority: { posture: 'dry-run', suiteCap: 1, targetedCap: 6, ttlSignal: false },
    }) as { findings: LedgerFinding[] };
    expect(patternIds(flagged.findings)).toContain('resolved-cap-divergence');

    const notFlagged = detectSelfDisablePatterns(events, {
      isCiHost: false,
      authority: { posture: 'dry-run', suiteCap: 2, targetedCap: 6, ttlSignal: false },
    }) as { findings: LedgerFinding[] };
    expect(patternIds(notFlagged.findings)).not.toContain('resolved-cap-divergence');
  });
});

describe('formatWarnLines', () => {
  it('renders one advisory WARN line per finding', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      evt('skip', { reason: 'off', loud: true }),
      evt('skip', { reason: 'off', loud: true }),
      evt('skip', { reason: 'off', loud: true }),
    ]);
    const lines = formatWarnLines(check(dir).findings) as string[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('WARN');
    expect(lines[0]).toContain('advisory only');
  });
});

// ── THE STRUCTURAL ASSERTION (§5 last bullet): pre-push is WARN-only ───────

function spawnScript(baseDir: string, args: string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, INSTAR_HOST_TEST_BASE_DIR: baseDir },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

describe('pre-push script is structurally WARN-only (§2.6(b), §5)', () => {
  it('exits 0 with WARN on stderr against a pattern-heavy fixture ledger', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      // Every pattern at sustained volume — the heaviest self-disable ledger.
      evt('skip', { reason: 'off', loud: true }),
      evt('skip', { reason: 'off', loud: true }),
      evt('skip', { reason: 'off', loud: true }),
      evt('skip', { reason: 'off', loud: true }),
      evt('skip', { reason: 'watch', loud: true }),
      evt('skip', { reason: 'watch', loud: true }),
      evt('skip', { reason: 'watch', loud: true }),
      evt('warn', { warnType: 'posture-divergence', direction: 'stronger' }),
      evt('warn', { warnType: 'posture-divergence', direction: 'weaker' }),
      evt('warn', { warnType: 'posture-divergence', direction: 'weaker' }),
      evt('warn', { warnType: 'env-arm-ignored' }),
      evt('warn', { warnType: 'env-arm-ignored' }),
      evt('warn', { warnType: 'env-arm-ignored' }),
      evt('warn', { warnType: 'cap-divergence', lane: 'suite', cap: 50 }),
      evt('warn', { warnType: 'cap-divergence', lane: 'suite', cap: 50 }),
      evt('warn', { warnType: 'cap-divergence', lane: 'suite', cap: 50 }),
    ]);
    const res = spawnScript(dir);
    expect(res.status).toBe(0); // NEVER blocks a push — the load-bearing assertion
    expect(res.stderr).toContain('WARN');
    expect(res.stderr).toContain('test-runner-bound self-disable');
  });

  it('exits 0 silently when no ledger exists (no ledger = nothing to warn)', () => {
    const dir = mkFixtureDir();
    const res = spawnScript(dir);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('WARN');
  });

  it('exits 0 when the base dir itself is missing/unreadable', () => {
    const res = spawnScript(path.join(os.tmpdir(), 'trb-selfdisable-nonexistent-xyz'));
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('WARN');
  });

  it('exits 0 on a fully-corrupt ledger (torn lines tolerated, never an error)', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, ['%%% not json', '{torn', ' binary']);
    const res = spawnScript(dir);
    expect(res.status).toBe(0);
  });
});

describe('dev:preflight mode MAY fail — but only on the unambiguous patterns (§2.6)', () => {
  it('--preflight exits non-zero on sustained `off`', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      evt('skip', { reason: 'off', loud: true }),
      evt('skip', { reason: 'off', loud: true }),
      evt('skip', { reason: 'off', loud: true }),
    ]);
    const res = spawnScript(dir, ['--preflight']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('WARN');
  });

  it('--preflight stays exit 0 (WARN only) on advisory-only patterns', () => {
    const dir = mkFixtureDir();
    writeLedger(dir, [
      evt('skip', { reason: 'watch', loud: true }),
      evt('skip', { reason: 'watch', loud: true }),
      evt('skip', { reason: 'watch', loud: true }),
      evt('warn', { warnType: 'posture-divergence', direction: 'weaker' }),
      evt('warn', { warnType: 'posture-divergence', direction: 'weaker' }),
      evt('warn', { warnType: 'posture-divergence', direction: 'weaker' }),
    ]);
    const res = spawnScript(dir, ['--preflight']);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('WARN');
  });

  it('--preflight exits 0 with a clean note when there is no ledger', () => {
    const dir = mkFixtureDir();
    const res = spawnScript(dir, ['--preflight']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('clean');
  });

  it('PREFLIGHT_FAIL_PATTERNS names exactly the two spec-graded-like-off signatures', () => {
    expect([...PREFLIGHT_FAIL_PATTERNS].sort()).toEqual([
      'ci-skip-non-ci-host',
      'sustained-off',
    ]);
  });
});

describe('dev:preflight integration (runDevPreflight wires the check)', () => {
  it('invokes the shared script in --preflight mode and a failing check fails preflight', async () => {
    const { runDevPreflight, SELF_DISABLE_CHECK_SCRIPT } = await import(
      '../../src/commands/devPreflight.js'
    );
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = {
      run: async (command: string, args: string[]) => {
        calls.push({ command, args });
        const isSelfDisable = args.includes('--preflight');
        return { command, args, exitCode: isSelfDisable ? 1 : 0 };
      },
    };
    const writes: string[] = [];
    const exitCode = await runDevPreflight({
      cwd: process.cwd(),
      runner,
      output: { write: (t: string) => writes.push(t), error: (t: string) => writes.push(t) },
      capabilityPrefixes: new Set<string>(),
      diffProvider: () => '',
    });
    expect(exitCode).toBe(1);
    const selfDisableCall = calls.find((c) => c.args.includes('--preflight'));
    expect(selfDisableCall).toBeDefined();
    expect(selfDisableCall?.command).toBe('node');
    expect(selfDisableCall?.args[0]).toBe(SELF_DISABLE_CHECK_SCRIPT);
    expect(writes.join('')).toContain('test-runner self-disable ledger');
  });

  it('aggregateExitCode treats an absent selfDisableExitCode as pass (older summaries stay valid)', async () => {
    const { aggregateExitCode } = await import('../../src/commands/devPreflight.js');
    expect(
      aggregateExitCode({ lintExitCode: 0, discoverabilityExitCode: 0, routeWarnings: [] }),
    ).toBe(0);
    expect(
      aggregateExitCode({
        lintExitCode: 0,
        discoverabilityExitCode: 0,
        routeWarnings: [],
        selfDisableExitCode: 1,
      }),
    ).toBe(1);
  });
});
