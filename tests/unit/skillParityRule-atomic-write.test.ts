/**
 * skillParityRule renderer — rendered files are written temp + rename (C6,
 * landed with skill-learning slice 0). A failure mid-write must leave no
 * partial target and no temp residue, and must keep the previous rendering.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { skillParityRule } from '../../src/providers/parity/rules/skillParityRule.js';

const dirs: string[] = [];
function makeHome(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spr-atomic-'));
  dirs.push(projectDir);
  const canonical = path.join(projectDir, '.instar/skills/demo-skill');
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, 'SKILL.md'), '---\nname: demo-skill\ndescription: "demo"\n---\n# body v1\n');
  return projectDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/skillParityRule-atomic-write.test.ts' });
  }
});

describe('skillParityRule renderer — atomic temp + rename', () => {
  it('a normal render leaves no temp files beside the rendering', async () => {
    const projectDir = makeHome();
    await skillParityRule.remediate(projectDir, 'demo-skill', 'claude-code');
    await skillParityRule.remediate(projectDir, 'demo-skill', 'codex-cli');
    const claudeDir = path.join(projectDir, '.claude/skills/demo-skill');
    const agentsDir = path.join(projectDir, '.agents/skills/demo-skill');
    expect(fs.readdirSync(claudeDir)).toEqual(['SKILL.md']);
    expect(fs.readdirSync(agentsDir).sort()).toEqual(['SKILL.md', 'agents']);
    expect(fs.readdirSync(path.join(agentsDir, 'agents'))).toEqual(['openai.yaml']);
  });

  /**
   * A write that fails MID-way: the first half lands, then the disk gives
   * out. A truncate-then-write renderer leaves that half at the target; a
   * temp + rename renderer leaves the half in a temp file it then removes.
   */
  function failHalfwayThrough(): void {
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data) => {
      const text = typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf-8');
      fs.writeFileSync(String(file), text.slice(0, Math.floor(text.length / 2)));
      throw new Error('simulated disk-full mid-write');
    });
  }

  it('a failed write leaves no partial SKILL.md and no temp residue', async () => {
    const projectDir = makeHome();
    const target = path.join(projectDir, '.claude/skills/demo-skill/SKILL.md');
    failHalfwayThrough();
    await expect(skillParityRule.remediate(projectDir, 'demo-skill', 'claude-code')).rejects.toThrow('simulated disk-full');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(path.dirname(target))).toEqual([]);
  });

  it('a failed re-render keeps the previous rendering byte-for-byte', async () => {
    const projectDir = makeHome();
    await skillParityRule.remediate(projectDir, 'demo-skill', 'claude-code');
    const target = path.join(projectDir, '.claude/skills/demo-skill/SKILL.md');
    const before = fs.readFileSync(target, 'utf-8');
    fs.writeFileSync(path.join(projectDir, '.instar/skills/demo-skill/SKILL.md'), '---\nname: demo-skill\ndescription: "demo"\n---\n# body v2\n');
    failHalfwayThrough();
    await expect(skillParityRule.remediate(projectDir, 'demo-skill', 'claude-code')).rejects.toThrow('simulated disk-full');
    expect(fs.readFileSync(target, 'utf-8')).toBe(before);
    expect(fs.readdirSync(path.dirname(target))).toEqual(['SKILL.md']);
  });
});
