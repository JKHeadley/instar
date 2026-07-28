// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1 unit tests for the LLM-Decision Quality Meter CLAUDE.md awareness block
 * (docs/specs/llm-decision-quality-meter.md §6 — Migration parity & agent awareness):
 *   - generateClaudeMd (new agents via init) includes the awareness section;
 *   - migrateClaudeMd (existing agents via update) appends it, content-sniffed + idempotent;
 *   - the section function uses the injected port (never hardcoded);
 *   - template and migrator share ONE source (the PR #1450 single-source lesson).
 * Mirrors doorway-claudemd-migration.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { DECISION_QUALITY_CLAUDEMD_SECTION, PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MARKER = 'LLM-Decision Quality Meter';

describe('Decision-quality CLAUDE.md awareness (Agent Awareness Standard)', () => {
  it('generateClaudeMd (new-install path) includes the awareness section with the read + grade-pass surfaces', () => {
    const md = generateClaudeMd('my-proj', 'echo', 4042, true);
    expect(md).toContain(MARKER);
    expect(md).toContain('http://localhost:4042/decision-quality');
    expect(md).toContain('/decision-quality/grade-pass');
    // 503-when-dark honesty + the proactive trigger + the census-debt note.
    expect(md).toContain('503 when the seam is dark');
    expect(md).toContain('read the meter, don\'t guess');
    expect(md).toContain('Census debt is re-surfaced on every read');
  });

  it('the section function honors the injected port (never hardcoded)', () => {
    const s = DECISION_QUALITY_CLAUDEMD_SECTION(9999);
    expect(s).toContain('http://localhost:9999/decision-quality');
    expect(s).not.toContain('localhost:4042');
  });

  it('aggregates are presented evidence-strength-first with the insufficient-evidence honesty marker', () => {
    const s = DECISION_QUALITY_CLAUDEMD_SECTION(4042);
    expect(s).toContain('evidence-strength-FIRST');
    expect(s).toContain('insufficient-evidence: true');
  });
});

describe('migrateClaudeMd appends the decision-quality section for existing agents (Migration Parity), idempotently', () => {
  let projectDir: string;
  let stateDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-quality-claudemd-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'x', port: 4042 }));
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    // A CLAUDE.md that does NOT yet carry the decision-quality section.
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — legacy agent\n\nSome existing content.\n');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/decision-quality-claudemd-migration.test.ts' });
  });

  function countMarker(): number {
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    return content.split(MARKER).length - 1;
  }

  it('adds the section on first migrate, then is a no-op on a second run (content-sniffed)', () => {
    expect(countMarker()).toBe(0);
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' } as any).migrate();
    expect(countMarker()).toBe(1);
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toContain('/decision-quality/grade-pass');
    // Second run must not double-append.
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' } as any).migrate();
    expect(countMarker()).toBe(1);
  });

  it('does NOT re-append when the section is already present', () => {
    fs.appendFileSync(claudeMdPath, DECISION_QUALITY_CLAUDEMD_SECTION(4042));
    expect(countMarker()).toBe(1);
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' } as any).migrate();
    expect(countMarker()).toBe(1);
  });
});
