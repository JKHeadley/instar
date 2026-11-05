import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobCoverageGuide, applyJobMeshGuide } from '../../src/core/jobMeshAwareness.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { renderCoreRegion, REFERENCE_DIR_REL } from '../../src/scaffold/claudeMdLayout.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'job-mesh-awareness-cleanup' }); });
const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });

describe('lease job guidance reaches new and existing agents', () => {
  it('new agents receive API, registry, proactive and building guidance using their actual port', () => {
    const md = generateClaudeMd('fixture', 'Fixture', 4832, false);
    for (const piece of Object.values(jobCoverageGuide(4832))) expect(md).toContain(piece.trim());
    expect(md).toContain('http://localhost:4832/jobs?scope=pool');
  });
  it('existing full files and framework shadows receive it once without losing custom text', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-mesh-awareness-')); roots.push(root);
    fs.mkdirSync(path.join(root, '.instar'));
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Custom instructions\nKeep this operator rule.\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Custom Codex instructions\nKeep this shadow rule.\n');
    const m = new PostUpdateMigrator({ projectDir: root, stateDir: path.join(root, '.instar'), port: 4832, hasTelegram: false, projectName: 'fixture' }) as any;
    const r = result(); m.migrateClaudeMd(r); m.migrateFrameworkShadowCapabilities(r);
    expect(r.errors).toEqual([]);
    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      const before = fs.readFileSync(path.join(root, file), 'utf8');
      for (const piece of Object.values(jobCoverageGuide(4832))) expect(before).toContain(piece.trim());
      expect(before).toContain(file === 'CLAUDE.md' ? 'Keep this operator rule.' : 'Keep this shadow rule.');
    }
    m.migrateClaudeMd(result()); m.migrateFrameworkShadowCapabilities(result());
    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      expect(text.split('**Lease job coverage and catch-up**').length - 1, file).toBe(1);
    }
  });
  it('preserves existing operator guidance and adds no duplicate on repeated application', () => {
    const original = '# Operator\nKeep exactly this line.\n';
    const once = applyJobMeshGuide(original, jobCoverageGuide(4832));
    expect(once).toContain(original);
    expect(applyJobMeshGuide(once, jobCoverageGuide(4832))).toBe(once);
  });
  it('refreshes existing reference-layout files and framework shadows from the canonical guide', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-mesh-reference-')); roots.push(root);
    fs.mkdirSync(path.join(root, '.instar'));
    let old = generateClaudeMd('fixture', 'Fixture', 4832, false);
    for (const piece of Object.values(jobCoverageGuide(4832))) old = old.replace(piece.trim(), '');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), renderCoreRegion(old) + '\n## My Rules\nKeep my reference-layout note.\n');
    fs.writeFileSync(path.join(root, 'GEMINI.md'), '# My Gemini notes\nKeep my Gemini note.\n');
    const m = new PostUpdateMigrator({ projectDir: root, stateDir: path.join(root, '.instar'), port: 4832, hasTelegram: false, projectName: 'fixture' }) as any;
    const r = result(); m.migrateClaudeMd(r); m.migrateFrameworkShadowCapabilities(r);
    expect(r.errors).toEqual([]);
    const referenceDir = path.join(root, REFERENCE_DIR_REL);
    const all = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8') + fs.readdirSync(referenceDir)
      .filter(file => file.endsWith('.md')).map(file => fs.readFileSync(path.join(referenceDir, file), 'utf8')).join('\n');
    for (const piece of Object.values(jobCoverageGuide(4832))) expect(all).toContain(piece.trim());
    expect(all).toContain('Keep my reference-layout note.');
    expect(fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf8')).toContain('**Lease job coverage and catch-up**');
    expect(fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf8')).toContain('Keep my Gemini note.');
  });
});
