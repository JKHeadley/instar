import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PostUpdateMigrator, SCRIPT_JOBS_CLAUDEMD_MARKER, JOB_RESULT_SUPERVISION_CLAUDEMD_MARKER } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const dirs: string[] = [];

function migrate(projectDir: string): Result {
  const result: Result = { upgraded: [], skipped: [], errors: [] };
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'echo' });
  (migrator as unknown as { migrateClaudeMd(value: Result): void }).migrateClaudeMd(result);
  return result;
}

describe('Scheduled jobs run as scripts — agent awareness', () => {
  afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-scriptJobs.test.ts' }); });

  it('generateClaudeMd carries the section with the read surfaces', () => {
    const fresh = generateClaudeMd('instar', 'Echo', 4042, true);
    expect(fresh).toContain(SCRIPT_JOBS_CLAUDEMD_MARKER);
    expect(fresh).toContain('http://localhost:4042/jobs/triage');
    expect(fresh).toContain('http://localhost:4042/jobs/cost?sinceDays=7');
    expect(fresh).toContain('`runner`, `lockTrust`, `tokens`, `triage`');
    expect(fresh).toContain('When health-check runs as a script');
    expect(fresh).toContain('Correction-class-review-backstop remains a session because its endpoint can call an LLM');
    expect(fresh).toContain('the new daily script-job-supervisor is inactive');
    expect(fresh.split(SCRIPT_JOBS_CLAUDEMD_MARKER)).toHaveLength(2);
    expect(fresh).toContain(JOB_RESULT_SUPERVISION_CLAUDEMD_MARKER);
    expect(fresh).toContain('A bare OK or skipped line cannot be closed as safe without independent evidence');
    expect(fresh).toContain('A separate idle effect proof can grade a routine Jev verdict correct');
  });

  it('migrateClaudeMd adds it once (content-sniffed, idempotent)', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-jobs-awareness-'));
    dirs.push(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Existing agent\n');
    const first = migrate(projectDir);
    expect(first.upgraded).toContain('CLAUDE.md: added Scheduled jobs run as scripts section');
    const migrated = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(migrated).toContain('http://localhost:4042/jobs/triage');
    const second = migrate(projectDir);
    expect(second.upgraded).not.toContain('CLAUDE.md: added Scheduled jobs run as scripts section');
    expect(second.skipped).toContain('CLAUDE.md: Scheduled jobs run as scripts section already present');
    const after = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(after.split(SCRIPT_JOBS_CLAUDEMD_MARKER)).toHaveLength(2);
    expect(after.split(JOB_RESULT_SUPERVISION_CLAUDEMD_MARKER)).toHaveLength(2);
  });

  it('corrects the older outage-sampling wording on an existing agent', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-supervision-awareness-'));
    dirs.push(projectDir);
    const old = '- **After their audit gate opens**, the triage jobs (health-check, commitment-checkin-reminder, the three feedback-factory jobs) can use Jev to check whether a non-routine result needs a real session. An uncertain answer requests a bounded investigator session; only during a Jev outage does Luna or Haiku sample routine results. Until benchmark and outcome-audit coverage is verified, those jobs stay on their existing session path and the model-backed daily review is inactive. Active scripts still get a daily must-fail canary.';
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), `# Existing agent\n${SCRIPT_JOBS_CLAUDEMD_MARKER}\n${old}\n`);
    const first = migrate(projectDir);
    expect(first.upgraded).toContain('CLAUDE.md: corrected script result supervision wording');
    const after = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(after).toContain('Only during a Jev outage may benchmarked Haiku or Luna replace Jev');
    expect(after).not.toContain('sample routine results');
    expect(migrate(projectDir).upgraded).not.toContain('CLAUDE.md: corrected script result supervision wording');
  });

  it('adds idle proof guidance once to an existing supervision section', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-idle-proof-awareness-'));
    dirs.push(projectDir);
    const old = generateClaudeMd('instar', 'Echo', 4042, true)
      .replace(/For the llm-decision-grading job, a server receipt confirms[^\n]+\n\n/, '');
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), old);
    expect(migrate(projectDir).upgraded).toContain('CLAUDE.md: added grading-job idle proof guidance');
    const after = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(after).toContain('A separate idle effect proof can grade a routine Jev verdict correct');
    expect(migrate(projectDir).upgraded).not.toContain('CLAUDE.md: added grading-job idle proof guidance');
  });
});
