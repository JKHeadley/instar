/**
 * Agent Awareness + Migration Parity (context-budget-layered-summaries §6 row U, §8):
 * new agents get the user-corpus Registry-First row from generateClaudeMd;
 * existing agents get it from migrateClaudeMd, inserted once after the Context
 * Budget sentinel row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-cb-u-row-')); fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true }); });
afterEach(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/migrate-context-budget-user-corpus-row.test.ts' }));

const migrator = () => new PostUpdateMigrator({ projectDir: tmp, stateDir: path.join(tmp, '.instar'), port: 4242, hasTelegram: false, projectName: 'test' }) as unknown as { migrateClaudeMd: (r: { upgraded: string[]; skipped: string[]; errors: string[] }) => void };
const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
const TABLE = `# CLAUDE.md

| Question | Check First |
|----------|-------------|
| What can I do? | \`curl http://localhost:4242/capabilities\` |
| Who do I work with? | \`.instar/USER.md\` |
`;

describe('Context Budget user-corpus Registry-First row', () => {
  it('existing agents: inserted once, right after the sentinel row, with this agent\'s port', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), TABLE.replace('| Who do I work with?', '| What are we working on? | x |\n| Who do I work with?'));
    const r = result();
    migrator().migrateClaudeMd(r);
    migrator().migrateClaudeMd(result());
    const out = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8');
    expect(out.match(/\/user-corpus/g)?.length).toBe(1);
    const lines = out.split('\n');
    const at = lines.findIndex((l) => l.startsWith('| Does compaction recovery work on this machine?'));
    expect(at).toBeGreaterThan(-1);
    // Other Context Budget rows (e.g. the delta-shadow row) also insert right after the
    // sentinel row, so the U row sits inside that contiguous Context Budget block — never
    // before the sentinel and never past an unrelated row.
    const u = lines.findIndex((l) => l.includes('http://localhost:4242/topic/N/user-corpus'));
    expect(u).toBeGreaterThan(at);
    for (const l of lines.slice(at + 1, u)) expect(l).toContain('/context-budget/');
    expect(r.upgraded).toContain('CLAUDE.md: added the Context Budget user-corpus Registry-First row');
  });

  it('new agents: generateClaudeMd carries the same row once', () => {
    const md = generateClaudeMd('test', 'Echo', 4242, false);
    expect(md.match(/\/topic\/N\/user-corpus/g)?.length).toBe(1);
    expect(md).toContain('http://localhost:4242/topic/N/user-corpus');
  });
});
