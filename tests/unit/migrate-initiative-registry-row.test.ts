/**
 * Migration parity (GRADUATED-FEATURE-ROLLOUT-SPEC §4.5/§7): existing agents
 * must get the "what are we working on → /initiatives" Registry-First row on
 * update. Tests migrateClaudeMd's row insertion in isolation: idempotent,
 * inserted after "What can I do?", skipped when already present.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

let tmp: string;
let projectDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-initiative-row-'));
  projectDir = tmp;
  fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));

function migrator(): { migrateClaudeMd: (r: { upgraded: string[]; skipped: string[]; errors: string[] }) => void } {
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4242, hasTelegram: false, projectName: 'test' }) as never;
}
const emptyResult = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });

const CLAUDE_WITH_TABLE = `# CLAUDE.md

### Registry First, Explore Second

| Question | Check First |
|----------|-------------|
| What can I do? | \`curl http://localhost:4242/capabilities\` |
| Who do I work with? | \`.instar/USER.md\` |
`;

describe('migrateClaudeMd — initiative Registry-First row', () => {
  it('inserts the "what are we working on" row after "What can I do?"', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), CLAUDE_WITH_TABLE);
    const r = emptyResult();
    migrator().migrateClaudeMd(r);
    const out = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(out).toContain('What are we working on?');
    expect(out).toMatch(/\/initiatives/);
    // inserted directly after the "What can I do?" row
    const lines = out.split('\n');
    const canIdx = lines.findIndex(l => l.includes('What can I do?'));
    expect(lines[canIdx + 1]).toContain('What are we working on?');
    expect(r.upgraded.some(s => s.includes('what are we working on') || s.includes('initiative discoverability'))).toBe(true);
  });

  it('is idempotent — a second run does not duplicate the row', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), CLAUDE_WITH_TABLE);
    migrator().migrateClaudeMd(emptyResult());
    migrator().migrateClaudeMd(emptyResult());
    const out = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(out.match(/What are we working on\?/g)?.length).toBe(1);
  });
});
