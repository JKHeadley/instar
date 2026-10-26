// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Agent Awareness + Migration Parity for the console follow-up reads
 * (GET /preferences, GET /api/files/search): new agents get both lines from
 * generateClaudeMd; existing agents get them from migrateClaudeMd, placed after the
 * sibling line when it exists, appended otherwise, and never twice.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator, PREFERENCES_LIST_CLAUDEMD_LINE, FILES_SEARCH_CLAUDEMD_LINE } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('console follow-up reads: CLAUDE.md awareness', () => {
  it('new agents: generateClaudeMd carries both lines with the injected port', () => {
    const md = generateClaudeMd('p', 'echo', 4321, true);
    expect(md).toContain(PREFERENCES_LIST_CLAUDEMD_LINE(4321));
    expect(md).toContain(FILES_SEARCH_CLAUDEMD_LINE(4321));
    expect(PREFERENCES_LIST_CLAUDEMD_LINE(9999)).toContain('http://localhost:9999/preferences`');
    expect(FILES_SEARCH_CLAUDEMD_LINE(9999)).toContain('localhost:9999/api/files/search');
  });

  describe('existing agents: migrateClaudeMd', () => {
    let projectDir: string;
    let stateDir: string;
    let md: string;
    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-followup-claudemd-'));
      stateDir = path.join(projectDir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'x', port: 4042 }));
      md = path.join(projectDir, 'CLAUDE.md');
    });
    afterEach(() => { SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/console-followup-claudemd-migration.test.ts' }); });
    const migrate = () => new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0', port: 4042 } as any).migrate();

    it('places each line right after its sibling line, once', () => {
      const prefsSibling = '- See the active block: `curl http://localhost:4042/preferences/session-context` — the block.';
      const filesSibling = '- **Generate a file link**: `curl "http://localhost:4042/api/files/link?path=.claude/CLAUDE.md"`';
      fs.writeFileSync(md, `# legacy\n\n${prefsSibling}\n- next pref line\n\n${filesSibling}\n- next files line\n`);
      migrate();
      const after = fs.readFileSync(md, 'utf-8');
      expect(after).toContain(`${prefsSibling}\n${PREFERENCES_LIST_CLAUDEMD_LINE(4042)}\n- next pref line`);
      expect(after).toContain(`${filesSibling}\n${FILES_SEARCH_CLAUDEMD_LINE(4042)}\n- next files line`);
      migrate();
      const again = fs.readFileSync(md, 'utf-8');
      expect(count(again, PREFERENCES_LIST_CLAUDEMD_LINE(4042))).toBe(1);
      expect(count(again, FILES_SEARCH_CLAUDEMD_LINE(4042))).toBe(1);
    });

    it('a CLAUDE.md without the sibling lines still learns both routes, once', () => {
      fs.writeFileSync(md, '# legacy\n\nnothing here\n');
      migrate();
      migrate();
      const after = fs.readFileSync(md, 'utf-8');
      expect(count(after, '/api/files/search')).toBe(1);
      expect(count(after, 'localhost:4042/preferences`')).toBe(1);
    });
  });
});
