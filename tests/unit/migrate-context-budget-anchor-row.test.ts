/**
 * Agent Awareness + Migration Parity (context-budget-layered-summaries §6.1, §6.2):
 * new agents get the anchor-ledger Registry-First row from generateClaudeMd;
 * existing agents get it from migrateClaudeMd, inserted once after the Context
 * Budget user-corpus row (which the same run inserts first on an older file).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-cb-anchor-row-')); fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true }); });
afterEach(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/migrate-context-budget-anchor-row.test.ts' }));

const migrator = () => new PostUpdateMigrator({ projectDir: tmp, stateDir: path.join(tmp, '.instar'), port: 4242, hasTelegram: false, projectName: 'test' }) as unknown as { migrateClaudeMd: (r: { upgraded: string[]; skipped: string[]; errors: string[] }) => void };
const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
const TABLE = `# CLAUDE.md

| Question | Check First |
|----------|-------------|
| What can I do? | \`curl http://localhost:4242/capabilities\` |
| What are we working on? | x |
| Who do I work with? | \`.instar/USER.md\` |
`;

describe('Context Budget anchor-ledger Registry-First row', () => {
  it('existing agents: inserted once, right after the user-corpus row, with this agent\'s port', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), TABLE);
    const r = result();
    migrator().migrateClaudeMd(r);
    migrator().migrateClaudeMd(result());
    const out = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8');
    expect(out.match(/\/topic\/N\/anchor/g)?.length).toBe(1);
    const lines = out.split('\n');
    const at = lines.findIndex((l) => l.startsWith("| How large are the operator's own messages in topic N?"));
    expect(at).toBeGreaterThan(-1);
    // Other Context Budget rows (e.g. the delta-shadow row) may sit between U and the Anchor row;
    // the Anchor row stays inside that contiguous Context Budget block, after U.
    const a = lines.findIndex((l) => l.includes('http://localhost:4242/topic/N/anchor'));
    expect(a).toBeGreaterThan(at);
    for (const l of lines.slice(at + 1, a)) expect(l).toMatch(/\/context-budget\/|\/topic\/N\//);
    expect(r.upgraded).toContain('CLAUDE.md: added the Context Budget anchor-ledger Registry-First row');
  });

  it('new agents: generateClaudeMd carries the same row once, after the user-corpus row', () => {
    const md = generateClaudeMd('test', 'Echo', 4242, false);
    expect(md.match(/\/topic\/N\/anchor/g)?.length).toBe(1);
    const lines = md.split('\n');
    const at = lines.findIndex((l) => l.startsWith("| How large are the operator's own messages in topic N?"));
    // Other Context Budget rows (e.g. the delta-shadow row) may sit between U and the Anchor row;
    // the Anchor row stays inside that contiguous Context Budget block, after U.
    const a = lines.findIndex((l) => l.includes('http://localhost:4242/topic/N/anchor'));
    expect(a).toBeGreaterThan(at);
    for (const l of lines.slice(at + 1, a)) expect(l).toMatch(/\/context-budget\/|\/topic\/N\//);
  });
});
