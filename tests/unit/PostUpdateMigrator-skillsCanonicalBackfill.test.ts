/**
 * Skill canonical backfill — docs/specs/skill-learning-sentinel.md slice 0,
 * frontloaded decisions 6 (conflict policy) and 7 (unconditional, copy-only,
 * idempotent). The concept spec (specs/instar-concepts/skill.md) deferred this
 * and it never shipped: every deployed agent had skills only under
 * `.claude/skills/` and an absent `.instar/skills/`.
 *
 * Covers: copy of SKILL.md + scripts/ + references/ + other files verbatim,
 * symlinks skipped, `.agents`-only copy (its `agents/openai.yaml` sibling not
 * copied), invalid slugs refused + logged, dirs without SKILL.md skipped,
 * `.claude` wins a differing `.agents` copy (left untouched, unstamped, logged
 * `canonical-backfill-conflict`), nothing deleted, stamps written and read as
 * in-sync by the REAL parity rule's verify(), idempotent second run, the
 * one-line count summary; `migrateBuiltinSkillRenderings` renders only ABSENT
 * renderings; `installBuiltinSkills` writes canonical first.
 */

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PostUpdateMigrator,
  skillBodyHash,
  stampSkillRendering,
  type MigrationResult,
} from '../../src/core/PostUpdateMigrator.js';
import { skillParityRule } from '../../src/providers/parity/rules/skillParityRule.js';
import { installBuiltinSkills, canonicalSkillsRootFor } from '../../src/commands/init.js';

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function emptyResult(): MigrationResult {
  return { upgraded: [], skipped: [], errors: [] };
}

