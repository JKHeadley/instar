// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Local Verify main-red hold (CMT-1033) — Agent Awareness + Migration Parity.
 *  - generateClaudeMd carries the hold (new agents learn `mainRedHold`, the repair rule, the switch).
 *  - migrateClaudeMd appends ONE line to an existing CLAUDE.md that already has the Local Verify
 *    section, idempotently, and leaves a CLAUDE.md without that section alone (it gets the whole
 *    section from the earlier migration first).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, LOCAL_VERIFY_MAIN_RED_HOLD_CLAUDEMD_LINE, LOCAL_VERIFY_MERGE_THROUGHPUT_CLAUDEMD_LINE } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const UPGRADE_LINE = 'CLAUDE.md: added Local Verify main-red hold awareness (CMT-1033)';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-localVerifyMainRedHold.test.ts' }); });

function runMigrateClaudeMd(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

function project(initial: string): { projectDir: string; claudeMd: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lv-hold-mig-'));
  dirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  const claudeMd = path.join(projectDir, 'CLAUDE.md');
  fs.writeFileSync(claudeMd, initial);
  return { projectDir, claudeMd };
}

describe('Local Verify main-red hold + merge-throughput awareness', () => {
  it('generateClaudeMd names mainRedHold, repairPrs/heldPrs, the repair rule, the item key and the kill switch', () => {
    const md = generateClaudeMd('fixture', 'Fixture', 4042, true);
    for (const s of ['mainRedHold', 'repairPrs', 'heldPrs', 'name the failing file in its title or body', 'local-verify:main-red-hold', 'monitoring.localVerify.mainRedHold: false']) {
      expect(md).toContain(s);
    }
  });

  it('the migration line carries the same facts', () => {
    for (const s of ['mainRedHold', 'repairPrs', 'heldPrs', 'local-verify:main-red-hold', 'monitoring.localVerify.mainRedHold: false']) {
      expect(LOCAL_VERIFY_MAIN_RED_HOLD_CLAUDEMD_LINE).toContain(s);
    }
  });

  it('appends the line to a CLAUDE.md that already has the Local Verify section, once', () => {
    const { projectDir, claudeMd } = project('# CLAUDE.md\n\n### Local Verify\n- Ask: `POST /local-verify` · Queue: `GET /local-verify`\n- Local Verify merge line: … `monitoring.localVerify.mergeLine: false` …\n- Local Verify merge-status loop: `GET /local-verify/status` …\n');
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'test-agent' });
    expect(runMigrateClaudeMd(m).upgraded).toContain(UPGRADE_LINE);
    const after1 = fs.readFileSync(claudeMd, 'utf-8');
    expect(after1).toContain(LOCAL_VERIFY_MAIN_RED_HOLD_CLAUDEMD_LINE);
    expect(runMigrateClaudeMd(m).upgraded).not.toContain(UPGRADE_LINE);
    expect(fs.readFileSync(claudeMd, 'utf-8').split('monitoring.localVerify.mainRedHold').length - 1).toBe(1);
  });

  it('a CLAUDE.md without the Local Verify section gets the whole section (which carries the hold) and no stray line', () => {
    const { projectDir, claudeMd } = project('# CLAUDE.md\n\nSome prior content.\n');
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'test-agent' });
    runMigrateClaudeMd(m);
    const after = fs.readFileSync(claudeMd, 'utf-8');
    expect(after).toContain('/local-verify');
    expect(after.split('monitoring.localVerify.mainRedHold').length - 1).toBe(1);
  });

  it('the merge-throughput label: the template and the migration line name the label, its place under main and the repair, the bound and the priority field', () => {
    const md = generateClaudeMd('fixture', 'Fixture', 4042, true);
    for (const text of [md, LOCAL_VERIFY_MERGE_THROUGHPUT_CLAUDEMD_LINE]) {
      for (const k of ['merge-throughput', '90 minutes', 'local-verify:starved', 'priority', 'gh pr edit <n> --add-label merge-throughput']) expect(text).toContain(k);
    }
  });

  it('appends the merge-throughput line once to a CLAUDE.md that has the Local Verify section', () => {
    const { projectDir, claudeMd } = project('# CLAUDE.md\n\n### Local Verify\n- Ask: `POST /local-verify`\n- `monitoring.localVerify.mainRedHold: false`\n- `GET /local-verify/status`\n- `monitoring.localVerify.mergeLine: false`\n');
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'test-agent' });
    expect(runMigrateClaudeMd(m).upgraded).toContain('CLAUDE.md: added Local Verify merge-throughput label awareness');
    expect(fs.readFileSync(claudeMd, 'utf-8')).toContain(LOCAL_VERIFY_MERGE_THROUGHPUT_CLAUDEMD_LINE);
    expect(runMigrateClaudeMd(m).upgraded).not.toContain('CLAUDE.md: added Local Verify merge-throughput label awareness');
    expect(fs.readFileSync(claudeMd, 'utf-8').split('Local Verify merge-throughput label').length - 1).toBe(1);
  });
});

