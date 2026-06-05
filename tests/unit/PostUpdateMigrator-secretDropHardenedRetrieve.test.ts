/**
 * Secret Drop hardened retrieve — migration coverage.
 *
 * Two slices:
 *
 * 1. migrateScripts installs `.instar/scripts/secret-drop-retrieve.mjs`
 *    on every update run (always-overwrite, like convergence-check.sh).
 *    This is the structural fix for the 2026-05-20 leak class — agents
 *    that update in place must receive the hardened helper without
 *    waiting for a re-init.
 *
 * 2. migrateClaudeMd rewrites the legacy unsafe `curl /secrets/retrieve/TOKEN`
 *    line to the hardened command form. Idempotent: a CLAUDE.md that already
 *    documents `secret-drop-retrieve.mjs` is left alone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function createMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: true,
    projectName: 'test-agent',
  });
}

function runMigrateScripts(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateScripts(r: MigrationResult): void }).migrateScripts(result);
  return result;
}

function runMigrateClaudeMd(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — Secret Drop hardened retrieve script install', () => {
  let projectDir: string;
  let retrievePath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-secret-drop-retrieve-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    retrievePath = path.join(projectDir, '.instar', 'scripts', 'secret-drop-retrieve.mjs');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts',
    });
  });

  it('installs .instar/scripts/secret-drop-retrieve.mjs on update', () => {
    const result = runMigrateScripts(createMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(retrievePath)).toBe(true);
  });

  it('the installed helper is executable', () => {
    runMigrateScripts(createMigrator(projectDir));
    const mode = fs.statSync(retrievePath).mode & 0o777;
    expect(mode & 0o100).toBeTruthy(); // owner-execute bit set
  });

  it('the installed helper has the hardening guarantees baked in', () => {
    runMigrateScripts(createMigrator(projectDir));
    const content = fs.readFileSync(retrievePath, 'utf-8');
    // Streams field value via process.stdout.write — never console.log the body.
    expect(content).toMatch(/process\.stdout\.write\(v\)/);
    // Never falls back to printing the raw response body.
    expect(content).toMatch(/NEVER print the response body|never prints the response body|that's the leak we're/i);
    // Honors --consume opt-in (default is peek per the 2026-05-20 hardening).
    expect(content).toContain('--consume');
  });

  it('reports the install in the upgraded list', () => {
    const result = runMigrateScripts(createMigrator(projectDir));
    expect(result.upgraded.some(u => u.includes('secret-drop-retrieve.mjs'))).toBe(true);
  });

  it('is safe to re-run (always-overwrite, content unchanged)', () => {
    runMigrateScripts(createMigrator(projectDir));
    const first = fs.readFileSync(retrievePath, 'utf-8');
    runMigrateScripts(createMigrator(projectDir));
    const second = fs.readFileSync(retrievePath, 'utf-8');
    expect(second).toBe(first);
  });
});

describe('PostUpdateMigrator — CLAUDE.md Secret Drop rewrite', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-secret-drop-claudemd-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts',
    });
  });

  it('rewrites the legacy curl line to the hardened helper form', () => {
    const legacy = [
      '# CLAUDE.md — test',
      '',
      '**Secret Drop** — secure secret intake.',
      '- Request: ...',
      '- Retrieve the secret: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/secrets/retrieve/TOKEN`',
      '- List pending: ...',
      '',
    ].join('\n');
    fs.writeFileSync(claudeMdPath, legacy);

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('node .instar/scripts/secret-drop-retrieve.mjs');
    expect(after).toContain('NEVER use `curl /secrets/retrieve`');
    // The legacy unsafe line is gone.
    expect(after).not.toMatch(/Retrieve the secret:.*curl.*\/secrets\/retrieve\/TOKEN/);
    expect(result.upgraded.some(u => u.includes('hardened helper'))).toBe(true);
  });

  it('is idempotent — already-hardened Secret Drop section is left alone', () => {
    const hardened = [
      '# CLAUDE.md — test',
      '',
      '**Secret Drop** — secure secret intake.',
      '- **Retrieve the secret (HARDENED — required)**: `node .instar/scripts/secret-drop-retrieve.mjs TOKEN field-name`',
      '',
    ].join('\n');
    fs.writeFileSync(claudeMdPath, hardened);

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    // The hardened line is preserved exactly — no double-rewrite.
    expect(after).toContain('- **Retrieve the secret (HARDENED — required)**: `node .instar/scripts/secret-drop-retrieve.mjs TOKEN field-name`');
    // The Secret Drop block was NOT touched by this migrator pass.
    expect(result.upgraded.some(u => u.toLowerCase().includes('secret drop'))).toBe(false);
    expect(result.skipped.some(s => s.includes('Secret Drop already documents hardened helper'))).toBe(true);
  });

  // A CLAUDE.md that already has the hardened helper (so the rewrite above is
  // skipped) must still LEARN about the new --run atomic use-and-consume mode.
  // Anchors on the stable leak-class sentence shipped with the hardened bullet.
  const hardenedWithAnchor = [
    '# CLAUDE.md — test',
    '',
    '**Secret Drop** — secure secret intake.',
    '- **Retrieve the secret (HARDENED — required)**: `node .instar/scripts/secret-drop-retrieve.mjs TOKEN field-name`',
    '- **NEVER use `curl /secrets/retrieve` directly** — leaks the value. The hardened script exists specifically to close that leak class (origin: 2026-05-20 incident).',
    '- List pending: ...',
    '',
  ].join('\n');

  it('ADDS the --run atomic use-and-consume guidance when the hardened helper is already documented', () => {
    fs.writeFileSync(claudeMdPath, hardenedWithAnchor);

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('--run -- ');
    expect(after).toContain('Atomic use-and-consume');
    // Inserted right after the leak-class anchor sentence, before "List pending".
    expect(after.indexOf('Atomic use-and-consume')).toBeGreaterThan(after.indexOf('2026-05-20 incident'));
    expect(after.indexOf('Atomic use-and-consume')).toBeLessThan(after.indexOf('List pending'));
    expect(result.upgraded.some(u => u.includes('--run atomic use-and-consume'))).toBe(true);
  });

  it('is idempotent — re-running does not insert a second --run bullet', () => {
    fs.writeFileSync(claudeMdPath, hardenedWithAnchor);
    runMigrateClaudeMd(createMigrator(projectDir)); // first pass inserts it
    const result = runMigrateClaudeMd(createMigrator(projectDir)); // second pass

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    // Exactly one --run bullet — the guard (!includes('--run -- ')) blocks re-insert.
    expect(after.split('Atomic use-and-consume').length - 1).toBe(1);
    expect(result.upgraded.some(u => u.includes('--run atomic use-and-consume'))).toBe(false);
  });

  it('ADDS the full Secret Drop section when a stale CLAUDE.md lacks it entirely', () => {
    // codey's exact situation: CLAUDE.md predates the Secret Drop template
    // section, so it has Private Viewing + Tunnel but no Secret Drop at all.
    // The retrieve-line patch only touches an EXISTING section; this ensures
    // the section is injected when absent (the root of J-secret-drop: codey
    // never learned the capability and improvised a plaintext-file handoff).
    const stale = [
      '# CLAUDE.md — test',
      '',
      '**Private Viewing** — auth-gated HTML pages.',
      '- Create: POST /view',
      '',
      '**Cloudflare Tunnel** — expose the server.',
      '- Status: GET /tunnel',
      '',
      '**Scripts** — helper scripts.',
      '',
    ].join('\n');
    fs.writeFileSync(claudeMdPath, stale);

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('**Secret Drop**');
    expect(after).toContain('POST');
    expect(after).toContain('/secrets/request');
    // The proactive trigger that prevents codey's exact failure mode:
    expect(after).toContain('NEVER create a local file');
    expect(after).toContain('one-time link');
    expect(result.upgraded.some(u => u.includes('added Secret Drop section'))).toBe(true);
    // Inserted before the Cloudflare Tunnel marker (template document order).
    expect(after.indexOf('**Secret Drop**')).toBeLessThan(after.indexOf('**Cloudflare Tunnel**'));
    // Neighbors preserved, not duplicated.
    expect(after.match(/\*\*Cloudflare Tunnel\*\*/g)?.length).toBe(1);
    expect(after.match(/\*\*Private Viewing\*\*/g)?.length).toBe(1);
  });

  it('ADDS the Commitments & Follow-Through section when a stale CLAUDE.md lacks it', () => {
    // codey live (2026-05-24): improvised a raw `sleep` for "report back in 3 min"
    // instead of registering a durable commitment, because the follow-through
    // capability was never agent-facing. Ensure the section is injected when absent.
    const stale = [
      '# CLAUDE.md — test',
      '',
      '**Private Viewing** — auth-gated HTML pages.',
      '- Create: POST /view',
      '',
      '**Cloudflare Tunnel** — expose the server.',
      '- Status: GET /tunnel',
      '',
    ].join('\n');
    fs.writeFileSync(claudeMdPath, stale);

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('**Commitments & Follow-Through**');
    expect(after).toContain('/commitments');
    expect(after).toContain('"agentResponse":"<what you said you would do>"');
    expect(after).toContain('"type":"one-time-action"');
    expect(after).not.toContain('"type":"follow-up"');
    // The proactive trigger that prevents codey's exact failure mode:
    expect(after).toContain('NEVER improvise the follow-through with a raw');
    // Inserted before Cloudflare Tunnel (document order), neighbors not duplicated.
    expect(after.indexOf('**Commitments & Follow-Through**')).toBeLessThan(after.indexOf('**Cloudflare Tunnel**'));
    expect(after.match(/\*\*Cloudflare Tunnel\*\*/g)?.length).toBe(1);
    expect(result.upgraded.some(u => u.includes('added Commitments & Follow-Through section'))).toBe(true);
  });

  it('is idempotent — re-running does not add a second Secret Drop section', () => {
    const stale = '# CLAUDE.md — test\n\n**Cloudflare Tunnel** — expose.\n- Status: GET /tunnel\n';
    fs.writeFileSync(claudeMdPath, stale);

    runMigrateClaudeMd(createMigrator(projectDir));
    const first = fs.readFileSync(claudeMdPath, 'utf-8');
    const result2 = runMigrateClaudeMd(createMigrator(projectDir));
    const second = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(second).toBe(first);
    expect(second.match(/\*\*Secret Drop\*\*/g)?.length).toBe(1);
    expect(result2.skipped.some(s => s.includes('Secret Drop section already present'))).toBe(true);
  });

  it('tolerates a port that does not match the agent\'s configured port', () => {
    // Older agent installed when port was 4040; the line literal uses 4040,
    // but the migrator now runs at 4042. The port-tolerant regex should
    // still find and replace the line.
    const legacy = [
      '# CLAUDE.md — test',
      '',
      '**Secret Drop**',
      '- Retrieve the secret: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4040/secrets/retrieve/TOKEN`',
      '',
    ].join('\n');
    fs.writeFileSync(claudeMdPath, legacy);

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('node .instar/scripts/secret-drop-retrieve.mjs');
    expect(after).not.toMatch(/\/secrets\/retrieve\/TOKEN`/);
    expect(result.upgraded.some(u => u.includes('hardened helper'))).toBe(true);
  });

  it('rewrites legacy unauthenticated Self-Discovery capabilities curl', () => {
    const legacy = [
      '# CLAUDE.md — test',
      '',
      '### Self-Discovery (Know Before You Claim)',
      '',
      'Before EVER saying "I don\'t have", check what actually exists:',
      '',
      '```bash',
      'curl http://localhost:4040/capabilities',
      '```',
      '',
    ].join('\n');
    fs.writeFileSync(claudeMdPath, legacy);

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('curl -H "Authorization: Bearer $AUTH" http://localhost:4042/capabilities');
    expect(after).not.toContain('curl http://localhost:4040/capabilities');
    expect(result.upgraded.some(u => u.includes('authenticated Self-Discovery capabilities curl'))).toBe(true);
  });

  it('adds Self-Discovery with the authenticated capabilities curl when missing', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — test\n\n### How to Build New Capabilities\n\nBuild it.\n');

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('### Self-Discovery (Know Before You Claim)');
    expect(after).toContain('curl -H "Authorization: Bearer $AUTH" http://localhost:4042/capabilities');
    expect(after).not.toContain('curl http://localhost:4042/capabilities');
    expect(result.upgraded.some(u => u.includes('added Self-Discovery section'))).toBe(true);
  });
});

