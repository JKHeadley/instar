// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * T11 (frozen acceptance list, step3/acceptance-tests.md): Agent Awareness + Migration Parity
 * for the per-job thinkingMode field (spec job-launch-intent-record, "Migration parity").
 * The init template and migrateClaudeMd produce the SAME line; running the migration twice adds
 * nothing, even though the topic-profile bullet already contains the bare word `thinkingMode`
 * (the sniff is the phrase "a job can set `thinkingMode`", not the word).
 * Red on main: the line is missing from both the template and the migrator.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator, topicProfileProposeBullet } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PHRASE = 'a job can set `thinkingMode` in its manifest to choose how hard the engine thinks';
const SNIFF = 'a job can set `thinkingMode`';
const PORT = 4042;

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: PORT, hasTelegram: false, projectName: 'test' });
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}
const count = (s: string, needle = SNIFF) => s.split(needle).length - 1;
const linesWith = (s: string) => s.split('\n').filter((l) => l.includes(SNIFF));

describe('T11 per-job thinkingMode awareness line', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-job-launch-awareness-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/job-launch-awareness.test.ts:cleanup' }));

  it('the init template carries the line exactly once', () => {
    const md = generateClaudeMd('test', 'Test', PORT, false);
    expect(md, 'generateClaudeMd has no per-job thinkingMode line').toContain(PHRASE);
    expect(count(md)).toBe(1);
  });

  it('migrateClaudeMd inserts the identical line into an existing CLAUDE.md that only has the topic-profile thinkingMode bullet', () => {
    const topicLine = topicProfileProposeBullet(PORT);
    expect(topicLine).toContain('thinkingMode'); // the bare word is already present: must not satisfy the sniff
    fs.writeFileSync(claudeMd, `# CLAUDE.md — test\n\n${topicLine}\n`);
    const r = run(projectDir);
    expect(r.errors).toEqual([]);
    const out = fs.readFileSync(claudeMd, 'utf8');
    expect(out, 'migrateClaudeMd did not add the per-job thinkingMode line').toContain(PHRASE);
    expect(count(out)).toBe(1);
    const tmplLines = linesWith(generateClaudeMd('test', 'Test', PORT, false));
    expect(linesWith(out)).toEqual(tmplLines);
  });

  it('a template-generated CLAUDE.md with the line removed gets back the byte-identical line', () => {
    const md = generateClaudeMd('test', 'Test', PORT, false);
    const tmplLines = linesWith(md);
    expect(tmplLines.length).toBe(1);
    fs.writeFileSync(claudeMd, md.split('\n').filter((l) => !l.includes(SNIFF)).join('\n'));
    run(projectDir);
    expect(linesWith(fs.readFileSync(claudeMd, 'utf8'))).toEqual(tmplLines);
  });

  it('running it twice adds nothing', () => {
    fs.writeFileSync(claudeMd, `# CLAUDE.md — test\n\n${topicProfileProposeBullet(PORT)}\n`);
    run(projectDir);
    const once = fs.readFileSync(claudeMd, 'utf8');
    expect(count(once)).toBe(1);
    run(projectDir);
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
  });

  it('a freshly generated CLAUDE.md is left untouched by the migration (no duplicate)', () => {
    const md = generateClaudeMd('test', 'Test', PORT, false);
    expect(md).toContain(PHRASE);
    fs.writeFileSync(claudeMd, md);
    run(projectDir);
    expect(count(fs.readFileSync(claudeMd, 'utf8'))).toBe(1);
  });
});