describe('Local Verify peer-verifier awareness', () => {
  it('the template and the migration line name the settings and the read surfaces; appended once', async () => {
    const { LOCAL_VERIFY_PEERS_CLAUDEMD_LINE } = await import('../../src/core/PostUpdateMigrator.js');
    const md = generateClaudeMd('fixture', 'Fixture', 4042, true);
    for (const text of [md, LOCAL_VERIFY_PEERS_CLAUDEMD_LINE]) {
      for (const k of ['monitoring.localVerify.peers', 'monitoring.localVerify.peer.enabled', 'peer-status', 'local-verify:peer-breaker']) expect(text).toContain(k);
    }
    const { projectDir, claudeMd } = project('# CLAUDE.md\n\n### Local Verify\n- Ask: `POST /local-verify`\n- `monitoring.localVerify.mainRedHold: false`\n- `GET /local-verify/status`\n- `monitoring.localVerify.mergeLine: false`\n- merge-throughput\n');
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'test-agent' });
    expect(runMigrateClaudeMd(m).upgraded).toContain('CLAUDE.md: added Local Verify peer-verifier awareness');
    expect(fs.readFileSync(claudeMd, 'utf-8')).toContain(LOCAL_VERIFY_PEERS_CLAUDEMD_LINE);
    expect(runMigrateClaudeMd(m).upgraded).not.toContain('CLAUDE.md: added Local Verify peer-verifier awareness');
  });
});

describe('Local Verify throughput overflow awareness', () => {
  it('the template and the migration line carry it; appended once to an existing section', async () => {
    const { LOCAL_VERIFY_THROUGHPUT_OVERFLOW_CLAUDEMD_LINE } = await import('../../src/core/PostUpdateMigrator.js');
    expect(generateClaudeMd('fixture', 'Fixture', 4042, true)).toContain('Local Verify throughput overflow');
    expect(LOCAL_VERIFY_THROUGHPUT_OVERFLOW_CLAUDEMD_LINE).toContain('queue-full');
    const { projectDir, claudeMd } = project('# CLAUDE.md\n\n### Local Verify\n- Ask: `POST /local-verify`\n- `monitoring.localVerify.mainRedHold: false`\n- `GET /local-verify/status`\n- `monitoring.localVerify.mergeLine: false`\n- merge-throughput\n');
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'test-agent' });
    expect(runMigrateClaudeMd(m).upgraded).toContain('CLAUDE.md: added Local Verify merge-throughput overflow awareness');
    expect(fs.readFileSync(claudeMd, 'utf-8')).toContain(LOCAL_VERIFY_THROUGHPUT_OVERFLOW_CLAUDEMD_LINE);
    expect(runMigrateClaudeMd(m).upgraded).not.toContain('CLAUDE.md: added Local Verify merge-throughput overflow awareness');
  });
});

