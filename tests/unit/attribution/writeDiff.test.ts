import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInScope, listScopeFiles, realpathLoose, withoutManagedRegion } from '../../../src/core/attribution/attributionScope.js';
import { changedBlocks, changedLines, planApplyPatch, planWrites } from '../../../src/core/attribution/writeDiff.js';
import { CLAUDE_MD_CORE_END, CLAUDE_MD_CORE_START_PREFIX } from '../../../src/scaffold/claudeMdLayout.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('planWrites', () => {
  const disk = '# Notes\n- old line\n- other\n';
  const read = () => disk;

  it('Write is diffed against the file on disk', () => {
    const [plan] = planWrites('Write', { file_path: 'a.md', content: '# Notes\n- old line\n- other\n- new line\n' }, read);
    expect(changedLines(plan.before, plan.after).map((i) => plan.after.split('\n')[i])).toEqual(['- new line']);
  });

  it('Edit keeps old_string, which proves the parent', () => {
    const [plan] = planWrites('Edit', { file_path: 'a.md', old_string: '- old line', new_string: '- new line' }, read);
    expect(plan.oldText).toBe('- old line');
    expect(plan.after).toContain('- new line');
    expect(plan.after).not.toContain('- old line');
  });

  it('MultiEdit applies in order', () => {
    const [plan] = planWrites('MultiEdit', { file_path: 'a.md', edits: [{ old_string: '- old line', new_string: '- two' }, { old_string: '- two', new_string: '- three' }] }, read);
    expect(plan.after).toContain('- three');
  });

  it('a replacement holding $& stays literal', () => {
    const [plan] = planWrites('Edit', { file_path: 'a.md', old_string: '- other', new_string: '- costs $& more' }, read);
    expect(plan.after).toContain('- costs $& more');
  });

  it('apply_patch reads Codex patches, including several files and a stale hunk', () => {
    const patch = ['*** Begin Patch', '*** Update File: a.md', '@@', ' # Notes', '-- old line', '+- patched', '*** Add File: b.md', '+fresh', '*** Delete File: c.md', '*** End Patch'].join('\n');
    const plans = planWrites('functions.apply_patch', { input: patch }, read);
    expect(plans.map((plan) => plan.path)).toEqual(['a.md', 'b.md']);
    expect(plans[0].after).toContain('- patched');
    expect(plans[0].oldText).toBe('- old line');
    expect(plans[1].after).toBe('fresh');
    const stale = planApplyPatch('*** Update File: a.md\n@@\n-gone\n+arrives', read);
    expect(stale[0].after).toContain('arrives');
  });

  it('an unknown tool or a missing path plans nothing', () => {
    expect(planWrites('Read', { file_path: 'a.md' }, read)).toEqual([]);
    expect(planWrites('Edit', {}, read)).toEqual([]);
  });
});

describe('changedBlocks', () => {
  it('reordering lines changes nothing; a repeated line counts', () => {
    expect(changedLines('a\nb', 'b\na')).toEqual([]);
    expect(changedLines('a', 'a\na')).toEqual([1]);
  });

  it('shows a changed line with its paragraph and heading', () => {
    const after = '# Rules\n\nline one\nline two\n\nother para';
    const blocks = changedBlocks(after, [3]);
    expect(blocks.text).toBe('# Rules\nline one\nline two');
    expect(blocks.refusable).toEqual(['line two']);
  });

  it('a changed heading makes the lines under it refusable, or it could never fail', () => {
    const after = "# Justin's standing rules\n- never spawn on the laptop\n\n# Other\n- keep";
    const blocks = changedBlocks(after, [0]);
    expect(blocks.text).toContain('never spawn on the laptop');
    expect(blocks.refusable).toContain('- never spawn on the laptop');
    expect(blocks.text).not.toContain('keep');
  });

  it('merges neighbouring changes', () => {
    expect(changedBlocks('a\nb\nc', [0, 2]).text).toBe('a\nb\nc');
  });
});

describe('scope', () => {
  let project: string;
  beforeEach(() => {
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'attr-scope-')));
    fs.mkdirSync(path.join(project, '.instar', 'agent-memory'), { recursive: true });
    fs.mkdirSync(path.join(project, '.claude', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(project, 'lanes'));
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(project, { recursive: true, force: true, operation: 'tests/unit/attribution/writeDiff.test.ts:cleanup' }); });
  const opts = (extra?: string[]) => ({ projectDir: project, stateDir: path.join(project, '.instar'), extraPaths: extra });

  it('covers the default notes and nothing else', () => {
    for (const inside of ['.instar/MEMORY.md', '.instar/USER.md', '.instar/AGENT.md', 'CLAUDE.md', '.instar/agent-memory/new.md', '.claude/rules/x/y.md']) {
      expect(isInScope(path.join(project, inside), opts()), inside).toBe(true);
    }
    for (const outside of ['src/a.ts', 'lanes/plan.md', '.instar/config.json', '.instar/MEMORY.md.bak']) {
      expect(isInScope(path.join(project, outside), opts()), outside).toBe(false);
    }
  });

  it('follows a link into the memory folder, and a link out of it', () => {
    const link = path.join(project, 'memlink');
    fs.symlinkSync(path.join(project, '.instar', 'agent-memory'), link);
    expect(isInScope(path.join(link, 'note.md'), opts())).toBe(true);
    const away = path.join(project, '.instar', 'agent-memory', 'away');
    fs.symlinkSync(path.join(project, 'lanes'), away);
    expect(isInScope(path.join(away, 'note.md'), opts())).toBe(false);
  });

  it('a login\'s unlinked memory folder for this project counts; another project\'s does not', () => {
    const segment = project.replace(/[/.]/g, '-');
    expect(isInScope(`/tmp/x/.claude/projects/${segment}/memory/a.md`, opts())).toBe(true);
    expect(isInScope('/tmp/x/.claude/projects/-other/memory/a.md', opts())).toBe(false);
  });

  it('attribution.paths extends the scope, confined under the agent home', () => {
    expect(isInScope(path.join(project, 'lanes', 'a.md'), opts(['lanes/']))).toBe(true);
    expect(isInScope('/etc/passwd', opts(['/etc/passwd']))).toBe(false);
  });

  it('lists notes for the audit', () => {
    fs.writeFileSync(path.join(project, '.instar', 'MEMORY.md'), 'x');
    fs.writeFileSync(path.join(project, '.instar', 'agent-memory', 'a.md'), 'x');
    fs.writeFileSync(path.join(project, '.instar', 'agent-memory', 'skip.json'), '{}');
    const files = listScopeFiles(opts()).map((file) => path.basename(file)).sort();
    expect(files).toEqual(['MEMORY.md', 'a.md']);
  });

  it('realpathLoose resolves a path that does not exist yet', () => {
    expect(realpathLoose(path.join(project, 'lanes', 'new', 'a.md'))).toBe(path.join(project, 'lanes', 'new', 'a.md'));
  });

  it('leaves out instar\'s managed region of CLAUDE.md only', () => {
    const text = `mine\n${CLAUDE_MD_CORE_START_PREFIX} x -->\nmanaged\n${CLAUDE_MD_CORE_END}\nalso mine`;
    expect(withoutManagedRegion('/a/CLAUDE.md', text)).not.toContain('managed');
    expect(withoutManagedRegion('/a/CLAUDE.md', text)).toContain('also mine');
    expect(withoutManagedRegion('/a/NOTES.md', text)).toBe(text);
  });
});
