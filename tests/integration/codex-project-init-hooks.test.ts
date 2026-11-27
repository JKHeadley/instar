import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('project init installs native Codex hooks for the selected framework', () => {
  let root: string;
  let originalCwd: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-codex-project-init-'));
    originalCwd = process.cwd();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    SafeFsExecutor.safeRmSync(root, {
      recursive: true,
      force: true,
      operation: 'tests/integration/codex-project-init-hooks.test.ts',
    });
  });

  it.each([
    { mode: 'named project', framework: 'codex-cli', claude: false },
    { mode: 'named project', framework: 'both', claude: true },
    { mode: 'existing directory', framework: 'codex-cli', claude: false },
    { mode: 'existing directory', framework: 'both', claude: true },
  ] as const)('registers the prompt hook for $mode with $framework', async ({ mode, framework, claude }) => {
    const name = 'hook-registration';
    const projectDir = path.join(root, name);
    const options = { framework, port: 4444, skipPrereqs: true };
    if (mode === 'named project') {
      await initProject({ ...options, name });
    } else {
      fs.mkdirSync(projectDir);
      await initProject({ ...options, dir: projectDir });
    }

    const hookFile = path.join(projectDir, '.codex', 'hooks.json');
    expect(fs.existsSync(hookFile)).toBe(true);
    const config = JSON.parse(fs.readFileSync(hookFile, 'utf8'));
    const promptHooks = config.hooks.UserPromptSubmit.flatMap(
      (group: { hooks: { command: string }[] }) => group.hooks,
    );
    expect(promptHooks).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: expect.stringContaining('telegram-topic-context.sh') }),
    ]));
    const promptScript = path.join(projectDir, '.instar', 'hooks', 'instar', 'telegram-topic-context.sh');
    expect(() => fs.accessSync(promptScript, fs.constants.X_OK)).not.toThrow();
    expect(fs.existsSync(path.join(projectDir, '.claude', 'settings.json'))).toBe(claude);
  });

  it('keeps an explicitly configured custom Codex hook on an existing project', async () => {
    const projectDir = path.join(root, 'custom-project');
    const hookFile = path.join(projectDir, '.codex', 'hooks.json');
    const custom = { matcher: '', hooks: [{ type: 'command', command: 'printf custom' }] };
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    fs.writeFileSync(hookFile, JSON.stringify({ hooks: { UserPromptSubmit: [custom] } }));

    await initProject({ dir: projectDir, framework: 'codex-cli', port: 4444, skipPrereqs: true });

    const config = JSON.parse(fs.readFileSync(hookFile, 'utf8'));
    expect(config.hooks.UserPromptSubmit).toContainEqual(custom);
    expect(config.hooks.UserPromptSubmit).toHaveLength(2);
  });

  it('leaves the default Claude-only setup without a Codex registration', async () => {
    const projectDir = path.join(root, 'default-project');
    fs.mkdirSync(projectDir);

    await initProject({ dir: projectDir, port: 4444, skipPrereqs: true });

    expect(fs.existsSync(path.join(projectDir, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.codex', 'hooks.json'))).toBe(false);
  });
});
