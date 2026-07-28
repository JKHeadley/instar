// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1 unit tests for the Benchmark-Divergence Detector's migration parity +
 * agent awareness (benchmark-divergence-detector §Migration parity):
 *   - migrateConfigBenchmarkDivergenceDark seeds the dark block on existing
 *     agents (enabled OMITTED — the developmentAgent gate), strips a
 *     default-shaped enabled:false, preserves an explicit true, idempotent;
 *   - generateClaudeMd (new agents) + migrateClaudeMd (existing agents) carry
 *     the awareness section, content-sniffed + idempotent, one shared source.
 * Mirrors decision-quality-claudemd-migration.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import {
  BENCHMARK_DIVERGENCE_CLAUDEMD_SECTION,
  migrateConfigBenchmarkDivergenceDark,
  PostUpdateMigrator,
} from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MARKER = 'Benchmark-Divergence Detector';

describe('migrateConfigBenchmarkDivergenceDark (config seed + #1001 strip)', () => {
  it('seeds the block DARK when absent: dryRun:true + retention knob, enabled OMITTED', () => {
    const config: Record<string, unknown> = {};
    expect(migrateConfigBenchmarkDivergenceDark(config)).toBe(true);
    expect(config.benchmarkDivergence).toEqual({ dryRun: true, byModelRetentionDays: 180 });
    expect(Object.prototype.hasOwnProperty.call(config.benchmarkDivergence, 'enabled')).toBe(false);
  });

  it('strips a default-shaped enabled:false (would force-dark even a dev agent)', () => {
    const config: Record<string, unknown> = { benchmarkDivergence: { enabled: false, dryRun: true } };
    expect(migrateConfigBenchmarkDivergenceDark(config)).toBe(true);
    expect(config.benchmarkDivergence).toEqual({ dryRun: true });
  });

  it('preserves an explicit true (operator fleet-flip) and every operator knob', () => {
    const config: Record<string, unknown> = { benchmarkDivergence: { enabled: true, divergenceThreshold: 0.2 } };
    expect(migrateConfigBenchmarkDivergenceDark(config)).toBe(false);
    expect(config.benchmarkDivergence).toEqual({ enabled: true, divergenceThreshold: 0.2 });
  });

  it('is idempotent — a second run changes nothing', () => {
    const config: Record<string, unknown> = {};
    migrateConfigBenchmarkDivergenceDark(config);
    const snapshot = JSON.parse(JSON.stringify(config));
    expect(migrateConfigBenchmarkDivergenceDark(config)).toBe(false);
    expect(config).toEqual(snapshot);
  });
});

describe('Benchmark-divergence CLAUDE.md awareness (Agent Awareness Standard)', () => {
  it('generateClaudeMd (new-install path) includes the awareness section with all three routes', () => {
    const md = generateClaudeMd('my-proj', 'echo', 4042, true);
    expect(md).toContain(MARKER);
    expect(md).toContain('http://localhost:4042/benchmark-divergence');
    expect(md).toContain('/benchmark-divergence/analyze');
    expect(md).toContain('503 when the detector is dark');
    expect(md).toContain('read the findings, don\'t guess');
    expect(md).toContain('advisory: true');
  });

  it('the section function honors the injected port (never hardcoded)', () => {
    const s = BENCHMARK_DIVERGENCE_CLAUDEMD_SECTION(9999);
    expect(s).toContain('http://localhost:9999/benchmark-divergence');
    expect(s).not.toContain('localhost:4042');
  });

  it('names the precondition-first honesty + the divergent-better inflation-first framing', () => {
    const s = BENCHMARK_DIVERGENCE_CLAUDEMD_SECTION(4042);
    expect(s).toContain('precondition-FIRST');
    expect(s).toContain('never blames or credits a model');
    expect(s).toContain('is the grade-rate inflated?');
  });
});

describe('migrateClaudeMd appends the section for existing agents (Migration Parity), idempotently', () => {
  let projectDir: string;
  let stateDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-claudemd-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'x', port: 4042 }));
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — legacy agent\n\nSome existing content.\n');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/benchmark-divergence-migration.test.ts' });
  });

  function countMarker(): number {
    return fs.readFileSync(claudeMdPath, 'utf-8').split(MARKER).length - 1;
  }

  it('adds the section on first migrate, then is a no-op on a second run (content-sniffed)', () => {
    expect(countMarker()).toBe(0);
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' } as any).migrate();
    expect(countMarker()).toBe(1);
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toContain('/benchmark-divergence/analyze');
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' } as any).migrate();
    expect(countMarker()).toBe(1);
  });

  it('the migrator also seeds the dark config block for existing agents', () => {
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' } as any).migrate();
    const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
    expect(config.benchmarkDivergence).toEqual({ dryRun: true, byModelRetentionDays: 180 });
    expect(Object.prototype.hasOwnProperty.call(config.benchmarkDivergence, 'enabled')).toBe(false);
  });
});
