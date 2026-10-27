/**
 * Migration Parity for reaper-pressure-signals: every DEPLOYED agent already carries the
 * "SessionReaper — CPU-aware pressure + decision audit" section, so the install-if-missing
 * branch can never reach them. The new sentence (cpuBusyPct + the kernel compressor grade)
 * must therefore be swapped IN PLACE, or deployed agents keep telling users the 1-min load
 * average decides the CPU tier. Review finding 3 (round 1) caught exactly that gap.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
}
function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

/** The sentence every pre-reaper-pressure-signals agent carries, verbatim. */
const LEGACY = 'The idle-session reaper\'s pressure is **CPU-aware**: the tier is the WORST of memory (free %) and CPU (1-min load ÷ cores), so a CPU-bound box raises pressure even when free RAM is fine. Tune the CPU thresholds in `.instar/config.json` → `{"monitoring": {"sessionReaper": {"cpuModerateLoadPerCore": 1.0, "cpuCriticalLoadPerCore": 1.5}}}`. `GET /sessions/reaper`\'s `pressure.inputs` shows freePct, loadPerCore, and the memTier/cpuTier breakdown.';

/** A deployed agent's CLAUDE.md: the section is already present, carrying the legacy sentence. */
function deployedSection(): string {
  return [
    '# CLAUDE.md',
    '',
    '## SessionReaper — CPU-aware pressure + decision audit',
    '',
    LEGACY,
    '',
    'A silent **decision audit** records every keep/kill decision *change* plus the reap-path events.',
    '- Read the tail: `curl "http://localhost:4040/sessions/reaper/audit?limit=50"` → `{ entries: [...] }`.',
    '',
  ].join('\n');
}

describe('PostUpdateMigrator — reaper pressure sentence (reaper-pressure-signals)', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-reaper-pressure-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-reaperPressureSentence.test.ts:cleanup' });
  });

  it('a FRESH CLAUDE.md gets the section carrying the NEW sentence (never the legacy one)', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('cpuBusyPct');
    expect(after).toContain('kernelMemoryPressureLevel');
    expect(after).toContain("cpuSignal: 'load'");
    expect(after).not.toContain('CPU (1-min load ÷ cores)');
  });

  it('a DEPLOYED agent (section already present) has the legacy sentence REPLACED in place', () => {
    fs.writeFileSync(claudeMdPath, deployedSection());
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('reaper pressure sentence in place'))).toBe(true);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('cpuBusyPct');
    expect(after).toContain('kernelMemoryPressureLevel');
    expect(after).not.toContain('CPU (1-min load ÷ cores)');
    // the rest of the section is untouched: the audit paragraph + its bullet survive, and the
    // section is not duplicated by an append.
    expect(after).toContain('A silent **decision audit** records every keep/kill decision');
    expect(after.match(/## SessionReaper — CPU-aware pressure \+ decision audit/g)?.length).toBe(1);
  });

  it('is idempotent — a second pass neither re-replaces nor appends', () => {
    fs.writeFileSync(claudeMdPath, deployedSection());
    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');
    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded.some((u) => u.includes('reaper pressure sentence in place'))).toBe(false);
  });

  it('a DRIFTED section (operator-edited sentence) is left alone rather than clobbered', () => {
    // No legacy sentence to match and no cpuBusyPct: the migration must NOT invent a patch over
    // text the operator rewrote — it skips, and the drift stays visible.
    const drifted = deployedSection().replace(LEGACY, 'My own notes about reaper pressure.');
    fs.writeFileSync(claudeMdPath, drifted);
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('My own notes about reaper pressure.');
    expect(result.upgraded.some((u) => u.includes('reaper pressure sentence in place'))).toBe(false);
  });
});

/** The FULL bullet an older `templates.ts` wrote at init (Form B), verbatim. */
const LEGACY_TEMPLATE_BULLET = `- Pressure is **CPU-aware**: the tier is the WORST of memory (free %) and CPU (1-min load ÷ cores), so a CPU-bound box raises pressure even when free RAM is fine. Tune the CPU thresholds in \`.instar/config.json\` → \`{"monitoring": {"sessionReaper": {"cpuModerateLoadPerCore": 1.0, "cpuCriticalLoadPerCore": 1.5}}}\`.`;

/** A TEMPLATE-initialized agent: the section is present in bullet form, not as the migrator's sentence. */
function templateInitialized(): string {
  return [
    '# CLAUDE.md',
    '',
    '## SessionReaper — CPU-aware pressure + decision audit',
    '',
    LEGACY_TEMPLATE_BULLET,
    '- See current state / why each session is kept or flagged: `curl http://localhost:4042/sessions/reaper`.',
    '- Read the tail: `curl "http://localhost:4040/sessions/reaper/audit?limit=50"`.',
    '',
  ].join('\n');
}

describe('PostUpdateMigrator — reaper pressure, Form B (template-initialized agents)', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-reaper-formb-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-reaperPressureSentence.test.ts:cleanupB' });
  });

  it('the template bullet is replaced WHOLE — no stale load-threshold sentence survives', () => {
    // The round-2 re-check: a prefix match would leave "Tune the CPU thresholds …
    // cpuModerateLoadPerCore" behind, so the agent would read the new text and then be told
    // the load knobs are the tuning controls.
    fs.writeFileSync(claudeMdPath, templateInitialized());
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('reaper pressure sentence in place'))).toBe(true);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('cpuBusyPct');
    expect(after).not.toContain('CPU (1-min load ÷ cores)');
    expect(after).not.toContain('cpuModerateLoadPerCore');   // the stale tuning sentence is GONE
    expect(after).not.toContain('Tune the CPU thresholds');
  });

  it('is idempotent on a Form-B file', () => {
    fs.writeFileSync(claudeMdPath, templateInitialized());
    runClaudeMdMigration(newMigrator(projectDir));
    const first = fs.readFileSync(claudeMdPath, 'utf-8');
    runClaudeMdMigration(newMigrator(projectDir));
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toBe(first);
  });
});
