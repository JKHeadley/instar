/**
 * DisabledBodyDrift — tests for the disabledAtBodyHash drift-detection helper.
 *
 * Per INSTAR-JOBS-AS-AGENTMD spec §Dashboard UX (enabled toggle records
 * disabledAtBodyHash) + §Operator Experience (drift digest semantics).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  bodyDriftedSinceDisable,
  listDriftedDisabledSlugs,
  stampDisabledAtBodyHash,
  clearDisabledAtBodyHash,
} from '../../../src/scheduler/DisabledBodyDrift.js';
import { hashBody } from '../../../src/scheduler/AgentMdLockFile.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('DisabledBodyDrift', () => {
  let workspace: string;
  let stateDir: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dbd-'));
    stateDir = path.join(workspace, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'DisabledBodyDrift.test cleanup' });
  });

  function writeManifest(slug: string, fields: Record<string, unknown>): void {
    const dir = path.join(stateDir, 'jobs', 'schedule');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify({
      slug,
      origin: 'user',
      schedule: '*/5 * * * *',
      enabled: true,
      execute: { type: 'agentmd' },
      manifestVersion: 1,
      ...fields,
    }, null, 2));
  }

  function writeMd(slug: string, body: string, namespace: 'instar' | 'user' = 'user'): void {
    const dir = path.join(stateDir, 'jobs', namespace);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug}.md`), `---\nname: ${slug}\n---\n${body}`);
  }

  // ── bodyDriftedSinceDisable ────────────────────────────────────────

  it('no-drift when current body hash matches captured disabledAtBodyHash', () => {
    const body = 'do the thing\n';
    const expectedHash = hashBody(body);
    writeMd('alpha', body);
    writeManifest('alpha', { enabled: false, disabledAtBodyHash: expectedHash });

    const r = bodyDriftedSinceDisable({ stateDir, slug: 'alpha' });
    expect(r.kind).toBe('no-drift');
  });

  it('drifted when body changed since disable', () => {
    const originalBody = 'old body\n';
    const originalHash = hashBody(originalBody);
    writeManifest('alpha', { enabled: false, disabledAtBodyHash: originalHash });
    writeMd('alpha', 'new body\n'); // body changed, hash captured at disable-time stays

    const r = bodyDriftedSinceDisable({ stateDir, slug: 'alpha' });
    expect(r.kind).toBe('drifted');
    if (r.kind === 'drifted') {
      expect(r.disabledAtBodyHash).toBe(originalHash);
      expect(r.currentBodyHash).not.toBe(originalHash);
    }
  });

  it('not-disabled when the manifest is enabled', () => {
    writeManifest('alpha', { enabled: true });
    writeMd('alpha', 'body\n');

    const r = bodyDriftedSinceDisable({ stateDir, slug: 'alpha' });
    expect(r.kind).toBe('not-disabled');
  });

  it('no-disable-record when disabled but no disabledAtBodyHash captured (pre-spec)', () => {
    writeManifest('alpha', { enabled: false });
    writeMd('alpha', 'body\n');

    const r = bodyDriftedSinceDisable({ stateDir, slug: 'alpha' });
    expect(r.kind).toBe('no-disable-record');
  });

  it('manifest-missing when the slug has no manifest', () => {
    const r = bodyDriftedSinceDisable({ stateDir, slug: 'ghost-slug' });
    expect(r.kind).toBe('manifest-missing');
  });

  it('body-missing when the manifest exists but the .md file is gone', () => {
    writeManifest('alpha', { enabled: false, disabledAtBodyHash: hashBody('body') });
    // No .md file written.

    const r = bodyDriftedSinceDisable({ stateDir, slug: 'alpha' });
    expect(r.kind).toBe('body-missing');
  });

  it('drift detection ignores frontmatter content; only the body bytes are hashed', () => {
    const body = 'consistent body bytes\n';
    const hash = hashBody(body);
    writeManifest('alpha', { enabled: false, disabledAtBodyHash: hash });
    // Write a .md whose frontmatter differs from a hypothetical earlier version
    // but whose body matches. Frontmatter is NOT in the hash, so this is no-drift.
    const dir = path.join(stateDir, 'jobs', 'user');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'alpha.md'), `---\nname: changed-name\ndescription: changed\n---\n${body}`);

    const r = bodyDriftedSinceDisable({ stateDir, slug: 'alpha' });
    expect(r.kind).toBe('no-drift');
  });

  // ── listDriftedDisabledSlugs ───────────────────────────────────────

  it('listDriftedDisabledSlugs returns all slugs whose disabled body has drifted', () => {
    writeManifest('drifted-1', { enabled: false, disabledAtBodyHash: hashBody('old') });
    writeMd('drifted-1', 'new');
    writeManifest('drifted-2', { enabled: false, disabledAtBodyHash: hashBody('old') });
    writeMd('drifted-2', 'newer');
    writeManifest('not-drifted', { enabled: false, disabledAtBodyHash: hashBody('same') });
    writeMd('not-drifted', 'same');
    writeManifest('enabled', { enabled: true });
    writeMd('enabled', 'whatever');

    const r = listDriftedDisabledSlugs(stateDir);
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.slug).sort()).toEqual(['drifted-1', 'drifted-2']);
  });

  it('listDriftedDisabledSlugs returns empty when no manifests exist', () => {
    expect(listDriftedDisabledSlugs(stateDir)).toEqual([]);
  });

  // ── stampDisabledAtBodyHash ────────────────────────────────────────

  it('stampDisabledAtBodyHash writes the current body hash + sets enabled:false', () => {
    writeManifest('alpha', { enabled: true });
    writeMd('alpha', 'body content\n');

    const hash = stampDisabledAtBodyHash(stateDir, 'alpha');
    expect(hash).toBe(hashBody('body content\n'));

    const re = JSON.parse(fs.readFileSync(path.join(stateDir, 'jobs', 'schedule', 'alpha.json'), 'utf-8'));
    expect(re.enabled).toBe(false);
    expect(re.disabledAtBodyHash).toBe(hash);
  });

  it('stampDisabledAtBodyHash returns null when the manifest is missing', () => {
    expect(stampDisabledAtBodyHash(stateDir, 'ghost')).toBeNull();
  });

  it('stampDisabledAtBodyHash returns null when the body file is missing', () => {
    writeManifest('alpha', { enabled: true });
    expect(stampDisabledAtBodyHash(stateDir, 'alpha')).toBeNull();
  });

  // ── clearDisabledAtBodyHash ────────────────────────────────────────

  it('clearDisabledAtBodyHash drops the field + flips enabled:true', () => {
    writeManifest('alpha', { enabled: false, disabledAtBodyHash: 'sha256:fake' });
    clearDisabledAtBodyHash(stateDir, 'alpha');

    const re = JSON.parse(fs.readFileSync(path.join(stateDir, 'jobs', 'schedule', 'alpha.json'), 'utf-8'));
    expect(re.enabled).toBe(true);
    expect(re.disabledAtBodyHash).toBeUndefined();
  });

  it('clearDisabledAtBodyHash is a no-op when the manifest is missing', () => {
    // Should not throw.
    expect(() => clearDisabledAtBodyHash(stateDir, 'ghost')).not.toThrow();
  });

  // ── Roundtrip property ────────────────────────────────────────────

  it('stamp → drift-check round-trip: stamping then checking returns no-drift; modifying body then re-checking returns drifted', () => {
    writeManifest('rt', { enabled: true });
    writeMd('rt', 'v1\n');

    stampDisabledAtBodyHash(stateDir, 'rt');
    expect(bodyDriftedSinceDisable({ stateDir, slug: 'rt' }).kind).toBe('no-drift');

    // Modify the body.
    writeMd('rt', 'v2\n');
    expect(bodyDriftedSinceDisable({ stateDir, slug: 'rt' }).kind).toBe('drifted');
  });
});