// Store-first durable persistence (2026-06-04): existing agents' Security
// bullet still claims submissions are "in-memory only (never written to
// disk)" — stale once submissions persist to the encrypted SecretStore.
// The migration rewrites the bullet; idempotent on the new wording.
describe('PostUpdateMigrator — CLAUDE.md Secret Drop store-first Security bullet', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-secret-drop-storefirst-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts',
    });
  });

  const oldBullet = '- **Security**: One-time use, expires after 15 minutes, in-memory only (never written to disk), CSRF-protected.';

  it('rewrites the stale in-memory-only Security bullet to the store-first durable wording', () => {
    fs.writeFileSync(claudeMdPath, [
      '# CLAUDE.md — test',
      '',
      '**Secret Drop** — secure secret intake.',
      '- **Retrieve the secret (HARDENED — required)**: `node .instar/scripts/secret-drop-retrieve.mjs TOKEN field-name`',
      oldBullet,
      '',
    ].join('\n'));

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).not.toContain('in-memory only (never written to disk)');
    expect(after).toContain('persisted store-first to the durable AES-256-GCM encrypted SecretStore');
    expect(after).toContain('secrets.persistDrops: false');
    expect(result.upgraded.some(u => u.includes('store-first durable persistence'))).toBe(true);
  });

  it('is idempotent — the durable wording is not rewritten again', () => {
    fs.writeFileSync(claudeMdPath, [
      '# CLAUDE.md — test',
      '',
      '**Secret Drop** — secure secret intake.',
      '- **Retrieve the secret (HARDENED — required)**: `node .instar/scripts/secret-drop-retrieve.mjs TOKEN field-name`',
      '- **Security**: One-time link, expires after 15 minutes, CSRF-protected. The moment a secret is SUBMITTED it is also persisted store-first to the durable AES-256-GCM encrypted SecretStore — so it survives session restarts, compaction, and cross-machine handoff instead of evaporating with the in-memory copy. Retrieval transparently falls back to the durable copy, and a successful consume deletes both. (Opt out with `secrets.persistDrops: false` in `.instar/config.json`.)',
      '',
    ].join('\n'));

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    // Other migrations may patch unrelated sections of this minimal fixture;
    // assert only what THIS migration owns: the durable bullet survives
    // verbatim exactly once, and the pass records a skip, not an upgrade.
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after.split('persisted store-first to the durable AES-256-GCM encrypted SecretStore').length - 1).toBe(1);
    expect(after).not.toContain('in-memory only (never written to disk)');
    expect(result.upgraded.some(u => u.includes('store-first durable persistence'))).toBe(false);
    expect(result.skipped.some(s => s.includes('store-first durability already documented'))).toBe(true);
  });

  it('a freshly injected Secret Drop section already carries the durable wording (no stale inject)', () => {
    // No Secret Drop section at all — the section-inject migration adds it and
    // must include the NEW Security wording, never the stale in-memory claim.
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — test\n\n**Cloudflare Tunnel** — tunnel stuff.\n');

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('**Secret Drop**');
    expect(after).not.toContain('in-memory only (never written to disk)');
    expect(after).toContain('persisted store-first to the durable AES-256-GCM encrypted SecretStore');
  });
});
