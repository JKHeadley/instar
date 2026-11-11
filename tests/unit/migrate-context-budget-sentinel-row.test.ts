/**
 * Agent Awareness + Migration Parity (context-budget-layered-summaries §7.8/§9.1):
 * new agents get the "does compaction recovery work" Registry-First row from
 * generateClaudeMd; existing agents get it from migrateClaudeMd — inserted after
 * the "What are we working on?" row, once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-cb-row-')); fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true }); });
afterEach(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/migrate-context-budget-sentinel-row.test.ts' }));

const migrator = () => new PostUpdateMigrator({ projectDir: tmp, stateDir: path.join(tmp, '.instar'), port: 4242, hasTelegram: false, projectName: 'test' }) as unknown as { migrateClaudeMd: (r: { upgraded: string[]; skipped: string[]; errors: string[] }) => void };
const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
const TABLE = `# CLAUDE.md

| Question | Check First |
|----------|-------------|
| What can I do? | \`curl http://localhost:4242/capabilities\` |
| Who do I work with? | \`.instar/USER.md\` |
`;

describe('Context Budget sentinel Registry-First row', () => {
  it('existing agents: inserted once, right after "What are we working on?", with this agent\'s port', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), TABLE);
    const r = result();
    migrator().migrateClaudeMd(r);
    migrator().migrateClaudeMd(result());
    const out = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8');
    expect(out.match(/\/context-budget\/sentinel/g)?.length).toBe(1);
    const lines = out.split('\n');
    const at = lines.findIndex((l) => l.startsWith('| What are we working on?'));
    expect(lines[at + 1]).toContain('http://localhost:4242/context-budget/sentinel');
    expect(r.upgraded).toContain('CLAUDE.md: added the Context Budget sentinel Registry-First row');
  });

  it('existing agents with the older row: extended in place with the §17 rows, once', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), TABLE);
    migrator().migrateClaudeMd(result());
    const p = path.join(tmp, 'CLAUDE.md');
    // Simulate an agent migrated before the rows existed.
    const older = fs.readFileSync(p, 'utf8').replace(/plus any quarantined or unreadable context folds, [^`]*`layerFreshness`[^\n]*?exists\)\. `503`/, 'plus any quarantined or unreadable context folds. `503`');
    expect(older).not.toContain('eligibleWithoutFold');
    fs.writeFileSync(p, older);
    const r = result();
    migrator().migrateClaudeMd(r);
    migrator().migrateClaudeMd(result());
    const out = fs.readFileSync(p, 'utf8');
    expect(out.match(/eligibleWithoutFold/g)?.length).toBe(1);
    expect(out).toContain('`layerFreshness`');
    expect(out).toContain('`holdHealth`');
    expect(r.upgraded).toContain('CLAUDE.md: extended the Context Budget sentinel row with its freshness, hold-health and no-fold rows');
  });

  it('existing agents with the pre-S16 row: refreshed once to name the canary\'s counted state', () => {
    const old = TABLE.replace('| Who do I work with?', '| Does compaction recovery work on this machine? / is a context fold stuck? | `curl http://localhost:4242/context-budget/sentinel` — (`uninitialized` = none seen; `n/a` = recovery switched off), plus any quarantined or unreadable context folds. |\n| Who do I work with?');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), old);
    const r = result();
    migrator().migrateClaudeMd(r);
    const r2 = result();
    migrator().migrateClaudeMd(r2);
    const out = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8');
    expect(out.match(/`counted` = an engine/g)?.length).toBe(1);
    expect(r.upgraded).toContain("CLAUDE.md: the Context Budget sentinel row names the canary's counted state");
    expect(r2.upgraded).not.toContain("CLAUDE.md: the Context Budget sentinel row names the canary's counted state");
  });

  it('new agents: generateClaudeMd carries the same row (with the counted state)', () => {
    expect(generateClaudeMd('test', 'Echo', 4242, false)).toContain('`counted` = an engine such as Codex');

    const md = generateClaudeMd('test', 'Echo', 4242, false);
    expect(md).toContain('http://localhost:4242/context-budget/sentinel');
    expect(md.match(/\/context-budget\/sentinel/g)?.length).toBe(1);
    expect(md).toContain('`eligibleWithoutFold`');
  });
});
