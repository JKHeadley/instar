import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { conversationsSuggestionsAwareness } from '../../src/messaging/shared/conversationGraphChat.js';

describe('Conversations suggestions awareness (conversation-graph-suggestions.md)', () => {
  it('renders on new agents and is added once to existing agents', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-conv-suggestions-awareness-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir);
    const file = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(file, '# Agent\n');
    try {
      const card = conversationsSuggestionsAwareness().trim();
      expect(card).toContain('Review suggestions');
      expect(card).toContain('Chief of Staff');
      expect(card).toContain('`GET /conversation-graph/suggestions`');
      expect(generateClaudeMd('test', 'Test', 4042, false)).toContain(card);
      const migrator = new PostUpdateMigrator({ projectDir, stateDir, port: 4042, hasTelegram: false, projectName: 'test' });
      const migrate = () => (migrator as unknown as { migrateClaudeMd(r: { upgraded: string[]; skipped: string[]; errors: string[] }): void })
        .migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
      migrate();
      const first = fs.readFileSync(file, 'utf8');
      expect(first).toContain(card);
      migrate();
      expect(fs.readFileSync(file, 'utf8')).toBe(first);
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true,
        operation: 'tests/unit/PostUpdateMigrator-conversationsSuggestionsAwareness.test.ts' });
    }
  });
});
