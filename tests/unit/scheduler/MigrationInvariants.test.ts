/**
 * MigrationInvariants — unit tests for the runtime gate per spec
 * §Gate wiring: "PostUpdateMigrator re-verifies invariants 1, 2, and 4
 * against the staged state. Failure aborts to fail-closed (invariant 9)."
 *
 * Invariant 6 (in-flight) is verified structurally at the PostUpdateMigrator
 * layer (no jobs run mid-update), not here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  snapshotUserNamespace,
  verifyMigrationInvariants,
  canonicalScheduleHash,
} from '../../../src/scheduler/MigrationInvariants.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('MigrationInvariants', () => {
  let workspace: string;
  let stateDir: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mi-'));
    stateDir = path.join(workspace, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'MigrationInvariants.test cleanup' });
  });

  function writeManifest(slug: string, fields: Record<string, unknown>) {
    const scheduleDir = path.join(stateDir, 'jobs', 'schedule');
    fs.mkdirSync(scheduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(scheduleDir, `${slug}.json`),
      JSON.stringify({ slug, origin: 'user', execute: { type: 'agentmd' }, manifestVersion: 1, ...fields }, null, 2),
    );
  }

  function writeUserMd(slug: string, content: string) {
    const userDir = path.join(stateDir, 'jobs', 'user');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, `${slug}.md`), content);
  }

  // ── Invariant 1: Zero job loss ────────────────────────────────────

  it('invariant 1 passes when every pre-migration slug has a manifest', () => {
    const pre = [
      { slug: 'a', execute: { type: 'prompt', value: 'x' }, schedule: '*/5 * * * *', enabled: true },
      { slug: 'b', execute: { type: 'prompt', value: 'y' }, schedule: '*/5 * * * *', enabled: true },
    ];
    writeManifest('a', { schedule: '*/5 * * * *', enabled: true });
    writeManifest('b', { schedule: '*/5 * * * *', enabled: true });

    const outcome = verifyMigrationInvariants({ agentStateDir: stateDir, preMigrationJobs: pre });

    expect(outcome.ok).toBe(true);
    expect(outcome.results.find((r) => r.invariant === 1)!.status).toBe('passed');
  });

  it('invariant 1 fails when a pre-migration slug has no post-migration trace', () => {
    const pre = [
      { slug: 'a', execute: { type: 'prompt', value: 'x' }, schedule: '*/5 * * * *', enabled: true },
      { slug: 'dropped', execute: { type: 'prompt', value: 'y' }, schedule: '*/5 * * * *', enabled: true },
    ];
    writeManifest('a', { schedule: '*/5 * * * *', enabled: true });
    // 'dropped' has no manifest or user file.

    const outcome = verifyMigrationInvariants({ agentStateDir: stateDir, preMigrationJobs: pre });

    expect(outcome.ok).toBe(false);
    const r1 = outcome.results.find((r) => r.invariant === 1)!;
    expect(r1.status).toBe('failed');
    expect(r1.reason).toContain('dropped');
  });

  it('invariant 1 accepts renamed entries (slug-user)', () => {
    const pre = [
      { slug: 'renamed-default', execute: { type: 'prompt', value: 'x' }, schedule: '*/5 * * * *', enabled: true },
    ];
    writeManifest('renamed-default-user', { schedule: '*/5 * * * *', enabled: true, origin: 'user' });
    writeUserMd('renamed-default-user', '---\nname: x\n---\nbody');

    const outcome = verifyMigrationInvariants({ agentStateDir: stateDir, preMigrationJobs: pre });

    expect(outcome.results.find((r) => r.invariant === 1)!.status).toBe('passed');
  });

  it('invariant 1 excludes non-prompt legacy entries (script/skill stay in jobs.json)', () => {
    const pre = [
      { slug: 'a', execute: { type: 'prompt', value: 'x' }, schedule: '* * * * *', enabled: true },
      { slug: 'script-job', execute: { type: 'script', value: 'echo' }, schedule: '* * * * *', enabled: true },
    ];
    writeManifest('a', { schedule: '* * * * *', enabled: true });
    // script-job has no manifest — that's fine, it's still in jobs.json.

    const outcome = verifyMigrationInvariants({ agentStateDir: stateDir, preMigrationJobs: pre });

    expect(outcome.results.find((r) => r.invariant === 1)!.status).toBe('passed');
  });

  // ── Invariant 2: Zero schedule drift ────────────────────────────────

  it('invariant 2 fails when a manifest changed the schedule', () => {
    const pre = [
      { slug: 'a', execute: { type: 'prompt', value: 'x' }, schedule: '*/5 * * * *', enabled: true, priority: 'low', model: 'haiku' },
    ];
    writeManifest('a', { schedule: '0 9 * * *', enabled: true }); // drifted!

    const outcome = verifyMigrationInvariants({ agentStateDir: stateDir, preMigrationJobs: pre });

    expect(outcome.ok).toBe(false);
    const r2 = outcome.results.find((r) => r.invariant === 2)!;
    expect(r2.status).toBe('failed');
    expect(r2.reason).toContain('schedule');
  });

  it('invariant 2 fails when enabled state was changed', () => {
    const pre = [
      { slug: 'a', execute: { type: 'prompt', value: 'x' }, schedule: '*/5 * * * *', enabled: true },
    ];
    writeManifest('a', { schedule: '*/5 * * * *', enabled: false }); // drifted!

    const outcome = verifyMigrationInvariants({ agentStateDir: stateDir, preMigrationJobs: pre });

    expect(outcome.ok).toBe(false);
    const r2 = outcome.results.find((r) => r.invariant === 2)!;
    expect(r2.status).toBe('failed');
    expect(r2.reason).toContain('enabled');
  });

  it('invariant 2 passes when schedule + enabled are preserved', () => {
    const pre = [
      { slug: 'a', execute: { type: 'prompt', value: 'x' }, schedule: '*/5 * * * *', enabled: true },
    ];
    writeManifest('a', { schedule: '*/5 * * * *', enabled: true });

    const outcome = verifyMigrationInvariants({ agentStateDir: stateDir, preMigrationJobs: pre });

    expect(outcome.results.find((r) => r.invariant === 2)!.status).toBe('passed');
  });

  // ── Invariant 4: User namespace untouched ──────────────────────────

  it('invariant 4 fails when a pre-snapshotted user file was modified', () => {
    writeUserMd('my-job', 'original body\n');
    const snap = snapshotUserNamespace(stateDir);

    // Simulate the migrator wrongly editing a user file.
    writeUserMd('my-job', 'TAMPERED body\n');

    const outcome = verifyMigrationInvariants({
      agentStateDir: stateDir,
      preMigrationJobs: [],
      preMigrationUserSnapshot: snap,
    });

    expect(outcome.ok).toBe(false);
    const r4 = outcome.results.find((r) => r.invariant === 4)!;
    expect(r4.status).toBe('failed');
    expect(r4.reason).toContain('my-job.md');
    expect(r4.reason).toContain('modified');
  });

  it('invariant 4 fails when a pre-snapshotted user file was removed', () => {
    writeUserMd('my-job', 'original body\n');
    const snap = snapshotUserNamespace(stateDir);

    SafeFsExecutor.safeUnlinkSync(path.join(stateDir, 'jobs', 'user', 'my-job.md'), { operation: 'MigrationInvariants.test simulate user file removal' });

    const outcome = verifyMigrationInvariants({
      agentStateDir: stateDir,
      preMigrationJobs: [],
      preMigrationUserSnapshot: snap,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.results.find((r) => r.invariant === 4)!.reason).toContain('removed');
  });

  it('invariant 4 passes when pre-snapshotted user files are byte-identical', () => {
    writeUserMd('my-job', 'original body\n');
    const snap = snapshotUserNamespace(stateDir);

    const outcome = verifyMigrationInvariants({
      agentStateDir: stateDir,
      preMigrationJobs: [],
      preMigrationUserSnapshot: snap,
    });

    expect(outcome.results.find((r) => r.invariant === 4)!.status).toBe('passed');
  });

  it('invariant 4 is skipped when no snapshot is provided', () => {
    const outcome = verifyMigrationInvariants({
      agentStateDir: stateDir,
      preMigrationJobs: [],
    });

    expect(outcome.results.find((r) => r.invariant === 4)!.status).toBe('skipped');
    expect(outcome.ok).toBe(true);
  });

  it('invariant 4 ignores newly-added user files (covers the fork path)', () => {
    const snap = snapshotUserNamespace(stateDir); // empty
    writeUserMd('new-fork', '---\nname: x\n---\nfork body');

    const outcome = verifyMigrationInvariants({
      agentStateDir: stateDir,
      preMigrationJobs: [],
      preMigrationUserSnapshot: snap,
    });

    expect(outcome.results.find((r) => r.invariant === 4)!.status).toBe('passed');
  });

  // ── canonicalScheduleHash ──────────────────────────────────────────

  it('canonicalScheduleHash is stable across irrelevant field reorderings', () => {
    const a = { slug: 'x', schedule: '* * * * *', enabled: true, priority: 'low', model: 'haiku' };
    const b = { priority: 'low', model: 'haiku', enabled: true, schedule: '* * * * *', slug: 'x' };
    expect(canonicalScheduleHash(a)).toBe(canonicalScheduleHash(b));
  });

  it('canonicalScheduleHash changes when the schedule changes', () => {
    const a = { slug: 'x', schedule: '* * * * *', enabled: true, priority: 'low', model: 'haiku' };
    const b = { slug: 'x', schedule: '0 9 * * *', enabled: true, priority: 'low', model: 'haiku' };
    expect(canonicalScheduleHash(a)).not.toBe(canonicalScheduleHash(b));
  });
});
