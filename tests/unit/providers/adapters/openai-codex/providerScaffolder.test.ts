/**
 * Unit tests for openai-codex ProviderScaffolder skill discovery layout.
 *
 * Phase 0 fix: skills must be written to `.agents/skills/<name>/` with a
 * sibling `agents/openai.yaml` per Codex 0.130's project-scope discovery
 * contract. The prior implementation wrote skills under `.agent/openai/skills/`
 * which Codex silently ignores.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProviderScaffolder } from '../../../../../src/providers/adapters/openai-codex/integration/providerScaffolder.js';
import type { ScaffoldAsset } from '../../../../../src/providers/primitives/integration/providerScaffolder.js';

async function makeProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'codex-scaffolder-test-'));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const SAMPLE_SKILL: ScaffoldAsset = {
  kind: 'skill',
  name: 'hello-instar',
  content: [
    '---',
    'name: hello-instar',
    'description: A test skill used to verify scaffolder behaviour.',
    'metadata:',
    '  short-description: Test skill',
    '---',
    '',
    '# Hello Instar',
    '',
    'Reply with PHASE0-SKILL-OK when invoked.',
    '',
  ].join('\n'),
};

describe('OpenAiCodexProviderScaffolder — skill discovery layout', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await makeProject();
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('writes skills to .agents/skills/<name>/SKILL.md (not .agent/openai/skills/)', async () => {
    const scaffolder = createProviderScaffolder();
    await scaffolder.install(projectRoot, { bundledAssets: [SAMPLE_SKILL] });

    const correctPath = path.join(projectRoot, '.agents/skills/hello-instar/SKILL.md');
    const legacyWrongPath = path.join(projectRoot, '.agent/openai/skills/hello-instar/SKILL.md');

    expect(await exists(correctPath)).toBe(true);
    expect(await exists(legacyWrongPath)).toBe(false);
  });

  it('emits sibling agents/openai.yaml inside each skill directory', async () => {
    const scaffolder = createProviderScaffolder();
    await scaffolder.install(projectRoot, { bundledAssets: [SAMPLE_SKILL] });

    const yamlPath = path.join(projectRoot, '.agents/skills/hello-instar/agents/openai.yaml');
    expect(await exists(yamlPath)).toBe(true);

    const yaml = await fs.readFile(yamlPath, 'utf-8');
    expect(yaml).toContain('interface:');
    expect(yaml).toMatch(/display_name:\s*".+"/);
    expect(yaml).toMatch(/short_description:\s*".+"/);
  });

  it('derives display_name from skill name when frontmatter omits it', async () => {
    const scaffolder = createProviderScaffolder();
    await scaffolder.install(projectRoot, { bundledAssets: [SAMPLE_SKILL] });

    const yaml = await fs.readFile(
      path.join(projectRoot, '.agents/skills/hello-instar/agents/openai.yaml'),
      'utf-8',
    );

    expect(yaml).toContain('display_name: "Hello Instar"');
  });

  it('uses frontmatter short-description for openai.yaml short_description', async () => {
    const scaffolder = createProviderScaffolder();
    await scaffolder.install(projectRoot, { bundledAssets: [SAMPLE_SKILL] });

    const yaml = await fs.readFile(
      path.join(projectRoot, '.agents/skills/hello-instar/agents/openai.yaml'),
      'utf-8',
    );

    expect(yaml).toContain('short_description: "Test skill"');
  });

  it('falls back to frontmatter description when short-description is absent', async () => {
    const scaffolder = createProviderScaffolder();
    const asset: ScaffoldAsset = {
      kind: 'skill',
      name: 'fallback-test',
      content: [
        '---',
        'name: fallback-test',
        'description: Some description here.',
        '---',
        '',
        '# Body',
      ].join('\n'),
    };

    await scaffolder.install(projectRoot, { bundledAssets: [asset] });

    const yaml = await fs.readFile(
      path.join(projectRoot, '.agents/skills/fallback-test/agents/openai.yaml'),
      'utf-8',
    );

    expect(yaml).toContain('short_description: "Some description here."');
  });

  it('truncates long short_description to 64 chars with ellipsis', async () => {
    const scaffolder = createProviderScaffolder();
    const longDescription = 'A'.repeat(200);
    const asset: ScaffoldAsset = {
      kind: 'skill',
      name: 'long-desc',
      content: [
        '---',
        'name: long-desc',
        `description: ${longDescription}`,
        '---',
        '',
        '# Body',
      ].join('\n'),
    };

    await scaffolder.install(projectRoot, { bundledAssets: [asset] });

    const yaml = await fs.readFile(
      path.join(projectRoot, '.agents/skills/long-desc/agents/openai.yaml'),
      'utf-8',
    );

    const match = yaml.match(/short_description:\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    const value = match![1];
    expect(value.length).toBeLessThanOrEqual(64);
    expect(value.endsWith('...')).toBe(true);
  });

  it('writes SKILL.md content verbatim (no template substitution)', async () => {
    const scaffolder = createProviderScaffolder();
    await scaffolder.install(projectRoot, { bundledAssets: [SAMPLE_SKILL] });

    const skillMd = await fs.readFile(
      path.join(projectRoot, '.agents/skills/hello-instar/SKILL.md'),
      'utf-8',
    );

    expect(skillMd).toBe(SAMPLE_SKILL.content);
  });

  it('still creates .agent/openai/ provider-config files alongside skills', async () => {
    const scaffolder = createProviderScaffolder();
    await scaffolder.install(projectRoot, { bundledAssets: [SAMPLE_SKILL] });

    expect(await exists(path.join(projectRoot, '.agent/openai/AGENTS.md'))).toBe(true);
    expect(await exists(path.join(projectRoot, '.agent/openai/config.toml'))).toBe(true);
    expect(await exists(path.join(projectRoot, '.agent/openai/hooks.json'))).toBe(true);
  });

  it('does NOT create .agents/skills/ when no skill assets are bundled', async () => {
    const scaffolder = createProviderScaffolder();
    await scaffolder.install(projectRoot, { bundledAssets: [] });

    expect(await exists(path.join(projectRoot, '.agents'))).toBe(false);
    expect(await exists(path.join(projectRoot, '.agent/openai'))).toBe(true);
  });

  it('reports both SKILL.md and openai.yaml in created[]', async () => {
    const scaffolder = createProviderScaffolder();
    const result = await scaffolder.install(projectRoot, { bundledAssets: [SAMPLE_SKILL] });

    const skillMdPath = path.join(projectRoot, '.agents/skills/hello-instar/SKILL.md');
    const yamlPath = path.join(projectRoot, '.agents/skills/hello-instar/agents/openai.yaml');

    expect(result.created).toContain(skillMdPath);
    expect(result.created).toContain(yamlPath);
  });

  it('handles multiple skills in one install call', async () => {
    const scaffolder = createProviderScaffolder();
    const skills: ScaffoldAsset[] = [
      { ...SAMPLE_SKILL, name: 'skill-a' },
      { ...SAMPLE_SKILL, name: 'skill-b' },
      { ...SAMPLE_SKILL, name: 'skill-c' },
    ];

    await scaffolder.install(projectRoot, { bundledAssets: skills });

    for (const s of skills) {
      expect(await exists(path.join(projectRoot, `.agents/skills/${s.name}/SKILL.md`))).toBe(true);
      expect(
        await exists(path.join(projectRoot, `.agents/skills/${s.name}/agents/openai.yaml`)),
      ).toBe(true);
    }
  });

  it('uninstall removes both .agent/openai/ and .agents/skills/', async () => {
    const scaffolder = createProviderScaffolder();
    await scaffolder.install(projectRoot, { bundledAssets: [SAMPLE_SKILL] });
    await scaffolder.uninstall(projectRoot);

    expect(await exists(path.join(projectRoot, '.agent/openai'))).toBe(false);
    expect(await exists(path.join(projectRoot, '.agents/skills'))).toBe(false);
  });

  it('install is idempotent — re-running with same skills does not throw', async () => {
    const scaffolder = createProviderScaffolder();
    await scaffolder.install(projectRoot, { bundledAssets: [SAMPLE_SKILL] });
    await expect(
      scaffolder.install(projectRoot, { bundledAssets: [SAMPLE_SKILL] }),
    ).resolves.toBeDefined();

    expect(
      await exists(path.join(projectRoot, '.agents/skills/hello-instar/SKILL.md')),
    ).toBe(true);
  });

  it('escapes double quotes in YAML string values', async () => {
    const scaffolder = createProviderScaffolder();
    const asset: ScaffoldAsset = {
      kind: 'skill',
      name: 'quote-test',
      content: [
        '---',
        'name: quote-test',
        'description: A "quoted" word inside.',
        '---',
        '',
        '# Body',
      ].join('\n'),
    };

    await scaffolder.install(projectRoot, { bundledAssets: [asset] });

    const yaml = await fs.readFile(
      path.join(projectRoot, '.agents/skills/quote-test/agents/openai.yaml'),
      'utf-8',
    );

    expect(yaml).toContain('short_description: "A \\"quoted\\" word inside."');
  });
});
