/**
 * Verifies the migrateFrameworkShadowCapabilities shim added for the
 * cross-framework portability audit (Gap 6 — operator-chosen "minimal shim"
 * approach). The shim mirrors capability-instruction sections from the
 * patched CLAUDE.md into AGENTS.md/GEMINI.md when those shadows exist,
 * so Codex/Gemini agents get the same "here's what you can do" instructions
 * as Claude Code (identity is already mirrored by Gap 1).
 *
 * Bodies are literally copied from CLAUDE.md, never duplicated in source,
 * so the two cannot drift.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function migrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test-agent',
  });
}

function runShadowCaps(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateFrameworkShadowCapabilities(r: MigrationResult): void }).migrateFrameworkShadowCapabilities(result);
  return result;
}

const CLAUDE_MD_FIXTURE = `# CLAUDE.md — instar

## What This Project Is

Intro text.

### Self-Discovery (Know Before You Claim)

Before claiming a missing capability, curl the live capabilities endpoint.

**Private Viewing** — Render markdown as auth-gated HTML.
Inline body.

**Dashboard** — Visual web interface.
More inline body.

### Coherence Gate (Pre-Action Verification)

Check coherence before high-risk actions.

## Threadline Network (Agent-to-Agent Communication)

Encrypted agent-to-agent messaging.
`;

describe('PostUpdateMigrator — migrateFrameworkShadowCapabilities (Gap 6 minimal shim)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-shadow-cap-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-shadowCapabilities.test.ts',
    });
  });

  it('appends missing capability sections to AGENTS.md from CLAUDE.md', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), CLAUDE_MD_FIXTURE);
    fs.writeFileSync(
      path.join(projectDir, 'AGENTS.md'),
      '# Echo\n\nCanonical identity body (no capability sections yet).\n',
    );

    const result = runShadowCaps(migrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.startsWith('AGENTS.md:'))).toBe(true);

    const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('### Self-Discovery');
    expect(agents).toContain('**Private Viewing**');
    expect(agents).toContain('**Dashboard**');
    expect(agents).toContain('### Coherence Gate');
    expect(agents).toContain('## Threadline Network');
    // canonical identity preserved
    expect(agents).toContain('Canonical identity body');
  });

  it('is idempotent — second run does not re-append', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), CLAUDE_MD_FIXTURE);
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Echo\n\nidentity\n');

    runShadowCaps(migrator(projectDir));
    const first = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    const result2 = runShadowCaps(migrator(projectDir));
    const second = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');

    expect(second).toBe(first);
    expect(result2.upgraded.some(u => u.startsWith('AGENTS.md:'))).toBe(false);
    expect(result2.skipped.some(s => s.includes('already present'))).toBe(true);
  });

  it('mirrors into BOTH AGENTS.md and GEMINI.md when both exist', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), CLAUDE_MD_FIXTURE);
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# id\n');
    fs.writeFileSync(path.join(projectDir, 'GEMINI.md'), '# id\n');

    const result = runShadowCaps(migrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8')).toContain('### Self-Discovery');
    expect(fs.readFileSync(path.join(projectDir, 'GEMINI.md'), 'utf-8')).toContain('### Self-Discovery');
  });

  it('no-op when no shadow exists (Claude-only install)', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), CLAUDE_MD_FIXTURE);

    const result = runShadowCaps(migrator(projectDir));

    expect(result.upgraded).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('no-op (with note) when CLAUDE.md is absent', () => {
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# id\n');

    const result = runShadowCaps(migrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('CLAUDE.md absent'))).toBe(true);
  });

  it('preserves identity content above the appended sections', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), CLAUDE_MD_FIXTURE);
    const identity = '# Echo identity\n\n## Who I am\n\nThe Echo agent.\n';
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), identity);

    runShadowCaps(migrator(projectDir));

    const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    expect(agents.startsWith(identity.trimEnd())).toBe(true);
  });

  // --- Secret Drop propagation (2026-05-24, codey live-test J-secret-drop) ---
  // Fixture reproduces the real adjacency that broke: Secret Drop sits BETWEEN
  // Private Viewing and Cloudflare Tunnel as a `**bold**` block with no heading
  // between them.
  const SECRET_ADJACENCY_FIXTURE = `# CLAUDE.md — instar

### Self-Discovery (Know Before You Claim)

curl the capabilities endpoint.

**Private Viewing** — Render markdown as auth-gated HTML.
Private body line.

**Secret Drop** — Securely collect secrets from users.
- Request: POST /secrets/request
- **When to use**: NEVER ask the user to edit a local file; always issue a one-time link.

**Cloudflare Tunnel** — Expose the local server.
Tunnel body line.

**Dashboard** — Visual web interface.
Dashboard body line.

### Coherence Gate (Pre-Action Verification)

Check coherence.
`;

  it('propagates Secret Drop to a shadow that already has its neighbors but not Secret Drop (no over-grab/dup)', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), SECRET_ADJACENCY_FIXTURE);
    // AGENTS.md generated from an OLDER template: has Private Viewing + Tunnel
    // + Dashboard but predates Secret Drop. This is codey's exact situation.
    fs.writeFileSync(
      path.join(projectDir, 'AGENTS.md'),
      `# Echo

### Self-Discovery (Know Before You Claim)

curl the capabilities endpoint.

**Private Viewing** — Render markdown as auth-gated HTML.
Private body line.

**Cloudflare Tunnel** — Expose the local server.
Tunnel body line.

**Dashboard** — Visual web interface.
Dashboard body line.
`,
    );

    const result = runShadowCaps(migrator(projectDir));
    expect(result.errors).toEqual([]);

    const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    // Secret Drop now present...
    expect(agents).toContain('**Secret Drop**');
    expect(agents).toContain('always issue a one-time link');
    // ...and adjacent sections are NOT duplicated by the slice over-grab.
    expect(agents.match(/\*\*Cloudflare Tunnel\*\*/g)?.length).toBe(1);
    expect(agents.match(/\*\*Private Viewing\*\*/g)?.length).toBe(1);
    expect(agents.match(/\*\*Dashboard\*\*/g)?.length).toBe(1);
    // The Secret Drop slice must stop at the next marker — it must NOT have
    // dragged the Cloudflare Tunnel body in with it.
    expect(agents.match(/\*\*Secret Drop\*\*/g)?.length).toBe(1);
  });

  it('propagates Commitments & Follow-Through to a shadow that has its neighbors but not it (no over-grab)', () => {
    const claudeMd = `# CLAUDE.md — instar

### Self-Discovery (Know Before You Claim)

curl the capabilities endpoint.

**Private Viewing** — auth-gated HTML.
Private body.

**Secret Drop** — secure secret intake.
Secret body.

**Commitments & Follow-Through** — durable promise tracking.
- Open: POST /commitments
- NEVER improvise the follow-through with a raw sleep/timer.

**Cloudflare Tunnel** — expose the server.
Tunnel body.

### Coherence Gate

Check coherence.
`;
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), claudeMd);
    fs.writeFileSync(
      path.join(projectDir, 'AGENTS.md'),
      '# Echo\n\n### Self-Discovery (Know Before You Claim)\n\ncurl it.\n\n**Private Viewing** — auth-gated HTML.\nPrivate body.\n\n**Cloudflare Tunnel** — expose the server.\nTunnel body.\n',
    );

    const result = runShadowCaps(migrator(projectDir));
    expect(result.errors).toEqual([]);

    const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('**Commitments & Follow-Through**');
    expect(agents).toContain('NEVER improvise the follow-through');
    expect(agents.match(/\*\*Cloudflare Tunnel\*\*/g)?.length).toBe(1);
    expect(agents.match(/\*\*Commitments & Follow-Through\*\*/g)?.length).toBe(1);
  });

  it('fresh shadow: every bold capability section is appended exactly once (slice bounded at next marker)', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), SECRET_ADJACENCY_FIXTURE);
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Echo\n\nidentity only\n');

    const result = runShadowCaps(migrator(projectDir));
    expect(result.errors).toEqual([]);

    const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    for (const marker of ['**Private Viewing**', '**Secret Drop**', '**Cloudflare Tunnel**', '**Dashboard**', '### Self-Discovery', '### Coherence Gate']) {
      const re = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      expect(agents.match(re)?.length, `${marker} should appear exactly once`).toBe(1);
    }
  });
});
