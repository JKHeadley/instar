/**
 * silent-loss-refusal-conservation §2.E + §4 — Agent Awareness + Migration Parity.
 * generateClaudeMd carries the Sender-Rejection Notices section; migrateClaudeMd
 * appends it for existing agents, content-sniffed + idempotent.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SENDER_REJECTION_CLAUDEMD_SECTION, PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* ok */ } });

describe('§2.E Agent Awareness — Sender-Rejection Notices', () => {
  it('the section names the mesh-rejection log + the safety gate + the proactive trigger', () => {
    const s = SENDER_REJECTION_CLAUDEMD_SECTION();
    expect(s).toContain('Sender-Rejection Notices');
    expect(s).toContain('logs/mesh-rejections.jsonl');
    expect(s).toContain('registry');
    expect(s.toLowerCase()).toContain('proactive');
  });

  it('generateClaudeMd includes the Sender-Rejection Notices section', () => {
    const md = generateClaudeMd('test-project', 'test-agent', 4042, true);
    expect(md).toContain('Sender-Rejection Notices');
  });

  it('migrateClaudeMd appends the section to an existing CLAUDE.md, idempotently', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'slrc-md-'));
    dirs.push(base);
    const projectDir = base;
    const stateDir = path.join(base, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# CLAUDE.md — test\n\nSome pre-existing content.\n');
    const migrator = new PostUpdateMigrator({ port: 4042, stateDir, projectDir, hasTelegram: false, projectName: 'test' } as any);
    const r1 = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (migrator as any).migrateClaudeMd(r1);
    const after1 = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(after1).toContain('Sender-Rejection Notices');
    // Idempotent: a second run does not duplicate the section.
    const r2 = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (migrator as any).migrateClaudeMd(r2);
    const after2 = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(after2.match(/Sender-Rejection Notices/g)?.length).toBe(1);
  });
});