function write(p: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function skillMd(name: string, body: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: Test skill ${name}\n${extra}---\n${body}`;
}

/** Every regular file under a root, as relative path → bytes (for "nothing deleted" checks). */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) { out.set(path.relative(root, p), `symlink:${fs.readlinkSync(p)}`); continue; }
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(root, p), fs.readFileSync(p, 'utf-8'));
    }
  };
  walk(root);
  return out;
}

describe('PostUpdateMigrator.migrateSkillsCanonicalBackfill', () => {
  let home: string;
  const alphaBody = '# Alpha\n\nDo the alpha thing.\n';
  const betaBody = '# Beta\n\nCodex-only skill body.\n';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-skill-backfill-'));
    fs.mkdirSync(path.join(home, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(home, '.instar', 'config.json'), JSON.stringify({ enabledFrameworks: ['claude-code'] }));

    // A Claude rendering with bundled subdirs, an extra top-level file, and a symlink.
    write(path.join(home, '.claude/skills/alpha/SKILL.md'), skillMd('alpha', alphaBody, 'allowed-tools: Bash\n'));
    write(path.join(home, '.claude/skills/alpha/scripts/run.sh'), '#!/bin/bash\necho alpha\n');
    write(path.join(home, '.claude/skills/alpha/references/notes.md'), '# notes\n');
    write(path.join(home, '.claude/skills/alpha/templates/report.md'), '# template\n');
    write(path.join(home, '.claude/skills/alpha/assets/logo.bin'), Buffer.from([0, 1, 2, 255]));
    fs.symlinkSync('/etc/hostname', path.join(home, '.claude/skills/alpha/escape-link'));
    // The same skill under .agents with a DIFFERENT body → conflict.
    write(path.join(home, '.agents/skills/alpha/SKILL.md'), skillMd('alpha', alphaBody + 'Codex-side edit.\n'));
    write(path.join(home, '.agents/skills/alpha/agents/openai.yaml'), 'interface:\n  display_name: Alpha\n');
    // A codex-only skill.
    write(path.join(home, '.agents/skills/beta/SKILL.md'), skillMd('beta', betaBody));
    write(path.join(home, '.agents/skills/beta/agents/openai.yaml'), 'interface:\n  display_name: Beta\n');
    write(path.join(home, '.agents/skills/beta/scripts/go.py'), 'print(1)\n');
    // Invalid slug (capital + space) and a dir with no SKILL.md.
    write(path.join(home, '.claude/skills/Bad Name/SKILL.md'), skillMd('bad', 'x\n'));
    write(path.join(home, '.claude/skills/nomd/scripts/tool.sh'), 'echo\n');
    // A plain file at the skills root (not a dir) must be ignored.
    write(path.join(home, '.claude/skills/README.md'), 'not a skill\n');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-skillsCanonicalBackfill.test.ts' });
  });

  it('copies renderings into canonical verbatim, applies the conflict policy, stamps, deletes nothing', async () => {
    const before = snapshot(path.join(home, '.claude/skills'));
    const beforeAgents = snapshot(path.join(home, '.agents/skills'));
    const result = emptyResult();
    await newMigrator(home).migrateSkillsCanonicalBackfill(result);

    // alpha: the .claude copy became canonical, with scripts/, references/, assets/, other files; symlink skipped.
    const canon = path.join(home, '.instar/skills');
    expect(fs.readFileSync(path.join(canon, 'alpha/SKILL.md'), 'utf-8')).toBe(before.get('alpha/SKILL.md'));
    expect(fs.readFileSync(path.join(canon, 'alpha/scripts/run.sh'), 'utf-8')).toBe('#!/bin/bash\necho alpha\n');
    expect(fs.readFileSync(path.join(canon, 'alpha/references/notes.md'), 'utf-8')).toBe('# notes\n');
    expect(fs.readFileSync(path.join(canon, 'alpha/templates/report.md'), 'utf-8')).toBe('# template\n');
    expect([...fs.readFileSync(path.join(canon, 'alpha/assets/logo.bin'))]).toEqual([0, 1, 2, 255]);
    expect(fs.existsSync(path.join(canon, 'alpha/escape-link'))).toBe(false);
    // beta: the .agents copy became canonical; its openai.yaml sibling is a rendering artifact, not canonical.
    expect(fs.readFileSync(path.join(canon, 'beta/SKILL.md'), 'utf-8')).toBe(beforeAgents.get('beta/SKILL.md'));
    expect(fs.readFileSync(path.join(canon, 'beta/scripts/go.py'), 'utf-8')).toBe('print(1)\n');
    expect(fs.existsSync(path.join(canon, 'beta/agents'))).toBe(false);
    // Invalid slug and SKILL.md-less dir: no canonical, logged.
    expect(fs.existsSync(path.join(canon, 'Bad Name'))).toBe(false);
    expect(fs.existsSync(path.join(canon, 'nomd'))).toBe(false);
    expect(result.skipped.some(s => s.startsWith('canonical-backfill-invalid-name: claude/Bad Name'))).toBe(true);
    expect(result.skipped.some(s => s.startsWith('canonical-backfill-no-skill-md: nomd'))).toBe(true);
    // No temp dir left behind (temp + rename).
    expect(fs.readdirSync(canon).sort()).toEqual(['alpha', 'beta']);

    // Conflict policy: the differing .agents/alpha copy is untouched, unstamped, logged.
    expect(fs.readFileSync(path.join(home, '.agents/skills/alpha/SKILL.md'), 'utf-8')).toBe(beforeAgents.get('alpha/SKILL.md'));
    expect(fs.readFileSync(path.join(home, '.agents/skills/alpha/SKILL.md'), 'utf-8')).not.toContain('x-instar-stamp');
    expect(result.skipped.some(s => s.startsWith('canonical-backfill-conflict: alpha (agents'))).toBe(true);

    // Stamps: the .claude/alpha and .agents/beta renderings now carry the canonical body hash; bodies untouched.
    const alphaHash = skillBodyHash(fs.readFileSync(path.join(canon, 'alpha/SKILL.md'), 'utf-8'));
    const claudeAlpha = fs.readFileSync(path.join(home, '.claude/skills/alpha/SKILL.md'), 'utf-8');
    expect(claudeAlpha).toContain(`x-instar-stamp: ${alphaHash}`);
    expect(claudeAlpha).toContain('allowed-tools: Bash'); // extra frontmatter preserved (never re-rendered)
    expect(claudeAlpha.endsWith(alphaBody)).toBe(true);
    const betaHash = skillBodyHash(fs.readFileSync(path.join(canon, 'beta/SKILL.md'), 'utf-8'));
    expect(fs.readFileSync(path.join(home, '.agents/skills/beta/SKILL.md'), 'utf-8')).toContain(`x-instar-stamp: ${betaHash}`);

    // Nothing deleted: every source file still exists; only the two stamped SKILL.md files changed.
    const after = snapshot(path.join(home, '.claude/skills'));
    const afterAgents = snapshot(path.join(home, '.agents/skills'));
    for (const [rel, content] of before) {
      expect(after.has(rel), `deleted: .claude/skills/${rel}`).toBe(true);
      if (rel !== 'alpha/SKILL.md') expect(after.get(rel)).toBe(content);
    }
    for (const [rel, content] of beforeAgents) {
      expect(afterAgents.has(rel), `deleted: .agents/skills/${rel}`).toBe(true);
      if (rel !== 'beta/SKILL.md') expect(afterAgents.get(rel)).toBe(content);
    }

    // One-line count summary.
    const summary = result.upgraded.find(u => u.startsWith('canonical-backfill: 2 copied, 2 stamped, 1 conflicts'));
    expect(summary).toBeDefined();
    expect(result.errors).toEqual([]);
  });

  it('the stamp it writes is the hash the REAL parity rule computes: verify() reads the rendering as in sync', async () => {
    await newMigrator(home).migrateSkillsCanonicalBackfill(emptyResult());
    const verdict = await skillParityRule.verify(home, 'alpha');
    const claudeIssues = verdict.mismatches.filter(m => m.framework === 'claude-code').map(m => m.reasonCode);
    expect(claudeIssues).not.toContain('canonical-read-error');
    expect(claudeIssues).not.toContain('missing-rendered-file');
    expect(claudeIssues).not.toContain('body-content-mismatch');
    expect(claudeIssues).not.toContain('user-edit-conflict');
    // Positive control: a hand edit to the stamped rendering is now distinguishable as a user edit.
    const p = path.join(home, '.claude/skills/alpha/SKILL.md');
    fs.appendFileSync(p, 'operator edit\n');
    const after = await skillParityRule.verify(home, 'alpha');
    expect(after.mismatches.some(m => m.framework === 'claude-code' && m.reasonCode === 'user-edit-conflict')).toBe(true);
  });

  it('is idempotent: a second run copies and stamps nothing and changes no bytes', async () => {
    const m = newMigrator(home);
    await m.migrateSkillsCanonicalBackfill(emptyResult());
    const one = { claude: snapshot(path.join(home, '.claude/skills')), agents: snapshot(path.join(home, '.agents/skills')), canon: snapshot(path.join(home, '.instar/skills')) };
    const second = emptyResult();
    await m.migrateSkillsCanonicalBackfill(second);
    expect(snapshot(path.join(home, '.claude/skills'))).toEqual(one.claude);
    expect(snapshot(path.join(home, '.agents/skills'))).toEqual(one.agents);
    expect(snapshot(path.join(home, '.instar/skills'))).toEqual(one.canon);
    expect(second.upgraded).toEqual([]);
    expect(second.skipped.some(s => s.startsWith('canonical-backfill: 0 copied, 0 stamped, 1 conflicts, 2 already canonical'))).toBe(true);
    expect(second.errors).toEqual([]);
  });

  it('a rendering whose unquoted description holds ": " and "#" gets a canonical that PARSES, same content, stamped', async () => {
    const desc = 'Run any sweep. Trigger words: audit, sweep, #hashtag, find all: everything';
    const body = '# Audit\n\nLoop until clean.\n';
    const raw = `---\nname: audit-loop\ndescription: ${desc}\nmetadata:\n  short-description: Audit: loop\nuser-invocable: true\n---\n${body}`;
    write(path.join(home, '.claude/skills/audit-loop/SKILL.md'), raw);
    const result = emptyResult();
    await newMigrator(home).migrateSkillsCanonicalBackfill(result);

    // The REAL parity rule reads the canonical cleanly and sees the full description.
    const verdict = await skillParityRule.verify(home, 'audit-loop');
    expect(verdict.mismatches.map(m => m.reasonCode)).not.toContain('canonical-read-error');
    const canonical = fs.readFileSync(path.join(home, '.instar/skills/audit-loop/SKILL.md'), 'utf-8');
    expect(canonical).toContain(`description: ${JSON.stringify(desc)}`);
    expect(canonical).toContain('short-description: "Audit: loop"');
    expect(canonical).toContain('user-invocable: "true"');
    expect(canonical.endsWith(`---\n${body}`)).toBe(true); // body bytes untouched
    expect(canonical.indexOf('name:') < canonical.indexOf('description:')).toBe(true); // order preserved
    // The rendering keeps its ORIGINAL frontmatter (only stamped) and the stamp equals the canonical body hash.
    const rendered = fs.readFileSync(path.join(home, '.claude/skills/audit-loop/SKILL.md'), 'utf-8');
    expect(rendered).toContain(`description: ${desc}\n`);
    expect(rendered).toContain(`x-instar-stamp: ${skillBodyHash(canonical)}`);
    expect(verdict.mismatches.filter(m => m.framework === 'claude-code').map(m => m.reasonCode)).not.toContain('body-content-mismatch');
    expect(result.upgraded.some(u => u.startsWith('canonical-backfill: audit-loop ←') && u.includes('re-quoted'))).toBe(true);
  });

  it('a rendering whose frontmatter cannot be made to parse gets NO canonical and is logged, rendering untouched', async () => {
    // A top-level YAML sequence can never become a mapping by re-quoting scalars.
    const raw = '---\n- not\n- a mapping\n---\nbody\n';
    write(path.join(home, '.claude/skills/broken/SKILL.md'), raw);
    const result = emptyResult();
    await newMigrator(home).migrateSkillsCanonicalBackfill(result);
    expect(fs.existsSync(path.join(home, '.instar/skills/broken'))).toBe(false);
    expect(fs.readFileSync(path.join(home, '.claude/skills/broken/SKILL.md'), 'utf-8')).toBe(raw);
    expect(result.skipped.some(s => s.startsWith('canonical-backfill-unparseable: .claude/skills/broken/SKILL.md'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('does nothing when there are no renderings at all', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-skill-backfill-empty-'));
    try {
      const result = emptyResult();
      await newMigrator(empty).migrateSkillsCanonicalBackfill(result);
      expect(fs.existsSync(path.join(empty, '.instar/skills'))).toBe(false);
      expect(result.upgraded).toEqual([]);
      expect(result.errors).toEqual([]);
    } finally {
      SafeFsExecutor.safeRmSync(empty, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-skillsCanonicalBackfill.test.ts' });
    }
  });
});

describe('skill stamp helpers', () => {
  it('skillBodyHash hashes the body after the frontmatter and refuses files without one', () => {
    const raw = '---\nname: x\ndescription: y\n---\nbody line\n';
    expect(skillBodyHash(raw)).toMatch(/^[a-f0-9]{64}$/);
    expect(skillBodyHash(raw)).toBe(skillBodyHash('---\nname: other\n---\nbody line\n'));
    expect(skillBodyHash('no frontmatter\n')).toBeNull();
  });

  it('stampSkillRendering inserts the stamp as the last frontmatter line, once, leaving the body intact', () => {
    const raw = '---\nname: x\ndescription: y\n---\nbody line\n';
    const hash = 'a'.repeat(64);
    const stamped = stampSkillRendering(raw, hash);
    expect(stamped).toBe(`---\nname: x\ndescription: y\nx-instar-stamp: ${hash}\n---\nbody line\n`);
    expect(skillBodyHash(stamped!)).toBe(skillBodyHash(raw));
    expect(stampSkillRendering(stamped!, hash)).toBeNull(); // never rewrites an existing stamp
    expect(stampSkillRendering('no frontmatter\n', hash)).toBeNull();
  });
});

describe('PostUpdateMigrator.migrateBuiltinSkillRenderings', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-skill-render-'));
    fs.mkdirSync(path.join(home, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(home, '.instar', 'config.json'), JSON.stringify({ enabledFrameworks: ['claude-code', 'codex-cli'] }));
    write(path.join(home, '.instar/skills/gamma/SKILL.md'), skillMd('gamma', '# Gamma\n'));
    write(path.join(home, '.instar/skills/gamma/scripts/g.sh'), 'echo g\n');
    // Claude rendering present (unstamped, hand-written); codex rendering absent.
    write(path.join(home, '.claude/skills/gamma/SKILL.md'), skillMd('gamma', '# Gamma\n', 'user-invocable: true\n'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-skillsCanonicalBackfill.test.ts' });
  });

  it('renders only ABSENT renderings through the parity rule and never overwrites one on disk', async () => {
    const claudeBefore = fs.readFileSync(path.join(home, '.claude/skills/gamma/SKILL.md'), 'utf-8');
    const result = emptyResult();
    await newMigrator(home).migrateBuiltinSkillRenderings(result);
    expect(fs.readFileSync(path.join(home, '.claude/skills/gamma/SKILL.md'), 'utf-8')).toBe(claudeBefore);
    const codex = fs.readFileSync(path.join(home, '.agents/skills/gamma/SKILL.md'), 'utf-8');
    expect(codex).toContain('x-instar-stamp:');
    expect(fs.existsSync(path.join(home, '.agents/skills/gamma/agents/openai.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(home, '.agents/skills/gamma/scripts/g.sh'), 'utf-8')).toBe('echo g\n');
    expect(result.upgraded).toContain('skill-renderings: gamma → codex-cli');
    expect(result.upgraded).not.toContain('skill-renderings: gamma → claude-code');

    const again = emptyResult();
    await newMigrator(home).migrateBuiltinSkillRenderings(again);
    expect(again.upgraded).toEqual([]);
    expect(again.skipped).toContain('skill-renderings: every canonical skill already rendered for the enabled frameworks');
  });

  it('skips every LEARNED canonical (pending stays unrendered; an active learned one is the reconciler\'s) and still renders the hand-written one', async () => {
    const learned = (name: string, state: string): string => `---\nname: ${name}\ndescription: Learned ${name}\nmetadata:\n  instar-learned-origin: "skill-learning-sentinel"\n  instar-learned-state: "${state}"\n---\n# ${name}\n`;
    write(path.join(home, '.instar/skills/pending-one/SKILL.md'), learned('pending-one', 'pending'));
    write(path.join(home, '.instar/skills/active-one/SKILL.md'), learned('active-one', 'active'));
    const result = emptyResult();
    await newMigrator(home).migrateBuiltinSkillRenderings(result);
    expect(fs.existsSync(path.join(home, '.claude/skills/pending-one'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.agents/skills/pending-one'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude/skills/active-one'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.agents/skills/gamma/SKILL.md'))).toBe(true); // hand-written: rendered as before
    expect(result.skipped).toContain('skill-renderings: pending-one is a learned canonical — the learned-skill reconciler renders it by state');
    expect(result.skipped).toContain('skill-renderings: active-one is a learned canonical — the learned-skill reconciler renders it by state');
    expect(result.upgraded).toEqual(['skill-renderings: gamma → codex-cli']);
    expect(result.errors).toEqual([]);
  });

  it('migrateParityRenderings (the generic parity pass) skips learned canonicals too, and a render-held refusal from the rule is a skip, not an error', async () => {
    const learned = (name: string, state: string): string => `---\nname: ${name}\ndescription: Learned ${name}\nmetadata:\n  instar-learned-origin: "skill-learning-sentinel"\n  instar-learned-state: "${state}"\n---\n# ${name}\n`;
    write(path.join(home, '.instar/skills/pending-two/SKILL.md'), learned('pending-two', 'pending'));
    write(path.join(home, '.instar/skills/owned-two/SKILL.md'), learned('owned-two', 'operator-owned'));
    const result = emptyResult();
    await (newMigrator(home) as unknown as { migrateParityRenderings(r: MigrationResult): Promise<void> }).migrateParityRenderings(result);
    expect(fs.existsSync(path.join(home, '.claude/skills/pending-two'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.agents/skills/pending-two'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude/skills/owned-two'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.agents/skills/gamma/SKILL.md'))).toBe(true); // the hand-written one still renders
    expect(result.skipped).toContain('parity-renderings: skill/pending-two is a learned canonical — the learned-skill reconciler renders it by state');
    expect(result.skipped).toContain('parity-renderings: skill/owned-two is a learned canonical — the learned-skill reconciler renders it by state');
    expect(result.errors.filter((e) => e.includes('pending-two') || e.includes('owned-two'))).toEqual([]);
    // The rule itself refuses a held canonical when reached directly — and the migrator files that as a skip.
    await expect(skillParityRule.remediate(home, 'pending-two', 'claude-code')).rejects.toThrow(/render-held:pending/);
  });

  it('a canonical the rule cannot read is a skip, not an error, and its rendering is untouched', async () => {
    write(path.join(home, '.instar/skills/delta/SKILL.md'), 'no frontmatter here\n');
    const result = emptyResult();
    await newMigrator(home).migrateBuiltinSkillRenderings(result);
    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.startsWith('skill-renderings: delta on claude-code'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.claude/skills/delta'))).toBe(false);
  });
});

describe('installBuiltinSkills writes canonical first', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-builtin-canonical-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-skillsCanonicalBackfill.test.ts' });
  });

  it('canonicalSkillsRootFor maps <home>/.claude/skills to <home>/.instar/skills and nothing else', () => {
    expect(canonicalSkillsRootFor(path.join(home, '.claude', 'skills'))).toBe(path.join(home, '.instar', 'skills'));
    expect(canonicalSkillsRootFor(path.join(home, 'somewhere', 'skills'))).toBeNull();
    expect(canonicalSkillsRootFor(path.join(home, '.claude'))).toBeNull();
  });

  it('writes .instar/skills/<slug>/SKILL.md for each inline built-in, identical to the Claude rendering, and never overwrites', () => {
    const skillsDir = path.join(home, '.claude', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    // Pre-existing canonical + rendering for one slug must survive untouched.
    write(path.join(home, '.instar/skills/agent-readiness/SKILL.md'), '---\nname: agent-readiness\ndescription: operator version\n---\nkeep me\n');
    write(path.join(skillsDir, 'agent-readiness/SKILL.md'), 'operator rendering\n');

    installBuiltinSkills(skillsDir, 4042);

    const canonicalPassport = fs.readFileSync(path.join(home, '.instar/skills/agent-passport/SKILL.md'), 'utf-8');
    expect(canonicalPassport).toBe(fs.readFileSync(path.join(skillsDir, 'agent-passport/SKILL.md'), 'utf-8'));
    expect(canonicalPassport.startsWith('---\nname: agent-passport\n')).toBe(true);
    expect(fs.existsSync(path.join(home, '.instar/skills/subscription-signin/SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(home, '.instar/skills/agent-readiness/SKILL.md'), 'utf-8')).toContain('keep me');
    expect(fs.readFileSync(path.join(skillsDir, 'agent-readiness/SKILL.md'), 'utf-8')).toBe('operator rendering\n');

    // Idempotent.
    const canonBefore = snapshot(path.join(home, '.instar/skills'));
    installBuiltinSkills(skillsDir, 4042);
    expect(snapshot(path.join(home, '.instar/skills'))).toEqual(canonBefore);
  });

  it('every inline built-in canonical PARSES under the parity rule (the "Trigger words: …" descriptions are re-quoted)', async () => {
    const skillsDir = path.join(home, '.claude', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    installBuiltinSkills(skillsDir, 4042);
    const canon = path.join(home, '.instar', 'skills');
    const names = fs.readdirSync(canon);
    expect(names).toContain('iterative-converging-audit');
    for (const name of names) {
      const verdict = await skillParityRule.verify(home, name);
      const bad = verdict.mismatches.filter(m => m.reasonCode === 'canonical-read-error').map(m => m.detail);
      expect(bad, `${name}: ${bad.join('; ')}`).toEqual([]);
    }
    // Content preserved: the re-quoted description still carries the trigger words verbatim.
    const ica = fs.readFileSync(path.join(canon, 'iterative-converging-audit', 'SKILL.md'), 'utf-8');
    expect(ica).toContain('Trigger words:');
    const body = fs.readFileSync(path.join(skillsDir, 'iterative-converging-audit', 'SKILL.md'), 'utf-8');
    expect(skillBodyHash(ica)).toBe(skillBodyHash(body)); // same body → same stamp
  });

  it('normalizeSkillFrontmatter returns a parseable file byte-identical and leaves a block scalar alone', async () => {
    const { normalizeSkillFrontmatter } = await import('../../src/core/skillCanonicalFrontmatter.js');
    const clean = '---\nname: ok\ndescription: >\n  folded: text # kept\nmetadata:\n  short-description: "q: x"\n---\nbody\n';
    expect(normalizeSkillFrontmatter(clean)).toEqual({ text: clean, changed: false });
    expect(normalizeSkillFrontmatter('no frontmatter\n')).toBeNull();
    const multi = '---\nname: ok\ndescription: first line: with colon\n  continued here\nallowed-tools: [Bash, Read]\n---\nbody\n';
    const fixed = normalizeSkillFrontmatter(multi)!;
    expect(fixed.changed).toBe(true);
    expect(fixed.text).toContain('description: "first line: with colon continued here"');
    expect(fixed.text).toContain('allowed-tools: [Bash, Read]');
    expect(fixed.text.endsWith('---\nbody\n')).toBe(true);
  });

  it('a skills dir that is not <home>/.claude/skills writes no canonical (legacy fixture behaviour kept)', () => {
    const skillsDir = path.join(home, 'custom-skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    installBuiltinSkills(skillsDir, 4042);
    expect(fs.existsSync(path.join(skillsDir, 'agent-passport/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.instar'))).toBe(false);
  });
});
