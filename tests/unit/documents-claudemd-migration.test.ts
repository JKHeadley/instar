// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1 unit tests for the Instar Documents CLAUDE.md awareness text
 * (docs/specs/instar-document-viewer.md, Agent Awareness / Migration Parity). The text is
 * one awareness entry, src/data/awareness/instar-documents.md
 * (docs/specs/awareness-entry-registry.md), so:
 *   - the entry parses with no error and renders with the injected port (never hardcoded);
 *   - generateClaudeMd (new agents via init) includes it;
 *   - migrateClaudeMd (existing agents via update) adds it exactly once, idempotently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { defaultRegistry, renderRegistrySection } from '../../src/awareness/registry.js';

const MARKER = 'Commentable documents on the dashboard document page';

describe('Documents CLAUDE.md awareness (Agent Awareness Standard)', () => {
  it('the entry file parses cleanly', () => {
    const reg = defaultRegistry();
    expect(reg.errors().filter((e) => e.id === 'instar-documents')).toEqual([]);
    expect(reg.eligibleEntries({ port: 4042, hasTelegram: false }).some((e) => e.id === 'instar-documents' && e.title.startsWith(MARKER))).toBe(true);
  });

  it('generateClaudeMd (new-install path) includes the awareness text with the comments read', () => {
    const md = generateClaudeMd('my-proj', 'echo', 4042, true);
    expect(md.split(MARKER).length - 1).toBe(1);
    expect(md).toContain('GET /docs/:id/comments?status=open');
    expect(md).toContain('http://localhost:4042/docs');
    expect(md).toContain('GET /docs/graph');
  });

  it('the entry honors the injected port (never hardcoded)', () => {
    const s = renderRegistrySection({ port: 9999, hasTelegram: false });
    expect(s).toContain('http://localhost:9999/docs');
    expect(s).not.toContain('localhost:4042');
  });
});

describe('migrateClaudeMd adds the documents text for existing agents (Migration Parity), idempotently', () => {
  let projectDir: string;
  let stateDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'documents-claudemd-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'x', port: 4042, claudeMd: { layout: 'full' } /* tests the legacy append chain; the reference-layout conversion is covered in claude-md-reference-layout.test.ts */ }));
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — legacy agent\n\nSome existing content.\n');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/documents-claudemd-migration.test.ts' });
  });

  function countMarker(): number {
    return fs.readFileSync(claudeMdPath, 'utf-8').split(MARKER).length - 1;
  }

  it('adds the text on first migrate, then is a no-op on a second run', () => {
    expect(countMarker()).toBe(0);
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' }).migrate();
    expect(countMarker()).toBe(1);
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toContain('GET /docs/graph');
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' }).migrate();
    expect(countMarker()).toBe(1);
  });
});
