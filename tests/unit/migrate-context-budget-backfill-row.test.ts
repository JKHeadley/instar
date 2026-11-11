/**
 * Agent Awareness + Migration Parity (context-budget-layered-summaries §6.1, S7):
 * new agents get the backfill Registry-First row from generateClaudeMd;
 * existing agents get it from migrateClaudeMd, inserted once after the Context
 * Budget anchor-ledger row (which the same run inserts first on an older file).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-cb-backfill-row-')); fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true }); });
afterEach(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/migrate-context-budget-backfill-row.test.ts' }));

const migrator = () => new PostUpdateMigrator({ projectDir: tmp, stateDir: path.join(tmp, '.instar'), port: 4242, hasTelegram: false, projectName: 'test' }) as unknown as { migrateClaudeMd: (r: { upgraded: string[]; skipped: string[]; errors: string[] }) => void };
const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
const TABLE = `# CLAUDE.md

| Question | Check First |
|----------|-------------|
| What can I do? | \`curl http://localhost:4242/capabilities\` |
| What are we working on? | x |
| Who do I work with? | \`.instar/USER.md\` |
`;
const ANCHOR_ROW = "| What is topic N for? / which of the operator's decisions are settled";

describe('Context Budget backfill Registry-First row', () => {
  it('existing agents: inserted once, right after the anchor-ledger row, with this agent\'s port', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), TABLE);
    const r = result();
    migrator().migrateClaudeMd(r);
    migrator().migrateClaudeMd(result());
    const out = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8');
    expect(out.match(/anchors\.backfill/g)?.length).toBe(1);
    const lines = out.split('\n');
    const at = lines.findIndex((l) => l.startsWith(ANCHOR_ROW));
    // Sibling Context Budget rows (anchor, backfill, H3, delta…) share this anchor point; ours sits inside that contiguous block.
    const own = lines.findIndex((l, k) => k > at && l.includes('never a message of its own'));
    expect(own).toBeGreaterThan(at);
    for (const l of lines.slice(at + 1, own)) expect(l).toMatch(/\/context-budget\/|\/topic\/N\/|\/topic\/summar/);
    expect(at).toBeGreaterThan(-1);
    expect(lines[own]).toContain('http://localhost:4242/context-budget/metrics');
    expect(lines[own]).toContain('never a message of its own');
    expect(r.upgraded).toContain('CLAUDE.md: added the Context Budget backfill Registry-First row');
  });

  it('new agents: generateClaudeMd carries the same row once, after the anchor-ledger row', () => {
    const md = generateClaudeMd('test', 'Echo', 4242, false);
    expect(md.match(/anchors\.backfill/g)?.length).toBe(1);
    const lines = md.split('\n');
    const at = lines.findIndex((l) => l.startsWith(ANCHOR_ROW));
    // Sibling Context Budget rows (anchor, backfill, H3, delta…) share this anchor point; ours sits inside that contiguous block.
    const own = lines.findIndex((l, k) => k > at && l.includes('never a message of its own'));
    expect(own).toBeGreaterThan(at);
    for (const l of lines.slice(at + 1, own)) expect(l).toMatch(/\/context-budget\/|\/topic\/N\/|\/topic\/summar/);
    expect(lines[own]).toContain('http://localhost:4242/context-budget/metrics');
  });
});
