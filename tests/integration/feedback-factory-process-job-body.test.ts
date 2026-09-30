// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Migration Parity for the feedback-factory-process job body (spec
 * docs/specs/feedback-inbox-vault-token.md §C). An existing agent holds the OLD
 * body — the one whose "fail this job run" had no mechanism — and an operator
 * may have changed `enabled`. The update path (PostUpdateMigrator →
 * installBuiltinJobs) must replace the body with the shipped one and keep the
 * operator's `enabled`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { installBuiltinJobs } from '../../src/scheduler/InstallBuiltinJobs.js';
import { loadAgentMdJobs } from '../../src/scheduler/AgentMdJobLoader.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLUG = 'feedback-factory-process';
const OLD_BODY_LINE = 'If it is true, a 503 is degradation—fail this job run so JobRun history and the server audit expose it; never treat it as healthy.';

describe('feedback-factory-process job body — existing agents get the failing body', () => {
  let workspace: string;
  let stateDir: string;
  let body: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-proc-body-'));
    stateDir = path.join(workspace, '.instar');
    // First install, then simulate the pre-release state: the old body on disk
    // and an operator-disabled manifest.
    expect(installBuiltinJobs({ agentStateDir: stateDir, packageRoot: REPO_ROOT, port: 4044 }).errors).toEqual([]);
    const mdPath = path.join(stateDir, 'jobs', 'instar', `${SLUG}.md`);
    const shipped = fs.readFileSync(mdPath, 'utf8');
    const head = shipped.slice(0, shipped.indexOf('\n---\n') + 5);
    fs.writeFileSync(mdPath, `${head}Run one feedback-factory operating-drain tick.\n\n1. ${OLD_BODY_LINE}\n`);
    const manifestPath = path.join(stateDir, 'jobs', 'schedule', `${SLUG}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, enabled: false }, null, 2));

    // The update path.
    const report = installBuiltinJobs({ agentStateDir: stateDir, packageRoot: REPO_ROOT, port: 4044 });
    expect(report.errors).toEqual([]);
    expect(report.installed).toContain(SLUG);
    body = fs.readFileSync(mdPath, 'utf8');
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'tests/integration/feedback-factory-process-job-body.test.ts' });
  });

  it('replaces the old body and keeps the operator\'s enabled=false', () => {
    expect(body).not.toContain(OLD_BODY_LINE);
    const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'jobs', 'schedule', `${SLUG}.json`), 'utf8'));
    expect(manifest.enabled).toBe(false);
  });

  it('the new body fails the run through $INSTAR_JOB_FAILURE_FILE, not through words', () => {
    expect(body).toContain('[ -n "$INSTAR_JOB_FAILURE_FILE" ] && printf \'%s\' "<reason>" > "$INSTAR_JOB_FAILURE_FILE"');
    expect(body).toContain('Saying "failed" in your output does NOT record a failure');
  });

  it('the new body covers every posture row of the spec table', () => {
    expect(body).toMatch(/`live` → go to step 2/);
    expect(body).toMatch(/`dark` → exit silently/);
    expect(body).toMatch(/`unavailable` → FAIL THE RUN with reason `drain posture unavailable: <posture\.reason>`/);
    expect(body).toMatch(/no JSON, no `posture` field, connection refused, 401, 403, any other code → if `developmentAgent` is true, FAIL THE RUN/);
    expect(body).toContain('whatever the HTTP code');
  });

  it('the agent port is substituted and the refreshed job still loads', () => {
    expect(body).toContain('${INSTAR_PORT:-4044}');
    const { jobs } = loadAgentMdJobs(path.join(stateDir, 'jobs', 'schedule'), path.join(stateDir, 'jobs'));
    expect(jobs.find((j) => j.slug === SLUG)).toBeTruthy();
  });
});
