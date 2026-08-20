// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the suppressed-duplicate
 * honesty fix.
 *
 * Per TESTING-INTEGRITY-SPEC this is the tier that catches a feature which
 * passes every unit test and is inert in production. For a change that ships
 * as a TEMPLATE plus a MIGRATION, "inert in production" has a very specific
 * shape: the template is fixed in the repo, the unit tests are green, and yet
 * every agent in the field keeps running the old lying script forever, because
 * instar agents update IN PLACE. A template-only change reaches only agents
 * created after it.
 *
 * So this test does not stop at "the migrator wrote a file". It drives the
 * REAL public `migrate()` entry point — the same call the production update
 * path makes — against a realistic agent home that already exists, and then
 * EXECUTES the relay script from that agent's own disk. The final assertion is
 * the one that matters: after updating in place, an existing agent's own
 * script tells the truth about a suppressed send.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TEMPLATE = path.resolve('src/templates/scripts/telegram-reply.sh');
const PRIOR_SHIPPED_SHA =
  '4464581188f5c736a62edac5e6a2edecfcfcd365557a18e514b741731bed6e0b';
const TOPIC = '29723';

/** The pre-fix shipped script: the current template minus the 7-line branch. */
function priorShippedContent(): string {
  const lines = fs.readFileSync(TEMPLATE, 'utf-8').split('\n');
  const start = lines.findIndex(l => l.includes('get("suppressedDuplicate") is True'));
  if (start === -1) throw new Error('suppression branch not found in template');
  return [...lines.slice(0, start), ...lines.slice(start + 7)].join('\n');
}

/**
 * Execute a relay script AS THE AGENT WOULD, against a stubbed curl that
 * returns the server's real suppressed-duplicate response shape (HTTP 200 +
 * `suppressedDuplicate: true`, per src/server/routes.ts).
 */
function runDeployedScript(
  scriptPath: string,
  agentHome: string,
  body: string,
): Promise<{ status: number | null; stdout: string }> {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suppressed-dup-e2e-bin-'));
  const curlStub = path.join(binDir, 'curl');
  fs.writeFileSync(
    curlStub,
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    *"/telegram/reply/"*) printf '%s\\n%s' '${body}' '200'; exit 0 ;;
  esac
done
exit 1
`,
  );
  fs.chmodSync(curlStub, 0o755);

  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath, TOPIC, 'the overnight summary'], {
      cwd: agentHome,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        INSTAR_SENDER_CLASS: 'script',
        INSTAR_PORT: '',
        INSTAR_AUTH_TOKEN: '',
      },
    });
    let stdout = '';
    child.stdout.on('data', c => { stdout += c.toString(); });
    child.on('error', reject);
    child.on('close', status => {
      SafeFsExecutor.safeRmSync(binDir, {
        recursive: true, force: true,
        operation: 'tests/e2e/telegram-reply-suppressed-duplicate-alive.test.ts:bin',
      });
      resolve({ status, stdout });
    });
  });
}

const SUPPRESSED_BODY = '{"ok":true,"topicId":29723,"suppressedDuplicate":true}';

describe('Suppressed-duplicate honesty E2E lifecycle (an existing agent updates in place)', () => {
  let agentHome: string;
  let claudePath: string;
  let neutralPath: string;
  let migrateResult: { upgraded: string[]; skipped: string[]; errors: string[] };
  let preUpdate: { status: number | null; stdout: string };

  beforeAll(async () => {
    // ---- An instar agent that ALREADY EXISTS, on the shipped pre-fix relay.
    agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-agent-preexisting-'));
    const stateDir = path.join(agentHome, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 49999, projectName: 'preexisting-agent' }),
    );

    claudePath = path.join(agentHome, '.claude', 'scripts', 'telegram-reply.sh');
    neutralPath = path.join(stateDir, 'scripts', 'telegram-reply.sh');
    const prior = priorShippedContent();
    for (const p of [claudePath, neutralPath]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, prior, { mode: 0o755 });
    }

    // ---- Capture the DEFECT on this agent, before the update.
    preUpdate = await runDeployedScript(claudePath, agentHome, SUPPRESSED_BODY);

    // ---- The production update path: the real public migrate() entry point.
    migrateResult = new PostUpdateMigrator({
      projectDir: agentHome,
      stateDir,
      port: 49999,
      hasTelegram: true,
      projectName: 'preexisting-agent',
    }).migrate();
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(agentHome, {
      recursive: true, force: true,
      operation: 'tests/e2e/telegram-reply-suppressed-duplicate-alive.test.ts',
    });
  });

  it('the pre-existing agent really did have the defect before updating', () => {
    // Guards the whole test from passing vacuously against an agent that was
    // never broken: pre-update, a suppressed send is reported as sent, exit 0.
    expect(preUpdate.status).toBe(0);
    expect(preUpdate.stdout).toMatch(/Sent \d+ chars/);
    expect(preUpdate.stdout).not.toContain('NOT SENT');
  });

  it('the shipped pre-fix script is the version the migrator claims to recognise', () => {
    expect(crypto.createHash('sha256').update(priorShippedContent()).digest('hex'))
      .toBe(PRIOR_SHIPPED_SHA);
  });

  it('the full migrate() run reports no errors on a realistic agent home', () => {
    const relayErrors = migrateResult.errors.filter(e => e.includes('telegram-reply'));
    expect(relayErrors).toEqual([]);
  });

  it('both deployed copies carry the fix after updating in place', () => {
    for (const p of [claudePath, neutralPath]) {
      const onDisk = fs.readFileSync(p, 'utf-8');
      expect(onDisk).toContain('NOT SENT — suppressed duplicate for topic');
      expect(onDisk).toBe(fs.readFileSync(TEMPLATE, 'utf-8'));
      // No stranded `.new` candidate — that would mean the migration missed.
      expect(fs.existsSync(`${p}.new`)).toBe(false);
    }
  });

  it('THE ALIVE TEST: the updated agent\'s OWN script now reports a suppressed send honestly', async () => {
    const res = await runDeployedScript(claudePath, agentHome, SUPPRESSED_BODY);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain('NOT SENT');
    expect(res.stdout).toContain('suppressed duplicate for topic 29723');
    expect(res.stdout).not.toMatch(/Sent \d+ chars/);
  });

  it('the framework-neutral copy is honest too (Codex/Gemini installs resolve that path)', async () => {
    const res = await runDeployedScript(neutralPath, agentHome, SUPPRESSED_BODY);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain('NOT SENT');
  });

  it('a genuine send still succeeds on the updated agent (the fix is not a blanket refusal)', async () => {
    const res = await runDeployedScript(claudePath, agentHome, '{"ok":true,"topicId":29723}');

    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Sent \d+ chars to topic 29723/);
  });

  it('updating a second time is a no-op — the agent stays fixed', () => {
    const again = new PostUpdateMigrator({
      projectDir: agentHome,
      stateDir: path.join(agentHome, '.instar'),
      port: 49999,
      hasTelegram: true,
      projectName: 'preexisting-agent',
    }).migrate();

    expect(again.errors.filter(e => e.includes('telegram-reply'))).toEqual([]);
    expect(again.skipped.some(s => s.includes('telegram-reply.sh') && s.includes('already current')))
      .toBe(true);
    expect(fs.readFileSync(claudePath, 'utf-8')).toContain('NOT SENT — suppressed duplicate');
  });
});
