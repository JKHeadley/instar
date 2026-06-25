/**
 * Agent Awareness (gate-prompts-judge-by-meaning §Migration): every agent must
 * learn that its outbound messages pass an LLM gate judging by MEANING (so a
 * reword does not evade the self-stop rules). Verifies the note ships to new
 * installs (generateClaudeMd) AND backfills to deployed agents (migrateClaudeMd,
 * idempotent). The framework-shadow marker ('### Outbound Message Gate') is
 * registered in PostUpdateMigrator's markers array so it mirrors to AGENTS.md /
 * GEMINI.md — asserted here via the generated section heading the slicer keys on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

const HEADING = '### Outbound Message Gate';
const MEANING = 'by MEANING, not by literal phrases';

describe('Outbound Message Gate — agent awareness', () => {
  it('new installs: generateClaudeMd includes the Outbound Message Gate section', () => {
    const md = generateClaudeMd({ agentName: 'echo', projectName: 'instar', port: 4042 } as never);
    expect(md).toContain(HEADING);
    expect(md).toContain(MEANING);
    expect(md).toContain('FAILS CLOSED');
  });

  describe('deployed agents: migrateClaudeMd backfill', () => {
    let projectDir: string;
    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omg-mig-'));
    });
    afterEach(() => {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/outbound-message-gate-awareness.test.ts' });
    });

    it('appends the section, idempotently', () => {
      const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
      fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nExisting content.\n');
      const migrator = new PostUpdateMigrator({ projectDir, stateDir: projectDir, port: 4042, hasTelegram: false, projectName: 'test' });
      const run = () =>
        (migrator as unknown as { migrateClaudeMd(r: { upgraded: string[]; skipped: string[]; errors: string[] }): void }).migrateClaudeMd({
          upgraded: [],
          skipped: [],
          errors: [],
        });
      run();
      const after = fs.readFileSync(claudeMdPath, 'utf-8');
      expect(after).toContain(HEADING);
      expect(after).toContain(MEANING);
      run();
      const occurrences = fs.readFileSync(claudeMdPath, 'utf-8').split(HEADING).length - 1;
      expect(occurrences).toBe(1);
    });
  });
});
