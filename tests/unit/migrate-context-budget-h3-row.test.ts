/**
 * Agent Awareness + Migration Parity (context-budget-layered-summaries §6 row H3):
 * new agents get the H3 Registry-First row (summarize returns H3, POST
 * /topic/summary returns 409 while the layers are on) from generateClaudeMd;
 * existing agents get it from migrateClaudeMd, inserted once after the
 * anchor-ledger row (which the same run inserts first on an older file).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-cb-h3-row-')); fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true }); });
afterEach(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/migrate-context-budget-h3-row.test.ts' }));

const migrator = () => new PostUpdateMigrator({ projectDir: tmp, stateDir: path.join(tmp, '.instar'), port: 4242, hasTelegram: false, projectName: 'test' }) as unknown as { migrateClaudeMd: (r: { upgraded: string[]; skipped: string[]; errors: string[] }) => void };
const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
const TABLE = `# CLAUDE.md

| Question | Check First |
|----------|-------------|
| What can I do? | \`curl http://localhost:4242/capabilities\` |
| What are we working on? | x |
| Who do I work with? | \`.instar/USER.md\` |
`;

const PREV = "| What is topic N for? / which of the operator's decisions are settled";
describe('Context Budget H3 Registry-First row', () => {
  it('existing agents: inserted once, right after the anchor-ledger row, with this agent\'s port', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), TABLE);
    const r = result();
    migrator().migrateClaudeMd(r);
    migrator().migrateClaudeMd(result());
    const out = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8');
    expect(out.match(/summary-written-by-h3/g)?.length).toBe(1);
    const lines = out.split('\n');
    const at = lines.findIndex((l) => l.startsWith(PREV));
    // Sibling Context Budget rows (anchor, backfill, H3, delta…) share this anchor point; ours sits inside that contiguous block.
    const own = lines.findIndex((l, k) => k > at && l.includes('http://localhost:4242/topic/summarize'));
    expect(own).toBeGreaterThan(at);
    for (const l of lines.slice(at + 1, own)) expect(l).toMatch(/\/context-budget\/|\/topic\/N\/|\/topic\/summar/);
    expect(at).toBeGreaterThan(-1);
    expect(lines[own]).toContain('http://localhost:4242/topic/summarize');
    expect(lines[own]).toContain('writer: h3');
    expect(r.upgraded).toContain('CLAUDE.md: added the Context Budget H3 Registry-First row');
  });

  it('new agents: generateClaudeMd carries the same row once, after the anchor-ledger row, identical to the migrated one', () => {
    const md = generateClaudeMd('test', 'Echo', 4242, false);
    expect(md.match(/summary-written-by-h3/g)?.length).toBe(1);
    const lines = md.split('\n');
    const at = lines.findIndex((l) => l.startsWith(PREV));
    // Sibling Context Budget rows (anchor, backfill, H3, delta…) share this anchor point; ours sits inside that contiguous block.
    const own = lines.findIndex((l, k) => k > at && l.includes('http://localhost:4242/topic/summarize'));
    expect(own).toBeGreaterThan(at);
    for (const l of lines.slice(at + 1, own)) expect(l).toMatch(/\/context-budget\/|\/topic\/N\/|\/topic\/summar/);
    expect(lines[own]).toContain('http://localhost:4242/topic/summarize');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), TABLE);
    migrator().migrateClaudeMd(result());
    const migrated = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8').split('\n').find((l) => l.includes('summary-written-by-h3'));
    expect(migrated).toBe(lines[own]);
  });
});
