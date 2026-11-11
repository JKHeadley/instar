/**
 * Agent Awareness + Migration Parity (context-budget-layered-summaries §9.5,
 * Phase 1 S10): new agents get the standing-packet Registry-First row from
 * generateClaudeMd; existing agents get it from migrateClaudeMd, inserted once
 * after the H3 row (which the same run inserts first on an older file).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-cb-sp-row-')); fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true }); });
afterEach(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/migrate-context-budget-standing-packet-row.test.ts' }));

const migrator = () => new PostUpdateMigrator({ projectDir: tmp, stateDir: path.join(tmp, '.instar'), port: 4242, hasTelegram: false, projectName: 'test' }) as unknown as { migrateClaudeMd: (r: { upgraded: string[]; skipped: string[]; errors: string[] }) => void };
const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
const TABLE = `# CLAUDE.md

| Question | Check First |
|----------|-------------|
| What can I do? | \`curl http://localhost:4242/capabilities\` |
| What are we working on? | x |
| Who do I work with? | \`.instar/USER.md\` |
`;
const PREV = '| What is the whole story of topic N so far?';

describe('Context Budget standing-packet Registry-First row', () => {
  it('existing agents: inserted once, right after the H3 row, with this agent\'s port', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), TABLE);
    const r = result();
    migrator().migrateClaudeMd(r);
    migrator().migrateClaudeMd(result());
    const out = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8');
    expect(out.match(/\/topic\/N\/standing-packet/g)?.length).toBe(1);
    const lines = out.split('\n');
    const at = lines.findIndex((l) => l.startsWith(PREV));
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toContain('http://localhost:4242/topic/N/standing-packet');
    expect(r.upgraded).toContain('CLAUDE.md: added the Context Budget standing-packet Registry-First row');
  });

  it('new agents: generateClaudeMd carries the same row once, after the H3 row, identical to the migrated one', () => {
    const md = generateClaudeMd('test', 'Echo', 4242, false);
    expect(md.match(/\/topic\/N\/standing-packet/g)?.length).toBe(1);
    const lines = md.split('\n');
    const at = lines.findIndex((l) => l.startsWith(PREV));
    expect(lines[at + 1]).toContain('http://localhost:4242/topic/N/standing-packet');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), TABLE);
    migrator().migrateClaudeMd(result());
    const migrated = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8').split('\n').find((l) => l.includes('/topic/N/standing-packet'));
    expect(migrated).toBe(lines[at + 1]);
  });
});