describe('Local Verify fail-fast awareness', () => {
  it('the template and the migration line name the behaviour, the reason and the switch', async () => {
    const { LOCAL_VERIFY_FAIL_FAST_CLAUDEMD_LINE } = await import('../../src/core/PostUpdateMigrator.js');
    const md = generateClaudeMd('fixture', 'Fixture', 4042, true);
    for (const text of [md, LOCAL_VERIFY_FAIL_FAST_CLAUDEMD_LINE]) {
      for (const k of ['lane-stopped-early', 'monitoring.localVerify.failFast: false', 'flaky on `main`']) expect(text).toContain(k);
    }
  });
  it('appends the fail-fast line once to a CLAUDE.md that has the Local Verify section', async () => {
    const { LOCAL_VERIFY_FAIL_FAST_CLAUDEMD_LINE } = await import('../../src/core/PostUpdateMigrator.js');
    const { projectDir, claudeMd } = project('# CLAUDE.md\n\n### Local Verify\n- Ask: `POST /local-verify`\n- `monitoring.localVerify.mainRedHold: false`\n- `GET /local-verify/status`\n- `monitoring.localVerify.mergeLine: false`\n- merge-throughput\n');
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'test-agent' });
    expect(runMigrateClaudeMd(m).upgraded).toContain('CLAUDE.md: added Local Verify fail-fast awareness');
    expect(fs.readFileSync(claudeMd, 'utf-8')).toContain(LOCAL_VERIFY_FAIL_FAST_CLAUDEMD_LINE);
    expect(runMigrateClaudeMd(m).upgraded).not.toContain('CLAUDE.md: added Local Verify fail-fast awareness');
  });
});

describe('Local Verify balanced-shards awareness', () => {
  it('the template and the migration line name the setting and the rollback', async () => {
    const { LOCAL_VERIFY_LANE_SHARDS_CLAUDEMD_LINE } = await import('../../src/core/PostUpdateMigrator.js');
    const md = generateClaudeMd('fixture', 'Fixture', 4042, true);
    for (const text of [md, LOCAL_VERIFY_LANE_SHARDS_CLAUDEMD_LINE]) {
      for (const k of ['monitoring.localVerify.laneShards', 'file-durations.json', '"integration": 1, "e2e": 2']) expect(text).toContain(k);
    }
  });
  it('appends the line once to a CLAUDE.md that has the Local Verify section', async () => {
    const { LOCAL_VERIFY_LANE_SHARDS_CLAUDEMD_LINE } = await import('../../src/core/PostUpdateMigrator.js');
    const { projectDir, claudeMd } = project('# CLAUDE.md\n\n### Local Verify\n- Ask: `POST /local-verify`\n- `monitoring.localVerify.mainRedHold: false`\n- `GET /local-verify/status`\n- `monitoring.localVerify.mergeLine: false`\n- merge-throughput\n- `monitoring.localVerify.failFast`\n');
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'test-agent' });
    expect(runMigrateClaudeMd(m).upgraded).toContain('CLAUDE.md: added Local Verify balanced-shards awareness');
    expect(fs.readFileSync(claudeMd, 'utf-8')).toContain(LOCAL_VERIFY_LANE_SHARDS_CLAUDEMD_LINE);
    expect(runMigrateClaudeMd(m).upgraded).not.toContain('CLAUDE.md: added Local Verify balanced-shards awareness');
  });
});

describe('Local Verify focused-preflight awareness', () => {
  it('ships the same default, replay and green-authority facts to new and existing agents', async () => {
    const { LOCAL_VERIFY_PREFLIGHT_CLAUDEMD_LINE } = await import('../../src/core/PostUpdateMigrator.js');
    for (const text of [generateClaudeMd('fixture', 'Fixture', 4042, true), LOCAL_VERIFY_PREFLIGHT_CLAUDEMD_LINE]) {
      for (const phrase of ['monitoring.localVerify.preflightMode', 'default off', 'full-suite replay', 'only the complete full-suite record', 'GET /local-verify']) expect(text).toContain(phrase);
    }
  });
  it('appends one line on update and leaves operator content intact', async () => {
    const { LOCAL_VERIFY_PREFLIGHT_CLAUDEMD_LINE } = await import('../../src/core/PostUpdateMigrator.js');
    const { projectDir, claudeMd } = project('# CLAUDE.md\n\n### Local Verify\n- Ask: `POST /local-verify`\n\nMy operator note.\n');
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'test-agent' });
    expect(runMigrateClaudeMd(m).upgraded).toContain('CLAUDE.md: added Local Verify focused-preflight awareness');
    expect(fs.readFileSync(claudeMd, 'utf-8')).toContain(LOCAL_VERIFY_PREFLIGHT_CLAUDEMD_LINE);
    expect(fs.readFileSync(claudeMd, 'utf-8')).toContain('My operator note.');
    expect(runMigrateClaudeMd(m).upgraded).not.toContain('CLAUDE.md: added Local Verify focused-preflight awareness');
  });
});
