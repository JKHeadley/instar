/**
 * frontier-design-review-standard §5: an existing agent's installed
 * spec-converge SKILL.md gains the recording driver run (`--all --record`) —
 * marker-sniffed, fingerprint-guarded (customised copies untouched), idempotent.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const SKILL_REL = ['skills', 'spec-converge', 'SKILL.md'];
const MARKER = 'frontier-design-review:recording-driver-run';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function project(content: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-run-mig-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-recordingDriverRun.test.ts' }));
  if (content !== null) {
    fs.mkdirSync(path.join(dir, '.claude', 'skills', 'spec-converge'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', ...SKILL_REL), content);
  }
  return dir;
}
function run(dir: string) {
  const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar') } as ConstructorParameters<typeof PostUpdateMigrator>[0]);
  const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
  (m as unknown as { migrateSpecConvergeRecordingDriverRun: (r: typeof result) => void }).migrateSpecConvergeRecordingDriverRun(result);
  return result;
}
const installed = (dir: string) => fs.readFileSync(path.join(dir, '.claude', ...SKILL_REL), 'utf8');

describe('migrateSpecConvergeRecordingDriverRun', () => {
  it('the bundled SKILL carries the marker and the driver command, with no model id typed in', () => {
    const skill = fs.readFileSync(path.join(repoRoot, ...SKILL_REL), 'utf8');
    expect(skill).toContain(MARKER);
    expect(skill).toContain('--all --record');
    expect(skill).not.toMatch(/claude-fable-5/);
  });

  it('updates a stock copy once; a second run changes nothing', () => {
    const dir = project('# /spec-converge\n\nold stock text\n');
    expect(run(dir).upgraded).toHaveLength(1);
    expect(installed(dir)).toContain(MARKER);
    const again = run(dir);
    expect(again.upgraded).toHaveLength(0);
    expect(again.errors).toHaveLength(0);
  });

  it('leaves a customised copy alone and says so', () => {
    const dir = project('# My own review skill\n\nmine\n');
    const r = run(dir);
    expect(r.upgraded).toHaveLength(0);
    expect(r.skipped[0]).toContain('customized');
    expect(installed(dir)).toBe('# My own review skill\n\nmine\n');
  });

  it('does nothing where the skill is not installed', () => {
    const dir = project(null);
    expect(run(dir)).toEqual({ upgraded: [], skipped: [], errors: [] });
  });
});
